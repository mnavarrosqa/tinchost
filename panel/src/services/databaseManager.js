const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');

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

function escapeId(id) {
  return '`' + String(id).replace(/`/g, '``') + '`';
}

function escapeAccountPart(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

function escapeString(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
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
  await conn.execute('CREATE DATABASE IF NOT EXISTS ' + escapeId(safe));
  await conn.end();
}

async function dropDatabase(settings, name) {
  const conn = await getConnection(settings);
  if (!conn) return;
  const safe = name.replace(/[^a-z0-9_]/gi, '');
  await conn.execute('DROP DATABASE IF EXISTS ' + escapeId(safe));
  await conn.end();
}

async function createUser(settings, username, password, host) {
  const conn = await getConnection(settings);
  if (!conn) throw new Error('MySQL root password not set in Settings');
  const safeUser = username.replace(/[^a-z0-9_]/gi, '');
  if (safeUser !== username) throw new Error('Invalid username');
  const h = host || 'localhost';
  await conn.execute("CREATE USER IF NOT EXISTS " + escapeAccountPart(safeUser) + "@" + escapeAccountPart(h) + " IDENTIFIED BY " + escapeString(password));
  await conn.execute('FLUSH PRIVILEGES');
  await conn.end();
}

async function setUserPassword(settings, username, newPassword, host) {
  const conn = await getConnection(settings);
  if (!conn) throw new Error('MySQL root password not set in Settings');
  const safeUser = username.replace(/[^a-z0-9_]/gi, '');
  if (safeUser !== username) throw new Error('Invalid username');
  const h = host || 'localhost';
  await conn.execute('ALTER USER ' + escapeAccountPart(safeUser) + '@' + escapeAccountPart(h) + ' IDENTIFIED BY ' + escapeString(newPassword));
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
  const h = host || 'localhost';
  const priv = PRIVILEGE_SETS[privileges === 'READ_ONLY' || privileges === 'READ_WRITE' ? privileges : 'ALL'] || PRIVILEGE_SETS.ALL;
  await conn.execute('GRANT ' + priv + ' ON ' + escapeId(safeDb) + '.* TO ' + escapeAccountPart(safeUser) + '@' + escapeAccountPart(h));
  await conn.execute('FLUSH PRIVILEGES');
  await conn.end();
}

async function revokeDatabase(settings, username, databaseName, host) {
  const conn = await getConnection(settings);
  if (!conn) return;
  const safeDb = databaseName.replace(/[^a-z0-9_]/gi, '');
  const safeUser = username.replace(/[^a-z0-9_]/gi, '');
  const h = host || 'localhost';
  await conn.execute('REVOKE ALL PRIVILEGES ON ' + escapeId(safeDb) + '.* FROM ' + escapeAccountPart(safeUser) + '@' + escapeAccountPart(h));
  await conn.execute('FLUSH PRIVILEGES');
  await conn.end();
}

async function dropUser(settings, username, host) {
  const conn = await getConnection(settings);
  if (!conn) return;
  const safeUser = username.replace(/[^a-z0-9_]/gi, '');
  const h = host || 'localhost';
  await conn.execute('DROP USER IF EXISTS ' + escapeAccountPart(safeUser) + '@' + escapeAccountPart(h));
  await conn.execute('FLUSH PRIVILEGES');
  await conn.end();
}

function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return '0 B';
  const n = Number(bytes);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' GB';
}

/**
 * Get human-readable sizes for the given database names. Returns { dbName: "12.5 MB", ... }.
 * On error or no MySQL config, returns {}.
 */
async function getDatabaseSizes(settings, dbNames) {
  if (!dbNames || dbNames.length === 0) return {};
  let conn;
  try {
    conn = await getConnection(settings);
    if (!conn) return {};
  } catch (_) {
    return {};
  }
  const result = {};
  try {
    const placeholders = dbNames.map(() => '?').join(',');
    const [rows] = await conn.execute(
      `SELECT table_schema AS db_name, COALESCE(SUM(data_length + index_length), 0) AS size_bytes
       FROM information_schema.tables
       WHERE table_schema IN (${placeholders})
       GROUP BY table_schema`,
      dbNames
    );
    for (const row of rows || []) {
      const name = row.db_name || row.DB_NAME;
      const bytes = row.size_bytes != null ? Number(row.size_bytes) : 0;
      if (name) result[name] = formatBytes(bytes);
    }
    for (const name of dbNames) {
      if (result[name] === undefined) result[name] = formatBytes(0);
    }
  } catch (_) {
    // leave result empty or partial
  } finally {
    try { await conn.end(); } catch (_) {}
  }
  return result;
}

/**
 * Build connection args for MySQL CLI tools (mysqldump, mysqlcheck). Returns { args, env }.
 */
function getMysqlCliOpts(settings) {
  const password = settings && settings.mysql_root_password;
  if (!password) return null;
  const socketPath = findSocket();
  const args = socketPath ? ['--socket', socketPath] : ['-h', '127.0.0.1'];
  return { args, env: { ...process.env, MYSQL_PWD: password } };
}

/**
 * Stream a compressed dump of the database to the given writable stream.
 * Returns a Promise that resolves with the readable stream (gzip output) once the pipeline is set up.
 * Caller should set response headers then pipe the stream to res.
 */
function streamDatabaseDump(settings, dbName) {
  const safe = String(dbName).replace(/[^a-z0-9_]/gi, '');
  if (safe !== dbName) throw new Error('Invalid database name');
  const opts = getMysqlCliOpts(settings);
  if (!opts) throw new Error('MySQL root password not set in Settings');
  return new Promise((resolve, reject) => {
    const dumpArgs = ['--single-transaction', '-u', 'root', ...opts.args, safe];
    const mysqldump = spawn('mysqldump', dumpArgs, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const gzip = spawn('gzip', ['-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    mysqldump.stdout.pipe(gzip.stdin);
    mysqldump.stderr.on('data', () => { gzip.stdin.destroy(); });
    gzip.stdin.on('error', () => {});
    gzip.stdout.on('error', (err) => reject(err));
    mysqldump.on('error', (err) => { gzip.stdin.destroy(); reject(err); });
    gzip.on('error', (err) => reject(err));
    resolve(gzip.stdout);
  });
}

/**
 * Run mysqlcheck --repair on the database. Returns { ok, message }.
 */
async function repairDatabase(settings, dbName) {
  const safe = String(dbName).replace(/[^a-z0-9_]/gi, '');
  if (safe !== dbName) return { ok: false, message: 'Invalid database name' };
  const opts = getMysqlCliOpts(settings);
  if (!opts) return { ok: false, message: 'MySQL root password not set in Settings' };
  return new Promise((resolve) => {
    const args = ['-u', 'root', '--repair', ...opts.args, safe];
    const proc = spawn('mysqlcheck', args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true, message: 'Repair completed.' });
      else resolve({ ok: false, message: (stderr || stdout || 'mysqlcheck failed').trim().slice(0, 200) });
    });
    proc.on('error', (err) => resolve({ ok: false, message: err.message || 'mysqlcheck not found' }));
  });
}

module.exports = { getConnection, createDatabase, dropDatabase, createUser, setUserPassword, grantDatabase, revokeDatabase, dropUser, PRIVILEGE_SETS, getDatabaseSizes, formatBytes, streamDatabaseDump, repairDatabase };
