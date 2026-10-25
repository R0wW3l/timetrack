const express = require('express');
const { HttpError } = require('./httpError');
const { readConfig, writeConfig } = require('./configStore');
const { readActive, writeActive, clearActive } = require('./activeTimer');
const {
  mapProject,
  mapTask,
  assertProjectTask,
  parseOffset,
  createEntry,
  updateEntry,
  deleteEntry,
  listEntries,
  loadProject,
  parseIdList,
  filterNames,
} = require('./entries');
const { streamPdf } = require('./pdf');

function asyncRoute(fn) {
  return (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
}

function requireName(value, label) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new HttpError(400, `${label} is required`);
  return name;
}

function requireWage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new HttpError(400, 'hourlyWageCad must be a non-negative number');
  }
  return value;
}

function createRouter(db, dataFolder) {
  const router = express.Router();

  router.get('/projects', asyncRoute((req, res) => {
    const rows = db.prepare(`
      SELECT id, name, hourly_wage_cad, archived
      FROM projects
      ORDER BY archived ASC, name COLLATE NOCASE ASC
    `).all();
    res.json(rows.map(mapProject));
  }));

  router.post('/projects', asyncRoute((req, res) => {
    const name = requireName(req.body?.name, 'name');
    const config = readConfig(dataFolder);
    const wage = req.body?.hourlyWageCad == null
      ? config.defaults.defaultHourlyWageCad
      : requireWage(req.body.hourlyWageCad);
    try {
      const info = db.prepare('INSERT INTO projects (name, hourly_wage_cad) VALUES (?, ?)').run(name, wage);
      const row = db.prepare('SELECT id, name, hourly_wage_cad, archived FROM projects WHERE id = ?').get(info.lastInsertRowid);
      res.status(201).json(mapProject(row));
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new HttpError(409, 'A project with that name already exists');
      }
      throw error;
    }
  }));

  router.put('/projects/:id', asyncRoute((req, res) => {
    const id = parseId(req.params.id);
    const existing = db.prepare('SELECT id, name, hourly_wage_cad, archived FROM projects WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, 'Project not found');
    const name = req.body?.name == null ? existing.name : requireName(req.body.name, 'name');
    const wage = req.body?.hourlyWageCad == null ? existing.hourly_wage_cad : requireWage(req.body.hourlyWageCad);
    const archived = req.body?.archived == null ? existing.archived : (req.body.archived ? 1 : 0);
    try {
      db.prepare('UPDATE projects SET name = ?, hourly_wage_cad = ?, archived = ? WHERE id = ?').run(name, wage, archived, id);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new HttpError(409, 'A project with that name already exists');
      }
      throw error;
    }
    const row = db.prepare('SELECT id, name, hourly_wage_cad, archived FROM projects WHERE id = ?').get(id);
    res.json(mapProject(row));
  }));

  router.delete('/projects/:id', asyncRoute((req, res) => {
    const id = parseId(req.params.id);
    const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, 'Project not found');
    db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(id);
    const row = db.prepare('SELECT id, name, hourly_wage_cad, archived FROM projects WHERE id = ?').get(id);
    res.json(mapProject(row));
  }));

  router.get('/tasks', asyncRoute((req, res) => {
    if (req.query.projectId === undefined) {
      const rows = db.prepare(`
        SELECT id, project_id, name FROM tasks
        ORDER BY name COLLATE NOCASE ASC
      `).all();
      res.json(rows.map(mapTask));
      return;
    }
    const projectId = Number(req.query.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) throw new HttpError(400, 'projectId is required');
    loadProject(db, projectId);
    const rows = db.prepare(`
      SELECT id, project_id, name FROM tasks
      WHERE project_id = ?
      ORDER BY name COLLATE NOCASE ASC
    `).all(projectId);
    res.json(rows.map(mapTask));
  }));

  router.post('/tasks', asyncRoute((req, res) => {
    const projectId = req.body?.projectId;
    const name = requireName(req.body?.name, 'name');
    loadProject(db, projectId);
    const existing = db.prepare('SELECT id, project_id, name FROM tasks WHERE project_id = ? AND name = ?').get(projectId, name);
    if (existing) {
      res.json(mapTask(existing));
      return;
    }
    const info = db.prepare('INSERT INTO tasks (project_id, name) VALUES (?, ?)').run(projectId, name);
    const row = db.prepare('SELECT id, project_id, name FROM tasks WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(mapTask(row));
  }));

  router.get('/timer', asyncRoute((req, res) => {
    res.json(readActive(dataFolder));
  }));

  router.post('/timer/start', asyncRoute((req, res) => {
    if (readActive(dataFolder).isRunning) throw new HttpError(409, 'A timer is already running');
    const { project, task } = assertProjectTask(db, req.body?.projectId, req.body?.taskId);
    const state = {
      isRunning: true,
      startUtc: new Date().toISOString(),
      tzOffsetMinutes: parseOffset(req.body?.tzOffsetMinutes),
      projectId: project.id,
      projectName: project.name,
      taskId: task.id,
      taskName: task.name,
      notesDraft: req.body?.notesDraft == null ? '' : String(req.body.notesDraft),
    };
    writeActive(dataFolder, state);
    res.status(201).json(state);
  }));

  router.put('/timer', asyncRoute((req, res) => {
    const active = readActive(dataFolder);
    if (!active.isRunning) throw new HttpError(409, 'No timer is running');
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'notesDraft')) {
      throw new HttpError(400, 'notesDraft is required');
    }
    active.notesDraft = req.body.notesDraft == null ? '' : String(req.body.notesDraft);
    writeActive(dataFolder, active);
    res.json(active);
  }));

  router.post('/timer/stop', asyncRoute((req, res) => {
    const active = readActive(dataFolder);
    if (!active.isRunning) throw new HttpError(409, 'No timer is running');
    const startMs = Date.parse(active.startUtc);
    const finishMs = Math.max(Date.now(), startMs + 1000);
    const payload = {
      projectId: active.projectId,
      taskId: active.taskId,
      startUtc: active.startUtc,
      finishUtc: new Date(finishMs).toISOString(),
      tzOffsetMinutes: active.tzOffsetMinutes,
      notes: req.body?.notes != null ? req.body.notes : active.notesDraft,
      amountCad: req.body?.amountCad,
      amountOverridden: req.body?.amountOverridden,
    };
    const result = db.transaction(() => createEntry(db, payload, {
      treatAmountAsOverride: true,
      allowArchived: true,
    }))();
    clearActive(dataFolder);
    res.json(result);
  }));

  router.get('/entries', asyncRoute((req, res) => {
    res.json(listEntries(db, req.query.from, req.query.to, {
      projectIds: req.query.projectIds,
      taskIds: req.query.taskIds,
    }));
  }));

  router.post('/entries', asyncRoute((req, res) => {
    const result = createEntry(db, req.body || {});
    res.status(201).json(result);
  }));

  router.put('/entries/:id', asyncRoute((req, res) => {
    res.json(updateEntry(db, parseId(req.params.id), req.body || {}));
  }));

  router.delete('/entries/:id', asyncRoute((req, res) => {
    deleteEntry(db, parseId(req.params.id));
    res.status(204).end();
  }));

  router.post('/reports/pdf', asyncRoute((req, res) => {
    const from = req.body?.from;
    const to = req.body?.to;
    const projectIds = parseIdList(req.body?.projectIds, 'projectIds');
    const taskIds = parseIdList(req.body?.taskIds, 'taskIds');
    const report = listEntries(db, from, to, { projectIds, taskIds });
    const config = readConfig(dataFolder);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="timetrack-${from}_${to}.pdf"`);
    streamPdf(res, report, {
      from,
      to,
      timeFormat: config.ui.timeFormat,
      filters: filterNames(db, projectIds, taskIds),
    });
  }));

  router.get('/config', asyncRoute((req, res) => {
    res.json(readConfig(dataFolder));
  }));

  router.put('/config', asyncRoute((req, res) => {
    res.json(writeConfig(dataFolder, req.body));
  }));

  return router;
}

module.exports = { createRouter };
