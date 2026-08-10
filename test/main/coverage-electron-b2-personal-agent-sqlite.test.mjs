import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const optionalBetterSqlite = require('../../dist-electron/main/runtime/optional-better-sqlite.js');
const { openPersonalAgentSqliteDatabase } = require('../../dist-electron/main/personal-agents/sqlite.js');

const withSqliteDrivers = (loadBetterSqlite, loadNodeSqlite, callback) => {
  const originalBetterSqliteLoader = optionalBetterSqlite.loadOptionalBetterSqlite;
  const originalModuleLoad = Module._load;
  optionalBetterSqlite.loadOptionalBetterSqlite = loadBetterSqlite;
  Module._load = function loadWithNodeSqliteMock(request, parent, isMain) {
    if (request === 'node:sqlite') return loadNodeSqlite();
    return originalModuleLoad.apply(this, [request, parent, isMain]);
  };
  try {
    return callback();
  } finally {
    optionalBetterSqlite.loadOptionalBetterSqlite = originalBetterSqliteLoader;
    Module._load = originalModuleLoad;
  }
};

test('personal-agent sqlite prefers the native driver when it opens successfully', () => {
  class NativeDatabase {
    constructor(filename) {
      this.filename = filename;
    }
  }
  const database = withSqliteDrivers(
    () => NativeDatabase,
    () => {
      throw new Error('node_sqlite_should_not_load');
    },
    () => openPersonalAgentSqliteDatabase('native.sqlite'),
  );
  assert.equal(database.filename, 'native.sqlite');
});

test('personal-agent sqlite falls back from a broken native driver and filters only the known experimental warning', () => {
  class BrokenNativeDatabase {
    constructor() {
      throw new Error('native_driver_unavailable');
    }
  }
  class NodeDatabase {
    constructor(filename) {
      this.filename = filename;
    }
  }
  const realEmitWarning = process.emitWarning;
  const forwardedWarnings = [];
  process.emitWarning = (warning, ...args) => {
    forwardedWarnings.push([warning, ...args]);
  };
  let database;
  try {
    database = withSqliteDrivers(
      () => BrokenNativeDatabase,
      () => {
        process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
        process.emitWarning(new Error('visible object warning'), { detail: true });
        process.emitWarning('visible string warning', 'OtherWarning');
        return { DatabaseSync: NodeDatabase };
      },
      () => openPersonalAgentSqliteDatabase('fallback.sqlite'),
    );
  } finally {
    process.emitWarning = realEmitWarning;
  }

  assert.equal(database.filename, 'fallback.sqlite');
  assert.equal(forwardedWarnings.length, 2);
  assert.equal(forwardedWarnings[0][0].message, 'visible object warning');
  assert.equal(forwardedWarnings[1][0], 'visible string warning');
});

test('personal-agent sqlite returns null when node:sqlite has no driver or cannot be loaded', () => {
  assert.equal(withSqliteDrivers(
    () => null,
    () => ({}),
    () => openPersonalAgentSqliteDatabase('missing-driver.sqlite'),
  ), null);

  assert.equal(withSqliteDrivers(
    () => null,
    () => {
      throw new Error('node_sqlite_unavailable');
    },
    () => openPersonalAgentSqliteDatabase('unavailable.sqlite'),
  ), null);
});
