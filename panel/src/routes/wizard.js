const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');

router.get('/', async (req, res) => {
  const db = await getDb();
  const state = db.prepare('SELECT * FROM wizard_state WHERE id = 1').get();
  res.render('wizard', { step: state?.step || 'welcome', state: state || {} });
});

router.get('/step/:step', async (req, res) => {
  const db = await getDb();
  db.prepare('UPDATE wizard_state SET step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(req.params.step);
  res.redirect('/wizard');
});

router.post('/complete', async (req, res) => {
  const db = await getDb();
  db.prepare('UPDATE wizard_state SET completed = 1, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run('finish');
  res.redirect('/');
});

router.post('/php', async (req, res) => {
  const versions = (req.body.versions || []).join(',');
  const db = await getDb();
  db.prepare('UPDATE wizard_state SET php_versions = ?, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(versions, 'web_server');
  res.redirect('/wizard');
});

router.post('/database', async (req, res) => {
  const choice = req.body.choice || 'mysql';
  const db = await getDb();
  db.prepare('UPDATE wizard_state SET database_choice = ?, step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(choice, 'email');
  res.redirect('/wizard');
});

module.exports = router;
