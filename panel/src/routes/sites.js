const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { getDb, getDbPath, getSetting } = require('../config/database');
const siteManager = require('../services/siteManager');
const sslManager = require('../services/sslManager');
const databaseManager = require('../services/databaseManager');
const { PRIVILEGE_SETS, getDatabaseSizes } = require('../services/databaseManager');
const ftpManager = require('../services/ftpManager');
const servicesManager = require('../services/servicesManager');
const { execSync, execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const dns = require('dns');
const multer = require('multer');

const dnsPromises = dns.promises;

function isInternalIPv4(addr) {
  if (!addr || addr === '127.0.0.1') return true;
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function isInternalIPv6(addr) {
  if (!addr || addr === '::1') return true;
  const lower = addr.toLowerCase();
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}

function getServerIps(db) {
  const fromSettingV4 = getSetting(db, 'server_public_ip');
  const fromSettingV6 = getSetting(db, 'server_public_ipv6');
  if (fromSettingV4 && fromSettingV4.trim()) {
    return { serverIp: fromSettingV4.trim(), serverIpv6: (fromSettingV6 && fromSettingV6.trim()) || null };
  }
  let serverIp = null;
  let serverIpv6 = null;
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces || {})) {
      for (const iface of ifaces[name] || []) {
        if (iface.internal) continue;
        if (iface.family === 'IPv4' && !isInternalIPv4(iface.address)) {
          if (!serverIp) serverIp = iface.address;
        }
        if (iface.family === 'IPv6' && !isInternalIPv6(iface.address)) {
          if (!serverIpv6) serverIpv6 = iface.address;
        }
      }
    }
  } catch (_) {}
  return { serverIp: serverIp || null, serverIpv6: serverIpv6 || null };
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const DEFAULT_INDEX_PATH = path.join(__dirname, '..', '..', 'templates', 'default-site-index.html');

/** Common PHP extensions: id = phpenmod/phpdismod name, pkg = apt package suffix (php{V}-pkg). */
const COMMON_PHP_MODULES = [
  { id: 'curl', label: 'cURL' },
  { id: 'mbstring', label: 'MBString' },
  { id: 'xml', label: 'XML' },
  { id: 'zip', label: 'Zip' },
  { id: 'gd', label: 'GD' },
  { id: 'intl', label: 'Intl' },
  { id: 'bcmath', label: 'BCMath' },
  { id: 'soap', label: 'SOAP' },
  { id: 'imap', label: 'IMAP' },
  { id: 'exif', label: 'Exif' },
  { id: 'gettext', label: 'Gettext' },
  { id: 'redis', label: 'Redis' },
  { id: 'mysqli', label: 'MySQLi', pkg: 'mysql' },
  { id: 'pdo_mysql', label: 'PDO MySQL', pkg: 'mysql' }
];

function getPhpLoadedModules(version) {
  const loaded = new Set();
  try {
    const out = execFileSync('php' + version, ['-m'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    out.split(/\n/).forEach((line) => {
      const m = line.trim().toLowerCase();
      if (m && !m.startsWith('[')) loaded.add(m);
    });
  } catch (_) {}
  return loaded;
}

function getPhpModulesForVersion(version) {
  const loaded = getPhpLoadedModules(version);
  return COMMON_PHP_MODULES.map((m) => ({
    id: m.id,
    label: m.label,
    enabled: loaded.has(m.id)
  }));
}

/** Enable or disable one PHP-FPM module for a PHP version (no restart). Returns { ok, message }. */
function setPhpModuleFpm(version, modId, enable) {
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  const mod = COMMON_PHP_MODULES.find((m) => m.id === modId);
  if (!mod) return { ok: false, message: 'Unknown module' };
  const pkg = (mod.pkg || mod.id);
  try {
    if (enable) {
      try {
        execFileSync('phpenmod', ['-s', 'fpm', modId], { encoding: 'utf8', stdio: 'pipe', env });
      } catch (e) {
        if ((e.stderr || '').includes('Cannot find') || (e.stdout || '').includes('Cannot find')) {
          execFileSync('apt-get', ['install', '-y', '-qq', 'php' + version + '-' + pkg], { encoding: 'utf8', stdio: 'pipe', env, timeout: 120000 });
          execFileSync('phpenmod', ['-s', 'fpm', modId], { encoding: 'utf8', stdio: 'pipe', env });
        } else throw e;
      }
    } else {
      execFileSync('phpdismod', ['-s', 'fpm', modId], { encoding: 'utf8', stdio: 'pipe', env });
    }
    return { ok: true };
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || e.message || 'Failed';
    return { ok: false, message: msg.trim().slice(0, 300) };
  }
}

/** Resolve path under site docroot. Returns absolute path or null if outside docroot. */
function resolveDocrootPath(docroot, relativePath) {
  const root = path.resolve(docroot);
  const resolved = path.resolve(root, relativePath || '.');
  if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  return null;
}

/** Detect installed scripts (e.g. WordPress) under site docroot. Returns array of { id, name, subfolder, urlPath, version, adminPath }. */
function detectInstalledScripts(site) {
  const list = [];
  const root = path.resolve(site.docroot);
  if (!site.docroot) return list;
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return list;
  } catch (_) { return list; }

  function checkWordPress(dir, subfolder) {
    const wpConfig = path.join(dir, 'wp-config.php');
    const wpIncludes = path.join(dir, 'wp-includes');
    try {
      if (fs.existsSync(wpConfig) && fs.existsSync(wpIncludes)) {
        let version = null;
        const versionPhp = path.join(dir, 'wp-includes', 'version.php');
        if (fs.existsSync(versionPhp)) {
          const content = fs.readFileSync(versionPhp, 'utf8');
          const m = content.match(/\$wp_version\s*=\s*['"]([^'"]+)['"]/);
          if (m) version = m[1];
        }
        const urlPath = subfolder ? '/' + subfolder.replace(/\/+$/, '') + '/' : '/';
        list.push({
          id: 'wordpress',
          name: 'WordPress',
          subfolder: subfolder || null,
          urlPath,
          version,
          adminPath: urlPath.replace(/\/$/, '') + '/wp-admin'
        });
      }
    } catch (_) {}
  }

  checkWordPress(root, '');
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const subDir = path.join(root, e.name);
        checkWordPress(subDir, e.name);
      }
    }
  } catch (_) {}

  return list;
}

/** Detect if Node.js is installed and return version string (e.g. "v20.10.0") or null. */
function getNodeVersion() {
  try {
    const out = execSync('node --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const v = (out && out.trim()) || null;
    return v || null;
  } catch (_) {
    return null;
  }
}

/** PM2 app name for a Node site (used for start/restart/stop/logs). */
function getNodePm2Name(siteId) {
  return 'tinchohost-site-' + siteId;
}

/** Get PM2 status for a Node site app: 'running' | 'stopped' | 'not_found'. */
function getNodePm2Status(siteId) {
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.processes) ? parsed.processes : []);
    const name = getNodePm2Name(siteId);
    const proc = list.find(p => p && p.name === name);
    if (!proc) return 'not_found';
    return (proc.pm2_env && proc.pm2_env.status === 'online') ? 'running' : 'stopped';
  } catch (_) {
    return 'not_found';
  }
}

