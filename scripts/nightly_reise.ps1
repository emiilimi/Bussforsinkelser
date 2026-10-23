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
# -DryRun: vis hvilke dager og uker jobben ville tatt, og avslutt. En jobb som
# kjorer en gang i dognet er ellers nesten umulig a ove pa - og det er nettopp
# de sjeldne grenene (hull lenger tilbake, eldre uke som ma re-eksporteres) man
# helst vil ha sett virke for natten de trengs. Skriver ikke til logs/.
param([switch]$DryRun)

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

# Etterfylling av eldre hull er "best effort" og ma vike for kveldens egen dag.
# Naar sa mye tid er brukt, hoppes gjenstaende hull over og tas natten etter -
# de ligger uansett i vinduet i flere dager til.
#
# Budsjettet LESES fra oppgavens egen ExecutionTimeLimit i stedet for a
# hardkodes. Bakgrunn: i september ble 150 min satt ut fra at grensa var 6 t
# (slik register_tasks.ps1 sier) - den registrerte oppgaven hadde 3 t. Rettet
# til 60 min 15.09, men da ble det feil igjen i det oppgaven fikk 6 t.
# Reserve 120 min: en ingest til (~20-42 min, malt oktober 2026) og halen
# (export ~5-16, aggregate ~22-90, upload ~3-10). 3 t -> 60 min, 6 t -> 240.
# Kjores skriptet manuelt (ingen oppgave a lese), brukes 3 t-verdien.
$script:CatchUpDeadlineMinutes = 60
try {
    $limit = (Get-ScheduledTask -TaskName 'Bussforsinkelser Reise nightly' -ErrorAction Stop).Settings.ExecutionTimeLimit
    if ($limit) {
        $limitMin = [System.Xml.XmlConvert]::ToTimeSpan($limit).TotalMinutes
        $script:CatchUpDeadlineMinutes = [int][Math]::Max(30, $limitMin - 120)
    }
}
catch { }

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

    # Tom BEGGE rorene fortlopende, i bakgrunnen, fra forste sekund.
    #
    # Bakgrunn (31. august 2026): upload_to_r2.py "hang" 40 min og ble drept
    # tre ganger pa rad - hver gang etter NOYAKTIG 32 shardfiler. Det var
    # ingen henging: et omdirigert stdout/stderr er et ror med ~4 KB buffer,
    # og forrige versjon leste det forst ETTER at barnet hadde avsluttet.
    # Nar barnet har skrevet 4 KB uten at noen leser, blokkerer neste
    # write() for alltid -> barnet venter pa oss, vi venter pa barnet.
    # Reprodusert 2026-09-02: et barn som skriver 200 logglinjer til stderr
    # ble drept pa fristen med 4094 byte mottatt; 40 linjer gikk pa 1 s.
    # Stegene som gikk bra (ingest, export, aggregate) logger under 4 KB;
    # opplastingen begynte a logge 2000+ linjer da stoppdetalj-shardene kom
    # 27. august - derfor traff dette akkurat da.
    #
    # ReadToEndAsync leser kontinuerlig pa en tradpool-trad, sa roret aldri
    # fylles. .Result under blokkerer til roret lukkes (barnet avsluttet
    # eller drept) og gir hele teksten - ogsa det som rakk a komme for et
    # eventuelt drap, som for.
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $killed = $false
    while (-not $proc.HasExited) {
        if ((Get-Date) -gt $deadline) {
            try { $proc.Kill() } catch { }   # kan allerede ha avsluttet i mellomtiden
            $killed = $true
            break
        }
        Start-Sleep -Seconds 15
    }
    $proc.WaitForExit()                       # sikrer at rorene er lukket for .Result

    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
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

<#
.SYNOPSIS
Kjor et python-skript og returner linjene det skrev til stdout.

