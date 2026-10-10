#!/usr/bin/env python3
"""
Overgangsfiler — ferdig sortert rådata per plattform for reiseplanleggeren.

HVORFOR: overgangssannsynligheten («rekker jeg bussen?») ble regnet i
nettleseren med DuckDB-WASM mot parquet på R2: én spørring per overgang, én
spørring om gangen, med HTTP range-kall per stopp og ukefil. Målt ~30 s varmt
og ~80 s kaldt for et vanlig søk (se CLAUDE.md, «Kostnadsmodell»).

Alle tre matche-nivåene i computeTransferGap (client/src/lib/trip-shared.ts)
— stabil avgangs-id, eksakt rutetid, ±60 min-pool — trenger bare dette fra
ÉN plattform om gangen: hvilke avganger som passerte, med linje, retning,
rutetider og målt forsinkelse per dato. Kombinasjonen av to plattformer
(ankomst her, avgang der) gjøres i nettleseren ved å stille datoene opp mot
hverandre — det er millisekunder. Derfor lagres rådata per PLATTFORM, ikke
per overgang: antall filer vokser med plattformer, ikke med kombinasjoner.

Skrives av aggregate_stats.py (nattjobben) og kan kjøres alene:

    PARQUET_DIR=data/reise-parquet python pipeline/transfer_shards.py

Output (lastes opp av upload_to_r2.py):

  transfer/index.json         {v, shards, path, operators, from, to, ...}
                              Klienten leser denne FØRST: den sier hvilke
                              operatører og datoer filene dekker, og hvilken
                              mappe shardene ligger i. Alt utenfor faller
                              tilbake til DuckDB som før.
  transfer/<N>/<shard>.json   N = antall shards. Mappenavnet gjør et bytte av
                              N atomisk: index.json lastes opp SIST og peker
                              ikke på den nye mappa før den er komplett.

Shardformat (kompakte arrays, se TransferShard i client/src/lib/transfer-data.ts):

  {"v":1, "d0":"2026-09-05", "dt":"WWWWWSU…", "L":["RUT:Line:31",…],
   "q": {"NSR:Quay:7170": [[li, dir, sk, aArr, aDep, [off…], [arr…], [dep…]], …]}}

  d0/dt   dato for forskyvning 0, og dagtype per forskyvning
          (W=weekday S=saturday U=sunday H=holiday M=may17)
  li      indeks i L
  sk      crc32(stabil avgangs-id) i base 36 — se stable_key()
  aArr/aDep  rutetid i minutter siden midnatt (HH*60+MM, som aimedMinExpr)
  arr/dep forsinkelse i HUNDREDELS minutter (parquet lagrer 0,01 min-oppløsning,
          så dette er tapsfritt), null der den mangler

Shardnøkkel: crc32(quayRef) % N — MÅ være lik shardOf() i transfer-data.ts.

Env:
    TRANSFER_OPERATORS  kommaseparert (default "RUT"). Tom = av.
    TRANSFER_DAYS       hvor mange dager bakover filene dekker (default 35;
                        reiseplanleggerens standardvindu er 30)
    TRANSFER_SHARDS     antall shards (default 2000)
    TRANSFER_OUT_DIR    utmappe (default PARQUET_DIR/transfer) — for testing
"""

import json
import logging
import os
import shutil
import time
import zlib
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).parent.parent
PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", str(REPO_ROOT / "data" / "parquet")))

OPERATORS = [o.strip() for o in os.environ.get("TRANSFER_OPERATORS", "RUT").split(",") if o.strip()]
DAYS = int(os.environ.get("TRANSFER_DAYS", "35"))
SHARDS = int(os.environ.get("TRANSFER_SHARDS", "2000"))
# Kun for testing: skriv et annet sted enn PARQUET_DIR/transfer (som nattjobben laster opp fra)
OUT_DIR = Path(os.environ.get("TRANSFER_OUT_DIR", str(PARQUET_DIR / "transfer")))
FORMAT_VERSION = 1

