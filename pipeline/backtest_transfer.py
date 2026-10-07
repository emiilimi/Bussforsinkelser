"""
backtest_transfer.py — leave-one-day-out-test av estimatorer for overgangssannsynlighet.

Grunnlaget for POOL_PRIOR_DAYS / shrunkProb() i client/src/lib/trip-shared.ts
(kjørt 2026-10-06, se STATUS.md). Kjør på nytt når datavinduet har vokst:

    python pipeline/backtest_transfer.py
    BT_BUFFER=5 python pipeline/backtest_transfer.py

Leser PARQUET_DIR (*-by-stop.parquet) og DATABASE_PATH (stop_coords for
plattform → stoppested). Tar ~30 s.

Leave-one-day-out backtest of transfer-probability estimators.

For real transfer pairs (arrival line A at quay qa, departure line B != A at a
quay in the same stop place, planned gap 2–10 min) on weekdays:
  own(d)  = actual dep - actual arr on day d, matched on exact aimed time (level 2)
  pool(d) = planned_gap + dep_delay(nearest aimed ±60) - arr_delay(nearest ±60)
Target: made(d) = own(d) >= BUFFER. For each target day, estimators use all
OTHER days:
  own      = share of other own days made          (k = #other own days)
  pool     = share of other pool days made
  cutoff5  = own if k >= 5 else pool               (what the site does today)
  shrinkM  = (k*own + M*pool) / (k+M)
Brier score, grouped by k bucket.
"""
import sqlite3
import sys
import os
import time
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", ROOT / "data" / "reise-parquet"))
DB_PATH = Path(os.environ.get("DATABASE_PATH", ROOT / "data" / "reise.db"))
BUFFER = float(os.environ.get("BT_BUFFER", "3"))  # 1 min gange + 2 min margin
MAX_PAIRS = 6000
rng = np.random.default_rng(42)

hub_names = ["Bergen busstasjon", "Lagunen terminal", "Åsane terminal", "Nesttun terminal",
             "Birkelandsskiftet terminal", "Festplassen", "Jernbaneveien", "Sandnes bussterminal Ruten",
             "Kannik", "Prostneset", "Fredrikstad bussterminal", "Olav Kyrres gate"]
db = sqlite3.connect(str(DB_PATH))
sp_rows = db.execute(
    f"SELECT DISTINCT stop_place_ref, stop_place_name FROM stop_coords WHERE stop_place_name IN ({','.join('?' * len(hub_names))})",
    hub_names).fetchall()
sps = [r[0] for r in sp_rows if r[0]]
quays = db.execute(
    f"SELECT stop_ref, stop_place_ref FROM stop_coords WHERE stop_place_ref IN ({','.join('?' * len(sps))})", sps).fetchall()
print(f"{len(sps)} stoppesteder, {len(quays)} plattformer", flush=True)

c = duckdb.connect()
c.execute("SET memory_limit='6GB'")
c.execute("CREATE TABLE q (stop_ref VARCHAR, sp VARCHAR)")
c.executemany("INSERT INTO q VALUES (?, ?)", quays)
files = sorted(p.as_posix() for p in PARQUET_DIR.glob("*-by-stop.parquet"))
t0 = time.time()
c.execute(f"""
  CREATE TABLE o AS
  SELECT o.date, o.line_ref, o.stop_ref, q.sp, o.direction_ref,
         CAST(substr(o.aimed_arrival,1,2) AS INT)*60 + CAST(substr(o.aimed_arrival,4,2) AS INT) AS ta,
         CAST(substr(o.aimed_departure,1,2) AS INT)*60 + CAST(substr(o.aimed_departure,4,2) AS INT) AS td,
         o.delay_arrival_min AS da, o.delay_departure_min AS dd
  FROM read_parquet({files}) o JOIN q USING (stop_ref)
  WHERE o.day_type = 'weekday'
    AND abs(COALESCE(o.delay_arrival_min, 0)) <= 120 AND abs(COALESCE(o.delay_departure_min, 0)) <= 120
""")
print("rader:", c.execute("SELECT COUNT(*), COUNT(DISTINCT date) FROM o").fetchone(), f"{time.time()-t0:.0f}s", flush=True)

# Ankomster og avganger per (dag, linje, plattform, retning, rutetid)
c.execute("""CREATE TABLE arr AS SELECT date, line_ref, stop_ref, sp, direction_ref, ta, AVG(da) AS da
             FROM o WHERE ta IS NOT NULL AND da IS NOT NULL GROUP BY ALL""")
c.execute("""CREATE TABLE dep AS SELECT date, line_ref, stop_ref, sp, direction_ref, td, AVG(dd) AS dd
             FROM o WHERE td IS NOT NULL AND dd IS NOT NULL GROUP BY ALL""")

# Kandidatpar fra ruteplanen: (A ankommer, B går) i samme stoppested, gap 2–10 min,
# og paret må forekomme minst 10 hverdager.
c.execute("""
  CREATE TABLE pairs AS
  WITH a AS (SELECT line_ref AS la, stop_ref AS qa, sp, direction_ref AS ra, ta, COUNT(*) AS na FROM arr GROUP BY ALL HAVING COUNT(*) >= 10),
       b AS (SELECT line_ref AS lb, stop_ref AS qb, sp, direction_ref AS rb, td AS tb, COUNT(*) AS nb FROM dep GROUP BY ALL HAVING COUNT(*) >= 10)
  SELECT a.*, b.lb, b.qb, b.rb, b.tb, b.tb - a.ta AS g0
  FROM a JOIN b USING (sp)
  WHERE a.la <> b.lb AND b.tb - a.ta BETWEEN 2 AND 10
""")
npairs = c.execute("SELECT COUNT(*) FROM pairs").fetchone()[0]
print("kandidatpar:", npairs, flush=True)
if npairs > MAX_PAIRS:
    c.execute(f"CREATE TABLE p AS SELECT * FROM pairs USING SAMPLE {MAX_PAIRS} ROWS (reservoir, 42)")
