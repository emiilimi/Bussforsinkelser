"""
backtest_marginal.py — tester «marginal»-estimatet for overgangssannsynlighet
(client/src/lib/trip-model.ts) mot ekte overganger, leave-one-day-out.

Marginal = vi kjenner IKKE de to avgangenes felles historikk, bare hver linjes
forsinkelsesfordeling ved byttestoppet (P50/P80/P95, som reiseplanleggeren
alltid har). Antar uavhengighet og regner P(gap >= buffer) med samme
kvantil-rutenett som klienten (transferProbFromMarginals). Dette er
«priorien» som brukes når overgangen har få eller ingen egne dager.

Kjør:
    PARQUET_DIR=../Bussforsinkelser/data/reise-parquet \
    DATABASE_PATH=../Bussforsinkelser/data/reise.db python pipeline/backtest_marginal.py

Samme overgangspar og samme mål som backtest_transfer.py (hverdager, gap 2–10
min, made(d) = faktisk gap på egen avgang >= BUFFER). Estimatorer:
  pool        = andel av K sammenlignbare dager (dagens kode når egne dager mangler)
  marg        = marginal-estimatet alene
  blendM      = (K·pool + M·marg) / (K + M)       (ny kode)
  base        = global andel (referanse for K = 0)
Scenario 2 (egne dager finnes): dagens shrink10 mot blandingen
  (n·shrink10 + M·marg) / (n + M), n = egne + sammenlignbare dager.

MERK: P50/P80/P95 per (linje, stopp) regnes over ALLE hverdager, også måldagen.
Én dag av ~25 og hundrevis av avganger — lekkasjen er neglisjerbar, men den
finnes.
"""
import os
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", ROOT / "data" / "reise-parquet"))
DB_PATH = Path(os.environ.get("DATABASE_PATH", ROOT / "data" / "reise.db"))
BUFFER = float(os.environ.get("BT_BUFFER", "3"))
MAX_PAIRS = int(os.environ.get("BT_MAX_PAIRS", "6000"))
rng = np.random.default_rng(42)

# --- Kvantil-rutenett: MÅ være identisk med client/src/lib/trip-model.ts ----
GRID = np.array([(i + 0.5) / 100 for i in range(100)])


def quantile_grid(p50, p80, p95):
    """Forsinkelse (min) på GRID-nivåene ut fra P50/P80/P95. None = ingen data."""
    vals = [v for v in (p50, p80, p95) if v is not None]
    if not vals:
        return None
    if p50 is None:
        p50 = vals[0]
    if p80 is None:
        p80 = p95 if p95 is not None else p50
    if p95 is None:
        p95 = p80
    p80 = max(p80, p50)
    p95 = max(p95, p80)
    lo = min(max(p80 - p50, 0.5), 3.0)
    tail = max(p95 - p80, 1.0)
    out = np.empty(len(GRID))
    for i, u in enumerate(GRID):
        if u <= 0.5:
            out[i] = p50 - lo * (0.5 - u) / 0.3
        elif u <= 0.8:
            out[i] = p50 + (p80 - p50) * (u - 0.5) / 0.3
        elif u <= 0.95:
            out[i] = p80 + (p95 - p80) * (u - 0.8) / 0.15
        else:
            out[i] = p95 + 2 * tail * (u - 0.95) / 0.15
    return out


def prob_from_marginals(slack, need, arr_q, dep_q):
    """P(slack + dep - arr >= need) med uavhengige fordelinger på GRID."""
    if arr_q is None:
        return None
    dep = dep_q if dep_q is not None else np.zeros(1)
    return float(np.mean((slack + dep[None, :] - arr_q[:, None]) >= need))


