#!/usr/bin/env python3
"""
Last opp Parquet-filer + manifest.json til Cloudflare R2.

Laster fra data/parquet/ og genererer manifest.json automatisk.
Hopper over filer som ikke er endret (sammenligner ETag/størrelse).

Credentials leses fra r2.env i prosjektmappen eller fra environment-variabler.

Usage:
    python pipeline/upload_to_r2.py                 # last opp nye/endrede filer
    python pipeline/upload_to_r2.py --all           # tving re-opplasting av alt
    python pipeline/upload_to_r2.py --dry-run       # vis hva som ville blitt lastet opp
    python pipeline/upload_to_r2.py --prod-db       # last opp KUN prod-DB (hopp over parquet + manifest)

Env-variabler (i r2.env eller i shell):
    R2_ACCOUNT_ID       f.eks. b274357997a1a1ccb8855267adec44b9
    R2_ACCESS_KEY_ID    API-nøkkel fra Cloudflare R2
    R2_SECRET_ACCESS_KEY
    R2_BUCKET           f.eks. bussforsinkelser-parquet
    R2_PUBLIC_URL       f.eks. https://pub-xxx.r2.dev
"""

import argparse
import hashlib
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from export_parquet import week_from_filename

# ---------------------------------------------------------------------------
# Konfigurasjon
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).parent.parent
PARQUET_DIR = Path(os.environ.get("PARQUET_DIR", str(REPO_ROOT / "data" / "parquet")))

# Hvor mange ukefiler som beholdes i manifest/bucket (nyeste først).
# 14 uker ≈ 98 dager — dekker nettleserens 90-dagersvindu med margin.
# 0 = ubegrenset. Eldre filer utelates fra manifestet og slettes fra
# bucketen når --prune brukes.
KEEP_WEEKS = int(os.environ.get("PARQUET_KEEP_WEEKS", "14"))

# Parallelle opplastinger av shardfilene (2000 små filer, hver med et
# head_object-kall først). Sekvensielt lå det på ~2 filer/s ≈ 17 min;
# boto3-klienter er trådsikre, så dette er trygt å kjøre i parallell.
UPLOAD_WORKERS = int(os.environ.get("R2_UPLOAD_WORKERS", "8"))

# Filer under denne størrelsen lastes opp med ett put_object-kall i stedet
# for s3transfer (som spinner opp sin egen trådpool per kall). Over grensa
# bruker s3transfer multipart — og da er ETag IKKE lenger md5 av innholdet,
# se upload_file.
PUT_OBJECT_MAX_BYTES = 8 * 1024 * 1024

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)


def load_env_file(path: Path) -> None:
    """Last inn KEY=VALUE-par fra en .env-fil til os.environ (hopp over linjer med #)."""
    if not path.exists():
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value


def get_s3_client():
    """Lag boto3 S3-klient konfigurert for Cloudflare R2."""
    account_id = os.environ.get("R2_ACCOUNT_ID", "")
    access_key = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "")

    if not all([account_id, access_key, secret_key]):
        raise ValueError(
            "Mangler R2-credentials. Sett R2_ACCOUNT_ID, R2_ACCESS_KEY_ID og "
            "R2_SECRET_ACCESS_KEY i r2.env eller som environment-variabler."
        )

    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )


