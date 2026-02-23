const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const siteManager = require('../services/siteManager');
const sslManager = require('../services/sslManager');
const databaseManager = require('../services/databaseManager');
const ftpManager = require('../services/ftpManager');
const { execSync } = require('child_process');
const crypto = require('crypto');

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const o = {};
  if (rows) rows.forEach(r => { o[r.key] = r.value; });
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
      try { execSync(`mkdir -p ${docrootPath} && chown www-data:www-data ${docrootPath}`, { stdio: 'pipe' }); } catch (_) {}
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
  const ftpUsers = ftpManager.getFtpUsersBySite(db, site.id);
  const settings = getSettings(db);
  res.render('sites/show', { site, siteDatabases, ftpUsers, hasMysqlPassword: !!(settings && settings.mysql_root_password), error: req.query.error, user: req.session.user });
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
    db.prepare('DELETE FROM sites WHERE id = ?').run(req.params.id);
    siteManager.reloadNginx();
  }
  res.redirect('/sites');
});

router.post('/:id/databases', async (req, res) => {
  const { name, db_username, db_password } = req.body || {};
  const siteId = req.params.id;
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site || !name) return res.redirect('/sites/' + siteId);
  const settings = getSettings(db);
  if (!settings.mysql_root_password) return res.redirect('/sites/' + siteId + '?error=mysql_password');
  try {
    const safeName = name.replace(/[^a-z0-9_]/gi, '');
    if (safeName !== name) throw new Error('Invalid database name');
    db.prepare('INSERT INTO databases (name, site_id) VALUES (?, ?)').run(safeName, siteId);
    await databaseManager.createDatabase(settings, safeName);
    if (db_username && db_password) {
      const safeUser = db_username.replace(/[^a-z0-9_]/gi, '');
      if (safeUser === db_username) {
        const hash = crypto.createHash('sha256').update(db_password).digest('hex');
        db.prepare('INSERT INTO db_users (username, password_hash, host) VALUES (?, ?, ?)').run(safeUser, hash, 'localhost');
        await databaseManager.createUser(settings, safeUser, db_password, 'localhost');
        await databaseManager.grantDatabase(settings, safeUser, safeName, 'localhost');
        const uid = db.prepare('SELECT id FROM db_users WHERE username = ?').get(safeUser).id;
        const did = db.prepare('SELECT id FROM databases WHERE name = ?').get(safeName).id;
        db.prepare('INSERT OR IGNORE INTO db_grants (database_id, db_user_id) VALUES (?, ?)').run(did, uid);
      }
    }
  } catch (e) {
    return res.redirect('/sites/' + siteId + '?error=' + encodeURIComponent(e.message || 'Database creation failed'));
  }
  res.redirect('/sites/' + siteId);
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
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({ host: 'localhost', user: 'root', password: settings.mysql_root_password });
      await conn.execute('DROP DATABASE IF EXISTS ??', [row.name.replace(/[^a-z0-9_]/gi, '')]);
      await conn.end();
    } catch (_) {}
  }
  res.redirect('/sites/' + siteId);
});

router.post('/:id/ftp-users', async (req, res) => {
  const { username, password } = req.body || {};
  const siteId = req.params.id;
  const db = await getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site || !username || !password) return res.redirect('/sites/' + siteId);
  try {
    await ftpManager.addFtpUser(siteId, username, password);
  } catch (e) {
    return res.redirect('/sites/' + siteId + '?error=' + encodeURIComponent(e.message || 'FTP user creation failed'));
  }
  res.redirect('/sites/' + siteId);
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
