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

# Tidsbudsjett for HELE kjoringen, inkludert nye forsok. Task Scheduler dreper
# oppgaven ved ExecutionTimeLimit (se register_tasks.ps1); starter vi et nytt
# forsok rett for den grensa, blir vi drept midt i steget i stedet for a
# avslutte ryddig med en logg som forklarer hva som skjedde. Derfor startes et
# nytt forsok bare hvis BADE ventetiden og hele neste forsok far plass.
$script:RunStarted = Get-Date
$script:RetryBudgetMinutes = 300

function Invoke-PythonStepOnce {
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

<#
.SYNOPSIS
Kjor et pipeline-steg, med nye forsok ved feil.

.DESCRIPTION
Bakgrunn (12. august 2026): nattjobben feilet to ganger samme dogn - forst
hang ingest_lite.py i en socket-lesing (PC-en sov trolig midt i
BigQuery-hentingen), deretter ble aggregate_stats.py drept pa en for kort
frist. Begge ville blitt reddet av et nytt forsok; begge krevde i stedet
manuell opprydding.

RestartCount/RestartInterval pa selve Task Scheduler-oppgaven hjelper IKKE
her: den gjelder uventet terminering, ikke et skript som avslutter med
exitkode 1 slik dette gjor. Derfor ma gjentakelsen ligge her, i skriptet.

Bade "drept pa frist" og "exit != 0" regnes som feil verdt a prove pa nytt.
Det dekker de tre feiltypene vi faktisk har sett: hang, for kort frist, og
vaktbikkja i ingest_lite.py som avbryter fordi BigQuery ikke har landet
gardagens data enda (der hjelper det a vente og prove igjen).
#>
function Invoke-PythonStep {
    param(
        [string]$ScriptPath,
        [string[]]$ExtraArgs = @(),
        [int]$TimeoutMinutes,
        [int]$Retries = 0,
        [int]$RetryDelayMinutes = 10
    )
    $attempt = 0
    while ($true) {
        try {
            Invoke-PythonStepOnce -ScriptPath $ScriptPath -ExtraArgs $ExtraArgs -TimeoutMinutes $TimeoutMinutes
            if ($attempt -gt 0) {
                Write-Host ("  [retry] {0} gikk gjennom pa forsok {1}." -f $ScriptPath, ($attempt + 1)) -ForegroundColor Green
            }
            return
        }
        catch {
            $attempt++
            $message = $_.Exception.Message
            if ($attempt -gt $Retries) { throw }

            # Ma bade ventetiden OG hele neste forsok fa plass i budsjettet.
            $elapsed = ((Get-Date) - $script:RunStarted).TotalMinutes
            $needed = $RetryDelayMinutes + $TimeoutMinutes
            if (($elapsed + $needed) -ge $script:RetryBudgetMinutes) {
                throw ("{0} feilet, og det er ikke rom for et nytt forsok innenfor tidsbudsjettet ({1} min brukt av {2}). Opprinnelig feil: {3}" -f `
                    $ScriptPath, [int]$elapsed, $script:RetryBudgetMinutes, $message)
            }

            Write-Host ("  [retry] {0} feilet (forsok {1} av {2}): {3}" -f `
                $ScriptPath, $attempt, ($Retries + 1), $message) -ForegroundColor Yellow
            Write-Host ("  [retry] Venter {0} min for nytt forsok ..." -f $RetryDelayMinutes) -ForegroundColor Yellow
            Start-Sleep -Seconds ($RetryDelayMinutes * 60)
        }
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
    # Ingest far lengst ventetid: nar den feiler er det som regel enten fordi
    # BigQuery ikke har landet gardagens data enda (da hjelper det a vente),
    # eller fordi forbindelsen dode mens PC-en sov (da hjelper det a prove pa
    # nytt). De tre siste stegene feiler stort sett forbigaende, sa der holder
    # det med ett raskt nytt forsok.
    Invoke-PythonStep -ScriptPath "pipeline/ingest_lite.py" -TimeoutMinutes 90 -Retries 2 -RetryDelayMinutes 20
    Invoke-PythonStep -ScriptPath "pipeline/export_parquet.py" -TimeoutMinutes 30 -Retries 1 -RetryDelayMinutes 5
    # aggregate_stats: 45 -> 90 min (2026-08-29). Steget brukte tidligere
    # ~8-10 min, men stoppdetalj-shardingen (2000 filer, ~434 MB) tar alene
    # ~28 min, og operatorlista har vokst (AVI/BFO/TEL: 1,84 mill. rader mot
    # ~1,2 mill.). Malt 29. august: steget ble drept pa 45 min BEGGE forsok,
    # begge ganger bare noen minutter fra a bli ferdig - og siden opplastingen
    # kommer etterpa, ble R2 staende to dogn bak selv om ingesten var vellykket.
    Invoke-PythonStep -ScriptPath "pipeline/aggregate_stats.py" -TimeoutMinutes 90 -Retries 1 -RetryDelayMinutes 5
    # Opplastingen har ogsa fatt mer a gjore: 2000 shardfiler i tillegg til
    # ukefilene og stats_*.json.
    Invoke-PythonStep -ScriptPath "pipeline/upload_to_r2.py" -ExtraArgs @("--prune") -TimeoutMinutes 40 -Retries 2 -RetryDelayMinutes 5

    Write-Host "=== Reise nightly OK ===" -ForegroundColor Green
}
finally {
    Stop-Transcript
}
