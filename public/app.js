const state = {
  route: 'track',
  config: null,
  projects: [],
  tasks: [],
  timer: { isRunning: false },
  entries: null,
  notice: '',
  error: '',
  editing: null,
  showEntryForm: false,
  range: monthRange(),
  allTasks: [],
  filters: { projectIds: [], taskIds: [] },
  openFilter: null,
};

let clockTimer = null;
let notesTimer = null;

const main = document.getElementById('main');
const themeButton = document.getElementById('theme-toggle');

document.getElementById('nav').addEventListener('click', () => {
  state.notice = '';
  state.error = '';
});

window.addEventListener('hashchange', () => {
  state.notice = '';
  state.error = '';
  state.showEntryForm = false;
  state.editing = null;
  state.openFilter = null;
  state.pendingTaskDelete = null;
  boot();
});

themeButton.addEventListener('click', async () => {
  if (!state.config) return;
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  state.config = { ...state.config, ui: { ...state.config.ui, theme: next } };
  applyTheme();
  try {
    state.config = await api('/config', { method: 'PUT', body: state.config });
    applyTheme();
  } catch (error) {
    state.error = error.message;
    render();
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  try {
    if (form.id === 'start-form') await startTimer(form);
    else if (form.id === 'stop-form') await stopTimer(form);
    else if (form.id === 'entry-form') await saveEntry(form);
    else if (form.id === 'range-form') await loadEntries();
    else if (form.id === 'report-form') await downloadPdf(form);
    else if (form.id === 'config-form') await saveConfig(form);
    else if (form.id === 'project-form') await createProject(form);
    else if (form.id === 'task-form') await createTask(form);
  } catch (error) {
    state.error = error.message;
    render();
  }
});

document.addEventListener('click', (event) => {
  const summary = event.target.closest('details.multi > summary');
  document.querySelectorAll('details.multi[open]').forEach((details) => {
    if (!details.contains(event.target)) details.open = false;
  });
  if (summary) {
    const details = summary.parentElement;
    state.openFilter = details.open ? null : details.dataset.filter;
  } else if (!event.target.closest('details.multi')) {
    state.openFilter = null;
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  try {
    const action = button.dataset.action;
    if (action === 'edit-entry') openEdit(Number(button.dataset.id));
    else if (action === 'new-entry') {
      state.editing = blankEntry();
      state.showEntryForm = true;
      state.notice = '';
      if (state.editing.projectId) await loadTasks(state.editing.projectId);
      render();
    } else if (action === 'cancel-entry') {
      state.editing = null;
      state.showEntryForm = false;
      render();
    } else if (action === 'delete-entry') await removeEntry(Number(button.dataset.id));
    else if (action === 'delete-task') await deleteTask(Number(button.dataset.id), Number(button.dataset.projectId));
    else if (action === 'confirm-delete-task') await removeTask(state.pendingTaskDelete, button.dataset.mode);
    else if (action === 'cancel-delete-task') {
      const projectId = state.pendingTaskDelete?.projectId;
      state.pendingTaskDelete = null;
      refreshTaskSlot(projectId);
    } else if (action === 'save-project') await saveProject(button.dataset.id);
    else if (action === 'clear-filter') await clearFilter(button.dataset.kind);
  } catch (error) {
    state.error = error.message;
    render();
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.dataset.filterKind) {
    try {
      await toggleFilter(target.dataset.filterKind, Number(target.value), target.checked);
    } catch (error) {
      state.error = error.message;
      render();
    }
    return;
  }
  if (target.id === 'entry-project') {
    await loadTasks(Number(target.value));
    if (state.editing) state.editing.projectId = Number(target.value);
    render();
  }
});

document.addEventListener('input', async (event) => {
  const target = event.target;
  if (target.id === 'project-input') {
    state.projectName = target.value;
    try {
      if (await loadTrackTasks()) {
        const list = document.getElementById('task-options');
        if (list) list.innerHTML = taskOptions(state.trackTasks);
      }
    } catch (error) {
      state.error = error.message;
      render();
    }
    return;
  }
  if (target.id === 'task-input') state.taskName = target.value;
  if (target.name === 'notesDraft' && target.form?.id === 'start-form') state.notesDraft = target.value;
  if (target.id === 'running-notes' && state.timer.isRunning) {
    const notes = event.target.value;
    localStorage.setItem(notesKey(state.timer.startUtc), notes);
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      api('/timer', { method: 'PUT', body: { notesDraft: notes } }).catch((error) => {
        state.error = error.message;
      });
    }, 400);
  }
});

