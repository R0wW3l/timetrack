const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');
const { seedConfig, readConfig, writeConfig } = require('../src/configStore');
const { listen } = require('./helpers');
const {
  parseMountPoints,
  isInsideMount,
  classifyFolder,
  resolveStartupFolder,
  prepareStartupFolder,
} = require('../src/dataFolder');
const { HttpError } = require('../src/httpError');

test('mount points honor spaces and ignore the container root', () => {
  const points = parseMountPoints(
    '36 26 0:32 / /Users/rw/pCloud\\040Drive rw,nosuid - apfs /dev/disk3s1 rw\n' +
    '40 36 0:40 / / rw - overlay overlay rw\n',
  );
  assert.deepEqual(points, ['/Users/rw/pCloud Drive', '/']);
  assert.equal(isInsideMount('/Users/rw/pCloud Drive/TimeTrack', points), true);
  assert.equal(isInsideMount('/Users/rw/pCloud Drive/TimeTrack/new', points), true);
  assert.equal(isInsideMount('/Users/rw/pCloud Drive-backup', points), false);
  assert.equal(isInsideMount('/etc/passwd', points), false);
  assert.equal(isInsideMount('/data', ['/data']), true);
  assert.equal(isInsideMount('/data-extra', ['/data']), false);
});

test('startup uses the saved folder, and DATA_FOLDER wins over the home settings file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timetrack-startup-'));
  const saved = path.join(root, 'saved');
  const fromEnv = path.join(root, 'from-env');
  const settings = path.join(root, 'settings');
  const home = path.join(root, 'home');
  fs.mkdirSync(saved);
  fs.mkdirSync(settings, { recursive: true });
  fs.mkdirSync(path.join(home, '.timetrack'), { recursive: true });
  fs.writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({ dataFolder: saved }));
  fs.writeFileSync(path.join(home, '.timetrack', 'settings.json'), JSON.stringify({ dataFolder: saved }));
  try {
    const chosen = resolveStartupFolder({
      SETTINGS_FOLDER: settings,
      DATA_FOLDER: fromEnv,
    }, home);
    assert.equal(chosen.dataFolder, fs.realpathSync(saved));
    assert.equal(chosen.settingsFolder, settings);

    const envOnly = resolveStartupFolder({ DATA_FOLDER: fromEnv }, home);
    assert.equal(envOnly.dataFolder, path.resolve(fromEnv));

    const fromHome = resolveStartupFolder({}, home);
    assert.equal(fromHome.dataFolder, fs.realpathSync(saved));
    assert.equal(fromHome.settingsFolder, path.join(home, '.timetrack'));

    const fallback = resolveStartupFolder({}, path.join(root, 'empty-home'));
    assert.equal(fallback.dataFolder, path.join(root, 'empty-home', 'timetrack-data'));

    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'notes.txt'), 'leave me');
    assert.throws(() => prepareStartupFolder(foreign, { docker: false, mountPoints: [] }), /no Timetrack database/);
    assert.equal(fs.existsSync(path.join(foreign, 'timetrack.db')), false);
    assert.throws(() => prepareStartupFolder('relative/folder', { docker: false }), HttpError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('classify accepts a Timetrack database beside other files and an empty folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timetrack-classify-'));
  try {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    fs.writeFileSync(path.join(empty, '.DS_Store'), 'x');
    assert.equal(classifyFolder(empty), 'empty');
    assert.equal(classifyFolder(path.join(root, 'missing')), 'missing');

    const existing = path.join(root, 'existing');
    fs.mkdirSync(existing);
    const db = openDatabase(existing);
    db.close();
    fs.writeFileSync(path.join(existing, 'backup.db'), 'old');
    assert.equal(classifyFolder(existing), 'existing');

    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'DATA-CUST.txt'), 'x');
    assert.equal(classifyFolder(foreign), 'foreign');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settings can open an existing database or initialize a folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timetrack-switch-'));
  const source = path.join(root, 'source');
  const settingsFolder = path.join(root, 'app-settings');
  fs.mkdirSync(source);
  const outside = path.join(path.dirname(root), `not-mounted-${path.basename(root)}`);
  const app = createApp(source, {
    settingsFolder,
    visibility: { docker: true, mountPoints: [fs.realpathSync(root)] },
  });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, urlPath, body) {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: body == null ? undefined : { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  }

  try {
    const created = await request('POST', '/api/projects', { name: 'Source job', hourlyWageCad: 45 });
    assert.equal(created.status, 201);
    const wage = await request('PUT', '/api/config', {
      ... (await request('GET', '/api/config')).data,
      defaults: { defaultHourlyWageCad: 80, defaultTimezone: 'America/Edmonton' },
    });
    assert.equal(wage.status, 200);

    const relative = await request('PUT', '/api/data-folder', { dataFolder: 'TimeTrack' });
    assert.equal(relative.status, 400);

    const unmounted = await request('PUT', '/api/data-folder', { dataFolder: outside });
    assert.equal(unmounted.status, 400);
    assert.match(unmounted.data.error, /not mounted/);
    assert.equal((await request('GET', '/api/projects')).data.some((project) => project.name === 'Source job'), true);

    const fresh = path.join(root, 'fresh');
    const initialized = await request('PUT', '/api/data-folder', { dataFolder: fresh });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.data.initialized, true);
    assert.equal(fs.existsSync(path.join(fresh, 'timetrack.db')), true);
    assert.equal((await request('GET', '/api/projects')).data.length, 0);
    assert.equal((await request('GET', '/api/config')).data.defaults.defaultHourlyWageCad, 80);
    assert.equal((await request('GET', '/api/config')).data.dataFolder, initialized.data.dataFolder);
    const savedSettings = JSON.parse(fs.readFileSync(path.join(settingsFolder, 'settings.json'), 'utf8'));
    assert.equal(savedSettings.dataFolder, initialized.data.dataFolder);
    const sourceDb = openDatabase(source);
    const sourceProjects = sourceDb.prepare('SELECT name FROM projects').all();
    sourceDb.close();
    assert.deepEqual(sourceProjects.map((row) => row.name), ['Source job']);

    const existing = path.join(root, 'existing');
    fs.mkdirSync(existing);
    const existingDb = openDatabase(existing);
    existingDb.prepare('INSERT INTO projects (name, hourly_wage_cad) VALUES (?, ?)').run('Kept', 12);
    existingDb.close();
    fs.writeFileSync(path.join(existing, 'notes.txt'), 'stay');
    seedConfig(existing);
    const existingConfig = readConfig(existing);
    existingConfig.defaults.defaultHourlyWageCad = 33;
    writeConfig(existing, existingConfig);

    const opened = await request('PUT', '/api/data-folder', { dataFolder: existing });
    assert.equal(opened.status, 200);
    assert.equal(opened.data.initialized, false);
    assert.equal((await request('GET', '/api/projects')).data[0].name, 'Kept');
    assert.equal((await request('GET', '/api/config')).data.defaults.defaultHourlyWageCad, 33);
    assert.equal(fs.readFileSync(path.join(existing, 'notes.txt'), 'utf8'), 'stay');

    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'DATA-CUST.txt'), 'customer');
    const needsInit = await request('PUT', '/api/data-folder', { dataFolder: foreign });
    assert.equal(needsInit.status, 409);
    assert.equal(needsInit.data.code, 'initialize');
    assert.equal(fs.existsSync(path.join(foreign, 'timetrack.db')), false);
    assert.equal((await request('GET', '/api/projects')).data[0].name, 'Kept');

    const createdBeside = await request('PUT', '/api/data-folder', { dataFolder: foreign, initialize: true });
    assert.equal(createdBeside.status, 200);
    assert.equal(createdBeside.data.initialized, true);
    assert.equal(fs.existsSync(path.join(foreign, 'timetrack.db')), true);
    assert.equal(fs.readFileSync(path.join(foreign, 'DATA-CUST.txt'), 'utf8'), 'customer');
    assert.equal((await request('GET', '/api/projects')).data.length, 0);

    const missingProject = await request('POST', '/api/tasks', { projectId: 1, name: 'nope' });
    assert.equal(missingProject.status, 400);
    assert.equal(missingProject.data.error, 'Project not found');
    const project = await request('POST', '/api/projects', { name: 'New', hourlyWageCad: 10 });
    const added = await request('POST', '/api/tasks', { projectId: project.data.id, name: 'Design' });
    const started = await request('POST', '/api/timer/start', {
      projectId: project.data.id,
      taskId: added.data.id,
      notesDraft: '',
      tzOffsetMinutes: -360,
    });
    assert.equal(started.status, 201);
    const blocked = await request('PUT', '/api/data-folder', { dataFolder: fresh });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /timer/i);
    assert.equal((await request('GET', '/api/data-folder')).data.dataFolder, createdBeside.data.dataFolder);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
