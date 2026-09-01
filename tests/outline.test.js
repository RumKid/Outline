import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const authScript = await readFile(new URL('../src/auth.js', import.meta.url), 'utf8');
const storageScript = await readFile(new URL('../src/storage.js', import.meta.url), 'utf8');
const tasksScript = await readFile(new URL('../src/tasks.js', import.meta.url), 'utf8');
const projectsScript = await readFile(new URL('../src/projects.js', import.meta.url), 'utf8');
const wealthScript = await readFile(new URL('../src/wealth.js', import.meta.url), 'utf8');
const viewsScript = await readFile(new URL('../src/views.js', import.meta.url), 'utf8');
const appScript = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
assert.ok(appScript, 'Outline app script should be present');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); }
  };
}

function createDirectory(initial = {}) {
  const files = new Map(Object.entries(initial));
  const directory = {
    name: 'Outline test folder',
    files,
    failWrites: 0,
    failWritesFor: null,
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) {
        const error = new Error(`Missing file: ${name}`);
        error.name = 'NotFoundError';
        throw error;
      }
      if (!files.has(name)) files.set(name, '');
      return {
        async getFile() {
          return { text: async () => files.get(name) };
        },
        async createWritable() {
          let nextText = '';
          return {
            async write(text) {
              if (directory.failWrites > 0 && directory.failWritesFor === name) {
                directory.failWrites--;
                throw new Error('Simulated write failure');
              }
              nextText = text;
            },
            async close() { files.set(name, nextText); },
            async abort() {}
          };
        }
      };
    }
  };
  return directory;
}

