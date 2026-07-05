# =============================================================================
# Backfill EN UKE for reise-pipelinen, deretter export + upload.
#
#   .\scripts\backfill_week_reise.ps1 -From 2026-06-08
#
# Ingester 7 dager fra og med -From (eldste forst), eksporterer ukefilene og
# laster dem opp. Pruning hoppes automatisk over for dager utenfor
# retention-vinduet (backfill-modus i ingest_lite) - neste nattlige kjoring
# rydder, og da ligger ukene trygt som Parquet pa R2.
#
# BigQuery-budsjett: en dag = 1-5 GB scan -> en uke = 10-35 GB. Free tier er
# 1 TB/mnd, sa en uke per dag er helt ufarlig.
# =============================================================================
param(
    [Parameter(Mandatory = $true, HelpMessage = "Forste dag i uken (YYYY-MM-DD)")]
    [string]$From
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$env:DATABASE_PATH = "data/reise.db"
$env:PARQUET_DIR   = "data/reise-parquet"
$env:R2_ENV_FILE   = "r2.reise.env"

$start = [datetime]$From
for ($i = 0; $i -lt 7; $i++) {
    $d = $start.AddDays($i).ToString("yyyy-MM-dd")
    Write-Host "=== Ingest $d ===" -ForegroundColor Cyan
    python pipeline/ingest_lite.py $d
    if ($LASTEXITCODE -ne 0) { throw "ingest_lite.py feilet pa $d (exit $LASTEXITCODE)" }
}

Write-Host "=== Eksporterer parquet ===" -ForegroundColor Cyan
python pipeline/export_parquet.py
if ($LASTEXITCODE -ne 0) { throw "export_parquet.py feilet (exit $LASTEXITCODE)" }

Write-Host "=== Laster opp til R2 ===" -ForegroundColor Cyan
python pipeline/upload_to_r2.py
if ($LASTEXITCODE -ne 0) { throw "upload_to_r2.py feilet (exit $LASTEXITCODE)" }

Write-Host ("=== Backfill {0}..{1} OK ===" -f $From, $start.AddDays(6).ToString("yyyy-MM-dd")) -ForegroundColor Green