/** Get last N lines of PM2 logs for a Node site app. Returns string or null. */
function getNodePm2Logs(siteId, lines) {
  try {
    const name = getNodePm2Name(siteId);
    const out = execSync('pm2 logs ' + name.replace(/[^a-zA-Z0-9_-]/g, '') + ' --nostream --lines ' + (lines || 50), { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    return out || null;
  } catch (_) {
    return null;
  }
}

/** Resolve app work directory (docroot or docroot/subfolder). Returns null if invalid. */
function getNodeWorkDir(site, subfolder) {
  const raw = (subfolder || '').trim().replace(/^\/+/, '').replace(/\\/g, '');
  const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (raw !== safe) return null;
  return resolveDocrootPath(site.docroot, safe || '.');
}

/** Get docroot disk usage. Returns formatted string (e.g. "125 MB") or null. */
function getDocrootSizeFormatted(site) {
  if (!site || !site.docroot) return null;
  const root = path.resolve(site.docroot);
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
    const out = execFileSync('du', ['-sb', root], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const match = out.trim().match(/^(\d+)/);
    if (!match) return null;
    const bytes = parseInt(match[1], 10);
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + ' KB';
    return bytes + ' B';
  } catch (_) {
    return null;
  }
}

const SITE_ERROR_MESSAGES = {
  mysql_password: 'MySQL root password not set in Settings. Set it in Settings and click Save.'
};

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const o = {};
  if (rows) rows.forEach(r => {
    const k = r.key !== undefined ? r.key : r.KEY;
    const v = r.value !== undefined ? r.value : r.VALUE;
    if (k != null) o[k] = v;
  });
  return o;
}

router.get('/', async (req, res) => {
  const db = await getDb();
  const sites = db.prepare('SELECT * FROM sites ORDER BY domain').all();
  const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
  const phpVersions = (state?.php_versions || '8.2').split(',').filter(Boolean);
  const listWarning = req.session.sitesListWarning || null;
  if (req.session.sitesListWarning) delete req.session.sitesListWarning;
  res.render('sites/list', { sites, phpVersions, user: req.session?.user, listWarning });
});

router.get('/new', async (req, res) => {
  const db = await getDb();
  const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
  const phpVersions = (state?.php_versions || '8.2').split(',').filter(Boolean);
  const nodeVersion = getNodeVersion();
  res.render('sites/form', { site: null, phpVersions, nodeVersion });
});

router.post('/', async (req, res) => {
  const { domain, docroot, php_version, ssl, ftp_enabled, app_type, node_port, htaccess_compat } = req.body || {};
  if (!domain) return res.redirect('/sites/new');
  const appKind = app_type === 'node' ? 'node' : 'php';
  const portNum = node_port != null && node_port !== '' ? parseInt(node_port, 10) : null;
  if (appKind === 'node' && (portNum == null || isNaN(portNum) || portNum < 1 || portNum > 65535)) {
    const db = await getDb();
    const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
    const phpVersions = (state?.php_versions || '8.2').split(',').filter(Boolean);
    return res.render('sites/form', { site: null, phpVersions, nodeVersion: getNodeVersion(), error: 'Node app requires a valid port (1–65535).' });
  }
  const docrootPath = docroot || `/var/www/${domain}`;
  const db = await getDb();
  try {
    if (ssl) {
      try { await sslManager.obtainCert(domain); } catch (e) {
        return res.render('sites/form', { site: null, phpVersions: (db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get()?.php_versions || '8.2').split(',').filter(Boolean), nodeVersion: getNodeVersion(), error: 'SSL: ' + e.message });
      }
    }
    db.prepare('INSERT INTO sites (domain, docroot, php_version, ssl, ftp_enabled, app_type, node_port, htaccess_compat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      domain, docrootPath, appKind === 'php' ? (php_version || '8.2') : null, ssl ? 1 : 0, ftp_enabled ? 1 : 0, appKind, appKind === 'node' ? portNum : null, (appKind === 'php' && htaccess_compat) ? 1 : 0
    );
    const site = db.prepare('SELECT * FROM sites WHERE domain = ?').get(domain);
    const settings = getSettings(db);
    await siteManager.writeVhost(site, settings);
    try {
      execFileSync('mkdir', ['-p', docrootPath], { stdio: 'pipe' });
      execFileSync('chown', ['www-data:www-data', docrootPath], { stdio: 'pipe' });
      execFileSync('chmod', ['755', docrootPath], { stdio: 'pipe' });
      if (appKind !== 'node' && fs.existsSync(DEFAULT_INDEX_PATH)) {
        const html = fs.readFileSync(DEFAULT_INDEX_PATH, 'utf8').replace(/\{\{domain\}\}/g, domain);
        const indexFile = path.join(docrootPath, 'index.html');
        fs.writeFileSync(indexFile, html, 'utf8');
        execFileSync('chown', ['www-data:www-data', indexFile], { stdio: 'pipe' });
        execFileSync('chmod', ['644', indexFile], { stdio: 'pipe' });
      }
    } catch (docrootErr) {
      req.session.createDocrootWarning = 'Site created but the docroot directory could not be created or configured. Check path and permissions.';
    }
    siteManager.reloadNginx();
  } catch (e) {
    const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
    return res.render('sites/form', { site: null, phpVersions: (state?.php_versions || '8.2').split(',').filter(Boolean), nodeVersion: getNodeVersion(), error: e.message });
  }
  if (req.session.createDocrootWarning) {
    req.session.sitesListWarning = req.session.createDocrootWarning;
    delete req.session.createDocrootWarning;
  }
  res.redirect('/sites');
});

router.get('/:id/edit', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
  const phpVersions = (state?.php_versions || '8.2').split(',').filter(Boolean);
  const error = req.session.siteEditError || null;
  if (req.session.siteEditError) delete req.session.siteEditError;
  res.render('sites/form', { site, phpVersions, error, nodeVersion: getNodeVersion() });
});

