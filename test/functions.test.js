const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { HttpError } = require('../src/httpError');
const {
  normalizeUtc,
  localDateString,
  formatTime,
  formatDuration,
  computeAmount,
  parseDateParam,
} = require('../src/time');
const { atomicWriteJson } = require('../src/atomic');
const { readConfig, writeConfig } = require('../src/configStore');
const { streamPdf } = require('../src/pdf');
const { openDatabase } = require('../src/db');
const { tempDataFolder } = require('./helpers');
const Database = require('better-sqlite3');

test('opening an older database adds task_name, lets entries outlive projects, and unarchives projects', () => {
  const folder = tempDataFolder();
  try {
    const old = new Database(path.join(folder, 'timetrack.db'));
    old.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        hourly_wage_cad REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id INTEGER,
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
      CREATE INDEX idx_entries_start ON entries(start_utc);
      INSERT INTO projects (name, archived) VALUES ('Old job', 1);
      INSERT INTO entries (project_id, start_utc, finish_utc, duration_seconds, amount_cad, notes)
      VALUES (1, '2026-01-05T15:00:00.000Z', '2026-01-05T16:00:00.000Z', 3600, 45, 'kept');
    `);
    old.close();

    const db = openDatabase(folder);
    const columns = db.prepare('PRAGMA table_info(entries)').all();
    assert.ok(columns.some((column) => column.name === 'task_name'));
    assert.ok(columns.some((column) => column.name === 'project_name'));
    assert.equal(columns.find((column) => column.name === 'project_id').notnull, 0);
    const projectKey = db.prepare('PRAGMA foreign_key_list(entries)').all().find((key) => key.from === 'project_id');
    assert.equal(projectKey.on_delete, 'SET NULL');
    const objects = db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'entries' AND type IN ('index', 'trigger')").all().map((row) => row.name);
    assert.ok(objects.includes('idx_entries_start'));
    assert.ok(objects.includes('idx_entries_project'));
    assert.ok(objects.includes('trg_entries_updated_at'));
    assert.deepEqual(db.prepare('SELECT id, project_id, notes, amount_cad FROM entries').all(), [
      { id: 1, project_id: 1, notes: 'kept', amount_cad: 45 },
    ]);
    assert.equal(db.prepare("SELECT archived FROM projects WHERE name = 'Old job'").get().archived, 0);
    db.prepare("UPDATE entries SET project_name = 'Old job' WHERE project_id = 1").run();
    db.prepare('DELETE FROM projects WHERE id = 1').run();
    assert.deepEqual(db.prepare('SELECT project_id, project_name FROM entries').get(), { project_id: null, project_name: 'Old job' });
    db.close();
    const reopened = openDatabase(folder);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 1);
    reopened.close();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('time helpers normalize, format, and reject bad dates', () => {
  assert.equal(normalizeUtc('2026-09-24T06:00:00Z'), '2026-09-24T06:00:00.000Z');
  assert.throws(() => normalizeUtc('not-a-date'), HttpError);
  assert.equal(localDateString('2026-09-24T06:00:00.000Z', -360), '2026-09-24');
  assert.equal(localDateString('2026-09-24T05:59:59.000Z', -360), '2026-09-23');

  const parts = { hour: 15, minute: 4, second: 5 };
  assert.equal(formatTime(parts, '24h'), '15:04:05');
  assert.equal(formatTime(parts, '12h'), '3:04:05 PM');
  assert.equal(formatTime({ hour: 0, minute: 0, second: 0 }, '12h'), '12:00:00 AM');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(computeAmount(3600, 45), 45);
  assert.equal(computeAmount(1, 90), 0.03);

  assert.equal(parseDateParam('2026-09-24', 'from'), '2026-09-24');
  assert.throws(() => parseDateParam('2026-02-31', 'from'), HttpError);
  assert.throws(() => parseDateParam('09-24-2026', 'to'), HttpError);
});

test('atomicWriteJson replaces the target and leaves no temp file', () => {
  const folder = tempDataFolder();
  const file = path.join(folder, 'active.json');
  try {
    atomicWriteJson(file, { isRunning: false });
    atomicWriteJson(file, { isRunning: true, notesDraft: 'kept' });
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.isRunning, true);
    assert.equal(saved.notesDraft, 'kept');
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('config seeds from the template and rejects invalid updates', () => {
  const folder = tempDataFolder();
  try {
    const seeded = readConfig(folder);
    assert.equal(seeded.dataFolder, folder);
    assert.equal(seeded.defaults.defaultHourlyWageCad, 45);
    assert.equal(seeded.defaults.defaultTimezone, 'America/Edmonton');
    assert.equal(seeded.ui.theme, 'auto');
    assert.equal(seeded.ui.timeFormat, '24h');
    assert.equal(seeded.database.filename, 'timetrack.db');

    const next = writeConfig(folder, {
      dataFolder: '/evil',
      database: { filename: 'other.db', walCheckpointOnStartup: false },
      defaults: { defaultHourlyWageCad: 80, defaultTimezone: 'America/Denver' },
      ui: { theme: 'dark', dateFormat: 'YYYY-MM-DD', timeFormat: '12h' },
      server: { port: 9090 },
    });
    assert.equal(next.dataFolder, folder);
    assert.equal(next.database.filename, 'timetrack.db');
    assert.equal(next.database.walCheckpointOnStartup, true);
    assert.equal(next.defaults.defaultHourlyWageCad, 80);
    assert.equal(next.ui.theme, 'dark');
    assert.equal(readConfig(folder).server.port, 9090);

    const bad = { ...next, ui: { ...next.ui, theme: 'blue' } };
    assert.throws(() => writeConfig(folder, bad), HttpError);
    assert.throws(() => writeConfig(folder, { ...next, ui: { ...next.ui, timeFormat: '16h' } }), HttpError);
    assert.throws(() => writeConfig(folder, {
      ...next,
      defaults: { ...next.defaults, defaultHourlyWageCad: -1 },
    }), HttpError);
    assert.throws(() => writeConfig(folder, {
      ...next,
      defaults: { ...next.defaults, defaultTimezone: '  ' },
    }), HttpError);
    assert.throws(() => writeConfig(folder, { ...next, ui: { ...next.ui, dateFormat: '' } }), HttpError);
    assert.throws(() => writeConfig(folder, { ...next, server: { port: 0 } }), HttpError);
    assert.equal(readConfig(folder).ui.theme, 'dark');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('pdf stream starts with a PDF header', async () => {
  const res = new PassThrough();
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => res.on('end', resolve));
  streamPdf(res, { entries: [], totalDurationSeconds: 0, totalAmountCad: 0 }, {
    from: '2026-09-01',
    to: '2026-09-02',
    timeFormat: '24h',
  });
  await done;
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
  assert.ok(bytes.length > 100);
});
