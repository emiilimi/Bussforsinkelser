#!/usr/bin/env python3
"""
Nightly BigQuery -> SQLite pipeline for Bussforsinkelser

Fetches one day of SIRI ET data for one or more operators, computes delay
statistics, and writes them to the local SQLite database.

Usage:
    python pipeline/ingest.py                          # yesterday, all operators
    python pipeline/ingest.py 2025-03-07               # specific date, all operators
    python pipeline/ingest.py --operator RUT           # yesterday, Ruter only
    python pipeline/ingest.py --operator SKY,RUT       # yesterday, two operators
    python pipeline/ingest.py 2025-03-07 --operator RUT

Railway cron: 0 2 * * *   (02:00 Oslo time)
"""

import json
import os
import sqlite3
import logging
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytz
from google.cloud import bigquery

try:
    from .day_type import compute_day_type
except ImportError:
    # Allow running as `python pipeline/ingest.py` (no package context).
    from day_type import compute_day_type  # type: ignore

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Vehicle modes included in all aggregations. Anything outside this set is
# dropped at the end of compute_delays(). 'coach' = flybuss / langdistansebuss,
# kept separate from 'bus' for the reiseplanlegger filter.
INCLUDED_MODES = {"bus", "coach", "tram", "metro", "rail", "water", "ferry"}

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

# Comma-separated operator codes; can be overridden via --operator CLI flag or BQ_OPERATOR env var.
# Default: all known operators.
_ALL_OPERATORS = "SKY,MOR,INN,OST,RUT,KOL,VYG,TRO,BRA,FIN,NOR"
OPERATORS: list[str] = [
    op.strip() for op in os.environ.get("BQ_OPERATOR", _ALL_OPERATORS).split(",") if op.strip()
]
OSLO_TZ = pytz.timezone("Europe/Oslo")

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# BigQuery fetch
# ---------------------------------------------------------------------------