router.get('/:id', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const siteDatabases = db.prepare('SELECT * FROM databases WHERE site_id = ? ORDER BY name').all(site.id);
  const databaseGrants = db.prepare(`
    SELECT g.database_id, g.db_user_id, g.privileges, u.username, u.password_plain FROM db_grants g
    JOIN db_users u ON u.id = g.db_user_id
    JOIN databases d ON d.id = g.database_id WHERE d.site_id = ?
  `).all(site.id);
  const ftpUsers = ftpManager.getFtpUsersBySite(db, site.id);
  const settings = getSettings(db);
  const newDbCredentials = req.session.newDbCredentials || null;
  const newFtpCredentials = req.session.newFtpCredentials || null;
  if (req.session.newDbCredentials) delete req.session.newDbCredentials;
  if (req.session.newFtpCredentials) delete req.session.newFtpCredentials;
  const errorMsg = (req.query.error && SITE_ERROR_MESSAGES[req.query.error]) || req.query.error || null;
  const panelDbPath = (req.query.error === 'mysql_password' ? getDbPath() : null) || null;
  const existingDbUsers = db.prepare('SELECT id, username FROM db_users ORDER BY username').all();
  let sslStatus = null;
  if (site.ssl) {
    try { sslStatus = sslManager.getCertStatus(site.domain); } catch (_) {}
  }
  const renew = req.query.renew || null;
  const sslRemoved = req.query.ssl === 'removed';
  const sslError = req.query.ssl === 'error' ? (req.query.msg ? decodeURIComponent(req.query.msg) : 'Remove failed') : null;
  const sslInstalled = req.query.ssl === 'installed';
  const sslInstallError = req.query.ssl === 'install_error' ? (req.query.msg ? decodeURIComponent(req.query.msg) : 'Install failed') : null;
  const wordpress = req.query.wordpress || null;
  const wp_folder = req.query.wp_folder || null;
  const phpOptionsSaved = req.query.php_options === 'saved';
  let databaseSizes = {};
  if (siteDatabases.length && getSetting(db, 'mysql_root_password')) {
    try {
      databaseSizes = await getDatabaseSizes(settings, siteDatabases.map(d => d.name));
    } catch (_) {}
  }
  const installedScripts = detectInstalledScripts(site);
  const docrootSizeFormatted = getDocrootSizeFormatted(site);
  const cloneOk = req.query.clone === 'ok';
  const cloneError = req.query.clone === 'error' ? (req.query.msg ? decodeURIComponent(req.query.msg) : 'Clone failed') : null;
  let nodePm2Status = null;
  let nodePm2Name = null;
  let envContent = '';
  if (site.app_type === 'node') {
    nodePm2Status = getNodePm2Status(site.id);
    nodePm2Name = getNodePm2Name(site.id);
    const envSubfolder = (req.query.env_subfolder || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '');
    const envWorkDir = getNodeWorkDir(site, envSubfolder);
    if (envWorkDir) {
      try {
        const envPath = path.join(envWorkDir, '.env');
        if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf8');
      } catch (_) {}
    }
  }
  const npmOk = req.query.npm === 'ok';
  const npmError = req.query.npm === 'error' ? (req.query.msg ? decodeURIComponent(req.query.msg) : null) : null;
  const envOk = req.query.env === 'ok';
  const envError = req.query.env === 'error' ? (req.query.msg ? decodeURIComponent(req.query.msg) : null) : null;
  const nodeStarted = req.query.node === 'started';
  const nodeRestarted = req.query.node === 'restarted';
  const nodeStopped = req.query.node === 'stopped';
  const nodeDeleted = req.query.node === 'deleted';
  const nodeError = req.query.node === 'error' ? (req.query.msg ? decodeURIComponent(req.query.msg) : null) : null;
  const currentEnvSubfolder = (req.query.env_subfolder || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '');
  const scriptUninstallOk = req.query.script_uninstall === 'ok';
  const scriptUninstallError = req.query.script_uninstall === 'error' ? (req.query.msg ? decodeURIComponent(req.query.msg) : null) : null;
  const repoUpdated = req.query.repo === 'updated';
  const repoError = req.query.repo === 'error' ? (req.query.msg ? decodeURIComponent(req.query.msg) : null) : null;
  const pullOk = req.query.pull === 'ok';
  const pullError = req.query.pull === 'error' ? (req.query.msg ? decodeURIComponent(req.query.msg) : null) : null;

  const { serverIp, serverIpv6 } = getServerIps(db);
  let dnsResolvedA = null;
  let dnsResolvedAAAA = null;
  let dnsPointsHere = false;
  try {
    const [v4, v6] = await Promise.all([
      dnsPromises.resolve4(site.domain).catch(() => []),
      dnsPromises.resolve6(site.domain).catch(() => [])
    ]);
    dnsResolvedA = Array.isArray(v4) && v4.length > 0 ? v4 : null;
    dnsResolvedAAAA = Array.isArray(v6) && v6.length > 0 ? v6 : null;
    const serverIps = [serverIp, serverIpv6].filter(Boolean);
    if (serverIps.length > 0 && (dnsResolvedA || dnsResolvedAAAA)) {
      const resolved = [...(dnsResolvedA || []), ...(dnsResolvedAAAA || [])];
      dnsPointsHere = resolved.some(addr => serverIps.includes(addr));
    }
  } catch (_) {}

  let phpModules = [];
  if (site.app_type !== 'node' && site.php_version) {
    phpModules = getPhpModulesForVersion(site.php_version);
  }

  const phpOptionsSaved = req.query.php_options === 'saved';
  const phpModulesSaved = req.query.php_modules === 'saved';
  const phpModulesError = req.query.php_modules === 'error' && req.query.msg ? decodeURIComponent(req.query.msg) : null;
  const phpRestartError = req.query.php_restart_error ? decodeURIComponent(req.query.php_restart_error) : null;

  res.render('sites/show', { site, siteDatabases, databaseGrants, ftpUsers, hasMysqlPassword: !!getSetting(db, 'mysql_root_password'), error: errorMsg, reset: req.query.reset, user: req.session.user, privilegeOptions: Object.keys(PRIVILEGE_SETS), newDbCredentials, newFtpCredentials, panelDbPath, existingDbUsers, sslStatus, renew, sslRemoved, sslError, sslInstalled, sslInstallError, wordpress, wp_folder, phpOptionsSaved, phpModulesSaved, phpModulesError, phpRestartError, phpModules, databaseSizes, installedScripts, docrootSizeFormatted, cloneOk, cloneError, repoUpdated, repoError, pullOk, pullError, nodePm2Status, nodePm2Name, envContent, npmOk, npmError, envOk, envError, nodeStarted, nodeRestarted, nodeStopped, nodeDeleted, nodeError, currentEnvSubfolder, scriptUninstallOk, scriptUninstallError, serverIp, serverIpv6, dnsResolvedA, dnsResolvedAAAA, dnsPointsHere });
});

router.post('/:id/ssl/renew', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || !site.ssl) return res.redirect('/sites/' + (site ? site.id : ''));
  try {
    await sslManager.renewCert(site.domain);
    siteManager.reloadNginx();
    res.redirect('/sites/' + site.id + '?renew=ok#ssl');
  } catch (_) {
    res.redirect('/sites/' + site.id + '?renew=error#ssl');
  }
});

router.post('/:id/ssl/delete', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || !site.ssl) return res.redirect('/sites/' + (site ? site.id : ''));
  try {
    await sslManager.deleteCert(site.domain);
    db.prepare('UPDATE sites SET ssl = 0 WHERE id = ?').run(site.id);
    const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
    const settings = getSettings(db);
    await siteManager.writeVhost(updated, settings);
    siteManager.reloadNginx();
    res.redirect('/sites/' + site.id + '?ssl=removed#ssl');
  } catch (e) {
    res.redirect('/sites/' + site.id + '?ssl=error&msg=' + encodeURIComponent((e && e.message) ? e.message : 'Remove failed') + '#ssl');
  }
});

router.post('/:id/ssl/install', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  if (site.ssl) return res.redirect('/sites/' + site.id + '#ssl');
  try {
    await sslManager.obtainCert(site.domain);
    db.prepare('UPDATE sites SET ssl = 1 WHERE id = ?').run(site.id);
    const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
    const settings = getSettings(db);
    await siteManager.writeVhost(updated, settings);
    siteManager.reloadNginx();
    res.redirect('/sites/' + site.id + '?ssl=installed#ssl');
  } catch (e) {
    res.redirect('/sites/' + site.id + '?ssl=install_error&msg=' + encodeURIComponent((e && e.message) ? e.message : 'Install failed') + '#ssl');
  }
});

router.post('/:id/clone', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  if (site.app_type !== 'node') return res.redirect('/sites/' + site.id + '?clone=error&msg=' + encodeURIComponent('Clone is only available for Node sites') + '#node-apps');
  const repoUrl = (req.body.repo_url || '').trim();
  if (!repoUrl) return res.redirect('/sites/' + site.id + '?clone=error&msg=' + encodeURIComponent('Repository URL is required') + '#node-apps');
  const branch = (req.body.branch || '').trim().replace(/[^a-zA-Z0-9/_.-]/g, '');
  const rawSubfolder = (req.body.target || '').trim().replace(/^\/+/, '').replace(/\\/g, '');
  const subfolder = rawSubfolder.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (rawSubfolder !== subfolder) return res.redirect('/sites/' + site.id + '?clone=error&msg=' + encodeURIComponent('Invalid subfolder name') + '#node-apps');
  const docroot = path.resolve(site.docroot);
  let targetPath;
  if (!subfolder) {
    try {
      if (!fs.existsSync(docroot)) fs.mkdirSync(docroot, { recursive: true });
      if (fs.readdirSync(docroot).length > 0) return res.redirect('/sites/' + site.id + '?clone=error&msg=' + encodeURIComponent('Docroot is not empty; clear it or use a subfolder') + '#node-apps');
    } catch (e) { return res.redirect('/sites/' + site.id + '?clone=error&msg=' + encodeURIComponent(e.message || 'Docroot not accessible') + '#node-apps'); }
    targetPath = docroot;
  } else {
    targetPath = resolveDocrootPath(site.docroot, subfolder);
    if (!targetPath) return res.redirect('/sites/' + site.id + '?clone=error&msg=' + encodeURIComponent('Invalid path') + '#node-apps');
    if (fs.existsSync(targetPath)) return res.redirect('/sites/' + site.id + '?clone=error&msg=' + encodeURIComponent('Subfolder already exists') + '#node-apps');
  }
  const safeUrl = repoUrl.replace(/[\0-\x1f\x7f]/g, '');
  try {
    const args = ['clone'];
    if (branch) args.push('-b', branch);
    args.push('--', safeUrl, targetPath);
    execFileSync('git', args, { stdio: 'pipe', timeout: 120000 });
    execFileSync('chown', ['-R', 'www-data:www-data', targetPath], { stdio: 'pipe' });
    const safeRepoUrl = safeUrl.slice(0, 2048);
    db.prepare('UPDATE sites SET clone_repo_url = ?, clone_branch = ?, clone_subfolder = ? WHERE id = ?').run(
      safeRepoUrl || null, branch || null, subfolder || null, site.id
    );
    res.redirect('/sites/' + site.id + '?clone=ok#node-apps');
  } catch (e) {
    const msg = (e.message || 'Clone failed').toString().slice(0, 200);
    res.redirect('/sites/' + site.id + '?clone=error&msg=' + encodeURIComponent(msg) + '#node-apps');
  }
});

