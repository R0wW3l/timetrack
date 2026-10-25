const os = require('os');
const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const { seedConfig, readConfig } = require('./configStore');
const { readActive } = require('./activeTimer');
const { createRouter } = require('./routes');
const { HttpError } = require('./httpError');

function createApp(dataFolder) {
  seedConfig(dataFolder);
  const db = openDatabase(dataFolder);
  const active = readActive(dataFolder);
  if (active.isRunning) {
    console.log(`Resumable timer found, started ${active.startUtc}`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  app.locals.dataFolder = dataFolder;
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', createRouter(db, dataFolder));
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      next();
      return;
    }
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
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function start() {
  const dataFolder = process.env.DATA_FOLDER || path.join(os.homedir(), 'timetrack-data');
  const config = readConfig(dataFolder);
  const port = Number(process.env.PORT || config.server.port || 8080);
  const app = createApp(dataFolder);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Timetrack listening on http://localhost:${port}`);
    console.log(`Data folder: ${dataFolder}`);
  });
}

module.exports = { createApp, start };
