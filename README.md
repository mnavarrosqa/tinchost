# UPGS Panel

A web hosting control panel for Ubuntu/Debian. One install script deploys the panel; a setup wizard guides you through installing PHP, MySQL/MariaDB, and optional mail/FTP/SSL. The panel runs as root and manages sites, databases, FTP users, and SSL certificates.

---

## Requirements

- **OS:** Ubuntu 22.04 LTS, Ubuntu 24.04, or Debian 12
- **Access:** Root or `sudo`
- **Node.js 20 LTS** and **PM2** are installed automatically by `install.sh` if missing

---

## Installation

1. **Get the code** on your server (clone or upload):

   ```bash
   git clone https://github.com/your-org/tinchohost.git
   cd tinchohost
   ```

   Or download and extract the repo, then `cd` into the project directory.

2. **Run the installer as root:**

   ```bash
   sudo ./install.sh
   ```

   The script will:

   - Install Node.js 20 and PM2 (if needed)
   - Install Nginx and SQLite
   - Copy the panel to `/opt/tinchohost/panel` and install dependencies
   - Create an Nginx site that proxies to the panel (port 3000)
   - Open firewall ports for HTTP/HTTPS, mail, and FTP (if UFW/firewalld is active)
   - Start the panel with PM2 and enable it on boot

3. **Note the URL** printed at the end (e.g. `http://<server-ip>/`). If the panel is already installed, the script exits unless you run `FORCE=1 sudo ./install.sh`.

---

## First-time setup

1. **Open the panel URL** in a browser (e.g. `http://your-server-ip/`).

2. **Set the admin password** on first visit. This is the only user; it has full access to the panel.

3. **Complete the setup wizard** from the dashboard. The wizard will:
   - Install and configure **PHP** (version selectable)
   - Install **MySQL/MariaDB** and set the root password (stored in the panel database)
   - Optionally install **Postfix** and **Dovecot** for mail
   - Optionally install **ProFTPD** for FTP
   - Optionally install **Certbot** for Let’s Encrypt SSL

   Run the wizard once; you can change PHP version or add/remove services later from **Settings**.

---

## Using the panel

### Dashboard

- Overview and links to **Sites**, **Databases**, and **Settings**.
- Shows wizard status until setup is complete.

### Sites

- **Sites** → list of all sites. **Add site** to create a new one.
- When adding a site you set:
  - **Domain** (e.g. `example.com`)
  - **Document root** (default `/var/www/example.com`)
  - **PHP version** (or Node if you choose a Node app)
  - Optional: **Enable SSL** (Let’s Encrypt), **Enable FTP**, **Node port** (for Node apps). Docroot is always created on site creation.

- **Click a site** to manage it:
  - **Overview** – docroot, PHP version, FTP/SSL status, quick links
  - **Databases** – create MySQL databases and users, assign users to databases
  - **FTP** – create FTP logins (format `user@example.com`), set passwords
  - **SSL** – view certificate status, renew, remove certificate, or **install** a certificate again after removal (from the same tab)
  - **PHP** – override PHP options for this site
  - **Scripts** – one-click install WordPress (or other scripts) into a subfolder
  - **File Manager** – browse the site’s docroot, upload files, create folders, rename/delete, **edit text files** (click the file name to open the editor overlay and save changes)
  - **Node apps** (for Node sites) – manage PM2 apps and environment variables

### Databases

- Create **databases** and **users**, then assign users to databases with the desired privileges.
- Passwords and credentials are shown once; use them in your app (e.g. `wp-config.php`).

### FTP

- FTP logins are created per site (e.g. `myuser@example.com`). Use the **FTP login** name and the password you set in the panel. The panel configures ProFTPD with passive ports 40000–40100; ensure these are open if clients cannot connect.

### SSL (Let’s Encrypt)

- Enable when adding a site or later from the site’s **SSL** tab. DNS for the domain must point to this server and ports 80/443 must be open. You can **renew**, **remove**, or **install** a certificate again from the same tab after removal.

### File Manager

- Open **File Manager** from a site’s page. You can:
  - Browse folders, create folders, upload files
  - Rename, delete, bulk move/copy/delete
  - **Edit text files:** click the **file name** to open an overlay editor, then **Save changes**. Download remains available as a separate button in the row. Only text-safe extensions (e.g. .php, .html, .js, .css, .env) are editable; binary and unsupported types are rejected.

### Settings

- Change **PHP version**, toggle **mail/FTP/Certbot** installation, and adjust other panel options. The wizard writes initial config; Settings is for later changes.

---

## Updating

After you pull new code (e.g. `git pull`), you **must run the update script** so the panel binary and assets are refreshed. The panel runs from `/opt/tinchohost/panel` and does not reload code by itself.

From the repo root on the server:

```bash
sudo ./update.sh
```

This will pull the latest code (if you haven’t already), sync the `panel/` files into `/opt/tinchohost/panel`, run any database migrations, and restart the panel with PM2. Until you run this, the panel serves the old version.

---

## Risks (important)

- **Panel runs as root.** If the panel is compromised, the server can be fully controlled. Use a strong admin password and restrict access (firewall, VPN, or bind the panel to localhost and put it behind Nginx with auth).
- **SSL (Let’s Encrypt):** Issuance fails if the domain’s DNS does not point to this server or if ports 80/443 are blocked.
- **FTP:** May not work from some networks if the FTP passive port range is not open. The panel uses ports 40000–40100 for passive mode. Use the **FTP login** shown in the panel (e.g. `myuser@example.com`). If the server is behind NAT, set `FTP_MASQUERADE_ADDRESS` to the public IP or hostname so passive connections work.
- **Mail:** Mail may not be delivered or may be marked as spam without SPF/DKIM/DMARC and open ports 25/587.
- **Destructive actions** (delete site, database, mailbox) cannot be undone. Keep backups.

The panel surfaces these risks in the relevant forms and pages.

---

## Data and settings

The panel stores its SQLite database at `panel/data/panel.sqlite` (relative to the panel install directory, e.g. `/opt/tinchohost/panel/data/panel.sqlite`). Settings, including the MySQL root password, are saved in this database. If you previously ran the panel from a different directory, the DB may live elsewhere; set the `DATABASE_PATH` environment variable to the full path of your existing `panel.sqlite` so the panel and migrations use the same file.

---

## Process management

The install script starts the panel with **PM2** and configures it to start on boot. Nginx proxies to the panel with 5-minute timeouts so long operations (e.g. delete site, wizard) do not hit 504. If you see 504 on an existing install, add `proxy_connect_timeout 300s; proxy_send_timeout 300s; proxy_read_timeout 300s;` to the panel `location /` block in `/etc/nginx/sites-available/panel` and run `nginx -t && systemctl reload nginx`.

Useful commands:

- **Status:** `pm2 status`
- **Logs:** `pm2 logs upgs-panel`
- **Restart:** `pm2 restart upgs-panel`
- **Start (if stopped):** `pm2 start /opt/tinchohost/panel/src/index.js --name upgs-panel`

---

## Project layout

| Path         | Description |
|-------------|-------------|
| `install.sh` | Panel-only install (Node.js, PM2, Nginx proxy, SQLite, panel app) |
| `update.sh`  | Update panel from repo (git pull, sync files, migrate, PM2 restart) |
| `install/`   | Nginx/PHP/mail config templates used by the install script |
| `panel/`     | Node.js control panel (Express, SQLite, runs as root) |
| `templates/` | Nginx vhost and PHP-FPM templates used by the panel |

---

## License

MIT
