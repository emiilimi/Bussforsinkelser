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
# Hvert steg har en hard tidsgrense (se Invoke-PythonStep). Bakgrunn (6.-7.
# juli 2026, tre separate hendelser samme uke):
#  1. PC-en sov midt i en kjoring -> prosessen hang uoppdaget i 16+ timer.
#  2. Et forsok pa a legge til en enkel watchdog (Start-Process -PassThru +
#     $proc.WaitForExit(millisekunder)) viste seg upalitelig - fristen ble
#     ikke respektert i praksis.
#  3. En pol-lokke-variant fungerte for a drepe hengte prosesser, MEN brukte
#     en parameter kalt "$Args" (kolliderer med PowerShells reserverte
#     automatiske $args-variabel -> et eksplisitt datoargument ble stille
#     droppet), OG leste $proc.ExitCode rett etter HasExited ble true, som
#     kan vaere usynkronisert (ekte suksess ble rapportert som feil).
# Losningen na bruker System.Diagnostics.Process direkte (ikke Start-Process-
# cmdleten) - bade argument-videreforing og ExitCode er verifisert palitelige
# med denne fremgangsmaten (se commit-historikk for testene som bekreftet det).
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
        [string[]]$ExtraArgs = @(),
        [int]$TimeoutMinutes
    )
    $allArgs = @($ScriptPath) + $ExtraArgs
    # Manuell quoting: ProcessStartInfo.Arguments er en enkel streng (ikke en
    # liste) i .NET Framework/Windows PowerShell 5.1 - ArgumentList-samlingen
    # er ikke initialisert der.
    $quoted = ($allArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "python"
    $psi.Arguments = $quoted
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $killed = $false
    while (-not $proc.HasExited) {
        if ((Get-Date) -gt $deadline) {
            $proc.Kill()
            $killed = $true
            break
        }
        Start-Sleep -Seconds 15
    }

    # ReadToEnd() blokkerer til strømmen er lukket (dvs. til prosessen er
    # avsluttet/drept) - trygt å kalle her i begge tilfeller.
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    if ($stdout) { Write-Host $stdout }
    if ($stderr) { Write-Host $stderr }

    if ($killed) {
        throw "$ScriptPath hang lenger enn $TimeoutMinutes min (drept). Sjekk output over og om PC-en sov/ble avbrutt midt i kjøringen."
    }
    if ($proc.ExitCode -ne 0) {
        throw "$ScriptPath feilet (exit $($proc.ExitCode))"
    }
}

New-Item -ItemType Directory -Force -Path "logs" | Out-Null
Start-Transcript -Path ("logs/reise-{0}.log" -f (Get-Date -Format "yyyy-MM-dd")) -Append

try {
    Write-Host ("=== Reise nightly: {0} ===" -f (Get-Date -Format "yyyy-MM-dd HH:mm")) -ForegroundColor Cyan

    # Frister med god margin over observert varighet. Tallene under er malt fra
    # loggene (august 2026), ikke gjettet:
    #   ingest    ~10-25 min   (BigQuery-henting + skriving)
    #   export    ~2-5 min
    #   aggregate ~13-14 min   (454-842 s malt over atte kjoringer)
    #   upload    ~2-3 min
    #
    # 12. august 2026: aggregate-steget ble DREPT pa 15 min. Det hang ikke - det
    # holdt pa (stats_stops_map.json ble ferdig 11:54), men steget hadde vokst
    # forbi fristen. Kommentaren her sa "aggregate ~1 min", som aldri stemte med
    # loggene: steget har ligget rundt 800 s i ukevis, altsa under ett minutt fra
    # a ryke hver eneste natt. Datasettet vokser, sa fristen ma ha ekte slingring.
    Invoke-PythonStep -ScriptPath "pipeline/ingest_lite.py" -TimeoutMinutes 90
    Invoke-PythonStep -ScriptPath "pipeline/export_parquet.py" -TimeoutMinutes 30
    Invoke-PythonStep -ScriptPath "pipeline/aggregate_stats.py" -TimeoutMinutes 45
    Invoke-PythonStep -ScriptPath "pipeline/upload_to_r2.py" -ExtraArgs @("--prune") -TimeoutMinutes 20

    Write-Host "=== Reise nightly OK ===" -ForegroundColor Green
}
finally {
    Stop-Transcript
}
