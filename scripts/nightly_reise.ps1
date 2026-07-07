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
# Hvert steg har en hard tidsgrense (se Invoke-PythonStep): hvis noe henger
# uoppdaget (skjedde 6.-7. juli 2026 - to separate hendelser, en etter at PC-en
# sov midt i kjoringen og en uten kjent arsak), feiler jobben tydelig innen
# fristen i stedet for a sta stille i timevis. Bruker en manuell poll-lokke
# (HasExited + Get-Date) i stedet for $proc.WaitForExit(timeout) - sistnevnte
# viste seg upalitelig i praksis (fristen pa 90 min ble ikke respektert 7. juli).
# Output fra det kjorende steget strommes til transcript-loggen underveis
# (ikke bare ved slutt), sa et fremtidig heng viser SISTE linje steget
# rakk a skrive, ikke bare stillhet.
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
    $linesShown = 0
    try {
        $proc = Start-Process -FilePath "python" -ArgumentList (@($ScriptPath) + $Args) `
            -NoNewWindow -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr

        $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
        while (-not $proc.HasExited) {
            # Strøm nye linjer fortløpende (ikke bare ved slutt) slik at et
            # fremtidig heng viser hvor langt steget kom, ikke bare stillhet.
            $all = @(Get-Content $stdout, $stderr -ErrorAction SilentlyContinue)
            if ($all.Count -gt $linesShown) {
                $all[$linesShown..($all.Count - 1)] | Write-Host
                $linesShown = $all.Count
            }
            if ((Get-Date) -gt $deadline) {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                throw "$ScriptPath hang lenger enn $TimeoutMinutes min (drept). Sjekk siste linje over og om PC-en sov/ble avbrutt midt i kjoringen."
            }
            Start-Sleep -Seconds 15
        }

        $all = @(Get-Content $stdout, $stderr -ErrorAction SilentlyContinue)
        if ($all.Count -gt $linesShown) {
            $all[$linesShown..($all.Count - 1)] | Write-Host
        }
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

    # Frister med god margin over observert varighet (ingest ~15-35 min normalt,
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
