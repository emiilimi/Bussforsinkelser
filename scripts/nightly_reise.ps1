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
#
# Hvert steg har en hard tidsgrense (se Invoke-PythonStep): hvis PC-en sover/
# lukkes midt i et steg og prosessen henger uoppdaget etter oppvakning, feiler
# jobben tydelig innen fristen i stedet for a sta stille resten av natten
# (skjedde 6.-7. juli 2026 - ingen loggmelding pa 16+ timer).
# =============================================================================
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$env:DATABASE_PATH = "data/reise.db"
$env:PARQUET_DIR   = "data/reise-parquet"
$env:R2_ENV_FILE   = "r2.reise.env"
# $env:JSD_RETENTION_DAYS = "14"    # default; hev midlertidig ved behov
# $env:PARQUET_KEEP_WEEKS = "14"    # default; antall uker i manifest/bucket

function Invoke-PythonStep {
    param(
        [string]$ScriptPath,
        [string[]]$Args = @(),
        [int]$TimeoutMinutes
    )
    $stdout = [System.IO.Path]::GetTempFileName()
    $stderr = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath "python" -ArgumentList (@($ScriptPath) + $Args) `
            -NoNewWindow -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $finished = $proc.WaitForExit($TimeoutMinutes * 60 * 1000)
        if (-not $finished) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            Get-Content $stdout, $stderr -ErrorAction SilentlyContinue | Write-Host
            throw "$ScriptPath hang lenger enn $TimeoutMinutes min (drept) - se output over. Sjekk om PC-en sov midt i kjoringen."
        }
        Get-Content $stdout, $stderr -ErrorAction SilentlyContinue | Write-Host
        if ($proc.ExitCode -ne 0) {
            throw "$ScriptPath feilet (exit $($proc.ExitCode))"
        }
    }
    finally {
        Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
    }
}

New-Item -ItemType Directory -Force -Path "logs" | Out-Null
Start-Transcript -Path ("logs/reise-{0}.log" -f (Get-Date -Format "yyyy-MM-dd")) -Append

try {
    Write-Host ("=== Reise nightly: {0} ===" -f (Get-Date -Format "yyyy-MM-dd HH:mm")) -ForegroundColor Cyan

    # Frister med god margin over observert varighet (ingest ~15-35 min,
    # export ~5 min, aggregate ~1 min, upload ~1-2 min avhengig av nett).
    Invoke-PythonStep -ScriptPath "pipeline/ingest_lite.py" -TimeoutMinutes 90
    Invoke-PythonStep -ScriptPath "pipeline/export_parquet.py" -TimeoutMinutes 30
    Invoke-PythonStep -ScriptPath "pipeline/aggregate_stats.py" -TimeoutMinutes 15
    Invoke-PythonStep -ScriptPath "pipeline/upload_to_r2.py" -Args @("--prune") -TimeoutMinutes 20

    Write-Host "=== Reise nightly OK ===" -ForegroundColor Green
}
finally {
    Stop-Transcript
}
