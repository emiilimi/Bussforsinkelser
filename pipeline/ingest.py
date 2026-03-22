#!/usr/bin/env python3
"""
Nightly BigQuery -> SQLite pipeline for bussforsinkelser.no

Fetches one day of Skyss SIRI ET data, computes delay statistics,
and writes them to the local SQLite database.

Usage:
    python pipeline/ingest.py                  # yesterday
    python pipeline/ingest.py 2025-03-07       # specific date

Railway cron: 0 2 * * *   (02:00 Oslo time)
"""

import os
import sqlite3
import logging
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytz
from google.cloud import bigquery

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# IMPORTANT: verify exact table path in the Entur data catalog at
# https://data.entur.no/domain/public-transport-data/product/realtime_siri_et
BQ_TABLE = os.environ.get(
    "BQ_TABLE",
    "ent-data-sharing-ext-prd.realtime_siri_et.realtime_siri_et_last_recorded",
)

DB_PATH = os.environ.get(
    "DATABASE_PATH",
    str(Path(__file__).parent.parent / "data" / "bussforsinkelser.db"),
)

OPERATOR = os.environ.get("BQ_OPERATOR", "SKY")
OSLO_TZ = pytz.timezone("Europe/Oslo")

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# BigQuery fetch
# ---------------------------------------------------------------------------

def fetch_day(client: bigquery.Client, target_date: date) -> pd.DataFrame:
    """Return all SIRI ET rows for one operating date.

    Fetches all vehicle modes (bus, tram, water, etc.) for the given operator.
    vehicle_mode is stored as a column in the DB so stats can be filtered
    per mode at query time — no need to re-run the backfill to add new modes.

    serviceJourneyId and sequenceNr are fetched for journey_stop_weekly:
    they identify the specific scheduled run ("the 06:15 Linje 6") and the
    stop's position along the route respectively.
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
        operatingDate = '{target_date.isoformat()}'
        AND dataSource = '{OPERATOR}'
    """
    log.info("Querying BigQuery for %s (all modes) …", target_date)
    df = client.query(query).to_dataframe()
    log.info("  Received %s rows", f"{len(df):,}")
    return df


# ---------------------------------------------------------------------------
# Delay calculation
# ---------------------------------------------------------------------------

def compute_delays(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    # Departure time preferred; fall back to arrival time for the last stop
    # (which has NULL aimedDepartureTime / departureTime in SIRI ET)
    aimed_dep = pd.to_datetime(df["aimedDepartureTime"], utc=True, errors="coerce")
    aimed_arr = pd.to_datetime(df["aimedArrivalTime"], utc=True, errors="coerce")
    df["aimed"] = aimed_dep.fillna(aimed_arr)

    actual_dep = pd.to_datetime(df["departureTime"], utc=True, errors="coerce")
    actual_arr = pd.to_datetime(df["arrivalTime"], utc=True, errors="coerce")
    df["actual"] = actual_dep.fillna(actual_arr)

    df["delay_min"] = (df["actual"] - df["aimed"]).dt.total_seconds() / 60
    df["is_cancelled"] = df["journeyCancellation"].astype(bool)
    # Hour of aimed departure in Oslo local time
    df["hour"] = (
        df["aimed"]
        .dt.tz_convert(OSLO_TZ)
        .dt.hour
    )
    # Normalise vehicle mode: fill nulls with "bus", then lowercase.
    # Skyss does NOT populate vehicleMode for bus trips in SIRI ET — NULL
    # means bus for this operator. Only ferry (and occasionally other modes)
    # are explicitly tagged. Ghost lines with legacy numeric stop refs are
    # filtered below by the NSR: check, so fillna("bus") is safe here.
    df["vehicleMode"] = df["vehicleMode"].fillna("bus").str.lower().str.strip()
    # Normalise direction
    df["directionRef"] = df["directionRef"].fillna("0").astype(str)
    # Drop rows with non-NSR stop refs — these belong to legacy/unregistered
    # routes (e.g. school buses with old Rutebanken numeric IDs) that were
    # never migrated to NeTEx and have no meaningful name or stop data.
    before = len(df)
    df = df[df["stopPointRef"].astype(str).str.startswith("NSR:")]
    dropped = before - len(df)
    if dropped:
        log.info("  Dropped %d rows with non-NSR stopPointRef (legacy routes)", dropped)
    return df


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def line_display_name(line_ref: str) -> str:
    """'SKY:Line:6'  ->  'Linje 6'"""
    parts = line_ref.split(":")
    if len(parts) >= 3:
        return f"Linje {parts[-1]}"
    return line_ref


def active_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Rows that are not cancelled and have a valid delay value."""
    return df[~df["is_cancelled"] & df["delay_min"].notna()]


# ---------------------------------------------------------------------------
# Upsert functions
# ---------------------------------------------------------------------------

def upsert_daily_summary(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame) -> None:
    # daily_summary is bus-only (used for the dashboard overview)
    bus_df = df[df["vehicleMode"] == "bus"]
    act = active_rows(bus_df)
    if act.empty:
        log.warning("No active bus rows for %s – skipping daily_summary", date_str)
        return
    conn.execute(
        """
        INSERT OR REPLACE INTO daily_summary
            (date, operator, avg_delay_min, pct_on_time, pct_delayed_10plus,
             total_journeys, total_cancellations)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            date_str,
            OPERATOR,
            round(act["delay_min"].mean(), 2),
            round((act["delay_min"] <= 2).mean() * 100, 1),
            round((act["delay_min"] > 10).mean() * 100, 1),
            len(act),                              # active bus stop-visits (non-cancelled)
            int(bus_df["is_cancelled"].sum()),      # bus cancellations only
        ),
    )


