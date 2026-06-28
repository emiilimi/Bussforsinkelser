#!/usr/bin/env python3
"""
Slanket daglig pipeline for reise.emoldestad.no (reiseplanlegger-siten).

Forskjell fra ingest.py:
  - Skriver KUN `journey_stop_daily` (+ `stop_coords` finnes for stop_name-join).
  - Ingen av de ubegrensede aggregat-tabellene (daily_summary, line_daily,
    stop_daily, *_hourly_raw, *_hourly_profile, leaderboards, worst_days,
    data_quality_log). Det er disse som fyller opp disken — journey_stop_daily
    er allerede et rullende 90-dagers vindu og holder seg lite.

Alt reiseplanleggeren + journey/line/stop-analyse (90 dager) trenger ligger i
journey_stop_daily → Parquet → R2 → DuckDB-WASM i nettleseren. Denne pipelinen
produserer nettopp den ene tabellen, og ingenting mer.

Kjedet kjøres slik (se REISE.md):
    python pipeline/ingest_lite.py            # gårsdagen, alle operatører
    python pipeline/export_parquet.py         # eksporter nye/ufullstendige uker
    python pipeline/upload_to_r2.py           # last opp parquet + manifest til R2

Gjenbruker fetch_day / compute_delays / upsert_journey_stop_daily fra ingest.py
slik at forsinkelsesberegningen er nøyaktig den samme som i hoved-pipelinen.

Usage:
    python pipeline/ingest_lite.py                     # i går, alle operatører
    python pipeline/ingest_lite.py 2026-06-26          # bestemt dato
    python pipeline/ingest_lite.py --operator SKY      # bare Skyss
    python pipeline/ingest_lite.py 2026-06-26 --operator SKY,RUT

Env-variabler:
    DATABASE_PATH        SQLite-fil (default: data/reise.db — EGEN, lett base)
    BQ_TABLE             BigQuery-kilde (arves fra ingest.py)
    BQ_OPERATOR          komma-separerte operatører (arves fra ingest.py)
    JSD_RETENTION_DAYS   hvor mange dager journey_stop_daily beholdes (default 90)
    LOG_LEVEL            INFO (default) / DEBUG
"""

import argparse
import logging
import os
import sqlite3
import time
from datetime import date, timedelta
from pathlib import Path

# Gjenbruk all BQ-/beregningslogikk fra hoved-pipelinen, slik at tallene er
# identiske og vi ikke duplikerer kode.
try:
    from .ingest import fetch_day, compute_delays, upsert_journey_stop_daily, OPERATORS, _ALL_OPERATORS
    from .day_type import compute_day_type
except ImportError:
    # Kjøres som `python pipeline/ingest_lite.py` (ingen pakke-kontekst).
    from ingest import fetch_day, compute_delays, upsert_journey_stop_daily, OPERATORS, _ALL_OPERATORS  # type: ignore
    from day_type import compute_day_type  # type: ignore

from google.cloud import bigquery

# ---------------------------------------------------------------------------
# Konfigurasjon
# ---------------------------------------------------------------------------

# Egen, lett database — rører ikke den tunge data/bussforsinkelser.db.
# Når du er trygg på at reise-siten fungerer kan du slette den gamle basen.
DB_PATH = os.environ.get(
    "DATABASE_PATH",
    str(Path(__file__).parent.parent / "data" / "reise.db"),
)

# Hvor lenge rådata beholdes lokalt. 90 = samme vindu som nettleseren viser.
# Du kan sette dette lavere (f.eks. 21) for å spare ytterligere diskplass —
# eldre uker ligger allerede som Parquet på R2, så nettleseren mister ikke
# historikk. Eneste konsekvens: du kan ikke re-generere en Parquet-fil eldre
# enn vinduet uten å hente dataene fra BigQuery på nytt.
RETENTION_DAYS = int(os.environ.get("JSD_RETENTION_DAYS", "90"))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Minimal schema — kun det reise-siten trenger
# ---------------------------------------------------------------------------

