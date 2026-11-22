const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteJson } = require('./atomic');
const { readActive } = require('./activeTimer');
const { seedConfig, readConfig, writeConfig } = require('./configStore');
const { openDatabase } = require('./db');
const { HttpError } = require('./httpError');

const SETTINGS_FILE = 'settings.json';

const OWN_FILES = new Set([
  'config.json',
  'config.json.tmp',
  'timetrack.db',
  'timetrack.db-wal',
  'timetrack.db-shm',
  'active.json',
  'active.json.tmp',
]);

function normalizeDataFolder(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new HttpError(400, 'Enter a data folder path');
  }
  if (input.includes('\0')) throw new HttpError(400, 'Enter a valid data folder path');
  const trimmed = input.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new HttpError(400, 'Enter the full data folder path, starting with /');
  }
  return path.resolve(trimmed);
}

function canonicalTarget(folder) {
  const resolved = path.resolve(folder);
  let current = resolved;
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.push(path.basename(current));
    current = parent;
  }
  const base = fs.realpathSync(current);
  return path.join(base, ...missing.reverse());
}

function classifyFolder(folder) {
  if (!fs.existsSync(folder)) return 'missing';
  const stat = fs.statSync(folder);
  if (!stat.isDirectory()) throw new HttpError(400, 'Data folder must be a directory');
  const names = fs.readdirSync(folder).filter((name) => !name.startsWith('.'));
  if (names.includes('timetrack.db')) {
    if (!fs.statSync(path.join(folder, 'timetrack.db')).isFile()) {
      throw new HttpError(400, 'timetrack.db must be a file');
    }
    return 'existing';
  }
  if (names.every((name) => OWN_FILES.has(name))) return names.length === 0 ? 'empty' : 'partial';
  return 'foreign';
}

function parseMountPoints(mountinfo) {
  const points = [];
  for (const line of String(mountinfo || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    if (parts.length < 5) continue;
    points.push(parts[4].replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\'));
  }
  return points;
}

function isInsideMount(folder, mountPoints) {
  const resolved = path.resolve(folder);
  return (mountPoints || []).some((mountPoint) => {
    if (!mountPoint || mountPoint === '/') return false;
    const relative = path.relative(mountPoint, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function detectVisibility() {
  if (!fs.existsSync('/.dockerenv')) return { docker: false, mountPoints: [] };
  try {
    return { docker: true, mountPoints: parseMountPoints(fs.readFileSync('/proc/self/mountinfo', 'utf8')) };
  } catch {
    return { docker: false, mountPoints: [] };
  }
}

function assertMounted(folder, visibility) {
  if (!visibility?.docker) return;
  if (!isInsideMount(folder, visibility.mountPoints)) {
    throw new HttpError(400, 'That folder is not mounted into the container. Mount it in Docker, then choose it again.');
  }
}

function settingsFile(settingsFolder) {
  return path.join(settingsFolder, SETTINGS_FILE);
}

function readChosenFolder(settingsFolder) {
  if (!settingsFolder) return null;
  const file = settingsFile(settingsFolder);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Settings file is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Settings file is not valid JSON: ${file}`);
  }
  if (parsed.dataFolder == null || parsed.dataFolder === '') return null;
  if (typeof parsed.dataFolder !== 'string') {
    throw new Error(`Settings file has an invalid data folder: ${file}`);
  }
  return canonicalTarget(normalizeDataFolder(parsed.dataFolder));
}

function saveSettings(settingsFolder, dataFolder) {
  if (!settingsFolder) throw new HttpError(500, 'Settings folder is not configured');
  fs.mkdirSync(settingsFolder, { recursive: true });
  atomicWriteJson(settingsFile(settingsFolder), { dataFolder });
}

function resolveStartupFolder(env = process.env, homedir = os.homedir()) {
  const explicitSettings = env.SETTINGS_FOLDER || null;
  if (explicitSettings) {
    const chosen = readChosenFolder(explicitSettings);
    if (chosen) return { dataFolder: chosen, settingsFolder: explicitSettings };
  }
  if (env.DATA_FOLDER) {
    return {
      dataFolder: path.resolve(env.DATA_FOLDER),
      settingsFolder: explicitSettings || path.join(homedir, '.timetrack'),
    };
  }
  const homeSettings = path.join(homedir, '.timetrack');
  const chosen = readChosenFolder(homeSettings);
  if (chosen) return { dataFolder: chosen, settingsFolder: homeSettings };
  return {
    dataFolder: path.join(homedir, 'timetrack-data'),
    settingsFolder: homeSettings,
  };
}

function prepareStartupFolder(folder, visibility = detectVisibility()) {
  const located = canonicalTarget(normalizeDataFolder(folder));
  assertMounted(located, visibility);
  if (classifyFolder(located) === 'foreign') {
    throw new Error(
      `Data folder ${located} has other files and no Timetrack database. ` +
      'Choose a Timetrack folder, or an empty folder, in settings.json.',
    );
  }
  return located;
}

function switchDataFolder(context, input, initialize = false) {
  const folder = canonicalTarget(normalizeDataFolder(input));
  const visibility = context.visibility || detectVisibility();
  assertMounted(folder, visibility);

  let current = path.resolve(context.dataFolder);
  if (fs.existsSync(current)) current = fs.realpathSync(current);
  if (folder === current) {
    saveSettings(context.settingsFolder, folder);
    return { dataFolder: folder, initialized: false };
  }

  if (readActive(context.dataFolder).isRunning) {
    throw new HttpError(409, 'Stop the running timer before changing the data folder');
  }

  const kind = classifyFolder(folder);
  if (kind === 'foreign' && initialize !== true) {
    throw new HttpError(
      409,
      'That folder has other files and no Timetrack database. Create a new database there only if those files should stay.',
      'initialize',
    );
  }

  const hadConfig = fs.existsSync(path.join(folder, 'config.json'));
  const hadDatabase = kind === 'existing';
  const previousConfig = (!hadConfig && !hadDatabase) ? readConfig(context.dataFolder) : null;
  fs.mkdirSync(folder, { recursive: true });
  seedConfig(folder);
  if (previousConfig) writeConfig(folder, previousConfig);

  const nextDb = openDatabase(folder);
  const previousDb = context.db;
  const previousFolder = context.dataFolder;
  context.db = nextDb;
  context.dataFolder = folder;
  try {
    saveSettings(context.settingsFolder, folder);
  } catch (error) {
    context.db = previousDb;
    context.dataFolder = previousFolder;
    nextDb.close();
    throw error;
  }
  try {
    previousDb.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // The new folder is already in use. Closing the old database still releases it.
  }
  previousDb.close();
  return { dataFolder: folder, initialized: !hadDatabase };
}

module.exports = {
  normalizeDataFolder,
  canonicalTarget,
  classifyFolder,
  parseMountPoints,
  isInsideMount,
  detectVisibility,
  readChosenFolder,
  resolveStartupFolder,
  prepareStartupFolder,
  switchDataFolder,
};
