"""
Reads all NeTEx XML files in rb_sky-aggregated-netex/ and updates
line_name in the DB tables: line_daily, line_hourly_raw,
line_hourly_profile, and leaderboard_lines.

Run after ingest:
    python pipeline/populate_line_names.py

NeTEx source: rb_sky-aggregated-netex/SKY_SKY-Line-*.xml
Each file contains a <Line id="SKY:Line:X"><Name>...</Name></Line> element.
"""

import os
import sqlite3
import xml.etree.ElementTree as ET
from pathlib import Path

DB_PATH = os.environ.get(
    "DATABASE_PATH",
    str(Path(__file__).parent.parent / "data" / "bussforsinkelser.db"),
)

NETEX_DIR = Path(__file__).parent.parent / "rb_sky-aggregated-netex"
NS = {"n": "http://www.netex.org.uk/netex"}


def parse_line_names(netex_dir: Path) -> dict[str, str]:
    """Return {line_ref: line_name} parsed from all NeTEx XML files."""
    names: dict[str, str] = {}
    files = list(netex_dir.glob("SKY_SKY-Line-*.xml"))
    print(f"Parsing {len(files)} NeTEx files...")
    for f in files:
        try:
            tree = ET.parse(f)
            root = tree.getroot()
            for line_el in root.iter("{http://www.netex.org.uk/netex}Line"):
                line_id = line_el.get("id")  # e.g. "SKY:Line:6"
                name_el = line_el.find("n:Name", NS)
                if line_id and name_el is not None and name_el.text:
                    names[line_id] = name_el.text.strip()
        except ET.ParseError as e:
            print(f"  Warning: could not parse {f.name}: {e}")
    return names


def update_db(db_path: str, names: dict[str, str]) -> None:
    conn = sqlite3.connect(db_path)
    updated = 0
    for line_ref, line_name in names.items():
        for table in ("line_daily", "line_hourly_raw", "line_hourly_profile", "leaderboard_lines"):
            cur = conn.execute(
                f"UPDATE {table} SET line_name = ? WHERE line_ref = ?",
                (line_name, line_ref),
            )
            updated += cur.rowcount
    conn.commit()
    conn.close()
    print(f"Updated {updated} rows across 4 tables ({len(names)} lines mapped).")


def main() -> None:
    if not NETEX_DIR.exists():
        print(f"NeTEx directory not found: {NETEX_DIR}")
        raise SystemExit(1)
    names = parse_line_names(NETEX_DIR)
    if not names:
        print("No line names found — check NeTEx directory.")
        raise SystemExit(1)
    print(f"Found {len(names)} lines. Updating DB...")
    update_db(DB_PATH, names)
    print("Done.")


if __name__ == "__main__":
    main()
