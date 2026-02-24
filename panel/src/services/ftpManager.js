const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { getDb } = require('../config/database');

const PROFTPD_PASSWD_FILE = process.env.PROFTPD_PASSWD_FILE || '/etc/proftpd/ftpd.passwd';
const PROFTPD_CONF_DIR = process.env.PROFTPD_CONF_DIR || '/etc/proftpd/conf.d';
const FTP_UID = process.env.FTP_UID || '33';
const FTP_GID = process.env.FTP_GID || '33';

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/** Generate crypt hash for ProFTPD AuthUserFile (SHA-512, $6$). Returns null if openssl fails. */
function cryptHash(password) {
  if (!password || typeof password !== 'string') return null;
  try {
    const out = execFileSync('openssl', ['passwd', '-6', '-stdin'], { input: password + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return out && out.startsWith('$6$') ? out : null;
  } catch (_) {
    return null;
  }
}

async function syncFtpUsers() {
  const db = await getDb();
  const users = db.prepare(`
    SELECT fu.username, fu.crypt_hash, fu.default_route, s.docroot, s.domain
    FROM ftp_users fu
    JOIN sites s ON s.id = fu.site_id
    WHERE s.ftp_enabled = 1 AND fu.crypt_hash IS NOT NULL AND fu.crypt_hash != ''
  `).all();
  try {
    fs.mkdirSync(path.dirname(PROFTPD_PASSWD_FILE), { recursive: true });
  } catch (_) {}
  const lines = users.map((u) => {
    const route = (u.default_route && String(u.default_route).trim() !== '') ? String(u.default_route).trim().replace(/^\/+/, '') : '';
    const homedir = route !== '' ? path.join(u.docroot, route) : u.docroot;
    const loginName = `${String(u.username).trim()}@${String(u.domain)}`;
    return `${loginName}:${u.crypt_hash}:${FTP_UID}:${FTP_GID}::${homedir}:/sbin/nologin`;
  });
  fs.writeFileSync(PROFTPD_PASSWD_FILE, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  try {
    execFileSync('chown', ['root:root', PROFTPD_PASSWD_FILE], { stdio: 'pipe' });
    execFileSync('chmod', ['640', PROFTPD_PASSWD_FILE], { stdio: 'pipe' });
  } catch (_) {}
  writeProftpdConf();
  return users.length;
}

function writeProftpdConf() {
  try {
    fs.mkdirSync(PROFTPD_CONF_DIR, { recursive: true });
    const conf = `# Tinchost panel – virtual FTP users (AuthUserFile only)
# Panel must run on the same host as ProFTPD so this file and passwd file exist here.
<IfModule mod_auth_pam.c>
  AuthPAM off
</IfModule>
AuthOrder mod_auth_file.c
AuthUserFile ${PROFTPD_PASSWD_FILE}
RequireValidShell off
UseFtpUsers off
DefaultRoot ~
`;
    const confPath = path.join(PROFTPD_CONF_DIR, 'tinchost.conf');
    fs.writeFileSync(confPath, conf, 'utf8');
    execFileSync('systemctl', ['reload', 'proftpd'], { stdio: 'pipe' });
  } catch (_) {}
}

async function addFtpUser(siteId, username, password, defaultRoute) {
  const crypt = cryptHash(password);
  if (!crypt) throw new Error('Could not generate FTP password hash. Ensure openssl is installed (e.g. apt install openssl).');
  const db = await getDb();
  const hash = hashPassword(password);
  const route = (defaultRoute != null && String(defaultRoute).trim() !== '') ? String(defaultRoute).trim() : '';
  db.prepare('INSERT INTO ftp_users (site_id, username, password_hash, default_route, crypt_hash, password_plain) VALUES (?, ?, ?, ?, ?, ?)').run(siteId, username, hash, route, crypt, password);
  await syncFtpUsers();
}

async function updateFtpUser(siteId, userId, updates) {
  const db = await getDb();
  const row = db.prepare('SELECT id FROM ftp_users WHERE id = ? AND site_id = ?').get(userId, siteId);
  if (!row) return;
  if (updates.password != null) {
    const crypt = cryptHash(updates.password);
    if (!crypt) throw new Error('Could not generate FTP password hash. Ensure openssl is installed.');
    const hash = hashPassword(updates.password);
    db.prepare('UPDATE ftp_users SET password_hash = ?, crypt_hash = ?, password_plain = ? WHERE id = ? AND site_id = ?').run(hash, crypt, updates.password, userId, siteId);
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