router.post('/:id/repo/update', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || site.app_type !== 'node') return res.redirect('/sites/' + (site ? site.id : ''));
  const repoUrl = (req.body.repo_url || '').trim();
  const branch = (req.body.branch || '').trim().replace(/[^a-zA-Z0-9/_.-]/g, '');
  if (!repoUrl) return res.redirect('/sites/' + site.id + '?repo=error&msg=' + encodeURIComponent('Repository URL is required') + '#node-apps');
  const cloneSubfolder = (site.clone_subfolder != null && site.clone_subfolder !== '') ? String(site.clone_subfolder) : '';
  const workDir = getNodeWorkDir(site, cloneSubfolder);
  if (!workDir || !fs.existsSync(workDir)) return res.redirect('/sites/' + site.id + '?repo=error&msg=' + encodeURIComponent('Clone directory not found') + '#node-apps');
  const gitDir = path.join(workDir, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return res.redirect('/sites/' + site.id + '?repo=error&msg=' + encodeURIComponent('Not a git repository') + '#node-apps');
  const safeUrl = repoUrl.replace(/[\0-\x1f\x7f]/g, '').slice(0, 2048);
  try {
    db.prepare('UPDATE sites SET clone_repo_url = ?, clone_branch = ? WHERE id = ?').run(safeUrl, branch || null, site.id);
    execFileSync('git', ['remote', 'set-url', 'origin', safeUrl], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['fetch', 'origin'], { cwd: workDir, stdio: 'pipe', timeout: 60000 });
    if (branch) {
      execFileSync('git', ['checkout', branch], { cwd: workDir, stdio: 'pipe' });
      execFileSync('git', ['branch', '--set-upstream-to', 'origin/' + branch, branch], { cwd: workDir, stdio: 'pipe' });
    }
    res.redirect('/sites/' + site.id + '?repo=updated#node-apps');
  } catch (e) {
    const msg = (e.message || 'Update failed').toString().slice(0, 200);
    res.redirect('/sites/' + site.id + '?repo=error&msg=' + encodeURIComponent(msg) + '#node-apps');
  }
});

router.post('/:id/repo/pull', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || site.app_type !== 'node') return res.redirect('/sites/' + (site ? site.id : ''));
  const cloneSubfolder = (site.clone_subfolder != null && site.clone_subfolder !== '') ? String(site.clone_subfolder) : '';
  const workDir = getNodeWorkDir(site, cloneSubfolder);
  if (!workDir || !fs.existsSync(workDir)) return res.redirect('/sites/' + site.id + '?pull=error&msg=' + encodeURIComponent('Clone directory not found') + '#node-apps');
  const gitDir = path.join(workDir, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return res.redirect('/sites/' + site.id + '?pull=error&msg=' + encodeURIComponent('Not a git repository') + '#node-apps');
  try {
    execFileSync('git', ['fetch', 'origin'], { cwd: workDir, stdio: 'pipe', timeout: 60000 });
    const branch = (site.clone_branch && String(site.clone_branch).trim()) || null;
    if (branch) {
      execFileSync('git', ['checkout', branch], { cwd: workDir, stdio: 'pipe' });
      execFileSync('git', ['pull', 'origin', branch], { cwd: workDir, stdio: 'pipe', timeout: 60000 });
    } else {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (currentBranch) execFileSync('git', ['pull', 'origin', currentBranch], { cwd: workDir, stdio: 'pipe', timeout: 60000 });
    }
    execFileSync('chown', ['-R', 'www-data:www-data', workDir], { stdio: 'pipe' });
    res.redirect('/sites/' + site.id + '?pull=ok#node-apps');
  } catch (e) {
    const msg = (e.message || 'Pull failed').toString().slice(0, 200);
    res.redirect('/sites/' + site.id + '?pull=error&msg=' + encodeURIComponent(msg) + '#node-apps');
  }
});

router.post('/:id/npm-install', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || site.app_type !== 'node') return res.redirect('/sites/' + (site ? site.id : ''));
  const workDir = getNodeWorkDir(site, req.body.subfolder);
  if (!workDir || !fs.existsSync(workDir)) return res.redirect('/sites/' + site.id + '?npm=error&msg=' + encodeURIComponent('Invalid or missing app directory') + '#node-apps');
  try {
    execSync('npm install --production', { cwd: workDir, encoding: 'utf8', stdio: 'pipe', timeout: 300000 });
    execFileSync('chown', ['-R', 'www-data:www-data', workDir], { stdio: 'pipe' });
    res.redirect('/sites/' + site.id + '?npm=ok#node-apps');
  } catch (e) {
    const msg = (e.message || 'npm install failed').toString().slice(0, 200);
    res.redirect('/sites/' + site.id + '?npm=error&msg=' + encodeURIComponent(msg) + '#node-apps');
  }
});

router.get('/:id/npm-install-stream', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || site.app_type !== 'node') return res.status(400).send('Invalid site');
  const subfolder = (req.query.subfolder || '').trim().replace(/^\/+/, '').replace(/\\/g, '');
  const workDir = getNodeWorkDir(site, subfolder);
  if (!workDir || !fs.existsSync(workDir)) return res.status(400).send('Invalid or missing app directory');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const proc = spawn('npm', ['install', '--production'], { cwd: workDir, timeout: 300000 });
  proc.stdout.on('data', (chunk) => res.write(chunk));
  proc.stderr.on('data', (chunk) => res.write(chunk));
  proc.on('error', (err) => {
    res.write('\nError: ' + (err.message || 'spawn failed') + '\n');
    res.write('DONE:1\n');
    res.end();
  });
  proc.on('close', (code) => {
    if (code === 0) {
      try { execFileSync('chown', ['-R', 'www-data:www-data', workDir], { stdio: 'pipe' }); } catch (_) {}
    }
    res.write('\n\nDONE:' + (code || 1) + '\n');
    res.end();
  });
});

router.post('/:id/env', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || site.app_type !== 'node') return res.redirect('/sites/' + (site ? site.id : ''));
  const workDir = getNodeWorkDir(site, req.body.subfolder);
  if (!workDir) return res.redirect('/sites/' + site.id + '?env=error&msg=' + encodeURIComponent('Invalid path') + '#node-apps');
  const content = (req.body.env_content != null ? req.body.env_content : '').toString();
  const envPath = path.join(workDir, '.env');
  try {
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
      execFileSync('chown', ['www-data:www-data', workDir], { stdio: 'pipe' });
    }
    fs.writeFileSync(envPath, content, 'utf8');
    execFileSync('chown', ['www-data:www-data', envPath], { stdio: 'pipe' });
    res.redirect('/sites/' + site.id + '?env=ok#node-apps');
  } catch (e) {
    res.redirect('/sites/' + site.id + '?env=error&msg=' + encodeURIComponent((e.message || 'Save failed').slice(0, 150)) + '#node-apps');
  }
});

router.post('/:id/node-start', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || site.app_type !== 'node') return res.redirect('/sites/' + (site ? site.id : ''));
  const workDir = getNodeWorkDir(site, req.body.subfolder);
  if (!workDir || !fs.existsSync(workDir)) return res.redirect('/sites/' + site.id + '?node=error&msg=' + encodeURIComponent('Invalid or missing app directory') + '#node-apps');
  const name = getNodePm2Name(site.id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return res.redirect('/sites/' + site.id + '?node=error&msg=' + encodeURIComponent('Invalid app name') + '#node-apps');
  const port = site.node_port != null ? String(site.node_port) : '3000';
  try {
    try { execFileSync('pm2', ['delete', name], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (_) {}
    const env = { ...process.env, PORT: port };
    execFileSync('pm2', ['start', 'npm', '--name', name, '--', 'run', 'start'], { cwd: workDir, env, stdio: 'pipe', timeout: 15000 });
    execSync('pm2 save', { stdio: 'pipe' });
    res.redirect('/sites/' + site.id + '?node=started#node-apps');
  } catch (e) {
    const msg = (e.message || 'Start failed').toString().slice(0, 200);
    res.redirect('/sites/' + site.id + '?node=error&msg=' + encodeURIComponent(msg) + '#node-apps');
  }
});

router.post('/:id/node-restart', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || site.app_type !== 'node') return res.redirect('/sites/' + (site ? site.id : ''));
  const name = getNodePm2Name(site.id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return res.redirect('/sites/' + site.id + '?node=error&msg=' + encodeURIComponent('Invalid app name') + '#node-apps');
  try {
    execFileSync('pm2', ['restart', name], { stdio: 'pipe', timeout: 10000 });
    execSync('pm2 save', { stdio: 'pipe' });
    res.redirect('/sites/' + site.id + '?node=restarted#node-apps');
  } catch (e) {
    res.redirect('/sites/' + site.id + '?node=error&msg=' + encodeURIComponent((e.message || 'Restart failed').slice(0, 200)) + '#node-apps');
  }
});

