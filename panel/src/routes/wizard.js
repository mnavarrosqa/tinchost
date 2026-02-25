const express = require('express');
const router = express.Router();
const { getDb, getSetting } = require('../config/database');
const { runWizardInstall, runWizardInstallStreaming } = require('../services/wizardInstall');

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, value);
}

async function getState() {
  const db = await getDb();
  return db.prepare('SELECT * FROM wizard_state WHERE id = 1').get() || {};
}

const EDITABLE_STEPS = ['welcome', 'database', 'options', 'review'];
const KNOWN_STEPS = ['welcome', 'database', 'options', 'review', 'result', 'finish'];

router.get('/', async (req, res) => {
  const state = await getState();
  let step = state.step || 'welcome';
  if (!KNOWN_STEPS.includes(step)) {
    step = 'welcome';
    const db = await getDb();
    db.prepare('UPDATE wizard_state SET step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(step);
  }
  res.render('wizard', { step, state });
});

router.get('/step/:name', async (req, res) => {
  const name = req.params.name;
  if (EDITABLE_STEPS.includes(name)) {
    const db = await getDb();
    db.prepare('UPDATE wizard_state SET step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(name);
  }
  res.redirect('/wizard');
});

router.post('/php', async (req, res) => {
  const versions = (Array.isArray(req.body.versions) ? req.body.versions : [req.body.versions]).filter(Boolean).join(',');
  const phpFpmConfig = req.body.php_fpm_config === 'optimized' ? 'optimized' : 'default';
  const nodeVersion = ['', '18', '20', '22'].includes(req.body.node_version) ? req.body.node_version : '';
  const db = await getDb();
  db.prepare('UPDATE wizard_state SET php_versions = ?, php_fpm_config = ?, node_version = ?, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(versions || null, phpFpmConfig, nodeVersion || null, 'database');
  res.redirect('/wizard');
});

router.post('/database', async (req, res) => {
  const choice = req.body.choice === 'mariadb' ? 'mariadb' : 'mysql';
  const databaseConfig = req.body.database_config === 'optimized' ? 'optimized' : 'default';
  const password = (req.body.mysql_root_password || '').trim();
  const passwordAgain = (req.body.mysql_root_password_again || '').trim();

  if (password.length < 8) {
    const state = await getState();
    return res.render('wizard', { step: 'database', state, databaseError: 'Root password must be at least 8 characters.' });
  }
  if (password !== passwordAgain) {
    const state = await getState();
    return res.render('wizard', { step: 'database', state, databaseError: 'Passwords do not match.' });
  }

  const db = await getDb();
  setSetting(db, 'mysql_root_password', password);
  db.prepare('UPDATE wizard_state SET database_choice = ?, database_config = ?, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(choice, databaseConfig, 'options');
  res.redirect('/wizard');
});

router.post('/options', async (req, res) => {
  const db = await getDb();
  const email = req.body.install_email ? 1 : 0;
  const ftp = req.body.install_ftp ? 1 : 0;
  const certbot = req.body.install_certbot ? 1 : 0;
  db.prepare('UPDATE wizard_state SET email_installed = ?, ftp_installed = ?, certbot_installed = ?, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(email, ftp, certbot, 'review');
  res.redirect('/wizard');
});

router.post('/install', async (req, res) => {
  const state = await getState();
  const db = await getDb();
  const mysqlRootPassword = getSetting(db, 'mysql_root_password') || null;
  const result = runWizardInstall(state, { mysqlRootPassword });
  if (result.success) {
    db.prepare('UPDATE wizard_state SET completed = 1, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run('finish');
  }
  res.render('wizard', { step: 'result', state, success: result.success, log: result.log });
});

router.post('/install/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const state = await getState();
  const send = (data) => {
    res.write('data: ' + JSON.stringify(data) + '\n\n');
    if (typeof res.flush === 'function') res.flush();
  };

  try {
    const db = await getDb();
    const mysqlRootPassword = getSetting(db, 'mysql_root_password') || null;
    const result = await runWizardInstallStreaming(state, (text) => send({ msg: text }), { mysqlRootPassword });
    if (result.success) {
      db.prepare('UPDATE wizard_state SET completed = 1, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run('finish');
    }
    send({ done: true, success: result.success });
  } catch (err) {
    send({ msg: '\n' + (err.message || String(err)) + '\n' });
    send({ done: true, success: false });
  } finally {
    res.end();
  }
});

router.post('/complete', async (req, res) => {
  const db = await getDb();
  db.prepare('UPDATE wizard_state SET completed = 1, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run('finish');
  res.redirect('/');
});

module.exports = router;
