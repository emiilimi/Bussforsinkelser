#!/usr/bin/env python3
"""
Lag en strippet DB-kopi for prod-deploy (Railway) uten journey_stop_daily.

journey_stop_daily er ~360 MB/dag og vokser til ~65 GB ved 90-dagers vindu
for hele Norge. Railway Hobby Volume = 5 GB — tabellen må fjernes fra prod-DB.
Tabellen lever videre lokalt og eksporteres til Parquet for DuckDB-WASM.

Usage:
    python pipeline/strip_for_prod.py
    python pipeline/strip_for_prod.py --output data/bussforsinkelser_prod.db

Output:
    data/bussforsinkelser_prod.db  (alle aggregerte tabeller, uten journey_stop_daily)
"""

import argparse
import logging
import os
import shutil
import sqlite3
from pathlib import Path

DB_PATH = os.environ.get(
    "DATABASE_PATH",
    str(Path(__file__).parent.parent / "data" / "bussforsinkelser.db"),
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

TABLES_TO_STRIP = ["journey_stop_daily"]


def main():
    parser = argparse.ArgumentParser(
        description="Lag strippet DB-kopi for prod-deploy (uten journey_stop_daily)"
    )
    parser.add_argument(
        "--output",
        default=str(Path(DB_PATH).parent / "bussforsinkelser_prod.db"),
        help="Sti til output-fil (default: data/bussforsinkelser_prod.db)",
    )
    args = parser.parse_args()

    src = Path(DB_PATH)
    dst = Path(args.output)

    if not src.exists():
        log.error("Kilde-DB ikke funnet: %s", src)
        return 1

    src_mb = src.stat().st_size / 1024 / 1024
    log.info("Kilde: %s (%.0f MB)", src, src_mb)
    log.info("Kopierer til %s …", dst)

    shutil.copy2(src, dst)

    conn = sqlite3.connect(dst)
    conn.execute("PRAGMA journal_mode=DELETE")  # slå av WAL-modus for ren fil

    try:
        for table in TABLES_TO_STRIP:
            # Sjekk om tabellen finnes
            exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()
            if exists:
                conn.execute(f"DROP TABLE {table}")
                log.info("  Droppet tabell: %s", table)
            else:
                log.info("  Tabell finnes ikke (allerede strippet?): %s", table)

        log.info("Kjører VACUUM (kan ta noen minutter) …")
        conn.execute("VACUUM")
        conn.commit()
    finally:
        conn.close()

    dst_mb = dst.stat().st_size / 1024 / 1024
    saved_mb = src_mb - dst_mb
    log.info(
        "Ferdig: %s (%.0f MB, spart %.0f MB = %.0f%%)",
        dst,
        dst_mb,
        saved_mb,
        (saved_mb / src_mb * 100) if src_mb > 0 else 0,
    )
    log.info("")
    log.info("Neste steg (last opp til Railway):")
    log.info("  railway link")
    log.info("  railway volume cp %s /app/data/bussforsinkelser.db", dst)


if __name__ == "__main__":
    main()
