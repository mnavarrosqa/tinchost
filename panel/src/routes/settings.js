const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, value);
}

router.get('/', async (req, res) => {
  const db = await getDb();
  const state = db.prepare('SELECT * FROM wizard_state WHERE id = 1').get();
  const nginxSites = getSetting(db, 'nginx_sites_available') || '/etc/nginx/sites-available';
  const phpPoolDir = getSetting(db, 'php_pool_dir') || '/etc/php';
  const mailPath = getSetting(db, 'mail_path') || '/var/mail/vhosts';
  const mysqlRootPassword = getSetting(db, 'mysql_root_password') ? '********' : '';
  res.render('settings', { state, nginxSites, phpPoolDir, mailPath, mysqlRootPassword });
});

router.post('/', async (req, res) => {
  const { nginx_sites_available, php_pool_dir, mail_path, mysql_root_password } = req.body || {};
  const db = await getDb();
  if (nginx_sites_available) setSetting(db, 'nginx_sites_available', nginx_sites_available);
  if (php_pool_dir) setSetting(db, 'php_pool_dir', php_pool_dir);
  if (mail_path) setSetting(db, 'mail_path', mail_path);
  if (mysql_root_password && mysql_root_password !== '********') setSetting(db, 'mysql_root_password', mysql_root_password);
  res.redirect('/settings');
});

module.exports = router;
