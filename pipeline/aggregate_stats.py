#!/usr/bin/env python3
"""
Full offload: beregn aggregert statistikk fra Parquet-ukefilene med DuckDB og
skriv små JSON-artefakter som nettleseren leser direkte fra R2 — ingen
SQLite-server, ingen aggregat-tabeller.

Kjøres nattlig ETTER export_parquet.py og FØR upload_to_r2.py:

    python pipeline/aggregate_stats.py

Output (skrives til PARQUET_DIR, lastes opp av upload_to_r2.py med no-cache):

  stats_summary.json     Dashboard + topplister:
                           daily:  per (dato, operatør) — snitt, punktlighet,
                                   andel >10 min, antall avganger
                           lines:  per (linje, modus, vindu 7/30/90) — snitt,
                                   stddev, punktlighet, andel >10 min, avganger
  stats_stops_map.json   Kart + stopp-topplister:
                           per (stopp, operatør) med koordinater og
                           [snitt, andel >2 min, stddev, avganger] per vindu

Alle prosenter er 0–100. Forsinkelse = COALESCE(delay_departure_min,
delay_arrival_min) — samme definisjon som resten av systemet.

Env:
    PARQUET_DIR     hvor ukefilene ligger (default data/parquet)
    DATABASE_PATH   SQLite med stop_coords for lat/lng (default data/reise.db)
    STATS_WINDOWS   kommaseparerte vinduer i dager (default "7,30,90")
"""

import json
import logging
import os
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).parent.parent
PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", str(REPO_ROOT / "data" / "parquet")))
DB_PATH = os.environ.get("DATABASE_PATH", str(REPO_ROOT / "data" / "reise.db"))
WINDOWS = [int(w) for w in os.environ.get("STATS_WINDOWS", "7,30,90").split(",")]

# Minste antall avganger for at en linje/et stopp tas med i et vindu —
# hindrer at én enkelt observasjon topper listene.
MIN_JOURNEYS_LINE = 5
MIN_DEPARTURES_STOP = 10

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# Forsinkelses-uttrykk (minutter): avgang der den finnes, ellers ankomst.
D = "COALESCE(delay_departure_min, delay_arrival_min)"


def r(v, digits=2):
    """Rund flyttall for kompakt JSON; None passerer gjennom."""
    return None if v is None else round(float(v), digits)