function loadApp(storage = createStorage()) {
  const elements = new Map();
  const content = { innerHTML: '', scrollTop: 0 };
  elements.set('content', content);
  const document = {
    addEventListener() {},
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll() { return []; },
    body: { appendChild() {} }
  };
  const context = {
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    document,
    localStorage: storage,
    indexedDB: {},
    window: { showDirectoryPicker: null },
    navigator: {},
    Notification: { permission: 'denied' },
    Chart: { defaults: { font: {} } },
    confirm: () => true,
    prompt: () => null,
    alert: () => {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    Intl,
    console
  };
  vm.createContext(context);
  vm.runInContext(`${authScript}\n${storageScript}\n${tasksScript}\n${projectsScript}\n${wealthScript}\n${viewsScript}\n${appScript}\nthis.__outline = { S, DM, Auth, DATA_SCHEMA_VERSION, dateKey, today, addDays, thisWeek, escH, eventArg, renderView, vStudy, vProjects, vSettings, setSettingsTab, cdState, cdToggle, doToggleTimer };`, context);
  vm.runInContext("this.__outline.vTasks = vTasks; this.__outline.vProjects = vProjects; this.__outline.openTaskDetail = openTaskDetail; this.__outline.closeTaskDetail = closeTaskDetail; this.__outline.saveTaskDetail = saveTaskDetail; this.__outline.taskDetailPanel = taskDetailPanel; this.__outline.setProjectViewMode = setProjectViewMode; this.__outline.setTaskDateFilter = setTaskDateFilter; this.__outline.setTaskCompletionFilter = setTaskCompletionFilter; this.__outline.setProjectStatusFilter = setProjectStatusFilter; this.__outline.setProjectCompletionFilter = setProjectCompletionFilter; this.__outline.buildSearchResults = buildSearchResults; this.__outline.paletteCommands = paletteCommands;", context);
  return { ...context.__outline, storage, content, elements };
}

test('local date helpers use the local calendar date', () => {
  const { dateKey, addDays, thisWeek } = loadApp();
  const localDate = new Date(2026, 7, 26, 23, 45);

  assert.equal(dateKey(localDate), '2026-08-26');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(thisWeek().length, 7);
});

test('the standalone app has no remote runtime dependencies', () => {
  const source = `${html}\n${appScript}`;
  assert.doesNotMatch(source, /fonts\.googleapis\.com|cdn\.jsdelivr\.net/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|new\s+Chart\s*\(/);
  assert.match(appScript, /function makeSvgChart\(/);
  assert.match(styles, /\.offline-chart\s*\{[^}]*width:100%;[^}]*height:100%;/);
  assert.doesNotMatch(html, /\bon(?:click|keydown|change|input)=/);
  assert.match(html, /data-action="pick-folder"/);
  assert.match(appScript, /event\.target\.closest\('\[data-action\]'\)/);
});

test('Settings UI exposes storage, security, and recovery controls', async () => {
  const app = loadApp();
  const markup = app.vSettings();
  assert.match(markup, /Storage/);
  assert.match(markup, /Security/);
  assert.match(markup, /Recovery/);
  assert.match(markup, /Download full backup/);
  await app.setSettingsTab('recovery');
  assert.match(app.content.innerHTML, /Recovery history/);
  assert.match(html, /data-view="settings"/);
  assert.doesNotMatch(html, /data-actions/);
});

test('reconnect flow has explicit failure and timeout fallbacks', () => {
  assert.match(appScript, /Reconnect failed · using browser storage/);
  assert.match(appScript, /Reconnect timed out · using browser storage/);
  assert.match(appScript, /8000/);
});

  test('browser smoke rendering produces the Study view', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  await app.renderView('study');
  assert.match(app.content.innerHTML, /Study Tracker/);
  assert.match(app.content.innerHTML, /study-chart/);
    assert.match(app.content.innerHTML, /Today's Sessions/);
    await app.renderView('settings');
    assert.match(app.content.innerHTML, /Settings &amp; Data/);
    assert.match(app.content.innerHTML, /Download full backup/);
  });

test('HTML escaping protects text, attributes, and inline handler arguments', () => {
  const { escH, eventArg } = loadApp();
  const payload = `\"><img src=x onerror=alert(1)> & 'quoted'`;

  assert.equal(escH(payload), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;quoted&#39;');
  assert.equal(eventArg(payload), '&quot;\\&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;quoted&#39;&quot;');
  assert.doesNotMatch(eventArg(payload), /(^|[^&])"/);
});

test('study countdown restores its absolute end time after reload', () => {
  const endTime = Date.now() + 45 * 60 * 1000;
  const app = loadApp(createStorage({
    pvp_countdown: { duration: 45 * 60, remaining: 45 * 60, running: true, endTime }
  }));
  assert.equal(app.cdState.running, true);
  assert.ok(app.cdState.endTime >= endTime - 1000);
  assert.ok(app.cdState.remaining <= 45 * 60 && app.cdState.remaining > 45 * 60 - 5);
});

test('study timers do not overlap and stopping countdown records elapsed time', () => {
  const app = loadApp();
  app.S.startSession();
  app.cdState.duration = 120;
  app.cdState.remaining = 120;
  app.cdState.running = false;
  app.cdToggle();
  assert.notEqual(app.S.activeSession(), null);
  assert.equal(app.S.sessions().length, 0);
  app.S.stopSession();
  app.cdState.running = true;
  app.cdState.endTime = Date.now() + 60000;
  app.cdToggle();
  assert.equal(app.S.sessions().length, 2);
  assert.ok(app.S.sessions()[1].mins >= 1);
});

test('tasks persist and reload with their date and subtasks', async () => {
  const storage = createStorage();
  const firstApp = loadApp(storage);
  firstApp.DM.fallback = true;
  await firstApp.S.addTask({ id: 'task-1', title: 'Ship Outline', priority: 'high', done: false, date: '2026-08-26' });
  await firstApp.S.addSubtask('task-1', 'Check persistence');

  const secondApp = loadApp(storage);
  const tasks = secondApp.S.tasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Ship Outline');
  assert.equal(tasks[0].date, '2026-08-26');
  assert.equal(tasks[0].subtasks[0].title, 'Check persistence');
});

test('personal and project task models remain separate with optional detail metadata', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  await app.S.addTask({ id: 'personal-detail', title: 'Personal detail', priority: 'medium', done: false, date: '2026-08-31' });
  await app.S.updateTask('personal-detail', { notes: 'Private note', dueTime: '09:30', estimateMinutes: 25 });
  await app.S.addProject({ id: 'project-detail', title: 'Project detail', description: '', status: 'active', tasks: [] });
  await app.S.addProjectTask('project-detail', 'Project detail task', 'high');
  const projectTaskId = app.S.projects()[0].tasks[0].id;
  await app.S.updateProjectTask('project-detail', projectTaskId, { notes: 'Project note', dueDate: '2026-09-01', dueTime: '14:00', estimateMinutes: 45 });
  const personal = app.S.tasks()[0];
  const project = app.S.projects()[0];
  assert.equal(personal.notes, 'Private note');
  assert.equal(personal.dueTime, '09:30');
  assert.equal(project.tasks[0].notes, 'Project note');
  assert.equal(project.tasks[0].dueDate, '2026-09-01');
  assert.equal(personal.projectId, undefined);
  assert.equal(project.tasks[0].date, undefined);
});

test('task detail panels expose separate personal and project context', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  await app.S.addTask({ id: 'detail-task', title: 'Open me', priority: 'high', done: false, date: '2026-08-31', notes: 'A note', subtasks: [] });
  app.openTaskDetail('personal', 'detail-task');
  await app.renderView('tasks');
  assert.match(app.content.innerHTML, /Task details/);
  assert.match(app.content.innerHTML, /Personal task/);
  assert.match(app.content.innerHTML, /A note/);
  await app.S.addProject({ id: 'detail-project', title: 'Project', description: '', status: 'active', tasks: [] });
  await app.S.addProjectTask('detail-project', 'Project task', 'medium');
  const projectTaskId = app.S.projects()[0].tasks[0].id;
  app.openTaskDetail('project', projectTaskId, 'detail-project');
  await app.renderView('projects');
  assert.match(app.content.innerHTML, /Project task/);
});

test('task detail edits flush to file-backed storage', async () => {
  const app = loadApp();
  const directory = createDirectory();
  app.DM.dirHandle = directory;
  app.DM.fallback = true;
  await app.S.addTask({ id: 'safe-detail', title: 'Before', priority: 'medium', done: false, date: '2026-08-31', subtasks: [] });
  app.DM.fallback = false;
  app.openTaskDetail('personal', 'safe-detail');
  app.elements.set('detail-title-personal-safe-detail', { value: 'After' });
  app.elements.set('detail-notes-personal-safe-detail', { value: 'Saved safely' });
  app.elements.set('detail-priority-personal-safe-detail', { value: 'high' });
  app.elements.set('detail-time-personal-safe-detail', { value: '' });
  app.elements.set('detail-estimate-personal-safe-detail', { value: '30' });
  app.elements.set('detail-date-personal-safe-detail', { value: '2026-08-31' });
  await app.saveTaskDetail('personal', 'safe-detail');
  const saved = JSON.parse(directory.files.get('outline-data.json')).tasks[0];
  assert.equal(saved.title, 'After');
  assert.equal(saved.notes, 'Saved safely');
  assert.equal(saved.estimateMinutes, '30');
});

test('tasks render today, overdue, upcoming, and collapsed completed sections', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  await app.S.addTask({ id: 'today-task', title: 'Today task', priority: 'high', done: false, date: '2026-08-31', subtasks: [] });
  await app.S.addTask({ id: 'overdue-task', title: 'Overdue task', priority: 'medium', done: false, date: '2026-08-30', subtasks: [] });
  await app.S.addTask({ id: 'upcoming-task', title: 'Upcoming task', priority: 'low', done: false, date: '2026-09-01', subtasks: [] });
  await app.S.addTask({ id: 'completed-task', title: 'Completed task', priority: 'low', done: true, date: '2026-08-31', subtasks: [] });
  await app.renderView('tasks');
  assert.match(app.content.innerHTML, /Today/);
  assert.match(app.content.innerHTML, /Overdue/);
  assert.match(app.content.innerHTML, /Upcoming/);
  assert.match(app.content.innerHTML, /Completed/);
  assert.match(app.content.innerHTML, /Today task/);
  assert.match(app.content.innerHTML, /Overdue task/);
  assert.match(app.content.innerHTML, /Upcoming task/);
  assert.doesNotMatch(app.content.innerHTML, /Completed task/);
  assert.match(app.content.innerHTML, /Completion/);
});

test('task filters and project completion/status behavior preserve separate contexts', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  const date = app.today();
  await app.S.addTask({ id: 'filter-today', title: 'High today', priority: 'high', done: false, date, subtasks: [] });
  await app.S.addTask({ id: 'filter-done', title: 'Done today', priority: 'low', done: true, date, subtasks: [] });
  app.setTaskDateFilter('today');
  app.setTaskCompletionFilter('active');
  await app.renderView('tasks');
  assert.match(app.content.innerHTML, /High today/);
  assert.doesNotMatch(app.content.innerHTML, /Done today/);
  app.setTaskCompletionFilter('completed');
  await app.renderView('tasks');
  assert.match(app.content.innerHTML, /Done today/);

  await app.S.addProject({ id: 'status-project', title: 'Status project', description: '', status: 'active', tasks: [] });
  await app.S.addProjectTask('status-project', 'Status task', 'medium');
  const taskId = app.S.projects()[0].tasks[0].id;
  app.S.setProjectTaskStatus('status-project', taskId, 'in-progress');
  app.S.toggleProjectTask('status-project', taskId);
  assert.equal(app.S.projects()[0].tasks[0].status, 'done');
  app.S.toggleProjectTask('status-project', taskId);
  assert.equal(app.S.projects()[0].tasks[0].status, 'in-progress');
});

