# Registers the "A3 SEO Backup" scheduled task: a database backup every night at 03:30,
# whether or not anyone is signed in (S4U, no password stored). Run from an elevated PowerShell:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-backup-task.ps1
#
# Remove with: Unregister-ScheduledTask -TaskName "A3 SEO Backup" -Confirm:$false
$ErrorActionPreference = "Stop"
$script = (Resolve-Path "$PSScriptRoot\backup-db.ps1").Path
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At "03:30"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
# A missed night (PC off) runs as soon as it is back; a stuck run is stopped after an hour.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "A3 SEO Backup" -Description "A3 SEO Monitor nightly database backup (scripts\windows\backup-db.ps1)" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered 'A3 SEO Backup' (daily 03:30). Run now: Start-ScheduledTask -TaskName 'A3 SEO Backup'"
