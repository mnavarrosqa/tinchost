const express = require('express');
const router = express.Router();
const { getDb, getDbPath, getSetting } = require('../config/database');
const servicesManager = require('../services/servicesManager');

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
  const installedServices = servicesManager.getInstalledServices(state || {}).map((s) => ({
    ...s,
    status: servicesManager.getServiceStatus(s.unit)
  }));
  const saved = req.session.settingsSaved;
  const settingsError = req.session.settingsError;
  const serviceRestarted = req.session.serviceRestarted;
  const serviceError = req.session.serviceError;
  if (req.session.settingsSaved) delete req.session.settingsSaved;
  if (req.session.settingsError) delete req.session.settingsError;
  if (req.session.serviceRestarted) delete req.session.serviceRestarted;
  if (req.session.serviceError) delete req.session.serviceError;
  const dbPath = getDbPath();
  const hasMysqlPassword = !!getSetting(db, 'mysql_root_password');
  res.render('settings', { state, nginxSites, phpPoolDir, mailPath, mysqlRootPassword, saved, settingsError, installedServices, serviceRestarted, serviceError, dbPath, hasMysqlPassword });
});

router.get('/services/logs', async (req, res) => {
  const unit = req.query && req.query.unit ? String(req.query.unit).trim() : '';
  const db = await getDb();
  const state = db.prepare('SELECT * FROM wizard_state WHERE id = 1').get();
  if (!unit || !servicesManager.isAllowedUnit(unit, state || {})) {
    return res.redirect('/settings?error=invalid_service');
  }
  const lines = req.query.lines || 200;
  const result = servicesManager.getServiceLogs(unit, lines);
  const label = (servicesManager.getInstalledServices(state || {}).find((s) => s.unit === unit) || {}).label || unit;
  res.render('settings-logs', { unit, label, output: result.ok ? result.output : result.error || 'Failed to load logs', error: !result.ok });
});

router.post('/services/restart', async (req, res) => {
  const unit = req.body && req.body.service ? String(req.body.service).trim() : '';
  const db = await getDb();
  const state = db.prepare('SELECT * FROM wizard_state WHERE id = 1').get();
  if (!unit || !servicesManager.isAllowedUnit(unit, state || {})) {
    req.session.serviceError = 'Invalid or not allowed service';
    return res.redirect('/settings');
  }
  const result = servicesManager.restartService(unit);
  if (result.ok) req.session.serviceRestarted = unit;
  else req.session.serviceError = result.message || 'Restart failed';
  res.redirect('/settings');
});

router.post('/', async (req, res) => {
  const { nginx_sites_available, php_pool_dir, mail_path, mysql_root_password } = req.body || {};
  try {
    const db = await getDb();
    if (nginx_sites_available != null && nginx_sites_available !== '') setSetting(db, 'nginx_sites_available', nginx_sites_available);
    if (php_pool_dir != null && php_pool_dir !== '') setSetting(db, 'php_pool_dir', php_pool_dir);
    if (mail_path != null && mail_path !== '') setSetting(db, 'mail_path', mail_path);
    const pw = mysql_root_password;
    if (pw != null && String(pw).trim() !== '' && pw !== '********') setSetting(db, 'mysql_root_password', String(pw).trim());
    req.session.settingsSaved = true;
  } catch (e) {
    req.session.settingsError = (e && e.message) ? e.message : 'Failed to save settings';
  }
  res.redirect('/settings');
});

module.exports = router;
