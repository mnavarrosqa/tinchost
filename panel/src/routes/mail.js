const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');

router.get('/', async (req, res) => {
  const db = await getDb();
  const domains = db.prepare(`
    SELECT md.*, (SELECT COUNT(*) FROM mailboxes WHERE mail_domain_id = md.id) as mailbox_count
    FROM mail_domains md ORDER BY domain
  `).all();
  res.render('mail/list', { domains });
});

router.post('/domains', async (req, res) => {
  const { domain } = req.body || {};
  if (!domain) return res.redirect('/mail');
  const db = await getDb();
  try {
    db.prepare('INSERT INTO mail_domains (domain) VALUES (?)').run(domain);
  } catch (e) {}
  res.redirect('/mail');
});

module.exports = router;
