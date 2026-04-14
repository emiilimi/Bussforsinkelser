#!/usr/bin/env python3
"""
Populate stop_coords from NSR (National Stop Registry).

First run: fetches from BigQuery and saves a local cache file (data/stop_coords.json).
Subsequent runs: loads from the cache — no BigQuery call needed.

Use --refresh to force a fresh BigQuery fetch (e.g. after NSR updates).

Usage:
    python pipeline/populate_stops.py            # use cache if available
    python pipeline/populate_stops.py --refresh  # force BigQuery fetch
"""

import json
import os
import sqlite3
import logging
import sys
from pathlib import Path

DB_PATH = os.environ.get(
    "DATABASE_PATH",
    str(Path(__file__).parent.parent / "data" / "bussforsinkelser.db"),
)

CACHE_PATH = str(Path(__file__).parent.parent / "data" / "stop_coords.json")

NSR_QUAYS_TABLE = (
    "ent-data-sharing-ext-prd.national_stop_registry.quays_last_version"
)
NSR_STOPS_TABLE = (
    "ent-data-sharing-ext-prd.national_stop_registry.stop_places_last_version"
)

logging.basicConfig(level="INFO", format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def fetch_from_bigquery() -> list[tuple]:
    from google.cloud import bigquery
    log.info("Fetching NSR stop coordinates from BigQuery …")
    client = bigquery.Client()
    # SIRI ET stopPointRef = NSR:Quay:xxxxx, so we key on quay IDs.
    # Quays have no name column, so we join to stop_places to get the
    # human-readable stop place name (the parent of the quay).
    query = f"""
    SELECT
        q.id                  AS stop_ref,
        sp.name               AS stop_name,
        q.location_latitude   AS lat,
        q.location_longitude  AS lng,
        q.stopPlaceRef        AS stop_place_ref,
        sp.name               AS stop_place_name
    FROM `{NSR_QUAYS_TABLE}` q
    LEFT JOIN `{NSR_STOPS_TABLE}` sp ON sp.id = q.stopPlaceRef
    WHERE q.location_latitude  IS NOT NULL
      AND q.location_longitude IS NOT NULL
    """
    df = client.query(query).to_dataframe()
    log.info("  Received %d quays", len(df))
    return [
        (str(r.stop_ref), str(r.stop_name) if r.stop_name else None, r.lat, r.lng,
         str(r.stop_place_ref) if r.stop_place_ref else None,
         str(r.stop_place_name) if r.stop_place_name else None)
        for r in df.itertuples(index=False)
    ]


def save_cache(rows: list[tuple]) -> None:
    Path(CACHE_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE_PATH, "w") as f:
        json.dump(rows, f)
    log.info("  Saved cache to %s", CACHE_PATH)


def load_cache() -> list[tuple]:
    with open(CACHE_PATH) as f:
        data = json.load(f)
    return [tuple(r) for r in data]


CACHE_MAX_AGE_DAYS = 30


def cache_is_stale() -> bool:
    path = Path(CACHE_PATH)
    if not path.exists():
        return True
    import time
    age_days = (time.time() - path.stat().st_mtime) / 86400
    if age_days > CACHE_MAX_AGE_DAYS:
        log.info("Cache is %.0f days old (> %d) — will refresh from BigQuery", age_days, CACHE_MAX_AGE_DAYS)
        return True
    return False


def populate(db_path: str = DB_PATH, force_refresh: bool = False) -> None:
    if force_refresh or cache_is_stale():
        rows = fetch_from_bigquery()
        save_cache(rows)
    else:
        log.info("Loading stop coords from cache %s …", CACHE_PATH)
        rows = load_cache()
        log.info("  Loaded %d rows", len(rows))

    conn = sqlite3.connect(db_path)
    try:
        with conn:
            conn.execute("DELETE FROM stop_coords")
            conn.executemany(
                """INSERT OR REPLACE INTO stop_coords
                   (stop_ref, stop_name, lat, lng, stop_place_ref, stop_place_name)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                rows,
            )
        log.info("  Inserted %d rows into stop_coords", len(rows))
    finally:
        conn.close()


if __name__ == "__main__":
    force = "--refresh" in sys.argv
    populate(force_refresh=force)
