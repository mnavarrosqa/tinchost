#!/usr/bin/env bash
# Tinchost Panel – panel-only install script
# Installs: Node.js, Nginx (proxy to panel), SQLite, panel app (runs as root).
# PHP, MySQL/MariaDB, mail, FTP, Certbot are installed later via the panel setup wizard.

set -e

PANEL_PATH="${PANEL_PATH:-/opt/tinchohost/panel}"
MARKER_FILE="${MARKER_FILE:-/opt/tinchohost/.panel-installed}"
FORCE="${FORCE:-0}"

# Ports used by the panel and optional services (mail, FTP, SSL)
PORTS_HTTP="80 443"
PORTS_MAIL="25 587"
PORTS_FTP="21"
PORTS_FTP_PASSIVE="40000:40100"
PORTS_SSH="22"

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

if [[ -f "$MARKER_FILE" && "$FORCE" != "1" ]]; then
  echo "Panel already installed (marker: $MARKER_FILE). Use FORCE=1 to re-run."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/9] Prerequisites..."
apt-get update -qq
apt-get install -y -qq curl ca-certificates

echo "[2/9] Firewall (opening required ports if ufw or firewalld is in use)..."
open_firewall_ports() {
  if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    for p in $PORTS_SSH $PORTS_HTTP $PORTS_MAIL $PORTS_FTP; do
      ufw allow "$p/tcp" 2>/dev/null || true
    done
    ufw allow "${PORTS_FTP_PASSIVE}/tcp" 2>/dev/null || true
    ufw reload 2>/dev/null || true
    echo "  UFW: allowed SSH, HTTP/HTTPS, mail (25/587), FTP (21 + passive ${PORTS_FTP_PASSIVE})."
  elif command -v firewall-cmd &>/dev/null && systemctl is-active firewalld &>/dev/null; then
    for p in $PORTS_SSH $PORTS_HTTP $PORTS_MAIL $PORTS_FTP; do
      firewall-cmd --permanent --add-port="$p/tcp" 2>/dev/null || true
    done
    firewall-cmd --permanent --add-port="${PORTS_FTP_PASSIVE//:/-}/tcp" 2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
    echo "  Firewalld: allowed SSH, HTTP/HTTPS, mail (25/587), FTP (21 + passive ${PORTS_FTP_PASSIVE})."
  else
    echo "  No active firewall (ufw/firewalld) detected; skipping."
  fi
}
open_firewall_ports

echo "[3/9] Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "[4/9] PM2 (process manager and startup)..."
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi
pm2 -v
# Ensure PM2 runs on boot (idempotent; only installs if missing)
STARTUP_CMD=$(pm2 startup systemd -u root --hp /root 2>&1 | grep -E '^sudo ' || true)
if [[ -n "$STARTUP_CMD" ]]; then
  eval "$STARTUP_CMD"
fi

echo "[5/9] Panel database (SQLite)..."
# SQLite is used by the panel; no MySQL required for initial install
apt-get install -y -qq sqlite3

echo "[6/9] Nginx (minimal)..."
apt-get install -y -qq nginx

echo "[7/9] Control panel app..."
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

echo "[8/9] Nginx vhost for panel..."
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

echo "[9/9] Starting panel with PM2..."
pm2 delete tinchost-panel 2>/dev/null || true
cd "$PANEL_PATH" && pm2 start src/index.js --name tinchost-panel
pm2 save

touch "$MARKER_FILE"
echo ""
echo "Tinchost Panel is installed."
echo "  Panel URL: http://$(hostname -I | awk '{print $1}')/"
echo "  Set your admin password on first visit."
echo "  Complete the setup wizard to install PHP, MySQL/MariaDB, and optional services."
