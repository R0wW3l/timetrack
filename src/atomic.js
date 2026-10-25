const fs = require('fs');

function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  const json = `${JSON.stringify(data, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

module.exports = { atomicWriteJson };
