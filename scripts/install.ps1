# ComicBlaster — Windows installer (PowerShell).
#
# Builds the Go server + React client from source, drops a config in
# %USERPROFILE%\comicblaster-data, and optionally registers a scheduled task
# that launches the server at login.
#
# Run from a PowerShell prompt:
#   .\scripts\install.ps1
#
# Requires: Go, Node.js, npm, and git on PATH.

$ErrorActionPreference = 'Stop'

function Info($msg)  { Write-Host "  $msg" }
function Bold($msg)  { Write-Host "`n$msg" -ForegroundColor White }
function Fatal($msg) { Write-Host "  $msg" -ForegroundColor Red; exit 1 }

function Require-Cmd($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Fatal "Required tool '$name' not found. $hint"
  }
}

$RepoRoot   = (Resolve-Path "$PSScriptRoot\..").Path
$DataDir    = if ($env:COMICBLASTER_DATA) { $env:COMICBLASTER_DATA } else { Join-Path $env:USERPROFILE 'comicblaster-data' }
$WebRoot    = Join-Path $RepoRoot 'web\dist'
$BinaryPath = Join-Path $RepoRoot 'server\comicblaster.exe'

Bold "== ComicBlaster install =="

Require-Cmd 'go'   "Install Go from https://go.dev/dl/"
Require-Cmd 'node' "Install Node.js LTS from https://nodejs.org/"
Require-Cmd 'npm'  "npm ships with Node.js"
Require-Cmd 'git'  "Install Git from https://git-scm.com/"

Info ("Go      : " + (& go version))
Info ("Node    : " + (& node --version))
Info ("Repo    : $RepoRoot")
Info ("Data dir: $DataDir")

Bold "== Building server =="
Push-Location (Join-Path $RepoRoot 'server')
& go build -o comicblaster.exe .\cmd\comicblaster
if ($LASTEXITCODE -ne 0) { Fatal "go build failed" }
Pop-Location
Info "Binary: $BinaryPath"

Bold "== Building web client =="
Push-Location (Join-Path $RepoRoot 'web')
& npm install --silent
if ($LASTEXITCODE -ne 0) { Fatal "npm install failed" }
& npm run build --silent
if ($LASTEXITCODE -ne 0) { Fatal "npm run build failed" }
Pop-Location
Info "Bundle: $WebRoot"

New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'covers') | Out-Null
$Cfg = Join-Path $DataDir 'config.yaml'
if (-not (Test-Path $Cfg)) {
@"
# ComicBlaster configuration
# library.paths is populated through the Settings page in the web UI; add
# entries here only if you want to pre-seed paths before the first start.
server:
    http_port: 8082
    web_root: $($WebRoot -replace '\\','\\')
library:
    paths: []
    scan_interval: 300
data_dir: $($DataDir -replace '\\','\\')
"@ | Set-Content -Encoding UTF8 $Cfg
  Info "Wrote default config: $Cfg"
} else {
  Info "Config already exists at $Cfg (left untouched)"
}

Bold "== Scheduled task =="
$Answer = Read-Host "Register a scheduled task to launch ComicBlaster at logon? (y/N)"
if ($Answer -match '^[Yy]') {
  $TaskName = 'ComicBlaster'
  $Action = New-ScheduledTaskAction `
    -Execute $BinaryPath `
    -Argument "-config `"$Cfg`"" `
    -WorkingDirectory (Join-Path $RepoRoot 'server')
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Info "Task '$TaskName' registered and started."
  Info "  Stop : Stop-ScheduledTask -TaskName '$TaskName'"
  Info "  Logs : Event Viewer → Windows Logs → Application"
} else {
  Info "Skipping. Run manually:"
  Info "  $BinaryPath -config `"$Cfg`""
}

Bold "== Auto-update =="
$AutoAnswer = Read-Host "Run update.ps1 once a day at 3:30 AM? (y/N)"
if ($AutoAnswer -match '^[Yy]') {
  $UpdateTask = 'ComicBlasterUpdate'
  $UpdateScript = Join-Path $RepoRoot 'scripts\update.ps1'
  $UpdateAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$UpdateScript`""
  $UpdateTrigger = New-ScheduledTaskTrigger -Daily -At 3:30am
  $UpdateSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $UpdateTask -Action $UpdateAction -Trigger $UpdateTrigger -Settings $UpdateSettings -Force | Out-Null
  Info "Daily auto-update task '$UpdateTask' registered (3:30 AM)."
  Info "  Disable: Unregister-ScheduledTask -TaskName '$UpdateTask' -Confirm:`$false"
}

Bold "== Done =="
Info "Open http://localhost:8082 in a browser to finish first-time setup."
