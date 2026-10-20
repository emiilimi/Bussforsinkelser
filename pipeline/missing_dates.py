"""Finn dager som mangler i reise-basen, slik at nattjobben kan ta dem igjen.

Bakgrunn (5. september 2026): PC-en sov gjennom 06:00-kjøringen. Task
Scheduler startet jobben ved oppvåkning i stedet, men `ingest_lite.py` uten
argument tar KUN gårsdagen — den hoppede dagen ble aldri hentet, og hullet var
permanent uten noen feilmelding. `NumberOfMissedRuns` var 0, for oppgaven fyrte
jo; bare sent. Det eneste sporet var en manglende logg i `logs/`.

Skriptet skriver de manglende datoene til stdout, nyeste først, som
`YYYY-MM-DD<TAB>YYYY-Www` (dato + ISO-uke, sistnevnte trengs av
export_parquet --week). Logging går til stderr, så stdout kan leses direkte
av nattskriptet.

Bruk:
    python pipeline/missing_dates.py            # 7 dager tilbake t.o.m. i gar
    python pipeline/missing_dates.py --days 3
"""
from __future__ import annotations

import argparse
import logging
import os
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from export_parquet import iso_week_str  # noqa: E402

DB_PATH = os.environ.get(
    "DATABASE_PATH",
    str(Path(__file__).parent.parent / "data" / "reise.db"),
)
RETENTION_DAYS = int(os.environ.get("JSD_RETENTION_DAYS", "14"))
DEFAULT_LOOKBACK = int(os.environ.get("CATCHUP_DAYS", "7"))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("missing_dates")


def has_data(conn: sqlite3.Connection, d: date) -> bool:
    """Er dagen ingestet? Indeksoppslag pa PK (date, ...), altsa billig.

    Hele dagen skrives i EN transaksjon i ingest_lite.run() uten interne
    commits, sa en delvis skrevet dag finnes ikke: enten er alt der, eller
    ingenting. Derfor holder det a se om det finnes en eneste rad.
    """
    row = conn.execute(
        "SELECT 1 FROM journey_stop_daily WHERE date = ? LIMIT 1",
        (d.isoformat(),),
    ).fetchone()
    return row is not None


def missing_dates(conn: sqlite3.Connection, days: int) -> list[date]:
    """Manglende dager i vinduet [i gar - days + 1, i gar], nyeste forst."""
    yesterday = date.today() - timedelta(days=1)
    return [
        d for i in range(days)
        if not has_data(conn, (d := yesterday - timedelta(days=i)))
    ]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="List dager som mangler i reise-basen (nyeste forst)",
    )
    parser.add_argument(
        "--days", type=int, default=DEFAULT_LOOKBACK,
        help=f"Hvor mange dager tilbake det sjekkes. Default: {DEFAULT_LOOKBACK}.",
    )
    parser.add_argument(
        "--refresh-weeks", action="store_true",
        help=(
            "Skriv i stedet ukene export_parquet.py friskner opp av seg selv "
            "(uten --week). Nattskriptet bruker dette til a la vaere a be om "
            "eksplisitt re-eksport av uker som allerede daekkes."
        ),
    )
    args = parser.parse_args()

    if args.refresh_weeks:
        # MA holdes i takt med refresh_weeks i export_parquet.main().
        today = date.today()
        for w in sorted({iso_week_str(today), iso_week_str(today - timedelta(days=1))}):
            print(w)
        return 0

    # Vinduet MA ligge innenfor retention. Ellers ville en dag utenfor vinduet
    # blitt hentet fra BigQuery og prunet bort igjen samme natt -- og meldt
    # manglende pa nytt neste natt, i det uendelige.
    days = max(1, min(args.days, RETENTION_DAYS - 1))
    if days != args.days:
        log.warning(
            "Begrenser vinduet fra %d til %d dager (JSD_RETENTION_DAYS=%d)",
            args.days, days, RETENTION_DAYS,
        )

    if not Path(DB_PATH).exists():
        log.error("Fant ikke databasen: %s", DB_PATH)
        return 1

    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        gaps = missing_dates(conn, days)
    finally:
        conn.close()

    if not gaps:
        log.info("Ingen hull i de siste %d dagene", days)
        return 0

    log.info(
        "Mangler %d av %d dager: %s",
        len(gaps), days, ", ".join(d.isoformat() for d in gaps),
    )
    for d in gaps:
        print(f"{d.isoformat()}\t{iso_week_str(d)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
