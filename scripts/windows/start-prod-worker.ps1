# Runs the SEO crawler worker on this Windows PC against the PRODUCTION database.
# Windows twin of scripts/start-prod-worker.sh: Vercel can't run Chromium, and the
# dealership sites only serve pages to a real browser, so production scans
# (CRAWLER_MODE=worker) and report PDFs are rendered here.
#
# Normally started by the "A3 SEO Worker" scheduled task (install-worker-task.ps1).
# Run it directly for a manual run; logs go to %LOCALAPPDATA%\a3-seo-worker\worker.log.
$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
if (-not (Test-Path .env.worker)) { throw ".env.worker is missing from $(Get-Location)" }

# .env.worker wins; scripts/load-env then fills anything unset from .env.local.
$env:ENV_FILE = ".env.worker"
# ipv4first: Neon publishes AAAA records; without it a network with no IPv6 route
# times out on the IPv6 attempt before IPv4 answers.
$env:NODE_OPTIONS = "--conditions=react-server --dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=3000"

# caffeinate -i equivalent: no idle sleep while this process runs. No power setting is changed.
# Best effort: the worker must still start if this fails.
try {
  Add-Type -Namespace A3 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED. Written as decimal: PowerShell 5.1 reads 0x80000001 as a negative Int32.
  [void][A3.Power]::SetThreadExecutionState([uint32]2147483649)
} catch {
  Write-Warning "Could not keep the PC awake: $_"
}

$logDir = Join-Path $env:LOCALAPPDATA "a3-seo-worker"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "worker.log"
$pidFile = Join-Path $logDir "worker.pid"
$ErrorActionPreference = "Continue"

function Write-LauncherLog([string]$message) {
  try { [IO.File]::AppendAllText($log, "[launcher] $(Get-Date -Format s) $message`r`n") } catch { }
}

# Stopping the scheduled task ends only this script, not the worker it started, so
# a restart would leave the old worker running beside the new one (and holding the
# log open). Stop the previous worker first; its cmd.exe PID is in worker.pid.
$previous = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
if ($previous -and (Get-Process -Id $previous -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq "cmd" })) {
  Write-LauncherLog "stopping the previous worker (cmd PID $previous)"
  taskkill /PID $previous /T /F | Out-Null
  Start-Sleep -Seconds 2
}

# Task Scheduler only restarts a task that fails to launch, not one whose process
# exits, so the restart loop lives here. A job interrupted by a crash or a restart
# is reclaimed by the queue's stale-job recovery.
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item -Force $log "$log.1" -ErrorAction SilentlyContinue }
  Write-LauncherLog "starting worker"
  $worker = Start-Process -FilePath "cmd.exe" -ArgumentList "/c node node_modules\tsx\dist\cli.mjs worker\index.ts >> `"$log`" 2>&1" -NoNewWindow -PassThru
  $null = $worker.Handle # without this, ExitCode is empty once the process has exited
  Set-Content -Path $pidFile -Value $worker.Id
  $worker.WaitForExit()
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Write-LauncherLog "worker exited with code $($worker.ExitCode); restarting in 30s"
  Start-Sleep -Seconds 30
}