test('offline search respects task contexts and locked encrypted state', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  await app.S.addTask({ id: 'search-personal', title: 'Private planning', notes: 'Personal note', date: app.today(), done: false, subtasks: [] });
  await app.S.addProject({ id: 'search-project', title: 'Launch project', description: 'Project note', status: 'active', tasks: [] });
  await app.S.addProjectTask('search-project', 'Project planning', 'high');
  let results = await app.buildSearchResults('planning');
  assert.equal(results.map(result => result.kind).join(','), 'personal,project-task');
  await app.Auth.setPassword('search password', {}, []);
  results = await app.buildSearchResults('planning');
  assert.equal(results.map(result => result.kind).join(','), 'personal,project-task');
  app.Auth.lock();
  assert.equal((await app.buildSearchResults('planning')).length, 0);
  assert.ok(app.paletteCommands().some(([label]) => label === 'Search tasks and projects'));
});

test('project tasks support a personal board workflow', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  await app.S.addProject({ id: 'project-board', title: 'Launch', description: '', status: 'active', tasks: [] });
  await app.S.addProjectTask('project-board', 'Prepare release notes', 'high');

  let project = app.S.projects()[0];
  const taskId = project.tasks[0].id;
  assert.equal(project.tasks[0].status, 'backlog');
  app.S.setProjectTaskStatus('project-board', taskId, 'in-progress');
  project = app.S.projects()[0];
  assert.equal(project.tasks[0].status, 'in-progress');
  assert.equal(project.tasks[0].done, false);
  app.S.setProjectTaskStatus('project-board', taskId, 'done');
  project = app.S.projects()[0];
  assert.equal(project.tasks[0].status, 'done');
  assert.equal(project.tasks[0].done, true);
});

