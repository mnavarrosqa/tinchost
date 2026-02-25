const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');

router.get('/', async (req, res) => {
  const db = await getDb();
  const domains = db.prepare(`
    SELECT md.*, (SELECT COUNT(*) FROM mailboxes WHERE mail_domain_id = md.id) as mailbox_count
    FROM mail_domains md ORDER BY domain
  `).all();
  const mailError = req.session.mailError || null;
  if (req.session.mailError) delete req.session.mailError;
  res.render('mail/list', { domains, mailError });
});

function isValidMailDomain(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim().toLowerCase();
  if (s.length === 0 || s.length > 253) return false;
  if (/[^a-z0-9.-]/.test(s) || s.startsWith('.') || s.endsWith('.') || /\.\./.test(s)) return false;
  const parts = s.split('.');
  return parts.length >= 2 && parts.every(p => p.length > 0 && p.length <= 63);
}

router.post('/domains', async (req, res) => {
  const { domain } = req.body || {};
  const trimmed = (domain != null && typeof domain === 'string') ? domain.trim().toLowerCase() : '';
  if (!trimmed) {
    req.session.mailError = 'Domain is required.';
    return res.redirect('/mail');
  }
  if (!isValidMailDomain(trimmed)) {
    req.session.mailError = 'Enter a valid domain (e.g. example.com).';
    return res.redirect('/mail');
  }
  const db = await getDb();
  if (db.prepare('SELECT id FROM mail_domains WHERE domain = ?').get(trimmed)) {
    req.session.mailError = 'This domain is already added.';
    return res.redirect('/mail');
  }
  try {
    db.prepare('INSERT INTO mail_domains (domain) VALUES (?)').run(trimmed);
  } catch (e) {
    req.session.mailError = (e && e.message) ? e.message : 'Could not add domain.';
    return res.redirect('/mail');
  }
  res.redirect('/mail');
});

module.exports = router;
