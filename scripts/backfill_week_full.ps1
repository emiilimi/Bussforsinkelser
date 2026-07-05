# =============================================================================
# Backfill EN UKE for den FULLE pipelinen (bussforsinkelser.db), deretter
# export + upload til den gamle botta.
#
#   .\scripts\backfill_week_full.ps1 -From 2026-06-08
#
# Bruker pipeline/ingest.py (alle aggregat-tabeller oppdateres per dag).
# For perioder over ~2 uker: bruk heller pipeline/backfill.py som batcher
# BigQuery-scan maned-for-maned (billigere).
# =============================================================================
param(
    [Parameter(Mandatory = $true, HelpMessage = "Forste dag i uken (YYYY-MM-DD)")]
    [string]$From
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# Defaults brukes med vilje (bussforsinkelser.db, data/parquet, r2.env, SKY)
Remove-Item Env:DATABASE_PATH, Env:PARQUET_DIR, Env:R2_ENV_FILE -ErrorAction SilentlyContinue

$start = [datetime]$From
for ($i = 0; $i -lt 7; $i++) {
    $d = $start.AddDays($i).ToString("yyyy-MM-dd")
    Write-Host "=== Ingest $d ===" -ForegroundColor Cyan
    python pipeline/ingest.py $d
    if ($LASTEXITCODE -ne 0) { throw "ingest.py feilet pa $d (exit $LASTEXITCODE)" }
}

Write-Host "=== Eksporterer parquet ===" -ForegroundColor Cyan
python pipeline/export_parquet.py
if ($LASTEXITCODE -ne 0) { throw "export_parquet.py feilet (exit $LASTEXITCODE)" }

Write-Host "=== Laster opp til R2 (gammel botte) ===" -ForegroundColor Cyan
python pipeline/upload_to_r2.py
if ($LASTEXITCODE -ne 0) { throw "upload_to_r2.py feilet (exit $LASTEXITCODE)" }

Write-Host ("=== Backfill {0}..{1} OK ===" -f $From, $start.AddDays(6).ToString("yyyy-MM-dd")) -ForegroundColor Green