router.post('/:id/node-stop', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || site.app_type !== 'node') return res.redirect('/sites/' + (site ? site.id : ''));
  const name = getNodePm2Name(site.id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return res.redirect('/sites/' + site.id + '?node=error&msg=' + encodeURIComponent('Invalid app name') + '#node-apps');
  try {
    execFileSync('pm2', ['stop', name], { stdio: 'pipe' });
    execSync('pm2 save', { stdio: 'pipe' });
    res.redirect('/sites/' + site.id + '?node=stopped#node-apps');
  } catch (e) {
    res.redirect('/sites/' + site.id + '?node=error&msg=' + encodeURIComponent((e.message || 'Stop failed').slice(0, 200)) + '#node-apps');
  }
});

router.post('/:id/node-delete', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site || site.app_type !== 'node') return res.redirect('/sites/' + (site ? site.id : ''));
  const name = getNodePm2Name(site.id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return res.redirect('/sites/' + site.id + '?node=error&msg=' + encodeURIComponent('Invalid app name') + '#node-apps');
  try {
    try { execFileSync('pm2', ['delete', name], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (_) {}
    execSync('pm2 save', { stdio: 'pipe' });
    res.redirect('/sites/' + site.id + '?node=deleted#node-apps');
  } catch (e) {
    res.redirect('/sites/' + site.id + '?node=error&msg=' + encodeURIComponent((e.message || 'Delete failed').slice(0, 200)) + '#node-apps');
  }
});

router.get('/:id/node-logs', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  if (site.app_type !== 'node') return res.redirect('/sites/' + site.id);
  const lines = Math.min(200, parseInt(req.query.lines, 10) || 80);
  const logs = getNodePm2Logs(site.id, lines);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(logs != null ? logs : 'No logs (app may not be running under PM2).');
});

router.post('/:id/scripts/uninstall', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const scriptId = (req.body.script_id || '').trim();
  const rawSubfolder = (req.body.subfolder || '').trim().replace(/^\/+/, '').replace(/\\/g, '');
  const subfolder = rawSubfolder.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (rawSubfolder !== subfolder) return res.redirect('/sites/' + site.id + '?script_uninstall=error&msg=' + encodeURIComponent('Invalid subfolder') + '#scripts');
  const docrootResolved = path.resolve(site.docroot);
  const targetPath = resolveDocrootPath(site.docroot, subfolder || '.');
  if (!targetPath || !fs.existsSync(targetPath)) return res.redirect('/sites/' + site.id + '?script_uninstall=error&msg=' + encodeURIComponent('Invalid or missing path') + '#scripts');
  if (scriptId === 'wordpress') {
    const wpConfig = path.join(targetPath, 'wp-config.php');
    const wpIncludes = path.join(targetPath, 'wp-includes');
    if (!fs.existsSync(wpConfig) || !fs.existsSync(wpIncludes)) return res.redirect('/sites/' + site.id + '?script_uninstall=error&msg=' + encodeURIComponent('WordPress not found at this location') + '#scripts');
    if (targetPath === docrootResolved) return res.redirect('/sites/' + site.id + '?script_uninstall=error&msg=' + encodeURIComponent('Uninstall from site root is not supported; use File Manager to remove files') + '#scripts');
    try {
      fs.rmSync(targetPath, { recursive: true });
      res.redirect('/sites/' + site.id + '?script_uninstall=ok#scripts');
    } catch (e) {
      res.redirect('/sites/' + site.id + '?script_uninstall=error&msg=' + encodeURIComponent((e.message || 'Uninstall failed').slice(0, 150)) + '#scripts');
    }
    return;
  }
  res.redirect('/sites/' + site.id + '?script_uninstall=error&msg=' + encodeURIComponent('Unknown script') + '#scripts');
});

router.post('/:id/scripts/wordpress', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const rawFolder = (req.body.folder || '').trim().replace(/^\/+/, '').replace(/\\/g, '');
  const folder = rawFolder.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (rawFolder !== folder) return res.redirect('/sites/' + site.id + '?wordpress=error&msg=invalid#scripts');
  const targetDir = resolveDocrootPath(site.docroot, folder || '.');
  if (!targetDir) return res.redirect('/sites/' + site.id + '?wordpress=error&msg=invalid#scripts');
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
    const zipPath = path.join(tmpDir, 'latest.zip');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(zipPath);
      https.get('https://wordpress.org/latest.zip', (resp) => {
        if (resp.statusCode !== 200) return reject(new Error('Download failed'));
        resp.pipe(file);
        file.on('finish', () => { file.close(resolve); });
      }).on('error', reject);
    });
    execSync('unzip -o -q ' + zipPath.replace(/ /g, '\\ ') + ' -d ' + tmpDir.replace(/ /g, '\\ '), { stdio: 'pipe' });
    const wpDir = path.join(tmpDir, 'wordpress');
    if (!fs.existsSync(wpDir)) throw new Error('Invalid zip');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const entries = fs.readdirSync(wpDir, { withFileTypes: true });
    for (const e of entries) {
      const src = path.join(wpDir, e.name);
      const dest = path.join(targetDir, e.name);
      if (e.isDirectory()) fs.cpSync(src, dest, { recursive: true });
      else fs.copyFileSync(src, dest);
    }
    execFileSync('chown', ['-R', 'www-data:www-data', targetDir], { stdio: 'pipe' });
  } catch (e) {
    if (tmpDir && fs.existsSync(tmpDir)) try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
    return res.redirect('/sites/' + site.id + '?wordpress=error&msg=install#scripts');
  }
  if (tmpDir && fs.existsSync(tmpDir)) try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
  res.redirect('/sites/' + site.id + '?wordpress=installed&wp_folder=' + encodeURIComponent(folder) + '#scripts');
});

router.get('/:id/files/api/entries', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const relativePath = (req.query.path || '').replace(/^\/+/, '');
  const dirPath = resolveDocrootPath(site.docroot, relativePath);
  if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return res.json({ entries: [] });
  const entries = [];
  try {
    const names = fs.readdirSync(dirPath);
    for (const name of names) {
      const full = path.join(dirPath, name);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      entries.push({ name, dir: stat.isDirectory(), size: stat.isFile() ? stat.size : null });
    }
    entries.sort((a, b) => (a.dir === b.dir) ? (a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : (a.dir ? -1 : 1));
  } catch (_) {}
  res.json({ entries });
});

router.get('/:id/files', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const relativePath = (req.query.path || '').replace(/^\/+/, '');
  const dirPath = resolveDocrootPath(site.docroot, relativePath);
  let entries = [];
  let errorMsg = null;
  if (!dirPath) {
    errorMsg = 'Invalid path';
  } else if (!fs.existsSync(dirPath)) {
    errorMsg = 'Directory does not exist';
  } else if (!fs.statSync(dirPath).isDirectory()) {
    errorMsg = 'Not a directory';
  } else {
    try {
      const names = fs.readdirSync(dirPath);
      for (const name of names) {
        const full = path.join(dirPath, name);
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }
        entries.push({ name, dir: stat.isDirectory(), size: stat.isFile() ? stat.size : null });
      }
      entries.sort((a, b) => (a.dir === b.dir) ? (a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : (a.dir ? -1 : 1));
    } catch (e) {
      errorMsg = e.message || 'Cannot read directory';
    }
  }
  const pathSegments = relativePath ? relativePath.split(path.sep).filter(Boolean) : [];
  const parentPath = pathSegments.length > 0 ? pathSegments.slice(0, -1).join(path.sep) : '';
  const queryError = req.query.error === 'invalid' ? 'Invalid path or name.' : (req.query.error === 'upload' ? 'Upload failed.' : null);
  res.render('sites/files', { site, currentPath: relativePath, pathSegments, parentPath, entries, error: errorMsg || queryError, pathSep: path.sep, user: req.session.user });
});

