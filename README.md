# Tinchost Panel

Web hosting control panel: one install script deploys the panel first; a setup wizard guides you to install PHP, MySQL/MariaDB, and optional email/FTP/SSL. The panel runs as root and manages sites, databases, and mail.

## Requirements

- Ubuntu 22.04 LTS (or 24.04) / Debian 12
- Root or sudo
- Node.js 20 LTS (installed by `install.sh` if missing)

## Quick start

```bash
sudo ./install.sh
```

Then open the panel URL shown (e.g. `http://<server-ip>/`), set the admin password on first visit, and complete the setup wizard.

## Risks (important)

- **Panel runs as root.** If the panel is compromised, the server can be fully controlled. Use a strong password and restrict access (firewall, VPN, or bind panel to localhost and use Nginx in front).
- **SSL (Let's Encrypt):** Issuance fails if the domain’s DNS does not point to this server or ports 80/443 are blocked.
- **FTP:** May not work from some networks if the FTP passive port range is not open in the firewall.
- **Mail:** Mail may not be delivered or may be marked as spam without SPF/DKIM/DMARC and open ports 25/587.
- **Destructive actions** (delete site, database, mailbox) cannot be undone. Ensure you have backups.

The panel surfaces these risks in the relevant forms and pages.

## Process management

The install script starts the panel with **PM2** (if installed) or a **systemd** unit `tinchost-panel.service`. To manage manually:

- **PM2:** `pm2 start /opt/tinchohost/panel/src/index.js --name tinchost-panel`
- **systemd:** `systemctl start tinchost-panel` (after install)

## Project layout

- `install.sh` – Panel-only install (Node.js, Nginx proxy, SQLite, panel app, started as root)
- `install/` – Nginx/PHP/mail config templates used by the script
- `panel/` – Node.js control panel (Express, SQLite, runs as root)
- `templates/` – Nginx vhost / PHP-FPM templates used by the panel

## License

MIT
