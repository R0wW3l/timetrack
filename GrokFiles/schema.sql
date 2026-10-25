PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    hourly_wage_cad REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS idx_entries_start ON entries(start_utc);
CREATE INDEX IF NOT EXISTS idx_entries_finish ON entries(finish_utc);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id);

CREATE TRIGGER IF NOT EXISTS trg_entries_updated_at
AFTER UPDATE ON entries
BEGIN
    UPDATE entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