LITE_SCHEMA = """
-- Rå per-avgang per-stopp observasjoner (multimodal, rullende vindu).
-- Eneste tabell som eksporteres til Parquet for reiseplanleggeren.
CREATE TABLE IF NOT EXISTS journey_stop_daily (
    date                TEXT    NOT NULL,
    service_journey_id  TEXT    NOT NULL,
    line_ref            TEXT    NOT NULL,
    direction_ref       TEXT    NOT NULL,
    stop_ref            TEXT    NOT NULL,
    stop_sequence       INTEGER NOT NULL,
    aimed_arrival       TEXT,
    aimed_departure     TEXT,
    vehicle_mode        TEXT    NOT NULL DEFAULT 'bus',
    day_type            TEXT    NOT NULL DEFAULT 'weekday',
    delay_arrival_min   REAL,
    delay_departure_min REAL,
    dwell_time_sec      REAL,
    PRIMARY KEY (date, service_journey_id, stop_ref)
);

CREATE INDEX IF NOT EXISTS idx_jsd_date          ON journey_stop_daily (date);
CREATE INDEX IF NOT EXISTS idx_jsd_line          ON journey_stop_daily (line_ref);
CREATE INDEX IF NOT EXISTS idx_jsd_stop          ON journey_stop_daily (stop_ref);
CREATE INDEX IF NOT EXISTS idx_jsd_journey       ON journey_stop_daily (service_journey_id);
CREATE INDEX IF NOT EXISTS idx_jsd_line_stop     ON journey_stop_daily (line_ref, stop_ref);
CREATE INDEX IF NOT EXISTS idx_jsd_day_type      ON journey_stop_daily (day_type);
CREATE INDEX IF NOT EXISTS idx_jsd_line_day_type ON journey_stop_daily (line_ref, day_type);

-- Stoppkoordinater/-navn. Brukes av export_parquet.py (LEFT JOIN → stop_name).
-- Fylles av pipeline/populate_stops.py (fra cache, ingen BQ-kostnad).
CREATE TABLE IF NOT EXISTS stop_coords (
    stop_ref        TEXT PRIMARY KEY,
    stop_name       TEXT,
    lat             REAL,
    lng             REAL,
    stop_place_ref  TEXT,
    platform_code   TEXT,
    stop_place_name TEXT
);
"""


def init_lite_db(conn: sqlite3.Connection) -> None:
    """Opprett den slanke schemaen hvis den ikke finnes (idempotent)."""
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(LITE_SCHEMA)


def prune_old_rows(conn: sqlite3.Connection, retention_days: int) -> None:
    """Slett rader eldre enn retention-vinduet. Holder basen liten."""
    cur = conn.execute(
        "DELETE FROM journey_stop_daily WHERE date < date('now', ?)",
        (f"-{retention_days} days",),
    )
    if cur.rowcount and cur.rowcount > 0:
        log.info("  Pruned %d rader eldre enn %d dager", cur.rowcount, retention_days)


# ---------------------------------------------------------------------------
# Hovedløp
# ---------------------------------------------------------------------------

def run(target_date: date, operators: list[str] | None = None) -> None:
    if operators is None:
        operators = OPERATORS
    log.info("=== Lett ingest (reise): %s (operatører: %s) ===", target_date, operators)
    started = time.time()

    client = bigquery.Client()
    df = fetch_day(client, target_date, operators)

    if df.empty:
        log.warning("Ingen rader for %s — ingenting å skrive", target_date)
        return

    df = compute_delays(df)
    date_str = target_date.isoformat()
    day_type = compute_day_type(target_date)
    log.info("  day_type=%s for %s (%d rader etter filtrering)", day_type, date_str, len(df))

    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        init_lite_db(conn)
        with conn:
            upsert_journey_stop_daily(conn, date_str, df, day_type)
            prune_old_rows(conn, RETENTION_DAYS)
        # Hold filen kompakt — ellers vokser den selv om vi sletter rader.
        conn.execute("VACUUM")
        log.info("=== Ferdig: %s skrevet til %s (%.1fs) ===",
                 date_str, DB_PATH, time.time() - started)
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Slanket daglig BigQuery → SQLite (kun journey_stop_daily) for reise-siten",
    )
    parser.add_argument(
        "date", nargs="?",
        help="Operating date (YYYY-MM-DD). Default: i går.",
    )
    parser.add_argument(
        "--operator", "--operators", dest="operator", default=None,
        help=(
            "Komma-separerte operatørkoder, f.eks. SKY eller SKY,RUT. "
            f"Overstyrer BQ_OPERATOR. Default: alle ({_ALL_OPERATORS})."
        ),
    )
    args = parser.parse_args()

    target = (
        date.fromisoformat(args.date)
        if args.date
        else date.today() - timedelta(days=1)
    )
    ops = (
        [op.strip() for op in args.operator.split(",") if op.strip()]
        if args.operator
        else OPERATORS
    )
    run(target, ops)
