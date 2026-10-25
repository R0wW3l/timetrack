const { HttpError } = require('./httpError');
const { localDateString, normalizeUtc, computeAmount, parseDateParam } = require('./time');

const ENTRY_SELECT = `
  SELECT
    e.id,
    e.project_id,
    p.name AS project_name,
    e.task_id,
    t.name AS task_name,
    e.start_utc,
    e.finish_utc,
    e.tz_offset_minutes,
    e.duration_seconds,
    e.amount_cad,
    e.amount_overridden,
    e.notes,
    e.overlap_acknowledged,
    e.created_at,
    e.updated_at
  FROM entries e
  JOIN projects p ON p.id = e.project_id
  LEFT JOIN tasks t ON t.id = e.task_id
`;

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    hourlyWageCad: row.hourly_wage_cad,
    archived: row.archived === 1,
  };
}

function mapTask(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
  };
}

function mapEntry(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    taskId: row.task_id,
    taskName: row.task_name,
    startUtc: row.start_utc,
    finishUtc: row.finish_utc,
    tzOffsetMinutes: row.tz_offset_minutes,
    durationSeconds: row.duration_seconds,
    amountCad: row.amount_cad,
    amountOverridden: row.amount_overridden === 1,
    notes: row.notes || '',
    overlapAcknowledged: row.overlap_acknowledged === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getEntry(db, id) {
  const row = db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id);
  return row ? mapEntry(row) : null;
}

function findOverlaps(db, startUtc, finishUtc, excludeId) {
  return db.prepare(`
    SELECT id FROM entries
    WHERE start_utc < ? AND finish_utc > ?
      AND (? IS NULL OR id != ?)
    ORDER BY start_utc
  `).all(finishUtc, startUtc, excludeId ?? null, excludeId ?? null).map((row) => row.id);
}

function parseOffset(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -960 || value > 960) {
    throw new HttpError(400, 'tzOffsetMinutes must be an integer between -960 and 960');
  }
  return value;
}

function loadProject(db, projectId) {
  if (!Number.isInteger(projectId)) throw new HttpError(400, 'projectId is required');
  const project = db.prepare(`
    SELECT id, name, hourly_wage_cad AS hourlyWageCad, archived
    FROM projects WHERE id = ?
  `).get(projectId);
  if (!project) throw new HttpError(400, 'Project not found');
  return project;
}

