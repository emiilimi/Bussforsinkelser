"""
passenger_stats.py — Passasjertellinger (samferdselsdata.no) x forsinkelser.

Kobler Enturs månedlige passasjertellinger (beta, samferdselsdata.no) mot
våre egne forsinkelsesobservasjoner og skriver SMÅ, ferdigregnede JSON-filer
som nettsiden slår opp i (ingen DuckDB i nettleseren):

    <PAX_OUT_DIR>/summary.json            operatør-KPI, linjeliste, last-vs-forsinkelse,
                                          kommuner, fulleste avganger, historikk
    <PAX_OUT_DIR>/lines/<OP_Line_X>.json  per linje: avganger med belegg og forsinkelse
                                          per stopp, timesprofil, månedshistorikk

Datakilde (offentlig GCS-bøtte bak samferdselsdata.no-utforskeren, funnet
2026-10-05 ved å lese utforskerens JS-bunt):
    https://storage.googleapis.com/ent-sdno-prd-paxcount-public/
      kol/ ost/ tro/   rå-filer: trip_id (= ServiceJourney-id), stop_id (NSR:Quay),
                       stop_sequence, operating_month, boarders, alighters
      aggregert/detail.parquet   linje x stopp x måned x time, fra 2022

⚠️ LISENS: samferdselsdata.no oppgir INGEN lisens, og dokumentasjonen ber om
at man «sjekker med dataeier før publisering». Utdata skrives derfor IKKE til
PARQUET_DIR (som upload_to_r2.py laster opp fra) — default er data/pax-out/.
Ikke last dette opp til R2 før Entur har bekreftet vilkårene.

Viktige valg (se docstringene under for begrunnelse):
  * Avgangsnøkkel = (line_ref, siste «_»-ledd av ServiceJourney-id). Hele id-en
    bytter 1,4–1,75 ganger per måned (datasettversjon i midten), siste ledd
    kolliderer på <0,06 % av (linje, dato) — målt august 2026.
  * Belegg per tur = månedstall / antall turer. Antall turer = observerte datoer
    for avgangen x (kalenderdager av dagtypen / datoer av dagtypen vi HAR data
    for) — korrigerer for hele dager som mangler i vår innsamling.
  * Passasjerminutter tapt = Σ avstigende x snitt(max(ankomstforsinkelse, 0))
    ved stoppet. Den som går av ved et stopp, opplever forsinkelsen der.
  * Forsinkelser med |d| > 120 min forkastes (samme grense som datakvalitets-
    flagget ellers på siden — dette er nesten alltid avganger som aldri ble
    avsluttet i sanntidsfeeden).

Bruk:
    python pipeline/passenger_stats.py
    PARQUET_DIR=data/reise-parquet PAX_OUT_DIR=client/public/pax-dev python pipeline/passenger_stats.py

Env:
    PARQUET_DIR     våre ukefiler (*-by-line.parquet)       default data/reise-parquet
    PAX_CACHE_DIR   lokal kopi av bøtta                     default data/pax-cache
    PAX_OUT_DIR     hvor JSON skrives                       default data/pax-out
    PAX_MAX_MONTHS  maks antall overlappende måneder        default 3
"""

from __future__ import annotations

import calendar
import json
import logging
import math
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from day_type import compute_day_type  # noqa: E402

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("passenger_stats")

BUCKET_URL = "https://storage.googleapis.com/ent-sdno-prd-paxcount-public"
PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", "data/reise-parquet"))
CACHE_DIR = Path(os.environ.get("PAX_CACHE_DIR", "data/pax-cache"))
OUT_DIR = Path(os.environ.get("PAX_OUT_DIR", "data/pax-out"))
MAX_MONTHS = int(os.environ.get("PAX_MAX_MONTHS", "3"))

# Operatører med per-avgang-tellinger i bøtta (2026-10). Vy/JDIR mangler
# avgangs-id (trip_id = «JDIR:operating_date:...») og er derfor ikke med her.
OPERATORS: dict[str, dict] = {
    "KOL": {"prefix": "kol", "name": "Kolumbus", "county": "Rogaland"},
    "OST": {"prefix": "ost", "name": "Østfold kollektivtrafikk", "county": "Østfold"},
    "TRO": {"prefix": "tro", "name": "Svipper", "county": "Troms"},
}

OUTLIER_MIN = 120.0
LOAD_BUCKETS = [(0, 10, "<10"), (10, 25, "10–25"), (25, 50, "25–50"), (50, 1e9, "50+")]


# ---------------------------------------------------------------------------
# 1. Speil bøtta lokalt (kun filer som har endret størrelse/etag)
# ---------------------------------------------------------------------------

