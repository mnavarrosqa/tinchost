try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { getDbPath } = require('../config/database');

const dbPath = getDbPath();
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wizard_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    step TEXT DEFAULT 'welcome',
    completed INTEGER DEFAULT 0,
    php_versions TEXT,
    php_fpm_config TEXT DEFAULT 'default',
    web_server TEXT,
    database_choice TEXT,
    database_config TEXT DEFAULT 'default',
    email_installed INTEGER DEFAULT 0,
    ftp_installed INTEGER DEFAULT 0,
    certbot_installed INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO wizard_state (id) VALUES (1);
`);
try {
  db.exec("ALTER TABLE wizard_state ADD COLUMN php_fpm_config TEXT DEFAULT 'default'");
} catch (_) { /* column may already exist */ }
try {
  db.exec("ALTER TABLE wizard_state ADD COLUMN database_config TEXT DEFAULT 'default'");
} catch (_) { /* column may already exist */ }
try {
  db.exec('ALTER TABLE databases ADD COLUMN site_id INTEGER REFERENCES sites(id)');
} catch (_) { /* column may already exist */ }
try {
  db.exec("ALTER TABLE db_grants ADD COLUMN privileges TEXT DEFAULT 'ALL'");
} catch (_) { /* column may already exist */ }
try {
  db.exec('ALTER TABLE db_users ADD COLUMN password_plain TEXT');
} catch (_) { /* column may already exist */ }
try {
  db.exec('ALTER TABLE ftp_users ADD COLUMN password_plain TEXT');
} catch (_) { /* column may already exist */ }
try {
  db.exec('ALTER TABLE ftp_users ADD COLUMN default_route TEXT DEFAULT ""');
} catch (_) { /* column may already exist */ }
try {
  db.exec('ALTER TABLE ftp_users ADD COLUMN crypt_hash TEXT');
} catch (_) { /* column may already exist */ }
try {
  db.exec('ALTER TABLE sites ADD COLUMN php_options TEXT');
} catch (_) { /* column may already exist */ }
db.exec(`

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    docroot TEXT NOT NULL,
    php_version TEXT,
    enabled INTEGER DEFAULT 1,
    ssl INTEGER DEFAULT 0,
    ftp_enabled INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ftp_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, username)
  );

  CREATE TABLE IF NOT EXISTS databases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    site_id INTEGER REFERENCES sites(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS db_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password_hash TEXT,
    host TEXT DEFAULT 'localhost',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS db_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    database_id INTEGER NOT NULL REFERENCES databases(id),
    db_user_id INTEGER NOT NULL REFERENCES db_users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(database_id, db_user_id)
  );

  CREATE TABLE IF NOT EXISTS mail_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mailboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mail_domain_id INTEGER NOT NULL REFERENCES mail_domains(id),
    local_part TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(mail_domain_id, local_part)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log('Migrations done:', dbPath);
db.close();
