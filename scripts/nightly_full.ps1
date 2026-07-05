# =============================================================================
# Nattlig FULL pipeline (bussforsinkelser.no-demoen)
#
#   BigQuery (garsdagen, kun SKY som for)
#     -> data/bussforsinkelser.db  (alle aggregat-tabeller + journey_stop_daily)
#     -> data/parquet/             (ukefiler for den GAMLE botta)
#     -> R2-bucket bussforsinkelser-parquet (r2.env)
#
# MERK 1: Denne basen har UBEGRENSET vekst i aggregat-tabellene (i motsetning
#         til reise-basen). Se REISE.md / full offload for planen videre.
# MERK 2: Prod-DB (Railway) oppdateres IKKE her - det er en 21+ GB kopi og
#         opplasting. Kjor ved behov (f.eks. ukentlig, manuelt):
#             python pipeline/strip_for_prod.py
#             python pipeline/upload_to_r2.py --prod-db
#         Krever ~22 GB ledig disk til kopien.
#
# Kjores av Task Scheduler (se scripts/register_tasks.ps1) eller manuelt:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/nightly_full.ps1
#
# Logger til logs/full-YYYY-MM-DD.log
# =============================================================================
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# Defaults brukes med vilje: DATABASE_PATH=data/bussforsinkelser.db,
# PARQUET_DIR=data/parquet, R2_ENV_FILE=r2.env, BQ_OPERATOR=SKY.
Remove-Item Env:DATABASE_PATH, Env:PARQUET_DIR, Env:R2_ENV_FILE -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path "logs" | Out-Null
Start-Transcript -Path ("logs/full-{0}.log" -f (Get-Date -Format "yyyy-MM-dd")) -Append

try {
    Write-Host ("=== Full nightly: {0} ===" -f (Get-Date -Format "yyyy-MM-dd HH:mm")) -ForegroundColor Cyan

    python pipeline/ingest.py
    if ($LASTEXITCODE -ne 0) { throw "ingest.py feilet (exit $LASTEXITCODE)" }

    python pipeline/export_parquet.py
    if ($LASTEXITCODE -ne 0) { throw "export_parquet.py feilet (exit $LASTEXITCODE)" }

    python pipeline/upload_to_r2.py
    if ($LASTEXITCODE -ne 0) { throw "upload_to_r2.py feilet (exit $LASTEXITCODE)" }

    Write-Host "=== Full nightly OK ===" -ForegroundColor Green
}
finally {
    Stop-Transcript
}
