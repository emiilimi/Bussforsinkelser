# =============================================================================
# Nattlig reise-pipeline (reise.emoldestad.no)
#
#   BigQuery (garsdagen, alle operatorer)
#     -> data/reise.db          (SQLite-mellomlager, 14 dagers vindu + VACUUM)
#     -> data/reise-parquet/    (ukefiler; innevarende + garsdagens uke)
#     -> R2-bucket reise-parquet (manifest med md5; --prune sletter uker > 14)
#
# Kjores av Task Scheduler (se scripts/register_tasks.ps1) eller manuelt:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/nightly_reise.ps1
#
# Logger til logs/reise-YYYY-MM-DD.log
# =============================================================================
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$env:DATABASE_PATH = "data/reise.db"
$env:PARQUET_DIR   = "data/reise-parquet"
$env:R2_ENV_FILE   = "r2.reise.env"
# $env:JSD_RETENTION_DAYS = "14"    # default; hev midlertidig ved behov
# $env:PARQUET_KEEP_WEEKS = "14"    # default; antall uker i manifest/bucket

New-Item -ItemType Directory -Force -Path "logs" | Out-Null
Start-Transcript -Path ("logs/reise-{0}.log" -f (Get-Date -Format "yyyy-MM-dd")) -Append

try {
    Write-Host ("=== Reise nightly: {0} ===" -f (Get-Date -Format "yyyy-MM-dd HH:mm")) -ForegroundColor Cyan

    python pipeline/ingest_lite.py
    if ($LASTEXITCODE -ne 0) { throw "ingest_lite.py feilet (exit $LASTEXITCODE)" }

    python pipeline/export_parquet.py
    if ($LASTEXITCODE -ne 0) { throw "export_parquet.py feilet (exit $LASTEXITCODE)" }

    python pipeline/upload_to_r2.py --prune
    if ($LASTEXITCODE -ne 0) { throw "upload_to_r2.py feilet (exit $LASTEXITCODE)" }

    Write-Host "=== Reise nightly OK ===" -ForegroundColor Green
}
finally {
    Stop-Transcript
}
