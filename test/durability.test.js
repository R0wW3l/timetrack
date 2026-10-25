const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { openDatabase } = require('../src/db');
const { tempDataFolder, startServer } = require('./helpers');

const root = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function spawnServer(dataFolder) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATA_FOLDER: dataFolder, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(logs || 'server exited before listening');
    try {
      const response = await fetch(`${base}/api/config`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode != null) throw new Error(logs || 'server exited before listening');
  const probe = await fetch(`${base}/api/config`);
  if (!probe.ok) throw new Error(logs || 'server did not listen');
  return {
    child,
    base,
    logs: () => logs,
    async kill() {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill('SIGKILL');
      }
      await waitForExit(child);
    },
  };
}

test('SIGKILL keeps committed data, the running timer, and ignores a leftover temp file', async () => {
  const dataFolder = tempDataFolder();
  const server = await spawnServer(dataFolder);
  try {
    const project = await fetch(`${server.base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Survive', hourlyWageCad: 45 }),
    });
    const projectBody = await project.json();
    assert.equal(project.status, 201);
    const task = await fetch(`${server.base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectBody.id, name: 'Keep' }),
    });
    const taskBody = await task.json();
    const entry = await fetch(`${server.base}/api/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projectBody.id,
        taskId: taskBody.id,
        startUtc: '2026-05-01T15:00:00.000Z',
        finishUtc: '2026-05-01T16:00:00.000Z',
        tzOffsetMinutes: -360,
        notes: 'saved',
      }),
    });
    const entryBody = await entry.json();
    assert.equal(entry.status, 201);
    const config = await fetch(`${server.base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaults: { defaultHourlyWageCad: 70, defaultTimezone: 'America/Edmonton' },
        ui: { theme: 'dark', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' },
        server: { port: 8080 },
      }),
    });
    assert.equal(config.status, 200);
    const started = await fetch(`${server.base}/api/timer/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projectBody.id,
        taskId: taskBody.id,
        notesDraft: 'still running',
        tzOffsetMinutes: -360,
      }),
    });
    const timer = await started.json();
    assert.equal(started.status, 201);

    await server.kill();

    assert.equal(fs.existsSync(path.join(dataFolder, 'timetrack.db')), true);
    assert.equal(fs.existsSync(path.join(dataFolder, 'config.json')), true);
    assert.equal(fs.existsSync(path.join(dataFolder, 'active.json')), true);
    fs.writeFileSync(path.join(dataFolder, 'active.json.tmp'), '{not json');

    const recovered = await startServer(dataFolder);
    try {
      const projects = await recovered.request('GET', '/api/projects');
      assert.equal(projects.data[0].name, 'Survive');
      const entries = await recovered.request('GET', '/api/entries?from=2026-05-01&to=2026-05-01');
      assert.equal(entries.data.entries[0].id, entryBody.entry.id);
      assert.equal(entries.data.entries[0].notes, 'saved');
      const restoredConfig = await recovered.request('GET', '/api/config');
      assert.equal(restoredConfig.data.defaults.defaultHourlyWageCad, 70);
      assert.equal(restoredConfig.data.ui.theme, 'dark');
      const runningTimer = await recovered.request('GET', '/api/timer');
      assert.equal(runningTimer.data.isRunning, true);
      assert.equal(runningTimer.data.startUtc, timer.startUtc);
      assert.equal(runningTimer.data.notesDraft, 'still running');
      assert.equal(runningTimer.data.projectId, projectBody.id);
      assert.equal(runningTimer.data.taskId, taskBody.id);
      assert.equal(runningTimer.data.tzOffsetMinutes, -360);

      const integrity = recovered.db.pragma('integrity_check', { simple: true });
      assert.equal(integrity, 'ok');
      assert.equal(recovered.db.pragma('journal_mode', { simple: true }), 'wal');
    } finally {
      await recovered.close();
    }

    const reopened = openDatabase(dataFolder);
    try {
      const integrity = reopened.pragma('integrity_check', { simple: true });
      assert.equal(integrity, 'ok');
      const checkpoint = reopened.pragma('wal_checkpoint(TRUNCATE)', { simple: false });
      assert.equal(checkpoint[0].busy, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await server.kill();
    fs.rmSync(dataFolder, { recursive: true, force: true });
  }
});
