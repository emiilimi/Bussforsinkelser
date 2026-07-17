#!/usr/bin/env python3
"""
Full offload: beregn aggregert statistikk fra Parquet-ukefilene med DuckDB og
skriv små JSON-artefakter som nettleseren leser direkte fra R2 — ingen
SQLite-server, ingen aggregat-tabeller.

Kjøres nattlig ETTER export_parquet.py og FØR upload_to_r2.py:

    python pipeline/aggregate_stats.py

Output (skrives til PARQUET_DIR, lastes opp av upload_to_r2.py med no-cache):

  stats_summary.json     Dashboard + topplister:
                           daily:  per (dato, operatør) — snitt, punktlighet,
                                   andel >10 min, antall avganger
                           lines:  per (linje, modus, vindu 7/30/90) — snitt,
                                   stddev, punktlighet, andel >10 min, avganger
  stats_stops_map.json   Kart + stopp-topplister:
                           per (stopp, operatør) med koordinater og
                           [snitt, andel >2 min, stddev, avganger] per vindu
  stats_line_names.json  {line_ref: navn} — SKY fra NeTEx (netex/sky/), andre
                           operatører fra vektet dominerende endeholdeplass-par
                           i journey_stop_daily. Samme metode som
                           pipeline/populate_line_names.py, men skriver til en
                           artefakt i stedet for SQLite-tabeller (reise.db har
                           ingen line_daily-tabell å oppdatere).

Alle prosenter er 0–100. Forsinkelse = COALESCE(delay_departure_min,
delay_arrival_min) — samme definisjon som resten av systemet.

Env:
    PARQUET_DIR     hvor ukefilene ligger (default data/parquet)
    DATABASE_PATH   SQLite med stop_coords for lat/lng (default data/reise.db)
    STATS_WINDOWS   kommaseparerte vinduer i dager (default "7,30,90")
"""

import json
import logging
import os
import re
import sqlite3
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).parent.parent
PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", str(REPO_ROOT / "data" / "parquet")))
DB_PATH = os.environ.get("DATABASE_PATH", str(REPO_ROOT / "data" / "reise.db"))
WINDOWS = [int(w) for w in os.environ.get("STATS_WINDOWS", "7,30,90").split(",")]

# Minste antall avganger for at en linje/et stopp tas med i et vindu —
# hindrer at én enkelt observasjon topper listene.
MIN_JOURNEYS_LINE = 5
MIN_DEPARTURES_STOP = 10

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# Forsinkelses-uttrykk (minutter): avgang der den finnes, ellers ankomst.
D = "COALESCE(delay_departure_min, delay_arrival_min)"


def r(v, digits=2):
    """Rund flyttall for kompakt JSON; None passerer gjennom."""
    return None if v is None else round(float(v), digits)


# ---------------------------------------------------------------------------
# Linjenavn — samme to strategier som pipeline/populate_line_names.py, men
# skriver til en JSON-artefakt i stedet for å UPDATE-e SQLite-tabeller
# (reise.db har ingen line_daily/leaderboard_lines å oppdatere).
# ---------------------------------------------------------------------------

NETEX_ROOT = REPO_ROOT / "netex"
NETEX_NS = {"n": "http://www.netex.org.uk/netex"}


def netex_line_names(operator: str) -> dict[str, str]:
    """{line_ref: navn} parset fra netex/{operator_lower}/*.xml. Tomt hvis mappen mangler."""
    netex_dir = NETEX_ROOT / operator.lower()
    if not netex_dir.exists():
        return {}
    names: dict[str, str] = {}
    for f in netex_dir.glob(f"{operator}_{operator}-Line-*.xml"):
        try:
            root = ET.parse(f).getroot()
            for line_el in root.iter("{http://www.netex.org.uk/netex}Line"):
                line_id = line_el.get("id")
                name_el = line_el.find("n:Name", NETEX_NS)
                if line_id and name_el is not None and name_el.text:
                    names[line_id] = name_el.text.strip()
        except ET.ParseError as e:
            log.warning("  Kunne ikke parse %s: %s", f.name, e)
    return names


def short_id(line_ref: str) -> str:
    """'SOF:Line:7284_69' -> 'SOF 7284_69'"""
    m = re.match(r"^([^:]+):Line:(.+)$", line_ref)
    return f"{m.group(1)} {m.group(2)}" if m else line_ref


