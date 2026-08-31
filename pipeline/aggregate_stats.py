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
                           coverage: {lineRef: [w7, w30, w90]} — sanntidsdekning
                                   i prosent, fra coverage_daily i reise.db
                                   (kan IKKE utledes av parquet, som bare
                                   inneholder sanntidsobserverte rader)
  stats_stops_map.json   Kart + stopp-topplister:
                           per (stopp, operatør) med koordinater og
                           [snitt, andel >2 min, stddev, avganger] per vindu
  stats_line_names.json  {line_ref: navn} — SKY fra NeTEx (netex/sky/), andre
                           operatører fra vektet dominerende endeholdeplass-par
                           i journey_stop_daily. Samme metode som
                           pipeline/populate_line_names.py, men skriver til en
                           artefakt i stedet for SQLite-tabeller (reise.db har
                           ingen line_daily-tabell å oppdatere).
  stops/<shard>.json     Stoppanalyse: dagstrend, timesprofil, linjer ved
                           stoppet og linje×time — ferdig aggregert per stopp.
                           Erstatter fem DuckDB-WASM-spørringer i nettleseren
                           (målt ~40 s kaldt, se build_stop_detail_shards).
                           Shardet på crc32(stopPlaceRef) % STATS_STOP_SHARDS
                           for å holde R2-skrivingen langt under gratisgrensen.

MERK: bare ÉN parquet-familie leses. export_parquet skriver hver uke to ganger
(-by-line og -by-stop, samme rader ulikt sortert); et blankt "*.parquet" leste
alt dobbelt — dobbelt minne og tid, og dobbel COUNT(*).

Alle prosenter er 0–100. Forsinkelse = COALESCE(delay_departure_min,
delay_arrival_min) — samme definisjon som resten av systemet.

Env:
    PARQUET_DIR         hvor ukefilene ligger (default data/parquet)
    DATABASE_PATH       SQLite med stop_coords for lat/lng (default data/reise.db)
    STATS_WINDOWS       kommaseparerte vinduer i dager (default "7,30,90")
    STATS_STOP_SHARDS   antall shardfiler for stoppdetaljer (default 2000)
    STATS_STOP_WINDOWS  vinduer for stoppdetaljer (default "7,14,30,90" —
                        MÅ dekke periodevelgerens valg i frontend)
