#!/usr/bin/env python3
"""
One-time historical backfill for bussforsinkelser.no

Fetches data from 2021-01-01 to yesterday, month by month, and populates
the local SQLite database. Supports multiple operators (e.g. SKY and RUT).

Safely resumable: months already fully present in daily_summary are skipped.

Usage:
    python pipeline/backfill.py                              # 2021-01-01 to yesterday, SKY
    python pipeline/backfill.py 2024-01-01                  # from custom start date
    python pipeline/backfill.py 2023-01-01 2023-06-30       # custom date range
    python pipeline/backfill.py --operator RUT               # Ruter, all dates
    python pipeline/backfill.py --operator SKY,RUT           # both operators
    python pipeline/backfill.py 2024-01-01 --operator RUT   # Ruter from 2024

WARNING: This will query several years of BigQuery data.
         Each month is ~1–5 GB scanned. Total ~50–150 GB over 4 years.
         At BigQuery's free tier (1 TB/month), run no more than 5–10 months
         per calendar month to stay within the free limit.
"""

import os
import sqlite3
import logging
import sys
from calendar import monthrange
from datetime import date, timedelta
from pathlib import Path

from google.cloud import bigquery

from ingest import (
    BQ_TABLE,
    DB_PATH,
    OPERATORS,
    compute_delays,
    upsert_daily_summary,
    upsert_line_daily,
    upsert_stop_daily,
    upsert_line_hourly_raw,
    upsert_stop_hourly_raw,
    upsert_journey_stop_weekly,
    upsert_journey_stop_daily,
    refresh_line_hourly_profile,
    refresh_stop_hourly_profile,
    refresh_leaderboards,
)
from day_type import compute_day_type

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

BACKFILL_START = date(2021, 1, 1)


# ---------------------------------------------------------------------------
# Month-level helpers
# ---------------------------------------------------------------------------

def months_between(start: date, end: date) -> list[tuple[date, date]]:
    """Return list of (month_start, month_end) tuples, inclusive of end."""
    result = []
    cur = date(start.year, start.month, 1)
    while cur <= end:
        last_day = monthrange(cur.year, cur.month)[1]
        month_end = min(date(cur.year, cur.month, last_day), end)
        result.append((cur, month_end))
        # Advance to first day of next month
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)
    return result


def dates_in_db(
    conn: sqlite3.Connection,
    month_start: date,
    month_end: date,
    operators: list[str],
) -> set[str]:
    """Return dates already fully ingested for ALL requested operators in this month.

    A date is considered "done" only when every requested operator has at least
    one row in daily_summary for that date.  This prevents skipping dates that
    were ingested for SKY but not yet for RUT when running multi-operator.
    """
    ops_placeholders = ",".join("?" * len(operators))
    rows = conn.execute(
        f"""
        SELECT date
        FROM daily_summary
        WHERE date >= ? AND date <= ?
          AND operator IN ({ops_placeholders})
        GROUP BY date
        HAVING COUNT(DISTINCT operator) >= ?
        """,
        (month_start.isoformat(), month_end.isoformat(), *operators, len(operators)),
    ).fetchall()
    return {r[0] for r in rows}


def fetch_month(
    client: bigquery.Client,
    month_start: date,
    month_end: date,
    operators: list[str],
):
    """
    Fetch one full month from BigQuery for the given operators.
    Returns a DataFrame with a 'dataSource' column so per-day splits work
    across multiple operators.
    """
    ops_sql = ", ".join(f"'{op}'" for op in operators)
    query = f"""
    SELECT
        operatingDate,
        lineRef,
        directionRef,
        vehicleMode,
        stopPointRef,
        stopPointName,
        journeyCancellation,
        aimedDepartureTime,
        departureTime,
        aimedArrivalTime,
        arrivalTime,
        dayOfTheWeek,
        serviceJourneyId,
        sequenceNr,
        dataSource
    FROM `{BQ_TABLE}`
    WHERE
        operatingDate BETWEEN '{month_start.isoformat()}' AND '{month_end.isoformat()}'
        AND dataSource IN ({ops_sql})
    """
    log.info("Fetching %s – %s (operators: %s) from BigQuery …", month_start, month_end, operators)
    df = client.query(query).to_dataframe()
    log.info("  Received %s rows", f"{len(df):,}")
    return df


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(
    start: date = BACKFILL_START,
    end: date | None = None,
    operators: list[str] | None = None,
) -> None:
    if end is None:
        end = date.today() - timedelta(days=1)
    if operators is None:
        operators = OPERATORS

    log.info("=== Backfill: %s to %s (operators: %s) ===", start, end, operators)

    client = bigquery.Client()
    conn = sqlite3.connect(DB_PATH)

    try:
        month_ranges = months_between(start, end)
        log.info("Processing %d months", len(month_ranges))

        for month_start, month_end in month_ranges:
            already_done = dates_in_db(conn, month_start, month_end, operators)

            # How many days does this month have?
            expected_days = (month_end - month_start).days + 1
            if len(already_done) >= expected_days:
                log.info("  %s – already complete, skipping", month_start.strftime("%Y-%m"))
                continue

            df = fetch_month(client, month_start, month_end, operators)
            if df.empty:
                log.warning("  No data for %s", month_start.strftime("%Y-%m"))
                continue

            df = compute_delays(df)

            # Process day by day within the month
            cur = month_start
            while cur <= month_end:
                date_str = cur.isoformat()
                if date_str in already_done:
                    cur += timedelta(days=1)
                    continue

                day_df = df[df["operatingDate"].astype(str) == date_str]
                if day_df.empty:
                    log.debug("  No rows for %s", date_str)
                    cur += timedelta(days=1)
                    continue

                day_type = compute_day_type(cur)
                with conn:
                    upsert_daily_summary(conn, date_str, day_df)
                    upsert_line_daily(conn, date_str, day_df)
                    upsert_stop_daily(conn, date_str, day_df)
                    upsert_line_hourly_raw(conn, date_str, day_df, day_type)
                    upsert_stop_hourly_raw(conn, date_str, day_df, day_type)
                    upsert_journey_stop_weekly(conn, date_str, day_df)
                    upsert_journey_stop_daily(conn, date_str, day_df, day_type)

                cur += timedelta(days=1)

            log.info("  %s committed", month_start.strftime("%Y-%m"))

        log.info("Rebuilding leaderboards and hourly profiles …")
        with conn:
            refresh_line_hourly_profile(conn)
            refresh_stop_hourly_profile(conn)
            refresh_leaderboards(conn)

        log.info("=== Backfill complete ===")

    finally:
        conn.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Historical backfill for bussforsinkelser.no",
    )
    parser.add_argument(
        "start",
        nargs="?",
        help="Start date (YYYY-MM-DD). Defaults to 2021-01-01.",
    )
    parser.add_argument(
        "end",
        nargs="?",
        help="End date (YYYY-MM-DD). Defaults to yesterday.",
    )
    parser.add_argument(
        "--operator",
        "--operators",
        dest="operator",
        default=None,
        help=(
            "Comma-separated operator code(s), e.g. SKY or SKY,RUT. "
            "Overrides BQ_OPERATOR env var. Defaults to SKY."
        ),
    )
    args = parser.parse_args()

    start_date = date.fromisoformat(args.start) if args.start else BACKFILL_START
    end_date = date.fromisoformat(args.end) if args.end else None
    ops = (
        [op.strip() for op in args.operator.split(",") if op.strip()]
        if args.operator
        else OPERATORS
    )

    run(start_date, end_date, ops)
