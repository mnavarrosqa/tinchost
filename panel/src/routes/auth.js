const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

router.get('/setup', async (req, res) => {
  const db = await getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c > 0) return res.redirect('/login');
  res.render('setup');
});

router.post('/setup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.redirect('/auth/setup');
  const db = await getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c > 0) return res.redirect('/login');
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  req.session.userId = 1;
  req.session.user = { username };
  res.redirect('/wizard');
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.redirect('/login');
  const db = await getDb();
  const user = db.prepare('SELECT id, username FROM users WHERE username = ? AND password_hash = ?').get(username, hashPassword(password));
  if (!user) return res.redirect('/login');
  req.session.userId = user.id;
  req.session.user = { username: user.username };
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

module.exports = router;