router.get('/:id/files/download', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).send('Not found');
  const relativePath = (req.query.path || '').replace(/^\/+/, '');
  const filePath = resolveDocrootPath(site.docroot, relativePath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(400).send('Invalid or not a file');
  res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(filePath).replace(/"/g, '\\"') + '"');
  res.sendFile(filePath);
});

const EDITABLE_EXTENSIONS = new Set(['.txt', '.html', '.htm', '.css', '.js', '.json', '.php', '.md', '.xml', '.yml', '.yaml', '.env', '.htaccess', '.ini', '.conf', '.sh', '.bat', '.sql', '.log', '.csv', '.svg', '.vue', '.ts', '.tsx', '.jsx', '.scss', '.sass', '.less', '.ejs', '.tpl', '.twig', '.py', '.rb', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.java', '.kt', '.rss', '.atom', '.map', '.lock', '.gitignore', '.editorconfig', '.htpasswd']);

function isEditableExtension(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return EDITABLE_EXTENSIONS.has(ext) || EDITABLE_EXTENSIONS.has(relativePath.toLowerCase());
}

router.get('/:id/files/content', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const relativePath = (req.query.path || '').replace(/^\/+/, '');
  const filePath = resolveDocrootPath(site.docroot, relativePath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(400).json({ error: 'Invalid or not a file' });
  if (!isEditableExtension(relativePath)) return res.status(400).json({ error: 'This file type cannot be edited as text' });
  try {
    const raw = fs.readFileSync(filePath);
    if (raw.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'File is too large to edit (max 2 MB)' });
    const sample = raw.length > 8192 ? raw.subarray(0, 8192) : raw;
    if (sample.indexOf(0) !== -1) return res.status(400).json({ error: 'File appears to be binary and cannot be edited' });
    const content = raw.toString('utf8');
    res.json({ content, path: relativePath });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not read file' });
  }
});

router.post('/:id/files/save', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const relativePath = (req.body.path || '').replace(/^\/+/, '');
  const content = typeof req.body.content === 'string' ? req.body.content : '';
  const filePath = resolveDocrootPath(site.docroot, relativePath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(400).json({ error: 'Invalid or not a file' });
  if (!isEditableExtension(relativePath)) return res.status(400).json({ error: 'This file type cannot be edited' });
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    execFileSync('chown', ['www-data:www-data', filePath], { stdio: 'pipe' });
    res.json({ ok: true, path: relativePath });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not save file' });
  }
});

router.post('/:id/files/mkdir', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const { path: dirPath, name } = req.body || {};
  const base = resolveDocrootPath(site.docroot, (dirPath || '').replace(/^\/+/, ''));
  if (!base || !name || /[\/\\]/.test(name)) return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(dirPath || '') + '&error=invalid');
  const full = path.join(base, name);
  if (resolveDocrootPath(site.docroot, path.relative(site.docroot, full)) === null) return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(dirPath || '') + '&error=invalid');
  try {
    fs.mkdirSync(full, { recursive: false });
    execFileSync('chown', ['www-data:www-data', full], { stdio: 'pipe' });
  } catch (_) {}
  res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent((dirPath ? dirPath + path.sep : '') + name));
});

router.post('/:id/files/delete', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const relativePath = (req.body.path || '').replace(/^\/+/, '');
  const full = resolveDocrootPath(site.docroot, relativePath);
  if (!full || full === path.resolve(site.docroot)) return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(path.dirname(relativePath) || '') + '&error=invalid');
  try {
    fs.rmSync(full, { recursive: true });
  } catch (_) {}
  const parent = path.dirname(relativePath);
  res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(parent === '.' ? '' : parent));
});

function normalizePathsBody(body) {
  const p = body.paths;
  if (Array.isArray(p)) return p.filter(Boolean).map(String).map(s => s.replace(/^\/+/, ''));
  if (p != null && p !== '') return [String(p).replace(/^\/+/, '')];
  return [];
}

router.post('/:id/files/bulk-delete', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const currentPath = (req.body.currentPath || '').replace(/^\/+/, '');
  const baseDir = resolveDocrootPath(site.docroot, currentPath);
  if (!baseDir) return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(currentPath) + '&error=invalid');
  const paths = normalizePathsBody(req.body);
  const docrootResolved = path.resolve(site.docroot);
  for (const rel of paths) {
    const full = resolveDocrootPath(site.docroot, rel);
    if (!full || full === docrootResolved) continue;
    try { fs.rmSync(full, { recursive: true }); } catch (_) {}
  }
  res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(currentPath));
});

router.post('/:id/files/bulk-move', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const currentPath = (req.body.currentPath || '').replace(/^\/+/, '');
  const destRel = (req.body.destination || '').trim().replace(/^\/+/, '').replace(/\\/g, path.sep);
  const paths = normalizePathsBody(req.body);
  const docrootResolved = path.resolve(site.docroot);
  const destDir = resolveDocrootPath(site.docroot, destRel);
  if (!destDir || !fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
    return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(currentPath) + '&error=invalid');
  }
  for (const rel of paths) {
    const full = resolveDocrootPath(site.docroot, rel);
    if (!full || full === docrootResolved) continue;
    const name = path.basename(full);
    const target = path.join(destDir, name);
    if (target === full) continue;
    if (resolveDocrootPath(site.docroot, path.relative(site.docroot, target)) === null) continue;
    try {
      fs.renameSync(full, target);
      if (fs.statSync(target).isDirectory()) execFileSync('chown', ['-R', 'www-data:www-data', target], { stdio: 'pipe' });
      else execFileSync('chown', ['www-data:www-data', target], { stdio: 'pipe' });
    } catch (_) {}
  }
  res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(currentPath));
});

router.post('/:id/files/bulk-copy', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const currentPath = (req.body.currentPath || '').replace(/^\/+/, '');
  const destRel = (req.body.destination || '').trim().replace(/^\/+/, '').replace(/\\/g, path.sep);
  const paths = normalizePathsBody(req.body);
  const docrootResolved = path.resolve(site.docroot);
  const destDir = resolveDocrootPath(site.docroot, destRel);
  if (!destDir || !fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
    return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(currentPath) + '&error=invalid');
  }
  for (const rel of paths) {
    const full = resolveDocrootPath(site.docroot, rel);
    if (!full || full === docrootResolved) continue;
    const name = path.basename(full);
    const target = path.join(destDir, name);
    if (target === full) continue;
    if (resolveDocrootPath(site.docroot, path.relative(site.docroot, target)) === null) continue;
    try {
      fs.cpSync(full, target, { recursive: true });
      execFileSync('chown', ['-R', 'www-data:www-data', target], { stdio: 'pipe' });
    } catch (_) {}
  }
  res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(currentPath));
});

router.post('/:id/files/rename', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const { path: dirPath, name: currentName, newName } = req.body || {};
  const dirPathNorm = (dirPath || '').replace(/^\/+/, '');
  const base = resolveDocrootPath(site.docroot, dirPathNorm);
  if (!base || !currentName || !newName || /[\/\\]/.test(currentName) || /[\/\\]/.test(newName)) return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(dirPathNorm) + '&error=invalid');
  const relOld = dirPathNorm ? dirPathNorm + path.sep + currentName : currentName;
  const fullOld = resolveDocrootPath(site.docroot, relOld);
  if (!fullOld) return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(dirPathNorm) + '&error=invalid');
  const fullNew = path.join(path.dirname(fullOld), newName);
  if (resolveDocrootPath(site.docroot, path.relative(site.docroot, fullNew)) === null) return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(dirPathNorm) + '&error=invalid');
  try {
    fs.renameSync(fullOld, fullNew);
    if (fs.statSync(fullNew).isDirectory()) execFileSync('chown', ['-R', 'www-data:www-data', fullNew], { stdio: 'pipe' });
    else execFileSync('chown', ['www-data:www-data', fullNew], { stdio: 'pipe' });
  } catch (_) {}
  res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(dirPathNorm));
});

