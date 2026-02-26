#!/usr/bin/env bash
# UPGS Panel – panel-only install script
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

# UI: colors only when stdout is a TTY and NO_COLOR is not set
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET='\033[0m'
  C_BOLD='\033[1m'
  C_DIM='\033[0;90m'
  C_OK='\033[0;32m'
  C_HEAD='\033[1;36m'
  C_URL='\033[1;33m'
else
  C_RESET= C_BOLD= C_DIM= C_OK= C_HEAD= C_URL=
fi

step()   { echo ""; echo -e "${C_HEAD}▸${C_RESET} ${C_BOLD}$1${C_RESET}"; }
step_ok() { echo -e "  ${C_OK}✓${C_RESET} $1"; }
info()   { echo -e "  ${C_DIM}$1${C_RESET}"; }

banner() {
  echo ""
  echo -e "${C_HEAD}╭─────────────────────────────────────────╮${C_RESET}"
  echo -e "${C_HEAD}│${C_RESET}  ${C_BOLD}UPGS Panel${C_RESET} – installer"
  echo -e "${C_HEAD}╰─────────────────────────────────────────╯${C_RESET}"
}

done_banner() {
  local url="http://$(hostname -I | awk '{print $1}')/"
  echo ""
  echo -e "${C_OK}╭─────────────────────────────────────────╮${C_RESET}"
  echo -e "${C_OK}│${C_RESET}  ${C_BOLD}Installation complete${C_RESET}"
  echo -e "${C_OK}╰─────────────────────────────────────────╯${C_RESET}"
  echo ""
  echo -e "  Panel URL:  ${C_URL}${url}${C_RESET}"
  echo -e "  ${C_DIM}• Set your admin password on first visit${C_RESET}"
  echo -e "  ${C_DIM}• Complete the setup wizard for PHP, MySQL, mail, FTP${C_RESET}"
  echo ""
}

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

# Require Ubuntu 22.04 or newer
if [[ -r /etc/os-release ]]; then
  # shellcheck source=/dev/null
  . /etc/os-release
else
  echo "Cannot read /etc/os-release. This script requires Ubuntu 22.04 or newer."
  exit 1
fi
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "This script requires Ubuntu. Detected OS: ${ID:-unknown}"
  exit 1
fi
major="${VERSION_ID%%.*}"
if [[ ! "${major:-}" =~ ^[0-9]+$ ]] || [[ $major -lt 22 ]]; then
  echo "This script requires Ubuntu 22.04 or newer. Detected version: ${VERSION_ID:-unknown}"
  exit 1
fi

if [[ -f "$MARKER_FILE" && "$FORCE" != "1" ]]; then
  echo "Panel already installed (marker: $MARKER_FILE). Use FORCE=1 to re-run."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

banner

step "System updates (apt update & upgrade)"
apt-get update -qq
apt-get upgrade -y -qq
step_ok "package lists updated, upgrades applied"

step "Prerequisites"
apt-get install -y -qq curl ca-certificates
step_ok "curl, ca-certificates"

step "Firewall (opening ports if ufw/firewalld is active)"
open_firewall_ports() {
  if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    for p in $PORTS_SSH $PORTS_HTTP $PORTS_MAIL $PORTS_FTP; do
      ufw allow "$p/tcp" 2>/dev/null || true
    done
    ufw allow "${PORTS_FTP_PASSIVE}/tcp" 2>/dev/null || true
    ufw reload 2>/dev/null || true
    step_ok "UFW: SSH, 80/443, 25/587, 21, passive ${PORTS_FTP_PASSIVE}"
  elif command -v firewall-cmd &>/dev/null && systemctl is-active firewalld &>/dev/null; then
    for p in $PORTS_SSH $PORTS_HTTP $PORTS_MAIL $PORTS_FTP; do
      firewall-cmd --permanent --add-port="$p/tcp" 2>/dev/null || true
    done
    firewall-cmd --permanent --add-port="${PORTS_FTP_PASSIVE//:/-}/tcp" 2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
    step_ok "Firewalld: SSH, 80/443, 25/587, 21, passive ${PORTS_FTP_PASSIVE}"
  else
    info "No active firewall detected; skipping."
  fi
}
open_firewall_ports

step "Node.js"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
step_ok "node $(node -v)"

step "PM2 (process manager + startup on boot)"
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi
# Ensure PM2 runs on boot (idempotent; only installs if missing)
STARTUP_CMD=$(pm2 startup systemd -u root --hp /root 2>&1 | grep -E '^sudo ' || true)
if [[ -n "$STARTUP_CMD" ]]; then
  eval "$STARTUP_CMD"
fi
step_ok "pm2 $(pm2 -v | head -1)"

step "Panel database (SQLite)"
apt-get install -y -qq sqlite3
step_ok "sqlite3"

step "Nginx"
apt-get install -y -qq nginx
# Global upload limit so WordPress/media uploads don't get 413
mkdir -p /etc/nginx/conf.d
echo -e '# UPGS Panel: allow larger uploads (e.g. WordPress media)\nclient_max_body_size 64M;' > /etc/nginx/conf.d/99-upgs-uploads.conf
step_ok "nginx"

step "Control panel app"
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
step_ok "installed at $PANEL_PATH"

step "Nginx vhost for panel"
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
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
NGINX_EOF
ln -sf /etc/nginx/sites-available/panel /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl reload nginx
step_ok "default vhost → :3000"

step "Starting panel with PM2"
pm2 delete upgs-panel 2>/dev/null || true
cd "$PANEL_PATH" && pm2 start src/index.js --name upgs-panel
pm2 save
step_ok "upgs-panel running"

touch "$MARKER_FILE"
done_banner
