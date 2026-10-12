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
Add-Type -Namespace A3 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[void][A3.Power]::SetThreadExecutionState(0x80000001) # ES_CONTINUOUS | ES_SYSTEM_REQUIRED

$logDir = Join-Path $env:LOCALAPPDATA "a3-seo-worker"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "worker.log"

# Task Scheduler only restarts a task that fails to launch, not one whose process
# exits, so the restart loop lives here. A job interrupted by a crash is reclaimed
# by the queue's stale-job recovery.
$ErrorActionPreference = "Continue"
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item -Force $log "$log.1" }
  Add-Content -Encoding utf8 $log "[launcher] $(Get-Date -Format s) starting worker"
  cmd /c "node node_modules\tsx\dist\cli.mjs worker\index.ts >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  Add-Content -Encoding utf8 $log "[launcher] $(Get-Date -Format s) worker exited with code $code; restarting in 30s"
  Start-Sleep -Seconds 30
}
