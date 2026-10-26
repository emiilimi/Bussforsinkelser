#!/usr/bin/env python3
"""
Populate stop_coords from NSR (National Stop Registry).

Fetches all quays from BigQuery — including stop_place_ref (parent stop place)
and platform_code (publicCode, e.g. "A", "B", "C") — for ALL operators.
This makes populate_stop_places.py optional (it can still run as a Skyss override
for platform_code corrections, but is no longer the primary source for any operator).

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
    # Quays have no name column — join to stop_places to get the human-readable
    # stop place name (the parent of the quay).
    # publicCode is the NeTEx platform designation (e.g. "A", "B", "1", "2").
    # NOTE: If BigQuery raises "Unrecognized name: publicCode", try
    # replacing q.publicCode with q.platformCode or check the schema with:
    #   SELECT column_name FROM `ent-data-sharing-ext-prd.national_stop_registry.INFORMATION_SCHEMA.COLUMNS`
    #   WHERE table_name = 'quays_last_version'
    query = f"""
    SELECT
        q.id                  AS stop_ref,
        sp.name               AS stop_name,
        q.location_latitude   AS lat,
        q.location_longitude  AS lng,
        q.stopPlaceRef        AS stop_place_ref,
        sp.name               AS stop_place_name,
        q.publicCode          AS platform_code,
        -- Multimodale knutepunkt: geocoderet (og dermed stoppsøket) gir
        -- FORELDEREN, sanntidsdataene peker på barnet. Oslo Kringsjå: søket
        -- gir NSR:StopPlace:59706, quayene ligger under 6211 (T-bane) og
        -- 6213 (buss), begge med parentRef 59706 (målt 2026-10-26). Uten
        -- denne koblingen måtte klienten gjette på navn — og traff Bergen.
        sp.parentRef.ref      AS parent_stop_place_ref
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
         str(r.stop_place_name) if r.stop_place_name else None,
         str(r.platform_code) if r.platform_code else None,
         str(r.parent_stop_place_ref) if r.parent_stop_place_ref else None)
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
    rows = [tuple(r) for r in data]
    # Bakoverkompatibelt: eldre cacher har 6 (uten platform_code) eller 7
    # (uten parent_stop_place_ref) kolonner. Fyll med None til 8-tupler.
    return [r + (None,) * (8 - len(r)) for r in rows]


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


# Et svar med vesentlig færre quays enn forrige gang er nesten sikkert en
# feil (avbrutt spørring, tom tabell under oppdatering hos Entur) — og
# populate() sletter HELE stop_coords før den skriver. Da beholdes den gamle
# lista. Målt 2026-10-26: 111 786 quays i cachen fra 28.06.
MIN_REFRESH_RATIO = 0.9


def populate(db_path: str = DB_PATH, force_refresh: bool = False, only_if_stale: bool = False) -> None:
    stale = cache_is_stale()
    if only_if_stale and not stale and not force_refresh:
        # Nattjobben kaller oss hver natt med --if-stale; da skal en fersk
        # cache ikke føre til at 111 000 rader slettes og skrives på nytt.
        log.info("Stoppregisteret er ferskt (< %d dager) — ingenting å gjøre", CACHE_MAX_AGE_DAYS)
        return
    if force_refresh or stale:
        rows = fetch_from_bigquery()
        if Path(CACHE_PATH).exists():
            old_n = len(load_cache())
            if old_n and len(rows) < MIN_REFRESH_RATIO * old_n:
                raise SystemExit(
                    f"BigQuery ga {len(rows)} quays mot {old_n} i cachen "
                    f"(< {MIN_REFRESH_RATIO:.0%}) — beholder den gamle lista"
                )
        save_cache(rows)
    else:
        log.info("Loading stop coords from cache %s …", CACHE_PATH)
        rows = load_cache()
        log.info("  Loaded %d rows", len(rows))

    conn = sqlite3.connect(db_path)
    try:
        # Kolonnen kom 2026-10-26 — legg den til i eksisterende baser
        cols = {r[1] for r in conn.execute("PRAGMA table_info(stop_coords)")}
        if "parent_stop_place_ref" not in cols:
            conn.execute("ALTER TABLE stop_coords ADD COLUMN parent_stop_place_ref TEXT")
        with conn:
            conn.execute("DELETE FROM stop_coords")
            conn.executemany(
                """INSERT OR REPLACE INTO stop_coords
                   (stop_ref, stop_name, lat, lng, stop_place_ref, stop_place_name, platform_code,
                    parent_stop_place_ref)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                rows,
            )
        log.info("  Inserted %d rows into stop_coords", len(rows))
    finally:
        conn.close()


if __name__ == "__main__":
    # --refresh   hent fra BigQuery uansett
    # --if-stale  hent bare når cachen er eldre enn CACHE_MAX_AGE_DAYS, og rør
    #             ellers ikke databasen (brukes av nattjobben → månedlig)
    populate(force_refresh="--refresh" in sys.argv, only_if_stale="--if-stale" in sys.argv)
