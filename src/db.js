const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, '..', 'GrokFiles', 'schema.sql');

function openDatabase(dataFolder) {
  fs.mkdirSync(dataFolder, { recursive: true });
  const db = new Database(path.join(dataFolder, 'timetrack.db'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return db;
}

module.exports = { openDatabase };
