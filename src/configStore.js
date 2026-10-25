const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic');
const { HttpError } = require('./httpError');

const TEMPLATE_PATH = path.join(__dirname, '..', 'GrokFiles', 'config.template.json');

function configPath(dataFolder) {
  return path.join(dataFolder, 'config.json');
}

function seedConfig(dataFolder) {
  fs.mkdirSync(dataFolder, { recursive: true });
  const file = configPath(dataFolder);
  if (fs.existsSync(file)) return;
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  template.dataFolder = dataFolder;
  atomicWriteJson(file, template);
}

function readConfig(dataFolder) {
  seedConfig(dataFolder);
  return JSON.parse(fs.readFileSync(configPath(dataFolder), 'utf8'));
}

function sanitizeConfig(input, dataFolder) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid config');
  const theme = input.ui?.theme;
  if (!['auto', 'light', 'dark'].includes(theme)) throw new HttpError(400, 'Invalid theme');
  const timeFormat = input.ui?.timeFormat;
  if (!['12h', '24h'].includes(timeFormat)) throw new HttpError(400, 'Invalid time format');
  const wage = input.defaults?.defaultHourlyWageCad;
  if (typeof wage !== 'number' || !Number.isFinite(wage) || wage < 0) {
    throw new HttpError(400, 'Invalid default hourly wage');
  }
  const timezone = input.defaults?.defaultTimezone;
  if (typeof timezone !== 'string' || !timezone.trim()) throw new HttpError(400, 'Invalid timezone');
  const dateFormat = input.ui?.dateFormat;
  if (typeof dateFormat !== 'string' || !dateFormat.trim()) throw new HttpError(400, 'Invalid date format');
  const port = input.server?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Invalid port');
  return {
    dataFolder,
    database: {
      filename: 'timetrack.db',
      walCheckpointOnStartup: true,
    },
    defaults: {
      defaultHourlyWageCad: wage,
      defaultTimezone: timezone.trim(),
    },
    ui: {
      theme,
      dateFormat: dateFormat.trim(),
      timeFormat,
    },
    server: { port },
  };
}

function writeConfig(dataFolder, input) {
  const next = sanitizeConfig(input, dataFolder);
  atomicWriteJson(configPath(dataFolder), next);
  return next;
}

module.exports = { readConfig, writeConfig, seedConfig };
