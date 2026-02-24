const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function getDbPath() {
  const envPath = process.env.DATABASE_PATH;
  if (envPath && envPath.trim()) {
    const p = envPath.trim();
    return path.isAbsolute(p) ? p : path.join(__dirname, '..', '..', p);
  }
  return path.join(__dirname, '..', '..', 'data', 'panel.sqlite');
}

function ensureSettingsTable(database) {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (_) {}
}

async function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  ensureSettingsTable(db);
  return db;
}

function getSetting(database, key) {
  try {
    const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row) return row.value !== undefined ? row.value : row.VALUE;
    const all = database.prepare('SELECT key, value FROM settings').all();
    for (const r of all || []) {
      const k = r.key !== undefined ? r.key : r.KEY;
      if (k === key) return r.value !== undefined ? r.value : r.VALUE;
    }
  } catch (_) {}
  return null;
}

module.exports = { getDb, getDbPath, getSetting };