def md5_of_file(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def upload_file(
    s3,
    bucket: str,
    local_path: Path,
    key: str,
    force: bool = False,
    dry_run: bool = False,
    cache_control: str | None = None,
    quiet: bool = False,
) -> bool:
    """Last opp én fil. Returner True hvis filen ble lastet opp.

    Uendret-sjekken sammenligner lokal md5 med objektets `md5`-metadata, og
    faller tilbake på ETag. ETag alene holdt IKKE: for filer over 8 MB
    bruker s3.upload_file multipart, og da er ETag «md5-av-del-md5-er-N»,
    aldri lik filens md5. Alle 22 ukefilene (29–92 MB) ble derfor lastet opp
    på nytt hver eneste natt — ~1,4 GB og 2–3 min per forsøk — selv om
    loggen kalte det en "uendret"-sjekk. Metadataen settes ved opplasting
    her, så første kjøring etter denne endringen laster alt opp én gang til,
    deretter hopper den over det som faktisk er uendret.
    """
    content_type = "application/json" if key.endswith(".json") else "application/octet-stream"
    local_md5 = md5_of_file(local_path)

    if not force:
        try:
            head = s3.head_object(Bucket=bucket, Key=key)
            remote_md5 = (head.get("Metadata") or {}).get("md5")
            remote_etag = head["ETag"].strip('"').lower()
            if local_md5 in (remote_md5, remote_etag):
                log.debug("  Uendret, hopper over: %s", key)
                return False
        except ClientError as e:
            if e.response["Error"]["Code"] != "404":
                raise

    size = local_path.stat().st_size
    size_kb = size / 1024
    if dry_run:
        log.info("  [dry-run] Ville lastet opp: %s (%.0f KB)", key, size_kb)
        return True

    log.log(logging.DEBUG if quiet else logging.INFO, "  ↑ %s (%.0f KB)", key, size_kb)
    extra_args: dict = {"ContentType": content_type, "Metadata": {"md5": local_md5}}
    if cache_control:
        extra_args["CacheControl"] = cache_control
    if size <= PUT_OBJECT_MAX_BYTES:
        with open(local_path, "rb") as f:
            s3.put_object(Bucket=bucket, Key=key, Body=f, **extra_args)
    else:
        s3.upload_file(str(local_path), bucket, key, ExtraArgs=extra_args)
    return True


def newest_parquet_files(parquet_dir: Path) -> list[Path]:
    """Filer som skal være i manifest/bucket: begge varianter (-by-line/-by-stop)
    for de nyeste KEEP_WEEKS ISO-ukene.

    Ukenavnene ('2026-W27') sorterer riktig leksikalsk, også over årsskifter.
    Grupperer per uke først slik at KEEP_WEEKS teller uker, ikke enkeltfiler
    (hver uke er nå to filer)."""
    files = [f for f in parquet_dir.glob("*.parquet") if f.is_file()]
    by_week: dict[str, list[Path]] = {}
    for f in files:
        week = week_from_filename(f.name)
        if week is None:
            continue  # gammelt enkeltfil-format — ikke last opp, kjør migrate_parquet_sort.py
        by_week.setdefault(week, []).append(f)

    weeks = sorted(by_week.keys())
    if KEEP_WEEKS > 0:
        weeks = weeks[-KEEP_WEEKS:]
    return sorted(f for w in weeks for f in by_week[w])


def max_date_of_file(path: Path) -> str | None:
    """Siste dato i en parquet-fil, lest fra radgruppe-statistikken.

    Leser KUN metadata (min/max per radgruppe), ikke radene — går på
    millisekunder selv for en 70 MB fil. Returnerer None hvis filen mangler
    statistikk for date-kolonnen, slik at manifestet heller utelater feltet
    enn å oppgi noe feil."""
    try:
        import pyarrow.parquet as pq

        md = pq.ParquetFile(path).metadata
        col = md.schema.names.index("date")
        best: str | None = None
        for rg in range(md.num_row_groups):
            stats = md.row_group(rg).column(col).statistics
            if stats is None or stats.max is None:
                continue
            value = str(stats.max)
            if best is None or value > best:
                best = value
        return best
    except Exception as exc:  # noqa: BLE001 — manifestet skal aldri velte på dette
        log.warning("  Kunne ikke lese maxDate fra %s: %s", path.name, exc)
        return None


def generate_manifest(parquet_dir: Path) -> list[dict]:
    """Returner sortert liste over {name, md5, maxDate} for .parquet-filer
    (nyeste KEEP_WEEKS).

    md5 brukes av klienten som cache-buster (?v=md5) slik at nettleseren
    henter fersk fil når innholdet endres, selv om filnavnet er det samme
    (ukefiler overskrives daglig med nye dager).

    maxDate er siste dato i filen. Klienten trenger den for å regne «siste N
    dager» riktig: uten den må den gjette ut fra FILNAVNET og bruke ISO-ukens
    søndag, som kan ligge opptil seks dager etter siste faktiske datadag — og
    da blir vinduet stille for kort (se hooks/use-parquet-query.ts). Feltet er
    valgfritt for klienten, så et gammelt manifest uten det fungerer som før."""
    out: list[dict] = []
    for f in newest_parquet_files(parquet_dir):
        entry: dict = {"name": f.name, "md5": md5_of_file(f)}
        max_date = max_date_of_file(f)
        if max_date:
            entry["maxDate"] = max_date
        out.append(entry)
    return out


def main():
    # Last credentials. Default: r2.env. For reise-siten: sett R2_ENV_FILE=r2.reise.env
    # slik at den nye bøtta brukes uten å røre den gamle demoens r2.env.
    # NB: env-variabler satt i shellet vinner alltid over fil-verdiene
    # (load_env_file overskriver ikke eksisterende os.environ-nøkler).
    env_file = os.environ.get("R2_ENV_FILE", "r2.env")
    load_env_file(REPO_ROOT / env_file)

    parser = argparse.ArgumentParser(description="Last opp Parquet-filer til Cloudflare R2")
    parser.add_argument("--all", action="store_true", help="Tving re-opplasting av alle filer")
    parser.add_argument(
        "--prune",
        action="store_true",
        help="Slett .parquet-filer i bucketen som ikke finnes lokalt (fjerner gamle uker)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Vis hva som ville blitt lastet opp")
    parser.add_argument(
        "--prod-db",
        action="store_true",
        help="Last opp KUN prod-DB (hopp over parquet + manifest)",
    )
    args = parser.parse_args()

    bucket = os.environ.get("R2_BUCKET", "bussforsinkelser-parquet")
    public_url = os.environ.get("R2_PUBLIC_URL", "")

    if args.dry_run:
        log.info("=== DRY RUN — ingen filer lastes opp ===")

    uploaded = 0
    skipped = 0
    manifest: list[dict] = []
    prod_db = REPO_ROOT / "data" / "bussforsinkelser_prod.db"

    # Parquet-URLer versjoneres med ?v=md5 av klienten → innholdet på en gitt
    # URL endres aldri → trygt med lang cache. Manifestet må alltid revalideres.
    PARQUET_CACHE = "public, max-age=31536000, immutable"
    MANIFEST_CACHE = "no-cache"

    if not args.prod_db:
        # ---------- Parquet + manifest ----------
        if not PARQUET_DIR.exists():
            log.error("Parquet-mappe finnes ikke: %s", PARQUET_DIR)
            log.error("Kjør først: python pipeline/export_parquet.py --all")
            return 1

        parquet_files = newest_parquet_files(PARQUET_DIR)
        if not parquet_files:
            log.warning("Ingen .parquet-filer funnet i %s", PARQUET_DIR)
            return 0

        log.info("Kobler til R2 bucket '%s' …", bucket)
        s3 = None if args.dry_run else get_s3_client()

        log.info(
            "Laster opp %d Parquet-fil(er) (nyeste %s uker) …",
            len(parquet_files),
            KEEP_WEEKS if KEEP_WEEKS > 0 else "alle",
        )
        for pf in sorted(parquet_files):
            if args.dry_run:
                log.info("  [dry-run] Ville lastet opp: %s (%.0f KB)", pf.name, pf.stat().st_size / 1024)
                uploaded += 1
            else:
                did_upload = upload_file(
                    s3, bucket, pf, pf.name, force=args.all, cache_control=PARQUET_CACHE
                )
                if did_upload:
                    uploaded += 1
                else:
                    skipped += 1

        # Generer og last opp manifest.json
        manifest = generate_manifest(PARQUET_DIR)
        manifest_path = PARQUET_DIR / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2))

        if args.dry_run:
            log.info("  [dry-run] Ville lastet opp: manifest.json (%d filer)", len(manifest))
        else:
            did_upload = upload_file(
                s3, bucket, manifest_path, "manifest.json",
                force=True, cache_control=MANIFEST_CACHE,
            )
            if did_upload:
                uploaded += 1

        # ---------- Statistikk-artefakter (full offload) ----------
        # Genereres av pipeline/aggregate_stats.py. Alltid no-cache: klienten
        # henter dem med no-store, og innholdet endres hver natt.
        for stats_name in ("stats_summary.json", "stats_stops_map.json", "stats_line_names.json"):
            stats_path = PARQUET_DIR / stats_name
            if not stats_path.exists():
                continue
            if args.dry_run:
                log.info("  [dry-run] Ville lastet opp: %s (%.0f KB)",
                         stats_name, stats_path.stat().st_size / 1024)
            else:
                did_upload = upload_file(
                    s3, bucket, stats_path, stats_name,
                    force=True, cache_control=MANIFEST_CACHE,
                )
                if did_upload:
                    uploaded += 1

        # ---------- Stoppdetaljer (shardet) ----------
        # stops/<shard>.json fra aggregate_stats.py — datagrunnlaget for
        # Stoppanalyse. Se build_stop_detail_shards for hvorfor det shardes.
        #
        # OPS-BUDSJETT (R2 gratis: 1 mill. Class A/mnd): 2000 shards × 30
        # netter = 60 000 skriv/mnd ≈ 6 %. head_object-sjekken under er
        # Class B (10 mill./mnd) og hopper over shards som faktisk er
        # uendret — typisk distrikts-shards uten helgetrafikk. Derfor IKKE
        # force=True her, i motsetning til de tre andre artefaktene.
        #
        # Parallelt (UPLOAD_WORKERS) og stille per fil: én logglinje per 250
        # shards + en oppsummering, ikke 2000 linjer. Sekvensielt tok dette
        # ~17 min, og 2000 logglinjer var det som fylte 4 KB-røret i
        # nightly_reise.ps1 og fikk steget til å «henge» (se der). Feil i én
        # opplasting propagerer via fut.result() og feller hele steget, som
        # før — nightly_reise.ps1 prøver da på nytt, og uendret-sjekken gjør
        # at nytt forsøk hopper over det som allerede kom opp.
        stops_dir = PARQUET_DIR / "stops"
        if stops_dir.is_dir():
            shard_files = sorted(stops_dir.glob("*.json"),
                                 key=lambda p: int(p.stem) if p.stem.isdigit() else -1)
            shard_up = shard_skip = 0
            if args.dry_run:
                shard_up = len(shard_files)
                total_mb = sum(p.stat().st_size for p in shard_files) / 1e6
                log.info("  [dry-run] Ville lastet opp %d shardfiler (%.1f MB)",
                         shard_up, total_mb)
            elif shard_files:
                log.info("Stoppdetaljer: sjekker/laster opp %d shards (%d parallelle) …",
                         len(shard_files), UPLOAD_WORKERS)
                with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as ex:
                    futures = [
                        ex.submit(upload_file, s3, bucket, sp, f"stops/{sp.name}",
                                  False, False, MANIFEST_CACHE, True)
                        for sp in shard_files
                    ]
                    for done, fut in enumerate(as_completed(futures), 1):
                        if fut.result():
                            shard_up += 1
                        else:
                            shard_skip += 1
                        if done % 250 == 0 or done == len(futures):
                            log.info("  stoppdetaljer: %d/%d ferdig (%d lastet opp, %d uendret)",
                                     done, len(futures), shard_up, shard_skip)
                log.info("Stoppdetaljer: %d lastet opp, %d uendret (av %d shards)",
                         shard_up, shard_skip, len(shard_files))
            uploaded += shard_up

        # ---------- Prune: fjern parquet-filer i bucketen som ikke finnes lokalt ----------
        # Hindrer at gamle uker (f.eks. fra en feilaktig opplasting) blir liggende
        # og kan plukkes opp av klienter med gammelt manifest i cache.
        if args.prune:
            local_names = {e["name"] for e in manifest}
            # Shardfiler som ikke finnes lokalt (typisk fordi STATS_STOP_SHARDS
            # er endret, eller en shard er blitt tom). DeleteObject er gratis
            # på R2, så det koster ingenting å rydde.
            local_shards = {f"stops/{p.name}" for p in (PARQUET_DIR / "stops").glob("*.json")} \
                if (PARQUET_DIR / "stops").is_dir() else set()
            stale_keys: list[str] = []
            if not args.dry_run:
                paginator = s3.get_paginator("list_objects_v2")
                for page in paginator.paginate(Bucket=bucket):
                    for obj in page.get("Contents", []):
                        key = obj["Key"]
                        if key.endswith(".parquet") and key not in local_names:
                            stale_keys.append(key)
                        elif key.startswith("stops/") and local_shards and key not in local_shards:
                            stale_keys.append(key)
                for key in stale_keys:
                    log.info("  ✂ Sletter fra bucket: %s", key)
                    s3.delete_object(Bucket=bucket, Key=key)
            else:
                log.info("  [dry-run] Ville slettet parquet-filer som ikke finnes lokalt")
            if stale_keys:
                log.info("Prune: %d gamle filer slettet", len(stale_keys))
            elif not args.dry_run:
                log.info("Prune: ingen gamle filer å slette")
    else:
        # ---------- Kun prod-DB-modus ----------
        log.info("=== KUN PROD-DB — hopper over parquet + manifest ===")
        log.info("Kobler til R2 bucket '%s' …", bucket)
        s3 = None if args.dry_run else get_s3_client()

    # ---------- Prod-DB (hopp over når vi kjører med reise-env) ----------
    # Reise-bøtta trenger bare parquet + manifest, ikke den tunge prod-DBen.
    skip_prod_db = (env_file != "r2.env") and not args.prod_db
    if skip_prod_db:
        log.info("Hopper over prod-DB (bruker %s, ikke r2.env)", env_file)
    elif prod_db.exists():
        log.info("Laster opp prod-database …")
        if args.dry_run:
            log.info("  [dry-run] Ville lastet opp: bussforsinkelser_prod.db (%.0f MB)", prod_db.stat().st_size / 1024 / 1024)
        else:
            # I --prod-db-modus tvinger vi alltid opp prod-DB siden det er hele poenget
            force_prod = args.all or args.prod_db
            did_upload = upload_file(s3, bucket, prod_db, "bussforsinkelser_prod.db", force=force_prod)
            if did_upload:
                uploaded += 1
            else:
                skipped += 1
    elif not skip_prod_db:
        log.warning("Prod-DB ikke funnet (%s) — kjør strip_for_prod.py først", prod_db)
        if args.prod_db:
            return 1

    log.info("")
    log.info("Ferdig: %d lastet opp, %d uendret/hoppet over", uploaded, skipped)
    if public_url:
        log.info("Public URL: %s", public_url)
        if not args.prod_db:
            log.info(
                "Parquet-eksempel: %s/%s",
                public_url,
                manifest[0]["name"] if manifest else "<ingen filer>",
            )
        if prod_db.exists() and not skip_prod_db:
            log.info("Prod-DB URL:      %s/bussforsinkelser_prod.db", public_url)


if __name__ == "__main__":
    main()
