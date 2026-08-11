import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const memoryModulePath = require.resolve('../../dist-electron/main/memory-store.js');
const optionalSqlite = require('../../dist-electron/main/runtime/optional-better-sqlite.js');
const { MemoryStore } = require(memoryModulePath);

const createRoot = async () => await fs.mkdtemp(path.join(os.tmpdir(), 'forger-memory-b18-'));

test('given rich memories, filters, scope transitions, evidence, revisions, usage, maintenance, and deletion persist together', async () => {
  const root = await createRoot();
  const store = new MemoryStore(root);
  try {
    assert.throws(() => store.requireDb(), /memory_store_not_loaded/);
    const global = await store.create({
      scope: 'global', kind: 'fact', title: ' Global title ', body: ' Global body ',
      read_when: ' when relevant ', status: 'candidate', source: 'settings', evidence: ' source excerpt ',
    }, { caller: 'free-chat' });
    const app = await store.create({
      scope: 'app', appId: ' finance-os ', kind: 'constraint', text: 'App body',
      readWhen: '', status: 'archived', source: 'agent',
    }, { caller: 'app-agent', appId: 'finance-os' });
    const appWithoutId = await store.create({ scope: 'app', appId: ' ', text: 'Unassigned app memory' });
    await store.create({ scope: 'global', text: 'Automation global' }, { caller: 'automation' });
    await store.create({ scope: 'global', text: 'Non-string evidence', evidence: 9 });
    await assert.rejects(
      () => store.create({ scope: 'app', appId: ' ', text: 'Missing app' }, { caller: 'automation', appIds: [] }),
      /memory_app_required/,
    );
    await assert.rejects(
      () => store.create({ scope: 'app', appId: 'other', text: 'Wrong app' }, { caller: 'app-agent', appId: 'finance-os' }),
      /memory_scope_forbidden/,
    );
    await assert.rejects(
      () => store.update({ id: app.id, text: 'Forbidden before mutation' }, { caller: 'app-agent', appId: 'other' }),
      /memory_scope_forbidden/,
    );
    await assert.rejects(
      () => store.update({ id: app.id, text: 'Automation lacks grants' }, { caller: 'automation' }),
      /memory_scope_forbidden/,
    );

    assert.equal((await store.list({ scope: 'global' })).length, 3);
    assert.deepEqual((await store.list({ appId: 'finance-os', kind: 'constraint', status: 'archived' })).map((item) => item.id), [app.id]);
    assert.deepEqual(await store.list({ scope: 'app', appId: 'missing' }), []);
    assert.equal((await store.list({}, { caller: 'desktop-chat' })).length, 5);
    assert.equal((await store.list({}, { caller: 'app-agent' })).every((item) => item.scope === 'global'), true);
    assert.equal((await store.list({}, { caller: 'automation' })).every((item) => item.scope === 'global'), true);
    assert.equal((await store.update({ id: app.id, status: 'active' }, { caller: 'app-agent', appId: 'finance-os' })).appId, 'finance-os');
    assert.throws(() => store.assertCanWrite(app, { caller: 'automation' }), /memory_scope_forbidden/);
    assert.equal((await store.list({ status: 'archived' })).length, 0);

    const moved = await store.update({
      id: global.id, scope: 'app', appId: 'finance-os', kind: 'workflow', title: ' ',
      body: 'Updated body', read_when: ' only on request ', status: 'active', evidence: ' ',
    }, { caller: 'settings' });
    assert.equal(moved.scope, 'app');
    assert.equal(moved.appId, 'finance-os');
    assert.equal(moved.title, 'Updated body');
    assert.equal(moved.evidence.length, 1, 'blank update evidence does not add a row');
    assert.equal(moved.revisions.length, 1);
    assert.equal(moved.revisions[0].scope, 'global');

    const restoredGlobal = await store.update({ id: moved.id, scope: 'global' }, { caller: 'desktop-chat' });
    assert.equal(restoredGlobal.appId, undefined);
    const context = await store.buildContext({ caller: 'free-chat', appId: 'finance-os', runId: 'run-1' }, 10_000);
    assert.match(context, /Automation global/);
    assert.match(context, new RegExp(`${appWithoutId.title} \\[app/`));
    const withUsage = (await store.list()).find((item) => item.id === restoredGlobal.id);
    assert.equal(withUsage.usage[0].caller, 'free-chat');
    assert.equal(withUsage.usage[0].appId, 'finance-os');
    assert.equal(withUsage.usage[0].runId, 'run-1');
    assert.equal(withUsage.usage[0].reason, 'registered');

    await store.recordMaintenanceRun({ status: 'succeeded', summary: ' compacted ', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T01:00:00.000Z' });
    await store.recordMaintenanceRun({ id: 'maintenance', status: 'skipped', summary: 9 });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM memory_maintenance_runs').get().count, 2);

    assert.deepEqual(await store.delete(restoredGlobal.id, { caller: 'free-chat' }), { success: true });
    assert.deepEqual(await store.delete(restoredGlobal.id), { success: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('given raw audit rows, entry reads normalize unknown callers, sources, kinds, statuses, and optional fields', async () => {
  const root = await createRoot();
  const store = new MemoryStore(root);
  try {
    const entry = await store.create({ scope: 'app', appId: 'app', text: 'Body' });
    const now = '2026-01-01T00:00:00.000Z';
    store.db.prepare('INSERT INTO memory_evidence (id, memory_id, source, excerpt, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('evidence', entry.id, 'unknown', 'Raw evidence', now);
    store.db.prepare('INSERT INTO memory_usage_events (id, memory_id, caller, app_id, run_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('usage', entry.id, 'unknown', null, null, null, now);
    store.db.prepare('INSERT INTO memory_revisions (id, memory_id, title, body, read_when, kind, scope, app_id, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('revision', entry.id, 'Old', 'Old body', '', 'unknown', 'app', 'app', 'unknown', 'unknown', now);
    const loaded = (await store.list({ appId: 'app' }))[0];
    assert.equal(loaded.evidence[0].source, 'user');
    assert.deepEqual(loaded.usage[0], { id: 'usage', memoryId: entry.id, caller: 'settings', createdAt: now });
    assert.equal(loaded.revisions[0].kind, 'preference');
    assert.equal(loaded.revisions[0].scope, 'app');
    assert.equal(loaded.revisions[0].appId, 'app');
    assert.equal(loaded.revisions[0].status, 'active');
    assert.equal(loaded.revisions[0].source, 'user');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('given diverse legacy JSON, migration accepts only safe rows, supplies defaults, and is idempotent', async () => {
  const root = await createRoot();
  try {
    await fs.writeFile(path.join(root, 'memory.json'), JSON.stringify({
      entries: [
        null,
        'bad',
        { kind: 'bad', scope: 'global', text: 'bad kind' },
        { kind: 'fact', scope: 'bad', text: 'bad scope' },
        { kind: 'fact', scope: 'global', text: ' ' },
        { kind: 'fact', scope: 'global', body: 'First\nline', title: '', readWhen: 9, status: 'bad', source: 'bad' },
        { id: 'legacy-app', kind: 'workflow', scope: 'app', appId: ' app ', text: 'App legacy', createdAt: '2020-01-01', updatedAt: '2020-01-02' },
      ],
    }));
    const store = new MemoryStore(root);
    const migrated = await store.list();
    assert.equal(migrated.length, 2);
    assert.equal(migrated.some((item) => item.id === 'legacy-app' && item.appId === 'app'), true);
    assert.equal(migrated.find((item) => item.id !== 'legacy-app').title, 'First');
    store.loadPromise = null;
    await store.load();
    assert.equal((await store.list()).length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('given legacy JSON without an entries collection, transactional migration records completion without inventing rows', async () => {
  const root = await createRoot();
  try {
    await fs.writeFile(path.join(root, 'memory.json'), '{}');
    const store = new MemoryStore(root);
    assert.deepEqual(await store.list(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('given a SQLite adapter without transactions, legacy migration commits success and rolls back an insert failure', async () => {
  for (const shouldFail of [false, true]) {
    const root = await createRoot();
    try {
      await fs.writeFile(path.join(root, 'memory.json'), JSON.stringify(shouldFail
        ? { entries: [{ kind: 'fact', scope: 'global', text: 'Legacy' }] }
        : {}));
      const execs = [];
      const inserts = [];
      const db = {
        exec(sql) { execs.push(sql); },
        prepare(sql) {
          return {
            get: () => undefined,
            run(...args) {
              if (sql.includes('INSERT OR IGNORE')) {
                if (shouldFail) throw new Error('insert_failed');
                inserts.push(args[0]);
              }
            },
            all: () => [],
          };
        },
      };
      const store = new MemoryStore(root);
      store.db = db;
      await store.migrateLegacyJson();
      assert.equal(execs.includes('BEGIN'), true);
      assert.equal(execs.includes(shouldFail ? 'ROLLBACK' : 'COMMIT'), true);
      assert.equal(inserts.length, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('given native SQLite loading failures, fallback warning suppression, forwarding, absence, and require errors stay deterministic', () => {
  const originalLoad = optionalSqlite.loadOptionalBetterSqlite;
  const originalModuleLoad = Module._load;
  const originalEmitWarning = process.emitWarning;
  const originalWarn = console.warn;
  const forwarded = [];
  const warnings = [];
  try {
    delete require.cache[memoryModulePath];
    optionalSqlite.loadOptionalBetterSqlite = () => class BrokenSqlite { constructor() { throw new Error('native mismatch'); } };
    process.emitWarning = (...args) => forwarded.push(args);
    console.warn = (...args) => warnings.push(args.join(' '));
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'node:sqlite') {
        process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
        process.emitWarning(new Error('forward me'), 'CustomWarning');
        process.emitWarning('forward without string type', { code: 'CUSTOM' });
        return { DatabaseSync: class FakeDatabase { constructor(filename) { this.filename = filename; } } };
      }
      return originalModuleLoad.call(this, request, parent, isMain);
    };
    const ReloadedStore = require(memoryModulePath).MemoryStore;
    const fallback = new ReloadedStore(path.join(os.tmpdir(), 'forger-memory-fallback'));
    assert.match(fallback.openSqliteDatabase().filename, /memory\.sqlite$/);
    assert.equal(warnings.some((message) => message.includes('native mismatch')), true);
    assert.equal(forwarded.length, 2);
    fallback.openSqliteDatabase();
    assert.equal(warnings.length, 1, 'fallback warning is emitted once per module lifecycle');

    Module._load = function missingDatabase(request, parent, isMain) {
      if (request === 'node:sqlite') return {};
      return originalModuleLoad.call(this, request, parent, isMain);
    };
    optionalSqlite.loadOptionalBetterSqlite = () => null;
    assert.equal(fallback.openSqliteDatabase(), null);

    delete require.cache[memoryModulePath];
    optionalSqlite.loadOptionalBetterSqlite = () => null;
    Module._load = function missingDatabaseFresh(request, parent, isMain) {
      if (request === 'node:sqlite') return {};
      return originalModuleLoad.call(this, request, parent, isMain);
    };
    const NoNativeStore = require(memoryModulePath).MemoryStore;
    assert.equal(new NoNativeStore(path.join(os.tmpdir(), 'forger-memory-no-native')).openSqliteDatabase(), null);

    delete require.cache[memoryModulePath];
    optionalSqlite.loadOptionalBetterSqlite = () => class StringFailure { constructor() { throw 'native string failure'; } };
    const StringFailureStore = require(memoryModulePath).MemoryStore;
    assert.equal(new StringFailureStore(path.join(os.tmpdir(), 'forger-memory-string-failure')).openSqliteDatabase(), null);
    Module._load = function throwingRequire(request, parent, isMain) {
      if (request === 'node:sqlite') throw new Error('module missing');
      return originalModuleLoad.call(this, request, parent, isMain);
    };
    assert.equal(fallback.openSqliteDatabase(), null);
  } finally {
    optionalSqlite.loadOptionalBetterSqlite = originalLoad;
    Module._load = originalModuleLoad;
    process.emitWarning = originalEmitWarning;
    console.warn = originalWarn;
    delete require.cache[memoryModulePath];
    require(memoryModulePath);
  }
});

test('given SQLite cannot be opened, loading fails explicitly instead of operating with an uninitialized store', async () => {
  const root = await createRoot();
  const store = new MemoryStore(root);
  store.openSqliteDatabase = () => null;
  try {
    await assert.rejects(() => store.loadFromDisk(), /memory_sqlite_unavailable/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