test('recurring personal tasks generate one next occurrence without changing task context', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  const date = app.today();
  await app.S.addTask({ id: 'daily-task', title: 'Daily task', priority: 'medium', done: false, date, recurrence: { type: 'daily', days: [] }, subtasks: [{ id: 'daily-subtask', title: 'Step', done: false }] });
  app.S.toggleTask('daily-task');
  let tasks = app.S.tasks();
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find(task => task.id === 'daily-task').done, true);
  const next = tasks.find(task => !task.done);
  assert.equal(next.date, app.addDays(date, 1));
  assert.equal(next.seriesId, 'daily-task');
  assert.equal(next.subtasks[0].done, false);
  app.S.toggleTask('daily-task');
  assert.equal(app.S.tasks().length, 2, 'reopening a completed occurrence must not duplicate the next occurrence');
});

test('recurrence handles weekdays, weekly, custom days, and overdue completion', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  const today = app.today();
  const weekday = new Date(today + 'T12:00:00').getDay();
  await app.S.addTask({ id: 'weekday-task', title: 'Weekday', priority: 'low', done: false, date: today, recurrence: { type: 'weekdays', days: [] } });
  app.S.toggleTask('weekday-task');
  const weekdayNext = app.S.tasks().find(task => task.seriesId === 'weekday-task');
  assert.ok(weekdayNext.date > today);
  assert.ok(![0, 6].includes(new Date(weekdayNext.date + 'T12:00:00').getDay()));

  const customDay = (weekday + 2) % 7;
  await app.S.addTask({ id: 'custom-task', title: 'Custom', priority: 'low', done: false, date: today, recurrence: { type: 'custom', days: [customDay] } });
  app.S.toggleTask('custom-task');
  const customNext = app.S.tasks().find(task => task.seriesId === 'custom-task');
  assert.equal(new Date(customNext.date + 'T12:00:00').getDay(), customDay);

  const overdueDate = app.addDays(today, -3);
  await app.S.addTask({ id: 'overdue-recurring', title: 'Overdue recurring', priority: 'low', done: false, date: overdueDate, recurrence: { type: 'daily', days: [] } });
  app.S.toggleTask('overdue-recurring');
  const overdueNext = app.S.tasks().find(task => task.seriesId === 'overdue-recurring');
  assert.equal(overdueNext.date, app.addDays(today, 1));
});

