#!/usr/bin/env bash
# ComicBlaster — Linux / Raspberry Pi OS installer.
#
# Builds the Go server + React client from source and (optionally) installs a
# systemd service that runs as the current user. Safe to run more than once;
# subsequent runs reuse the existing data directory and just rebuild.
#
# Usage:
#   ./scripts/install.sh                # interactive
#   COMICBLASTER_DATA=~/comicdata ./scripts/install.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_USER="$(id -un)"
INSTALL_HOME="$HOME"
DATA_DIR="${COMICBLASTER_DATA:-$INSTALL_HOME/comicblaster-data}"
WEB_ROOT="$REPO_ROOT/web/dist"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
warn()  { printf '\033[33m  %s\033[0m\n' "$*"; }
fatal() { printf '\033[31m  %s\033[0m\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fatal "Required tool '$1' not found. Install it and re-run."
}

bold "== ComicBlaster install =="

# --- Toolchain checks -------------------------------------------------------
if ! command -v go >/dev/null 2>&1; then
  warn "Go is not installed."
  if command -v apt-get >/dev/null 2>&1; then
    read -r -p "  Install golang via apt? [y/N] " REPLY
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      sudo apt-get update
      sudo apt-get install -y golang-go
    else
      fatal "Aborted: Go is required to build the server."
    fi
  else
    fatal "Install Go (https://go.dev/dl/) and re-run."
  fi
fi
require go
require node
require npm
require git

info "Go      : $(go version | awk '{print $3}')"
info "Node    : $(node --version)"
info "User    : $INSTALL_USER"
info "Repo    : $REPO_ROOT"
info "Data dir: $DATA_DIR"

# --- Build ------------------------------------------------------------------
bold "== Building server =="
( cd "$REPO_ROOT/server" && go build -o comicblaster ./cmd/comicblaster )
info "Binary: $REPO_ROOT/server/comicblaster"

bold "== Building web client =="
( cd "$REPO_ROOT/web" && npm install --silent && npm run build --silent )
info "Bundle: $WEB_ROOT"

# --- Data dir + config ------------------------------------------------------
mkdir -p "$DATA_DIR/covers"
CFG="$DATA_DIR/config.yaml"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<EOF
# ComicBlaster configuration
# library.paths is populated through the Settings page in the web UI; add
# entries here only if you want to pre-seed paths before the first start.
server:
    http_port: 8082
    web_root: $WEB_ROOT
library:
    paths: []
    scan_interval: 300
data_dir: $DATA_DIR
EOF
  info "Wrote default config: $CFG"
else
  info "Config already exists at $CFG (left untouched)"
fi

# --- systemd service --------------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  read -r -p "Install as a systemd service (auto-start on boot)? [y/N] " REPLY
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    sudo -v
    UNIT="/etc/systemd/system/comicblaster.service"
    sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=ComicBlaster
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$INSTALL_USER
Group=$INSTALL_USER
WorkingDirectory=$REPO_ROOT/server
ExecStart=$REPO_ROOT/server/comicblaster -config "$CFG"
Restart=on-failure
RestartSec=5
Environment=HOME=$INSTALL_HOME

LimitNOFILE=65536

StandardOutput=journal
StandardError=journal
SyslogIdentifier=comicblaster

NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable comicblaster
    sudo systemctl restart comicblaster
    info "Service installed and started."
    info "  Status: sudo systemctl status comicblaster"
    info "  Logs  : sudo journalctl -u comicblaster -f"
  else
    info "Skipping systemd install. Run manually with:"
    info "  $REPO_ROOT/server/comicblaster -config $CFG"
  fi
fi

# --- Auto-update timer ------------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  read -r -p "Enable nightly auto-update (git pull + rebuild + restart)? [y/N] " REPLY
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    sudo -v
    SVC="/etc/systemd/system/comicblaster-update.service"
    TMR="/etc/systemd/system/comicblaster-update.timer"
    sudo tee "$SVC" >/dev/null <<EOF
[Unit]
Description=ComicBlaster auto-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$INSTALL_USER
WorkingDirectory=$REPO_ROOT
ExecStart=$REPO_ROOT/scripts/update.sh
EOF
    sudo tee "$TMR" >/dev/null <<EOF
[Unit]
Description=Nightly ComicBlaster auto-update

[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now comicblaster-update.timer
    info "Auto-update enabled. Runs daily (off-peak), logs in journalctl."
    info "  Disable: sudo systemctl disable --now comicblaster-update.timer"
  fi
fi

bold "== Done =="
info "Open http://localhost:8082 in a browser to finish first-time setup."
