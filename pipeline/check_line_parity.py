"""
Paritetssjekk: linjefilene (line_shards.py) mot nettleserens egen SQL.

For et utvalg linjer kjøres apiLineDistribution-spørringen fra
client/src/lib/stats-adapter.ts for ÉN linje (slik nettleseren gjør), og svaret
sammenlignes med det som er pakket i linjefilene — på det nivået
parseDistribution bruker det: summer per celle (ukedag × time), n per bøtte,
og radene for dag, hele utvalget og dato × time.

  PARQUET_DIR=data/reise-parquet LINES_DIR=data/reise-parquet/lines \\
      python pipeline/check_line_parity.py [--n 40] [--line SKY:Line:3]
Skal gi «0 avvik».
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from line_shards import DIST_BIN_PER_MIN, D_EXPR, EARLY_MIN, line_shard_of  # noqa: E402

PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", "data/parquet"))
LINES_DIR = Path(os.environ.get("LINES_DIR") or PARQUET_DIR / "lines")
TOL = 2e-3   # filene har 3 desimaler


def browser_sql(files: list[Path], line_ref: str, from_date: str) -> str:
    """Kopi av apiLineDistribution (stats-adapter.ts) med lineQueryScope for én linje."""
    file_list = ", ".join(f"'{f.as_posix()}'" for f in files)
    where = (f"line_ref = '{line_ref}' AND {D_EXPR} IS NOT NULL AND date >= '{from_date}'")
    counts = f"""
      COUNT(*)::INTEGER AS n, SUM(d) AS s,
      SUM(CASE WHEN d < {EARLY_MIN} THEN 1 ELSE 0 END)::INTEGER AS early,
      SUM(CASE WHEN d >= {EARLY_MIN} AND d <= 2 THEN 1 ELSE 0 END)::INTEGER AS punctual,
      SUM(CASE WHEN d > 10 THEN 1 ELSE 0 END)::INTEGER AS late10"""
    return f"""
    WITH r AS MATERIALIZED (
      SELECT date, d, service_journey_id AS sj,
        isodow(CAST(date AS DATE)) AS dow,
        CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER) % 24 AS hour,
        CAST(FLOOR(LEAST(GREATEST(d, -10), 30) * {DIST_BIN_PER_MIN}) AS INTEGER) AS b
      FROM (SELECT date, service_journey_id, aimed_departure, aimed_arrival, {D_EXPR} AS d
            FROM read_parquet([{file_list}]) WHERE {where})
    )
    SELECT 0 AS kind, NULL::VARCHAR AS date, dow, hour, b, {counts},
      NULL::DOUBLE, NULL::DOUBLE, NULL::DOUBLE, NULL::DOUBLE, NULL::INTEGER
    FROM r WHERE hour IS NOT NULL GROUP BY dow, hour, b
    UNION ALL
    SELECT 1, CAST(date AS VARCHAR), NULL, NULL, NULL, {counts},
      quantile_cont(d, 0.5), quantile_cont(d, 0.8), NULL, NULL, COUNT(DISTINCT sj)::INTEGER
    FROM r GROUP BY date
    UNION ALL
    SELECT 2, NULL, NULL, NULL, NULL, {counts},
      quantile_cont(d, 0.5), quantile_cont(d, 0.8), quantile_cont(d, 0.95),
      STDDEV_SAMP(d), COUNT(DISTINCT CAST(date AS VARCHAR) || '|' || sj)::INTEGER
    FROM r
    UNION ALL
    SELECT 3, CAST(date AS VARCHAR), NULL, hour, NULL, {counts}, MIN(d), MAX(d), NULL, NULL, NULL
    FROM r WHERE hour IS NOT NULL GROUP BY date, hour
    """


def close(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, float) and a != a:
        return b is None
    return abs(float(a) - float(b)) <= TOL * max(1.0, abs(float(a)))


def compare(rows: list[tuple], packed: dict, d0: date) -> list[str]:
    errs: list[str] = []
    # kind 0 på parseDistribution-nivå
    cells = defaultdict(lambda: [0, 0.0, 0, 0, 0, defaultdict(int)])
    for kind, dt, dow, hour, b, n, s, e, p, l, *_ in rows:
        if kind != 0 or hour is None:
            continue
        c = cells[dow * 24 + hour]
        c[0] += n; c[1] += s; c[2] += e; c[3] += p; c[4] += l; c[5][b] += n
    got = {c[0]: c for c in packed["c"]}
    if set(cells) != set(got):
        errs.append(f"celler: {len(cells)} vs {len(got)}")
    for k, c in cells.items():
        g = got.get(k)
        if not g:
            continue
        if not (c[0] == g[1] and close(c[1], g[2]) and c[2:5] == g[3:6]):
            errs.append(f"celle {k}: {c[:5]} vs {g[1:6]}")
        bins = dict(zip(g[6][0::2], g[6][1::2]))
        if dict(c[5]) != bins:
            errs.append(f"celle {k}: bøtter ulike")
    # kind 1
    daily = {((date.fromisoformat(r[1][:10]) - d0).days): r for r in rows if r[0] == 1}
    for off, n, s, e, p, l, p50, p80, deps in packed["d"]:
        r = daily.pop(off, None)
        if r is None or not (r[5] == n and close(r[6], s) and (r[7], r[8], r[9]) == (e, p, l)
                             and close(r[10], p50) and close(r[11], p80) and r[14] == deps):
            errs.append(f"dag {off}: {r} vs {[off, n, s, e, p, l, p50, p80, deps]}")
    if daily:
        errs.append(f"{len(daily)} dager mangler i fila")
    # kind 2
    o = next((r for r in rows if r[0] == 2), None)
    po = packed["o"]
    if o is None or po is None or not (o[5] == po[0] and close(o[6], po[1]) and (o[7], o[8], o[9]) == tuple(po[2:5])
                                         and close(o[10], po[5]) and close(o[11], po[6]) and close(o[12], po[7])
                                         and close(o[13], po[8]) and o[14] == po[9]):
        errs.append(f"totalt: {o} vs {po}")
    # kind 3
    dh = {((date.fromisoformat(r[1][:10]) - d0).days, r[3]): r for r in rows if r[0] == 3}
    for off, hour, n, s, mn, mx in packed["h"]:
        r = dh.pop((off, hour), None)
        if r is None or not (r[5] == n and close(r[6], s) and close(r[10], mn) and close(r[11], mx)):
            errs.append(f"dato×time {off},{hour}: {r} vs {[off, hour, n, s, mn, mx]}")
    if dh:
        errs.append(f"{len(dh)} dato×time mangler i fila")
    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--line", action="append", default=[])
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    idx = json.loads((LINES_DIR / "index.json").read_text(encoding="utf-8"))
    d0 = date.fromisoformat(idx["from"])
    # Bare ukene som overlapper vinduet (SQL-en filtrerer på dato uansett).
    files = [f for f in sorted(PARQUET_DIR.glob("*-by-line.parquet"))
             if date.fromisocalendar(int(f.name[:4]), int(f.name[6:8]), 7) >= d0]
    all_lines = []
    for p in LINES_DIR.glob("*.json"):
        if p.name != "index.json":
            all_lines += list(json.loads(p.read_text(encoding="utf-8"))["lines"])
    random.seed(a.seed)
    sample = a.line + random.sample(sorted(all_lines), min(a.n, len(all_lines)))
    con = duckdb.connect()
    con.execute("SET enable_progress_bar = false")
    bad = 0
    for lr in sample:
        shard = json.loads((LINES_DIR / f"{line_shard_of(lr, idx['shards'])}.json").read_text(encoding="utf-8"))
        packed = shard["lines"].get(lr)
        rows = con.execute(browser_sql(files, lr, idx["from"])).fetchall()
        if packed is None:
            print(f"  {lr}: mangler i fila ({len(rows)} rader i SQL)")
            bad += 1
            continue
        errs = compare(rows, packed, d0)
        if errs:
            bad += 1
            print(f"  {lr}: {len(errs)} avvik, f.eks. {errs[:2]}", flush=True)
        else:
            print(f"  {lr}: ok ({len(rows)} rader)", flush=True)
    print(f"{len(sample)} linjer, {bad} med avvik" if bad else f"{len(sample)} linjer, 0 avvik")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