_TERMINUS_SQL = """
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


def derive_db_name(sq: sqlite3.Connection, line_ref: str) -> str | None:
    """Utled visningsnavn fra dominerende endeholdeplass-par (vektet på antall avganger)."""
    rows = sq.execute(_TERMINUS_SQL, (line_ref,)).fetchall()
    if not rows:
        return None

    main_pair, main_weight = None, 0
    for stop_a, stop_b, weight in rows:
        if stop_a and stop_b and stop_a != stop_b:
            main_pair, main_weight = (stop_a, stop_b), weight
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


def build_line_names(sq: sqlite3.Connection) -> dict[str, str]:
    """{line_ref: navn} for alle linjer i journey_stop_daily. SKY fra NeTEx,
    resten fra vektet endeholdeplass-par (DB-derivert)."""
    line_refs = [row[0] for row in sq.execute("SELECT DISTINCT line_ref FROM journey_stop_daily")]
    by_operator: dict[str, list[str]] = {}
    for ref in line_refs:
        op = ref.split(":", 1)[0]
        by_operator.setdefault(op, []).append(ref)

    names: dict[str, str] = {}
    for op, refs in sorted(by_operator.items()):
        netex = netex_line_names(op)
        hits = 0
        for ref in refs:
            if ref in netex:
                names[ref] = netex[ref]
                hits += 1
            else:
                derived = derive_db_name(sq, ref)
                if derived:
                    names[ref] = derived
        if netex:
            log.info("  %s: %d/%d linjer fra NeTEx, resten DB-derivert", op, hits, len(refs))
    return names


def main() -> int:
    started = time.time()
    files = sorted(PARQUET_DIR.glob("*.parquet"))
    if not files:
        log.error("Ingen parquet-filer i %s — kjør export_parquet.py først", PARQUET_DIR)
        return 1

    con = duckdb.connect()
    file_list = ", ".join(f"'{f.as_posix()}'" for f in files)
    con.execute(f"CREATE VIEW delays AS SELECT * FROM read_parquet([{file_list}])")

    max_date_s, min_date_s = con.execute(
        "SELECT MAX(date), MIN(date) FROM delays"
    ).fetchone()
    max_date = date.fromisoformat(max_date_s)
    log.info("Datagrunnlag: %s → %s (%d filer)", min_date_s, max_date_s, len(files))

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # ------------------------------------------------------------------
    # Sanntidsdekning per (dato, operatør) fra coverage_daily i SQLite —
    # målt ved ingest (kan ikke utledes fra parquet, som kun har sanntidsrader).
    # ------------------------------------------------------------------
    coverage: dict[tuple, float] = {}
    cancellations: dict[tuple, int] = {}
    silent_journeys: dict[tuple, int] = {}
    if Path(DB_PATH).exists():
        sq = sqlite3.connect(DB_PATH)
        try:
            has_table = sq.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='coverage_daily'"
            ).fetchone()
            if has_table:
                cols = {r[1] for r in sq.execute("PRAGMA table_info(coverage_daily)")}
                canc_expr = "SUM(n_cancelled)" if "n_cancelled" in cols else "NULL"
                silent_expr = (
                    "SUM(n_journeys_norealtime)" if "n_journeys_norealtime" in cols else "NULL"
                )
                for d, op, total, rt, canc, silent in sq.execute(f"""
                    SELECT date,
                           substr(line_ref, 1, instr(line_ref, ':') - 1) AS operator,
                           SUM(n_total), SUM(n_realtime), {canc_expr}, {silent_expr}
                    FROM coverage_daily
                    GROUP BY 1, 2
                """):
                    if total:
                        coverage[(d, op)] = round(100.0 * rt / total, 1)
                    if canc is not None:
                        cancellations[(d, op)] = int(canc)
                    if silent is not None:
                        silent_journeys[(d, op)] = int(silent)
        finally:
            sq.close()
        log.info("coverage_daily: %d (dato, operatør)-rader", len(coverage))

    # ------------------------------------------------------------------
    # daily: per (dato, operatør)
    # ------------------------------------------------------------------
    daily_rows = con.execute(f"""
        SELECT
            date,
            split_part(line_ref, ':', 1)                    AS operator,
            ROUND(AVG({D}), 2)                              AS avg_delay,
            ROUND(100.0 * AVG(CASE WHEN {D} <= 2 THEN 1 ELSE 0 END), 1) AS pct_on_time,
            ROUND(100.0 * AVG(CASE WHEN {D} > 10 THEN 1 ELSE 0 END), 1)             AS pct_10plus,
            COUNT(DISTINCT service_journey_id)              AS journeys,
            COUNT(*)                                        AS n
        FROM delays
        WHERE {D} IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
    """).fetchall()
    daily = [
        {
            "date": row[0], "operator": row[1],
            "avgDelayMin": r(row[2]), "pctOnTime": r(row[3], 1),
            "pctDelayed10plus": r(row[4], 1),
            "totalJourneys": int(row[5]), "n": int(row[6]),
            "pctRealtimeCoverage": coverage.get((row[0], row[1])),
            # Avlyste avganger (unike) fra coverage_daily — null før 6. juli 2026
            "totalCancellations": cancellations.get((row[0], row[1])),
            # Avganger i feeden HELT uten sanntid (ikke avlyst) — null før 6. juli 2026
            "journeysMissingRealtime": silent_journeys.get((row[0], row[1])),
        }
        for row in daily_rows
    ]
    log.info("daily: %d rader", len(daily))

    # ------------------------------------------------------------------
    # lines: per (linje, modus inkl. 'all', vindu)
    # ------------------------------------------------------------------
    lines = []
    for w in WINDOWS:
        cutoff = (max_date - timedelta(days=w - 1)).isoformat()
        for mode_expr, mode_label in [("'all'", None), ("vehicle_mode", None)]:
            rows = con.execute(f"""
                SELECT
                    line_ref,
                    {mode_expr}                              AS mode,
                    ROUND(AVG({D}), 2)                       AS avg_delay,
                    ROUND(STDDEV_SAMP({D}), 2)               AS stddev,
                    ROUND(100.0 * AVG(CASE WHEN {D} <= 2 THEN 1 ELSE 0 END), 1) AS pct_on_time,
                    ROUND(100.0 * AVG(CASE WHEN {D} > 10 THEN 1 ELSE 0 END), 1)             AS pct_10plus,
                    COUNT(DISTINCT service_journey_id || date) AS departures
                FROM delays
                WHERE date >= '{cutoff}' AND {D} IS NOT NULL
                GROUP BY 1, 2
                HAVING COUNT(DISTINCT service_journey_id || date) >= {MIN_JOURNEYS_LINE}
            """).fetchall()
            for row in rows:
                lines.append({
                    "lineRef": row[0], "mode": row[1], "window": w,
                    "avgDelayMin": r(row[2]), "stddevDelayMin": r(row[3]),
                    "pctOnTime": r(row[4], 1), "pctDelayed10plus": r(row[5], 1),
                    "totalDepartures": int(row[6]),
                })
    log.info("lines: %d rader (%d vinduer)", len(lines), len(WINDOWS))

    summary = {
        "generatedAt": generated_at,
        "windows": WINDOWS,
        "dates": {"min": min_date_s, "max": max_date_s},
        "daily": daily,
        "lines": lines,
    }
    summary_path = PARQUET_DIR / "stats_summary.json"
    summary_path.write_text(json.dumps(summary, separators=(",", ":")), encoding="utf-8")
    log.info("→ %s (%.0f KB)", summary_path.name, summary_path.stat().st_size / 1024)

    # ------------------------------------------------------------------
    # stops: per (stopp, operatør) × vindu — kart + stopp-topplister.
    # Kompakt format: rader er arrays, vinduer er [avg, pct2plus, stddev, n]
    # eller null når stoppet mangler data i vinduet.
    # ------------------------------------------------------------------
    # Per quay: koordinater + stoppested-tilhørighet (for stoppanalyse-søkets
    # gruppering per stoppested) + plattformkode (finnes i praksis kun for SKY).
    coords: dict[str, tuple] = {}
    if Path(DB_PATH).exists():
        sq = sqlite3.connect(DB_PATH)
        try:
            for ref, lat, lng, sp_ref, sp_name, platform in sq.execute(
                "SELECT stop_ref, lat, lng, stop_place_ref, stop_place_name,"
                "       platform_code FROM stop_coords"
            ):
                coords[ref] = (lat, lng, sp_ref, sp_name, platform)
        finally:
            sq.close()
        log.info("stop_coords: %d koordinater fra %s", len(coords), DB_PATH)
    else:
        log.warning("Fant ikke %s — kartet får ingen koordinater", DB_PATH)

    def compact_sp_ref(sp_ref):
        """'NSR:StopPlace:123' → 123 (int) for å spare bytes; ellers uendret."""
        if isinstance(sp_ref, str) and sp_ref.startswith("NSR:StopPlace:"):
            tail = sp_ref[len("NSR:StopPlace:"):]
            if tail.isdigit():
                return int(tail)
        return sp_ref

    # windows-dict per (stop, operator)
    stops: dict[tuple, dict] = {}
    for w in WINDOWS:
        cutoff = (max_date - timedelta(days=w - 1)).isoformat()
        rows = con.execute(f"""
            SELECT
                stop_ref,
                split_part(line_ref, ':', 1)   AS operator,
                MAX(stop_name)                 AS stop_name,
                ROUND(AVG({D}), 2)             AS avg_delay,
                ROUND(100.0 * AVG(CASE WHEN {D} > 2 THEN 1 ELSE 0 END), 1) AS pct_2plus,
                ROUND(STDDEV_SAMP({D}), 2)     AS stddev,
                COUNT(DISTINCT service_journey_id || date) AS departures
            FROM delays
            WHERE date >= '{cutoff}' AND {D} IS NOT NULL
            GROUP BY 1, 2
            HAVING COUNT(DISTINCT service_journey_id || date) >= {MIN_DEPARTURES_STOP}
        """).fetchall()
        for stop_ref, operator, name, avg, pct2, std, dep in rows:
            key = (stop_ref, operator)
            entry = stops.setdefault(key, {"name": name, "w": {}})
            if name and not entry["name"]:
                entry["name"] = name
            entry["w"][w] = [r(avg), r(pct2, 1), r(std), int(dep)]

    # Radformat: [stopRef, operator, stopName, lat, lng, w1, w2, w3,
    #             spRef, platformCode, spName]
    # De tre siste er lagt til ETTER vinduene slik at eldre klienter (som
    # indekserer 5 + vindusindeks) leser uendret. spRef er kompaktet til bare
    # tallet; spName utelates når det er likt stopName.
    stop_rows = []
    for (stop_ref, operator), entry in sorted(stops.items()):
        lat, lng, sp_ref, sp_name, platform = coords.get(
            stop_ref, (None, None, None, None, None))
        stop_rows.append([
            stop_ref, operator, entry["name"], lat, lng,
            *[entry["w"].get(w) for w in WINDOWS],
            compact_sp_ref(sp_ref),
            platform,
            sp_name if (sp_name and sp_name != entry["name"]) else None,
        ])

    stops_doc = {
        "generatedAt": generated_at,
        "windows": WINDOWS,
        "cols": ["stopRef", "operator", "stopName", "lat", "lng",
                 *[f"w{w}" for w in WINDOWS],
                 "spRef", "platformCode", "spName"],
        "wcols": ["avgDelayMin", "pctDelayed2plus", "stddevDelayMin", "totalDepartures"],
        "stops": stop_rows,
    }
    stops_path = PARQUET_DIR / "stats_stops_map.json"
    stops_path.write_text(json.dumps(stops_doc, separators=(",", ":")), encoding="utf-8")
    log.info("→ %s (%d stopp, %.0f KB)", stops_path.name, len(stop_rows),
             stops_path.stat().st_size / 1024)

    # ------------------------------------------------------------------
    # Linjenavn — {line_ref: navn}, SKY fra NeTEx, resten DB-derivert.
    # ------------------------------------------------------------------
    if Path(DB_PATH).exists():
        sq = sqlite3.connect(DB_PATH)
        try:
            line_names = build_line_names(sq)
        finally:
            sq.close()
        names_path = PARQUET_DIR / "stats_line_names.json"
        names_path.write_text(json.dumps(line_names, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        log.info("→ %s (%d linjenavn, %.0f KB)", names_path.name, len(line_names),
                 names_path.stat().st_size / 1024)
    else:
        log.warning("Fant ikke %s — hopper over linjenavn", DB_PATH)

    log.info("Ferdig på %.1fs", time.time() - started)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