router.post('/:id/files/upload', upload.single('file'), async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const dirPath = (req.body.path || '').replace(/^\/+/, '');
  const base = resolveDocrootPath(site.docroot, dirPath);
  if (!base || !req.file) return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(dirPath) + '&error=upload');
  const name = (req.file.originalname || 'upload').replace(/\.\./g, '').replace(/^\/+/, '');
  const full = path.join(base, name || 'upload');
  if (resolveDocrootPath(site.docroot, path.relative(site.docroot, full)) === null) return res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(dirPath) + '&error=invalid');
  try {
    fs.writeFileSync(full, req.file.buffer);
    execFileSync('chown', ['www-data:www-data', full], { stdio: 'pipe' });
  } catch (_) {}
  res.redirect('/sites/' + site.id + '/files?path=' + encodeURIComponent(dirPath));
});

router.post('/:id/php-options', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const opts = {};
  const common = ['memory_limit', 'upload_max_filesize', 'max_execution_time', 'post_max_size', 'max_input_vars'];
  for (const k of common) {
    const v = (req.body[k] || '').trim();
    if (v) opts[k] = v.replace(/[\r\n"\\]/g, '');
  }
  const extra = (req.body.extra_options || '').trim().split(/\r?\n/);
  for (const line of extra) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim().replace(/[^a-zA-Z0-9_.]/g, '');
    const v = line.slice(idx + 1).trim().replace(/[\r\n"\\]/g, '');
    if (k) opts[k] = v;
  }
  const php_options = Object.keys(opts).length ? JSON.stringify(opts) : null;
  db.prepare('UPDATE sites SET php_options = ? WHERE id = ?').run(php_options, req.params.id);
  const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  const settings = getSettings(db);
  await siteManager.writeVhost(updated, settings);
  siteManager.reloadNginx();
  if (site.app_type !== 'node' && site.php_version) {
    const restart = servicesManager.restartService('php' + site.php_version + '-fpm');
    if (!restart.ok) {
      return res.redirect('/sites/' + site.id + '?php_options=saved&php_restart_error=' + encodeURIComponent(restart.message || 'PHP-FPM restart failed') + '#php');
    }
  }
  res.redirect('/sites/' + site.id + '?php_options=saved#php');
});

router.post('/:id/php-modules', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  if (site.app_type === 'node' || !site.php_version) return res.redirect('/sites/' + site.id + '#php');
  const version = site.php_version;
  const enabledIds = new Set(
    COMMON_PHP_MODULES.filter((m) => req.body['module_' + m.id] === 'on').map((m) => m.id)
  );
  const loaded = getPhpLoadedModules(version);
  const toEnable = enabledIds.size ? [...enabledIds].filter((id) => !loaded.has(id)) : [];
  const toDisable = COMMON_PHP_MODULES.filter((m) => loaded.has(m.id) && !enabledIds.has(m.id)).map((m) => m.id);
  for (const id of toEnable) {
    const r = setPhpModuleFpm(version, id, true);
    if (!r.ok) return res.redirect('/sites/' + site.id + '?php_modules=error&msg=' + encodeURIComponent(r.message) + '#php');
  }
  for (const id of toDisable) {
    const r = setPhpModuleFpm(version, id, false);
    if (!r.ok) return res.redirect('/sites/' + site.id + '?php_modules=error&msg=' + encodeURIComponent(r.message) + '#php');
  }
  if (toEnable.length || toDisable.length) {
    const restart = servicesManager.restartService('php' + version + '-fpm');
    if (!restart.ok) return res.redirect('/sites/' + site.id + '?php_modules=error&msg=' + encodeURIComponent(restart.message || 'PHP-FPM restart failed') + '#php');
  }
  res.redirect('/sites/' + site.id + '?php_modules=saved#php');
});

router.post('/:id', async (req, res) => {
  const { domain, docroot, php_version, ssl, ftp_enabled, app_type, node_port, htaccess_compat } = req.body || {};
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const appKind = app_type === 'node' ? 'node' : 'php';
  const portNum = node_port != null && node_port !== '' ? parseInt(node_port, 10) : null;
  if (appKind === 'node' && (portNum == null || isNaN(portNum) || portNum < 1 || portNum > 65535)) {
    const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
    return res.render('sites/form', { site: { ...site, domain: domain || site.domain, docroot: docroot || site.docroot, php_version: site.php_version, app_type: 'node' }, phpVersions: (state?.php_versions || '8.2').split(',').filter(Boolean), nodeVersion: getNodeVersion(), error: 'Node app requires a valid port (1–65535).' });
  }
  const dom = domain || site.domain;
  if (ssl && !site.ssl) {
    try { await sslManager.obtainCert(dom); } catch (e) {
      const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
      return res.render('sites/form', { site: { ...site, domain: dom, docroot: docroot || site.docroot, php_version: php_version || site.php_version, app_type: appKind, node_port: appKind === 'node' ? portNum : site.node_port }, phpVersions: (state?.php_versions || '8.2').split(',').filter(Boolean), nodeVersion: getNodeVersion(), error: 'SSL: ' + e.message });
    }
  }
  db.prepare('UPDATE sites SET domain = ?, docroot = ?, php_version = ?, ssl = ?, ftp_enabled = ?, app_type = ?, node_port = ?, htaccess_compat = ? WHERE id = ?').run(
    dom, docroot || site.docroot, appKind === 'php' ? (php_version || site.php_version) : null, ssl ? 1 : 0, ftp_enabled ? 1 : 0, appKind, appKind === 'node' ? portNum : null, (appKind === 'php' && htaccess_compat) ? 1 : 0, req.params.id
  );
  const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  const settings = getSettings(db);
  try {
    await siteManager.writeVhost(updated, settings);
    siteManager.reloadNginx();
    res.redirect('/sites/' + req.params.id + (appKind === 'node' ? '#node-apps' : ''));
  } catch (e) {
    req.session.siteEditError = (e && e.message) ? e.message : 'Nginx config or reload failed. Site record was updated.';
    res.redirect('/sites/' + req.params.id + '/edit');
  }
});

router.post('/:id/delete', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (site) {
    const settings = getSettings(db);
    siteManager.removeVhost(site, settings);
    db.prepare('DELETE FROM ftp_users WHERE site_id = ?').run(req.params.id);
    await ftpManager.syncFtpUsers();
    const siteDbIds = db.prepare('SELECT id FROM databases WHERE site_id = ?').all(req.params.id);
    for (const row of siteDbIds) {
      db.prepare('DELETE FROM db_grants WHERE database_id = ?').run(row.id);
    }
    db.prepare('DELETE FROM databases WHERE site_id = ?').run(req.params.id);
    db.prepare('DELETE FROM sites WHERE id = ?').run(req.params.id);
    siteManager.reloadNginx();
  }
  res.redirect('/sites');
});

