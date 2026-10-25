const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

let server;
let base;
let dataFolder;
let db;

before(async () => {
  dataFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'timetrack-'));
  const app = createApp(dataFolder);
  db = app.locals.db;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dataFolder, { recursive: true, force: true });
});

async function request(method, urlPath, body) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: body == null ? undefined : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data, headers: response.headers };
}

test('local midnight counts as that day and one second earlier is the previous day', async () => {
  const project = await request('POST', '/api/projects', { name: 'Boundary', hourlyWageCad: 45 });
  const task = await request('POST', '/api/tasks', { projectId: project.data.id, name: 'Work' });

  async function add(startUtc, offset) {
    const finishUtc = new Date(Date.parse(startUtc) + 60 * 1000).toISOString();
    const created = await request('POST', '/api/entries', {
      projectId: project.data.id,
      taskId: task.data.id,
      startUtc,
      finishUtc,
      tzOffsetMinutes: offset,
      notes: `${offset}:${startUtc}`,
    });
    assert.equal(created.status, 201);
    return created.data.entry.id;
  }

  const midnightNeg = await add('2026-09-24T06:00:00.000Z', -360);
  const beforeNeg = await add('2026-09-24T05:59:59.000Z', -360);
  const day24 = await request('GET', '/api/entries?from=2026-09-24&to=2026-09-24');
  const day23 = await request('GET', '/api/entries?from=2026-09-23&to=2026-09-23');
  assert.deepEqual(day24.data.entries.map((entry) => entry.id), [midnightNeg]);
  assert.deepEqual(day23.data.entries.map((entry) => entry.id), [beforeNeg]);

  const midnightPos = await add('2026-09-23T22:00:00.000Z', 120);
  const beforePos = await add('2026-09-23T21:59:59.000Z', 120);
  const again24 = await request('GET', '/api/entries?from=2026-09-24&to=2026-09-24');
  const again23 = await request('GET', '/api/entries?from=2026-09-23&to=2026-09-23');
  const ids24 = again24.data.entries.map((entry) => entry.id);
  const ids23 = again23.data.entries.map((entry) => entry.id);
  assert.ok(ids24.includes(midnightPos));
  assert.ok(!ids24.includes(beforePos));
  assert.ok(ids23.includes(beforePos));
  assert.ok(!ids23.includes(midnightPos));
});

test('overlap warns without blocking, and amounts can be overridden', async () => {
  const project = await request('POST', '/api/projects', { name: 'Overlap', hourlyWageCad: 45 });
  const task = await request('POST', '/api/tasks', { projectId: project.data.id, name: 'Design' });
  const first = await request('POST', '/api/entries', {
    projectId: project.data.id,
    taskId: task.data.id,
    startUtc: '2026-08-01T15:00:00.000Z',
    finishUtc: '2026-08-01T16:00:00.000Z',
    tzOffsetMinutes: -360,
    notes: 'first',
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.overlapWarning, false);
  assert.equal(first.data.entry.amountCad, 45);
  assert.equal(first.data.entry.amountOverridden, false);

  const second = await request('POST', '/api/entries', {
    projectId: project.data.id,
    taskId: task.data.id,
    startUtc: '2026-08-01T15:30:00.000Z',
    finishUtc: '2026-08-01T16:30:00.000Z',
    tzOffsetMinutes: -360,
    notes: 'second',
    amountOverridden: true,
    amountCad: 12.5,
  });
  assert.equal(second.status, 201);
  assert.equal(second.data.overlapWarning, true);
  assert.deepEqual(second.data.overlappingEntryIds, [first.data.entry.id]);
  assert.equal(second.data.entry.amountCad, 12.5);
  assert.equal(second.data.entry.amountOverridden, true);
});

test('timer writes active.json and clears it only after the entry commits', async () => {
  const project = await request('POST', '/api/projects', { name: 'Timer', hourlyWageCad: 90 });
  const task = await request('POST', '/api/tasks', { projectId: project.data.id, name: 'Build' });
  const started = await request('POST', '/api/timer/start', {
    projectId: project.data.id,
    taskId: task.data.id,
    notesDraft: 'draft',
    tzOffsetMinutes: -360,
  });
  assert.equal(started.status, 201);
  assert.equal(fs.existsSync(path.join(dataFolder, 'active.json')), true);
  const again = await request('POST', '/api/timer/start', {
    projectId: project.data.id,
    taskId: task.data.id,
    notesDraft: '',
    tzOffsetMinutes: -360,
  });
  assert.equal(again.status, 409);

  const noted = await request('PUT', '/api/timer', { notesDraft: 'still going' });
  assert.equal(noted.status, 200);
  assert.equal(noted.data.notesDraft, 'still going');
  assert.equal(noted.data.startUtc, started.data.startUtc);

  const stopped = await request('POST', '/api/timer/stop', { notes: 'done' });
  assert.equal(stopped.status, 200);
  assert.equal(fs.existsSync(path.join(dataFolder, 'active.json')), false);
  assert.equal(stopped.data.entry.notes, 'done');
  assert.equal(stopped.data.entry.projectName, 'Timer');
  const idle = await request('GET', '/api/timer');
  assert.deepEqual(idle.data, { isRunning: false });
});

test('pdf response is a downloadable file', async () => {
  const response = await fetch(`${base}/api/reports/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '2026-09-23', to: '2026-09-24' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
});
