const express = require('express');
const router = express.Router();
const { getDb, getDbPath, getSetting } = require('../config/database');
const servicesManager = require('../services/servicesManager');
const wizardInstall = require('../services/wizardInstall');

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, value);
}

function getWizardState(db) {
  return db.prepare('SELECT * FROM wizard_state WHERE id = 1').get() || {};
}

function updateWizardState(db, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => k + ' = ?').join(', ');
  db.prepare('UPDATE wizard_state SET ' + setClause + ', updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(...keys.map((k) => updates[k]));
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
  const settingsInstalled = req.session.settingsInstalled;
  const serviceRestarted = req.session.serviceRestarted;
  const serviceError = req.session.serviceError;
  if (req.session.settingsSaved) delete req.session.settingsSaved;
  if (req.session.settingsError) delete req.session.settingsError;
  if (req.session.settingsInstalled) delete req.session.settingsInstalled;
  if (req.session.serviceRestarted) delete req.session.serviceRestarted;
  if (req.session.serviceError) delete req.session.serviceError;
  const dbPath = getDbPath();
  const hasMysqlPassword = !!getSetting(db, 'mysql_root_password');
  res.render('settings', { state, nginxSites, phpPoolDir, mailPath, mysqlRootPassword, saved, settingsError, settingsInstalled, installedServices, serviceRestarted, serviceError, dbPath, hasMysqlPassword });
});

router.get('/services/logs', async (req, res) => {
  const unit = req.query && req.query.unit ? String(req.query.unit).trim() : '';
  const db = await getDb();
  const state = db.prepare('SELECT * FROM wizard_state WHERE id = 1').get();
  if (!unit || !servicesManager.isAllowedUnit(unit, state || {})) {
    if (req.get('Accept') && req.get('Accept').includes('application/json')) {
      return res.status(400).json({ ok: false, error: 'Invalid or not allowed service' });
    }
    return res.redirect('/settings?error=invalid_service');
  }
  const lines = req.query.lines || 300;
  const priority = (req.query.priority === 'err' || req.query.priority === 'error') ? 'err' : null;
  const result = servicesManager.getServiceLogs(unit, lines, priority);
  const label = (servicesManager.getInstalledServices(state || {}).find((s) => s.unit === unit) || {}).label || unit;
  const output = result.ok ? result.output : result.error || 'Failed to load logs';
  if (req.get('Accept') && req.get('Accept').includes('application/json')) {
    return res.json({ ok: result.ok, output, label, unit });
  }
  res.render('settings-logs', { unit, label, output, error: !result.ok, priority: priority || 'all' });
});

router.post('/services/restart', async (req, res) => {
  const unit = req.body && req.body.service ? String(req.body.service).trim() : '';
  const db = await getDb();
  const state = db.prepare('SELECT * FROM wizard_state WHERE id = 1').get();
  if (!unit || !servicesManager.isAllowedUnit(unit, state || {})) {
    if (req.get('Accept') && req.get('Accept').includes('application/json')) {
      return res.status(400).json({ ok: false, message: 'Invalid or not allowed service' });
    }
    req.session.serviceError = 'Invalid or not allowed service';
    return res.redirect('/settings');
  }
  const result = servicesManager.restartService(unit);
  const services = servicesManager.getInstalledServices(state || {});
  const serviceMeta = services.find((s) => s.unit === unit) || { label: unit };
  if (req.get('Accept') && req.get('Accept').includes('application/json')) {
    if (result.ok) {
      return res.json({
        ok: true,
        unit,
        label: serviceMeta.label,
        status: result.status || servicesManager.getServiceStatus(unit)
      });
    }
    return res.status(500).json({
      ok: false,
      unit,
      label: serviceMeta.label,
      message: result.message || 'Restart failed'
    });
  }
  if (result.ok) req.session.serviceRestarted = unit;
  else req.session.serviceError = result.message || 'Restart failed';
  res.redirect('/settings');
});

const ALLOWED_PHP_VERSIONS = ['7.4', '8.1', '8.2', '8.3'];

router.post('/install/php', async (req, res) => {
  const raw = (Array.isArray(req.body.versions) ? req.body.versions : [req.body.versions]).filter(Boolean);
  const versions = raw.filter((v) => ALLOWED_PHP_VERSIONS.includes(String(v)));
  const phpFpmConfig = req.body.php_fpm_config === 'optimized' ? 'optimized' : 'default';
  if (versions.length === 0) {
    req.session.settingsError = 'Select at least one PHP version (7.4, 8.1, 8.2, 8.3).';
    return res.redirect('/settings');
  }
  const db = await getDb();
  wizardInstall.aptUpdate();
  const result = wizardInstall.installPhp(versions, phpFpmConfig);
  if (!result.ok) {
    req.session.settingsError = 'PHP install failed: ' + (result.out || '').slice(0, 200);
    return res.redirect('/settings');
  }
  updateWizardState(db, { php_versions: versions.join(','), php_fpm_config: phpFpmConfig });
  req.session.settingsInstalled = 'php';
  res.redirect('/settings');
});

router.post('/install/node', async (req, res) => {
  const version = ['18', '20', '22'].includes(req.body.node_version) ? req.body.node_version : null;
  if (!version) {
    req.session.settingsError = 'Select a Node.js version (18, 20, or 22).';
    return res.redirect('/settings');
  }
  const db = await getDb();
  wizardInstall.aptUpdate();
  const result = wizardInstall.installNode(version);
  if (!result.ok) {
    req.session.settingsError = 'Node.js install failed: ' + (result.out || '').slice(0, 200);
    return res.redirect('/settings');
  }
  updateWizardState(db, { node_version: version });
  req.session.settingsInstalled = 'node';
  res.redirect('/settings');
});

