const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { resolveDataFolder } = require('../src/app');

test('the data folder is the one path Docker mounts', () => {
  const home = path.join(os.tmpdir(), 'timetrack-home');
  assert.equal(
    resolveDataFolder({ DATA_FOLDER: '/Users/rw/pCloud Drive/TimeTrack' }, home),
    path.resolve('/Users/rw/pCloud Drive/TimeTrack'),
  );
  assert.equal(
    resolveDataFolder({ DATA_FOLDER: 'relative/folder' }, home),
    path.resolve('relative/folder'),
  );
  assert.equal(resolveDataFolder({}, home), path.join(home, 'timetrack-data'));
});
