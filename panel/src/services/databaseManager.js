const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');

const SOCKET_PATHS = [
  '/var/run/mysqld/mysqld.sock',
  '/tmp/mysql.sock',
  '/var/lib/mysql/mysql.sock',
  '/run/mysqld/mysqld.sock'
];

function findSocket() {
  for (const p of SOCKET_PATHS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

/**
 * Run MySQL/MariaDB commands when root password is configured in settings.
 * Panel runs as root; connects to local MySQL and runs CREATE DATABASE, CREATE USER, GRANT.
 * Tries Unix socket first (same as `sudo mysql -u root -p`), then 127.0.0.1, then localhost.
 */
async function getConnection(settings) {
  const password = settings && settings.mysql_root_password;
  if (!password) return null;
  const opts = { user: 'root', password, multipleStatements: true };
  let lastErr = null;
  const socketPath = findSocket();
  if (socketPath) {
    try {
      return await mysql.createConnection({ ...opts, socketPath });
    } catch (err) {
      lastErr = err;
    }
  }
  for (const host of ['127.0.0.1', 'localhost']) {
    try {
      return await mysql.createConnection({ ...opts, host });
    } catch (err) {
      lastErr = err;
    }
  }
  const msg = lastErr && lastErr.message && lastErr.message.includes('Access denied')
    ? 'MySQL access denied for root. Check that the password in Settings matches the MySQL root password (e.g. run: sudo mysql -u root -p).'
    : (lastErr && lastErr.message) || 'MySQL connection failed';
  throw new Error(msg);
}

async function createDatabase(settings, name) {
  const conn = await getConnection(settings);
  if (!conn) throw new Error('MySQL root password not set in Settings');
  const safe = name.replace(/[^a-z0-9_]/gi, '');
  if (safe !== name) throw new Error('Invalid database name');
  await conn.execute('CREATE DATABASE IF NOT EXISTS ??', [safe]);
  await conn.end();
}

async function createUser(settings, username, password, host) {
  const conn = await getConnection(settings);
  if (!conn) throw new Error('MySQL root password not set in Settings');
  const safeUser = username.replace(/[^a-z0-9_]/gi, '');
  if (safeUser !== username) throw new Error('Invalid username');
  await conn.execute("CREATE USER IF NOT EXISTS ??@?? IDENTIFIED BY ?", [safeUser, host || 'localhost', password]);
  await conn.end();
}

async function setUserPassword(settings, username, newPassword, host) {
  const conn = await getConnection(settings);
  if (!conn) throw new Error('MySQL root password not set in Settings');
  const safeUser = username.replace(/[^a-z0-9_]/gi, '');
  if (safeUser !== username) throw new Error('Invalid username');
  await conn.execute('ALTER USER ??@?? IDENTIFIED BY ?', [safeUser, host || 'localhost', newPassword]);
  await conn.execute('FLUSH PRIVILEGES');
  await conn.end();
}

const PRIVILEGE_SETS = {
  ALL: 'ALL PRIVILEGES',
  READ_WRITE: 'SELECT, INSERT, UPDATE, DELETE',
  READ_ONLY: 'SELECT'
};

async function grantDatabase(settings, username, databaseName, host, privileges) {
  const conn = await getConnection(settings);
  if (!conn) throw new Error('MySQL root password not set in Settings');
  const safeDb = databaseName.replace(/[^a-z0-9_]/gi, '');
  const safeUser = username.replace(/[^a-z0-9_]/gi, '');
  const priv = PRIVILEGE_SETS[privileges === 'READ_ONLY' || privileges === 'READ_WRITE' ? privileges : 'ALL'] || PRIVILEGE_SETS.ALL;
  await conn.execute(`GRANT ${priv} ON ??.* TO ??@??`, [safeDb, safeUser, host || 'localhost']);
  await conn.execute('FLUSH PRIVILEGES');
  await conn.end();
}

module.exports = { getConnection, createDatabase, createUser, setUserPassword, grantDatabase, PRIVILEGE_SETS };
