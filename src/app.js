const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const { seedConfig, readConfig } = require('./configStore');
const { readActive } = require('./activeTimer');
const { createRouter } = require('./routes');
const { HttpError } = require('./httpError');

function resolveDataFolder(env = process.env, homedir = os.homedir()) {
  const requested = env.DATA_FOLDER || path.join(homedir, 'timetrack-data');
  return path.resolve(requested);
}

function createApp(dataFolder) {
  const context = {
    db: null,
    dataFolder,
  };
  seedConfig(dataFolder);
  context.db = openDatabase(dataFolder);
  const active = readActive(dataFolder);
  if (active.isRunning) {
    console.log(`Resumable timer found, started ${active.startUtc}`);
  }

  const app = express();
  app.disable('x-powered-by');
  Object.defineProperty(app.locals, 'db', {
    enumerable: true,
    get() { return context.db; },
  });
  Object.defineProperty(app.locals, 'dataFolder', {
    enumerable: true,
    get() { return context.dataFolder; },
  });
  app.locals.context = context;
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', createRouter(context));
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof SyntaxError && error.status === 400) {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
    if (error instanceof HttpError) {
      const body = { error: error.message };
      if (error.code) body.code = error.code;
      res.status(error.status).json(body);
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function start() {
  const dataFolder = resolveDataFolder();
  fs.mkdirSync(dataFolder, { recursive: true });
  const config = readConfig(dataFolder);
  const port = Number(process.env.PORT || config.server.port || 8080);
  const app = createApp(dataFolder);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Timetrack listening on http://localhost:${port}`);
    console.log(`Data folder: ${dataFolder}`);
  });
}

module.exports = { createApp, start, resolveDataFolder };
