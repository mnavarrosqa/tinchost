#!/usr/bin/env bash
# UPGS Panel – update script
# Pulls latest from the repo, syncs panel files, runs npm install & migrations, restarts PM2.

set -e

PANEL_PATH="${PANEL_PATH:-/opt/tinchohost/panel}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

if [[ ! -d "$PANEL_PATH" ]]; then
  echo "Panel not found at $PANEL_PATH. Run install.sh first."
  exit 1
fi

if ! command -v rsync &>/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq rsync
fi

echo "Updating UPGS Panel..."
echo "  Repo: $REPO_ROOT"
echo "  Panel: $PANEL_PATH"
echo ""

echo "[1/5] Pulling latest from repo..."
if [[ -d "$REPO_ROOT/.git" ]]; then
  cd "$REPO_ROOT"
  git fetch origin
  git pull
else
  echo "  Not a git repo; skipping pull. Using current files."
fi

echo "[2/5] Syncing panel files (keeping .env, data/, node_modules intact)..."
rsync -a --delete \
  --exclude='.env' \
  --exclude='data' \
  --exclude='node_modules' \
  --exclude='storage' \
  "$REPO_ROOT/panel/" "$PANEL_PATH/"

echo "[3/5] Installing dependencies..."
cd "$PANEL_PATH"
npm install --production
npm rebuild

echo "[4/5] Running migrations..."
node src/scripts/migrate.js

echo "[5/5] Restarting panel..."
if command -v pm2 &>/dev/null; then
  pm2 restart upgs-panel
  pm2 save
  echo ""
  echo "UPGS Panel updated and restarted."
  echo "  Panel URL: http://$(hostname -I | awk '{print $1}')/"
else
  echo "  PM2 not found. Restart manually: systemctl restart upgs-panel (if using systemd)."
  exit 1
fi
