"""
Linjefiler for Linjeanalyse — /api/line/<ref>/distribution uten DuckDB i nettleseren.

Linjeanalysens fordeling, varmekart, timesprofil og dagstrend kommer fra ÉN
DuckDB-spørring (apiLineDistribution i client/src/lib/stats-adapter.ts). Målt
2026-11-25 lokalt mot R2: > 90 s for linje 3, kaldt. Her kjøres den samme
spørringen for ALLE linjer på én gang, for standardvisningen (siste 30 dager,
begge retninger, alle dagtyper), og svaret skrives per linje:

  <PARQUET_DIR>/lines/index.json        {v, generatedAt, from, to, days, shards}
  <PARQUET_DIR>/lines/<shard>.json      {v, from, to, lines: {lineRef: Packed}}

Packed (kompakt; client/src/lib/line-shards.ts pakker ut til DistRow[]):
  c  kind 0 slått sammen per celle: [dow*24+hour, n, s, early, punctual, late10, [b, n, b, n, ...]]
     — parseDistribution summerer kind 0 per celle uansett, og histogrammet
     trenger bare n per bøtte, så resultatet er identisk med radene fra SQL-en.
  d  kind 1: [dagnr, n, s, early, punctual, late10, p50, p80, deps]
  o  kind 2: [n, s, early, punctual, late10, p50, p80, p95, sd, deps]
  h  kind 3: [dagnr, hour, n, s, min, max]   (early/punctual/late10 brukes ikke)
  dagnr = dager etter `from`.

shard = crc32(lineRef) % LINE_SHARDS — MÅ være lik lineShardOf() i
client/src/lib/line-shards.ts.

⚠️ SQL-en MÅ speile apiLineDistribution. Endrer du den (bøtter, grenser,
kolonner), må denne følge med, og pipeline/check_line_parity.py skal gi 0 avvik.

Kjøring:
  PARQUET_DIR=data/reise-parquet python pipeline/line_shards.py
Env:
  LINE_SHARDS      antall filer (default 1024)
  LINE_DAYS        vindu i dager (default 30 = Linjeanalysens standard)
  LINES_OUT_DIR    utmappe (default <PARQUET_DIR>/lines)
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import zlib
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aggregate_stats import configure_duckdb  # noqa: E402

log = logging.getLogger("line_shards")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(message)s")

PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", "data/parquet"))
LINE_SHARDS = int(os.environ.get("LINE_SHARDS", "1024"))
LINE_DAYS = int(os.environ.get("LINE_DAYS", "30"))
FORMAT_VERSION = 1

# Samme som stats-adapter.ts
EARLY_MIN = -1
DIST_BIN_PER_MIN = 4
D_EXPR = "COALESCE(delay_departure_min, delay_arrival_min)"


def line_shard_of(line_ref: str, shards: int = LINE_SHARDS) -> int:
    return zlib.crc32(line_ref.encode("utf-8")) % shards


def distribution_sql(files: list[Path], from_date: str) -> str:
    """apiLineDistribution med line_ref i hver GROUP BY."""
    file_list = ", ".join(f"'{f.as_posix()}'" for f in files)
    counts = f"""
      COUNT(*)::INTEGER AS n, SUM(d) AS s,
      SUM(CASE WHEN d < {EARLY_MIN} THEN 1 ELSE 0 END)::INTEGER AS early,
      SUM(CASE WHEN d >= {EARLY_MIN} AND d <= 2 THEN 1 ELSE 0 END)::INTEGER AS punctual,
      SUM(CASE WHEN d > 10 THEN 1 ELSE 0 END)::INTEGER AS late10"""
    return f"""
    WITH r AS MATERIALIZED (
      SELECT line_ref, date, d, service_journey_id AS sj,
        isodow(CAST(date AS DATE)) AS dow,
        CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER) % 24 AS hour,
        CAST(FLOOR(LEAST(GREATEST(d, -10), 30) * {DIST_BIN_PER_MIN}) AS INTEGER) AS b
      FROM (
        SELECT line_ref, date, service_journey_id, aimed_departure, aimed_arrival, {D_EXPR} AS d
        FROM read_parquet([{file_list}])
        WHERE {D_EXPR} IS NOT NULL AND date >= '{from_date}'
      )
    )
    SELECT line_ref, 0 AS kind, NULL::VARCHAR AS date, dow, hour, b, {counts},
      NULL::DOUBLE AS p50, NULL::DOUBLE AS p80, NULL::DOUBLE AS p95,
      NULL::DOUBLE AS sd, NULL::INTEGER AS deps
    FROM r WHERE hour IS NOT NULL GROUP BY line_ref, dow, hour, b
    UNION ALL
    SELECT line_ref, 1, CAST(date AS VARCHAR), NULL, NULL, NULL, {counts},
      quantile_cont(d, 0.5), quantile_cont(d, 0.8), NULL, NULL, COUNT(DISTINCT sj)::INTEGER
    FROM r GROUP BY line_ref, date
    UNION ALL
    SELECT line_ref, 2, NULL, NULL, NULL, NULL, {counts},
      quantile_cont(d, 0.5), quantile_cont(d, 0.8), quantile_cont(d, 0.95),
      STDDEV_SAMP(d), COUNT(DISTINCT CAST(date AS VARCHAR) || '|' || sj)::INTEGER
    FROM r GROUP BY line_ref
    UNION ALL
    SELECT line_ref, 3, CAST(date AS VARCHAR), NULL, hour, NULL, {counts},
      MIN(d), MAX(d), NULL, NULL, NULL
    FROM r WHERE hour IS NOT NULL GROUP BY line_ref, date, hour
    """


def compact(v, digits: int = 3):
    """Desimaltall med `digits` siffer, heltall som heltall, NaN som null."""
    if isinstance(v, float):
        if v != v:  # NaN (STDDEV_SAMP av én verdi)
            return None
        r = round(v, digits)
        return int(r) if r == int(r) else r
    return v


def pack_line(rows: list[tuple], d0: date) -> dict:
    """SQL-radene for én linje (uten line_ref) → Packed, se modul-docstring."""
    cells: dict[int, list] = {}
    daily, hourly, overall = [], [], None
    for kind, dt, dow, hour, b, n, s, early, punct, late10, p50, p80, p95, sd, deps in rows:
        if kind == 0:
            k = dow * 24 + hour
            c = cells.get(k)
            if c is None:
                c = cells[k] = [k, 0, 0.0, 0, 0, 0, []]
            c[1] += n; c[2] += s; c[3] += early; c[4] += punct; c[5] += late10
            c[6] += [b, n]
        elif kind == 1:
            off = (date.fromisoformat(dt[:10]) - d0).days
            daily.append([off, n, compact(s), early, punct, late10, compact(p50), compact(p80), deps])
        elif kind == 2:
            overall = [n, compact(s), early, punct, late10, compact(p50), compact(p80), compact(p95),
                       compact(sd), deps]
        elif kind == 3:
            off = (date.fromisoformat(dt[:10]) - d0).days
            hourly.append([off, hour, n, compact(s), compact(p50), compact(p80)])
    for c in cells.values():
        c[2] = compact(c[2])
        pairs = sorted(zip(c[6][0::2], c[6][1::2]))
        c[6] = [x for pair in pairs for x in pair]
    return {"c": sorted(cells.values()), "d": sorted(daily), "o": overall, "h": sorted(hourly)}


def build_line_shards(con=None) -> int:
    """Bygg lines/. Kalles av aggregate_stats.py (--only lines) eller main()."""
    t0 = time.time()
    files = sorted(PARQUET_DIR.glob("*-by-line.parquet"))
    if not files:
        log.error("Ingen *-by-line.parquet i %s", PARQUET_DIR)
        return 1
    if con is None:
        con = duckdb.connect()
        configure_duckdb(con)
    file_list = ", ".join(f"'{f.as_posix()}'" for f in files)
    (latest,) = con.execute(f"SELECT MAX(date) FROM read_parquet([{file_list}])").fetchone()
    from_date = (date.fromisoformat(latest) - timedelta(days=LINE_DAYS - 1)).isoformat()
    # Bare ukefilene som kan ha rader i vinduet (navnet er ISO-uke).
    use = [f for f in files if _week_end(f.name) >= date.fromisoformat(from_date)]
    log.info("Vindu %s → %s, %d av %d ukefiler", from_date, latest, len(use), len(files))

    by_line: dict[str, list] = {}
    n_rows = 0
    cur = con.execute(distribution_sql(use, from_date))
    while True:
        chunk = cur.fetchmany(200_000)
        if not chunk:
            break
        for row in chunk:
            by_line.setdefault(row[0], []).append(row[1:])
            n_rows += 1
    log.info("%d rader, %d linjer (%.0f s)", n_rows, len(by_line), time.time() - t0)
    d0 = date.fromisoformat(from_date)
    out: dict[int, dict[str, dict]] = {}
    for line_ref in list(by_line):
        out.setdefault(line_shard_of(line_ref), {})[line_ref] = pack_line(by_line.pop(line_ref), d0)

    target = Path(os.environ.get("LINES_OUT_DIR") or PARQUET_DIR / "lines")
    target.mkdir(parents=True, exist_ok=True)
    keep = set()
    total = 0
    for shard, lines in out.items():
        p = target / f"{shard}.json"
        p.write_text(json.dumps({"v": FORMAT_VERSION, "from": from_date, "to": latest,
                                 "lines": lines}, separators=(",", ":")),
                     encoding="utf-8")
        keep.add(p.name)
        total += p.stat().st_size
    # Shards som ble tomme (linjer som falt ut av vinduet) må bort, ellers
    # ville klienten lest gamle tall med feil vindu — index.json skrives sist.
    for p in target.glob("*.json"):
        if p.name != "index.json" and p.name not in keep:
            p.unlink()
    (target / "index.json").write_text(json.dumps({
        "v": FORMAT_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "from": from_date, "to": latest, "days": LINE_DAYS, "shards": LINE_SHARDS,
    }, separators=(",", ":")), encoding="utf-8")
    log.info("→ %s: %d filer, %.1f MB (%.0f s)", target, len(keep), total / 1e6, time.time() - t0)
    return 0


def main() -> int:
    return build_line_shards()


def _week_end(name: str) -> date:
    """«2026-W47-by-line.parquet» → søndagen i uka."""
    y, w = name[:4], name[6:8]
    return date.fromisocalendar(int(y), int(w), 7)


if __name__ == "__main__":
    sys.exit(main())
