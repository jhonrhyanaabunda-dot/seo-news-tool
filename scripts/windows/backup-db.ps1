# Nightly database backup (scripts/backup-db.ts) for the "A3 SEO Backup" scheduled task.
# Writes %USERPROFILE%\Backups\a3-seo-monitor\<timestamp>\ and keeps 30 days.
# Log: %LOCALAPPDATA%\a3-seo-worker\backup.log
$ErrorActionPreference = "Continue"
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$env:ENV_FILE = ".env.worker"
$env:NODE_OPTIONS = "--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=3000"
$logDir = Join-Path $env:LOCALAPPDATA "a3-seo-worker"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "backup.log"
try { [IO.File]::AppendAllText($log, "[backup] $(Get-Date -Format s) starting`r`n") } catch { }
cmd /c "node node_modules\tsx\dist\cli.mjs scripts\backup-db.ts --keep-days 30 >> `"$log`" 2>&1"
$code = $LASTEXITCODE
try { [IO.File]::AppendAllText($log, "[backup] $(Get-Date -Format s) finished with exit code $code`r`n") } catch { }
exit $code