DAY_TYPE_CODE = {"weekday": "W", "saturday": "S", "sunday": "U", "holiday": "H", "may17": "M"}

log = logging.getLogger(__name__)


def shard_of(quay_ref: str, shards: int = SHARDS) -> int:
    """MÅ være identisk med shardOf() i client/src/lib/transfer-data.ts."""
    return zlib.crc32(quay_ref.encode("utf-8")) % shards


def stable_key(stable_id: str) -> str:
    """crc32 i base 36 av den STABILE avgangs-id-en (siste «-»-ledd, se
    stableSjId() i trip-shared.ts). Ruters id-er er 32 hex-tegn og endres ikke
    med datasettversjon; Skyss' stabile ledd er kort. En kort hash holder
    filene små; kollisjon krever at to ulike avganger på SAMME plattform får
    samme 32-bits hash (~n/2^32 for brukerens avgang), og ville bare blandet
    inn en nabos dager. MÅ være lik stableKey() i transfer-data.ts."""
    n = zlib.crc32(stable_id.encode("utf-8"))
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if n == 0:
            return out


def build_transfer_shards(con, generated_at: str, max_date: date, view: str = "delays") -> int:
    """Skriv transfer/<N>/<shard>.json + transfer/index.json. `view` er en
    DuckDB-view over by-stop-familien (samme som aggregate_stats bruker)."""
    root = OUT_DIR
    if not OPERATORS:
        log.info("overgangsfiler: TRANSFER_OPERATORS er tom — hopper over")
        return 0

    started = time.time()
    from_date = max_date - timedelta(days=DAYS - 1)
    ops_sql = ", ".join(f"'{o}'" for o in OPERATORS)
    where = f"""date >= '{from_date.isoformat()}' AND date <= '{max_date.isoformat()}'
        AND split_part(line_ref, ':', 1) IN ({ops_sql})"""

    day_types = dict(con.execute(f"""
        SELECT date, ANY_VALUE(day_type) FROM {view} WHERE {where} GROUP BY 1
    """).fetchall())
    if not day_types:
        log.warning("overgangsfiler: ingen rader for %s i %s → %s", OPERATORS, from_date, max_date)
        return 0
    dt_str = "".join(
        DAY_TYPE_CODE.get(day_types.get((from_date + timedelta(days=i)).isoformat()), "-")
        for i in range(DAYS)
    )

    # Én rad per (plattform, linje, retning, stabil avgang, rutetider); datoene
    # som parallelle lister. aimed_* er "HH:MM"/"HH:MM:SS"; minuttene regnes
    # likt aimedMinExpr i trip-shared.ts. Rader uten noen forsinkelse er
    # ubrukelige for alle tre nivåene og tas ikke med.
    t0 = time.time()
    con.execute("SET preserve_insertion_order = true")
    cur = con.execute(f"""
        WITH r AS (
            SELECT stop_ref, line_ref, direction_ref,
                   regexp_extract(service_journey_id, '[^-]*$') AS stable,
                   CASE WHEN aimed_arrival IS NULL THEN NULL ELSE
                     CAST(SUBSTR(aimed_arrival, 1, 2) AS INTEGER) * 60
                     + CAST(SUBSTR(aimed_arrival, 4, 2) AS INTEGER) END AS a_arr,
                   CASE WHEN aimed_departure IS NULL THEN NULL ELSE
                     CAST(SUBSTR(aimed_departure, 1, 2) AS INTEGER) * 60
                     + CAST(SUBSTR(aimed_departure, 4, 2) AS INTEGER) END AS a_dep,
                   CAST(date_diff('day', DATE '{from_date.isoformat()}', CAST(date AS DATE)) AS INTEGER) AS off,
                   CAST(ROUND(delay_arrival_min * 100) AS INTEGER) AS arr,
                   CAST(ROUND(delay_departure_min * 100) AS INTEGER) AS dep
            FROM {view}
            WHERE {where}
              AND (delay_arrival_min IS NOT NULL OR delay_departure_min IS NOT NULL)
        )
        SELECT stop_ref, line_ref, direction_ref, stable, a_arr, a_dep,
               LIST(off ORDER BY off, arr, dep), LIST(arr ORDER BY off, arr, dep),
               LIST(dep ORDER BY off, arr, dep)
        FROM r
        GROUP BY ALL
        ORDER BY stop_ref, line_ref, direction_ref NULLS FIRST, a_dep NULLS FIRST,
                 a_arr NULLS FIRST, stable
    """)

    # Skriv til en midlertidig mappe og bytt inn til slutt, så en avbrutt
    # kjøring aldri etterlater en halv mappe som upload_to_r2 laster opp.
    final_dir = root / str(SHARDS)
    tmp_dir = root / f"{SHARDS}.tmp"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True)

    # Hold alle shards i minnet: for RUT/35 dager er det ~100 MB Python-objekter
    # — overkommelig, og resultatet kommer sortert per plattform, ikke per shard.
    shards: dict[int, dict] = {}
    groups = rows = 0
    while True:
        batch = cur.fetchmany(50_000)
        if not batch:
            break
        for stop_ref, line_ref, dref, stable, a_arr, a_dep, offs, arrs, deps in batch:
            s = shards.get(shard_of(stop_ref))
            if s is None:
                s = shards[shard_of(stop_ref)] = {"L": [], "Li": {}, "q": {}}
            li = s["Li"].get(line_ref)
            if li is None:
                li = s["Li"][line_ref] = len(s["L"])
                s["L"].append(line_ref)
            s["q"].setdefault(stop_ref, []).append(
                [li, dref, stable_key(stable), a_arr, a_dep, offs, arrs, deps])
            groups += 1
            rows += len(offs)
    log.info("overgangsfiler: %d rader i %d avgangsgrupper, %d plattformer (%.1fs)",
             rows, groups, sum(len(s["q"]) for s in shards.values()), time.time() - t0)

    total = biggest = 0
    for shard, s in shards.items():
        doc = {"v": FORMAT_VERSION, "d0": from_date.isoformat(), "dt": dt_str,
               "L": s["L"], "q": s["q"]}
        p = tmp_dir / f"{shard}.json"
        p.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
        size = p.stat().st_size
        total += size
        biggest = max(biggest, size)

    if final_dir.exists():
        shutil.rmtree(final_dir)
    tmp_dir.rename(final_dir)
    # Mapper for et annet antall shards er foreldet (upload_to_r2 --prune
    # rydder dem i bøtta også).
    for d in root.iterdir():
        if d.is_dir() and d.name != str(SHARDS):
            shutil.rmtree(d)

    index = {
        "v": FORMAT_VERSION,
        "generatedAt": generated_at,
        "shards": SHARDS,
        "path": f"transfer/{SHARDS}",
        "operators": OPERATORS,
        "from": from_date.isoformat(),
        "to": max_date.isoformat(),
        "files": len(shards),
    }
    (root / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    log.info("→ transfer/ (%d shardfiler, %.1f MB, største %.0f KB, %s → %s, %s) på %.1fs",
             len(shards), total / 1e6, biggest / 1024, from_date, max_date,
             ",".join(OPERATORS), time.time() - started)
    return len(shards)


def main() -> int:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(message)s")
    files = sorted(PARQUET_DIR.glob("*-by-stop.parquet"))
    if not files:
        log.error("Ingen *-by-stop.parquet i %s", PARQUET_DIR)
        return 1
    con = duckdb.connect()
    con.execute(f"SET memory_limit = '{os.environ.get('STATS_DUCKDB_MEMORY', '8GB')}'")
    file_list = ", ".join(f"'{f.as_posix()}'" for f in files)
    con.execute(f"CREATE VIEW delays AS SELECT * FROM read_parquet([{file_list}])")
    max_date = date.fromisoformat(con.execute("SELECT MAX(date) FROM delays").fetchone()[0])
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    build_transfer_shards(con, generated_at, max_date)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