boot();

async function boot() {
  state.route = (location.hash.replace('#/', '') || 'track');
  if (!['track', 'entries', 'report', 'settings'].includes(state.route)) state.route = 'track';
  document.querySelectorAll('.nav a').forEach((link) => {
    link.classList.toggle('active', link.dataset.route === state.route);
  });
  state.config = await api('/config');
  applyTheme();
  state.projects = await api('/projects');
  state.timer = await api('/timer');
  if (state.timer.isRunning) {
    const saved = localStorage.getItem(notesKey(state.timer.startUtc));
    if (saved != null) state.timer.notesDraft = saved;
    const projectId = state.timer.projectId;
    state.tasks = await api(`/tasks?projectId=${projectId}`);
  } else if (state.route === 'track') {
    state.trackTasksProjectId = undefined;
    await loadTrackTasks();
  }
  if (state.route === 'entries' || state.route === 'report') {
    state.allTasks = await api('/tasks');
    state.filters.taskIds = state.filters.taskIds.filter((id) => state.allTasks.some((task) => task.id === id));
    await loadEntries();
  } else {
    render();
    if (state.route === 'settings') await hydrateTaskChips();
  }
  startClock();
}

function applyTheme() {
  const theme = state.config?.ui?.theme || 'auto';
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = resolvedTheme() === 'dark' ? 'Light' : 'Dark';
}

function resolvedTheme() {
  const theme = state.config?.ui?.theme || 'auto';
  if (theme === 'auto') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}

function render() {
  const pages = { track: renderTrack, entries: renderEntries, report: renderReport, settings: renderSettings };
  main.innerHTML = pages[state.route]();
}

function renderTrack() {
  if (!state.timer.isRunning) {
    return `
      <h1>Track</h1>
      <p class="lede">Start a timer. It stays on disk, so a restart can pick it up. Type a new project or task name to add it.</p>
      ${alertHtml()}
      <section class="card stack">
        <form id="start-form" class="stack">
          ${projectTaskFields(state.projects, state.trackTasks || [])}
          <label><span>Notes</span><textarea name="notesDraft">${esc(state.notesDraft || '')}</textarea></label>
          <div><button type="submit">Start</button></div>
        </form>
      </section>
    `;
  }
  const elapsed = formatDuration(Math.floor((Date.now() - Date.parse(state.timer.startUtc)) / 1000));
  return `
    <h1>Track</h1>
    <p class="lede">${esc(state.timer.projectName)} · ${esc(state.timer.taskName)}</p>
    ${alertHtml()}
    <section class="card">
      <div class="clock" id="elapsed">${elapsed}</div>
      <form id="stop-form" class="stack">
        <label><span>Notes</span><textarea id="running-notes" name="notes">${esc(state.timer.notesDraft || '')}</textarea></label>
        <label class="check"><input id="override" name="override" type="checkbox"> Set amount manually</label>
        <label><span>Amount (CAD)</span><input name="amountCad" type="number" min="0" step="0.01" placeholder="Auto from wage"></label>
        <div><button type="submit">Stop</button></div>
      </form>
    </section>
  `;
}

