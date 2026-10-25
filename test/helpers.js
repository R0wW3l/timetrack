const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

function tempDataFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'timetrack-'));
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function requestFor(base) {
  return async function request(method, urlPath, body, options = {}) {
    const headers = { ...(options.headers || {}) };
    let payload;
    if (body != null) {
      payload = options.raw ? body : JSON.stringify(body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: payload,
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
  };
}

async function startServer(dataFolder) {
  const app = createApp(dataFolder);
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    server,
    base,
    db: app.locals.db,
    request: requestFor(base),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      app.locals.db.close();
    },
  };
}

module.exports = { tempDataFolder, listen, requestFor, startServer };
