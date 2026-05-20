# ComicBlaster — Windows updater (PowerShell).
#
# Pulls the latest source, rebuilds the Go binary and the web bundle, and (if
# the ComicBlaster scheduled task exists) restarts it.

$ErrorActionPreference = 'Stop'

function Info($msg) { Write-Host "  $msg" }
function Bold($msg) { Write-Host "`n$msg" -ForegroundColor White }
function Fatal($msg) { Write-Host "  $msg" -ForegroundColor Red; exit 1 }

$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
Push-Location $RepoRoot

Bold "== ComicBlaster update =="

Info "Fetching changes…"
& git pull --ff-only
if ($LASTEXITCODE -ne 0) { Fatal "git pull failed" }

Info "Rebuilding server…"
Push-Location (Join-Path $RepoRoot 'server')
& go build -o comicblaster.exe .\cmd\comicblaster
if ($LASTEXITCODE -ne 0) { Fatal "go build failed" }
Pop-Location

Info "Rebuilding web client…"
Push-Location (Join-Path $RepoRoot 'web')
& npm install --silent
& npm run build --silent
Pop-Location

$Task = Get-ScheduledTask -TaskName 'ComicBlaster' -ErrorAction SilentlyContinue
if ($Task) {
  Info "Restarting scheduled task…"
  Stop-ScheduledTask  -TaskName 'ComicBlaster' -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName 'ComicBlaster'
  Info "Done."
} else {
  Info "Done. Restart the server process to pick up the new build."
}

Pop-Location
