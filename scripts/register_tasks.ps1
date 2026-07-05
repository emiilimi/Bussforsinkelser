# =============================================================================
# Registrer de to nattlige pipeline-jobbene i Windows Task Scheduler.
# Kjor en gang:  powershell -ExecutionPolicy Bypass -File scripts/register_tasks.ps1
#
#   Bussforsinkelser Reise nightly   06:30 hver dag   (AKTIV)
#   Bussforsinkelser Full nightly    07:00 hver dag   (DEAKTIVERT - se under)
#
# Jobbene kjorer som deg, kun nar du er logget inn. Var PC-en av/i dvale
# kl. 06:30, kjores jobben sa snart den far sjansen (StartWhenAvailable).
#
# Endre tidspunkt:   Task Scheduler-appen -> oppgaven -> Triggers -> Edit
# Slett:             Unregister-ScheduledTask -TaskName 'Bussforsinkelser Reise nightly'
# Aktiver full-jobb: Enable-ScheduledTask -TaskName 'Bussforsinkelser Full nightly'
# Kjor manuelt na:   Start-ScheduledTask -TaskName 'Bussforsinkelser Reise nightly'
# =============================================================================
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -MultipleInstances IgnoreNew

function Register-PipelineTask {
    param([string]$Name, [string]$Script, [string]$At, [bool]$Enabled)
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repo\scripts\$Script`"" `
        -WorkingDirectory $repo
    $trigger = New-ScheduledTaskTrigger -Daily -At $At
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Settings $settings -Force | Out-Null
    if (-not $Enabled) { Disable-ScheduledTask -TaskName $Name | Out-Null }
    $state = if ($Enabled) { "AKTIV" } else { "deaktivert" }
    Write-Host ("  [OK] {0}  ({1} daglig, {2})" -f $Name, $At, $state)
}

Write-Host "Registrerer pipeline-jobber for repo: $repo"
Register-PipelineTask -Name "Bussforsinkelser Reise nightly" -Script "nightly_reise.ps1" -At "06:30" -Enabled $true
# Full-jobben registreres deaktivert: den fulle basen vokser ubegrenset og
# disken er nesten full (slett data/bussforsinkelser_prod.db forst).
Register-PipelineTask -Name "Bussforsinkelser Full nightly" -Script "nightly_full.ps1" -At "07:00" -Enabled $false

Write-Host ""
Write-Host "Ferdig. Sjekk med: Get-ScheduledTask -TaskName 'Bussforsinkelser*'"
