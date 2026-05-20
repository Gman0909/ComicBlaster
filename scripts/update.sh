#!/usr/bin/env bash
# ComicBlaster — Linux / Raspberry Pi OS updater.
#
# Pulls the latest source, rebuilds the Go binary and the web bundle, and (if
# a systemd unit is installed) restarts the service.
#
# Usage: ./scripts/update.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

bold "== ComicBlaster update =="

# Warm up sudo so the daemon-reload + restart at the end don't prompt mid-build.
if systemctl is-enabled --quiet comicblaster 2>/dev/null; then
  sudo -v
fi

info "Fetching changes…"
git pull --ff-only

info "Rebuilding server…"
( cd server && go build -o comicblaster ./cmd/comicblaster )

info "Rebuilding web client…"
( cd web && npm install --silent && npm run build --silent )

if systemctl is-enabled --quiet comicblaster 2>/dev/null; then
  info "Restarting service…"
  sudo systemctl restart comicblaster
  info "Done. Logs: sudo journalctl -u comicblaster -f"
else
  info "Done. Restart the server process to pick up the new build."
fi
