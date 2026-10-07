"""
upload_pax.py — last opp passasjer-artefaktene (passenger_stats.py) til R2 under pax/.

BEVISST et eget skript, ikke en del av upload_to_r2.py / nattjobben:
samferdselsdata.no oppgir ingen lisens for passasjertellingene og ber om at
man avklarer med dataeier før publisering. Skriptet nekter derfor å kjøre
uten --confirm-license, som du bare skal bruke når Entur har sagt ja.

Etter opplasting: sett VITE_PAX_BASE_URL=https://parquet.sentur.no/pax i
Cloudflare Pages og bygg på nytt — uten den er menypunkt, side og
belegg-merker skjult (se client/src/lib/pax.ts).

Bruk:
    $env:R2_ENV_FILE = "r2.reise.env"
    python pipeline/upload_pax.py --dry-run
    python pipeline/upload_pax.py --confirm-license          # laster opp + rydder gamle linjefiler

Env:
    PAX_OUT_DIR   default data/pax-out (samme som passenger_stats.py)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from upload_to_r2 import (  # noqa: E402
    REPO_ROOT, UPLOAD_WORKERS, get_s3_client, load_env_file, upload_file,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("upload_pax")

PREFIX = "pax/"
# Artefaktene byttes månedlig; én time er rikelig og gir rask utrulling.
CACHE = "public, max-age=3600"


def main() -> int:
    env_file = os.environ.get("R2_ENV_FILE", "r2.env")
    load_env_file(REPO_ROOT / env_file)

    ap = argparse.ArgumentParser(description="Last opp passasjer-artefakter til R2 (pax/)")
    ap.add_argument("--confirm-license", action="store_true",
                    help="Bekreft at Entur har godkjent publisering av passasjertallene")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-prune", action="store_true", help="Ikke slett pax/-filer som ikke finnes lokalt")
    args = ap.parse_args()

    out_dir = Path(os.environ.get("PAX_OUT_DIR", "data/pax-out"))
    if not (out_dir / "summary.json").exists():
        log.error("Fant ikke %s — kjør pipeline/passenger_stats.py først", out_dir / "summary.json")
        return 1
    if not args.confirm_license and not args.dry_run:
        log.error("Avbrutt: passasjertallene har ingen avklart lisens. Bruk --dry-run, eller "
                  "--confirm-license når Entur har godkjent publisering.")
        return 2

    files = [out_dir / "summary.json", *sorted(out_dir.glob("stops_*.json")), *sorted((out_dir / "lines").glob("*.json"))]
    keys = {f: PREFIX + f.relative_to(out_dir).as_posix() for f in files}
    total_mb = sum(f.stat().st_size for f in files) / 1e6
    bucket = os.environ.get("R2_BUCKET", "bussforsinkelser-parquet")
    log.info("%d filer (%.1f MB) → %s/%s", len(files), total_mb, bucket, PREFIX)

    if args.dry_run:
        for f in files[:5]:
            log.info("  [dry-run] %s", keys[f])
        log.info("  [dry-run] … og %d til", max(0, len(files) - 5))
        return 0

    s3 = get_s3_client()
    up = skip = 0
    with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as ex:
        futs = [ex.submit(upload_file, s3, bucket, f, keys[f], False, False, CACHE, True) for f in files]
        for i, fut in enumerate(as_completed(futs), 1):
            if fut.result():
                up += 1
            else:
                skip += 1
            if i % 250 == 0 or i == len(futs):
                log.info("  %d/%d ferdig (%d lastet opp, %d uendret)", i, len(futs), up, skip)

    if not args.no_prune:
        local = set(keys.values())
        stale = []
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=PREFIX):
            for obj in page.get("Contents", []):
                if obj["Key"] not in local:
                    stale.append(obj["Key"])
        for k in stale:
            s3.delete_object(Bucket=bucket, Key=k)
        log.info("Prune: %d gamle pax-filer slettet", len(stale))

    log.info("Ferdig: %d lastet opp, %d uendret", up, skip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
