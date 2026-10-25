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
const { tempDataFolder } = require('./helpers');

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