def upsert_line_daily(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame) -> None:
    act = active_rows(df)
    if act.empty:
        return
    rows = []
    for (line_ref, direction_ref, vehicle_mode), grp in act.groupby(
        ["lineRef", "directionRef", "vehicleMode"]
    ):
        delays = grp["delay_min"]
        rows.append((
            date_str,
            str(line_ref),
            str(direction_ref),
            str(vehicle_mode),
            line_display_name(str(line_ref)),
            round(float(delays.mean()), 2),
            round(float(delays.max()), 2),
            round(float(delays.min()), 2),
            round(float(delays.median()), 2),
            round((delays <= 2).mean() * 100, 1),
            round((delays > 2).mean() * 100, 1),
            round((delays > 10).mean() * 100, 1),
            len(grp),
        ))
    conn.executemany(
        """
        INSERT OR REPLACE INTO line_daily
            (date, line_ref, direction_ref, vehicle_mode, line_name, avg_delay_min,
             max_delay_min, min_delay_min, median_delay_min,
             pct_on_time, pct_delayed_2plus, pct_delayed_10plus,
             num_departures)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    log.info("  Upserted %d line_daily rows", len(rows))


def upsert_stop_daily(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame) -> None:
    act = active_rows(df)
    if act.empty:
        return
    rows = []
    for (stop_ref, vehicle_mode, direction_ref), grp in act.groupby(["stopPointRef", "vehicleMode", "directionRef"]):
        # Use the most common non-null stop name in the group.
        # Store NULL (not the ref) when SIRI ET has no name — lets the DB-side
        # COALESCE with stop_coords provide the proper NSR name instead.
        names = grp["stopPointName"].dropna()
        modes = names.mode()
        stop_name = modes.iloc[0] if not modes.empty else (names.iloc[0] if not names.empty else None)
        delays = grp["delay_min"]
        rows.append((
            date_str,
            str(stop_ref),
            str(direction_ref),
            str(vehicle_mode),
            OPERATOR,
            stop_name,  # None stays as SQL NULL (str(None) would give the string "None")
            round(float(delays.mean()), 2),
            round(float(delays.max()), 2),
            round(float(delays.min()), 2),
            round((delays > 2).mean() * 100, 1),
            len(grp),
        ))
    conn.executemany(
        """
        INSERT OR REPLACE INTO stop_daily
            (date, stop_ref, direction_ref, vehicle_mode, operator, stop_name, avg_delay_min,
             max_delay_min, min_delay_min, pct_delayed_2plus, num_departures)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    log.info("  Upserted %d stop_daily rows", len(rows))


def upsert_line_hourly_raw(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame) -> None:
    """Store per-hour averages for this day (used to rebuild the 30-day profile)."""
    act = active_rows(df)
    act = act[act["hour"].notna()]
    if act.empty:
        return
    rows = []
    for (line_ref, direction_ref, hour), grp in act.groupby(["lineRef", "directionRef", "hour"]):
        rows.append((
            date_str,
            str(line_ref),
            str(direction_ref),
            line_display_name(str(line_ref)),
            int(hour),
            round(grp["delay_min"].mean(), 2),
            len(grp),
        ))
    conn.executemany(
        """
        INSERT OR REPLACE INTO line_hourly_raw
            (date, line_ref, direction_ref, line_name, hour, avg_delay_min, num_samples)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def refresh_line_hourly_profile(conn: sqlite3.Connection) -> None:
    """Rebuild 30-day rolling hourly profile from raw daily buckets.

    avg_delay_min  = weighted average across all samples in the window.
    max_avg_delay_min = worst single-day average for this (line, dir, hour) over 30 days.
    min_avg_delay_min = best single-day average for this (line, dir, hour) over 30 days.
    """
    conn.execute("DELETE FROM line_hourly_profile")
    conn.execute(
        """
        INSERT INTO line_hourly_profile
            (line_ref, direction_ref, line_name, hour,
             avg_delay_min, max_avg_delay_min, min_avg_delay_min, num_samples)
        SELECT
            line_ref,
            direction_ref,
            line_name,
            hour,
            ROUND(
                SUM(avg_delay_min * num_samples) * 1.0 / SUM(num_samples),
                2
            ) AS avg_delay_min,
            ROUND(MAX(avg_delay_min), 2) AS max_avg_delay_min,
            ROUND(MIN(avg_delay_min), 2) AS min_avg_delay_min,
            SUM(num_samples) AS num_samples
        FROM line_hourly_raw
        WHERE date >= date('now', '-30 days')
        GROUP BY line_ref, direction_ref, line_name, hour
        """
    )


def upsert_stop_hourly_raw(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame) -> None:
    """Store per-hour averages per stop for this day (bus only, used to rebuild 30-day profile)."""
    act = active_rows(df[df["vehicleMode"] == "bus"])
    act = act[act["hour"].notna()]
    if act.empty:
        return
    rows = []
    for (stop_ref, hour, direction_ref), grp in act.groupby(["stopPointRef", "hour", "directionRef"]):
        rows.append((
            date_str,
            str(stop_ref),
            int(hour),
            str(direction_ref),
            OPERATOR,
            round(grp["delay_min"].mean(), 2),
            len(grp),
        ))
    conn.executemany(
        """
        INSERT OR REPLACE INTO stop_hourly_raw
            (date, stop_ref, hour, direction_ref, operator, avg_delay_min, num_samples)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def refresh_stop_hourly_profile(conn: sqlite3.Connection) -> None:
    """Rebuild 30-day rolling hourly profile per stop from raw daily buckets.

    avg_delay_min  = weighted average across all samples in the window.
    max_avg_delay_min = worst single-day average for this (stop, dir, hour) over 30 days.
    min_avg_delay_min = best single-day average for this (stop, dir, hour) over 30 days.
    """
    conn.execute("DELETE FROM stop_hourly_profile")
    conn.execute(
        """
        INSERT INTO stop_hourly_profile
            (stop_ref, hour, direction_ref, operator,
             avg_delay_min, max_avg_delay_min, min_avg_delay_min, num_samples)
        SELECT
            stop_ref,
            hour,
            direction_ref,
            operator,
            ROUND(
                SUM(avg_delay_min * num_samples) * 1.0 / SUM(num_samples),
                2
            ) AS avg_delay_min,
            ROUND(MAX(avg_delay_min), 2) AS max_avg_delay_min,
            ROUND(MIN(avg_delay_min), 2) AS min_avg_delay_min,
            SUM(num_samples) AS num_samples
        FROM stop_hourly_raw
        WHERE date >= date('now', '-30 days')
        GROUP BY stop_ref, hour, direction_ref, operator
        """
    )


def upsert_journey_stop_weekly(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame) -> None:
    """Upsert per-journey per-stop weekly aggregates (bus only).

    Groups rows by (serviceJourneyId, lineRef, directionRef, stopPointRef) and
    accumulates delay stats into weekly buckets. On conflict (same week + journey
    + stop already written from an earlier day this week), merges using weighted
    average so multiple days accumulate correctly.

    Enables:
    - Journey profile (Thomas-analysen): delay at each stop along a route
    - Worst stop on a line: GROUP BY stop_ref WHERE line_ref = 'SKY:Line:6'
    - Lines per stop: GROUP BY line_ref WHERE stop_ref = 'NSR:Quay:xxxxx'
    - Stop leaderboard filtered by line
    """
    act = active_rows(df[df["vehicleMode"] == "bus"])
    if act.empty:
        return

    # Guard: these columns are in fetch_day but may be absent in old backfill data
    if "serviceJourneyId" not in act.columns or "sequenceNr" not in act.columns:
        log.warning("  journey_stop_weekly skipped: serviceJourneyId/sequenceNr not in DataFrame")
        return

    act = act[act["serviceJourneyId"].notna() & act["sequenceNr"].notna()].copy()
    if act.empty:
        return

    # Monday of the week containing date_str
    d = date.fromisoformat(date_str)
    week_start = (d - timedelta(days=d.weekday())).isoformat()

    rows = []
    for (journey_id, line_ref, direction_ref, stop_ref), grp in act.groupby(
        ["serviceJourneyId", "lineRef", "directionRef", "stopPointRef"]
    ):
        # Stop sequence: use first value (consistent within a journey+stop group)
        stop_seq = int(grp["sequenceNr"].iloc[0])

        # Aimed time at this specific stop: HH:MM in Oslo local time
        aimed_ts = grp["aimed"].dropna()
        aimed_time = (
            aimed_ts.iloc[0].astimezone(OSLO_TZ).strftime("%H:%M")
            if not aimed_ts.empty
            else None
        )

        delays = grp["delay_min"]
        rows.append((
            week_start,
            str(journey_id),
            str(line_ref),
            str(direction_ref),
            str(stop_ref),
            stop_seq,
            aimed_time,
            round(float(delays.mean()), 2),
            round(float(delays.max()), 2),
            round(float(delays.min()), 2),
            len(delays),
        ))

    conn.executemany(
        """
        INSERT INTO journey_stop_weekly
            (week_start, service_journey_id, line_ref, direction_ref, stop_ref,
             stop_sequence, aimed_time, avg_delay_min, max_delay_min, min_delay_min,
             num_samples)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (week_start, service_journey_id, stop_ref) DO UPDATE SET
            -- Fill in aimed_time if the first insert had NULL (e.g. data arrived later in the week)
            aimed_time    = COALESCE(aimed_time, excluded.aimed_time),
            avg_delay_min = ROUND(
                (avg_delay_min * num_samples + excluded.avg_delay_min * excluded.num_samples) * 1.0
                / (num_samples + excluded.num_samples), 2),
            max_delay_min = MAX(max_delay_min, excluded.max_delay_min),
            min_delay_min = MIN(min_delay_min, excluded.min_delay_min),
            num_samples   = num_samples + excluded.num_samples
        """,
        rows,
    )

    # Prune data older than 13 weeks (~91 days)
    conn.execute("DELETE FROM journey_stop_weekly WHERE week_start < date('now', '-91 days')")
    log.info("  Upserted %d journey_stop_weekly rows (week %s)", len(rows), week_start)


def refresh_leaderboards(conn: sqlite3.Connection) -> None:
    """Rebuild all-time leaderboard tables."""
    conn.execute("DELETE FROM leaderboard_lines")
    conn.execute(
        """
        INSERT INTO leaderboard_lines
            (line_ref, line_name, avg_delay_min, pct_on_time, pct_delayed_10plus, total_departures)
        SELECT
            line_ref,
            line_name,
            ROUND(
                SUM(avg_delay_min * num_departures) * 1.0 / SUM(num_departures),
                2
            ),
            ROUND(
                SUM(pct_on_time * num_departures) * 1.0 / SUM(num_departures),
                1
            ),
            ROUND(
                SUM(pct_delayed_10plus * num_departures) * 1.0 / SUM(num_departures),
                1
            ),
            SUM(num_departures)
        FROM line_daily
        WHERE vehicle_mode = 'bus'
        GROUP BY line_ref, line_name
        """
    )

    # leaderboard_stops removed — worst/best stops are now computed live
    # in getLeaderboardStops() (server/storage.ts) with a 7-day rolling window.

    conn.execute("DELETE FROM worst_days")
    conn.execute(
        """
        INSERT INTO worst_days
            (date, operator, avg_delay_min, total_journeys, total_cancellations, pct_on_time)
        SELECT date, operator, avg_delay_min, total_journeys, total_cancellations, pct_on_time
        FROM daily_summary
        ORDER BY avg_delay_min DESC
        LIMIT 100
        """
    )
    log.info("  Leaderboards refreshed")


# ---------------------------------------------------------------------------
# Data quality logging
# ---------------------------------------------------------------------------

OUTLIER_THRESHOLD_MIN = 120  # flag delays beyond ±2 hours as potential data errors


def upsert_data_quality_log(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame) -> None:
    """Flag data quality issues: outlier delays and missing timing data.

    Outlier: abs(delay_min) > OUTLIER_THRESHOLD_MIN — likely a GPS/clock error.
    Missing: rows where both departure and arrival times were NULL after fallback.

    These are stored for frontend transparency notices; they do NOT affect stats
    (outliers are still included in averages — clipping is a separate decision).
    """
    rows = []

    # --- 1. Outlier delays ---
    if "delay_min" in df.columns and "aimed" in df.columns:
        outliers = df[df["delay_min"].notna() & (df["delay_min"].abs() > OUTLIER_THRESHOLD_MIN)].copy()
        for _, row in outliers.iterrows():
            delay = float(row["delay_min"])
            abs_min = abs(delay)
            hours = int(abs_min) // 60
            mins = int(abs_min) % 60
            delay_str = f"{hours}t {mins}min" if hours > 0 and mins > 0 else (
                f"{hours}t" if hours > 0 else f"{mins}min"
            )
            direction = "forsinket" if delay > 0 else "tidlig"

            line_ref = str(row.get("lineRef", "") or "") or None
            line_name = line_ref.split(":")[-1] if line_ref else "ukjent linje"
            journey_id = str(row.get("serviceJourneyId", "") or "") or None
            stop_ref = str(row.get("stopPointRef", "") or "") or None

            aimed_time = None
            try:
                aimed_ts = row.get("aimed")
                if aimed_ts is not None and pd.notna(aimed_ts):
                    aimed_local = pd.Timestamp(aimed_ts).tz_convert(OSLO_TZ)
                    aimed_time = aimed_local.strftime("%H:%M")
            except Exception:
                pass

            time_str = f"kl. {aimed_time} " if aimed_time else ""
            message = (
                f"Avgang {time_str}på linje {line_name} ble registrert "
                f"{delay_str} {direction}. Dette kan skyldes feil i sanntidsdata."
            ).strip()

            rows.append((
                date_str, OPERATOR, "outlier_delay",
                line_ref, journey_id, stop_ref, aimed_time,
                round(delay, 1), 1, None, message,
            ))

    # --- 2. Missing timing data ---
    if "aimed" in df.columns:
        n_missing = int(df["aimed"].isna().sum())
        n_total = len(df)
        if n_missing > 0 and n_total > 0:
            pct = round(n_missing / n_total * 100, 1)
            message = (
                f"{n_missing} av {n_total} registreringer ({pct}%) manglet "
                f"tidsstempeldata for {date_str} og ble utelatt fra statistikken."
            )
            rows.append((
                date_str, OPERATOR, "missing_time",
                None, None, None, None,
                None, n_missing, n_total, message,
            ))

    if not rows:
        return

    # Clear old entries for this date+operator before re-inserting
    conn.execute(
        "DELETE FROM data_quality_log WHERE date = ? AND operator = ?",
        (date_str, OPERATOR),
    )
    conn.executemany(
        """
        INSERT INTO data_quality_log
            (date, operator, type, line_ref, service_journey_id, stop_ref,
             aimed_time, delay_min, count, total, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    n_outliers = sum(1 for r in rows if r[2] == "outlier_delay")
    n_missing = sum(1 for r in rows if r[2] == "missing_time")
    log.info("  Data quality: %d outlier(s), %d missing-time warning(s)", n_outliers, n_missing)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(target_date: date) -> None:
    log.info("=== Nightly ingest: %s ===", target_date)

    client = bigquery.Client()
    df = fetch_day(client, target_date)

    if df.empty:
        log.warning("No rows returned for %s – nothing to commit", target_date)
        return

    df = compute_delays(df)
    date_str = target_date.isoformat()

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    try:
        with conn:
            upsert_data_quality_log(conn, date_str, df)  # flag outliers before aggregation
            upsert_daily_summary(conn, date_str, df)
            upsert_line_daily(conn, date_str, df)
            upsert_stop_daily(conn, date_str, df)
            upsert_line_hourly_raw(conn, date_str, df)
            upsert_stop_hourly_raw(conn, date_str, df)
            upsert_journey_stop_weekly(conn, date_str, df)
            refresh_line_hourly_profile(conn)
            refresh_stop_hourly_profile(conn)
            refresh_leaderboards(conn)
        log.info("=== Done: %s committed ===", date_str)
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        target = date.fromisoformat(sys.argv[1])
    else:
        target = date.today() - timedelta(days=1)
    run(target)