def _list_bucket() -> list[dict]:
    """GCS XML-listing med paginering (marker)."""
    ns = {"s": "http://doc.s3.amazonaws.com/2006-03-01"}
    out: list[dict] = []
    marker = ""
    while True:
        url = f"{BUCKET_URL}?max-keys=1000" + (f"&marker={urllib.request.quote(marker)}" if marker else "")
        with urllib.request.urlopen(url, timeout=60) as r:
            root = ET.fromstring(r.read())
        for c in root.findall("s:Contents", ns):
            out.append({
                "key": c.findtext("s:Key", namespaces=ns),
                "size": int(c.findtext("s:Size", namespaces=ns) or 0),
                "etag": (c.findtext("s:ETag", namespaces=ns) or "").strip('"'),
            })
        if (root.findtext("s:IsTruncated", namespaces=ns) or "false").lower() != "true":
            break
        marker = out[-1]["key"]
    return out


def sync_cache() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    meta_path = CACHE_DIR / "_etags.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    wanted_prefixes = tuple(f"{o['prefix']}/" for o in OPERATORS.values()) + ("aggregert/detail.parquet",)
    objs = [o for o in _list_bucket() if o["key"].startswith(wanted_prefixes)]
    fetched = 0
    for o in objs:
        dst = CACHE_DIR / o["key"]
        if dst.exists() and meta.get(o["key"]) == o["etag"] and dst.stat().st_size == o["size"]:
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(dst.suffix + ".part")
        for attempt in range(3):
            try:
                urllib.request.urlretrieve(f"{BUCKET_URL}/{o['key']}", tmp)
                break
            except Exception as e:  # noqa: BLE001
                log.warning("Nedlasting feilet (%s), forsøk %d: %s", o["key"], attempt + 1, e)
                time.sleep(2 * (attempt + 1))
        else:
            raise RuntimeError(f"Kunne ikke laste ned {o['key']}")
        tmp.replace(dst)
        meta[o["key"]] = o["etag"]
        fetched += 1
    # Fjern lokale filer som er borte fra bøtta (ellers telles de dobbelt)
    keys = {o["key"] for o in objs}
    for p in CACHE_DIR.rglob("*.parquet"):
        k = p.relative_to(CACHE_DIR).as_posix()
        if k not in keys:
            p.unlink()
            meta.pop(k, None)
    meta_path.write_text(json.dumps(meta, indent=1))
    log.info("Pax-cache: %d filer i bøtta, %d lastet ned", len(objs), fetched)


# ---------------------------------------------------------------------------
# 2. Hjelpere
# ---------------------------------------------------------------------------

def month_bounds(m: date) -> tuple[date, date]:
    last = calendar.monthrange(m.year, m.month)[1]
    return m.replace(day=1), m.replace(day=last)


def calendar_day_types(m: date) -> dict[str, int]:
    first, last = month_bounds(m)
    counts: dict[str, int] = {}
    for day in range(first.day, last.day + 1):
        dt = compute_day_type(first.replace(day=day))
        counts[dt] = counts.get(dt, 0) + 1
    return counts


def r(x, nd=1):
    """Avrund for JSON (None/NaN → None)."""
    if x is None:
        return None
    try:
        if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
            return None
    except TypeError:
        return None
    return round(float(x), nd)


def strip_line_name(raw: str | None) -> str | None:
    """«KOL 8_1003: Forus nord - Jernbaneveien» → «Forus nord - Jernbaneveien»."""
    if not raw:
        return None
    return re.sub(r"^[A-ZÆØÅ]{2,4}\s+[^:]+:\s*", "", raw).strip() or None


