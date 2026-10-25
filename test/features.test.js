const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { computeAmount } = require('../src/time');
const { tempDataFolder, startServer } = require('./helpers');

let running;
let request;
let dataFolder;

before(async () => {
  dataFolder = tempDataFolder();
  running = await startServer(dataFolder);
  request = running.request;
});

after(async () => {
  if (running) await running.close();
  fs.rmSync(dataFolder, { recursive: true, force: true });
});

test('projects use the default wage, reject duplicates, and archive', async () => {
  const seeded = await request('GET', '/api/config');
  assert.equal(seeded.data.defaults.defaultHourlyWageCad, 45);

  const defaults = await request('POST', '/api/projects', { name: 'alpha' });
  assert.equal(defaults.status, 201);
  assert.equal(defaults.data.hourlyWageCad, 45);
  assert.equal(defaults.data.archived, false);

  const priced = await request('POST', '/api/projects', { name: 'Beta', hourlyWageCad: 80 });
  assert.equal(priced.status, 201);
  assert.equal(priced.data.hourlyWageCad, 80);

  const duplicate = await request('POST', '/api/projects', { name: 'alpha', hourlyWageCad: 10 });
  assert.equal(duplicate.status, 409);

  const empty = await request('POST', '/api/projects', { name: '   ', hourlyWageCad: 10 });
  assert.equal(empty.status, 400);
  const negative = await request('POST', '/api/projects', { name: 'Nope', hourlyWageCad: -1 });
  assert.equal(negative.status, 400);

  const listed = await request('GET', '/api/projects');
  assert.deepEqual(listed.data.map((project) => project.name), ['alpha', 'Beta']);

  const updated = await request('PUT', `/api/projects/${priced.data.id}`, {
    name: 'Beta',
    hourlyWageCad: 81,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.hourlyWageCad, 81);

  const archived = await request('DELETE', `/api/projects/${defaults.data.id}`);
  assert.equal(archived.status, 200);
  assert.equal(archived.data.archived, true);
  const afterArchive = await request('GET', '/api/projects');
  assert.deepEqual(afterArchive.data.map((project) => project.name), ['Beta', 'alpha']);

  const missing = await request('DELETE', '/api/projects/99999');
  assert.equal(missing.status, 404);
  const badId = await request('PUT', '/api/projects/abc', { name: 'x', hourlyWageCad: 1 });
  assert.equal(badId.status, 400);
  const zeroId = await request('GET', '/api/projects/0');
  assert.equal(zeroId.status, 404);

  const restored = await request('PUT', `/api/projects/${defaults.data.id}`, { archived: false });
  assert.equal(restored.data.archived, false);
});

test('tasks dedupe by name and stay on their project', async () => {
  const project = await request('POST', '/api/projects', { name: 'Tasks', hourlyWageCad: 40 });
  const other = await request('POST', '/api/projects', { name: 'Other', hourlyWageCad: 40 });
  const created = await request('POST', '/api/tasks', { projectId: project.data.id, name: 'Design' });
  assert.equal(created.status, 201);
  const again = await request('POST', '/api/tasks', { projectId: project.data.id, name: 'Design' });
  assert.equal(again.status, 200);
  assert.equal(again.data.id, created.data.id);

  const zebra = await request('POST', '/api/tasks', { projectId: project.data.id, name: 'zebra' });
  const list = await request('GET', `/api/tasks?projectId=${project.data.id}`);
  assert.deepEqual(list.data.map((task) => task.name), ['Design', 'zebra']);
  assert.equal(zebra.status, 201);

  const all = await request('GET', '/api/tasks');
  assert.equal(all.status, 200);
  assert.ok(all.data.some((task) => task.id === created.data.id && task.projectId === project.data.id));
  const badProject = await request('GET', '/api/tasks?projectId=abc');
  assert.equal(badProject.status, 400);
  const foreign = await request('POST', '/api/entries', {
    projectId: other.data.id,
    taskId: created.data.id,
    startUtc: '2026-07-01T15:00:00.000Z',
    finishUtc: '2026-07-01T16:00:00.000Z',
    tzOffsetMinutes: -360,
    notes: 'wrong task',
  });
  assert.equal(foreign.status, 400);

  await request('DELETE', `/api/projects/${project.data.id}`);
  const blocked = await request('POST', '/api/entries', {
    projectId: project.data.id,
    taskId: created.data.id,
    startUtc: '2026-07-02T15:00:00.000Z',
    finishUtc: '2026-07-02T16:00:00.000Z',
    tzOffsetMinutes: -360,
  });
  assert.equal(blocked.status, 400);
  const timerBlocked = await request('POST', '/api/timer/start', {
    projectId: project.data.id,
    taskId: created.data.id,
    notesDraft: '',
    tzOffsetMinutes: -360,
  });
  assert.equal(timerBlocked.status, 400);
});

test('timer notes, stop amount, override, and overlap', async () => {
  const project = await request('POST', '/api/projects', { name: 'Clock', hourlyWageCad: 90 });
  const task = await request('POST', '/api/tasks', { projectId: project.data.id, name: 'Build' });
  const idleStop = await request('POST', '/api/timer/stop', { notes: 'nope' });
  assert.equal(idleStop.status, 409);
  const idleNotes = await request('PUT', '/api/timer', { notesDraft: 'nope' });
  assert.equal(idleNotes.status, 409);

  const badOffset = await request('POST', '/api/timer/start', {
    projectId: project.data.id,
    taskId: task.data.id,
    notesDraft: '',
    tzOffsetMinutes: 9999,
  });
  assert.equal(badOffset.status, 400);

  const started = await request('POST', '/api/timer/start', {
    projectId: project.data.id,
    taskId: task.data.id,
    notesDraft: 'draft',
    tzOffsetMinutes: -360,
  });
  assert.equal(started.status, 201);
  const onDisk = JSON.parse(fs.readFileSync(`${dataFolder}/active.json`, 'utf8'));
  assert.equal(onDisk.startUtc, started.data.startUtc);
  assert.equal(onDisk.projectId, project.data.id);

  const again = await request('POST', '/api/timer/start', {
    projectId: project.data.id,
    taskId: task.data.id,
    notesDraft: '',
    tzOffsetMinutes: -360,
  });
  assert.equal(again.status, 409);

  const missingNotes = await request('PUT', '/api/timer', {});
  assert.equal(missingNotes.status, 400);
  const noted = await request('PUT', '/api/timer', { notesDraft: 'still going' });
  assert.equal(noted.status, 200);
  assert.equal(noted.data.startUtc, started.data.startUtc);
  assert.equal(noted.data.projectId, project.data.id);
  assert.equal(noted.data.taskId, task.data.id);
  assert.equal(noted.data.tzOffsetMinutes, -360);

  const covering = await request('POST', '/api/entries', {
    projectId: project.data.id,
    taskId: task.data.id,
    startUtc: new Date(Date.now() - 3600 * 1000).toISOString(),
    finishUtc: new Date(Date.now() + 3600 * 1000).toISOString(),
    tzOffsetMinutes: -360,
    notes: 'covers now',
  });
  assert.equal(covering.status, 201);

  const stopped = await request('POST', '/api/timer/stop', {
    notes: 'done',
    amountCad: 12.5,
    amountOverridden: true,
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.overlapWarning, true);
  assert.ok(stopped.data.overlappingEntryIds.includes(covering.data.entry.id));
  assert.equal(stopped.data.entry.amountCad, 12.5);
  assert.equal(stopped.data.entry.amountOverridden, true);
  assert.equal(fs.existsSync(`${dataFolder}/active.json`), false);

  const startedAgain = await request('POST', '/api/timer/start', {
    projectId: project.data.id,
    taskId: task.data.id,
    notesDraft: 'wage',
    tzOffsetMinutes: -360,
  });
  assert.equal(startedAgain.status, 201);
  const paid = await request('POST', '/api/timer/stop', { notes: 'computed' });
  assert.equal(paid.status, 200);
  assert.equal(
    paid.data.entry.amountCad,
    computeAmount(paid.data.entry.durationSeconds, 90)
  );
  assert.equal(paid.data.entry.amountOverridden, false);
});

test('entries filter, edit, delete, and reject bad ranges', async () => {
  const project = await request('POST', '/api/projects', { name: 'Ledger', hourlyWageCad: 45 });
  const task = await request('POST', '/api/tasks', { projectId: project.data.id, name: 'Write' });
  const created = await request('POST', '/api/entries', {
    projectId: project.data.id,
    taskId: task.data.id,
    startUtc: '2026-06-01T15:00:00.000Z',
    finishUtc: '2026-06-01T16:00:00.000Z',
    tzOffsetMinutes: -360,
    notes: 'hour',
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.entry.amountCad, 45);

  const day = await request('GET', '/api/entries?from=2026-06-01&to=2026-06-01');
  assert.equal(day.data.totalDurationSeconds, 3600);
  assert.equal(day.data.totalAmountCad, 45);
  assert.equal(day.data.entries.length, 1);

  const other = await request('POST', '/api/entries', {
    projectId: project.data.id,
    taskId: task.data.id,
    startUtc: '2026-06-01T18:00:00.000Z',
    finishUtc: '2026-06-01T19:00:00.000Z',
    tzOffsetMinutes: -360,
    notes: 'later',
  });
  const edited = await request('PUT', `/api/entries/${created.data.entry.id}`, {
    projectId: project.data.id,
    taskId: task.data.id,
    startUtc: '2026-06-01T18:30:00.000Z',
    finishUtc: '2026-06-01T20:30:00.000Z',
    tzOffsetMinutes: -360,
    notes: 'moved',
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.entry.amountCad, 90);
  assert.equal(edited.data.overlapWarning, true);
  assert.deepEqual(edited.data.overlappingEntryIds, [other.data.entry.id]);

  const removed = await request('DELETE', `/api/entries/${other.data.entry.id}`);
  assert.equal(removed.status, 204);
  const afterDelete = await request('GET', '/api/entries?from=2026-06-01&to=2026-06-01');
  assert.equal(afterDelete.data.entries.length, 1);
  const missing = await request('DELETE', '/api/entries/99999');
  assert.equal(missing.status, 404);
  const missingEdit = await request('PUT', '/api/entries/99999', {
    projectId: project.data.id,
    taskId: task.data.id,
    startUtc: '2026-06-01T15:00:00.000Z',
    finishUtc: '2026-06-01T16:00:00.000Z',
    tzOffsetMinutes: -360,
  });
  assert.equal(missingEdit.status, 404);

  const backwards = await request('POST', '/api/entries', {
    projectId: project.data.id,
    taskId: task.data.id,
    startUtc: '2026-06-02T16:00:00.000Z',
    finishUtc: '2026-06-02T16:00:00.000Z',
    tzOffsetMinutes: -360,
  });
  assert.equal(backwards.status, 400);
  const flipped = await request('GET', '/api/entries?from=2026-06-03&to=2026-06-01');
  assert.equal(flipped.status, 400);
  const fakeDay = await request('GET', '/api/entries?from=2026-02-31&to=2026-03-01');
  assert.equal(fakeDay.status, 400);
});

test('entries and reports filter by project and task', async () => {
  const jobA = await request('POST', '/api/projects', { name: 'Job A', hourlyWageCad: 50 });
  const jobB = await request('POST', '/api/projects', { name: 'Job B', hourlyWageCad: 100 });
  const designA = await request('POST', '/api/tasks', { projectId: jobA.data.id, name: 'Design' });
  const buildA = await request('POST', '/api/tasks', { projectId: jobA.data.id, name: 'Build' });
  const designB = await request('POST', '/api/tasks', { projectId: jobB.data.id, name: 'Design' });

  async function add(project, task, hour) {
    const created = await request('POST', '/api/entries', {
      projectId: project.data.id,
      taskId: task.data.id,
      startUtc: `2026-05-10T${hour}:00:00.000Z`,
      finishUtc: `2026-05-10T${hour}:30:00.000Z`,
      tzOffsetMinutes: -360,
    });
    assert.equal(created.status, 201);
    return created.data.entry.id;
  }
  const designAEntry = await add(jobA, designA, 14);
  const buildAEntry = await add(jobA, buildA, 15);
  const designBEntry = await add(jobB, designB, 16);

  async function filtered(query) {
    const response = await request('GET', `/api/entries?from=2026-05-10&to=2026-05-10${query}`);
    assert.equal(response.status, 200);
    return {
      ids: response.data.entries.map((entry) => entry.id).sort((x, y) => x - y),
      seconds: response.data.totalDurationSeconds,
      amount: response.data.totalAmountCad,
    };
  }

  assert.deepEqual(await filtered(''), {
    ids: [designAEntry, buildAEntry, designBEntry],
    seconds: 5400,
    amount: 100,
  });
  assert.deepEqual(await filtered('&projectIds='), await filtered(''));
  assert.deepEqual(await filtered(`&projectIds=${jobA.data.id}`), {
    ids: [designAEntry, buildAEntry],
    seconds: 3600,
    amount: 50,
  });
  assert.deepEqual(await filtered(`&taskIds=${designA.data.id},${designB.data.id}`), {
    ids: [designAEntry, designBEntry],
    seconds: 3600,
    amount: 75,
  });
  assert.deepEqual(await filtered(`&projectIds=${jobA.data.id},${jobB.data.id}&taskIds=${designA.data.id}`), {
    ids: [designAEntry],
    seconds: 1800,
    amount: 25,
  });
  assert.deepEqual(await filtered(`&projectIds=${jobA.data.id}&taskIds=${designB.data.id}`), {
    ids: [],
    seconds: 0,
    amount: 0,
  });
  assert.deepEqual(
    (await filtered(`&projectIds=${jobA.data.id}&projectIds=${jobB.data.id}`)).ids,
    [designAEntry, buildAEntry, designBEntry]
  );

  for (const bad of ['projectIds=abc', 'projectIds=0', 'taskIds=1.5', `projectIds=${jobA.data.id},-2`]) {
    const response = await request('GET', `/api/entries?from=2026-05-10&to=2026-05-10&${bad}`);
    assert.equal(response.status, 400, bad);
  }

  const pdf = await fetch(`${running.base}/api/reports/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: '2026-05-10',
      to: '2026-05-10',
      projectIds: [jobA.data.id],
      taskIds: [designA.data.id],
    }),
  });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');

  const badPdf = await request('POST', '/api/reports/pdf', {
    from: '2026-05-10',
    to: '2026-05-10',
    projectIds: ['x'],
  });
  assert.equal(badPdf.status, 400);
});

test('config, pdf, static shell, and error responses', async () => {
  const seeded = await request('GET', '/api/config');
  assert.equal(seeded.data.dataFolder, dataFolder);
  assert.equal(seeded.data.database.filename, 'timetrack.db');
  assert.equal(seeded.data.defaults.defaultTimezone, 'America/Edmonton');

  const saved = await request('PUT', '/api/config', {
    dataFolder: '/evil',
    database: { filename: 'other.db', walCheckpointOnStartup: false },
    defaults: { defaultHourlyWageCad: 55, defaultTimezone: 'America/Denver' },
    ui: { theme: 'light', dateFormat: 'YYYY-MM-DD', timeFormat: '12h' },
    server: { port: 9091 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.dataFolder, dataFolder);
  assert.equal(saved.data.database.filename, 'timetrack.db');
  assert.equal(saved.data.database.walCheckpointOnStartup, true);
  assert.equal(saved.data.ui.timeFormat, '12h');
  assert.equal(saved.data.defaults.defaultHourlyWageCad, 55);

  const badTheme = await request('PUT', '/api/config', {
    ...saved.data,
    ui: { ...saved.data.ui, theme: 'blue' },
  });
  assert.equal(badTheme.status, 400);

  const pdf = await fetch(`${running.base}/api/reports/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '2026-06-01', to: '2026-06-01' }),
  });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /attachment; filename="timetrack-2026-06-01_2026-06-01.pdf"/);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');

  const home = await request('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Timetrack/);
  assert.match(home.text, /data-route="track"/);

  const junk = await request('POST', '/api/projects', '{', { raw: true });
  assert.equal(junk.status, 400);
  const unknown = await request('GET', '/api/does-not-exist');
  assert.equal(unknown.status, 404);
});
