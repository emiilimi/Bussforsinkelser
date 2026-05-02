#!/usr/bin/env python3
"""
One-time historical backfill for bussforsinkelser.no

Fetches all Skyss data from 2021-01-01 to yesterday, month by month,
and populates the local SQLite database.

Safely resumable: months already present in daily_summary are skipped.

Usage:
    python pipeline/backfill.py                        # 2021-01-01 to yesterday
    python pipeline/backfill.py 2024-01-01             # from custom start date
    python pipeline/backfill.py 2023-01-01 2023-06-30  # custom date range

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
    OPERATOR,
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


def dates_in_db(conn: sqlite3.Connection, month_start: date, month_end: date) -> set[str]:
    """Return set of date strings already present in daily_summary for this month."""
    rows = conn.execute(
        "SELECT date FROM daily_summary WHERE date >= ? AND date <= ?",
        (month_start.isoformat(), month_end.isoformat()),
    ).fetchall()
    return {r[0] for r in rows}


def fetch_month(client: bigquery.Client, month_start: date, month_end: date, skip_dates: set[str]):
    """
    Fetch one full month from BigQuery and ingest day by day.
    skip_dates: dates to skip (already in DB).
    """
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
        sequenceNr
    FROM `{BQ_TABLE}`
    WHERE
        operatingDate BETWEEN '{month_start.isoformat()}' AND '{month_end.isoformat()}'
        AND dataSource = '{OPERATOR}'
    """
    log.info("Fetching %s – %s from BigQuery …", month_start, month_end)
    df = client.query(query).to_dataframe()
    log.info("  Received %s rows", f"{len(df):,}")
    return df


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(start: date = BACKFILL_START, end: date | None = None) -> None:
    if end is None:
        end = date.today() - timedelta(days=1)

    log.info("=== Backfill: %s to %s ===", start, end)

    client = bigquery.Client()
    conn = sqlite3.connect(DB_PATH)

    try:
        month_ranges = months_between(start, end)
        log.info("Processing %d months", len(month_ranges))

        for month_start, month_end in month_ranges:
            already_done = dates_in_db(conn, month_start, month_end)

            # How many days does this month have?
            expected_days = (month_end - month_start).days + 1
            if len(already_done) >= expected_days:
                log.info("  %s – already complete, skipping", month_start.strftime("%Y-%m"))
                continue

            df = fetch_month(client, month_start, month_end, already_done)
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
    start_date = BACKFILL_START
    end_date = None

    if len(sys.argv) >= 2:
        start_date = date.fromisoformat(sys.argv[1])
    if len(sys.argv) >= 3:
        end_date = date.fromisoformat(sys.argv[2])

    run(start_date, end_date)