test('project task UX preserves statuses and renders filters, list controls, deadlines, and health', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  await app.S.addProject({ id: 'health-project', title: 'Health project', description: '', deadline: app.addDays(app.today(), 2), status: 'active', tasks: [] });
  await app.S.addProjectTask('health-project', 'Project task', 'high', 'backlog');
  const taskId = app.S.projects()[0].tasks[0].id;
  await app.S.updateProjectTask('health-project', taskId, { notes: 'Project notes', dueDate: app.today(), estimateMinutes: 20 });
  app.S.setProjectTaskStatus('health-project', taskId, 'in-progress');
  assert.equal(app.S.projects()[0].tasks[0].status, 'in-progress');
  app.setProjectViewMode('list');
  await app.renderView('projects');
  assert.match(app.content.innerHTML, /Health project/);
  assert.match(app.content.innerHTML, /On track|At risk|Overdue/);
  assert.match(app.content.innerHTML, /Priority/);
  assert.match(app.content.innerHTML, /Sort/);
  assert.match(app.content.innerHTML, /List/);
  assert.match(app.content.innerHTML, /Status/);
  assert.match(app.content.innerHTML, /Completion/);
  app.openTaskDetail('project', taskId, 'health-project');
  await app.renderView('projects');
  assert.match(app.content.innerHTML, /Project notes/);
});

test('wealth income, expense, transfer, deletion, and budget calculations stay balanced', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  await app.S.addWealthAccount({ id: 'bank', name: 'Bank', type: 'bank', balance: 1000, currency: '₹' });
  await app.S.addWealthAccount({ id: 'cash', name: 'Cash', type: 'cash', balance: 100, currency: '₹' });

  await app.S.addWealthTransaction({ id: 'income-1', type: 'income', accountId: 'bank', category: 'Salary', amount: 500, date: '2026-08-26', note: '' });
  await app.S.addWealthTransaction({ id: 'expense-1', type: 'expense', accountId: 'bank', category: 'Food', amount: 125, date: '2026-08-26', note: '' });
  await app.S.addWealthTransaction({ id: 'transfer-1', type: 'transfer', accountId: 'bank', toAccountId: 'cash', category: 'Transfer', amount: 200, date: '2026-08-26', note: '' });

  let wealth = app.S.wealth();
  assert.equal(wealth.accounts.find(account => account.id === 'bank').balance, 1175);
  assert.equal(wealth.accounts.find(account => account.id === 'cash').balance, 300);

  app.S.delWealthTransaction('expense-1');
  app.S.setWealthBudget('Food', 500);
  wealth = app.S.wealth();
  assert.equal(wealth.accounts.find(account => account.id === 'bank').balance, 1300);
  assert.equal(wealth.budgets.Food, 500);
});

