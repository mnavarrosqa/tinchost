const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('../config/database');

const PROFTPD_PASSWD_FILE = process.env.PROFTPD_PASSWD_FILE || '/etc/proftpd/ftpd.passwd';

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function syncFtpUsers() {
  const db = await getDb();
  const users = db.prepare(`
    SELECT fu.username, fu.password_hash, s.docroot
    FROM ftp_users fu
    JOIN sites s ON s.id = fu.site_id
    WHERE s.ftp_enabled = 1
  `).all();
  // ProFTPD with mod_sql or passwd file: write passwd file format if used
  // Stub: just ensure dir exists; actual ProFTPD config is wizard/install
  try {
    fs.mkdirSync(path.dirname(PROFTPD_PASSWD_FILE), { recursive: true });
  } catch (_) {}
  return users.length;
}

async function addFtpUser(siteId, username, password, defaultRoute) {
  const db = await getDb();
  const hash = hashPassword(password);
  const route = (defaultRoute != null && String(defaultRoute).trim() !== '') ? String(defaultRoute).trim() : '';
  db.prepare('INSERT INTO ftp_users (site_id, username, password_hash, default_route) VALUES (?, ?, ?, ?)').run(siteId, username, hash, route);
  await syncFtpUsers();
}

async function updateFtpUser(siteId, userId, updates) {
  const db = await getDb();
  const row = db.prepare('SELECT id FROM ftp_users WHERE id = ? AND site_id = ?').get(userId, siteId);
  if (!row) return;
  if (updates.password != null) {
    const hash = hashPassword(updates.password);
    db.prepare('UPDATE ftp_users SET password_hash = ? WHERE id = ? AND site_id = ?').run(hash, userId, siteId);
  }
  if (updates.default_route !== undefined) {
    const route = String(updates.default_route).trim();
    db.prepare('UPDATE ftp_users SET default_route = ? WHERE id = ? AND site_id = ?').run(route, userId, siteId);
  }
  await syncFtpUsers();
}

async function deleteFtpUser(siteId, userId) {
  const db = await getDb();
  db.prepare('DELETE FROM ftp_users WHERE id = ? AND site_id = ?').run(userId, siteId);
  await syncFtpUsers();
}

function getFtpUsersBySite(db, siteId) {
  return db.prepare('SELECT * FROM ftp_users WHERE site_id = ? ORDER BY username').all(siteId);
}

module.exports = { syncFtpUsers, addFtpUser, updateFtpUser, deleteFtpUser, getFtpUsersBySite, hashPassword };