router.post('/install/database', async (req, res) => {
  const choice = req.body.choice === 'mariadb' ? 'mariadb' : 'mysql';
  const databaseConfig = req.body.database_config === 'optimized' ? 'optimized' : 'default';
  const db = await getDb();
  const state = getWizardState(db);
  if (state.database_choice) {
    req.session.settingsError = 'Database is already installed. Reinstalling is not supported from here.';
    return res.redirect('/settings');
  }
  wizardInstall.aptUpdate();
  const result = wizardInstall.installDatabase(choice, databaseConfig);
  if (!result.ok) {
    req.session.settingsError = 'Database install failed: ' + (result.out || '').slice(0, 200);
    return res.redirect('/settings');
  }
  updateWizardState(db, { database_choice: choice, database_config: databaseConfig });
  req.session.settingsInstalled = 'database';
  res.redirect('/settings');
});

router.post('/install/mail', async (req, res) => {
  const db = await getDb();
  const state = getWizardState(db);
  if (state.email_installed) {
    req.session.settingsError = 'Mail is already installed.';
    return res.redirect('/settings');
  }
  wizardInstall.aptUpdate();
  const result = wizardInstall.installMail();
  if (!result.ok) {
    req.session.settingsError = 'Mail install failed: ' + (result.out || '').slice(0, 200);
    return res.redirect('/settings');
  }
  updateWizardState(db, { email_installed: 1 });
  req.session.settingsInstalled = 'mail';
  res.redirect('/settings');
});

router.post('/install/ftp', async (req, res) => {
  const db = await getDb();
  const state = getWizardState(db);
  if (state.ftp_installed) {
    req.session.settingsError = 'FTP is already installed.';
    return res.redirect('/settings');
  }
  wizardInstall.aptUpdate();
  const result = wizardInstall.installFtp();
  if (!result.ok) {
    req.session.settingsError = 'FTP install failed: ' + (result.out || '').slice(0, 200);
    return res.redirect('/settings');
  }
  updateWizardState(db, { ftp_installed: 1 });
  req.session.settingsInstalled = 'ftp';
  res.redirect('/settings');
});

router.post('/install/certbot', async (req, res) => {
  const db = await getDb();
  const state = getWizardState(db);
  if (state.certbot_installed) {
    req.session.settingsError = 'Certbot is already installed.';
    return res.redirect('/settings');
  }
  wizardInstall.aptUpdate();
  const result = wizardInstall.installCertbot();
  if (!result.ok) {
    req.session.settingsError = 'Certbot install failed: ' + (result.out || '').slice(0, 200);
    return res.redirect('/settings');
  }
  updateWizardState(db, { certbot_installed: 1 });
  req.session.settingsInstalled = 'certbot';
  res.redirect('/settings');
});

router.post('/test-email', async (req, res) => {
  const to = (req.body && req.body.to) ? String(req.body.to).trim() : '';
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!to || !emailRe.test(to)) {
    req.session.settingsError = 'Enter a valid email address to send the test to.';
    return res.redirect('/settings#services');
  }
  try {
    const hostname = require('os').hostname();
    const from = 'noreply@' + (hostname || 'localhost');
    const raw = 'To: ' + to + '\r\nSubject: UPGS Panel test\r\nFrom: ' + from + '\r\n\r\nTest from UPGS Panel. If you received this, Postfix and sendmail are working.\r\n';
    const { spawnSync } = require('child_process');
    const r = spawnSync('/usr/sbin/sendmail', ['-t', '-i', '-f', from], {
      input: raw,
      encoding: 'utf8',
      timeout: 15000
    });
    if (r.status !== 0) {
      const err = (r.stderr || r.stdout || r.error?.message || 'sendmail failed').toString().trim();
      req.session.settingsError = 'Test email failed: ' + (err.slice(0, 200) || 'sendmail exited with ' + r.status);
      return res.redirect('/settings#services');
    }
    req.session.settingsSaved = 'Test email sent to ' + to + '. Check inbox (and spam).';
  } catch (e) {
    req.session.settingsError = 'Test email failed: ' + ((e && e.message) || 'sendmail not available or error');
  }
  res.redirect('/settings#services');
});

router.post('/', async (req, res) => {
  const { nginx_sites_available, php_pool_dir, mail_path, mysql_root_password } = req.body || {};
  try {
    const db = await getDb();
    if (nginx_sites_available != null && nginx_sites_available !== '') setSetting(db, 'nginx_sites_available', nginx_sites_available);
    if (php_pool_dir != null && php_pool_dir !== '') setSetting(db, 'php_pool_dir', php_pool_dir);
    if (mail_path != null && mail_path !== '') setSetting(db, 'mail_path', mail_path);
    const pw = mysql_root_password;
    if (pw != null && String(pw).trim() !== '' && pw !== '********') {
      const trimmed = String(pw).trim();
      setSetting(db, 'mysql_root_password', trimmed);
      if (!getSetting(db, 'mysql_root_password')) req.session.settingsError = 'MySQL password was not saved; try entering it again and click Save.';
    }
    req.session.settingsSaved = true;
  } catch (e) {
    req.session.settingsError = (e && e.message) ? e.message : 'Failed to save settings';
  }
  res.redirect('/settings');
});

module.exports = router;
