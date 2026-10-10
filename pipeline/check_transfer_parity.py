#!/usr/bin/env python3
"""
Paritetssjekk: gir overgangsfilene SAMME svar som DuckDB-spørringene?

Trekker ekte overganger (ankomst på én plattform, avgang med en annen linje
2–15 min senere på en plattform i samme stoppested) fra parquet, kjører
klientens egen SQL (generert av script/check-transfer-parity.ts) mot de samme
parquet-filene med DuckDB, og lar TS-skriptet sammenligne med det
transfer-data.ts regner ut av filene.

    PARQUET_DIR=data/reise-parquet TRANSFER_OUT_DIR=<mappe med transfer/> \\
        python pipeline/check_transfer_parity.py

Krever at transfer_shards.py har skrevet filene for samme parquet-data.
"""

import json
import os
import random
import sqlite3
import subprocess
import sys
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).parent.parent
PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", str(REPO_ROOT / "data" / "parquet")))
OUT_DIR = Path(os.environ.get("TRANSFER_OUT_DIR", str(PARQUET_DIR / "transfer")))
DB_PATH = os.environ.get("DATABASE_PATH", str(REPO_ROOT / "data" / "reise.db"))
N = int(os.environ.get("PARITY_N", "60"))
WORK = OUT_DIR.parent / "parity"


def ts(mode: str) -> None:
    subprocess.run(
        ["npx", "tsx", "script/check-transfer-parity.ts", mode, str(WORK), str(OUT_DIR)],
        cwd=REPO_ROOT, check=True, shell=(os.name == "nt"),
    )


def main() -> int:
    WORK.mkdir(parents=True, exist_ok=True)
    index = json.loads((OUT_DIR / "index.json").read_text())
    ops = index["operators"]
    to, frm = index["to"], index["from"]

    con = duckdb.connect()
    files = sorted(PARQUET_DIR.glob("*-by-stop.parquet"))
    con.execute("CREATE VIEW delays_by_stop AS SELECT * FROM read_parquet([%s])"
                % ", ".join(f"'{f.as_posix()}'" for f in files))

    sq = sqlite3.connect(DB_PATH)
    sp = sq.execute("SELECT stop_ref, stop_place_ref FROM stop_coords WHERE stop_place_ref IS NOT NULL").fetchall()
    sq.close()
    con.execute("CREATE TABLE sp (stop_ref VARCHAR, sp VARCHAR)")
    con.executemany("INSERT INTO sp VALUES (?, ?)", sp)

    ops_sql = ", ".join(f"'{o}'" for o in ops)
    random.seed(7)
    specs = []
    # Én dato per dagtype — overgangen må finnes den dagen; statistikken regnes
    # så over hele vinduet, akkurat som i reiseplanleggeren.
    for day_type, n in (("weekday", N), ("saturday", N // 3), ("sunday", N // 4)):
        d = con.execute(f"""SELECT MAX(date) FROM delays_by_stop
            WHERE day_type = '{day_type}' AND date <= '{to}' AND date >= '{frm}'""").fetchone()[0]
        if not d:
            continue
        rows = con.execute(f"""
            WITH x AS (
              SELECT d.*, sp.sp,
                CAST(SUBSTR(aimed_arrival,1,2) AS INT)*60 + CAST(SUBSTR(aimed_arrival,4,2) AS INT) AS a_arr,
                CAST(SUBSTR(aimed_departure,1,2) AS INT)*60 + CAST(SUBSTR(aimed_departure,4,2) AS INT) AS a_dep
              FROM delays_by_stop d JOIN sp USING (stop_ref)
              WHERE date = '{d}' AND split_part(line_ref, ':', 1) IN ({ops_sql})
            )
            SELECT a.service_journey_id, a.stop_ref, a.line_ref, a.a_arr,
                   b.service_journey_id, b.stop_ref, b.line_ref, b.a_dep
            FROM x a JOIN x b ON a.sp = b.sp AND a.line_ref <> b.line_ref
              AND b.a_dep BETWEEN a.a_arr + 2 AND a.a_arr + 15
            WHERE a.aimed_arrival IS NOT NULL AND b.aimed_departure IS NOT NULL
            USING SAMPLE {n * 3} ROWS
        """).fetchall()
        random.shuffle(rows)
        for i, (asj, aq, al, aa, dsj, dq, dl, da) in enumerate(rows[:n]):
            # Vinduet: standard (samme dagtype, siste 30 dager) for de fleste,
            # «Siste 7 dager» (alle dagtyper) for hver femte.
            if i % 5 == 4:
                from datetime import date, timedelta
                w = {"dayTypes": None, "dateFrom": (date.fromisoformat(to) - timedelta(days=6)).isoformat(), "dateTo": None}
            else:
                from datetime import date, timedelta
                w = {"dayTypes": [day_type], "dateFrom": (date.fromisoformat(to) - timedelta(days=29)).isoformat(), "dateTo": None}
            # Hver sjette: ukjent avgangs-id → tester nivå 2/3 alene
            if i % 6 == 5:
                asj = asj + "-x"
            specs.append({
                "key": f"{day_type}-{i}", "arrSjId": asj, "arrQuayRef": aq, "arrLineRef": al, "arrAimedMin": aa,
                "depSjId": dsj, "depQuayRef": dq, "depLineRef": dl, "depAimedMin": da,
                "dayType": day_type, "statsWindow": w,
            })
    (WORK / "specs.json").write_text(json.dumps(specs))
    print(f"{len(specs)} overganger trukket")

    ts("sql")  # → sql.json: [{key, sql, distSql}]
    out = {}
    by_key = {sp["key"]: sp for sp in specs}
    for item in json.loads((WORK / "sql.json").read_text()):
        rows = con.execute(item["sql"]).fetchall() if item["sql"] else []
        dist = con.execute(item["distSql"]).fetchall()
        spec = by_key[item["key"]]
        ties: set[str] = set()
        for q, l, t, col, dcol in (
            (spec["arrQuayRef"], spec["arrLineRef"], spec["arrAimedMin"], "aimed_arrival", "delay_arrival_min"),
            (spec["depQuayRef"], spec["depLineRef"], spec["depAimedMin"], "aimed_departure", "delay_departure_min"),
        ):
            dx = f"ABS(CAST(SUBSTR({col},1,2) AS INT)*60 + CAST(SUBSTR({col},4,2) AS INT) - {t})"
            ties |= {str(r[0]) for r in con.execute(f"""
                SELECT date FROM (
                  SELECT date, {dx} AS dist, MIN({dx}) OVER (PARTITION BY date) AS mind
                  FROM delays_by_stop
                  WHERE stop_ref = '{q}' AND line_ref = '{l}' {item["winSql"]}
                    AND {col} IS NOT NULL AND {dcol} IS NOT NULL AND {dx} <= 60)
                WHERE dist = mind GROUP BY date HAVING COUNT(*) > 1""").fetchall()}
        out[item["key"]] = {
            "ties": sorted(ties),
            "rows": [{"src": r[0], "date": str(r[1]), "gap": r[2], "arr_min": r[3], "dep_min": r[4]} for r in rows],
            "dist": [list(r) for r in dist],
            "leg": [list(con.execute(q).fetchone()) for q in item["legSql"]],
        }
    (WORK / "duck.json").write_text(json.dumps(out))
    ts("compare")
    return 0


if __name__ == "__main__":
    sys.exit(main())