"""

import json
import logging
import os
import re
import shutil
import sqlite3
import time
import zlib
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

# «For tidlig»: mer enn ETT minutt før rutetid. Under det er tallet stort sett
# avrundingsstøy (7,7 % av observasjonene er negative i det hele tatt, men bare
# 2,8 % under -1 min). En avgang som går for tidlig kan man ikke rekke, men den
# teller likevel som «i rute» (forsinkelse <= 2 min) — uten dette tallet er den
# usynlig. Må holdes i synk med EARLY_MIN i client/src/lib/stats-adapter.ts.
EARLY_MIN = -1


def r(v, digits=2):
    """Rund flyttall for kompakt JSON; None passerer gjennom."""
    return None if v is None else round(float(v), digits)


# ---------------------------------------------------------------------------
# Stoppdetaljer, shardet — datagrunnlaget for Stoppanalyse.
#
# HVORFOR: Stoppanalyse regnet tidligere alt i nettleseren med DuckDB-WASM mot
# parquet på R2. Målt 2026-08-22 (Kringsjå, «Siste måned», 5 ukefiler):
# 43,2 s kaldt / 4,8 s varmt / 3,3 s mot lokale filer — altså ~40 s ren
# HTTP-rundtur for å hente parquet-metadata og kolonnebiter, ikke beregning.
# Ferdig aggregert her blir det ETT lite filoppslag i stedet.
#
# HVORFOR SHARDET, ikke én fil per stopp: filene inneholder DAGLIGE rader, så
# hvert stopp med avganger i går endres hver natt. Målt: ~70 683 aktive stopp
# per dag ⇒ 2,12 mill. skriv/mnd selv med endringsdeteksjon, altså OVER R2s
# gratisgrense på 1 mill. Class A-operasjoner. Med shards skalerer skrivingen
# med ANTALL SHARDS, ikke antall stopp: 2000 shards × 30 netter = 60 000
# skriv/mnd ≈ 6 % av grensen. Lagring ~83 MB av 10 GB.
#
# HVORFOR crc32(stopPlaceRef) OG IKKE stopRef: Stoppanalyse slår opp et
# NSR:StopPlace og trenger ALLE medlems-quays (Kringsjå = 4). Hashes quayene
# hver for seg havner de i ulike shards og vi er tilbake til flere rundturer.
# Med stoppestedet som nøkkel ligger de alltid i samme fil. Balansen holder:
# målt 45 113 stoppesteder → median 38 quays/shard, maks 70 ved N=2000.
# ---------------------------------------------------------------------------

STOP_SHARDS = int(os.environ.get("STATS_STOP_SHARDS", "2000"))
# Egen vindusliste for stoppdetaljer — MÅ dekke periodevelgerens valg
# (7/14/30/90, se PRESETS i components/time-window-picker.tsx). Holdes atskilt
# fra WINDOWS slik at kart-/toppliste-artefaktene beholder sitt format.
# Dagsradene dekker alle vinduer ved utsnitt; det er kun times-/linje-
# aggregatene som må lagres per vindu.
STOP_DETAIL_WINDOWS = [int(w) for w in
                       os.environ.get("STATS_STOP_WINDOWS", "7,14,30,90").split(",")]
# Grafen «Forsinkelse per linje og time» viser kun de mest trafikkerte linjene
# (uniqueLines .slice(0, 7) i stop-analysis-section.tsx). Vi lagrer 8 for litt
# slingringsmonn — resten ville vært død vekt i hver eneste shardfil.
STOP_TOP_LINES = 8


def shard_of(stop_place_ref: str, shards: int = STOP_SHARDS) -> int:
    """Deterministisk shard-nummer. MÅ være identisk med shardOf() i
    client/src/lib/stop-detail.ts — ellers ser klienten i feil fil."""
    return zlib.crc32(stop_place_ref.encode("utf-8")) % shards


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


def build_stop_detail_shards(con, coords: dict, generated_at: str, max_date: date) -> int:
    """Skriv stops/<shard>.json — ferdig aggregert stoppdetalj per shard.

    Strategi for minnebruk: de fem tunge aggregatene beregnes ÉN gang hver
    (fem parquet-skann totalt) inn i midlertidige DuckDB-tabeller. Deretter
    leses de per shard derfra — små, lokale spørringer uten nye parquet-skann.
    Python holder aldri mer enn én shard om gangen.
    """
    out_dir = PARQUET_DIR / "stops"
    if out_dir.exists():
        shutil.rmtree(out_dir)          # slett-ops er gratis på R2
    out_dir.mkdir(parents=True)

    # stop_ref → (shard, stopPlaceRef). Quays uten kjent stoppested hashes på
    # sin egen ref, slik at de fortsatt havner i en (egen) shard.
    mapping = []
    for stop_ref, (_lat, _lng, sp_ref, _sp_name, _platform) in coords.items():
        key = sp_ref or stop_ref
        mapping.append((stop_ref, shard_of(key), key))
    if not mapping:
        log.warning("Ingen stop_coords — hopper over stoppdetaljer")
        return 0

    con.execute("CREATE OR REPLACE TEMP TABLE shardmap (stop_ref VARCHAR, shard INTEGER, sp_ref VARCHAR)")
    con.executemany("INSERT INTO shardmap VALUES (?, ?, ?)", mapping)
    log.info("stoppdetaljer: %d quays → %d shards", len(mapping), STOP_SHARDS)

    max_win = max(STOP_DETAIL_WINDOWS)
    cut = {w: (max_date - timedelta(days=w - 1)).isoformat() for w in STOP_DETAIL_WINDOWS}
    HOUR = "CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER)"

    # --- daglig trend: kun største vindu; klienten skjærer ut kortere ---
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE det_daily AS
        SELECT m.shard, d.stop_ref, d.date,
               ROUND(AVG({D}), 2) AS avg_delay,
               ROUND(MAX({D}), 1) AS max_delay,
               ROUND(MIN({D}), 1) AS min_delay,
               ROUND(100.0 * AVG(CASE WHEN {D} > 2 THEN 1 ELSE 0 END), 1) AS pct2,
               ROUND(100.0 * AVG(CASE WHEN {D} < {EARLY_MIN} THEN 1 ELSE 0 END), 1) AS pct_early,
               ROUND(STDDEV_SAMP({D}), 2) AS stddev,
               COUNT(DISTINCT d.service_journey_id) AS departures
        FROM delays d JOIN shardmap m USING (stop_ref)
        WHERE d.date >= '{cut[max_win]}' AND {D} IS NOT NULL
        GROUP BY 1, 2, 3
    """)

    # --- timesprofil, per vindu ---
    # Per (vindu, stopp, time): snitt av DAGSSNITTENE, samt beste/verste dag —
    # samme definisjon som den gamle DuckDB-spørringen i stats-adapter.
    win_union = " UNION ALL ".join(
        f"""SELECT {w} AS win, m.shard AS shard, d.stop_ref AS stop_ref,
                   {HOUR} AS hour, d.date AS date,
                   AVG({D}) AS a, COUNT(*) AS n
            FROM delays d JOIN shardmap m USING (stop_ref)
            WHERE d.date >= '{cut[w]}' AND {D} IS NOT NULL
              AND COALESCE(d.aimed_departure, d.aimed_arrival) IS NOT NULL
            GROUP BY 1, 2, 3, 4, 5"""
        for w in STOP_DETAIL_WINDOWS)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE det_hourly AS
        SELECT win, shard, stop_ref, hour,
               ROUND(AVG(a), 2) AS avg_delay,
               ROUND(MAX(a), 2) AS max_avg,
               ROUND(MIN(a), 2) AS min_avg,
               CAST(SUM(n) AS BIGINT) AS n
        FROM ({win_union})
        GROUP BY 1, 2, 3, 4
    """)

    # --- linjer ved stoppet, per vindu ---
    lines_union = " UNION ALL ".join(
        f"""SELECT {w} AS win, m.shard, d.stop_ref, d.line_ref,
                   AVG({D}) AS avg_delay, COUNT(*) AS n
            FROM delays d JOIN shardmap m USING (stop_ref)
            WHERE d.date >= '{cut[w]}'
            GROUP BY 1,2,3,4"""
        for w in STOP_DETAIL_WINDOWS)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE det_lines AS
        SELECT win, shard, stop_ref, line_ref,
               ROUND(avg_delay, 2) AS avg_delay, CAST(n AS BIGINT) AS n
        FROM ({lines_union})
    """)

    # --- linje × time, KUN de mest trafikkerte linjene per stopp/vindu ---
    lh_union = " UNION ALL ".join(
        f"""SELECT {w} AS win, m.shard, d.stop_ref, d.line_ref, {HOUR} AS hour,
                   AVG({D}) AS avg_delay, COUNT(*) AS n
            FROM delays d JOIN shardmap m USING (stop_ref)
            WHERE d.date >= '{cut[w]}' AND {D} IS NOT NULL
              AND COALESCE(d.aimed_departure, d.aimed_arrival) IS NOT NULL
            GROUP BY 1,2,3,4,5"""
        for w in STOP_DETAIL_WINDOWS)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE det_linehour AS
        WITH raw AS ({lh_union}),
        ranked AS (
            SELECT *, DENSE_RANK() OVER (
                PARTITION BY win, stop_ref ORDER BY line_total DESC, line_ref
            ) AS rnk
            FROM (SELECT *, SUM(n) OVER (PARTITION BY win, stop_ref, line_ref) AS line_total FROM raw)
        )
        SELECT win, shard, stop_ref, line_ref, hour,
               ROUND(avg_delay, 2) AS avg_delay, CAST(n AS BIGINT) AS n
        FROM ranked WHERE rnk <= {STOP_TOP_LINES}
    """)

    # --- retninger (vindu-uavhengig) ---
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE det_dirs AS
        SELECT DISTINCT m.shard, d.stop_ref, d.direction_ref
        FROM delays d JOIN shardmap m USING (stop_ref)
        WHERE d.date >= '{cut[max_win]}' AND d.direction_ref IS NOT NULL
    """)

    for t in ("det_daily", "det_hourly", "det_lines", "det_linehour", "det_dirs"):
        n = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        log.info("  %s: %d rader", t, n)

    # Datoer lagres som dagforskyvning fra maxDate (0 = maxDate) — sparer ~8
    # byte per daglig rad, og klienten regner dem tilbake.
    def day_off(d) -> int:
        dd = d if isinstance(d, date) else date.fromisoformat(str(d)[:10])
        return (max_date - dd).days

    written = total_bytes = 0
    for shard in range(STOP_SHARDS):
        stops: dict[str, dict] = {}

        def slot(ref):
            return stops.setdefault(ref, {"d": [], "h": {}, "l": {}, "lh": {}, "dir": []})

        for ref, dt, avg, mx, mn, pct2, early, std, dep in con.execute(
            "SELECT stop_ref, date, avg_delay, max_delay, min_delay, pct2, pct_early,"
            " stddev, departures FROM det_daily WHERE shard = ? ORDER BY stop_ref, date",
            [shard],
        ).fetchall():
            slot(ref)["d"].append([day_off(dt), avg, mx, mn, pct2, early, std, int(dep)])

        for ref, win, hour, avg, mxa, mna, n in con.execute(
            "SELECT stop_ref, win, hour, avg_delay, max_avg, min_avg, n FROM det_hourly"
            " WHERE shard = ? ORDER BY stop_ref, win, hour", [shard],
        ).fetchall():
            slot(ref)["h"].setdefault(str(win), []).append([hour, avg, mxa, mna, int(n)])

        for ref, win, line_ref, avg, n in con.execute(
            "SELECT stop_ref, win, line_ref, avg_delay, n FROM det_lines"
            " WHERE shard = ? ORDER BY stop_ref, win, n DESC", [shard],
        ).fetchall():
            slot(ref)["l"].setdefault(str(win), []).append([line_ref, avg, int(n)])

        for ref, win, line_ref, hour, avg, n in con.execute(
            "SELECT stop_ref, win, line_ref, hour, avg_delay, n FROM det_linehour"
            " WHERE shard = ? ORDER BY stop_ref, win, line_ref, hour", [shard],
        ).fetchall():
            slot(ref)["lh"].setdefault(str(win), []).append([line_ref, hour, avg, int(n)])

        for ref, dref in con.execute(
            "SELECT stop_ref, direction_ref FROM det_dirs WHERE shard = ?"
            " ORDER BY stop_ref, direction_ref", [shard],
        ).fetchall():
            slot(ref)["dir"].append(dref)

        if not stops:
            continue                     # tom shard — ingen fil, klienten tåler 404
        doc = {
            "generatedAt": generated_at,
            "shard": shard,
            "windows": STOP_DETAIL_WINDOWS,
            "maxDate": max_date.isoformat(),
            "dcols": ["dayOffset", "avgDelayMin", "maxDelayMin", "minDelayMin",
                      "pctDelayed2plus", "pctEarly", "stddevDelayMin", "numDepartures"],
            "hcols": ["hour", "avgDelayMin", "maxAvgDelayMin", "minAvgDelayMin", "numSamples"],
            "lcols": ["lineRef", "avgDelayMin", "numSamples"],
            "lhcols": ["lineRef", "hour", "avgDelayMin", "numSamples"],
            "stops": stops,
        }
        p = out_dir / f"{shard}.json"
        p.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
        written += 1
        total_bytes += p.stat().st_size

    log.info("→ stops/ (%d shardfiler, %.1f MB totalt, snitt %.0f KB/fil)",
             written, total_bytes / 1e6, total_bytes / max(written, 1) / 1024)
    return written


