const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic');
const { HttpError } = require('./httpError');

function activePath(dataFolder) {
  return path.join(dataFolder, 'active.json');
}

function readActive(dataFolder) {
  const file = activePath(dataFolder);
  if (!fs.existsSync(file)) return { isRunning: false };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new HttpError(500, 'active.json is not valid JSON');
  }
  if (!data || data.isRunning !== true) return { isRunning: false };
  return data;
}

function writeActive(dataFolder, data) {
  atomicWriteJson(activePath(dataFolder), data);
}

function clearActive(dataFolder) {
  const file = activePath(dataFolder);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { readActive, writeActive, clearActive };
