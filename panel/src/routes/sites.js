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
const { execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const DEFAULT_INDEX_PATH = path.join(__dirname, '..', '..', 'templates', 'default-site-index.html');

/** Resolve path under site docroot. Returns absolute path or null if outside docroot. */
function resolveDocrootPath(docroot, relativePath) {
  const root = path.resolve(docroot);
  const resolved = path.resolve(root, relativePath || '.');
  if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  return null;
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
  res.render('sites/list', { sites, phpVersions, user: req.session?.user });
});

router.get('/new', async (req, res) => {
  const db = await getDb();
  const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
  const phpVersions = (state?.php_versions || '8.2').split(',').filter(Boolean);
  res.render('sites/form', { site: null, phpVersions });
});

router.post('/', async (req, res) => {
  const { domain, docroot, php_version, create_docroot, ssl, ftp_enabled, app_type, node_port } = req.body || {};
  if (!domain) return res.redirect('/sites/new');
  const appKind = app_type === 'node' ? 'node' : 'php';
  const portNum = node_port != null && node_port !== '' ? parseInt(node_port, 10) : null;
  if (appKind === 'node' && (portNum == null || isNaN(portNum) || portNum < 1 || portNum > 65535)) {
    const db = await getDb();
    const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
    const phpVersions = (state?.php_versions || '8.2').split(',').filter(Boolean);
    return res.render('sites/form', { site: null, phpVersions, error: 'Node app requires a valid port (1–65535).' });
  }
  const docrootPath = docroot || `/var/www/${domain}`;
  const db = await getDb();
  try {
    if (ssl) {
      try { await sslManager.obtainCert(domain); } catch (e) {
        return res.render('sites/form', { site: null, phpVersions: (db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get()?.php_versions || '8.2').split(',').filter(Boolean), error: 'SSL: ' + e.message });
      }
    }
    db.prepare('INSERT INTO sites (domain, docroot, php_version, ssl, ftp_enabled, app_type, node_port) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      domain, docrootPath, appKind === 'php' ? (php_version || '8.2') : null, ssl ? 1 : 0, ftp_enabled ? 1 : 0, appKind, appKind === 'node' ? portNum : null
    );
    const site = db.prepare('SELECT * FROM sites WHERE domain = ?').get(domain);
    const settings = getSettings(db);
    await siteManager.writeVhost(site, settings);
    if (create_docroot === 'on' || create_docroot === true) {
      try {
        execFileSync('mkdir', ['-p', docrootPath], { stdio: 'pipe' });
        execFileSync('chown', ['www-data:www-data', docrootPath], { stdio: 'pipe' });
        execFileSync('chmod', ['755', docrootPath], { stdio: 'pipe' });
        if (fs.existsSync(DEFAULT_INDEX_PATH)) {
          const html = fs.readFileSync(DEFAULT_INDEX_PATH, 'utf8').replace(/\{\{domain\}\}/g, domain);
          const indexFile = path.join(docrootPath, 'index.html');
          fs.writeFileSync(indexFile, html, 'utf8');
          execFileSync('chown', ['www-data:www-data', indexFile], { stdio: 'pipe' });
          execFileSync('chmod', ['644', indexFile], { stdio: 'pipe' });
        }
      } catch (_) {}
    }
    siteManager.reloadNginx();
  } catch (e) {
    const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
    return res.render('sites/form', { site: null, phpVersions: (state?.php_versions || '8.2').split(',').filter(Boolean), error: e.message });
  }
  res.redirect('/sites');
});

router.get('/:id/edit', async (req, res) => {
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
  const phpVersions = (state?.php_versions || '8.2').split(',').filter(Boolean);
  res.render('sites/form', { site, phpVersions });
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
  const wordpress = req.query.wordpress || null;
  const wp_folder = req.query.wp_folder || null;
  const phpOptionsSaved = req.query.php_options === 'saved';
  let databaseSizes = {};
  if (siteDatabases.length && getSetting(db, 'mysql_root_password')) {
    try {
      databaseSizes = await getDatabaseSizes(settings, siteDatabases.map(d => d.name));
    } catch (_) {}
  }
  res.render('sites/show', { site, siteDatabases, databaseGrants, ftpUsers, hasMysqlPassword: !!getSetting(db, 'mysql_root_password'), error: errorMsg, reset: req.query.reset, user: req.session.user, privilegeOptions: Object.keys(PRIVILEGE_SETS), newDbCredentials, newFtpCredentials, panelDbPath, existingDbUsers, sslStatus, renew, sslRemoved, wordpress, wp_folder, phpOptionsSaved, databaseSizes });
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
  } catch (_) {}
  res.redirect('/sites/' + site.id + '?ssl=removed#ssl');
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
  res.redirect('/sites/' + site.id + '?php_options=saved#php');
});

router.post('/:id', async (req, res) => {
  const { domain, docroot, php_version, ssl, ftp_enabled, app_type, node_port } = req.body || {};
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const appKind = app_type === 'node' ? 'node' : 'php';
  const portNum = node_port != null && node_port !== '' ? parseInt(node_port, 10) : null;
  if (appKind === 'node' && (portNum == null || isNaN(portNum) || portNum < 1 || portNum > 65535)) {
    const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
    return res.render('sites/form', { site: { ...site, domain: domain || site.domain, docroot: docroot || site.docroot, php_version: site.php_version, app_type: 'node' }, phpVersions: (state?.php_versions || '8.2').split(',').filter(Boolean), error: 'Node app requires a valid port (1–65535).' });
  }
  const dom = domain || site.domain;
  if (ssl && !site.ssl) {
    try { await sslManager.obtainCert(dom); } catch (e) {
      const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
      return res.render('sites/form', { site: { ...site, domain: dom, docroot: docroot || site.docroot, php_version: php_version || site.php_version, app_type: appKind, node_port: appKind === 'node' ? portNum : site.node_port }, phpVersions: (state?.php_versions || '8.2').split(',').filter(Boolean), error: 'SSL: ' + e.message });
    }
  }
  db.prepare('UPDATE sites SET domain = ?, docroot = ?, php_version = ?, ssl = ?, ftp_enabled = ?, app_type = ?, node_port = ? WHERE id = ?').run(
    dom, docroot || site.docroot, appKind === 'php' ? (php_version || site.php_version) : null, ssl ? 1 : 0, ftp_enabled ? 1 : 0, appKind, appKind === 'node' ? portNum : null, req.params.id
  );
  const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  const settings = getSettings(db);
  await siteManager.writeVhost(updated, settings);
  siteManager.reloadNginx();
  res.redirect('/sites');
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