test('password setup and unlock encrypt existing project subtasks', async () => {
  const app = loadApp();
  app.DM.fallback = true;
  app.storage.setItem('pvp_projects', JSON.stringify([{
    id: 'project-1',
    title: 'Private project',
    description: 'Private details',
    status: 'active',
    tasks: [{
      id: 'project-task-1',
      title: 'Private task',
      notes: 'Private task note',
      done: false,
      subtasks: [{ id: 'project-subtask-1', title: 'Private subtask', done: false }]
    }]
  }]));

  await app.Auth.setPassword('correct horse battery', {}, []);
  let stored = await app.Auth.decrypt(JSON.parse(app.storage.getItem('pvp_private_vault')));
  stored = stored.pvp_projects;
  assert.equal(stored[0].tasks[0].subtasks[0].title._enc, true);
  assert.equal(await app.Auth.decrypt(stored[0].tasks[0].subtasks[0].title), 'Private subtask');
  assert.equal(await app.Auth.decrypt(stored[0].tasks[0].notes), 'Private task note');

  app.Auth.lock();
  app.storage.removeItem('pvp_private_vault');
  app.storage.setItem('pvp_projects', JSON.stringify([{
    id: 'project-1',
    title: stored[0].title,
    description: stored[0].description,
    status: 'active',
    tasks: [{
      id: 'project-task-1',
      title: stored[0].tasks[0].title,
      done: false,
      subtasks: [{ id: 'project-subtask-2', title: 'Added while legacy', done: false }]
    }]
  }]));
  app.S.clearCache();
  assert.equal(await app.Auth.unlock('correct horse battery'), true);
  stored = JSON.parse(app.storage.getItem('pvp_private_vault'));
  stored = await app.Auth.decrypt(stored);
  stored = stored.pvp_projects;
  assert.equal(stored[0].tasks[0].subtasks[0].title._enc, true);
  assert.equal(await app.Auth.decrypt(stored[0].tasks[0].subtasks[0].title), 'Added while legacy');

  assert.ok(JSON.parse(app.storage.getItem('pvp_private_vault'))._enc);
  app.Auth.lock();
  await assert.rejects(
    app.S.addTask({ id: 'locked-task', title: 'Should not write', date: '2026-08-26', done: false }),
    /locked/i
  );
  assert.equal(await app.Auth.unlock('correct horse battery'), true);
  assert.equal(await app.Auth.rotatePassword('new correct password'), true);
  app.Auth.lock();
  assert.equal(await app.Auth.unlock('correct horse battery'), false);
  assert.equal(await app.Auth.unlock('new correct password'), true);
});

test('durable saves flush pending data and retry transient write failures', async () => {
  const app = loadApp();
  const directory = createDirectory();
  app.DM.dirHandle = directory;
  app.DM.fallback = true;
  app.S.s('pvp_tasks', [{ id: 'durable-1', title: 'Durable task', date: '2026-08-26', done: false, subtasks: [] }]);
  app.DM.fallback = false;

  app.DM.save();
  assert.equal(app.DM.savePending, true);
  assert.equal(await app.DM.flush(), true);
  assert.ok(directory.files.has('outline-data.json'));

  directory.failWrites = 2;
  directory.failWritesFor = 'outline-data.json';
  app.DM.save();
  assert.equal(await app.DM.flush(), true);
  assert.equal(directory.failWrites, 0);

  app.DM.fallback = true;
  app.storage.setItem('pvp_journal', JSON.stringify({ '2026-08-26': { text: 'Saved journal' } }));
  app.DM.fallback = false;
  app.DM.saveJournal();
  assert.equal(await app.DM.flushJournal(), true);
  assert.ok(directory.files.has('outline-journal.json'));
});