function assertProjectTask(db, projectId, taskId, { allowArchived = false } = {}) {
  const project = loadProject(db, projectId);
  if (!allowArchived && project.archived) throw new HttpError(400, 'Project is archived');
  if (!Number.isInteger(taskId)) throw new HttpError(400, 'taskId is required');
  const task = db.prepare('SELECT id, name, project_id FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new HttpError(400, 'Task not found');
  if (task.project_id !== project.id) throw new HttpError(400, 'Task does not belong to this project');
  return { project, task };
}

function resolveAmount({ seconds, wage, amountCad, amountOverridden, treatAmountAsOverride }) {
  const overridden = amountOverridden === true || (treatAmountAsOverride && amountCad != null);
  if (overridden) {
    if (typeof amountCad !== 'number' || !Number.isFinite(amountCad) || amountCad < 0) {
      throw new HttpError(400, 'amountCad must be a non-negative number when overriding');
    }
    return { amountCad: Math.round((amountCad + Number.EPSILON) * 100) / 100, amountOverridden: 1 };
  }
  return { amountCad: computeAmount(seconds, wage), amountOverridden: 0 };
}

function buildEntryFields(db, body, options = {}) {
  const { project } = assertProjectTask(db, body.projectId, body.taskId, options);
  const startUtc = normalizeUtc(body.startUtc);
  const finishUtc = normalizeUtc(body.finishUtc);
  if (finishUtc <= startUtc) throw new HttpError(400, 'finishUtc must be after startUtc');
  const tzOffsetMinutes = parseOffset(body.tzOffsetMinutes);
  const seconds = Math.round((Date.parse(finishUtc) - Date.parse(startUtc)) / 1000);
  const notes = body.notes == null ? '' : String(body.notes);
  const amount = resolveAmount({
    seconds,
    wage: project.hourlyWageCad,
    amountCad: body.amountCad,
    amountOverridden: body.amountOverridden,
    treatAmountAsOverride: options.treatAmountAsOverride,
  });
  return {
    projectId: project.id,
    taskId: body.taskId,
    startUtc,
    finishUtc,
    tzOffsetMinutes,
    durationSeconds: seconds,
    amountCad: amount.amountCad,
    amountOverridden: amount.amountOverridden,
    notes,
  };
}

function insertEntry(db, fields, overlapAcknowledged) {
  const info = db.prepare(`
    INSERT INTO entries (
      project_id, task_id, start_utc, finish_utc, tz_offset_minutes,
      duration_seconds, amount_cad, amount_overridden, notes, overlap_acknowledged
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.projectId,
    fields.taskId,
    fields.startUtc,
    fields.finishUtc,
    fields.tzOffsetMinutes,
    fields.durationSeconds,
    fields.amountCad,
    fields.amountOverridden,
    fields.notes,
    overlapAcknowledged
  );
  return Number(info.lastInsertRowid);
}

function createEntry(db, body, options) {
  const fields = buildEntryFields(db, body, options);
  const overlappingEntryIds = findOverlaps(db, fields.startUtc, fields.finishUtc, null);
  const id = insertEntry(db, fields, overlappingEntryIds.length ? 1 : 0);
  return {
    entry: getEntry(db, id),
    overlapWarning: overlappingEntryIds.length > 0,
    overlappingEntryIds,
  };
}

function updateEntry(db, id, body) {
  const existing = db.prepare('SELECT id, project_id FROM entries WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, 'Entry not found');
  const fields = buildEntryFields(db, body, {
    allowArchived: body.projectId === existing.project_id,
  });
  const overlappingEntryIds = findOverlaps(db, fields.startUtc, fields.finishUtc, id);
  db.prepare(`
    UPDATE entries SET
      project_id = ?,
      task_id = ?,
      start_utc = ?,
      finish_utc = ?,
      tz_offset_minutes = ?,
      duration_seconds = ?,
      amount_cad = ?,
      amount_overridden = ?,
      notes = ?,
      overlap_acknowledged = ?
    WHERE id = ?
  `).run(
    fields.projectId,
    fields.taskId,
    fields.startUtc,
    fields.finishUtc,
    fields.tzOffsetMinutes,
    fields.durationSeconds,
    fields.amountCad,
    fields.amountOverridden,
    fields.notes,
    overlappingEntryIds.length ? 1 : 0,
    id
  );
  return {
    entry: getEntry(db, id),
    overlapWarning: overlappingEntryIds.length > 0,
    overlappingEntryIds,
  };
}

function deleteEntry(db, id) {
  const info = db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  if (info.changes === 0) throw new HttpError(404, 'Entry not found');
}

function parseIdList(value, label) {
  if (value == null || value === '') return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const ids = parts
    .map((part) => (typeof part === 'string' ? part.trim() : part))
    .filter((part) => part !== '')
    .map((part) => (typeof part === 'number' || typeof part === 'string' ? Number(part) : NaN));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new HttpError(400, `${label} must be a list of ids`);
  }
  return [...new Set(ids)];
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function filterNames(db, projectIds, taskIds) {
  const projects = projectIds.length
    ? db.prepare(`
      SELECT name FROM projects
      WHERE id IN (${placeholders(projectIds)})
      ORDER BY name COLLATE NOCASE ASC
    `).all(...projectIds).map((row) => row.name)
    : [];
  const tasks = taskIds.length
    ? db.prepare(`
      SELECT p.name AS project_name, t.name
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id IN (${placeholders(taskIds)})
      ORDER BY p.name COLLATE NOCASE ASC, t.name COLLATE NOCASE ASC
    `).all(...taskIds).map((row) => `${row.project_name} / ${row.name}`)
    : [];
  return { projects, tasks };
}

function listEntries(db, fromRaw, toRaw, filters = {}) {
  const from = parseDateParam(fromRaw, 'from');
  const to = parseDateParam(toRaw, 'to');
  if (from > to) throw new HttpError(400, 'from must be on or before to');
  const projectIds = parseIdList(filters.projectIds, 'projectIds');
  const taskIds = parseIdList(filters.taskIds, 'taskIds');
  const lo = new Date(Date.parse(`${from}T00:00:00.000Z`) - 16 * 3600 * 1000).toISOString();
  const hi = new Date(Date.parse(`${to}T00:00:00.000Z`) + 40 * 3600 * 1000).toISOString();
  const where = ['e.start_utc >= ?', 'e.start_utc <= ?'];
  const params = [lo, hi];
  if (projectIds.length) {
    where.push(`e.project_id IN (${placeholders(projectIds)})`);
    params.push(...projectIds);
  }
  if (taskIds.length) {
    where.push(`e.task_id IN (${placeholders(taskIds)})`);
    params.push(...taskIds);
  }
  const entries = db.prepare(`
    ${ENTRY_SELECT}
    WHERE ${where.join(' AND ')}
    ORDER BY e.start_utc DESC
  `).all(...params).map(mapEntry).filter((entry) => {
    const localDate = localDateString(entry.startUtc, entry.tzOffsetMinutes);
    return localDate >= from && localDate <= to;
  });
  const totalDurationSeconds = entries.reduce((sum, entry) => sum + entry.durationSeconds, 0);
  const totalAmountCad = entries.reduce((sum, entry) => sum + Math.round(entry.amountCad * 100), 0) / 100;
  return { entries, totalDurationSeconds, totalAmountCad };
}

module.exports = {
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
};