def main() -> int:
    started = time.time()
    files = sorted(PARQUET_DIR.glob("*.parquet"))
    if not files:
        log.error("Ingen parquet-filer i %s — kjør export_parquet.py først", PARQUET_DIR)
        return 1

    con = duckdb.connect()
    file_list = ", ".join(f"'{f.as_posix()}'" for f in files)
    con.execute(f"CREATE VIEW delays AS SELECT * FROM read_parquet([{file_list}])")

    max_date_s, min_date_s = con.execute(
        "SELECT MAX(date), MIN(date) FROM delays"
    ).fetchone()
    max_date = date.fromisoformat(max_date_s)
    log.info("Datagrunnlag: %s → %s (%d filer)", min_date_s, max_date_s, len(files))

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # ------------------------------------------------------------------
    # Sanntidsdekning per (dato, operatør) fra coverage_daily i SQLite —
    # målt ved ingest (kan ikke utledes fra parquet, som kun har sanntidsrader).
    # ------------------------------------------------------------------
    coverage: dict[tuple, float] = {}
    cancellations: dict[tuple, int] = {}
    silent_journeys: dict[tuple, int] = {}
    if Path(DB_PATH).exists():
        sq = sqlite3.connect(DB_PATH)
        try:
            has_table = sq.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='coverage_daily'"
            ).fetchone()
            if has_table:
                cols = {r[1] for r in sq.execute("PRAGMA table_info(coverage_daily)")}
                canc_expr = "SUM(n_cancelled)" if "n_cancelled" in cols else "NULL"
                silent_expr = (
                    "SUM(n_journeys_norealtime)" if "n_journeys_norealtime" in cols else "NULL"
                )
                for d, op, total, rt, canc, silent in sq.execute(f"""
                    SELECT date,
                           substr(line_ref, 1, instr(line_ref, ':') - 1) AS operator,
                           SUM(n_total), SUM(n_realtime), {canc_expr}, {silent_expr}
                    FROM coverage_daily
                    GROUP BY 1, 2
                """):
                    if total:
                        coverage[(d, op)] = round(100.0 * rt / total, 1)
                    if canc is not None:
                        cancellations[(d, op)] = int(canc)
                    if silent is not None:
                        silent_journeys[(d, op)] = int(silent)
        finally:
            sq.close()
        log.info("coverage_daily: %d (dato, operatør)-rader", len(coverage))

    # ------------------------------------------------------------------
    # daily: per (dato, operatør)
    # ------------------------------------------------------------------
    daily_rows = con.execute(f"""
        SELECT
            date,
            split_part(line_ref, ':', 1)                    AS operator,
            ROUND(AVG({D}), 2)                              AS avg_delay,
            ROUND(100.0 * AVG(CASE WHEN {D} <= 2 THEN 1 ELSE 0 END), 1) AS pct_on_time,
            ROUND(100.0 * AVG(CASE WHEN {D} > 10 THEN 1 ELSE 0 END), 1)             AS pct_10plus,
            COUNT(DISTINCT service_journey_id)              AS journeys,
            COUNT(*)                                        AS n
        FROM delays
        WHERE {D} IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
    """).fetchall()
    daily = [
        {
            "date": row[0], "operator": row[1],
            "avgDelayMin": r(row[2]), "pctOnTime": r(row[3], 1),
            "pctDelayed10plus": r(row[4], 1),
            "totalJourneys": int(row[5]), "n": int(row[6]),
            "pctRealtimeCoverage": coverage.get((row[0], row[1])),
            # Avlyste avganger (unike) fra coverage_daily — null før 6. juli 2026
            "totalCancellations": cancellations.get((row[0], row[1])),
            # Avganger i feeden HELT uten sanntid (ikke avlyst) — null før 6. juli 2026
            "journeysMissingRealtime": silent_journeys.get((row[0], row[1])),
        }
        for row in daily_rows
    ]
    log.info("daily: %d rader", len(daily))

    # ------------------------------------------------------------------
    # lines: per (linje, modus inkl. 'all', vindu)
    # ------------------------------------------------------------------
    lines = []
    for w in WINDOWS:
        cutoff = (max_date - timedelta(days=w - 1)).isoformat()
        for mode_expr, mode_label in [("'all'", None), ("vehicle_mode", None)]:
            rows = con.execute(f"""
                SELECT
                    line_ref,
                    {mode_expr}                              AS mode,
                    ROUND(AVG({D}), 2)                       AS avg_delay,
                    ROUND(STDDEV_SAMP({D}), 2)               AS stddev,
                    ROUND(100.0 * AVG(CASE WHEN {D} <= 2 THEN 1 ELSE 0 END), 1) AS pct_on_time,
                    ROUND(100.0 * AVG(CASE WHEN {D} > 10 THEN 1 ELSE 0 END), 1)             AS pct_10plus,
                    COUNT(DISTINCT service_journey_id || date) AS departures
                FROM delays
                WHERE date >= '{cutoff}' AND {D} IS NOT NULL
                GROUP BY 1, 2
                HAVING COUNT(DISTINCT service_journey_id || date) >= {MIN_JOURNEYS_LINE}
            """).fetchall()
            for row in rows:
                lines.append({
                    "lineRef": row[0], "mode": row[1], "window": w,
                    "avgDelayMin": r(row[2]), "stddevDelayMin": r(row[3]),
                    "pctOnTime": r(row[4], 1), "pctDelayed10plus": r(row[5], 1),
                    "totalDepartures": int(row[6]),
                })
    log.info("lines: %d rader (%d vinduer)", len(lines), len(WINDOWS))

    summary = {
        "generatedAt": generated_at,
        "windows": WINDOWS,
        "dates": {"min": min_date_s, "max": max_date_s},
        "daily": daily,
        "lines": lines,
    }
    summary_path = PARQUET_DIR / "stats_summary.json"
    summary_path.write_text(json.dumps(summary, separators=(",", ":")), encoding="utf-8")
    log.info("→ %s (%.0f KB)", summary_path.name, summary_path.stat().st_size / 1024)

    # ------------------------------------------------------------------
    # stops: per (stopp, operatør) × vindu — kart + stopp-topplister.
    # Kompakt format: rader er arrays, vinduer er [avg, pct2plus, stddev, n]
    # eller null når stoppet mangler data i vinduet.
    # ------------------------------------------------------------------
    coords: dict[str, tuple] = {}
    if Path(DB_PATH).exists():
        sq = sqlite3.connect(DB_PATH)
        try:
            for ref, lat, lng in sq.execute("SELECT stop_ref, lat, lng FROM stop_coords"):
                coords[ref] = (lat, lng)
        finally:
            sq.close()
        log.info("stop_coords: %d koordinater fra %s", len(coords), DB_PATH)
    else:
        log.warning("Fant ikke %s — kartet får ingen koordinater", DB_PATH)

    # windows-dict per (stop, operator)
    stops: dict[tuple, dict] = {}
    for w in WINDOWS:
        cutoff = (max_date - timedelta(days=w - 1)).isoformat()
        rows = con.execute(f"""
            SELECT
                stop_ref,
                split_part(line_ref, ':', 1)   AS operator,
                MAX(stop_name)                 AS stop_name,
                ROUND(AVG({D}), 2)             AS avg_delay,
                ROUND(100.0 * AVG(CASE WHEN {D} > 2 THEN 1 ELSE 0 END), 1) AS pct_2plus,
                ROUND(STDDEV_SAMP({D}), 2)     AS stddev,
                COUNT(DISTINCT service_journey_id || date) AS departures
            FROM delays
            WHERE date >= '{cutoff}' AND {D} IS NOT NULL
            GROUP BY 1, 2
            HAVING COUNT(DISTINCT service_journey_id || date) >= {MIN_DEPARTURES_STOP}
        """).fetchall()
        for stop_ref, operator, name, avg, pct2, std, dep in rows:
            key = (stop_ref, operator)
            entry = stops.setdefault(key, {"name": name, "w": {}})
            if name and not entry["name"]:
                entry["name"] = name
            entry["w"][w] = [r(avg), r(pct2, 1), r(std), int(dep)]

    # Radformat: [stopRef, operator, stopName, lat, lng, w1, w2, w3]
    stop_rows = []
    for (stop_ref, operator), entry in sorted(stops.items()):
        lat, lng = coords.get(stop_ref, (None, None))
        stop_rows.append([
            stop_ref, operator, entry["name"], lat, lng,
            *[entry["w"].get(w) for w in WINDOWS],
        ])

    stops_doc = {
        "generatedAt": generated_at,
        "windows": WINDOWS,
        "cols": ["stopRef", "operator", "stopName", "lat", "lng",
                 *[f"w{w}" for w in WINDOWS]],
        "wcols": ["avgDelayMin", "pctDelayed2plus", "stddevDelayMin", "totalDepartures"],
        "stops": stop_rows,
    }
    stops_path = PARQUET_DIR / "stats_stops_map.json"
    stops_path.write_text(json.dumps(stops_doc, separators=(",", ":")), encoding="utf-8")
    log.info("→ %s (%d stopp, %.0f KB)", stops_path.name, len(stop_rows),
             stops_path.stat().st_size / 1024)

    log.info("Ferdig på %.1fs", time.time() - started)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
