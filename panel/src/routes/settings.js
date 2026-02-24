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
  const saved = req.session.settingsSaved;
  const settingsError = req.session.settingsError;
  if (req.session.settingsSaved) delete req.session.settingsSaved;
  if (req.session.settingsError) delete req.session.settingsError;
  res.render('settings', { state, nginxSites, phpPoolDir, mailPath, mysqlRootPassword, saved, settingsError });
});

router.post('/', async (req, res) => {
  const { nginx_sites_available, php_pool_dir, mail_path, mysql_root_password } = req.body || {};
  try {
    const db = await getDb();
    if (nginx_sites_available != null && nginx_sites_available !== '') setSetting(db, 'nginx_sites_available', nginx_sites_available);
    if (php_pool_dir != null && php_pool_dir !== '') setSetting(db, 'php_pool_dir', php_pool_dir);
    if (mail_path != null && mail_path !== '') setSetting(db, 'mail_path', mail_path);
    if (mysql_root_password != null && mysql_root_password !== '' && mysql_root_password !== '********') setSetting(db, 'mysql_root_password', mysql_root_password);
    req.session.settingsSaved = true;
  } catch (e) {
    req.session.settingsError = (e && e.message) ? e.message : 'Failed to save settings';
  }
  res.redirect('/settings');
});

module.exports = router;
