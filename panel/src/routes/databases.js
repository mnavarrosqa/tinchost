const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const databaseManager = require('../services/databaseManager');
const { getDatabaseSizes, streamDatabaseDump, repairDatabase } = require('../services/databaseManager');
const crypto = require('crypto');

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const o = {};
  if (rows) rows.forEach(r => { o[r.key] = r.value; });
  return o;
}

router.get('/', async (req, res) => {
  const db = await getDb();
  const databases = db.prepare('SELECT * FROM databases ORDER BY name').all();
  const users = db.prepare('SELECT * FROM db_users ORDER BY username').all();
  const grants = db.prepare('SELECT g.id, g.database_id, g.db_user_id, g.privileges, d.name AS database_name, u.username, u.host FROM db_grants g JOIN databases d ON d.id = g.database_id JOIN db_users u ON u.id = g.db_user_id').all();
  const settings = getSettings(db);
  let databaseSizes = {};
  if (databases.length && settings && settings.mysql_root_password) {
    try {
      databaseSizes = await getDatabaseSizes(settings, databases.map(d => d.name));
    } catch (_) {}
  }
  const repair = req.query.repair || null;
  const repairMsg = req.query.msg || null;
  res.render('databases/list', { databases, users, grants, hasMysqlPassword: !!(settings && settings.mysql_root_password), user: req.session.user, databaseSizes, repair, repairMsg });
});

router.post('/databases', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.redirect('/databases');
  const db = await getDb();
  try {
    db.prepare('INSERT INTO databases (name) VALUES (?)').run(name);
    const settings = getSettings(db);
    await databaseManager.createDatabase(settings, name);
  } catch (e) {
    if (e.message && e.message.includes('MySQL root password')) {
      return res.redirect('/databases?error=mysql_password');
    }
  }
  res.redirect('/databases');
});

router.post('/users', async (req, res) => {
  const { username, password, host } = req.body || {};
  if (!username) return res.redirect('/databases');
  const db = await getDb();
  const hash = password ? crypto.createHash('sha256').update(password).digest('hex') : '';
  try {
    db.prepare('INSERT INTO db_users (username, password_hash, host) VALUES (?, ?, ?)').run(username, hash, host || 'localhost');
    const settings = getSettings(db);
    if (password) await databaseManager.createUser(settings, username, password, host || 'localhost');
  } catch (e) {}
  res.redirect('/databases');
});

router.get('/databases/:id/download', async (req, res) => {
  const db = await getDb();
  const row = db.prepare('SELECT id, name FROM databases WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.redirect('/databases');
  const settings = getSettings(db);
  try {
    const stream = await streamDatabaseDump(settings, row.name);
    const safeName = row.name.replace(/[^a-z0-9_]/gi, '_');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.sql.gz"');
    res.setHeader('Content-Type', 'application/gzip');
    stream.pipe(res);
    stream.on('error', () => { try { res.end(); } catch (_) {} });
  } catch (e) {
    if (!res.headersSent) res.status(500).send(e.message || 'Download failed');
    else try { res.end(); } catch (_) {}
  }
});

router.post('/databases/:id/repair', async (req, res) => {
  const db = await getDb();
  const row = db.prepare('SELECT id, name FROM databases WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.redirect('/databases');
  const settings = getSettings(db);
  const result = await repairDatabase(settings, row.name);
  if (result.ok) res.redirect('/databases?repair=ok');
  else res.redirect('/databases?repair=error&msg=' + encodeURIComponent(result.message || 'Repair failed'));
});

router.post('/databases/:id/delete', async (req, res) => {
  const db = await getDb();
  const row = db.prepare('SELECT id, name FROM databases WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.redirect('/databases');
  db.prepare('DELETE FROM db_grants WHERE database_id = ?').run(row.id);
  db.prepare('DELETE FROM databases WHERE id = ?').run(row.id);
  const settings = getSettings(db);
  try { await databaseManager.dropDatabase(settings, row.name); } catch (_) {}
  res.redirect('/databases');
});

router.post('/users/:id/delete', async (req, res) => {
  const db = await getDb();
  const row = db.prepare('SELECT id, username, host FROM db_users WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.redirect('/databases');
  db.prepare('DELETE FROM db_grants WHERE db_user_id = ?').run(row.id);
  db.prepare('DELETE FROM db_users WHERE id = ?').run(row.id);
  const settings = getSettings(db);
  try { await databaseManager.dropUser(settings, row.username, row.host); } catch (_) {}
  res.redirect('/databases');
});

router.post('/users/:id/password', async (req, res) => {
  const password = (req.body && req.body.password) || '';
  const db = await getDb();
  const row = db.prepare('SELECT id, username, host FROM db_users WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.redirect('/databases');
  const settings = getSettings(db);
  try {
    if (password) await databaseManager.setUserPassword(settings, row.username, password, row.host);
    const hash = password ? crypto.createHash('sha256').update(password).digest('hex') : '';
    db.prepare('UPDATE db_users SET password_hash = ? WHERE id = ?').run(hash, row.id);
  } catch (_) {}
  res.redirect('/databases');
});

router.post('/grants', async (req, res) => {
  const { database_id, db_user_id, privileges } = req.body || {};
  const db = await getDb();
  const dbRow = db.prepare('SELECT id, name FROM databases WHERE id = ?').get(Number(database_id));
  const userRow = db.prepare('SELECT id, username, host FROM db_users WHERE id = ?').get(Number(db_user_id));
  if (!dbRow || !userRow) return res.redirect('/databases');
  const priv = privileges === 'READ_ONLY' || privileges === 'READ_WRITE' ? privileges : 'ALL';
  const existing = db.prepare('SELECT id FROM db_grants WHERE database_id = ? AND db_user_id = ?').get(dbRow.id, userRow.id);
  if (existing) {
    db.prepare('UPDATE db_grants SET privileges = ? WHERE id = ?').run(priv, existing.id);
  } else {
    db.prepare('INSERT INTO db_grants (database_id, db_user_id, privileges) VALUES (?, ?, ?)').run(dbRow.id, userRow.id, priv);
  }
  const settings = getSettings(db);
  try { await databaseManager.grantDatabase(settings, userRow.username, dbRow.name, userRow.host, priv); } catch (_) {}
  res.redirect('/databases');
});

router.post('/grants/revoke', async (req, res) => {
  const { database_id, db_user_id } = req.body || {};
  const db = await getDb();
  const grant = db.prepare('SELECT g.database_id, g.db_user_id, d.name AS database_name, u.username, u.host FROM db_grants g JOIN databases d ON d.id = g.database_id JOIN db_users u ON u.id = g.db_user_id WHERE g.database_id = ? AND g.db_user_id = ?').get(Number(database_id), Number(db_user_id));
  if (!grant) return res.redirect('/databases');
  db.prepare('DELETE FROM db_grants WHERE database_id = ? AND db_user_id = ?').run(grant.database_id, grant.db_user_id);
  const settings = getSettings(db);
  try { await databaseManager.revokeDatabase(settings, grant.username, grant.database_name, grant.host); } catch (_) {}
  res.redirect('/databases');
});

module.exports = router;
