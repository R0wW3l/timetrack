const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { computeAmount } = require('../src/time');
const { tempDataFolder } = require('./helpers');

const root = path.join(__dirname, '..');
const composeFile = path.join(root, 'docker-compose.crash-test.yml');
const base = 'http://127.0.0.1:18080';

function dockerAvailable() {
  return spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
}

function compose(dataFolder, args) {
  const result = spawnSync(
    'docker',
    ['compose', '-p', 'timetrack-crash', '-f', composeFile, ...args],
    {
      cwd: root,
      env: { ...process.env, DATA_FOLDER: dataFolder },
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) {
    throw new Error(`${result.stderr || ''}\n${result.stdout || ''}`.trim() || `compose ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function composeDown(dataFolder) {
  spawnSync(
    'docker',
    ['compose', '-p', 'timetrack-crash', '-f', composeFile, 'down', '--remove-orphans'],
    {
      cwd: root,
      env: { ...process.env, DATA_FOLDER: dataFolder },
      encoding: 'utf8',
    }
  );
}

async function api(method, urlPath, body) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: body == null ? undefined : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data, headers: response.headers, text };
}

async function waitForApi() {
  const start = Date.now();
  let last = 'no response';
  while (Date.now() - start < 90000) {
    try {
      const response = await fetch(`${base}/api/config`);
      if (response.ok) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`API did not return: ${last}`);
}

function containerId(dataFolder) {
  const result = spawnSync(
    'docker',
    ['compose', '-p', 'timetrack-crash', '-f', composeFile, 'ps', '-q'],
    {
      cwd: root,
      env: { ...process.env, DATA_FOLDER: dataFolder },
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) throw new Error(result.stderr || 'compose ps failed');
  const id = result.stdout.trim().split('\n').filter(Boolean)[0];
  if (!id) throw new Error('crash-test container is not running');
  return id;
}

function inspect(id, format) {
  const result = spawnSync('docker', ['inspect', '-f', format, id], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'docker inspect failed');
  return result.stdout.trim();
}

function restartCount(id) {
  return Number(inspect(id, '{{.RestartCount}}'));
}

function integrity(dataFolder) {
  const db = new Database(path.join(dataFolder, 'timetrack.db'));
  db.pragma('busy_timeout = 5000');
  try {
    return db.pragma('integrity_check', { simple: true });
  } finally {
    db.close();
  }
}

async function killAndWait(id) {
  const previousCount = restartCount(id);
  const hostPid = inspect(id, '{{.State.Pid}}');
  // docker kill marks the container manually stopped, so unless-stopped does not
  // bring it back. Killing the process from the daemon PID namespace is a sudden
  // SIGKILL and leaves the restart policy in force.
  const killed = spawnSync(
    'docker',
    ['run', '--rm', '--privileged', '--pid=host', 'alpine', 'kill', '-9', hostPid],
    { encoding: 'utf8' }
  );
  if (killed.status !== 0) throw new Error(killed.stderr || killed.stdout || 'sudden kill failed');
  const start = Date.now();
  let count = previousCount;
  while (Date.now() - start < 60000) {
    try {
      count = restartCount(id);
      if (count > previousCount) break;
    } catch {
      // inspect can fail while Docker is restarting the container
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(count > previousCount, 'container did not restart on its own');
  await waitForApi();
}

test('docker kill restarts the container and keeps every feature', { timeout: 600000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip('docker info failed');
    return;
  }
  const dataFolder = tempDataFolder();
  try {
    composeDown(dataFolder);
    compose(dataFolder, ['up', '--build', '-d']);
    await waitForApi();

    const seeded = await api('GET', '/api/config');
    assert.equal(seeded.data.dataFolder, '/data');
    assert.equal(seeded.data.defaults.defaultHourlyWageCad, 45);
    assert.equal(seeded.data.ui.theme, 'auto');
    assert.equal(seeded.data.defaults.defaultTimezone, 'America/Edmonton');
    assert.equal(fs.existsSync(path.join(dataFolder, 'timetrack.db')), true);

    const project = await api('POST', '/api/projects', { name: 'alpha', hourlyWageCad: 45 });
    assert.equal(project.status, 201);
    const priced = await api('POST', '/api/projects', { name: 'Beta', hourlyWageCad: 80 });
    assert.equal(priced.status, 201);
    const duplicate = await api('POST', '/api/projects', { name: 'alpha' });
    assert.equal(duplicate.status, 409);
    const task = await api('POST', '/api/tasks', { projectId: project.data.id, name: 'Design' });
    assert.equal(task.status, 201);
    const sameTask = await api('POST', '/api/tasks', { projectId: project.data.id, name: 'Design' });
    assert.equal(sameTask.status, 200);
    assert.equal(sameTask.data.id, task.data.id);
    const entry = await api('POST', '/api/entries', {
      projectId: project.data.id,
      taskId: task.data.id,
      startUtc: '2026-04-01T15:00:00.000Z',
      finishUtc: '2026-04-01T16:00:00.000Z',
      tzOffsetMinutes: -360,
      notes: 'kept',
    });
    assert.equal(entry.status, 201);
    const edited = await api('PUT', `/api/entries/${entry.data.entry.id}`, {
      projectId: project.data.id,
      taskId: task.data.id,
      startUtc: '2026-04-01T15:00:00.000Z',
      finishUtc: '2026-04-01T17:00:00.000Z',
      tzOffsetMinutes: -360,
      notes: 'edited',
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.entry.amountCad, 90);
    const savedConfig = await api('PUT', '/api/config', {
      dataFolder: '/evil',
      database: { filename: 'other.db' },
      defaults: { defaultHourlyWageCad: 60, defaultTimezone: 'America/Edmonton' },
      ui: { theme: 'dark', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' },
      server: { port: 8080 },
    });
    assert.equal(savedConfig.status, 200);
    assert.equal(savedConfig.data.dataFolder, '/data');
    assert.equal(savedConfig.data.database.filename, 'timetrack.db');
    const pdf = await fetch(`${base}/api/reports/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-04-01', to: '2026-04-01' }),
    });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-disposition'), /attachment/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

    const before = {
      projects: (await api('GET', '/api/projects')).data,
      entries: (await api('GET', '/api/entries?from=2026-04-01&to=2026-04-01')).data,
      config: (await api('GET', '/api/config')).data,
      timer: (await api('GET', '/api/timer')).data,
    };
    assert.deepEqual(before.timer, { isRunning: false });

    await killAndWait(containerId(dataFolder));
    assert.equal(integrity(dataFolder), 'ok');
    const afterKill = {
      projects: (await api('GET', '/api/projects')).data,
      entries: (await api('GET', '/api/entries?from=2026-04-01&to=2026-04-01')).data,
      config: (await api('GET', '/api/config')).data,
      timer: (await api('GET', '/api/timer')).data,
    };
    assert.deepEqual(afterKill, before);

    const started = await api('POST', '/api/timer/start', {
      projectId: project.data.id,
      taskId: task.data.id,
      notesDraft: 'across kill',
      tzOffsetMinutes: -360,
    });
    assert.equal(started.status, 201);
    const noted = await api('PUT', '/api/timer', { notesDraft: 'still across kill' });
    assert.equal(noted.status, 200);
    const range = '/api/entries?from=2020-01-01&to=2035-12-31';
    const entriesBefore = (await api('GET', range)).data.entries.length;
    await killAndWait(containerId(dataFolder));
    const resumed = await api('GET', '/api/timer');
    assert.equal(resumed.data.isRunning, true);
    assert.equal(resumed.data.startUtc, started.data.startUtc);
    assert.equal(resumed.data.notesDraft, 'still across kill');
    assert.equal(resumed.data.projectId, project.data.id);
    assert.equal(resumed.data.taskId, task.data.id);
    assert.equal(resumed.data.tzOffsetMinutes, -360);
    assert.equal((await api('GET', range)).data.entries.length, entriesBefore);
    const stopped = await api('POST', '/api/timer/stop', { notes: 'after restart' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.data.entry.notes, 'after restart');
    assert.equal(
      stopped.data.entry.amountCad,
      computeAmount(stopped.data.entry.durationSeconds, 45)
    );
    assert.equal(fs.existsSync(path.join(dataFolder, 'active.json')), false);
    assert.equal((await api('GET', range)).data.entries.length, entriesBefore + 1);

    const extra = await api('POST', '/api/projects', { name: 'After', hourlyWageCad: 10 });
    assert.equal(extra.status, 201);
    const renamed = await api('PUT', `/api/projects/${extra.data.id}`, {
      name: 'After edit',
      hourlyWageCad: 11,
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.hourlyWageCad, 11);
    const archived = await api('DELETE', `/api/projects/${priced.data.id}`);
    assert.equal(archived.data.archived, true);
    const extraTask = await api('POST', '/api/tasks', { projectId: extra.data.id, name: 'Later' });
    assert.equal(extraTask.status, 201);
    const manual = await api('POST', '/api/entries', {
      projectId: extra.data.id,
      taskId: extraTask.data.id,
      startUtc: '2026-04-02T15:00:00.000Z',
      finishUtc: '2026-04-02T16:00:00.000Z',
      tzOffsetMinutes: -360,
      notes: 'post kill',
    });
    assert.equal(manual.status, 201);
    const removed = await api('DELETE', `/api/entries/${manual.data.entry.id}`);
    assert.equal(removed.status, 204);
    const report = await fetch(`${base}/api/reports/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-04-01', to: '2026-04-02' }),
    });
    assert.equal(report.status, 200);
    assert.equal(report.headers.get('content-type'), 'application/pdf');
    const theme = await api('PUT', '/api/config', {
      defaults: { defaultHourlyWageCad: 61, defaultTimezone: 'America/Edmonton' },
      ui: { theme: 'light', dateFormat: 'YYYY-MM-DD', timeFormat: '12h' },
      server: { port: 8080 },
    });
    assert.equal(theme.status, 200);
    assert.equal((await api('GET', '/api/config')).data.ui.theme, 'light');
    assert.equal(integrity(dataFolder), 'ok');
  } finally {
    composeDown(dataFolder);
    fs.rmSync(dataFolder, { recursive: true, force: true });
  }
});