else:
    c.execute("CREATE TABLE p AS SELECT * FROM pairs")
c.execute("ALTER TABLE p ADD COLUMN pid INTEGER")
c.execute("UPDATE p SET pid = rowid")

# Egen avgang (eksakt rutetid) per dag
c.execute("""
  CREATE TABLE own AS
  SELECT p.pid, a.date, (p.tb + d.dd) - (p.ta + a.da) AS gap
  FROM p
  JOIN arr a ON a.line_ref = p.la AND a.stop_ref = p.qa AND a.direction_ref IS NOT DISTINCT FROM p.ra AND a.ta = p.ta
  JOIN dep d ON d.line_ref = p.lb AND d.stop_ref = p.qb AND d.direction_ref IS NOT DISTINCT FROM p.rb AND d.td = p.tb AND d.date = a.date
""")
# Pool: nærmeste rutetid ±60 per dag på hver side
c.execute("""
  CREATE TABLE pool AS
  WITH an AS (
    SELECT p.pid, a.date, a.da FROM p
    JOIN arr a ON a.line_ref = p.la AND a.stop_ref = p.qa AND a.direction_ref IS NOT DISTINCT FROM p.ra
     AND a.ta BETWEEN p.ta - 60 AND p.ta + 60
    QUALIFY ROW_NUMBER() OVER (PARTITION BY p.pid, a.date ORDER BY abs(a.ta - p.ta)) = 1
  ), dn AS (
    SELECT p.pid, d.date, d.dd FROM p
    JOIN dep d ON d.line_ref = p.lb AND d.stop_ref = p.qb AND d.direction_ref IS NOT DISTINCT FROM p.rb
     AND d.td BETWEEN p.tb - 60 AND p.tb + 60
    QUALIFY ROW_NUMBER() OVER (PARTITION BY p.pid, d.date ORDER BY abs(d.td - p.tb)) = 1
  )
  SELECT an.pid, an.date, p.g0 + dn.dd - an.da AS gap
  FROM an JOIN dn USING (pid, date) JOIN p USING (pid)
""")
print("own-obs:", c.execute("SELECT COUNT(*) FROM own").fetchone()[0],
      "pool-obs:", c.execute("SELECT COUNT(*) FROM pool").fetchone()[0], f"{time.time()-t0:.0f}s", flush=True)

own = c.execute("SELECT pid, date, gap FROM own ORDER BY pid").fetchall()
pool = c.execute("SELECT pid, date, gap FROM pool ORDER BY pid").fetchall()
from collections import defaultdict
own_by = defaultdict(dict)
pool_by = defaultdict(dict)
for pid, d, g in own:
    own_by[pid][d] = g >= BUFFER
for pid, d, g in pool:
    pool_by[pid][d] = g >= BUFFER

# Realistisk k: siten bruker alle dager i vinduet, men egne dager er ofte få
# (ny id, ruteendring). Vi simulerer k ved å trekke k av de andre egne dagene.
K_LIST = [1, 2, 3, 5, 7, 10, 15, 20, 30, None]  # None = alle
MS = [2, 5, 10, 20]
res = defaultdict(lambda: defaultdict(list))
n_targets = 0
for pid, od in own_by.items():
    pd_ = pool_by.get(pid, {})
    dates = list(od.keys())
    if len(dates) < 4:
        continue
    for d in dates:
        y = 1.0 if od[d] else 0.0
        others_own = [od[x] for x in dates if x != d]
        others_pool = [v for x, v in pd_.items() if x != d]
        if not others_pool:
            continue
        p_pool = sum(others_pool) / len(others_pool)
        n_targets += 1
        for K in K_LIST:
            if K is None:
                sample = others_own
                kk = "all"
            else:
                if len(others_own) < K:
                    continue
                idx = rng.choice(len(others_own), size=K, replace=False)
                sample = [others_own[i] for i in idx]
                kk = K
            k = len(sample)
            p_own = sum(sample) / k
            r = res[kk]
            r["own"].append((p_own - y) ** 2)
            r["pool"].append((p_pool - y) ** 2)
            r["cutoff5"].append(((p_own if k >= 5 else p_pool) - y) ** 2)
            for m in MS:
                r[f"shrink{m}"].append((((k * p_own + m * p_pool) / (k + m)) - y) ** 2)

print(f"\nmål-dager: {n_targets}, par med egne obs: {sum(1 for v in own_by.values() if len(v) >= 4)}")
cols = ["own", "pool", "cutoff5", "shrink2", "shrink5", "shrink10", "shrink20"]
print(f"{'k':>5} {'n':>8} " + " ".join(f"{x:>9}" for x in cols))
for kk in [k if k is not None else "all" for k in K_LIST]:
    r = res.get(kk)
    if not r:
        continue
    print(f"{str(kk):>5} {len(r['own']):>8} " + " ".join(f"{np.mean(r[x]):9.4f}" for x in cols))
print(f"\nferdig på {time.time()-t0:.0f}s")