test('switching folders flushes the old folder and saves later changes to the new folder', async () => {
  const data = (title) => JSON.stringify({
    schemaVersion: 1,
    tasks: [{ id: 'folder-task', title, date: '2099-01-01', done: false, subtasks: [] }],
    habits: [], water: {}, sessions: [], active: null, sleep: {}, intentions: {},
    dailySummaries: {}, wealth: { accounts: [], transactions: [], budgets: {}, categories: {} },
    projects: [], ideas: [], savedAt: new Date().toISOString()
  });
  const folderA = createDirectory({ 'outline-data.json': data('Folder A') });
  const folderB = createDirectory({ 'outline-data.json': data('Folder B') });
  const app = loadApp();
  app.DM.dirHandle = folderA;

  await app.DM.loadAll();
  assert.equal(app.DM.savePending, false, 'loading must not schedule a save');
  app.S.s('pvp_tasks', [{ id: 'folder-task', title: 'Changed in A', date: '2099-01-01', done: false, subtasks: [] }]);

  assert.equal(await app.DM.prepareForFolderSwitch(), true);
  app.DM.dirHandle = folderB;
  await app.DM.loadAll();
  assert.equal(app.S.tasks()[0].title, 'Folder B');
  assert.equal(app.DM.savePending, false, 'loading folder B must not save into it');
  assert.equal(JSON.parse(folderA.files.get('outline-data.json')).tasks[0].title, 'Changed in A');

  app.S.s('pvp_tasks', [{ id: 'folder-task', title: 'Changed in B', date: '2099-01-01', done: false, subtasks: [] }]);
  assert.equal(await app.DM.flush(), true);
  assert.equal(JSON.parse(folderB.files.get('outline-data.json')).tasks[0].title, 'Changed in B');
});

test('journal edits are persisted immediately and survive a reload during a pending write', async () => {
  const directory = createDirectory({
    'outline-journal.json': JSON.stringify({ '2026-08-26': { text: 'Old text' } })
  });
  const app = loadApp();
  app.DM.dirHandle = directory;

  await app.S.saveJournal({ '2026-08-26': { text: 'New text', mood: 'Good' } });
  assert.equal(JSON.parse(directory.files.get('outline-journal.json'))['2026-08-26'].text, 'New text');
  assert.equal(app.storage.getItem('pvp_journal_pending'), null);

  const reloaded = loadApp(createStorage({
    pvp_journal_pending: { '2026-08-26': { text: 'Recovered text' } }
  }));
  reloaded.DM.dirHandle = createDirectory({
    'outline-journal.json': JSON.stringify({ '2026-08-26': { text: 'Stale disk text' } })
  });
  await reloaded.DM.loadAll();
  await reloaded.DM.flushJournal();
  assert.equal(reloaded.S.journalMap()['2026-08-26'].text, 'Recovered text');
});

test('locked app renders a lock screen for protected views', async () => {
  const app = loadApp();
  app.storage.setItem('pvp_enc_verify', JSON.stringify({ _enc: true }));
  await app.renderView('wealth');
  assert.match(app.content.innerHTML, /Outline is Locked/);
});

test('legacy data migrates to the current schema and future schemas are protected', async () => {
  const legacyDirectory = createDirectory({
    'outline-data.json': JSON.stringify({
      tasks: [{ id: 'legacy-task', title: 'Legacy task', date: '2026-08-26', done: false }]
    })
  });

  const legacyApp = loadApp();
  legacyApp.DM.dirHandle = legacyDirectory;
  const migrated = await legacyApp.DM.load();
  assert.equal(migrated.schemaVersion, legacyApp.DATA_SCHEMA_VERSION);
  assert.equal(migrated.tasks[0].subtasks.length, 0);
  assert.match(legacyApp.DM.schemaMigrationNotice, /Legacy data upgraded/);

  legacyApp.DM.fallback = true;
  legacyApp.S.s('pvp_tasks', migrated.tasks);
  legacyApp.DM.fallback = false;
  assert.equal(await legacyApp.DM._doSave(), true);
  assert.equal(JSON.parse(legacyDirectory.files.get('outline-data.json')).schemaVersion, legacyApp.DATA_SCHEMA_VERSION);

  const futureDirectory = createDirectory({
    'outline-data.json': JSON.stringify({ schemaVersion: legacyApp.DATA_SCHEMA_VERSION + 1, tasks: [] })
  });
  const futureApp = loadApp();
  futureApp.DM.dirHandle = futureDirectory;
  assert.equal(await futureApp.DM.load(), null);
  assert.equal(futureApp.DM.schemaBlocked, true);
  assert.equal(await futureApp.DM._doSave(), false);
  assert.equal(futureDirectory.files.get('outline-data.json'), JSON.stringify({ schemaVersion: legacyApp.DATA_SCHEMA_VERSION + 1, tasks: [] }));
});

