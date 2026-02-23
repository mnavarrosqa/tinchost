#!/usr/bin/env bash
# Tinchost Panel – panel-only install script
# Installs: Node.js, Nginx (proxy to panel), SQLite, panel app (runs as root).
# PHP, MySQL/MariaDB, mail, FTP, Certbot are installed later via the panel setup wizard.

set -e

PANEL_PATH="${PANEL_PATH:-/opt/tinchohost/panel}"
MARKER_FILE="${MARKER_FILE:-/opt/tinchohost/.panel-installed}"
FORCE="${FORCE:-0}"

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

if [[ -f "$MARKER_FILE" && "$FORCE" != "1" ]]; then
  echo "Panel already installed (marker: $MARKER_FILE). Use FORCE=1 to re-run."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/7] Prerequisites..."
apt-get update -qq
apt-get install -y -qq curl ca-certificates

echo "[2/7] Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "[3/7] Panel database (SQLite)..."
# SQLite is used by the panel; no MySQL required for initial install
apt-get install -y -qq sqlite3

echo "[4/7] Nginx (minimal)..."
apt-get install -y -qq nginx

echo "[5/7] Control panel app..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$(dirname "$PANEL_PATH")"
cp -r "$SCRIPT_DIR/panel" "$PANEL_PATH"
mkdir -p "$PANEL_PATH/data" "$PANEL_PATH/storage"
cd "$PANEL_PATH"
if [[ ! -f .env ]]; then
  cat > .env << EOF
PORT=3000
NODE_ENV=production
DATABASE_PATH=$PANEL_PATH/data/panel.sqlite
EOF
fi
npm install --production
node src/scripts/migrate.js

echo "[6/7] Nginx vhost for panel..."
PANEL_HOSTNAME="${PANEL_HOSTNAME:-$(hostname)}"
cat > /etc/nginx/sites-available/panel << NGINX_EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${PANEL_HOSTNAME};
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX_EOF
ln -sf /etc/nginx/sites-available/panel /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl reload nginx

echo "[7/7] Starting panel as root..."
if command -v pm2 &>/dev/null; then
  pm2 delete tinchost-panel 2>/dev/null || true
  cd "$PANEL_PATH" && pm2 start src/index.js --name tinchost-panel
  pm2 save
else
  cat > /etc/systemd/system/tinchost-panel.service << EOF
[Unit]
Description=Tinchost Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$PANEL_PATH
ExecStart=$(which node) $PANEL_PATH/src/index.js
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now tinchost-panel
fi

touch "$MARKER_FILE"
echo ""
echo "Tinchost Panel is installed."
echo "  Panel URL: http://$(hostname -I | awk '{print $1}')/"
echo "  Set your admin password on first visit."
echo "  Complete the setup wizard to install PHP, MySQL/MariaDB, and optional services."
