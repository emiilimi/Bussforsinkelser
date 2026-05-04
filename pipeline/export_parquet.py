#!/usr/bin/env python3
"""
Export journey_stop_daily data from SQLite to Parquet files, partitioned per ISO week.

Parquet files are the data source for DuckDB-WASM in the browser,
enabling client-side percentile queries, scatter-plots, and transfer
probability calculations — without any server round-trip.

Usage:
    python pipeline/export_parquet.py              # export all unwritten weeks
    python pipeline/export_parquet.py --all        # re-export everything
    python pipeline/export_parquet.py --week 2026-W15  # export one specific week

Output:
    data/parquet/2026-W14.parquet
    data/parquet/2026-W15.parquet
    ...

Designed to run weekly via cron (after nightly ingest has populated journey_stop_daily).
"""

import argparse
import logging
import os
import sqlite3
from datetime import date, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DB_PATH = os.environ.get(
    "DATABASE_PATH",
    str(Path(__file__).parent.parent / "data" / "bussforsinkelser.db"),
)

PARQUET_DIR = os.environ.get(
    "PARQUET_DIR",
    str(Path(__file__).parent.parent / "data" / "parquet"),
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# Arrow schema — explicit types so every Parquet file has identical structure,
# even if a column is all-NULL for a given week.
ARROW_SCHEMA = pa.schema([
    ("date", pa.string()),
    ("service_journey_id", pa.string()),
    ("line_ref", pa.string()),
    ("direction_ref", pa.string()),
    ("stop_ref", pa.string()),
    ("stop_sequence", pa.int32()),
    ("aimed_arrival", pa.string()),
    ("aimed_departure", pa.string()),
    ("delay_arrival_min", pa.float32()),
    ("delay_departure_min", pa.float32()),
    ("dwell_time_sec", pa.float32()),
    ("vehicle_mode", pa.string()),
    ("day_type", pa.string()),
    ("stop_name", pa.string()),   # fra stop_coords JOIN — brukes av DuckDB-WASM direkte
])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def iso_week_str(d: date) -> str:
    """Return ISO week string like '2026-W15'."""
    year, week, _ = d.isocalendar()
    return f"{year}-W{week:02d}"


def monday_of_week(week_str: str) -> date:
    """'2026-W15' -> date(2026, 4, 6)."""
    from datetime import datetime
    return datetime.strptime(week_str + "-1", "%G-W%V-%u").date()


def get_weeks_in_db(conn: sqlite3.Connection) -> list[str]:
    """Return sorted list of ISO week strings that have data in journey_stop_daily."""
    rows = conn.execute("""
        SELECT DISTINCT strftime('%G-W', date,  'weekday 0', '-6 days')
                     || printf('%02d', CAST(strftime('%W', date, 'weekday 0', '-6 days') AS INT) +
                        CASE WHEN strftime('%w', date(strftime('%Y', date, 'weekday 0', '-6 days') || '-01-01')) <= '4'
                             THEN 1 ELSE 0 END)
        FROM journey_stop_daily
        ORDER BY 1
    """).fetchall()
    # Simpler approach: compute in Python from distinct dates
    date_rows = conn.execute("SELECT DISTINCT date FROM journey_stop_daily ORDER BY date").fetchall()
    weeks = sorted({iso_week_str(date.fromisoformat(r[0])) for r in date_rows})
    return weeks


def get_existing_parquet_weeks(parquet_dir: str) -> set[str]:
    """Return set of week strings that already have a Parquet file."""
    d = Path(parquet_dir)
    if not d.exists():
        return set()
    return {f.stem for f in d.glob("*.parquet")}


def export_week(conn: sqlite3.Connection, week_str: str, parquet_dir: str) -> int:
    """Export one ISO week of journey_stop_daily to a Parquet file. Returns row count."""
    mon = monday_of_week(week_str)
    sun = mon + timedelta(days=6)

    rows = conn.execute(
        """
        SELECT j.date, j.service_journey_id, j.line_ref, j.direction_ref, j.stop_ref,
               j.stop_sequence, j.aimed_arrival, j.aimed_departure,
               j.delay_arrival_min, j.delay_departure_min, j.dwell_time_sec,
               j.vehicle_mode, j.day_type,
               s.stop_name
        FROM journey_stop_daily j
        LEFT JOIN stop_coords s ON s.stop_ref = j.stop_ref
        WHERE j.date >= ? AND j.date <= ?
        ORDER BY j.date, j.line_ref, j.service_journey_id, j.stop_sequence
        """,
        (mon.isoformat(), sun.isoformat()),
    ).fetchall()

    if not rows:
        log.info("  %s: no data, skipping", week_str)
        return 0

    # Build columnar arrays
    cols = list(zip(*rows))
    arrays = [
        pa.array(cols[0], type=pa.string()),       # date
        pa.array(cols[1], type=pa.string()),       # service_journey_id
        pa.array(cols[2], type=pa.string()),       # line_ref
        pa.array(cols[3], type=pa.string()),       # direction_ref
        pa.array(cols[4], type=pa.string()),       # stop_ref
        pa.array(cols[5], type=pa.int32()),        # stop_sequence
        pa.array(cols[6], type=pa.string()),       # aimed_arrival
        pa.array(cols[7], type=pa.string()),       # aimed_departure
        pa.array(cols[8], type=pa.float32()),      # delay_arrival_min
        pa.array(cols[9], type=pa.float32()),      # delay_departure_min
        pa.array(cols[10], type=pa.float32()),     # dwell_time_sec
        pa.array(cols[11], type=pa.string()),      # vehicle_mode
        pa.array(cols[12], type=pa.string()),      # day_type
        pa.array(cols[13], type=pa.string()),      # stop_name
    ]

    table = pa.table(arrays, schema=ARROW_SCHEMA)

    out_path = Path(parquet_dir) / f"{week_str}.parquet"
    pq.write_table(table, out_path, compression="zstd")

    size_kb = out_path.stat().st_size / 1024
    log.info("  %s: %d rows → %s (%.0f KB)", week_str, len(rows), out_path.name, size_kb)
    return len(rows)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Export journey_stop_daily to Parquet")
    parser.add_argument("--all", action="store_true", help="Re-export all weeks (overwrite existing)")
    parser.add_argument("--week", type=str, help="Export one specific week (e.g. 2026-W15)")
    args = parser.parse_args()

    Path(PARQUET_DIR).mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")

    try:
        if args.week:
            # Export one specific week
            n = export_week(conn, args.week, PARQUET_DIR)
            log.info("Exported %d rows for %s", n, args.week)
            return

        db_weeks = get_weeks_in_db(conn)
        if not db_weeks:
            log.info("No data in journey_stop_daily — nothing to export")
            return

        existing = set() if args.all else get_existing_parquet_weeks(PARQUET_DIR)

        # Current (incomplete) week — always re-export since new days may have been added
        current_week = iso_week_str(date.today())

        to_export = []
        for w in db_weeks:
            if w not in existing or w == current_week:
                to_export.append(w)

        if not to_export:
            log.info("All %d weeks already exported, nothing to do", len(db_weeks))
            return

        log.info("Exporting %d week(s) to %s …", len(to_export), PARQUET_DIR)
        total_rows = 0
        for w in to_export:
            total_rows += export_week(conn, w, PARQUET_DIR)

        log.info("Done: %d total rows across %d week(s)", total_rows, len(to_export))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