def fetch_day(
    client: bigquery.Client,
    target_date: date,
    operators: list[str] | None = None,
) -> pd.DataFrame:
    """Return all SIRI ET rows for one operating date.

    Fetches all vehicle modes (bus, tram, water, ferry, etc.) for the given
    operator(s). vehicle_mode is stored as a column in the DB so stats can be
    filtered per mode at query time.

    serviceJourneyId and sequenceNr are fetched for journey_stop_daily:
    they identify the specific scheduled run ("the 06:15 Linje 6") and the
    stop's position along the route respectively.
    """
    if operators is None:
        operators = OPERATORS
    # Build SQL IN clause: ('SKY',) or ('SKY', 'RUT')
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
        operatingDate = '{target_date.isoformat()}'
        AND dataSource IN ({ops_sql})
    """
    log.info("Querying BigQuery for %s (operators: %s, all modes) …", target_date, operators)
    df = client.query(query).to_dataframe(create_bqstorage_client=False)
    log.info("  Received %s rows", f"{len(df):,}")
    return df


# ---------------------------------------------------------------------------
# Delay calculation
# ---------------------------------------------------------------------------

def compute_delays(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    # Parse all four timestamps
    aimed_dep = pd.to_datetime(df["aimedDepartureTime"], utc=True, errors="coerce")
    aimed_arr = pd.to_datetime(df["aimedArrivalTime"], utc=True, errors="coerce")
    actual_dep = pd.to_datetime(df["departureTime"], utc=True, errors="coerce")
    actual_arr = pd.to_datetime(df["arrivalTime"], utc=True, errors="coerce")

    # Combined delay: departure preferred, fall back to arrival for last stop
    df["aimed"] = aimed_dep.fillna(aimed_arr)
    df["actual"] = actual_dep.fillna(actual_arr)
    df["delay_min"] = (df["actual"] - df["aimed"]).dt.total_seconds() / 60

    # Separate arrival and departure delays
    df["delay_arrival_min"] = (actual_arr - aimed_arr).dt.total_seconds() / 60
    df["delay_departure_min"] = (actual_dep - aimed_dep).dt.total_seconds() / 60

    # Dwell time: how long the bus stands at the stop (actual departure - actual arrival)
    df["dwell_time_sec"] = (actual_dep - actual_arr).dt.total_seconds()

    # Aimed times in local timezone for storage
    df["aimed_arr_ts"] = aimed_arr
    df["aimed_dep_ts"] = aimed_dep
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
    # Drop modes outside the whitelist (taxi, air, etc.)
    before_mode = len(df)
    df = df[df["vehicleMode"].isin(INCLUDED_MODES)]
    dropped_mode = before_mode - len(df)
    if dropped_mode:
        log.info("  Dropped %d rows with vehicleMode outside %s", dropped_mode, sorted(INCLUDED_MODES))
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
    """One row per (date, operator, vehicle_mode) — dashboard can switch / aggregate modes."""
    if df.empty:
        log.warning("No rows for %s – skipping daily_summary", date_str)
        return
    rows = []
    group_cols = ["dataSource", "vehicleMode"] if "dataSource" in df.columns else ["vehicleMode"]
    for keys, mode_df in df.groupby(group_cols):
        if isinstance(keys, tuple):
            operator_val, vehicle_mode = keys
        else:
            # Fallback: single column groupby (no dataSource)
            operator_val, vehicle_mode = OPERATORS[0], keys
        act = active_rows(mode_df)
        if act.empty:
            continue
        rows.append((
            date_str,
            str(operator_val),
            str(vehicle_mode),
            round(act["delay_min"].mean(), 2),
            round((act["delay_min"] <= 2).mean() * 100, 1),
            round((act["delay_min"] > 10).mean() * 100, 1),
            len(act),
            int(mode_df["is_cancelled"].sum()),
        ))
    if not rows:
        return
    conn.executemany(
        """
        INSERT OR REPLACE INTO daily_summary
            (date, operator, vehicle_mode, avg_delay_min, pct_on_time, pct_delayed_10plus,
             total_journeys, total_cancellations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def upsert_line_daily(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame) -> None:
    if df.empty:
        return
    rows = []
    for (line_ref, direction_ref, vehicle_mode), full_grp in df.groupby(
        ["lineRef", "directionRef", "vehicleMode"]
    ):
        # Scheduled (non-cancelled) rows — denominator for coverage
        scheduled = full_grp[~full_grp["is_cancelled"]]
        # Active rows: non-cancelled AND have a valid delay (i.e. had real-time data)
        act = scheduled[scheduled["delay_min"].notna()]
        if act.empty:
            continue
        delays = act["delay_min"]
        n_scheduled = len(scheduled)
        pct_coverage = round(len(act) / n_scheduled * 100, 1) if n_scheduled > 0 else None
        stddev = round(float(delays.std()), 2) if len(delays) >= 2 else None
        # Cancellations: distinct serviceJourneyIds with journeyCancellation=true.
        # A cancelled journey has all its stop-visits flagged, so counting unique SJIDs
        # is the right granularity (one cancelled trip = one cancellation).
        cancelled_grp = full_grp[full_grp["is_cancelled"]]
        if "serviceJourneyId" in cancelled_grp.columns and not cancelled_grp.empty:
            num_cancellations = int(cancelled_grp["serviceJourneyId"].nunique())
        else:
            num_cancellations = 0
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
            stddev,
            round((delays <= 2).mean() * 100, 1),
            round((delays > 2).mean() * 100, 1),
            round((delays > 10).mean() * 100, 1),
            len(act),
            pct_coverage,
            num_cancellations,
        ))
    conn.executemany(
        """
        INSERT OR REPLACE INTO line_daily
            (date, line_ref, direction_ref, vehicle_mode, line_name, avg_delay_min,
             max_delay_min, min_delay_min, median_delay_min, stddev_delay_min,
             pct_on_time, pct_delayed_2plus, pct_delayed_10plus,
             num_departures, pct_realtime_coverage, num_cancellations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    log.info("  Upserted %d line_daily rows", len(rows))


def upsert_stop_daily(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame) -> None:
    act = active_rows(df)
    if act.empty:
        return
    rows = []
    group_cols = ["stopPointRef", "vehicleMode", "directionRef", "dataSource"] \
        if "dataSource" in act.columns \
        else ["stopPointRef", "vehicleMode", "directionRef"]
    for keys, grp in act.groupby(group_cols):
        if len(group_cols) == 4:
            stop_ref, vehicle_mode, direction_ref, operator_val = keys
        else:
            stop_ref, vehicle_mode, direction_ref = keys
            operator_val = OPERATORS[0]
        # Use the most common non-null stop name in the group.
        # Store NULL (not the ref) when SIRI ET has no name — lets the DB-side
        # COALESCE with stop_coords provide the proper NSR name instead.
        names = grp["stopPointName"].dropna()
        modes = names.mode()
        stop_name = modes.iloc[0] if not modes.empty else (names.iloc[0] if not names.empty else None)
        delays = grp["delay_min"]
        stddev = round(float(delays.std()), 2) if len(delays) >= 2 else None
        rows.append((
            date_str,
            str(stop_ref),
            str(direction_ref),
            str(vehicle_mode),
            str(operator_val),
            stop_name,  # None stays as SQL NULL (str(None) would give the string "None")
            round(float(delays.mean()), 2),
            round(float(delays.max()), 2),
            round(float(delays.min()), 2),
            stddev,
            round((delays > 2).mean() * 100, 1),
            len(grp),
        ))
    conn.executemany(
        """
        INSERT OR REPLACE INTO stop_daily
            (date, stop_ref, direction_ref, vehicle_mode, operator, stop_name, avg_delay_min,
             max_delay_min, min_delay_min, stddev_delay_min, pct_delayed_2plus, num_departures)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    log.info("  Upserted %d stop_daily rows", len(rows))


def upsert_line_hourly_raw(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame, day_type: str) -> None:
    """Store per-hour averages for this day (used to rebuild the 30-day profile)."""
    act = active_rows(df)
    act = act[act["hour"].notna()]
    if act.empty:
        return
    rows = []
    for (line_ref, direction_ref, vehicle_mode, hour), grp in act.groupby(
        ["lineRef", "directionRef", "vehicleMode", "hour"]
    ):
        rows.append((
            date_str,
            str(line_ref),
            str(direction_ref),
            str(vehicle_mode),
            day_type,
            line_display_name(str(line_ref)),
            int(hour),
            round(grp["delay_min"].mean(), 2),
            len(grp),
        ))
    conn.executemany(
        """
        INSERT OR REPLACE INTO line_hourly_raw
            (date, line_ref, direction_ref, vehicle_mode, day_type, line_name, hour, avg_delay_min, num_samples)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            (line_ref, direction_ref, vehicle_mode, day_type, line_name, hour,
             avg_delay_min, max_avg_delay_min, min_avg_delay_min, num_samples)
        SELECT
            line_ref,
            direction_ref,
            vehicle_mode,
            day_type,
            MAX(line_name) AS line_name,
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
        GROUP BY line_ref, direction_ref, vehicle_mode, day_type, hour
        """
    )


def upsert_stop_hourly_raw(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame, day_type: str) -> None:
    """Store per-hour averages per stop for this day (used to rebuild 30-day profile)."""
    act = active_rows(df)
    act = act[act["hour"].notna()]
    if act.empty:
        return
    rows = []
    group_cols_shr = ["stopPointRef", "hour", "directionRef", "vehicleMode"]
    if "dataSource" in act.columns:
        group_cols_shr = group_cols_shr + ["dataSource"]
    for keys, grp in act.groupby(group_cols_shr):
        if len(group_cols_shr) == 5:
            stop_ref, hour, direction_ref, vehicle_mode, operator_val = keys
        else:
            stop_ref, hour, direction_ref, vehicle_mode = keys
            operator_val = OPERATORS[0]
        rows.append((
            date_str,
            str(stop_ref),
            int(hour),
            str(direction_ref),
            str(operator_val),
            str(vehicle_mode),
            day_type,
            round(grp["delay_min"].mean(), 2),
            len(grp),
        ))
    conn.executemany(
        """
        INSERT OR REPLACE INTO stop_hourly_raw
            (date, stop_ref, hour, direction_ref, operator, vehicle_mode, day_type, avg_delay_min, num_samples)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            (stop_ref, hour, direction_ref, operator, vehicle_mode, day_type,
             avg_delay_min, max_avg_delay_min, min_avg_delay_min, num_samples)
        SELECT
            stop_ref,
            hour,
            direction_ref,
            operator,
            vehicle_mode,
            day_type,
            ROUND(
                SUM(avg_delay_min * num_samples) * 1.0 / SUM(num_samples),
                2
            ) AS avg_delay_min,
            ROUND(MAX(avg_delay_min), 2) AS max_avg_delay_min,
            ROUND(MIN(avg_delay_min), 2) AS min_avg_delay_min,
            SUM(num_samples) AS num_samples
        FROM stop_hourly_raw
        WHERE date >= date('now', '-30 days')
        GROUP BY stop_ref, hour, direction_ref, operator, vehicle_mode, day_type
        """
    )


def upsert_journey_stop_daily(conn: sqlite3.Connection, date_str: str, df: pd.DataFrame, day_type: str) -> None:
    """Insert raw per-journey per-stop delay rows for one calendar day (all included modes).

    One row per (date, service_journey_id, stop_ref) — un-aggregated truth.
    On re-ingest of the same date, values are overwritten (idempotent).

    Rolling 90-day window: rows older than 90 days are pruned automatically.
    Zero extra BQ cost: all values already computed by compute_delays().
    """
    act = active_rows(df)
    if act.empty:
        return

    if "serviceJourneyId" not in act.columns or "sequenceNr" not in act.columns:
        log.warning("  journey_stop_daily skipped: serviceJourneyId/sequenceNr not in DataFrame")
        return

    act = act[act["serviceJourneyId"].notna() & act["sequenceNr"].notna()].copy()
    if act.empty:
        return

    rows = []
    for (journey_id, line_ref, direction_ref, stop_ref, vehicle_mode), grp in act.groupby(
        ["serviceJourneyId", "lineRef", "directionRef", "stopPointRef", "vehicleMode"]
    ):
        stop_seq = int(grp["sequenceNr"].iloc[0])

        aimed_arr_ts = grp["aimed_arr_ts"].dropna()
        aimed_arrival = (
            aimed_arr_ts.iloc[0].astimezone(OSLO_TZ).strftime("%H:%M")
            if not aimed_arr_ts.empty else None
        )

        aimed_dep_ts = grp["aimed_dep_ts"].dropna()
        aimed_departure = (
            aimed_dep_ts.iloc[0].astimezone(OSLO_TZ).strftime("%H:%M")
            if not aimed_dep_ts.empty else None
        )

        # Mean across multiple observations for the same journey+stop in one day
        arr_delays = grp["delay_arrival_min"].dropna()
        delay_arrival = round(float(arr_delays.mean()), 2) if not arr_delays.empty else None

        dep_delays = grp["delay_departure_min"].dropna()
        delay_departure = round(float(dep_delays.mean()), 2) if not dep_delays.empty else None

        dwell = grp["dwell_time_sec"].dropna()
        dwell = dwell[(dwell >= 0) & (dwell <= 600)]
        dwell_sec = round(float(dwell.mean()), 1) if not dwell.empty else None

        rows.append((
            date_str,
            str(journey_id),
            str(line_ref),
            str(direction_ref),
            str(stop_ref),
            stop_seq,
            aimed_arrival,
            aimed_departure,
            str(vehicle_mode),
            day_type,
            delay_arrival,
            delay_departure,
            dwell_sec,
        ))

    conn.executemany(
        """
        INSERT INTO journey_stop_daily
            (date, service_journey_id, line_ref, direction_ref, stop_ref,
             stop_sequence, aimed_arrival, aimed_departure,
             vehicle_mode, day_type,
             delay_arrival_min, delay_departure_min, dwell_time_sec)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (date, service_journey_id, stop_ref) DO UPDATE SET
            aimed_arrival       = COALESCE(aimed_arrival, excluded.aimed_arrival),
            aimed_departure     = COALESCE(aimed_departure, excluded.aimed_departure),
            vehicle_mode        = excluded.vehicle_mode,
            day_type            = excluded.day_type,
            delay_arrival_min   = excluded.delay_arrival_min,
            delay_departure_min = excluded.delay_departure_min,
            dwell_time_sec      = excluded.dwell_time_sec
        """,
        rows,
    )

    conn.execute("DELETE FROM journey_stop_daily WHERE date < date('now', '-90 days')")
    log.info("  Upserted %d journey_stop_daily rows", len(rows))


def refresh_leaderboards(conn: sqlite3.Connection) -> None:
    """Rebuild all-time leaderboard tables."""
    conn.execute("DELETE FROM leaderboard_lines")
    conn.execute(
        """
        INSERT INTO leaderboard_lines
            (line_ref, line_name, vehicle_mode, avg_delay_min, stddev_delay_min,
             pct_on_time, pct_delayed_10plus, total_departures, total_cancellations)
        SELECT
            line_ref,
            MAX(line_name) AS line_name,
            -- vehicle_mode is functionally determined by line_ref (1:1).
            MAX(vehicle_mode) AS vehicle_mode,
            ROUND(
                SUM(avg_delay_min * num_departures) * 1.0 / NULLIF(SUM(num_departures), 0),
                2
            ),
            ROUND(
                SUM(CASE WHEN stddev_delay_min IS NOT NULL THEN stddev_delay_min * num_departures ELSE 0 END) * 1.0
                / NULLIF(SUM(CASE WHEN stddev_delay_min IS NOT NULL THEN num_departures ELSE 0 END), 0),
                2
            ),
            ROUND(
                SUM(pct_on_time * num_departures) * 1.0 / NULLIF(SUM(num_departures), 0),
                1
            ),
            ROUND(
                SUM(pct_delayed_10plus * num_departures) * 1.0 / NULLIF(SUM(num_departures), 0),
                1
            ),
            SUM(num_departures),
            COALESCE(SUM(num_cancellations), 0)
        FROM line_daily
        GROUP BY line_ref
        """
    )

    # leaderboard_stops removed — worst/best stops are now computed live
    # in getLeaderboardStops() (server/storage.ts) with a 7-day rolling window.

    conn.execute("DELETE FROM worst_days")
    # day_type is computed in Python (Norwegian holidays don't fit pure SQL).
    # Pull the source rows then enrich, then bulk insert top 100 per (operator, mode).
    cur = conn.execute(
        """
        SELECT date, operator, vehicle_mode, avg_delay_min,
               total_journeys, total_cancellations, pct_on_time
        FROM daily_summary
        ORDER BY avg_delay_min DESC
        LIMIT 100
        """
    )
    worst_rows = []
    for row in cur.fetchall():
        d_str, operator, vehicle_mode, avg, total, cancels, pct = row
        try:
            dt = compute_day_type(date.fromisoformat(d_str))
        except Exception:
            dt = None
        worst_rows.append((d_str, operator, vehicle_mode, dt, avg, total, cancels, pct))
    conn.executemany(
        """
        INSERT INTO worst_days
            (date, operator, vehicle_mode, day_type, avg_delay_min,
             total_journeys, total_cancellations, pct_on_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        worst_rows,
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

    # Determine the set of operators present in this batch
    ops_in_df = (
        df["dataSource"].dropna().unique().tolist()
        if "dataSource" in df.columns
        else OPERATORS[:1]
    )

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
            # Use per-row dataSource if available, fall back to first OPERATORS entry
            row_operator = str(row.get("dataSource") or OPERATORS[0])

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
                date_str, row_operator, "outlier_delay",
                line_ref, journey_id, stop_ref, aimed_time,
                round(delay, 1), 1, None, message,
            ))

    # --- 2. Missing timing data (per operator) ---
    if "aimed" in df.columns:
        for op in ops_in_df:
            op_df = df[df["dataSource"] == op] if "dataSource" in df.columns else df
            n_missing = int(op_df["aimed"].isna().sum())
            n_total = len(op_df)
            if n_missing > 0 and n_total > 0:
                pct = round(n_missing / n_total * 100, 1)
                message = (
                    f"{n_missing} av {n_total} registreringer ({pct}%) manglet "
                    f"tidsstempeldata for {date_str} og ble utelatt fra statistikken."
                )
                rows.append((
                    date_str, op, "missing_time",
                    None, None, None, None,
                    None, n_missing, n_total, message,
                ))

    if not rows:
        return

    # Clear old entries for this date + all operators in this batch before re-inserting
    ops_placeholders = ",".join("?" * len(ops_in_df))
    conn.execute(
        f"DELETE FROM data_quality_log WHERE date = ? AND operator IN ({ops_placeholders})",
        (date_str, *ops_in_df),
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
# Real-time coverage diagnostics
# ---------------------------------------------------------------------------

DIAGNOSTICS_DIR = Path(__file__).parent.parent / "data" / "diagnostics"

def log_realtime_coverage(date_str: str, df: pd.DataFrame) -> None:
    """Detect and log suspected 'no real-time' departures (bus only).

    Two categories:
    A) departureTime == aimedDepartureTime (exact match, both non-NULL)
       → Suspected fake on-time: operator echoed scheduled time as actual,
         likely meaning no GPS update was received. delay_min = 0.0 exactly.
    B) departureTime IS NULL AND arrivalTime IS NULL (not cancelled)
       → Definitively no real-time: already excluded from stats by active_rows().

    Results written to: data/diagnostics/YYYY-MM-DD-realtime.json
    Check with: cat data/diagnostics/YYYY-MM-DD-realtime.json
    """
    # Diagnostics covers all included modes — variable kept named `bus` for
    # historical reasons (output JSON keys reference "bus" still).
    bus = df.copy()
    if bus.empty:
        return

    aimed_dep  = pd.to_datetime(bus["aimedDepartureTime"], utc=True, errors="coerce")
    actual_dep = pd.to_datetime(bus["departureTime"],      utc=True, errors="coerce")
    actual_arr = pd.to_datetime(bus["arrivalTime"],        utc=True, errors="coerce")

    # Category A: suspected fake on-time
    mask_fake = actual_dep.notna() & aimed_dep.notna() & (actual_dep == aimed_dep)
    # Category B: no real-time at all (both times NULL, not cancelled)
    mask_no_rt = actual_dep.isna() & actual_arr.isna() & ~bus["is_cancelled"]

    n_total  = len(bus)
    n_fake   = int(mask_fake.sum())
    n_no_rt  = int(mask_no_rt.sum())

    pct_fake  = round(n_fake  / n_total * 100, 1) if n_total else 0.0
    pct_no_rt = round(n_no_rt / n_total * 100, 1) if n_total else 0.0

    log.info(
        "  Real-time coverage: %.1f%% suspected fake on-time (delay=0 exact), "
        "%.1f%% no real-time at all (%d total bus rows)",
        pct_fake, pct_no_rt, n_total,
    )

    # --- Per-line breakdown ---
    lines_fake = []
    fake_df = bus[mask_fake].copy()
    if not fake_df.empty:
        for line_ref, grp in fake_df.groupby("lineRef"):
            n_line_total = len(bus[bus["lineRef"] == line_ref])
            n_line_fake  = len(grp)
            pct = round(n_line_fake / n_line_total * 100, 1) if n_line_total else 0.0
            if pct < 1.0:
                continue  # skip noise — only report lines with ≥1% suspected fake
            # Which journeys? (serviceJourneyId + aimed departure time at first stop)
            journeys = []
            if "serviceJourneyId" in grp.columns:
                for jid, jgrp in grp.groupby("serviceJourneyId"):
                    aimed_times = jgrp["aimedDepartureTime"].dropna()
                    first_aimed = (
                        pd.to_datetime(aimed_times, utc=True, errors="coerce")
                        .dt.tz_convert("Europe/Oslo")
                        .dt.strftime("%H:%M")
                        .iloc[0]
                        if not aimed_times.empty else None
                    )
                    journeys.append({
                        "serviceJourneyId": str(jid),
                        "firstAimedTime": first_aimed,
                        "affectedStops": len(jgrp),
                    })
            lines_fake.append({
                "lineRef": str(line_ref),
                "totalBusRows": n_line_total,
                "suspectedFakeOnTime": n_line_fake,
                "pct": pct,
                "journeys": sorted(journeys, key=lambda x: x["firstAimedTime"] or ""),
            })

        lines_fake.sort(key=lambda x: -x["pct"])
        if lines_fake:
            log.warning(
                "  Fake on-time suspects (≥1%%): %s",
                ", ".join(f"{l['lineRef']} ({l['pct']}%%)" for l in lines_fake[:10]),
            )

    # --- Lines with high no-realtime rate ---
    lines_no_rt = []
    no_rt_df = bus[mask_no_rt].copy()
    if not no_rt_df.empty:
        for line_ref, grp in no_rt_df.groupby("lineRef"):
            n_line_total = len(bus[bus["lineRef"] == line_ref])
            n_line_no_rt = len(grp)
            pct = round(n_line_no_rt / n_line_total * 100, 1) if n_line_total else 0.0
            if pct < 5.0:
                continue  # only report lines with ≥5% missing real-time
            lines_no_rt.append({
                "lineRef": str(line_ref),
                "totalBusRows": n_line_total,
                "noRealtime": n_line_no_rt,
                "pct": pct,
            })
        lines_no_rt.sort(key=lambda x: -x["pct"])

    # --- Write JSON ---
    DIAGNOSTICS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DIAGNOSTICS_DIR / f"{date_str}-realtime.json"
    report = {
        "date": date_str,
        "totalBusRows": n_total,
        "suspectedFakeOnTime": {
            "count": n_fake,
            "pct": pct_fake,
            "description": (
                "departureTime == aimedDepartureTime exactly — "
                "likely no GPS update received, scheduled time echoed as actual"
            ),
            "byLine": lines_fake,
        },
        "noRealtime": {
            "count": n_no_rt,
            "pct": pct_no_rt,
            "description": (
                "Both departureTime and arrivalTime NULL (not cancelled) — "
                "excluded from delay stats automatically"
            ),
            "byLine": lines_no_rt,
        },
    }
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    log.info("  Real-time diagnostics → %s", out_path)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(target_date: date, operators: list[str] | None = None) -> None:
    if operators is None:
        operators = OPERATORS
    log.info("=== Nightly ingest: %s (operators: %s) ===", target_date, operators)

    client = bigquery.Client()
    df = fetch_day(client, target_date, operators)

    if df.empty:
        log.warning("No rows returned for %s – nothing to commit", target_date)
        return

    df = compute_delays(df)
    date_str = target_date.isoformat()
    day_type = compute_day_type(target_date)
    log.info("  day_type=%s for %s", day_type, date_str)

    log_realtime_coverage(date_str, df)  # writes data/diagnostics/YYYY-MM-DD-realtime.json

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    try:
        with conn:
            upsert_data_quality_log(conn, date_str, df)  # flag outliers before aggregation
            upsert_daily_summary(conn, date_str, df)
            upsert_line_daily(conn, date_str, df)
            upsert_stop_daily(conn, date_str, df)
            upsert_line_hourly_raw(conn, date_str, df, day_type)
            upsert_stop_hourly_raw(conn, date_str, df, day_type)
            upsert_journey_stop_daily(conn, date_str, df, day_type)
            refresh_line_hourly_profile(conn)
            refresh_stop_hourly_profile(conn)
            refresh_leaderboards(conn)
        log.info("=== Done: %s committed ===", date_str)
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Nightly BigQuery → SQLite ingest for Bussforsinkelser",
    )
    parser.add_argument(
        "date",
        nargs="?",
        help="Operating date (YYYY-MM-DD). Defaults to yesterday.",
    )
    parser.add_argument(
        "--operator",
        "--operators",
        dest="operator",
        default=None,
        help=(
            "Comma-separated operator code(s) to ingest, e.g. SKY or SKY,RUT. "
            f"Overrides BQ_OPERATOR env var. Defaults to all operators ({_ALL_OPERATORS})."
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
