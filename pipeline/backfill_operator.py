#!/usr/bin/env python3
"""
Etterfyll journey_stop_daily for ÉN eller FLERE dataSource-koder over et
datointervall — uten å røre dataene som allerede ligger der.

Bakgrunn: da fly (AVI) ble lagt til i operatørlista 2026-08-14, gjaldt det bare
framover. Historikken manglet flyene. Dette skriptet henter en enkelt kilde
tilbake i tid og skriver den inn ved siden av det som finnes fra før.

Trygt fordi upsert_journey_stop_daily() er et rent
INSERT ... ON CONFLICT(date, service_journey_id, stop_ref) DO UPDATE:
radene legges TIL. En bakkerad og en flyrad kan aldri kollidere (ulik
service_journey_id), så eksisterende buss-/tog-/fergedata står urørt.

Kan IKKE erstattes av `ingest_lite.py <dato>` med BQ_OPERATOR satt, fordi den:
  - avbryter på MIN_EXPECTED_ROWS (300 000) — én dag med fly er ~1 100 rader
  - kjører prune + VACUUM per dag (minutter hver gang på en 6+ GB base)

Bruk:
    python pipeline/backfill_operator.py --operator AVI \
        --from 2026-07-31 --to 2026-08-13

Etterpå må ukefilene bygges og lastes opp for at nettsiden skal se dem:
    python pipeline/export_parquet.py --week 2026-W31   (osv. per berørt uke)
    python pipeline/upload_to_r2.py --prune

Env: DATABASE_PATH (default data/bussforsinkelser.db — sett data/reise.db for
reise-siten), BQ_TABLE, LOG_LEVEL.
"""

import argparse
import logging
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from google.cloud import bigquery

sys.path.insert(0, str(Path(__file__).parent))
from ingest import fetch_day, compute_delays, upsert_journey_stop_daily  # noqa: E402
from day_type import compute_day_type  # noqa: E402

DB_PATH = os.environ.get(
    "DATABASE_PATH", str(Path(__file__).parent.parent / "data" / "bussforsinkelser.db")
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)


def parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--operator", required=True,
                   help="dataSource-kode(r), komma-separert. F.eks. AVI eller BFO,TEL")
    p.add_argument("--from", dest="date_from", required=True, help="YYYY-MM-DD (inklusiv)")
    p.add_argument("--to", dest="date_to", required=True, help="YYYY-MM-DD (inklusiv)")
    p.add_argument("--dry-run", action="store_true",
                   help="Hent og rapporter radtall, men IKKE skriv til basen")
    args = p.parse_args()

    operators = [o.strip().upper() for o in args.operator.split(",") if o.strip()]
    d_from, d_to = parse_date(args.date_from), parse_date(args.date_to)
    if d_from > d_to:
        log.error("--from er etter --to")
        return 1

    days = (d_to - d_from).days + 1
    log.info("=== Etterfyll %s: %s → %s (%d dager)%s ===",
             ",".join(operators), d_from, d_to, days, "  [DRY RUN]" if args.dry_run else "")

    client = bigquery.Client()
    conn = None if args.dry_run else sqlite3.connect(DB_PATH)
    total_fetched = total_written = 0
    started = time.time()

    try:
        for i in range(days):
            target = d_from + timedelta(days=i)
            df = fetch_day(client, target, operators)
            if df.empty:
                log.warning("  %s: ingen rader", target)
                continue
            fetched = len(df)
            total_fetched += fetched

            df = compute_delays(df)
            if df.empty:
                log.warning("  %s: %d rader hentet, 0 igjen etter filtrering", target, fetched)
                continue

            modes = ", ".join(f"{m}={n}" for m, n in df["vehicleMode"].value_counts().items())
            if args.dry_run:
                log.info("  %s: %d hentet → %d etter filtrering (%s)", target, fetched, len(df), modes)
                continue

            with conn:
                upsert_journey_stop_daily(conn, target.isoformat(), df, compute_day_type(target))
            total_written += len(df)
            log.info("  %s: %d hentet → %d skrevet (%s)", target, fetched, len(df), modes)
    finally:
        if conn is not None:
            conn.close()

    log.info("=== Ferdig: %d rader hentet, %d skrevet på %.1fs ===",
             total_fetched, total_written, time.time() - started)
    if not args.dry_run and total_written:
        log.info("Husk: export_parquet.py for berørte uker + upload_to_r2.py --prune")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
