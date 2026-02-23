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

async function addFtpUser(siteId, username, password) {
  const db = await getDb();
  const hash = hashPassword(password);
  db.prepare('INSERT INTO ftp_users (site_id, username, password_hash) VALUES (?, ?, ?)').run(siteId, username, hash);
  await syncFtpUsers();
}

module.exports = { syncFtpUsers, addFtpUser, hashPassword };