function renderEntries() {
  const data = state.entries || { entries: [], totalDurationSeconds: 0, totalAmountCad: 0 };
  return `
    <h1>Entries</h1>
    <p class="lede">Times are shown in the offset saved with each entry.</p>
    ${alertHtml()}
    <section class="card stack">
      ${rangeForm()}
      ${filterControls()}
      <div><button type="button" data-action="new-entry">Add entry</button></div>
      ${state.showEntryForm ? entryFormHtml() : ''}
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Date</th><th>Start</th><th>Finish</th><th>Duration</th><th>Project</th><th>Task</th><th>Notes</th><th>CAD</th><th></th></tr>
          </thead>
          <tbody>
            ${data.entries.length ? data.entries.map(entryRow).join('') : `<tr><td colspan="9" class="muted">No entries in this range.</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="totals">
        <strong>${(data.totalDurationSeconds / 3600).toFixed(2)} h</strong>
        <strong>${formatDuration(data.totalDurationSeconds)}</strong>
        <strong>${Number(data.totalAmountCad).toFixed(2)} CAD</strong>
      </div>
    </section>
  `;
}

function renderReport() {
  return `
    <h1>Report</h1>
    <p class="lede">Download a PDF of the entries in the range, plus the totals. Leave the filters blank to include every project and task.</p>
    ${alertHtml()}
    <section class="card stack">
      <form id="report-form" class="row">
        <label class="grow"><span>From</span><input name="from" type="date" value="${state.range.from}" required></label>
        <label class="grow"><span>To</span><input name="to" type="date" value="${state.range.to}" required></label>
        <button type="submit">Download PDF</button>
      </form>
      ${filterControls()}
      ${state.entries ? `<p class="muted">${state.entries.entries.length} entries · ${(state.entries.totalDurationSeconds / 3600).toFixed(2)} h · ${Number(state.entries.totalAmountCad).toFixed(2)} CAD</p>` : ''}
    </section>
  `;
}

function renderSettings() {
  const config = state.config;
  return `
    <h1>Settings</h1>
    <p class="lede">Wage, appearance, projects, and tasks stay on this machine.</p>
    ${alertHtml()}
    <section class="card stack">
      <form id="config-form" class="row">
        <label class="grow"><span>Default hourly wage (CAD)</span><input name="defaultHourlyWageCad" type="number" min="0" step="0.01" value="${config.defaults.defaultHourlyWageCad}" required></label>
        <label class="grow"><span>Theme</span>
          <select name="theme">
            ${['auto', 'light', 'dark'].map((theme) => `<option value="${theme}" ${config.ui.theme === theme ? 'selected' : ''}>${theme}</option>`).join('')}
          </select>
        </label>
        <label class="grow"><span>Time format</span>
          <select name="timeFormat">
            <option value="24h" ${config.ui.timeFormat === '24h' ? 'selected' : ''}>24-hour</option>
            <option value="12h" ${config.ui.timeFormat === '12h' ? 'selected' : ''}>12-hour</option>
          </select>
        </label>
        <button type="submit">Save preferences</button>
      </form>
    </section>
    <section class="card stack">
      <h2>Projects</h2>
      <form id="project-form" class="row">
        <label class="grow"><span>Name</span><input name="name" required></label>
        <label class="grow"><span>Hourly wage (CAD)</span><input name="hourlyWageCad" type="number" min="0" step="0.01" value="${config.defaults.defaultHourlyWageCad}" required></label>
        <button type="submit">Add project</button>
      </form>
      ${state.projects.map(projectEditor).join('') || '<p class="muted">No projects yet.</p>'}
    </section>
  `;
}

function projectEditor(project) {
  return `
    <div class="project">
      <div class="row">
        <label class="grow"><span>Name</span><input id="project-name-${project.id}" value="${esc(project.name)}"></label>
        <label class="grow"><span>Hourly wage (CAD)</span><input id="project-wage-${project.id}" type="number" min="0" step="0.01" value="${project.hourlyWageCad}"></label>
        <button type="button" data-action="save-project" data-id="${project.id}">Save</button>
      </div>
      <form id="task-form" class="row" data-project-id="${project.id}">
        <label class="grow"><span>New task</span><input name="name" required></label>
        <button type="submit">Add task</button>
      </form>
      <div class="tasks" id="tasks-${project.id}">${taskChips(project.id)}</div>
    </div>
  `;
}

function taskChips(projectId) {
  if (state.taskCache && state.taskCache[projectId]) {
    const chips = state.taskCache[projectId].map((task) => `
      <span class="chip">
        ${esc(task.name)}
        <button type="button" class="chip-delete" data-action="delete-task" data-id="${task.id}" data-project-id="${projectId}" title="Delete task" aria-label="Delete task ${esc(task.name)}">&times;</button>
      </span>
    `).join('') || '<span class="muted">No tasks yet.</span>';
    const pending = state.pendingTaskDelete;
    if (!pending || pending.projectId !== projectId) return chips;
    const count = `${pending.entryCount} entr${pending.entryCount === 1 ? 'y' : 'ies'}`;
    return `${chips}
      <div class="banner stack task-confirm">
        <span>"${esc(pending.name)}" has ${count}. Delete them too, or keep them? Kept entries still show this project and task name.</span>
        <div class="row">
          <button type="button" class="danger" data-action="confirm-delete-task" data-mode="delete">Delete task and ${count}</button>
          <button type="button" class="ghost" data-action="confirm-delete-task" data-mode="keep">Delete task, keep entries</button>
          <button type="button" class="ghost" data-action="cancel-delete-task">Cancel</button>
        </div>
      </div>
    `;
  }
  return '<span class="muted">Loading tasks…</span>';
}

function rangeForm() {
  return `
    <form id="range-form" class="row">
      <label class="grow"><span>From</span><input name="from" type="date" value="${state.range.from}" required></label>
      <label class="grow"><span>To</span><input name="to" type="date" value="${state.range.to}" required></label>
      <button type="submit">Apply</button>
    </form>
  `;
}

function filterControls() {
  const selectedProjects = new Set(state.filters.projectIds);
  const selectedTasks = new Set(state.filters.taskIds);
  const taskProjects = selectedProjects.size
    ? state.projects.filter((project) => selectedProjects.has(project.id))
    : state.projects;
  const groups = taskProjects
    .map((project) => ({ project, tasks: state.allTasks.filter((task) => task.projectId === project.id) }))
    .filter((group) => group.tasks.length);
  const projectNames = state.projects.filter((project) => selectedProjects.has(project.id)).map((project) => project.name);
  const taskNames = state.allTasks.filter((task) => selectedTasks.has(task.id)).map((task) => {
    const project = state.projects.find((item) => item.id === task.projectId);
    return `${project ? project.name : ''} / ${task.name}`;
  });
  return `
    <div class="row">
      <div class="grow field">
        <span>Projects</span>
        <details class="multi" data-filter="projects" ${state.openFilter === 'projects' ? 'open' : ''}>
          <summary>${esc(filterSummary(projectNames, 'All projects'))}</summary>
          <div class="multi-menu">
            ${state.projects.map((project) => filterOption(
              'projectIds',
              project.id,
              esc(project.name),
              selectedProjects.has(project.id)
            )).join('') || '<p class="muted">No projects yet.</p>'}
            <div><button type="button" class="ghost" data-action="clear-filter" data-kind="projectIds">Clear</button></div>
          </div>
        </details>
      </div>
      <div class="grow field">
        <span>Tasks</span>
        <details class="multi" data-filter="tasks" ${state.openFilter === 'tasks' ? 'open' : ''}>
          <summary>${esc(filterSummary(taskNames, 'All tasks'))}</summary>
          <div class="multi-menu">
            ${groups.map(({ project, tasks }) => `
              <div class="multi-group">
                <div class="multi-heading">${esc(project.name)}</div>
                ${tasks.map((task) => filterOption('taskIds', task.id, esc(task.name), selectedTasks.has(task.id))).join('')}
              </div>
            `).join('') || '<p class="muted">No tasks yet.</p>'}
            <div><button type="button" class="ghost" data-action="clear-filter" data-kind="taskIds">Clear</button></div>
          </div>
        </details>
      </div>
    </div>
  `;
}

function filterOption(kind, id, labelHtml, checked) {
  return `<label class="check"><input type="checkbox" data-filter-kind="${kind}" value="${id}" ${checked ? 'checked' : ''}> ${labelHtml}</label>`;
}

function filterSummary(names, allLabel) {
  if (!names.length) return allLabel;
  return names.length === 1 ? names[0] : `${names.length} selected`;
}

function projectTaskFields(projects, tasks) {
  return `
    <label><span>Project</span>
      <input id="project-input" name="projectName" list="project-options" autocomplete="off" required placeholder="Pick a project or type a new one" value="${esc(state.projectName || '')}">
      <datalist id="project-options">
        ${projects.map((project) => `<option value="${esc(project.name)}"></option>`).join('')}
      </datalist>
    </label>
    <label><span>Task</span>
      <input id="task-input" name="taskName" list="task-options" autocomplete="off" required placeholder="Pick a task or type a new one" value="${esc(state.taskName || '')}">
      <datalist id="task-options">${taskOptions(tasks)}</datalist>
    </label>
  `;
}

function taskOptions(tasks) {
  return tasks.map((task) => `<option value="${esc(task.name)}"></option>`).join('');
}

function findByName(items, name) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  return items.find((item) => item.name === wanted)
    || items.find((item) => item.name.toLowerCase() === wanted.toLowerCase())
    || null;
}

async function loadTrackTasks() {
  const project = findByName(state.projects, state.projectName);
  const projectId = project ? project.id : null;
  if (projectId === state.trackTasksProjectId) return false;
  state.trackTasksProjectId = projectId;
  const tasks = projectId ? await api(`/tasks?projectId=${projectId}`) : [];
  if (state.trackTasksProjectId !== projectId) return false;
  state.trackTasks = tasks;
  return true;
}

function entryFormHtml() {
  const entry = state.editing;
  const projects = state.projects;
  const tasks = (state.tasks || []).filter((task) => task.projectId === entry.projectId);
  const partsStart = entry.startUtc ? localParts(entry.startUtc, entry.tzOffsetMinutes) : null;
  const partsFinish = entry.finishUtc ? localParts(entry.finishUtc, entry.tzOffsetMinutes) : null;
  return `
    <form id="entry-form" class="stack">
      <label><span>Project</span>
        <select id="entry-project" name="projectId" required>
          ${projects.map((project) => `<option value="${project.id}" ${project.id === entry.projectId ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}
        </select>
      </label>
      <label><span>Task</span>
        <select name="taskId" required>
          ${entry.id && !entry.taskId ? `<option value="" selected>${esc(entry.taskName || 'Task')} (deleted), pick a task</option>` : ''}
          ${tasks.map((task) => `<option value="${task.id}" ${task.id === entry.taskId ? 'selected' : ''}>${esc(task.name)}</option>`).join('')}
        </select>
      </label>
      <div class="row">
        <label class="grow"><span>Start date</span><input name="startDate" type="date" required value="${partsStart ? dateValue(partsStart) : ''}"></label>
        <label class="grow"><span>Start time</span><input name="startTime" type="time" step="1" required value="${partsStart ? timeValue(partsStart) : ''}"></label>
      </div>
      <div class="row">
        <label class="grow"><span>Finish date</span><input name="finishDate" type="date" required value="${partsFinish ? dateValue(partsFinish) : ''}"></label>
        <label class="grow"><span>Finish time</span><input name="finishTime" type="time" step="1" required value="${partsFinish ? timeValue(partsFinish) : ''}"></label>
      </div>
      <label><span>Notes</span><textarea name="notes">${esc(entry.notes || '')}</textarea></label>
      <label class="check"><input name="amountOverridden" type="checkbox" ${entry.amountOverridden ? 'checked' : ''}> Override amount</label>
      <label><span>Amount (CAD)</span><input name="amountCad" type="number" min="0" step="0.01" value="${entry.amountCad ?? ''}"></label>
      <div class="row">
        <button type="submit">${entry.id ? 'Save entry' : 'Create entry'}</button>
        <button type="button" class="ghost" data-action="cancel-entry">Cancel</button>
      </div>
    </form>
  `;
}

function entryRow(entry) {
  const start = localParts(entry.startUtc, entry.tzOffsetMinutes);
  const finish = localParts(entry.finishUtc, entry.tzOffsetMinutes);
  const format = state.config.ui.timeFormat;
  return `
    <tr>
      <td>${localDateString(entry.startUtc, entry.tzOffsetMinutes)}</td>
      <td>${formatTime(start, format)}</td>
      <td>${formatTime(finish, format)}</td>
      <td>${formatDuration(entry.durationSeconds)}</td>
      <td>${esc(entry.projectName)}</td>
      <td>${esc(entry.taskName || '')}</td>
      <td>${esc(entry.notes)}</td>
      <td>${Number(entry.amountCad).toFixed(2)}${entry.amountOverridden ? ' *' : ''}</td>
      <td class="row">
        <button type="button" class="ghost" data-action="edit-entry" data-id="${entry.id}">Edit</button>
        <button type="button" class="danger" data-action="delete-entry" data-id="${entry.id}">Delete</button>
      </td>
    </tr>
  `;
}

function alertHtml() {
  return `${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}${state.notice ? `<p class="banner">${esc(state.notice)}</p>` : ''}`;
}

async function startTimer(form) {
  const data = Object.fromEntries(new FormData(form));
  state.projectName = (data.projectName || '').trim();
  state.taskName = (data.taskName || '').trim();
  state.notesDraft = data.notesDraft || '';
  state.error = '';
  state.notice = '';
  if (!state.projectName || !state.taskName) throw new Error('Pick or type a project and a task.');
  clearTimeout(notesTimer);
  const added = [];
  let project = findByName(state.projects, state.projectName);
  if (!project) {
    project = await api('/projects', { method: 'POST', body: { name: state.projectName } });
    added.push(`project "${project.name}"`);
    state.projects = await api('/projects');
  }
  let task = findByName(await api(`/tasks?projectId=${project.id}`), state.taskName);
  if (!task) {
    task = await api('/tasks', { method: 'POST', body: { projectId: project.id, name: state.taskName } });
    added.push(`task "${task.name}"`);
  }
  state.timer = await api('/timer/start', {
    method: 'POST',
    body: {
      projectId: project.id,
      taskId: task.id,
      notesDraft: state.notesDraft,
      tzOffsetMinutes: currentOffset(),
    },
  });
  localStorage.setItem(notesKey(state.timer.startUtc), state.timer.notesDraft || '');
  state.projectName = project.name;
  state.taskName = task.name;
  state.notesDraft = '';
  state.trackTasksProjectId = undefined;
  state.notice = added.length ? `Added ${added.join(' and ')}.` : '';
  render();
  startClock();
}

async function stopTimer(form) {
  const data = Object.fromEntries(new FormData(form));
  clearTimeout(notesTimer);
  const body = { notes: data.notes || '' };
  if (form.override.checked && data.amountCad !== '') {
    body.amountCad = Number(data.amountCad);
    body.amountOverridden = true;
  }
  const result = await api('/timer/stop', { method: 'POST', body });
  localStorage.removeItem(notesKey(state.timer.startUtc));
  state.timer = { isRunning: false };
  await loadTrackTasks();
  state.notice = result.overlapWarning
    ? `Saved. This entry overlaps ${result.overlappingEntryIds.length} other entr${result.overlappingEntryIds.length === 1 ? 'y' : 'ies'}.`
    : 'Saved.';
  render();
  startClock();
}

async function loadEntries() {
  const fromInput = document.querySelector('[name="from"]');
  const toInput = document.querySelector('[name="to"]');
  if (fromInput && toInput) state.range = { from: fromInput.value, to: toInput.value };
  state.entries = await api(`/entries?${entriesQuery()}`);
  render();
  if (state.route === 'settings') await hydrateTaskChips();
}

function entriesQuery() {
  const params = new URLSearchParams(state.range);
  if (state.filters.projectIds.length) params.set('projectIds', state.filters.projectIds.join(','));
  if (state.filters.taskIds.length) params.set('taskIds', state.filters.taskIds.join(','));
  return params.toString();
}

async function toggleFilter(kind, id, checked) {
  const ids = new Set(state.filters[kind]);
  if (checked) ids.add(id);
  else ids.delete(id);
  let taskIds = kind === 'taskIds' ? [...ids] : state.filters.taskIds;
  const projectIds = kind === 'projectIds' ? [...ids] : state.filters.projectIds;
  if (kind === 'projectIds') {
    const keep = new Set(projectIds);
    taskIds = taskIds.filter((taskId) => {
      const task = state.allTasks.find((item) => item.id === taskId);
      if (!task) return false;
      if (!checked && task.projectId === id) return false;
      return keep.size === 0 || keep.has(task.projectId);
    });
  }
  state.filters = { projectIds, taskIds };
  state.openFilter = kind === 'projectIds' ? 'projects' : 'tasks';
  await loadEntries();
}

async function clearFilter(kind) {
  state.filters = { ...state.filters, [kind]: [] };
  state.openFilter = null;
  await loadEntries();
}

async function saveEntry(form) {
  const data = Object.fromEntries(new FormData(form));
  const offset = state.editing?.id ? state.editing.tzOffsetMinutes : currentOffset();
  const body = {
    projectId: Number(data.projectId),
    taskId: Number(data.taskId),
    startUtc: wallToUtc(data.startDate, data.startTime, offset),
    finishUtc: wallToUtc(data.finishDate, data.finishTime, offset),
    tzOffsetMinutes: offset,
    notes: data.notes || '',
    amountOverridden: Boolean(form.amountOverridden.checked),
  };
  if (body.amountOverridden) body.amountCad = Number(data.amountCad);
  const path = state.editing?.id ? `/entries/${state.editing.id}` : '/entries';
  const method = state.editing?.id ? 'PUT' : 'POST';
  const result = await api(path, { method, body });
  state.notice = result.overlapWarning
    ? `Saved. This entry overlaps ${result.overlappingEntryIds.length} other entr${result.overlappingEntryIds.length === 1 ? 'y' : 'ies'}.`
    : 'Saved.';
  state.showEntryForm = false;
  state.editing = null;
  await loadEntries();
}

async function openEdit(id) {
  const entry = state.entries.entries.find((item) => item.id === id);
  state.editing = { ...entry };
  state.showEntryForm = true;
  state.tasks = await api(`/tasks?projectId=${entry.projectId}`);
  render();
}

async function removeEntry(id) {
  if (!confirm('Delete this entry?')) return;
  await api(`/entries/${id}`, { method: 'DELETE' });
  state.notice = 'Entry deleted.';
  await loadEntries();
}

async function downloadPdf(form) {
  const data = Object.fromEntries(new FormData(form));
  state.range = { from: data.from, to: data.to };
  const response = await fetch('/api/reports/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...state.range, ...state.filters }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not build the PDF');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `timetrack-${data.from}_${data.to}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
  state.entries = await api(`/entries?${entriesQuery()}`);
  state.notice = 'PDF downloaded.';
  render();
}

async function saveConfig(form) {
  const data = Object.fromEntries(new FormData(form));
  const next = {
    ...state.config,
    defaults: {
      ...state.config.defaults,
      defaultHourlyWageCad: Number(data.defaultHourlyWageCad),
    },
    ui: {
      ...state.config.ui,
      theme: data.theme,
      timeFormat: data.timeFormat,
    },
  };
  state.config = await api('/config', { method: 'PUT', body: next });
  applyTheme();
  state.notice = 'Preferences saved.';
  render();
  await hydrateTaskChips();
}

async function createProject(form) {
  const data = Object.fromEntries(new FormData(form));
  await api('/projects', {
    method: 'POST',
    body: { name: data.name, hourlyWageCad: Number(data.hourlyWageCad) },
  });
  state.projects = await api('/projects');
  state.notice = 'Project added.';
  render();
  await hydrateTaskChips();
}

async function saveProject(id) {
  const name = document.getElementById(`project-name-${id}`).value;
  const hourlyWageCad = Number(document.getElementById(`project-wage-${id}`).value);
  await api(`/projects/${id}`, {
    method: 'PUT',
    body: { name, hourlyWageCad },
  });
  state.projects = await api('/projects');
  state.notice = 'Project saved.';
  render();
  await hydrateTaskChips();
}

async function deleteTask(id, projectId) {
  const task = (state.taskCache?.[projectId] || []).find((item) => item.id === id);
  if (!task) return;
  state.notice = '';
  state.error = '';
  if (task.entryCount > 0) {
    const previous = state.pendingTaskDelete?.projectId;
    state.pendingTaskDelete = task;
    if (previous && previous !== projectId) refreshTaskSlot(previous);
    refreshTaskSlot(projectId);
    return;
  }
  if (!confirm(`Delete task "${task.name}"?`)) return;
  await removeTask(task);
}

async function removeTask(task, mode) {
  if (!task) return;
  const query = mode ? `?entries=${mode}` : '';
  const result = await api(`/tasks/${task.id}${query}`, { method: 'DELETE' });
  state.pendingTaskDelete = null;
  const plural = (n) => `${n} entr${n === 1 ? 'y' : 'ies'}`;
  if (result.deletedEntries) state.notice = `Task "${task.name}" and ${plural(result.deletedEntries)} deleted.`;
  else if (result.keptEntries) state.notice = `Task "${task.name}" deleted. ${plural(result.keptEntries)} kept.`;
  else state.notice = `Task "${task.name}" deleted.`;
  render();
  await hydrateTaskChips();
}

function refreshTaskSlot(projectId) {
  const slot = document.getElementById(`tasks-${projectId}`);
  if (slot) slot.innerHTML = taskChips(projectId);
}

async function createTask(form) {
  const data = Object.fromEntries(new FormData(form));
  await api('/tasks', {
    method: 'POST',
    body: { projectId: Number(form.dataset.projectId), name: data.name },
  });
  state.notice = 'Task added.';
  render();
  await hydrateTaskChips();
}

async function loadTasks(projectId) {
  state.tasks = projectId ? await api(`/tasks?projectId=${projectId}`) : [];
}

async function hydrateTaskChips() {
  if (state.route !== 'settings') return;
  state.taskCache = {};
  await Promise.all(state.projects.map(async (project) => {
    state.taskCache[project.id] = await api(`/tasks?projectId=${project.id}`);
    refreshTaskSlot(project.id);
  }));
}

function blankEntry() {
  const project = state.projects[0];
  return {
    projectId: project ? project.id : null,
    taskId: null,
    tzOffsetMinutes: currentOffset(),
    notes: '',
    amountOverridden: false,
    amountCad: '',
  };
}

function startClock() {
  clearInterval(clockTimer);
  if (!state.timer.isRunning) return;
  clockTimer = setInterval(() => {
    const el = document.getElementById('elapsed');
    if (!el || !state.timer.isRunning) return;
    el.textContent = formatDuration(Math.floor((Date.now() - Date.parse(state.timer.startUtc)) / 1000));
  }, 1000);
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body == null ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || response.statusText);
  return data;
}

function notesKey(startUtc) {
  return `timetrack-notes-${startUtc}`;
}

function currentOffset() {
  return -new Date().getTimezoneOffset();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localParts(isoUtc, offsetMinutes) {
  const date = new Date(Date.parse(isoUtc) + offsetMinutes * 60 * 1000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function localDateString(isoUtc, offsetMinutes) {
  const parts = localParts(isoUtc, offsetMinutes);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function formatTime(parts, timeFormat) {
  if (timeFormat === '12h') {
    const suffix = parts.hour >= 12 ? 'PM' : 'AM';
    let hour = parts.hour % 12;
    if (hour === 0) hour = 12;
    return `${hour}:${pad(parts.minute)}:${pad(parts.second)} ${suffix}`;
  }
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return `${hours}:${pad(minutes)}:${pad(secs)}`;
}

function dateValue(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function timeValue(parts) {
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function wallToUtc(dateStr, timeStr, offsetMinutes) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute, second = 0] = timeStr.split(':').map(Number);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60 * 1000;
  return new Date(utcMs).toISOString();
}

function monthRange() {
  const now = new Date();
  const from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const to = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return { from, to };
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}
