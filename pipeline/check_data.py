"""
check_data.py — Manual inspection helpers for bussforsinkelser.no
Run individual sections by commenting/uncommenting them below.

Usage:
    python pipeline/check_data.py
"""

import os
import sqlite3
from pathlib import Path

# ---------------------------------------------------------------------------
# BigQuery client (only needed for BQ queries below)
# ---------------------------------------------------------------------------
from google.cloud import bigquery

BQ_TABLE = os.environ.get(
    "BQ_TABLE",
    "ent-data-sharing-ext-prd.realtime_siri_et.realtime_siri_et_last_recorded",
)
OPERATOR = os.environ.get("BQ_OPERATOR", "SKY")
client = bigquery.Client()

# ---------------------------------------------------------------------------
# SQLite connection
# ---------------------------------------------------------------------------
DB_PATH = Path(__file__).parent.parent / "data" / "bussforsinkelser.db"
conn = sqlite3.connect(DB_PATH)

# ===========================================================================
# SECTION 1 — Investigate rows with NULL vehicleMode in BigQuery
# ===========================================================================
# What lines/routes are missing vehicleMode? Are they buses, metro, train?
# Run this to understand what we'd be setting to "unknown" in the pipeline.
# ===========================================================================

print("=== NULL vehicleMode — COUNTS BY lineRef (most recent 7 days) ===")
rows = client.query(f"""
    SELECT
        lineRef,
        COUNT(*)               AS total_rows,
        COUNT(DISTINCT operatingDate) AS dates,
        MIN(operatingDate)     AS earliest,
        MAX(operatingDate)     AS latest
    FROM `{BQ_TABLE}`
    WHERE dataSource = '{OPERATOR}'
      AND vehicleMode IS NULL
      AND operatingDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
    GROUP BY lineRef
    ORDER BY total_rows DESC
    LIMIT 30
""").result()
for r in rows:
    print(
        f"  {str(r.lineRef):35s}"
        f"  rows={r.total_rows:5d}  dates={r.dates}  "
        f"({r.earliest} → {r.latest})"
    )

print()
print("=== NULL vehicleMode — SAMPLE ROWS (stopPointRef, stopPointName) ===")
rows = client.query(f"""
    SELECT
        operatingDate,
        lineRef,
        stopPointRef,
        stopPointName,
        originName,
        destinationName,
        serviceJourneyId
    FROM `{BQ_TABLE}`
    WHERE dataSource = '{OPERATOR}'
      AND vehicleMode IS NULL
      AND operatingDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
    LIMIT 30
""").result()
for r in rows:
    print(
        f"  {str(r.operatingDate)}  line={str(r.lineRef):30s}  "
        f"stop={str(r.stopPointRef):30s}  "
        f"name={str(r.stopPointName):25s}  "
        f"origin={str(r.originName)}  dest={str(r.destinationName)}"
    )

print()
print("=== NULL vehicleMode — TOTAL VS KNOWN MODES (last 7 days) ===")
rows = client.query(f"""
    SELECT
        vehicleMode,
        COUNT(*) AS total_rows
    FROM `{BQ_TABLE}`
    WHERE dataSource = '{OPERATOR}'
      AND operatingDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
    GROUP BY vehicleMode
    ORDER BY total_rows DESC
""").result()
for r in rows:
    print(f"  vehicleMode={str(r.vehicleMode):15s}  rows={r.total_rows:7,d}")


# ===========================================================================
# SECTION 2 — Check "unknown" vehicle mode in local SQLite DB
# ===========================================================================
# After re-ingesting with the new fillna("unknown") logic, run this to see
# what ended up in the DB.
# ===========================================================================

# print()
# print("=== SQLite: vehicle_mode distribution ===")
# rows = conn.execute("""
#     SELECT vehicle_mode, COUNT(*) AS days, SUM(num_departures) AS departures
#     FROM line_daily
#     GROUP BY vehicle_mode
#     ORDER BY departures DESC
# """).fetchall()
# for r in rows:
#     print(f"  mode={r[0]:15s}  day-rows={r[1]:4d}  total_departures={r[2]:6,d}")
#
# print()
# print("=== SQLite: 'unknown' lines ===")
# rows = conn.execute("""
#     SELECT line_ref, MAX(line_name) AS name,
#            SUM(num_departures) AS departures, COUNT(DISTINCT date) AS dates
#     FROM line_daily
#     WHERE vehicle_mode = 'unknown'
#     GROUP BY line_ref
#     ORDER BY departures DESC
# """).fetchall()
# for r in rows:
#     print(f"  {r[0]:35s}  name={str(r[1]):25s}  deps={r[2]:5d}  dates={r[3]}")


# ===========================================================================
# SECTION 3 — Ghost line 1200 (legacy Rutebanken stops, never migrated)
# ===========================================================================

# print("=== LINE 1200 — RECENT STOPS (2026-03-04, ordered by sequence) ===")
# rows = client.query(f"""
#     SELECT DISTINCT sequenceNr, stopPointRef, stopPointName,
#                     originName, destinationName, serviceJourneyId, directionRef
#     FROM `{BQ_TABLE}`
#     WHERE dataSource = '{OPERATOR}'
#       AND lineRef LIKE '%:1200'
#       AND operatingDate = '2026-03-04'
#     ORDER BY serviceJourneyId, sequenceNr
#     LIMIT 30
# """).result()
# for r in rows:
#     print(
#         f"  seq={r.sequenceNr:3}  stop={str(r.stopPointRef):30s}  "
#         f"name={r.stopPointName}  dest={r.destinationName}  dir={r.directionRef}"
#     )


conn.close()
