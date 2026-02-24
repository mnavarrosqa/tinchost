const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function getDbPath() {
  const envPath = process.env.DATABASE_PATH;
  if (envPath) return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);
  const cwdDb = path.join(process.cwd(), 'data', 'panel.sqlite');
  if (fs.existsSync(cwdDb)) return cwdDb;
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

module.exports = { getDb, getDbPath };
