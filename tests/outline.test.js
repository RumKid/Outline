import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const appScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
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
  const document = {
    addEventListener() {},
    getElementById() { return null; },
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
  vm.runInContext(`${appScript}\nthis.__outline = { S, DM, Auth, DATA_SCHEMA_VERSION, dateKey, today, addDays, thisWeek };`, context);
  return { ...context.__outline, storage };
}

test('local date helpers use the local calendar date', () => {
  const { dateKey, addDays, thisWeek } = loadApp();
  const localDate = new Date(2026, 7, 26, 23, 45);

  assert.equal(dateKey(localDate), '2026-08-26');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(thisWeek().length, 7);
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
