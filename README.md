# Tinchost Panel

Web hosting control panel: one install script deploys the panel first; a setup wizard guides you to install PHP, MySQL/MariaDB, and optional email/FTP/SSL. The panel runs as root and manages sites, databases, and mail.

## Requirements

- Ubuntu 22.04 LTS (or 24.04) / Debian 12
- Root or sudo
- Node.js 20 LTS and PM2 (installed by `install.sh` if missing)

## Quick start

```bash
sudo ./install.sh
```

Then open the panel URL shown (e.g. `http://<server-ip>/`), set the admin password on first visit, and complete the setup wizard.

## Updating

**After `git pull` you must run the update script**—the panel runs from `/opt/tinchohost/panel` and does not reload code by itself. From the repo root on the server:

```bash
sudo ./update.sh
```

This pulls the latest code (if you haven’t already), syncs the `panel/` files into the install directory, runs migrations, and restarts the panel with PM2. Until you run this, the wizard and panel will keep serving the old version.

## Risks (important)

- **Panel runs as root.** If the panel is compromised, the server can be fully controlled. Use a strong password and restrict access (firewall, VPN, or bind panel to localhost and use Nginx in front).
- **SSL (Let's Encrypt):** Issuance fails if the domain’s DNS does not point to this server or ports 80/443 are blocked.
- **FTP:** May not work from some networks if the FTP passive port range is not open in the firewall. The panel configures ProFTPD to use ports 40000–40100 for passive mode (same range opened by `install.sh`). In the FTP client, use the **FTP login** shown in the panel (e.g. `myuser@example.com`). If the server is behind NAT, set `FTP_MASQUERADE_ADDRESS` to the public IP or hostname so passive connections work.
- **Mail:** Mail may not be delivered or may be marked as spam without SPF/DKIM/DMARC and open ports 25/587.
- **Destructive actions** (delete site, database, mailbox) cannot be undone. Ensure you have backups.

The panel surfaces these risks in the relevant forms and pages.

## Data and settings

The panel stores its SQLite database at `panel/data/panel.sqlite` (relative to the panel install directory, e.g. `/opt/tinchohost/panel/data/panel.sqlite`). Settings (including the MySQL root password) are saved in this database. If you previously ran the panel with a different working directory, the DB may have been created elsewhere; set the `DATABASE_PATH` environment variable to the full path of your existing `panel.sqlite` so the panel and migrations use the same file.

## Process management

The install script installs **PM2**, starts the panel with it, and configures it to start on boot. The panel is served via Nginx proxy with 5-minute timeouts so long operations (e.g. delete site, wizard) do not return 504 Gateway Time-out. If you see 504 on an existing install, add `proxy_connect_timeout 300s; proxy_send_timeout 300s; proxy_read_timeout 300s;` to the panel `location /` block in `/etc/nginx/sites-available/panel` and run `nginx -t && systemctl reload nginx`.

To manage manually:

- **PM2:** `pm2 start /opt/tinchohost/panel/src/index.js --name tinchost-panel` · `pm2 status` · `pm2 logs tinchost-panel`

## Project layout

- `install.sh` – Panel-only install (Node.js, PM2, Nginx proxy, SQLite, panel app, started with PM2)
- `update.sh` – Update panel from repo (git pull, sync files, migrate, PM2 restart)
- `install/` – Nginx/PHP/mail config templates used by the script
- `panel/` – Node.js control panel (Express, SQLite, runs as root)
- `templates/` – Nginx vhost / PHP-FPM templates used by the panel

## License

MIT
emplates used by the panel

## License

MIT
