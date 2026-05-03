"""
Populates line_name in the DB tables: line_daily, line_hourly_raw,
line_hourly_profile, and leaderboard_lines.

Two strategies, chosen automatically per operator:

  NeTEx   — reads XML files from netex/{operator_lower}/ and extracts the
             <Line id="..."><Name>...</Name></Line> element.  Used when the
             directory exists (e.g. netex/sky/ for SKY lines).

  DB-derived — queries journey_stop_daily to find the dominant terminus pair,
             weighted by total num_samples.  Used when no NeTEx directory is
             present (e.g. SOF, FIR).

Why weighted termini?
  Lines with multiple route variants would otherwise have their name hijacked
  by a minority variant that sorts alphabetically last.  Weighting by samples
  picks the pair that represents the most actual passenger-carrying trips.
  Secondary termini above 15% of dominant weight appear in parentheses, e.g.:
    SOF 8966_69: Måløy terminal - Nordfjordeid rutebilstasjon (Stryn rutebilstasjon)

Usage:
    python pipeline/populate_line_names.py                      # dry-run, all non-SKY operators
    python pipeline/populate_line_names.py --operator SKY       # dry-run, SKY via NeTEx
    python pipeline/populate_line_names.py --operator SOF       # dry-run, SOF via DB-derived
    python pipeline/populate_line_names.py --all                # dry-run, all operators with auto-generated names
    python pipeline/populate_line_names.py --apply              # write to DB
    python pipeline/populate_line_names.py --dump names.json    # save to file for manual editing
    python pipeline/populate_line_names.py --from-file names.json --apply  # apply edited file
"""

import argparse
import json
import os
import re
import sqlite3
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).parent.parent
DB_PATH = os.environ.get("DATABASE_PATH", str(ROOT / "data" / "bussforsinkelser.db"))
NETEX_ROOT = ROOT / "netex"

TABLES = ("line_daily", "line_hourly_raw", "line_hourly_profile", "leaderboard_lines")
NS = {"n": "http://www.netex.org.uk/netex"}

# ---------------------------------------------------------------------------
# NeTEx strategy
# ---------------------------------------------------------------------------

def netex_dir_for(operator: str) -> Path:
    """Returns netex/{operator_lower}/ — e.g. netex/sky/ for SKY."""
    return NETEX_ROOT / operator.lower()


def parse_netex_names(netex_dir: Path, operator: str) -> dict[str, str]:
    """Return {line_ref: line_name} parsed from NeTEx XML files in netex_dir."""
    pattern = f"{operator}_{operator}-Line-*.xml"
    files = list(netex_dir.glob(pattern))
    print(f"  Parsing {len(files)} NeTEx files in {netex_dir.relative_to(ROOT)}...")
    names: dict[str, str] = {}
    for f in files:
        try:
            tree = ET.parse(f)
            root = tree.getroot()
            for line_el in root.iter("{http://www.netex.org.uk/netex}Line"):
                line_id = line_el.get("id")
                name_el = line_el.find("n:Name", NS)
                if line_id and name_el is not None and name_el.text:
                    names[line_id] = name_el.text.strip()
        except ET.ParseError as e:
            print(f"  Warning: could not parse {f.name}: {e}")
    return names


# ---------------------------------------------------------------------------
# DB-derived strategy
# ---------------------------------------------------------------------------

TERMINUS_SQL = """
WITH journey_endpoints AS (
    SELECT
        j.service_journey_id,
        COUNT(*) AS journey_weight,
        (SELECT COALESCE(sc.stop_name, j2.stop_ref)
         FROM journey_stop_daily j2
         LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
         WHERE j2.service_journey_id = j.service_journey_id
         ORDER BY j2.stop_sequence ASC LIMIT 1) AS first_stop,
        (SELECT COALESCE(sc.stop_name, j2.stop_ref)
         FROM journey_stop_daily j2
         LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
         WHERE j2.service_journey_id = j.service_journey_id
         ORDER BY j2.stop_sequence DESC LIMIT 1) AS last_stop
    FROM journey_stop_daily j
    WHERE j.line_ref = ?
    GROUP BY j.service_journey_id
),
terminus_pairs AS (
    SELECT
        MIN(first_stop, last_stop) AS stop_a,
        MAX(first_stop, last_stop) AS stop_b,
        SUM(journey_weight) AS total_weight
    FROM journey_endpoints
    WHERE first_stop IS NOT NULL AND last_stop IS NOT NULL
    GROUP BY stop_a, stop_b
    ORDER BY total_weight DESC
)
SELECT stop_a, stop_b, total_weight FROM terminus_pairs LIMIT 10
"""


def short_id(line_ref: str) -> str:
    """'SOF:Line:7284_69' -> 'SOF 7284_69'"""
    m = re.match(r"^([^:]+):Line:(.+)$", line_ref)
    return f"{m.group(1)} {m.group(2)}" if m else line_ref


def derive_db_name(conn: sqlite3.Connection, line_ref: str) -> str | None:
    """Derive a display name from journey_stop_daily terminus data."""
    rows = conn.execute(TERMINUS_SQL, (line_ref,)).fetchall()
    if not rows:
        return None

    main_pair = None
    main_weight = 0
    for stop_a, stop_b, weight in rows:
        if stop_a and stop_b and stop_a != stop_b:
            main_pair = (stop_a, stop_b)
            main_weight = weight
            break

    if main_pair is None:
        return f"{short_id(line_ref)}: {rows[0][0]} (rundtur)"

    stop_a, stop_b = main_pair
    main_stops = {stop_a, stop_b}
    threshold = main_weight * 0.15
    extra: list[str] = []
    seen: set[str] = set()
    for row_a, row_b, weight in rows:
        if (row_a, row_b) == main_pair or weight < threshold:
            continue
        for stop in (row_a, row_b):
            if stop and stop not in main_stops and stop not in seen:
                extra.append(stop)
                seen.add(stop)

    name = f"{short_id(line_ref)}: {stop_a} - {stop_b}"
    if extra:
        name += f" ({', '.join(extra)})"
    return name


