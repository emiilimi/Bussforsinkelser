#!/usr/bin/env python3
"""
Engangsmigrering: konverter eksisterende, enkeltfil-per-uke Parquet
(f.eks. "2026-W25.parquet") til det nye to-fils formatet fra
export_parquet.py ("2026-W25-by-line.parquet" + "2026-W25-by-stop.parquet").

Kjøres MOT eksisterende Parquet-filer, IKKE mot SQLite — retention-vinduet i
journey_stop_daily har for lengst kastet rader for de eldste ukene, så
export_parquet.py sin vanlige vei (SQLite → Parquet) kan ikke re-generere dem.
Denne ruten (Parquet → Parquet, omsortert med DuckDB) krever ingen BigQuery-
kvote og ingen re-ingest — bare en lokal transformasjon av data vi alt har.

Usage:
    python pipeline/migrate_parquet_sort.py                # migrer alle gamle enkeltfiler
    python pipeline/migrate_parquet_sort.py --dry-run       # vis hva som ville skjedd
    python pipeline/migrate_parquet_sort.py --keep-old      # ikke slett gamle filer

Env:
    PARQUET_DIR   hvor ukefilene ligger (default data/parquet)
"""

import argparse
import logging
import os
from pathlib import Path

import duckdb

from export_parquet import FAMILIES, ROW_GROUP_SIZE, week_from_filename

REPO_ROOT = Path(__file__).parent.parent
PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", str(REPO_ROOT / "data" / "parquet")))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

SORT_KEYS = {
    "by-line": "line_ref, direction_ref, date, stop_sequence",
    "by-stop": "stop_ref, date, stop_sequence",
}


def find_legacy_files(parquet_dir: Path) -> list[Path]:
    """Enkeltfiler fra det gamle formatet — matcher IKKE -by-line/-by-stop."""
    out = []
    for f in sorted(parquet_dir.glob("*.parquet")):
        if week_from_filename(f.name) is None:
            # Ikke -by-line/-by-stop → gammelt format ("2026-W25.parquet")
            out.append(f)
    return out


def migrate_file(con: "duckdb.DuckDBPyConnection", src: Path, dry_run: bool) -> None:
    week_str = src.stem  # "2026-W25"
    n_rows = con.execute(f"SELECT COUNT(*) FROM read_parquet('{src.as_posix()}')").fetchone()[0]
    log.info("%s: %d rows", src.name, n_rows)

    for family in FAMILIES:
        out_path = src.parent / f"{week_str}-{family}.parquet"
        if dry_run:
            log.info("  [dry-run] ville skrevet %s", out_path.name)
            continue
        con.execute(f"""
            COPY (
                SELECT * FROM read_parquet('{src.as_posix()}')
                ORDER BY {SORT_KEYS[family]}
            )
            TO '{out_path.as_posix()}'
            (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {ROW_GROUP_SIZE})
        """)
        size_kb = out_path.stat().st_size / 1024
        log.info("  → %s (%.0f KB)", out_path.name, size_kb)


def main():
    parser = argparse.ArgumentParser(description="Migrer gamle Parquet-ukefiler til by-line/by-stop-formatet")
    parser.add_argument("--dry-run", action="store_true", help="Vis hva som ville blitt gjort, ikke skriv noe")
    parser.add_argument("--keep-old", action="store_true", help="Ikke slett de gamle enkeltfilene etter migrering")
    args = parser.parse_args()

    legacy = find_legacy_files(PARQUET_DIR)
    if not legacy:
        log.info("Ingen gamle enkeltfiler funnet i %s — ingenting å migrere", PARQUET_DIR)
        return

    log.info("Migrerer %d gammel(e) fil(er) i %s …", len(legacy), PARQUET_DIR)
    con = duckdb.connect()
    for src in legacy:
        migrate_file(con, src, args.dry_run)

    if args.dry_run:
        log.info("[dry-run] Ingen filer slettet")
        return

    if not args.keep_old:
        for src in legacy:
            # Verifiser at begge nye filer faktisk finnes og har samme radantall
            # før vi sletter kilden.
            week_str = src.stem
            n_src = con.execute(f"SELECT COUNT(*) FROM read_parquet('{src.as_posix()}')").fetchone()[0]
            ok = True
            for family in FAMILIES:
                out_path = src.parent / f"{week_str}-{family}.parquet"
                if not out_path.exists():
                    ok = False
                    break
                n_out = con.execute(f"SELECT COUNT(*) FROM read_parquet('{out_path.as_posix()}')").fetchone()[0]
                if n_out != n_src:
                    log.error("  %s: radantall matcher ikke (%d != %d) — beholder gammel fil", out_path.name, n_out, n_src)
                    ok = False
            if ok:
                src.unlink()
                log.info("  ✂ slettet gammel fil: %s", src.name)

    log.info("Ferdig.")


if __name__ == "__main__":
    main()
