const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const { runWizardInstall, runWizardInstallStreaming } = require('../services/wizardInstall');

async function getState() {
  const db = await getDb();
  return db.prepare('SELECT * FROM wizard_state WHERE id = 1').get() || {};
}

const EDITABLE_STEPS = ['welcome', 'database', 'options', 'review'];

router.get('/', async (req, res) => {
  const state = await getState();
  const step = state.step || 'welcome';
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
  const db = await getDb();
  db.prepare('UPDATE wizard_state SET php_versions = ?, php_fpm_config = ?, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(versions || null, phpFpmConfig, 'database');
  res.redirect('/wizard');
});

router.post('/database', async (req, res) => {
  const choice = req.body.choice === 'mariadb' ? 'mariadb' : 'mysql';
  const db = await getDb();
  db.prepare('UPDATE wizard_state SET database_choice = ?, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(choice, 'options');
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
  const result = runWizardInstall(state);
  const db = await getDb();
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
    const result = await runWizardInstallStreaming(state, (text) => send({ msg: text }));
    const db = await getDb();
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