def safe_name(line_ref: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", line_ref)


# SQL: stabil avgangsnøkkel. KOL/OST/TRO bruker «_» (…:1003_<versjon>_1001),
# Skyss m.fl. «-». Samme regel som paxDepKey() i client/src/lib/pax.ts.
KEY_SQL = """CASE WHEN contains(split_part({c}, ':', -1), '_') THEN split_part({c}, '_', -1)
                  WHEN contains(split_part({c}, ':', -1), '-') THEN split_part({c}, '-', -1)
                  ELSE split_part({c}, ':', -1) END"""


# ---------------------------------------------------------------------------
# 3. Hovedberegning
# ---------------------------------------------------------------------------

def main() -> int:
    t0 = time.time()
    sync_cache()

    by_line = sorted(PARQUET_DIR.glob("*-by-line.parquet"))
    if not by_line:
        log.error("Fant ingen *-by-line.parquet i %s", PARQUET_DIR)
        return 1

    con = duckdb.connect()
    mem = os.environ.get("STATS_DUCKDB_MEMORY", "4GB")
    con.execute(f"SET memory_limit='{mem}'")

    ops_sql = ", ".join(f"'{op}'" for op in OPERATORS)
    files_sql = "[" + ", ".join(f"'{p.as_posix()}'" for p in by_line) + "]"

    # Vårt datovindu + hvilke datoer (per dagtype) vi faktisk har data for.
    con.execute(f"""
        CREATE TABLE our_dates AS
        SELECT DISTINCT CAST(date AS DATE) AS d, day_type
        FROM read_parquet({files_sql})
        WHERE split_part(line_ref, ':', 1) IN ({ops_sql})
    """)
    dmin, dmax = con.execute("SELECT MIN(d), MAX(d) FROM our_dates").fetchone()
    log.info("Våre data for %s: %s → %s", ",".join(OPERATORS), dmin, dmax)

    pax_files = {
        op: sorted((CACHE_DIR / cfg["prefix"]).glob("*.parquet")) for op, cfg in OPERATORS.items()
    }
    detail_path = (CACHE_DIR / "aggregert" / "detail.parquet").as_posix()

    # --- Velg analysemåneder per operatør -----------------------------------
    # Fra aggregert/detail.parquet (liten, og allerede uten duplikater — se
    # DUPLIKATER under). Den er også fasiten vi sjekker rådata-summene mot.
    detail_totals = {
        (op, m): int(b) for op, m, b in con.execute(f"""
            SELECT source_id, operating_month, SUM(number_of_boarders)
            FROM read_parquet('{detail_path}') WHERE source_id IN ({ops_sql}) GROUP BY ALL
        """).fetchall()
    }
    op_months: dict[str, list[date]] = {}
    for op, files in pax_files.items():
        if not files:
            log.warning("%s: ingen pax-filer", op)
            continue
        rows = sorted((m, b) for (o, m), b in detail_totals.items() if o == op)
        totals = {m: b for m, b in rows}
        months = []
        for m, b in rows:
            first, last = month_bounds(m)
            if first < dmin or last > dmax:
                continue
            # Ufullstendig måned i bøtta? (TRO-september kom med før resten)
            prev = [totals[p] for p in totals if p < m][-3:]
            if prev and b < 0.5 * sorted(prev)[len(prev) // 2]:
                log.warning("%s %s: bare %d påstigninger mot median %d — hopper over (ufullstendig?)",
                            op, m, b, sorted(prev)[len(prev) // 2])
                continue
            months.append(m)
        op_months[op] = months[-MAX_MONTHS:]
        log.info("%s: analysemåneder %s", op, [m.isoformat()[:7] for m in op_months[op]])

    if not any(op_months.values()):
        log.error("Ingen måneder der både passasjertall og forsinkelser er komplette.")
        return 1

    # Månedstabell (op, month) for filtrering
    con.execute("CREATE TABLE op_month (op VARCHAR, month DATE)")
    for op, months in op_months.items():
        for m in months:
            con.execute("INSERT INTO op_month VALUES (?, ?)", [op, m])

    # Korrigering for hele dager som mangler i vår innsamling
    con.execute("CREATE TABLE day_scale (month DATE, day_type VARCHAR, scale DOUBLE)")
    for m in sorted({m for ms in op_months.values() for m in ms}):
        cal = calendar_day_types(m)
        first, last = month_bounds(m)
        have = dict(con.execute(
            "SELECT day_type, COUNT(*) FROM our_dates WHERE d BETWEEN ? AND ? GROUP BY 1", [first, last]
        ).fetchall())
        for dt, n_cal in cal.items():
            n_have = have.get(dt, 0)
            scale = n_cal / n_have if n_have else None
            if scale and scale > 1.0001:
                log.info("  %s %s: %d kalenderdager, %d med data → skala %.3f", m.isoformat()[:7], dt, n_cal, n_have, scale)
            con.execute("INSERT INTO day_scale VALUES (?, ?, ?)", [m, dt, scale])

    # --- Våre observasjoner for analysemånedene -----------------------------
    log.info("Leser forsinkelser …")
    con.execute(f"""
        CREATE TABLE obs AS
        SELECT o.line_ref,
               {KEY_SQL.format(c='o.service_journey_id')} AS dep_key,
               CAST(date_trunc('month', CAST(o.date AS DATE)) AS DATE) AS month,
               CAST(o.date AS DATE) AS d,
               o.stop_ref, o.stop_sequence AS seq,
               COALESCE(o.delay_arrival_min, o.delay_departure_min) AS d_arr,
               COALESCE(o.delay_departure_min, o.delay_arrival_min) AS d_dep,
               COALESCE(o.aimed_departure, o.aimed_arrival) AS aimed,
               o.day_type, o.vehicle_mode
        FROM read_parquet({files_sql}) o
        JOIN op_month om
          ON om.op = split_part(o.line_ref, ':', 1)
         AND om.month = CAST(date_trunc('month', CAST(o.date AS DATE)) AS DATE)
    """)
    n_all = con.execute("SELECT COUNT(*) FROM obs").fetchone()[0]
    con.execute(f"DELETE FROM obs WHERE abs(d_arr) > {OUTLIER_MIN} OR abs(d_dep) > {OUTLIER_MIN}")
    n_kept = con.execute("SELECT COUNT(*) FROM obs").fetchone()[0]
    log.info("  %d observasjoner (%d forkastet som |d| > %d min)", n_kept, n_all - n_kept, OUTLIER_MIN)

    # Per (måned, linje, avgang, stopp)
    con.execute("""
        CREATE TABLE dly AS
        SELECT month, line_ref, dep_key, stop_ref,
               COUNT(*) AS n,
               AVG(d_arr) AS mean_arr,
               AVG(GREATEST(d_arr, 0)) AS mean_pos_arr,
               AVG((d_arr <= 2)::INT) AS p_le2,
               AVG((d_arr > 5)::INT) AS p_gt5,
               AVG(d_dep) AS mean_dep,
               MIN(seq) AS seq,
               MODE(aimed) AS aimed
        FROM obs GROUP BY ALL
    """)
    # Per (måned, linje, avgang): antall turer (skalert), dagtype, starttid
    con.execute("""
        CREATE TABLE deps AS
        WITH base AS (
            SELECT month, line_ref, dep_key,
                   COUNT(DISTINCT d) AS days_obs,
                   MODE(day_type) AS day_type,
                   MODE(vehicle_mode) AS mode
            FROM obs GROUP BY ALL
        ), firsts AS (
            SELECT month, line_ref, dep_key, arg_min(aimed, seq) AS t_first
            FROM dly GROUP BY ALL
        )
        SELECT b.*, f.t_first,
               b.days_obs * COALESCE(s.scale, 1.0) AS runs
        FROM base b
        JOIN firsts f USING (month, line_ref, dep_key)
        LEFT JOIN day_scale s ON s.month = b.month AND s.day_type = b.day_type
    """)

    # --- Passasjertall -------------------------------------------------------
    log.info("Leser passasjertall …")
    union = []
    for op, files in pax_files.items():
        if not files or not op_months.get(op):
            continue
        fl = "[" + ", ".join(f"'{p.as_posix()}'" for p in files) + "]"
        union.append(f"SELECT * FROM read_parquet({fl}, union_by_name=true)")
    # DUPLIKATER: bøtta inneholder hele eksport-shards flere ganger (målt
    # 2026-10-05: kol/paxcount_…016 og …018 er identiske, juli 2026 ligger i
    # tre filer). En naiv SUM gir 2–3x for mange passasjerer. Vi fjerner
    # eksakt like rader (alle kolonner vi bruker) — IKKE bare (avgang, stopp),
    # fordi ringruter kan passere samme stopp to ganger i én tur.
    con.execute(f"""
        CREATE TABLE pax_raw AS
        SELECT DISTINCT p.source_id, p.operating_month, p.route_id, p.trip_id, p.stop_id,
               p.stop_sequence, p.departure_hour, p.direction_id,
               p.number_of_boarders, p.number_of_alighters,
               p.trip_headsign, p.route_short_name, p.stop_name, p.stop_latitude, p.stop_longitude,
               p.municipality, p.county, p.is_low_pop_stop
        FROM ({' UNION ALL BY NAME '.join(union)}) p
        JOIN op_month om ON om.op = p.source_id AND om.month = p.operating_month
    """)
    for op, m, b in con.execute("SELECT source_id, operating_month, SUM(number_of_boarders) FROM pax_raw GROUP BY ALL").fetchall():
        ref = detail_totals.get((op, m))
        if ref and abs(b - ref) / ref > 0.01:
            log.warning("%s %s: rådata gir %d påstigninger, aggregert/detail %d (%.1f %% avvik)",
                        op, m, b, ref, 100 * (b - ref) / ref)
        else:
            log.info("  %s %s: %d påstigninger (stemmer med aggregert/detail)", op, m.isoformat()[:7], b)
    con.execute(f"""
        CREATE TABLE pax AS
        SELECT p.operating_month AS month,
               p.route_id AS line_ref,
               {KEY_SQL.format(c='p.trip_id')} AS dep_key,
               p.stop_id AS stop_ref,
               SUM(p.number_of_boarders) AS b,
               SUM(COALESCE(p.number_of_alighters, 0)) AS a,
               MIN(p.stop_sequence) AS seq,
               MIN(p.departure_hour) AS hour,
               ANY_VALUE(p.trip_headsign) AS headsign,
               ANY_VALUE(p.route_short_name) AS public_code,
               ANY_VALUE(p.stop_name) AS stop_name,
               ANY_VALUE(p.stop_latitude) AS lat,
               ANY_VALUE(p.stop_longitude) AS lon,
               ANY_VALUE(p.municipality) AS municipality,
               ANY_VALUE(p.county) AS county,
               BOOL_OR(COALESCE(p.is_low_pop_stop, false)) AS low_pop
        FROM pax_raw p
        WHERE p.trip_id IS NOT NULL AND p.trip_id <> 'Unknown'
        GROUP BY ALL
    """)
    log.info("  %d pax-rader (måned x avgang x stopp)", con.execute("SELECT COUNT(*) FROM pax").fetchone()[0])

    # --- Kobling -------------------------------------------------------------
    con.execute("""
        CREATE TABLE j AS
        SELECT p.*,
               split_part(p.line_ref, ':', 1) AS op,
               d.runs, d.day_type, d.t_first, d.mode,
               y.n AS n_obs, y.mean_arr, y.mean_pos_arr, y.p_le2, y.p_gt5, y.mean_dep, y.aimed,
               COALESCE(p.seq, y.seq) AS ord,
               -- UTELLET AVGANG: 0 på og 0 av over hele måneden betyr nesten
               -- alltid at bussen ikke hadde teller, ikke at den gikk tom
               -- (målt august 2026: 12 % av KOL-avgangene, 1–2 % for OST/TRO;
               -- på KOL-linje 52 var bare skoleavgangene telt).
               SUM(p.b + p.a) OVER (PARTITION BY p.month, p.line_ref, p.dep_key) > 0 AS counted
        FROM pax p
        LEFT JOIN deps d USING (month, line_ref, dep_key)
        LEFT JOIN dly y USING (month, line_ref, dep_key, stop_ref)
    """)
    # Belegg om bord ETTER stoppet, per tur. Bare der vi kjenner antall turer.
    con.execute("""
        CREATE TABLE jl AS
        SELECT *,
               b / runs AS b_run,
               a / runs AS a_run,
               GREATEST(SUM((b - a) / runs) OVER (
                   PARTITION BY month, line_ref, dep_key ORDER BY ord, stop_ref
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) AS load
        FROM j WHERE runs IS NOT NULL AND runs > 0 AND counted
    """)

    coverage = {
        (op, m): (b_tot, b_dep, a_tot, a_dly)
        for op, m, b_tot, b_dep, a_tot, a_dly in con.execute("""
            SELECT op, month, SUM(b), SUM(b) FILTER (WHERE runs IS NOT NULL),
                   SUM(a), SUM(a) FILTER (WHERE mean_arr IS NOT NULL)
            FROM j GROUP BY ALL
        """).fetchall()
    }

    # --- Per avgang -----------------------------------------------------------
    con.execute("""
        CREATE TABLE dep_stats AS
        SELECT month, op, line_ref, dep_key,
               ANY_VALUE(headsign) AS headsign, ANY_VALUE(public_code) AS public_code,
               ANY_VALUE(day_type) AS day_type, ANY_VALUE(t_first) AS t_first,
               ANY_VALUE(runs) AS runs,
               MAX(load) AS peak,
               SUM(b_run) AS b_per_run,
               SUM(a * mean_arr) / NULLIF(SUM(a) FILTER (WHERE mean_arr IS NOT NULL), 0) AS pax_delay,
               AVG(mean_arr) AS stop_delay,
               MAX(mean_arr) AS max_delay
        FROM jl GROUP BY month, op, line_ref, dep_key
    """)

    # --- Per linje x måned ------------------------------------------------------
    con.execute("""
        CREATE TABLE line_month AS
        WITH pax_side AS (
            SELECT month, op, line_ref,
                   SUM(b) AS boardings, SUM(a) AS alightings,
                   SUM(a) FILTER (WHERE mean_arr IS NOT NULL) AS a_matched,
                   SUM(a * mean_pos_arr) AS pax_min_lost,
                   SUM(a * mean_arr) / NULLIF(SUM(a) FILTER (WHERE mean_arr IS NOT NULL), 0) AS pax_delay,
                   SUM(a * p_le2) / NULLIF(SUM(a) FILTER (WHERE p_le2 IS NOT NULL), 0) AS pax_ontime,
                   SUM(a * p_gt5) / NULLIF(SUM(a) FILTER (WHERE p_gt5 IS NOT NULL), 0) AS pax_late5,
                   ANY_VALUE(public_code) AS public_code,
                   MODE(mode) AS mode
            FROM j GROUP BY ALL
        ), stop_side AS (
            SELECT month, line_ref, AVG(d_arr) AS stop_delay, AVG((d_arr <= 2)::INT) AS stop_ontime,
                   COUNT(DISTINCT (dep_key, d)) AS trips
            FROM obs GROUP BY ALL
        ), counted_side AS (
            SELECT month, line_ref, COUNT(DISTINCT dep_key) AS n_deps_all,
                   COUNT(DISTINCT dep_key) FILTER (WHERE NOT counted) AS n_uncounted
            FROM j GROUP BY ALL
        ), dep_side AS (
            SELECT month, line_ref, COUNT(*) AS n_deps, MAX(peak) AS peak_max,
                   quantile_cont(peak, 0.9) AS peak_p90, AVG(peak) AS peak_avg,
                   COUNT(*) FILTER (WHERE peak >= 50) AS n_crowded
            FROM dep_stats GROUP BY ALL
        )
        SELECT p.*, s.stop_delay, s.stop_ontime, s.trips, c.n_deps_all, c.n_uncounted,
               d.n_deps, d.peak_max, d.peak_p90, d.peak_avg, d.n_crowded
        FROM pax_side p
        LEFT JOIN stop_side s USING (month, line_ref)
        LEFT JOIN dep_side d USING (month, line_ref)
        LEFT JOIN counted_side c USING (month, line_ref)
    """)

    # Linjenavn fra aggregate_stats-artefakten (finnes i PARQUET_DIR)
    names_path = PARQUET_DIR / "stats_line_names.json"
    line_names = {}
    if names_path.exists():
        line_names = {k: strip_line_name(v) for k, v in json.loads(names_path.read_text(encoding="utf-8")).items()}

    # --- Månedshistorikk fra aggregert/detail (fra 2022) ------------------------
    hist_rows = con.execute(f"""
        SELECT source_id, route_id, operating_month, SUM(number_of_boarders)
        FROM read_parquet('{detail_path}')
        WHERE source_id IN ({ops_sql})
        GROUP BY ALL ORDER BY 1, 2, 3
    """).fetchall()
    line_hist: dict[str, list] = {}
    op_hist: dict[str, dict[str, int]] = {}
    for op, route, m, b in hist_rows:
        line_hist.setdefault(route, []).append([m.isoformat()[:7], int(b)])
        op_hist.setdefault(op, {})
        op_hist[op][m.isoformat()[:7]] = op_hist[op].get(m.isoformat()[:7], 0) + int(b)

    # ======================================================================
    # Skriv summary.json
    # ======================================================================
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "lines").mkdir(exist_ok=True)

    latest = {op: ms[-1] for op, ms in op_months.items() if ms}

    operators_out = []
    for op, cfg in OPERATORS.items():
        if op not in latest:
            continue
        kpis = []
        for m in op_months[op]:
            row = con.execute("""
                SELECT SUM(boardings), SUM(pax_min_lost), SUM(a_matched),
                       SUM(pax_delay * a_matched) / NULLIF(SUM(a_matched), 0),
                       SUM(pax_ontime * a_matched) / NULLIF(SUM(a_matched), 0),
                       SUM(pax_late5 * a_matched) / NULLIF(SUM(a_matched), 0),
                       COUNT(*)
                FROM line_month WHERE op = ? AND month = ?
            """, [op, m]).fetchone()
            sd = con.execute("""
                SELECT AVG(d_arr), AVG((d_arr <= 2)::INT) FROM obs
                WHERE split_part(line_ref, ':', 1) = ? AND month = ?
            """, [op, m]).fetchone()
            unc = con.execute("""
                SELECT 100.0 * COUNT(DISTINCT (line_ref, dep_key)) FILTER (WHERE NOT counted)
                       / NULLIF(COUNT(DISTINCT (line_ref, dep_key)), 0)
                FROM j WHERE op = ? AND month = ?
            """, [op, m]).fetchone()[0]
            b_tot, b_dep, a_tot, a_dly = coverage.get((op, m), (0, 0, 0, 0))
            kpis.append({
                "month": m.isoformat()[:7],
                "boardings": int(row[0] or 0),
                "paxHoursLost": r((row[1] or 0) / 60, 0),
                "paxDelay": r(row[3], 2),
                "paxOnTime": r((row[4] or 0) * 100, 1),
                "paxLate5": r((row[5] or 0) * 100, 1),
                "stopDelay": r(sd[0], 2),
                "stopOnTime": r((sd[1] or 0) * 100, 1),
                "lines": row[6],
                "coverageBoardings": r(100 * (b_dep or 0) / b_tot, 1) if b_tot else None,
                "coverageAlightings": r(100 * (a_dly or 0) / a_tot, 1) if a_tot else None,
                "uncountedDeps": r(unc, 1),
            })
        operators_out.append({
            "code": op, "name": cfg["name"], "county": cfg["county"],
            "months": [m.isoformat()[:7] for m in op_months[op]],
            "latestMonth": latest[op].isoformat()[:7],
            "kpi": kpis,
            "history": sorted(op_hist.get(op, {}).items()),
        })

    lines_out = []
    for row in con.execute("""
        SELECT l.* FROM line_month l
        JOIN (SELECT op, MAX(month) AS month FROM op_month GROUP BY op) lm USING (op, month)
        ORDER BY pax_min_lost DESC NULLS LAST
    """).fetchdf().to_dict("records"):
        lines_out.append({
            "lineRef": row["line_ref"],
            "op": row["op"],
            "code": row["public_code"],
            "name": line_names.get(row["line_ref"]),
            "mode": row["mode"],
            "month": row["month"].isoformat()[:7],
            "boardings": int(row["boardings"] or 0),
            "paxHoursLost": r((row["pax_min_lost"] or 0) / 60, 1),
            "paxDelay": r(row["pax_delay"], 2),
            "paxOnTime": r((row["pax_ontime"] or 0) * 100 if row["pax_ontime"] is not None else None, 1),
            "paxLate5": r((row["pax_late5"] or 0) * 100 if row["pax_late5"] is not None else None, 1),
            "stopDelay": r(row["stop_delay"], 2),
            "stopOnTime": r((row["stop_ontime"] or 0) * 100 if row["stop_ontime"] is not None else None, 1),
            "trips": int(row["trips"] or 0),
            "deps": int(row["n_deps"] or 0),
            "peakMax": r(row["peak_max"], 0),
            "peakP90": r(row["peak_p90"], 0),
            "crowdedDeps": int(row["n_crowded"] or 0),
            "uncountedShare": r(100 * (row["n_uncounted"] or 0) / row["n_deps_all"], 1) if row["n_deps_all"] else None,
        })

    # Last vs forsinkelse — rush (hverdag 07–09/15–17) mot resten
    load_delay = []
    for row in con.execute(f"""
        WITH x AS (
            SELECT op, peak, stop_delay, max_delay,
                   CASE {' '.join(f"WHEN peak >= {lo} AND peak < {hi} THEN '{lab}'" for lo, hi, lab in LOAD_BUCKETS)} END AS bucket,
                   CASE {' '.join(f"WHEN peak >= {lo} AND peak < {hi} THEN {i}" for i, (lo, hi, _) in enumerate(LOAD_BUCKETS))} END AS bi,
                   (day_type = 'weekday' AND (
                       CAST(substr(t_first, 1, 2) AS INT) IN (7, 8, 15, 16))) AS rush
            FROM dep_stats ds
            JOIN (SELECT op, MAX(month) AS month FROM op_month GROUP BY op) lm USING (op, month)
            WHERE stop_delay IS NOT NULL AND t_first IS NOT NULL
        )
        SELECT op, rush, bucket, bi, COUNT(*), AVG(stop_delay), quantile_cont(max_delay, 0.5)
        FROM x GROUP BY ALL
        UNION ALL
        SELECT 'ALL', rush, bucket, bi, COUNT(*), AVG(stop_delay), quantile_cont(max_delay, 0.5)
        FROM x GROUP BY ALL
        ORDER BY 1, 2, 4
    """).fetchall():
        op, rush, bucket, _bi, n, md, mx = row
        load_delay.append({"op": op, "rush": bool(rush), "bucket": bucket, "n": n,
                           "meanDelay": r(md, 2), "medianWorstStop": r(mx, 2)})

    municipalities = [
        {"op": op, "municipality": mun, "county": cty, "boardings": int(b or 0),
         "paxHoursLost": r((pm or 0) / 60, 0), "paxDelay": r(pd, 2)}
        for op, mun, cty, b, pm, pd in con.execute("""
            SELECT op, municipality, ANY_VALUE(county), SUM(b), SUM(a * mean_pos_arr),
                   SUM(a * mean_arr) / NULLIF(SUM(a) FILTER (WHERE mean_arr IS NOT NULL), 0)
            FROM j JOIN (SELECT op, MAX(month) AS month FROM op_month GROUP BY op) lm USING (op, month)
            WHERE municipality IS NOT NULL
            GROUP BY op, municipality ORDER BY 5 DESC NULLS LAST
        """).fetchall()
    ]

    crowded = [
        {"op": op, "lineRef": lr, "code": code, "headsign": hs, "dayType": dt, "time": t,
         "peak": r(pk, 0), "runs": r(runs, 1), "boardingsPerRun": r(bpr, 0), "meanDelay": r(sd, 1),
         "depKey": dk}
        for op, lr, code, hs, dt, t, pk, runs, bpr, sd, dk in con.execute("""
            SELECT op, line_ref, public_code, headsign, day_type, t_first, peak, runs, b_per_run, stop_delay, dep_key
            FROM (SELECT ds.*, ROW_NUMBER() OVER (PARTITION BY op ORDER BY peak DESC) AS rn
                  FROM dep_stats ds
                  JOIN (SELECT op, MAX(month) AS month FROM op_month GROUP BY op) lm USING (op, month)
                  WHERE runs >= 3)
            WHERE rn <= 25 ORDER BY op, peak DESC
        """).fetchall()
    ]

    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {
            "name": "Passasjertellinger (beta), samferdselsdata.no / Entur",
            "url": "https://samferdselsdata.no/dataprodukter/passasjertellinger",
            "delayWindow": {"min": dmin.isoformat(), "max": dmax.isoformat()},
        },
        "method": {
            "outlierMin": OUTLIER_MIN,
            "loadBuckets": [b[2] for b in LOAD_BUCKETS],
            "rushHours": "hverdager, første avgang 07–09 og 15–17",
        },
        "operators": operators_out,
        "lines": lines_out,
        "loadDelay": load_delay,
        "municipalities": municipalities,
        "crowded": crowded,
    }
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log.info("summary.json: %d linjer, %d kommuner, %.0f KB",
             len(lines_out), len(municipalities), (OUT_DIR / "summary.json").stat().st_size / 1024)

    # ======================================================================
    # Skriv lines/<ref>.json — siste analysemåned
    # ======================================================================
    con.execute("""
        CREATE TABLE jl_latest AS
        SELECT jl.* FROM jl
        JOIN (SELECT op, MAX(month) AS month FROM op_month GROUP BY op) lm USING (op, month)
    """)
    stops_df = con.execute("""
        SELECT line_ref, stop_ref, ANY_VALUE(stop_name) AS name, ANY_VALUE(lat) AS lat, ANY_VALUE(lon) AS lon,
               SUM(b) AS b, SUM(a) AS a, BOOL_OR(low_pop) AS low_pop, AVG(ord) AS avg_ord
        FROM jl_latest GROUP BY ALL ORDER BY line_ref, avg_ord
    """).fetchdf()
    rows_df = con.execute("""
        SELECT line_ref, dep_key, stop_ref, ord, headsign, day_type, t_first, runs, aimed,
               b_run, a_run, load, mean_arr, n_obs
        FROM jl_latest ORDER BY line_ref, dep_key, ord, stop_ref
    """).fetchdf()
    hourly_df = con.execute("""
        SELECT line_ref, day_type, CAST(substr(t_first, 1, 2) AS INT) AS h,
               COUNT(*) AS n, AVG(peak) AS peak, AVG(stop_delay) AS delay, AVG(b_per_run) AS bpr
        FROM dep_stats ds
        JOIN (SELECT op, MAX(month) AS month FROM op_month GROUP BY op) lm USING (op, month)
        WHERE t_first IS NOT NULL
        GROUP BY ALL ORDER BY 1, 2, 3
    """).fetchdf()
    line_meta = {l["lineRef"]: l for l in lines_out}

    def to_min(hhmm):
        if not isinstance(hhmm, str) or len(hhmm) < 5:
            return None
        return int(hhmm[:2]) * 60 + int(hhmm[3:5])

    written = 0
    old = {p.name for p in (OUT_DIR / "lines").glob("*.json")}
    new = set()
    stops_by_line = {k: g for k, g in stops_df.groupby("line_ref")}
    hourly_by_line = {k: g for k, g in hourly_df.groupby("line_ref")}
    for line_ref, g in rows_df.groupby("line_ref"):
        sg = stops_by_line.get(line_ref)
        if sg is None:
            continue
        stop_idx = {ref: i for i, ref in enumerate(sg["stop_ref"])}
        stops = [[s.stop_ref, s.name, r(s.lat, 5), r(s.lon, 5), int(s.b), int(s.a), bool(s.low_pop)]
                 for s in sg.itertuples()]
        deps = []
        for dep_key, dg in g.groupby("dep_key", sort=False):
            first = dg.iloc[0]
            t0m = to_min(first.t_first)
            offs = []
            for a in dg["aimed"]:
                m = to_min(a)
                offs.append(None if (m is None or t0m is None) else (m - t0m) % 1440)
            deps.append({
                "k": dep_key,
                "hs": first.headsign,
                "dt": first.day_type,
                "t": first.t_first,
                "runs": r(first.runs, 1),
                "s": [stop_idx[x] for x in dg["stop_ref"]],
                "o": offs,
                "l": [r(x, 1) for x in dg["load"]],
                "b": [r(x, 1) for x in dg["b_run"]],
                "a": [r(x, 1) for x in dg["a_run"]],
                "d": [r(x, 1) for x in dg["mean_arr"]],
            })
        deps.sort(key=lambda d: (d["dt"] or "", d["t"] or "99:99"))
        hg = hourly_by_line.get(line_ref)
        hourly = [] if hg is None else [
            {"dt": h.day_type, "h": int(h.h), "n": int(h.n), "peak": r(h.peak, 1),
             "delay": r(h.delay, 2), "bpr": r(h.bpr, 1)}
            for h in hg.itertuples()
        ]
        meta = line_meta.get(line_ref, {})
        out = {
            "lineRef": line_ref,
            "op": line_ref.split(":")[0],
            "code": meta.get("code"),
            "name": meta.get("name") or line_names.get(line_ref),
            "mode": meta.get("mode"),
            "month": meta.get("month"),
            "kpi": meta,
            "history": line_hist.get(line_ref, []),
            "stops": stops,
            "deps": deps,
            "hourly": hourly,
        }
        fname = f"{safe_name(line_ref)}.json"
        (OUT_DIR / "lines" / fname).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        new.add(fname)
        written += 1
    for stale in old - new:
        (OUT_DIR / "lines" / stale).unlink()
    total_kb = sum(p.stat().st_size for p in (OUT_DIR / "lines").glob("*.json")) / 1024
    log.info("lines/: %d filer, %.0f KB totalt", written, total_kb)
    log.info("Ferdig på %.0f s", time.time() - t0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