# ---------------------------------------------------------------------------
# Candidate selection
# ---------------------------------------------------------------------------

def get_candidate_operators(conn: sqlite3.Connection, operator: str | None, all_lines: bool) -> list[str]:
    """Return list of operator prefixes to process."""
    if operator:
        return [operator.upper()]
    if all_lines:
        rows = conn.execute(
            "SELECT DISTINCT SUBSTR(line_ref, 1, INSTR(line_ref, ':') - 1) AS op "
            "FROM line_daily WHERE line_name LIKE 'Linje %'"
        ).fetchall()
        return sorted({r[0] for r in rows if r[0]})
    # Default: all non-SKY operators present in the DB
    rows = conn.execute(
        "SELECT DISTINCT SUBSTR(line_ref, 1, INSTR(line_ref, ':') - 1) AS op "
        "FROM line_daily WHERE line_ref NOT LIKE 'SKY:%'"
    ).fetchall()
    return sorted({r[0] for r in rows if r[0]})


def derive_names_for_operator(conn: sqlite3.Connection, operator: str) -> dict[str, str]:
    """Return {line_ref: name} for all lines of this operator, using the best available strategy."""
    nd = netex_dir_for(operator)
    if nd.exists():
        print(f"  [{operator}] NeTEx directory found -> using NeTEx strategy")
        return parse_netex_names(nd, operator)
    else:
        print(f"  [{operator}] No NeTEx directory -> using DB-derived (weighted terminus) strategy")
        line_refs = conn.execute(
            "SELECT DISTINCT line_ref FROM line_daily WHERE line_ref LIKE ?",
            (f"{operator}:%",),
        ).fetchall()
        updates: dict[str, str] = {}
        no_data: list[str] = []
        for (line_ref,) in line_refs:
            name = derive_db_name(conn, line_ref)
            if name is None:
                no_data.append(line_ref)
            else:
                updates[line_ref] = name
        if no_data:
            print(f"  [{operator}] No journey data for: {', '.join(no_data)}")
        return updates


# ---------------------------------------------------------------------------
# DB write
# ---------------------------------------------------------------------------

def apply_updates(conn: sqlite3.Connection, updates: dict[str, str]) -> int:
    total = 0
    for line_ref, name in updates.items():
        for table in TABLES:
            cur = conn.execute(f"UPDATE {table} SET line_name = ? WHERE line_ref = ?", (name, line_ref))
            total += cur.rowcount
    conn.commit()
    return total


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Populate line names in DB (NeTEx or DB-derived per operator)")
    parser.add_argument("--apply", action="store_true", help="Write changes to DB (default: dry-run)")
    parser.add_argument("--operator", help="Process a single operator, e.g. SKY, SOF, ATB")
    parser.add_argument("--all", dest="all_lines", action="store_true",
                        help="Process all operators that still have auto-generated names")
    parser.add_argument("--dump", metavar="FILE",
                        help="Save derived names to JSON for manual editing (implies dry-run)")
    parser.add_argument("--from-file", metavar="FILE",
                        help="Apply names from a previously saved (and optionally edited) JSON file")
    args = parser.parse_args()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # ---- Load from file ----
    if args.from_file:
        path = Path(args.from_file)
        updates: dict[str, str] = json.loads(path.read_text(encoding="utf-8"))
        print(f"Loaded {len(updates)} names from {path}.")
        print()
        print(f"{'LINE REF':<35}  NAME")
        print("-" * 90)
        for line_ref, name in sorted(updates.items()):
            print(f"{line_ref:<35}  {name}")
        if not args.apply:
            print("\nDry-run — re-run with --apply to commit.")
            conn.close()
            return
        total = apply_updates(conn, updates)
        conn.close()
        print(f"\nUpdated {total} rows across {len(TABLES)} tables.")
        return

    # ---- Derive names ----
    operators = get_candidate_operators(conn, args.operator, args.all_lines)
    if not operators:
        print("No operators found to process.")
        conn.close()
        return
    print(f"Processing operators: {', '.join(operators)}")
    print()

    all_updates: dict[str, str] = {}
    for op in operators:
        updates_op = derive_names_for_operator(conn, op)
        all_updates.update(updates_op)
        print(f"  [{op}] {len(updates_op)} names derived.")

    print()
    print(f"{'LINE REF':<35}  DERIVED NAME")
    print("-" * 90)
    for line_ref, name in sorted(all_updates.items()):
        print(f"{line_ref:<35}  {name}")

    if args.dump:
        path = Path(args.dump)
        path.write_text(json.dumps(all_updates, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        print(f"\nSaved to {path}. Edit it, then run:")
        print(f"  python pipeline/populate_line_names.py --from-file {path} --apply")
        conn.close()
        return

    if not args.apply:
        print(f"\nDry-run — {len(all_updates)} names derived, not written.")
        print("Options:")
        print("  --apply                write directly to DB")
        print("  --dump names.json      save to file for editing first")
        conn.close()
        return

    total = apply_updates(conn, all_updates)
    conn.close()
    print(f"\nUpdated {total} rows across {len(TABLES)} tables ({len(all_updates)} lines).")


if __name__ == "__main__":
    main()
