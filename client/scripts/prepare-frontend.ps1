# prepare-frontend.ps1
#
# Wails' frontend:build hook runs this before embedding assets into the
# Go binary. We don't have a stand-alone frontend under client/ — the
# React app lives at ../web/ and is shared with the browser deployment.
#
# Steps:
#   1. Build the web bundle (vite → web/dist/)
#   2. Mirror web/dist into client/dist/ so main.go's //go:embed picks
#      it up (Go's embed can't traverse '..').

# Stop-on-error for PowerShell cmdlets, but native commands (npm, etc.)
# fork their stderr into PowerShell's error stream — under 'Stop' that
# turns vite's non-error build summary into a hard fatal. Use 'Continue'
# instead and rely on $LASTEXITCODE for actual failure detection.
$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path "$PSScriptRoot\..").Path
$Web  = (Resolve-Path "$Root\..\web").Path

Write-Host "[prepare-frontend] building web bundle in $Web"
Push-Location $Web
# 2>&1 routes the native command's stderr to stdout so $? doesn't latch
# false on a clean build. $LASTEXITCODE remains the source of truth.
& npm run build 2>&1 | Out-Host
$ExitCode = $LASTEXITCODE
Pop-Location
if ($ExitCode -ne 0) {
  throw "npm run build failed (exit $ExitCode)"
}

$Src = Join-Path $Web 'dist'
$Dst = Join-Path $Root 'dist'

Write-Host "[prepare-frontend] mirroring $Src -> $Dst"
if (Test-Path $Dst) { Remove-Item -Recurse -Force $Dst }
New-Item -ItemType Directory -Force -Path $Dst | Out-Null
Copy-Item -Recurse -Force "$Src\*" $Dst