.DESCRIPTION
Som Invoke-PythonStepOnce, men stdout returneres i stedet for a bare logges -
brukes for hjelpere som svarer med data (missing_dates.py). Rorene tommes
fortlopende av samme grunn som der: et omdirigert ror har ~4 KB buffer, og
leser vi det forst etter at barnet har avsluttet, blokkerer et barn som skriver
mer enn det for alltid (se kommentaren i Invoke-PythonStepOnce).
#>
function Get-PythonOutput {
    param(
        [string]$ScriptPath,
        [string[]]$ExtraArgs = @(),
        [int]$TimeoutMinutes = 5
    )
    $allArgs = @($ScriptPath) + $ExtraArgs
    $quoted = ($allArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "python"
    $psi.Arguments = $quoted
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $killed = $false
    while (-not $proc.HasExited) {
        if ((Get-Date) -gt $deadline) {
            try { $proc.Kill() } catch { }
            $killed = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    $proc.WaitForExit()

    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    if ($stderr) { Write-Host $stderr }

    if ($killed) { throw "$ScriptPath hang lenger enn $TimeoutMinutes min (drept)." }
    if ($proc.ExitCode -ne 0) { throw "$ScriptPath feilet (exit $($proc.ExitCode))" }

    return @($stdout -split "`r?`n" | Where-Object { $_ -and $_.Trim() })
}

<#
.SYNOPSIS
Hvilke dager mangler i basen, nyeste forst.

.DESCRIPTION
Normalt er svaret "bare i gar". Men to ganger i lopet av to uker ble en dag
aldri hentet, og ingen oppdaget det:

  27. august 2026: BigQuery-forbindelsen rok, steget ble drept pa fristen, og
    retry-budsjettet var brukt opp.
  5. september 2026: PC-en sov gjennom 06:00-kjoringen. Task Scheduler startet
    jobben ved oppvakning, sa NumberOfMissedRuns forble 0 - men ingest_lite.py
    uten argument tar KUN gardagen, sa 4. september ble hoppet over.

I begge tilfellene var hullet stille og permanent: ingenting sammenlikner basen
mot kalenderen, og eneste spor var en manglende logg i logs/. Etter 14 dager er
dagen ute av BigQuery-vinduet vart og kan ikke hentes i det hele tatt.

Ved feil faller vi tilbake til gardagen, slik at en hjelper som ikke virker
aldri stopper den normale nattjobben.
#>
function Resolve-DatesToIngest {
    try {
        $lines = Get-PythonOutput -ScriptPath "pipeline/missing_dates.py"
        return @($lines | ForEach-Object {
            $parts = $_ -split "`t"
            [PSCustomObject]@{ Date = $parts[0].Trim(); Week = $parts[1].Trim() }
        })
    }
    catch {
        Write-Host ("  [catch-up] missing_dates.py feilet ({0}). Faller tilbake til gardagen." -f $_.Exception.Message) -ForegroundColor Yellow
        $y = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
        return @([PSCustomObject]@{ Date = $y; Week = $null })
    }
}

New-Item -ItemType Directory -Force -Path "logs" | Out-Null
if (-not $DryRun) {
    Start-Transcript -Path ("logs/reise-{0}.log" -f (Get-Date -Format "yyyy-MM-dd")) -Append
}

# Hold PC-en vaken mens jobben kjorer. Hvilemodus midt i et steg har kostet
# kjoringer gjentatte ganger (6.-7. juli, 15.09, 22.10): watchdogen star stille
# mens maskinen sover, steget "henger" i timevis, og ved oppvakning er
# tidsbudsjettet brukt opp. 22.10 kveld: stoppdetaljene ferdige 21:13, deretter
# 11 timer stille. SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
# hindrer AUTOMATISK hvilemodus til vi slipper i finally - ikke lukket lokk
# eller av-knapp. Feiler kallet, kjorer jobben videre som for.
$script:KeepAwake = $false
if (-not $DryRun) {
    try {
        Add-Type -Namespace SenTur -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);' -ErrorAction Stop
        # 2147483649 = ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1)
        $script:KeepAwake = ([SenTur.Power]::SetThreadExecutionState([uint32]2147483649) -ne 0)
        Write-Host ("  Holder maskinen vaken under kjoringen: {0}" -f $script:KeepAwake)
    }
    catch {
        Write-Host ("  Klarte ikke a holde maskinen vaken ({0}) - kjorer videre." -f $_.Exception.Message) -ForegroundColor Yellow
    }
}

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
    $yesterday = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
    # @(...) er ikke pynt: PowerShell pakker ut et ettelements-array ved return,
    # og da finnes ikke .Count (teller ble tom i loggen for dette).
    $dates = @(Resolve-DatesToIngest)

    # Rekkefolge: gardagen forst (nattens egentlige oppgave), deretter ELDSTE
    # hull forst. Malt 13.-20. oktober 2026: ingest tar na ~20-42 min per dag,
    # sa etterfyllingsbudsjettet rekker bare EN ekstra dag per natt. Med
    # nyeste-forst ble 2026-10-14 skjovet bakerst seks netter pa rad og var
    # en natt fra a falle ut av 7-dagersvinduet for godt. Det eldste hullet er
    # det som er narmest a forsvinne; de nyere har flere netter igjen.
    $primary = @($dates | Where-Object { $_.Date -eq $yesterday })
    $older = @($dates | Where-Object { $_.Date -ne $yesterday } | Sort-Object Date)
    $dates = @($primary + $older)
    if ($dates.Count -eq 0) {
        Write-Host "  Ingen manglende dager - hopper over ingest (basen er ajour)." -ForegroundColor Green
    }
    else {
        Write-Host ("  Skal hente {0} dag(er): {1}" -f $dates.Count, (($dates | ForEach-Object { $_.Date }) -join ", "))
    }

    if ($DryRun) {
        try { $auto = @(Get-PythonOutput -ScriptPath "pipeline/missing_dates.py" -ExtraArgs @("--refresh-weeks")) }
        catch { $auto = @() }
        Write-Host ""
        Write-Host "  [dry-run] Ville hentet, i denne rekkefolgen:" -ForegroundColor Cyan
        if ($dates.Count -eq 0) { Write-Host "    (ingenting - basen er ajour)" }
        foreach ($d in $dates) {
            $rolle = if ($d.Date -eq $yesterday) { "gardagen (kritisk)" } else { "etterfylling (best effort)" }
            Write-Host ("    {0}  {1}  {2}" -f $d.Date, $d.Week, $rolle)
        }
        $eksplisitt = @($dates | Where-Object { $_.Week -and ($auto -notcontains $_.Week) } | ForEach-Object { $_.Week } | Sort-Object -Unique)
        Write-Host ("  [dry-run] Eksporten uten argument dekker: {0}" -f (($auto -join ", "), "(ingen)")[[int]($auto.Count -eq 0)])
        Write-Host ("  [dry-run] Ville i tillegg bedt om --week: {0}" -f (($eksplisitt -join ", "), "(ingen)")[[int]($eksplisitt.Count -eq 0)])
        Write-Host "  [dry-run] Stopper her - ingenting er hentet, skrevet eller lastet opp." -ForegroundColor Cyan
        return
    }

    $extraWeeks = @{}
    foreach ($d in $dates) {
        $isPrimary = ($d.Date -eq $yesterday)
        if (-not $isPrimary) {
            $elapsed = ((Get-Date) - $script:RunStarted).TotalMinutes
            if ($elapsed -ge $script:CatchUpDeadlineMinutes) {
                Write-Host ("  [catch-up] Hopper over {0} og resten: {1} min brukt av {2}. Tas natten etter." -f `
                    $d.Date, [int]$elapsed, $script:CatchUpDeadlineMinutes) -ForegroundColor Yellow
                break
            }
        }
        try {
            Invoke-PythonStep -ScriptPath "pipeline/ingest_lite.py" -ExtraArgs @($d.Date) -TimeoutMinutes 90 -Retries 2 -RetryDelayMinutes 20
        }
        catch {
            # Gardagen er jobbens egentlige oppgave: feiler den, feiler natten,
            # som for. Et eldre hull er best effort - det ligger i vinduet noen
            # dager til, sa vi logger og gar videre i stedet for a velte resten
            # av kjoringen (og dermed ogsa gardagen, som alt er hentet).
            if ($isPrimary) { throw }
            Write-Host ("  [catch-up] {0} feilet: {1}. Proves pa nytt neste natt." -f `
                $d.Date, $_.Exception.Message) -ForegroundColor Yellow
            continue
        }
        if ($d.Week) { $extraWeeks[$d.Week] = $true }
    }

    Invoke-PythonStep -ScriptPath "pipeline/export_parquet.py" -TimeoutMinutes 30 -Retries 1 -RetryDelayMinutes 5

    # Eksporten uten argument friskner bare opp inneverende uke og gardagens
    # uke. Et hull lenger tilbake kan ligge i en eldre uke som alt er
    # eksportert - den ma bes om eksplisitt, ellers blir de nye radene liggende
    # i basen uten a na parquet (og dermed hverken kart, linjeanalyse eller
    # aggregatene). Fila verner selv mot a bli skrevet med faerre dager enn den
    # allerede dekker, sa en overflodig runde her er ufarlig.
    if ($extraWeeks.Count -gt 0) {
        try { $autoWeeks = @(Get-PythonOutput -ScriptPath "pipeline/missing_dates.py" -ExtraArgs @("--refresh-weeks")) }
        catch { $autoWeeks = @() }
        foreach ($w in @($extraWeeks.Keys)) {
            if ($autoWeeks -contains $w) { continue }
            Write-Host ("  [catch-up] Re-eksporterer {0} (dekkes ikke av den vanlige eksporten)." -f $w) -ForegroundColor Cyan
            Invoke-PythonStep -ScriptPath "pipeline/export_parquet.py" -ExtraArgs @("--week", $w) -TimeoutMinutes 30 -Retries 1 -RetryDelayMinutes 5
        }
    }
    # aggregate_stats: 45 -> 90 min (2026-08-29). Steget brukte tidligere
    # ~8-10 min, men har vokst med stoppdetalj-shardingen (2000 filer,
    # ~434 MB) og en lengre operatorliste (AVI/BFO/TEL).
    #
    # To malinger samme dogn, og de spriker - noter BEGGE, ikke bare den ene:
    #   natt 29.08: drept pa 45 min BEGGE forsok. R2 ble staende to dogn bak
    #               selv om ingesten var vellykket, siden opplastingen
    #               kommer etterpa.
    #   manuelt 29.08 kl. 19:45: HELE steget pa 1188 s (19,8 min), hvorav
    #               shardingen ~11 min. Altsa godt under 45 min-fristen.
    # Samme kode, samme datagrunnlag - forskjellen ma ligge i hva PC-en ellers
    # gjorde om natta (eller at forste forsok fortsatt holdt filer/CPU nar
    # forsok to startet). Fristen er derfor satt ut fra verste observasjon, og
    # 90 min er et TAK, ikke en ventetid: gar steget pa 20 min koster det
    # ingenting a ha rom til 90.
    #
    # 90 -> 150 min (2026-10-23). Overgangsfilene (transfer_shards, fra 10.10)
    # kom pa toppen, og malt varighet for hele steget er na 45-76 min:
    #   13.10: 46 min | 14.10: 45 min | 17.10: 76 min | 20.10: 46 min
    # men 14.10 forsok 1 brukte 88 min BARE pa stoppdetaljene og ble drept.
    # Oppgavens grense er na 6 t, sa det er rom for et tak med ekte margin.
    Invoke-PythonStep -ScriptPath "pipeline/aggregate_stats.py" -TimeoutMinutes 150 -Retries 1 -RetryDelayMinutes 5
    # Opplastingen har ogsa fatt mer a gjore: 2000 shardfiler i tillegg til
    # ukefilene og stats_*.json.
    Invoke-PythonStep -ScriptPath "pipeline/upload_to_r2.py" -ExtraArgs @("--prune") -TimeoutMinutes 40 -Retries 2 -RetryDelayMinutes 5

    Write-Host "=== Reise nightly OK ===" -ForegroundColor Green
}
finally {
    # Slipp vaken-kravet (ES_CONTINUOUS alene = tilbake til normal hvilemodus)
    if ($script:KeepAwake) { try { [void][SenTur.Power]::SetThreadExecutionState([uint32]2147483648) } catch { } }
    if (-not $DryRun) { Stop-Transcript }
}
