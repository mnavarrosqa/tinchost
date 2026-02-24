const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb, getDbPath, getSetting } = require('../config/database');
const siteManager = require('../services/siteManager');
const sslManager = require('../services/sslManager');
const databaseManager = require('../services/databaseManager');
const { PRIVILEGE_SETS } = require('../services/databaseManager');
const ftpManager = require('../services/ftpManager');
const { execSync, execFileSync } = require('child_process');
const crypto = require('crypto');

const DEFAULT_INDEX_PATH = path.join(__dirname, '..', '..', 'templates', 'default-site-index.html');

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
  res.render('sites/list', { sites, phpVersions });
});

router.get('/new', async (req, res) => {
  const db = await getDb();
  const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
  const phpVersions = (state?.php_versions || '8.2').split(',').filter(Boolean);
  res.render('sites/form', { site: null, phpVersions });
});

router.post('/', async (req, res) => {
  const { domain, docroot, php_version, create_docroot, ssl, ftp_enabled } = req.body || {};
  if (!domain) return res.redirect('/sites/new');
  const docrootPath = docroot || `/var/www/${domain}`;
  const db = await getDb();
  try {
    if (ssl) {
      try { await sslManager.obtainCert(domain); } catch (e) {
        return res.render('sites/form', { site: null, phpVersions: (db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get()?.php_versions || '8.2').split(',').filter(Boolean), error: 'SSL: ' + e.message });
      }
    }
    db.prepare('INSERT INTO sites (domain, docroot, php_version, ssl, ftp_enabled) VALUES (?, ?, ?, ?, ?)').run(
      domain, docrootPath, php_version || '8.2', ssl ? 1 : 0, ftp_enabled ? 1 : 0
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
  res.render('sites/show', { site, siteDatabases, databaseGrants, ftpUsers, hasMysqlPassword: !!getSetting(db, 'mysql_root_password'), error: errorMsg, reset: req.query.reset, user: req.session.user, privilegeOptions: Object.keys(PRIVILEGE_SETS), newDbCredentials, newFtpCredentials, panelDbPath, existingDbUsers, sslStatus, renew, sslRemoved });
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

router.post('/:id', async (req, res) => {
  const { domain, docroot, php_version, ssl, ftp_enabled } = req.body || {};
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
  if (!site) return res.redirect('/sites');
  const dom = domain || site.domain;
  if (ssl && !site.ssl) {
    try { await sslManager.obtainCert(dom); } catch (e) {
      const state = db.prepare('SELECT php_versions FROM wizard_state WHERE id = 1').get();
      return res.render('sites/form', { site: { ...site, domain: dom, docroot: docroot || site.docroot, php_version: php_version || site.php_version }, phpVersions: (state?.php_versions || '8.2').split(',').filter(Boolean), error: 'SSL: ' + e.message });
    }
  }
  db.prepare('UPDATE sites SET domain = ?, docroot = ?, php_version = ?, ssl = ?, ftp_enabled = ? WHERE id = ?').run(
    dom, docroot || site.docroot, php_version || site.php_version, ssl ? 1 : 0, ftp_enabled ? 1 : 0, req.params.id
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
