"""
Creates the SQLite database schema for bussforsinkelser.no.
Run once before first ingest: python pipeline/db_setup.py

NOTE: If the database already exists, drop it first:
    rm data/bussforsinkelser.db && python pipeline/db_setup.py
"""
import os
import sqlite3
from pathlib import Path

DB_PATH = os.environ.get(
    "DATABASE_PATH",
    str(Path(__file__).parent.parent / "data" / "bussforsinkelser.db"),
)

SCHEMA = """
-- One row per operator per calendar date (bus journeys only, for the dashboard).
-- operator: e.g. 'SKY', 'RUT', 'ATB' — allows multi-region support.
CREATE TABLE IF NOT EXISTS daily_summary (
    date                TEXT    NOT NULL,
    operator            TEXT    NOT NULL DEFAULT 'SKY',
    avg_delay_min       REAL,
    pct_on_time         REAL,   -- % departures within 2 min of schedule
    pct_delayed_10plus  REAL,
    total_journeys      INTEGER,
    total_cancellations INTEGER,
    PRIMARY KEY (date, operator)
);

-- One row per line per direction per vehicle mode per calendar date.
-- direction_ref: '0' = outbound, '1' = inbound (Entur convention).
-- vehicle_mode: 'bus', 'tram', 'water', etc. — stored for all modes,
--   filtered at query time (default: bus only).
-- operator is NOT a separate column here: it is embedded in line_ref
--   (e.g. 'SKY:Line:6', 'RUT:Line:31B') and can be filtered with LIKE 'SKY:%'.
CREATE TABLE IF NOT EXISTS line_daily (
    date               TEXT    NOT NULL,
    line_ref           TEXT    NOT NULL,
    direction_ref      TEXT    NOT NULL DEFAULT '0',
    vehicle_mode       TEXT    NOT NULL DEFAULT 'bus',
    line_name          TEXT,
    avg_delay_min      REAL,
    max_delay_min      REAL,
    min_delay_min      REAL,
    median_delay_min   REAL,
    pct_on_time        REAL,
    pct_delayed_2plus  REAL,
    pct_delayed_10plus REAL,
    num_departures     INTEGER,
    PRIMARY KEY (date, line_ref, direction_ref, vehicle_mode)
);

-- One row per stop per vehicle mode per operator per calendar date.
-- operator IS a separate column here because stop_ref (NSR:Quay:xxxxx)
--   is operator-agnostic: the same physical stop can be served by both
--   SKY and RUT buses, and their stats must be stored independently.
CREATE TABLE IF NOT EXISTS stop_daily (
    date              TEXT    NOT NULL,
    stop_ref          TEXT    NOT NULL,
    vehicle_mode      TEXT    NOT NULL DEFAULT 'bus',
    operator          TEXT    NOT NULL DEFAULT 'SKY',
    stop_name         TEXT,
    avg_delay_min     REAL,
    max_delay_min     REAL,
    min_delay_min     REAL,
    pct_delayed_2plus REAL,
    num_departures    INTEGER,
    PRIMARY KEY (date, stop_ref, vehicle_mode, operator)
);

-- Raw hourly buckets per line per day (aggregated across directions).
-- operator embedded in line_ref — no separate column needed.
-- Used to rebuild the 30-day rolling hourly profile each night.
CREATE TABLE IF NOT EXISTS line_hourly_raw (
    date          TEXT    NOT NULL,
    line_ref      TEXT    NOT NULL,
    line_name     TEXT,
    hour          INTEGER NOT NULL,
    avg_delay_min REAL,
    num_samples   INTEGER,
    PRIMARY KEY (date, line_ref, hour)
);

-- 30-day rolling average delay per line per hour-of-day (rebuilt nightly).
-- operator embedded in line_ref.
CREATE TABLE IF NOT EXISTS line_hourly_profile (
    line_ref      TEXT    NOT NULL,
    line_name     TEXT,
    hour          INTEGER NOT NULL,
    avg_delay_min REAL,
    num_samples   INTEGER,
    PRIMARY KEY (line_ref, hour)
);

-- Raw hourly buckets per stop per day (bus only).
-- operator IS a separate column (NSR stop refs are operator-agnostic).
CREATE TABLE IF NOT EXISTS stop_hourly_raw (
    date          TEXT    NOT NULL,
    stop_ref      TEXT    NOT NULL,
    hour          INTEGER NOT NULL,
    operator      TEXT    NOT NULL DEFAULT 'SKY',
    avg_delay_min REAL,
    num_samples   INTEGER,
    PRIMARY KEY (date, stop_ref, hour, operator)
);

-- 30-day rolling average delay per stop per hour-of-day (rebuilt nightly, bus only).
CREATE TABLE IF NOT EXISTS stop_hourly_profile (
    stop_ref      TEXT    NOT NULL,
    hour          INTEGER NOT NULL,
    operator      TEXT    NOT NULL DEFAULT 'SKY',
    avg_delay_min REAL,
    num_samples   INTEGER,
    PRIMARY KEY (stop_ref, hour, operator)
);

-- All-time line leaderboard (rebuilt nightly, bus only, aggregated across directions).
-- operator embedded in line_ref.
CREATE TABLE IF NOT EXISTS leaderboard_lines (
    line_ref           TEXT PRIMARY KEY,
    line_name          TEXT,
    avg_delay_min      REAL,
    pct_on_time        REAL,
    pct_delayed_10plus REAL,
    total_departures   INTEGER
);

-- Historical worst days per operator (top 100 by avg delay, rebuilt nightly, bus only).
CREATE TABLE IF NOT EXISTS worst_days (
    date                TEXT    NOT NULL,
    operator            TEXT    NOT NULL DEFAULT 'SKY',
    avg_delay_min       REAL,
    total_journeys      INTEGER,
    total_cancellations INTEGER,
    pct_on_time         REAL,
    PRIMARY KEY (date, operator)
);

-- Stop coordinates from NSR (populated once, refreshed rarely).
CREATE TABLE IF NOT EXISTS stop_coords (
    stop_ref  TEXT PRIMARY KEY,
    stop_name TEXT,
    lat       REAL,
    lng       REAL
);

-- Per-journey per-stop weekly aggregates (bus only, 13-week rolling window).
--
-- Core table for:
--   • Journey profile ("Thomas-analysen"): delay at each stop along a route
--     → see exactly where delay builds up
--   • Worst stop on a line: GROUP BY stop_ref WHERE line_ref = 'SKY:Line:6'
--   • Filter stop leaderboard by line
--   • Lines per stop: GROUP BY line_ref WHERE stop_ref = 'NSR:Quay:xxxxx'
--
-- service_journey_id: stable NeTEx ID for one specific scheduled run,
--   e.g. 'SKY:ServiceJourney:10-123456' (the "06:15 Linje 6 to Nesttun").
-- stop_sequence: stop order along the route (from BQ sequenceNr).
-- aimed_time: scheduled departure at this specific stop in HH:MM local time.
--
-- Upsert logic: weighted average merge so multiple days accumulate within a week.
-- Old weeks are pruned automatically (>91 days / 13 weeks).
CREATE TABLE IF NOT EXISTS journey_stop_weekly (
    week_start         TEXT    NOT NULL,  -- Monday ISO date, e.g. '2026-03-16'
    service_journey_id TEXT    NOT NULL,  -- NeTEx ServiceJourney ID
    line_ref           TEXT    NOT NULL,  -- for filtering by line
    direction_ref      TEXT    NOT NULL,
    stop_ref           TEXT    NOT NULL,  -- NSR:Quay:xxxxx
    stop_sequence      INTEGER NOT NULL,  -- order along route
    aimed_time         TEXT,             -- 'HH:MM' local time at this stop
    avg_delay_min      REAL,
    max_delay_min      REAL,
    min_delay_min      REAL,
    num_samples        INTEGER,
    PRIMARY KEY (week_start, service_journey_id, stop_ref)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_line_daily_date         ON line_daily (date);
CREATE INDEX IF NOT EXISTS idx_line_daily_line_ref     ON line_daily (line_ref);
CREATE INDEX IF NOT EXISTS idx_line_daily_vehicle_mode ON line_daily (vehicle_mode);
CREATE INDEX IF NOT EXISTS idx_stop_daily_date         ON stop_daily (date);
CREATE INDEX IF NOT EXISTS idx_stop_daily_stop_ref     ON stop_daily (stop_ref);
CREATE INDEX IF NOT EXISTS idx_stop_daily_vehicle_mode ON stop_daily (vehicle_mode);
CREATE INDEX IF NOT EXISTS idx_stop_daily_operator     ON stop_daily (operator);
CREATE INDEX IF NOT EXISTS idx_line_hourly_raw_date    ON line_hourly_raw (date);
CREATE INDEX IF NOT EXISTS idx_stop_hourly_raw_date    ON stop_hourly_raw (date);
CREATE INDEX IF NOT EXISTS idx_stop_hourly_raw_stop    ON stop_hourly_raw (stop_ref);
CREATE INDEX IF NOT EXISTS idx_jsw_line_dir            ON journey_stop_weekly (line_ref, direction_ref);
CREATE INDEX IF NOT EXISTS idx_jsw_stop                ON journey_stop_weekly (stop_ref);
CREATE INDEX IF NOT EXISTS idx_jsw_week                ON journey_stop_weekly (week_start);
CREATE INDEX IF NOT EXISTS idx_jsw_journey             ON journey_stop_weekly (service_journey_id);

-- Data quality log: outlier delays and missing timing data flagged during ingest.
-- One row per outlier journey-stop, one row per day for missing_time summary.
-- Used by the frontend to show transparency notices.
CREATE TABLE IF NOT EXISTS data_quality_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    date                TEXT    NOT NULL,
    operator            TEXT    NOT NULL DEFAULT 'SKY',
    type                TEXT    NOT NULL,  -- 'outlier_delay' | 'missing_time'
    line_ref            TEXT,              -- NULL for global warnings
    service_journey_id  TEXT,              -- specific journey (outliers only)
    stop_ref            TEXT,              -- specific stop (outliers only)
    aimed_time          TEXT,              -- 'HH:MM' scheduled departure (outliers)
    delay_min           REAL,             -- actual delay in minutes (outliers)
    count               INTEGER DEFAULT 1, -- number of affected rows
    total               INTEGER,           -- total rows that day (for % calc)
    message             TEXT    NOT NULL   -- Norwegian human-readable message
);

CREATE INDEX IF NOT EXISTS idx_dql_date     ON data_quality_log (date, operator);
CREATE INDEX IF NOT EXISTS idx_dql_line_ref ON data_quality_log (line_ref);
CREATE INDEX IF NOT EXISTS idx_dql_stop_ref ON data_quality_log (stop_ref);
"""


def init_db(db_path: str = DB_PATH) -> None:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    # WAL mode: allows readers and writer to coexist without blocking each other,
    # and survives interrupted writes without corrupting the database.
    # Must be set before creating tables; persists in the DB file.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")  # safe with WAL, faster than FULL
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
    print(f"Database ready: {db_path}")


if __name__ == "__main__":
    init_db()
