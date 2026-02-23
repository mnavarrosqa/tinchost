const Database = require('better-sqlite3');
const path = require('path');

let db = null;

function getDbPath() {
  const envPath = process.env.DATABASE_PATH;
  if (envPath) return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);
  return path.join(process.cwd(), 'data', 'panel.sqlite');
}

async function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

module.exports = { getDb, getDbPath };
