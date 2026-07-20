#!/usr/bin/env python3
"""
Export journey_stop_daily data from SQLite to Parquet files, partitioned per ISO week.

Parquet files are the data source for DuckDB-WASM in the browser,
enabling client-side percentile queries, scatter-plots, and transfer
probability calculations — without any server round-trip.

Hver uke skrives som TO filer, samme rader men ulik fysisk sortering, slik at
Parquets radgruppe-statistikk (min/max per kolonne) faktisk kan brukes til å
hoppe over radgrupper — DuckDB kan bare "prune" effektivt langs kolonnen
dataene er sortert på. Sider som filtrerer på line_ref (linjeanalyse) og
sider som filtrerer på stop_ref (stoppanalyse, avganger) er begge vanlige,
så én sortering ville gjort den andre halvparten av spørringene trege.
Målt (juli 2026): riktig sortert fil henter ~0.3 MB i 4-5 HTTP range-kall per
uke for en typisk spørring, mot ~9-12 MB i 23 kall usortert.

    data/parquet/2026-W15-by-line.parquet   ORDER BY line_ref, direction_ref, date
    data/parquet/2026-W15-by-stop.parquet   ORDER BY stop_ref, date

Usage:
    python pipeline/export_parquet.py              # export all unwritten weeks
    python pipeline/export_parquet.py --all        # re-export everything
    python pipeline/export_parquet.py --week 2026-W15  # export one specific week

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

# Radgruppestørrelse — mindre grupper gir finere pruning-granularitet.
# pyarrow sin default (2**20 ≈ 1.05M) er for grovt til at DuckDB kan hoppe
# forbi mesteparten av en fil selv når den er sortert riktig.
ROW_GROUP_SIZE = 122_880

FAMILIES = ("by-line", "by-stop")

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
    date_rows = conn.execute("SELECT DISTINCT date FROM journey_stop_daily ORDER BY date").fetchall()
    weeks = sorted({iso_week_str(date.fromisoformat(r[0])) for r in date_rows})
    return weeks


def week_from_filename(name: str) -> str | None:
    """'2026-W15-by-line.parquet' -> '2026-W15'. None if it doesn't match."""
    stem = name[:-len(".parquet")] if name.endswith(".parquet") else name
    for fam in FAMILIES:
        suffix = f"-{fam}"
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    return None


def get_existing_parquet_weeks(parquet_dir: str) -> set[str]:
    """Return set of week strings that already have BOTH sorted variants written.

    A week with only one of the two files (e.g. from an interrupted run) is
    treated as not-yet-exported so it gets completed on the next run."""
    d = Path(parquet_dir)
    if not d.exists():
        return set()
    have: dict[str, set[str]] = {}
    for f in d.glob("*.parquet"):
        week = week_from_filename(f.name)
        if week is None:
            continue
        have.setdefault(week, set()).add(f.name)
    return {
        week for week, names in have.items()
        if all(f"{week}-{fam}.parquet" in names for fam in FAMILIES)
    }


def export_week(conn: sqlite3.Connection, week_str: str, parquet_dir: str) -> int:
    """Export one ISO week of journey_stop_daily to two Parquet files (same rows,
    sorted differently — see module docstring). Returns row count.

    Vern: eksisterende ukefiler overskrives ALDRI med en versjon som dekker
    færre dager. Det kan skje når retention-vinduet (JSD_RETENTION_DAYS) har
    kastet gamle dager, eller når bare deler av en uke er backfillet. Da
    beholdes de eksisterende (mer komplette) filene. Slett dem manuelt hvis
    du faktisk vil re-eksportere med færre dager."""
    mon = monday_of_week(week_str)
    sun = mon + timedelta(days=6)

    # Representativ fil for "har vi allerede mer komplette data enn basen?"-
    # sjekken — begge varianter av en uke inneholder alltid identiske rader
    # (bare i ulik rekkefølge), så det holder å sjekke én.
    check_path = Path(parquet_dir) / f"{week_str}-{FAMILIES[0]}.parquet"
    if check_path.exists():
        db_dates = {
            r[0] for r in conn.execute(
                "SELECT DISTINCT date FROM journey_stop_daily WHERE date >= ? AND date <= ?",
                (mon.isoformat(), sun.isoformat()),
            ).fetchall()
        }
        try:
            file_dates = set(
                pq.read_table(check_path, columns=["date"])
                .column("date").to_pylist()
            )
        except Exception:
            file_dates = set()
        missing = file_dates - db_dates
        if missing:
            log.warning(
                "  %s: basen mangler %d dag(er) som finnes i eksisterende fil (%s) — "
                "beholder filene i stedet for å skrive en mindre komplett versjon",
                week_str, len(missing), ", ".join(sorted(missing)),
            )
            return 0

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

    write_sorted_family(table, parquet_dir, week_str, "by-line",
                         [("line_ref", "ascending"), ("direction_ref", "ascending"),
                          ("date", "ascending"), ("stop_sequence", "ascending")])
    write_sorted_family(table, parquet_dir, week_str, "by-stop",
                         [("stop_ref", "ascending"), ("date", "ascending"),
                          ("stop_sequence", "ascending")])

    log.info("  %s: %d rows → 2 files", week_str, len(rows))
    return len(rows)


def write_sorted_family(
    table: "pa.Table", parquet_dir: str, week_str: str, family: str, sort_keys: list[tuple[str, str]],
) -> None:
    sorted_table = table.sort_by(sort_keys)
    out_path = Path(parquet_dir) / f"{week_str}-{family}.parquet"
    pq.write_table(sorted_table, out_path, compression="zstd", row_group_size=ROW_GROUP_SIZE)
    size_kb = out_path.stat().st_size / 1024
    log.info("    %s (%.0f KB)", out_path.name, size_kb)


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

        # Uker som fortsatt kan få nye dager, re-eksporteres alltid:
        #  - inneværende uke (åpenbart ufullstendig)
        #  - GÅRSDAGENS uke: nattlig kjøring ingester gårsdagen, så mandag
        #    morgen tilhører de nye dataene (søndag) FORRIGE uke. Uten dette
        #    ville søndagen aldri komme med i ukens fil.
        refresh_weeks = {
            iso_week_str(date.today()),
            iso_week_str(date.today() - timedelta(days=1)),
        }

        # (export_week verner selv mot å overskrive en eksisterende fil med
        # en versjon som dekker færre dager — trygt både etter retention-
        # pruning og ved delvis backfill.)
        to_export = []
        for w in db_weeks:
            if w not in existing or w in refresh_weeks:
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
