"""
Reads the GTFS stops.txt file and populates stop_place_ref, platform_code,
and stop_place_name columns in the stop_coords table.

Run after db_setup.py and populate_stops.py:
    python pipeline/populate_stop_places.py

The GTFS stops.txt file is expected at:
    "gammel nedlastning/stops.txt"
(relative to the project root, or override with --gtfs-file)

GTFS columns used:
    stop_id         → NSR:Quay:XXXXX  (the quay reference)
    parent_station  → NSR:StopPlace:XXXXX  (the parent stop place)
    platform_code   → platform letter (A, B, C, ...)
    stop_name       → used to populate stop_place_name for StopPlace rows
    location_type   → 1 = StopPlace row, empty = Quay row
"""

import csv
import os
import sqlite3
import sys
import argparse
from pathlib import Path

DB_PATH = os.environ.get(
    "DATABASE_PATH",
    str(Path(__file__).parent.parent / "data" / "bussforsinkelser.db"),
)
GTFS_DEFAULT = str(
    Path(__file__).parent.parent / "gammel nedlastning" / "stops.txt"
)


def add_columns_if_missing(conn: sqlite3.Connection) -> None:
    """Add stop_place_ref, platform_code, stop_place_name columns if not present."""
    cur = conn.execute("PRAGMA table_info(stop_coords)")
    existing = {row[1] for row in cur.fetchall()}

    if "stop_place_ref" not in existing:
        conn.execute("ALTER TABLE stop_coords ADD COLUMN stop_place_ref TEXT")
        print("  Added column: stop_place_ref")
    if "platform_code" not in existing:
        conn.execute("ALTER TABLE stop_coords ADD COLUMN platform_code TEXT")
        print("  Added column: platform_code")
    if "stop_place_name" not in existing:
        conn.execute("ALTER TABLE stop_coords ADD COLUMN stop_place_name TEXT")
        print("  Added column: stop_place_name")

    conn.commit()


def load_gtfs(gtfs_path: str) -> tuple[dict[str, dict], dict[str, str]]:
    """
    Parse stops.txt and return:
      quay_map: { 'NSR:Quay:XXXXX': { stop_place_ref, platform_code } }
      place_name_map: { 'NSR:StopPlace:XXXXX': 'stop_name' }
    """
    quay_map: dict[str, dict] = {}
    place_name_map: dict[str, str] = {}

    with open(gtfs_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            stop_id = row["stop_id"].strip()
            location_type = row.get("location_type", "").strip()
            stop_name = row.get("stop_name", "").strip()
            parent_station = row.get("parent_station", "").strip()
            platform_code = row.get("platform_code", "").strip()

            if location_type == "1":
                # StopPlace row — capture the name
                if stop_id.startswith("NSR:StopPlace:"):
                    place_name_map[stop_id] = stop_name
            else:
                # Quay row
                if stop_id.startswith("NSR:Quay:") and parent_station.startswith("NSR:StopPlace:"):
                    quay_map[stop_id] = {
                        "stop_place_ref": parent_station,
                        "platform_code": platform_code or None,
                    }

    return quay_map, place_name_map


def update_stop_coords(
    conn: sqlite3.Connection,
    quay_map: dict[str, dict],
    place_name_map: dict[str, str],
) -> tuple[int, int]:
    """
    Update stop_coords rows that have a matching quay in the GTFS file.
    Returns (updated_count, skipped_count).
    """
    cur = conn.execute("SELECT stop_ref FROM stop_coords")
    all_refs = [row[0] for row in cur.fetchall()]

    updated = 0
    skipped = 0

    for stop_ref in all_refs:
        if stop_ref not in quay_map:
            skipped += 1
            continue

        info = quay_map[stop_ref]
        place_ref = info["stop_place_ref"]
        platform = info["platform_code"]
        place_name = place_name_map.get(place_ref)

        conn.execute(
            """
            UPDATE stop_coords
               SET stop_place_ref  = ?,
                   platform_code   = ?,
                   stop_place_name = ?
             WHERE stop_ref = ?
            """,
            (place_ref, platform, place_name, stop_ref),
        )
        updated += 1

    conn.commit()
    return updated, skipped


def main() -> None:
    parser = argparse.ArgumentParser(description="Populate stop_place_ref and platform_code in stop_coords")
    parser.add_argument("--gtfs-file", default=GTFS_DEFAULT, help="Path to GTFS stops.txt")
    parser.add_argument("--db", default=DB_PATH, help="Path to SQLite database")
    args = parser.parse_args()

    if not Path(args.gtfs_file).exists():
        print(f"ERROR: GTFS file not found: {args.gtfs_file}", file=sys.stderr)
        sys.exit(1)
    if not Path(args.db).exists():
        print(f"ERROR: Database not found: {args.db}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading GTFS stops from: {args.gtfs_file}")
    quay_map, place_name_map = load_gtfs(args.gtfs_file)
    print(f"  {len(quay_map):,} quay mappings loaded")
    print(f"  {len(place_name_map):,} stop place names loaded")

    conn = sqlite3.connect(args.db)
    try:
        print("Adding columns if missing...")
        add_columns_if_missing(conn)

        print("Updating stop_coords...")
        updated, skipped = update_stop_coords(conn, quay_map, place_name_map)
        print(f"  Updated: {updated:,} rows")
        print(f"  Skipped (no GTFS match): {skipped:,} rows")
    finally:
        conn.close()

    print("Done.")


if __name__ == "__main__":
    main()