router.post('/:id/databases', async (req, res) => {
  const { name, assign_user, db_username, db_password, privileges } = req.body || {};
  const siteId = req.params.id;
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site || !name) return res.redirect('/sites/' + siteId);
  const settings = getSettings(db);
  const mysqlPassword = getSetting(db, 'mysql_root_password');
  if (!mysqlPassword) {
    const siteDatabases = db.prepare('SELECT * FROM databases WHERE site_id = ? ORDER BY name').all(site.id);
    const databaseGrants = db.prepare(`
      SELECT g.database_id, g.db_user_id, g.privileges, u.username, u.password_plain FROM db_grants g
      JOIN db_users u ON u.id = g.db_user_id
      JOIN databases d ON d.id = g.database_id WHERE d.site_id = ?
    `).all(site.id);
    const ftpUsers = ftpManager.getFtpUsersBySite(db, site.id);
    const dbPath = getDbPath();
    const errorMsg = 'MySQL root password not set in Settings. Set it in Settings and click Save. If you already did, set DATABASE_PATH to this panel database path and restart the panel: ' + dbPath;
    const existingDbUsersErr = db.prepare('SELECT id, username FROM db_users ORDER BY username').all();
    return res.render('sites/show', { site, siteDatabases, databaseGrants, ftpUsers, hasMysqlPassword: false, error: errorMsg, reset: null, user: req.session.user, privilegeOptions: Object.keys(PRIVILEGE_SETS), newDbCredentials: null, newFtpCredentials: null, panelDbPath: dbPath, existingDbUsers: existingDbUsersErr });
  }
  const priv = (privileges === 'READ_ONLY' || privileges === 'READ_WRITE') ? privileges : 'ALL';
  settings.mysql_root_password = settings.mysql_root_password || mysqlPassword;
  let newDbCredentials = null;
  try {
    const safeName = name.replace(/[^a-z0-9_]/gi, '');
    if (safeName !== name) throw new Error('Invalid database name');
    if (db.prepare('SELECT id FROM databases WHERE name = ?').get(safeName)) throw new Error('A database with this name already exists');
    db.prepare('INSERT INTO databases (name, site_id) VALUES (?, ?)').run(safeName, siteId);
    await databaseManager.createDatabase(settings, safeName);
    let uid = null;
    let safeUser = null;
    let isNewUser = false;
    if (assign_user === 'new') {
      if (!db_username || !db_password) throw new Error('New user selected: enter username and password');
    }
    if (assign_user === 'new' && db_username && db_password) {
      safeUser = db_username.replace(/[^a-z0-9_]/gi, '');
      if (safeUser !== db_username) throw new Error('Invalid username');
      isNewUser = !db.prepare('SELECT id FROM db_users WHERE username = ?').get(safeUser);
      uid = db.prepare('SELECT id FROM db_users WHERE username = ?').get(safeUser)?.id;
      if (!uid) {
        const hash = crypto.createHash('sha256').update(db_password).digest('hex');
        db.prepare('INSERT INTO db_users (username, password_hash, host, password_plain) VALUES (?, ?, ?, ?)').run(safeUser, hash, 'localhost', db_password);
        await databaseManager.createUser(settings, safeUser, db_password, 'localhost');
        uid = db.prepare('SELECT id FROM db_users WHERE username = ?').get(safeUser).id;
      }
      await databaseManager.grantDatabase(settings, safeUser, safeName, 'localhost', priv);
      const did = db.prepare('SELECT id FROM databases WHERE name = ?').get(safeName).id;
      db.prepare('INSERT OR IGNORE INTO db_grants (database_id, db_user_id, privileges) VALUES (?, ?, ?)').run(did, uid, priv);
      newDbCredentials = isNewUser ? { username: safeUser, password: db_password, database: safeName } : null;
    } else if (assign_user && assign_user !== 'new') {
      const existing = db.prepare('SELECT id, username FROM db_users WHERE id = ?').get(assign_user);
      if (existing) {
        safeUser = existing.username;
        uid = existing.id;
        await databaseManager.grantDatabase(settings, safeUser, safeName, 'localhost', priv);
        const did = db.prepare('SELECT id FROM databases WHERE name = ?').get(safeName).id;
        db.prepare('INSERT OR IGNORE INTO db_grants (database_id, db_user_id, privileges) VALUES (?, ?, ?)').run(did, uid, priv);
      }
    }
  } catch (e) {
    const msg = (e.message && e.message.includes('UNIQUE constraint failed')) ? 'A database with this name already exists' : (e.message || 'Database creation failed');
    return res.redirect('/sites/' + siteId + '?error=' + encodeURIComponent(msg));
  }
  const siteDatabases = db.prepare('SELECT * FROM databases WHERE site_id = ? ORDER BY name').all(site.id);
  const databaseGrants = db.prepare(`
    SELECT g.database_id, g.db_user_id, g.privileges, u.username, u.password_plain FROM db_grants g
    JOIN db_users u ON u.id = g.db_user_id
    JOIN databases d ON d.id = g.database_id WHERE d.site_id = ?
  `).all(site.id);
  const ftpUsers = ftpManager.getFtpUsersBySite(db, site.id);
  const existingDbUsersSuccess = db.prepare('SELECT id, username FROM db_users ORDER BY username').all();
  res.render('sites/show', { site, siteDatabases, databaseGrants, ftpUsers, hasMysqlPassword: !!getSetting(db, 'mysql_root_password'), error: null, user: req.session.user, privilegeOptions: Object.keys(PRIVILEGE_SETS), newDbCredentials, newFtpCredentials: null, existingDbUsers: existingDbUsersSuccess });
});


router.post('/:id/db-users/:dbUserId/reset-password', async (req, res) => {
  const { password } = req.body || {};
  const siteId = req.params.id;
  const dbUserId = req.params.dbUserId;
  if (!password) return res.redirect('/sites/' + siteId + '?error=password_required');
  const db = await getDb();
  const grant = db.prepare(`
    SELECT u.username FROM db_grants g
    JOIN db_users u ON u.id = g.db_user_id
    JOIN databases d ON d.id = g.database_id WHERE d.site_id = ? AND g.db_user_id = ?
  `).get(siteId, dbUserId);
  if (!grant) return res.redirect('/sites/' + siteId);
  const settings = getSettings(db);
  try {
    await databaseManager.setUserPassword(settings, grant.username, password, 'localhost');
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    db.prepare('UPDATE db_users SET password_hash = ?, password_plain = ? WHERE id = ?').run(hash, password, dbUserId);
  } catch (e) {
    return res.redirect('/sites/' + siteId + '?error=' + encodeURIComponent(e.message || 'Failed to update password'));
  }
  res.redirect('/sites/' + siteId + '?reset=db');
});

router.post('/:id/databases/:dbId/delete', async (req, res) => {
  const siteId = req.params.id;
  const dbId = req.params.dbId;
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  const row = db.prepare('SELECT * FROM databases WHERE id = ? AND site_id = ?').get(dbId, siteId);
  if (!site || !row) return res.redirect('/sites/' + siteId);
  db.prepare('DELETE FROM db_grants WHERE database_id = ?').run(dbId);
  db.prepare('DELETE FROM databases WHERE id = ?').run(dbId);
  const settings = getSettings(db);
  if (settings.mysql_root_password) {
    try {
      await databaseManager.dropDatabase(settings, row.name);
    } catch (_) {}
  }
  res.redirect('/sites/' + siteId);
});

router.post('/:id/ftp-users', async (req, res) => {
  const { username, password, default_route } = req.body || {};
  const siteId = req.params.id;
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site || !username || !password) return res.redirect('/sites/' + siteId + '?error=username_and_password_required');
  try {
    await ftpManager.addFtpUser(siteId, username, password, default_route);
  } catch (e) {
    return res.redirect('/sites/' + siteId + '?error=' + encodeURIComponent(e.message || 'FTP user creation failed'));
  }
  const siteDatabases = db.prepare('SELECT * FROM databases WHERE site_id = ? ORDER BY name').all(site.id);
  const databaseGrants = db.prepare(`
    SELECT g.database_id, g.db_user_id, g.privileges, u.username, u.password_plain FROM db_grants g
    JOIN db_users u ON u.id = g.db_user_id
    JOIN databases d ON d.id = g.database_id WHERE d.site_id = ?
  `).all(site.id);
  const ftpUsers = ftpManager.getFtpUsersBySite(db, site.id);
  const settings = getSettings(db);
  const newFtpCredentials = { username: String(username).trim(), password };
  const existingDbUsersFtp = db.prepare('SELECT id, username FROM db_users ORDER BY username').all();
  res.render('sites/show', { site, siteDatabases, databaseGrants, ftpUsers, hasMysqlPassword: !!(settings && settings.mysql_root_password), error: null, user: req.session.user, privilegeOptions: Object.keys(PRIVILEGE_SETS), newDbCredentials: null, newFtpCredentials, existingDbUsers: existingDbUsersFtp });
});

router.post('/:id/ftp-users/:uid/reset-password', async (req, res) => {
  const { password } = req.body || {};
  const siteId = req.params.id;
  const uid = req.params.uid;
  if (!password || String(password).trim() === '') return res.redirect('/sites/' + siteId + '?error=password_required');
  try {
    await ftpManager.updateFtpUser(siteId, uid, { password: String(password).trim() });
  } catch (e) {
    return res.redirect('/sites/' + siteId + '?error=' + encodeURIComponent(e.message || 'Failed to update password'));
  }
  res.redirect('/sites/' + siteId + '?reset=ftp');
});

router.post('/:id/ftp-users/:uid/delete', async (req, res) => {
  const siteId = req.params.id;
  const uid = req.params.uid;
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) return res.redirect('/sites');
  try {
    await ftpManager.deleteFtpUser(siteId, uid);
  } catch (_) {}
  res.redirect('/sites/' + siteId);
});

module.exports = router;
