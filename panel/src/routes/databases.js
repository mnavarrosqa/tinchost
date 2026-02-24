const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const databaseManager = require('../services/databaseManager');
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
  const settings = getSettings(db);
  res.render('databases/list', { databases, users, hasMysqlPassword: !!(settings && settings.mysql_root_password), user: req.session.user });
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

module.exports = router;
