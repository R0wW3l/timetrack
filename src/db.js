const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, '..', 'GrokFiles', 'schema.sql');

const ENTRY_COPY_COLUMNS = `
  id, project_id, task_id, task_name, start_utc, finish_utc, tz_offset_minutes,
  duration_seconds, amount_cad, amount_overridden, notes, overlap_acknowledged,
  created_at, updated_at
`;

// SQLite cannot drop NOT NULL from a column, so older databases get a new entries
// table that lets kept entries outlive their deleted project.
function allowEntriesWithoutProject(db, schema) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE entries_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          project_name TEXT,
          task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
          task_name TEXT,
          start_utc TEXT NOT NULL,
          finish_utc TEXT NOT NULL,
          tz_offset_minutes INTEGER NOT NULL DEFAULT 0,
          duration_seconds INTEGER NOT NULL,
          amount_cad REAL NOT NULL DEFAULT 0,
          amount_overridden INTEGER NOT NULL DEFAULT 0,
          notes TEXT DEFAULT '',
          overlap_acknowledged INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          CHECK (finish_utc > start_utc)
        );
        INSERT INTO entries_new (${ENTRY_COPY_COLUMNS}) SELECT ${ENTRY_COPY_COLUMNS} FROM entries;
        DROP TABLE entries;
        ALTER TABLE entries_new RENAME TO entries;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  // Dropping the old table also dropped its indexes and trigger.
  db.exec(schema);
}

function openDatabase(dataFolder) {
  fs.mkdirSync(dataFolder, { recursive: true });
  const db = new Database(path.join(dataFolder, 'timetrack.db'));
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  const entryColumns = db.prepare('PRAGMA table_info(entries)').all();
  if (!entryColumns.some((column) => column.name === 'task_name')) db.exec('ALTER TABLE entries ADD COLUMN task_name TEXT');
  if (entryColumns.find((column) => column.name === 'project_id').notnull) allowEntriesWithoutProject(db, schema);
  // Archiving was removed; bring back projects archived by older versions.
  db.prepare('UPDATE projects SET archived = 0 WHERE archived = 1').run();
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return db;
}

module.exports = { openDatabase };
