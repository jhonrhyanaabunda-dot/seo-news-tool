# Registers the "A3 SEO Worker" scheduled task that keeps the crawler worker running.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-worker-task.ps1
#     Starts when this user signs in (no admin rights needed).
#
#   (from an elevated PowerShell) ... install-worker-task.ps1 -AtStartup
#     Starts at boot whether or not anyone signs in, so it survives Windows Update
#     restarts. Uses S4U, so no password is stored.
#
# Remove with: Unregister-ScheduledTask -TaskName "A3 SEO Worker" -Confirm:$false
param([switch]$AtStartup)
$ErrorActionPreference = "Stop"

$launcher = (Resolve-Path "$PSScriptRoot\start-prod-worker.ps1").Path
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""

if ($AtStartup) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $trigger.Delay = "PT1M" # let the network come up first
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
}

# ExecutionTimeLimit 0 = never stop (the default would kill the worker after 3 days).
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "A3 SEO Worker" -Description "A3 SEO Monitor crawler + report PDF worker (scripts\windows\start-prod-worker.ps1)" `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered 'A3 SEO Worker' ($(if ($AtStartup) { 'at startup' } else { 'at logon' })). Start now: Start-ScheduledTask -TaskName 'A3 SEO Worker'"
Write-Host "Log: $env:LOCALAPPDATA\a3-seo-worker\worker.log"