def main() -> int:
    started = time.time()
    # KUN ÉN filfamilie. export_parquet skriver hver uke TO ganger — samme
    # rader, ulik sortering (-by-line og -by-stop, se CLAUDE.md). Et blankt
    # "*.parquet" fanget begge, så hver rad ble lest to ganger: dobbelt minne
    # og dobbel tid (OOM på 11 uker), og COUNT(*) ble dobbelt så høy.
    #
    # De EKSISTERENDE artefaktene overlevde det: alle synlige tellinger bruker
    # COUNT(DISTINCT ...), og snitt/vekter er skala-uavhengige — derfor har
    # ingen lagt merke til det. Men stoppdetaljene under teller med COUNT(*)
    # («N avg.», «stoppbesøk»), så her ville det blitt feil på skjermen.
    #
    # Eldre kataloger (full-bygget) har ufiksede navn som 2026-W16.parquet —
    # de dekkes av fallbacken.
    files = sorted(PARQUET_DIR.glob("*-by-stop.parquet"))
    if not files:
        files = sorted(f for f in PARQUET_DIR.glob("*.parquet")
                       if "-by-line" not in f.name)
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
    # (dato, line_ref, n_total, n_realtime) — råmateriale for per-linje-vinduene
    line_coverage_raw: list[tuple[str, str, int, int]] = []
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
                # Rå (dato, linje) — brukes til per-linje-vinduene lenger nede.
                # MÅ leses her: parquet inneholder kun sanntidsobserverte rader,
                # så nevneren (planlagte passeringer) finnes ikke der.
                for d, lr, total, rt in sq.execute(
                    "SELECT date, line_ref, n_total, n_realtime FROM coverage_daily"
                ):
                    if total:
                        line_coverage_raw.append((d, lr, int(total), int(rt)))
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
        log.info("coverage_daily: %d (dato, operatør)-rader, %d (dato, linje)-rader",
                 len(coverage), len(line_coverage_raw))

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
            ROUND(100.0 * AVG(CASE WHEN {D} < {EARLY_MIN} THEN 1 ELSE 0 END), 1)    AS pct_early,
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
            "pctDelayed10plus": r(row[4], 1), "pctEarly": r(row[5], 1),
            "totalJourneys": int(row[6]), "n": int(row[7]),
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
                    ROUND(100.0 * AVG(CASE WHEN {D} < {EARLY_MIN} THEN 1 ELSE 0 END), 1)    AS pct_early,
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
                    "pctEarly": r(row[6], 1),
                    "totalDepartures": int(row[7]),
                })
    log.info("lines: %d rader (%d vinduer)", len(lines), len(WINDOWS))

    # ------------------------------------------------------------------
    # coverage: sanntidsdekning per (linje, vindu), som {lineRef: [w7, w30, w90]}
    #
    # Per VINDU, ikke per dato: en per-dato-variant ble målt til 1,09 MB (+29 %
    # på artefakten), mot 89 kB for denne. stats_summary.json hentes ved hver
    # sidelast på hele reise-siten, så et helt stat-kort er ikke verdt 1 MB.
    #
    # Prisen er at egendefinerte datointervall ikke får dekningstall — klienten
    # viser «—» der i stedet, etter samme regel som resten av summary-svaret:
    # eksakt eller ingenting, aldri en tilnærming.
    #
    # Merk at dekningen IKKE har retnings- eller dagtypedimensjon (coverage_daily
    # er per dato+linje), så den vises bare når de filtrene står på «alle».
    # ------------------------------------------------------------------
    line_coverage: dict[str, list[float | None]] = {}
    if line_coverage_raw:
        for i, w in enumerate(WINDOWS):
            cutoff = (max_date - timedelta(days=w - 1)).isoformat()
            acc: dict[str, list[int]] = {}
            for d, lr, total, rt in line_coverage_raw:
                # Øvre grense også: coverage_daily prunes ALDRI, mens
                # parquet-uker ruller av etter 14 uker. Uten max_date_s-sjekken
                # kunne dekningen dekket flere dager enn tallene den står ved
                # siden av, den dagen ingest har kjørt men export_parquet ikke.
                if d < cutoff or d > max_date_s:
                    continue
                a = acc.setdefault(lr, [0, 0])
                a[0] += total
                a[1] += rt
            for lr, (total, rt) in acc.items():
                slot = line_coverage.setdefault(lr, [None] * len(WINDOWS))
                slot[i] = round(100.0 * rt / total, 1) if total else None
    log.info("coverage: %d linjer × %d vinduer", len(line_coverage), len(WINDOWS))
    # Frigjør råmaterialet (~90k rader) FØR stops-seksjonen: den aggregerer
    # titalls millioner parquet-rader i DuckDB og er stegets minnetopp.
    line_coverage_raw.clear()

    summary = {
        "generatedAt": generated_at,
        "windows": WINDOWS,
        "dates": {"min": min_date_s, "max": max_date_s},
        "daily": daily,
        "lines": lines,
        "coverage": line_coverage,
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
    # Stoppdetaljer per shard — samme DuckDB-pass og samme `coords` som
    # kartet over, slik at de to artefaktene ikke kan si ulike ting om
    # samme stopp. Se build_stop_detail_shards for hvorfor det shardes.
    # ------------------------------------------------------------------
    build_stop_detail_shards(con, coords, generated_at, max_date)

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
