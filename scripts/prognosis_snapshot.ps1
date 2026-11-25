# Øyeblikksbilder av Enturs sanntidsprognoser (2 timer, hvert 10. min) for å
# måle prognosefeilen over flere dager. Kjøres av oppgaven
# «Bussforsinkelser prognose-snapshot» (registrert med -Register nedenfor).
# Etter at nattjobben har hentet dagene:
#   python pipeline/triplab/entur_estimates.py evaluate --quantiles
# gir nye PROGNOSIS_ERROR-tall til client/src/lib/live-model.ts.
param([switch]$Register, [string]$Until = "2026-11-30")

$repo = Split-Path -Parent $PSScriptRoot

if ($Register) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$repo\scripts\prognosis_snapshot.ps1`"" `
        -WorkingDirectory $repo
    $triggers = @("07:00", "15:00") | ForEach-Object {
        $t = New-ScheduledTaskTrigger -Daily -At $_
        $t.EndBoundary = "$($Until)T23:59:00"
        $t
    }
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Hours 3) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited  # S4U krever admin
    Register-ScheduledTask -TaskName "Bussforsinkelser prognose-snapshot" -Action $action -Trigger $triggers `
        -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
    Write-Host "Registrert: 07:00 og 15:00 daglig til og med $Until"
    exit 0
}

Set-Location $repo
$log = Join-Path $repo "data\triplab\entur_snapshot.log"
"=== $(Get-Date -Format s) ===" | Out-File -Append -Encoding utf8 $log
& python pipeline/triplab/entur_estimates.py snapshot *>&1 | Out-File -Append -Encoding utf8 $log
exit $LASTEXITCODE