test('wealth rejects invalid values and prevents orphaned account data', async () => {
  const app = loadApp();
  app.DM.fallback = true;

  assert.equal(await app.S.addWealthAccount({ id: 'blank', name: ' ', type: 'bank', balance: 10, currency: '₹' }), false);
  assert.equal(await app.S.addWealthAccount({ id: 'bad-number', name: 'Bad', type: 'bank', balance: '12abc', currency: '₹' }), false);
  assert.equal(await app.S.addWealthAccount({ id: 'bank', name: 'Bank', type: 'bank', balance: 100, currency: '₹' }), true);
  assert.equal(await app.S.addWealthTransaction({ id: 'missing-account', type: 'expense', accountId: 'missing', category: 'Food', amount: 10, date: '2026-08-26', note: '' }), false);
  assert.equal(await app.S.addWealthTransaction({ id: 'bad-date', type: 'expense', accountId: 'bank', category: 'Food', amount: 10, date: '2026-02-30', note: '' }), false);
  assert.equal(await app.S.addWealthTransaction({ id: 'bad-amount', type: 'expense', accountId: 'bank', category: 'Food', amount: '12abc', date: '2026-08-26', note: '' }), false);
  assert.equal(app.S.setWealthBudget('Unknown', 100), false);
  assert.equal(await app.S.addWealthTransaction({ id: 'valid-expense', type: 'expense', accountId: 'bank', category: 'Food', amount: 10, date: '2026-08-26', note: '' }), true);
  assert.equal(app.S.delWealthAccount('bank'), false);
  assert.equal(app.S.delWealthTransaction('valid-expense'), true);
  assert.equal(app.S.delWealthAccount('bank'), true);
});

test('data backups rotate and corrupted primary data recovers from both backup slots', async () => {
  const app = loadApp();
  const directory = createDirectory();
  app.DM.dirHandle = directory;
  app.DM.fallback = true;
  app.S.s('pvp_tasks', [{ id: 'v1', title: 'Version one', date: '2026-08-26', done: false, subtasks: [] }]);
  app.DM.fallback = false;
  assert.equal(await app.DM._doSave(), true);

  app.DM.fallback = true;
  app.S.s('pvp_tasks', [{ id: 'v2', title: 'Version two', date: '2026-08-27', done: false, subtasks: [] }]);
  app.DM.fallback = false;
  assert.equal(await app.DM._doSave(), true);
  app.DM.fallback = true;
  app.S.s('pvp_tasks', [{ id: 'v3', title: 'Version three', date: '2026-08-28', done: false, subtasks: [] }]);
  app.DM.fallback = false;
  assert.equal(await app.DM._doSave(), true);

  assert.ok(directory.files.has('outline-data.backup.json'));
  assert.ok(directory.files.has('outline-data.backup.previous.json'));

  directory.files.set('outline-data.json', '{corrupt');
  const recoveredLatest = await app.DM.load();
  assert.equal(recoveredLatest.tasks[0].id, 'v2');

  directory.files.set('outline-data.backup.json', '{also corrupt');
  const recoveredPrevious = await app.DM.load();
  assert.equal(recoveredPrevious.tasks[0].id, 'v1');
});

test('fallback storage keeps rotating backups and restores them', () => {
  const app = loadApp();
  app.DM.fallback = true;
  app.S.sSilent('pvp_tasks', [{ id: 'fallback-1', title: 'Keep me', date: '2026-08-26', done: false, subtasks: [] }]);
  app.DM.saveFallbackBackup();
  app.S.sSilent('pvp_tasks', [{ id: 'fallback-2', title: 'Second copy', date: '2026-08-26', done: false, subtasks: [] }]);
  app.DM.saveFallbackBackup();
  app.storage.setItem('pvp_tasks', JSON.stringify([]));
  assert.equal(app.DM.restoreFallbackBackup(), true);
  assert.equal(JSON.parse(app.storage.getItem('pvp_tasks'))[0].id, 'fallback-2');
  assert.ok(app.storage.getItem('pvp_fallback_backup_previous'));
});