# --- Data (samme som backtest_transfer.py) ----------------------------------
hub_names = ["Bergen busstasjon", "Lagunen terminal", "Åsane terminal", "Nesttun terminal",
             "Birkelandsskiftet terminal", "Festplassen", "Jernbaneveien", "Sandnes bussterminal Ruten",
             "Kannik", "Prostneset", "Fredrikstad bussterminal", "Olav Kyrres gate",
             "Jernbanetorget", "Nationaltheatret", "Storo", "Helsfyr", "Lysaker stasjon"]
db = sqlite3.connect(str(DB_PATH))
sp_rows = db.execute(
    f"SELECT DISTINCT stop_place_ref FROM stop_coords WHERE stop_place_name IN ({','.join('?' * len(hub_names))})",
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

c.execute("""CREATE TABLE arr AS SELECT date, line_ref, stop_ref, sp, direction_ref, ta, AVG(da) AS da
             FROM o WHERE ta IS NOT NULL AND da IS NOT NULL GROUP BY ALL""")
c.execute("""CREATE TABLE dep AS SELECT date, line_ref, stop_ref, sp, direction_ref, td, AVG(dd) AS dd
             FROM o WHERE td IS NOT NULL AND dd IS NOT NULL GROUP BY ALL""")
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

c.execute("""
  CREATE TABLE own AS
  SELECT p.pid, a.date, (p.tb + d.dd) - (p.ta + a.da) AS gap
  FROM p
  JOIN arr a ON a.line_ref = p.la AND a.stop_ref = p.qa AND a.direction_ref IS NOT DISTINCT FROM p.ra AND a.ta = p.ta
  JOIN dep d ON d.line_ref = p.lb AND d.stop_ref = p.qb AND d.direction_ref IS NOT DISTINCT FROM p.rb AND d.td = p.tb AND d.date = a.date
""")
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
# Linjenes fordeling ved stoppet (alle tider, alle hverdager) — som duckStats i klienten
marg_arr = {(l, s): (a, b, cc) for l, s, a, b, cc in c.execute("""
  SELECT line_ref, stop_ref, quantile_cont(da, 0.5), quantile_cont(da, 0.8), quantile_cont(da, 0.95)
  FROM arr WHERE (line_ref, stop_ref) IN (SELECT la, qa FROM p) GROUP BY ALL""").fetchall()}
marg_dep = {(l, s): (a, b, cc) for l, s, a, b, cc in c.execute("""
  SELECT line_ref, stop_ref, quantile_cont(dd, 0.5), quantile_cont(dd, 0.8), quantile_cont(dd, 0.95)
  FROM dep WHERE (line_ref, stop_ref) IN (SELECT lb, qb FROM p) GROUP BY ALL""").fetchall()}
pmeta = c.execute("SELECT pid, la, qa, lb, qb, g0 FROM p").fetchall()
print("own-obs:", c.execute("SELECT COUNT(*) FROM own").fetchone()[0],
      "pool-obs:", c.execute("SELECT COUNT(*) FROM pool").fetchone()[0], f"{time.time()-t0:.0f}s", flush=True)

p_marg = {}
for pid, la, qa, lb, qb, g0 in pmeta:
    aq = quantile_grid(*marg_arr.get((la, qa), (None, None, None)))
    dq = quantile_grid(*marg_dep.get((lb, qb), (None, None, None)))
    v = prob_from_marginals(g0, BUFFER, aq, dq)
    if v is not None:
        p_marg[pid] = v

own_by = defaultdict(dict)
pool_by = defaultdict(dict)
for pid, d, g in c.execute("SELECT pid, date, gap FROM own").fetchall():
    own_by[pid][d] = g >= BUFFER
for pid, d, g in c.execute("SELECT pid, date, gap FROM pool").fetchall():
    pool_by[pid][d] = g >= BUFFER

all_y = [v for od in own_by.values() for v in od.values()]
base = sum(all_y) / len(all_y)
print(f"global andel rakk det: {base:.3f}")

K_LIST = [0, 1, 2, 3, 5, 10, None]
MS = [2, 5, 10, 20]
res = defaultdict(lambda: defaultdict(list))
res2 = defaultdict(lambda: defaultdict(list))
calib = defaultdict(lambda: [0, 0.0, 0.0])  # bucket -> n, sum pred, sum y
for pid, od in own_by.items():
    if pid not in p_marg:
        continue
    pm = p_marg[pid]
    pd_ = pool_by.get(pid, {})
    dates = list(od.keys())
    if len(dates) < 4:
        continue
    for d in dates:
        y = 1.0 if od[d] else 0.0
        b = min(9, int(pm * 10))
        calib[b][0] += 1
        calib[b][1] += pm
        calib[b][2] += y
        others_pool = [v for x, v in pd_.items() if x != d]
        # Scenario 1: ingen egne dager, K sammenlignbare
        for K in K_LIST:
            if K is None:
                sample, kk = others_pool, "all"
            else:
                if len(others_pool) < K:
                    continue
                idx = rng.choice(len(others_pool), size=K, replace=False) if K else []
                sample, kk = [others_pool[i] for i in idx], K
            k = len(sample)
            r = res[kk]
            r["base"].append((base - y) ** 2)
            r["marg"].append((pm - y) ** 2)
            if k > 0:
                pp = sum(sample) / k
                r["pool"].append((pp - y) ** 2)
            else:
                r["pool"].append((base - y) ** 2)  # dagens kode: ukjent → ingen tall (base som stand-in)
            for m in MS:
                pp = sum(sample) / k if k else 0.0
                r[f"blend{m}"].append((((k * pp + m * pm) / (k + m)) - y) ** 2)
        # Scenario 2: egne dager finnes (som i dag), sammenlignbare alle
        others_own = [od[x] for x in dates if x != d]
        if others_pool:
            for kown in (1, 3, 5, None):
                if kown is None:
                    so, kk = others_own, "all"
                else:
                    if len(others_own) < kown:
                        continue
                    idx = rng.choice(len(others_own), size=kown, replace=False)
                    so, kk = [others_own[i] for i in idx], kown
                po = sum(so) / len(so)
                ppool = sum(others_pool) / len(others_pool)
                shrink = (len(so) * po + 10 * ppool) / (len(so) + 10)
                n = len(so) + len(others_pool)
                r2 = res2[kk]
                r2["shrink10"].append((shrink - y) ** 2)
                for m in MS:
                    r2[f"+marg{m}"].append((((n * shrink + m * pm) / (n + m)) - y) ** 2)

print("\nScenario 1 — ingen egne dager, K sammenlignbare dager (Brier, lavere er bedre)")
cols = ["base", "pool", "marg"] + [f"blend{m}" for m in MS]
print(f"{'K':>5} {'n':>8} " + " ".join(f"{x:>9}" for x in cols))
for kk in [k if k is not None else "all" for k in K_LIST]:
    r = res.get(kk)
    if r:
        print(f"{str(kk):>5} {len(r['marg']):>8} " + " ".join(f"{np.mean(r[x]):9.4f}" for x in cols))

print("\nScenario 2 — egne dager + alle sammenlignbare: dagens shrink10 mot + marginal-prior")
cols2 = ["shrink10"] + [f"+marg{m}" for m in MS]
print(f"{'egne':>5} {'n':>8} " + " ".join(f"{x:>9}" for x in cols2))
for kk in (1, 3, 5, "all"):
    r = res2.get(kk)
    if r:
        print(f"{str(kk):>5} {len(r['shrink10']):>8} " + " ".join(f"{np.mean(r[x]):9.4f}" for x in cols2))

print("\nKalibrering av marginal-estimatet (spådd vs. faktisk andel som rakk byttet)")
for b in sorted(calib):
    n, sp, sy = calib[b]
    print(f"  {b/10:.1f}–{(b+1)/10:.1f}: n={n:6d}  spådd {sp/n:.3f}  faktisk {sy/n:.3f}")
print(f"\nferdig på {time.time()-t0:.0f}s")
