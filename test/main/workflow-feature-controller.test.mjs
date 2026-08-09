import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

const loadController = () => {
  const resolved = require.resolve('../../dist-electron/main/workflow-feature-controller.js');
  delete require.cache[resolved];
  return require(resolved).WorkflowFeatureController;
};

test('workflows v1 is off by default and rejects manager access while disabled', () => {
  const WorkflowFeatureController = loadController();
  let createCalls = 0;
  const controller = new WorkflowFeatureController({
    createManager: () => {
      createCalls += 1;
      return { initialize: async () => undefined, dispose: () => undefined };
    },
  });

  assert.equal(controller.isEnabled(), false);
  assert.equal(controller.getManager(), null);
  assert.equal(createCalls, 0);
  assert.throws(() => controller.requireManager(), { message: 'workflow_feature_disabled' });
});

test('startup initialization restores workflows without recalculating persisted schedules', async () => {
  const WorkflowFeatureController = loadController();
  const initializeCalls = [];
  const persisted = [];
  const manager = {
    initialize: async (options) => {
      initializeCalls.push(options);
    },
    dispose: () => undefined,
  };
  const controller = new WorkflowFeatureController({
    initialEnabled: true,
    createManager: () => manager,
    persistEnabled: async (enabled) => {
      persisted.push(enabled);
    },
  });

  await controller.initialize();

  assert.equal(controller.isEnabled(), true);
  assert.equal(controller.getManager(), manager);
  assert.deepEqual(initializeCalls, [undefined], 'normal startup keeps the persisted missed-run policy');
  assert.deepEqual(persisted, [], 'startup does not rewrite the stored opt-in');
});

test('every runtime enable recalculates schedules from reactivation time', async () => {
  const WorkflowFeatureController = loadController();
  const initializeCalls = [];
  const persisted = [];
  let managerId = 0;
  const controller = new WorkflowFeatureController({
    createManager: () => {
      const id = ++managerId;
      return {
        initialize: async (options) => {
          initializeCalls.push({ id, options });
        },
        dispose: () => undefined,
      };
    },
    persistEnabled: async (enabled) => {
      persisted.push(enabled);
    },
  });

  await controller.enable();
  await controller.disable();
  await controller.enable();

  assert.deepEqual(initializeCalls, [
    { id: 1, options: { recalculateSchedulesFromNow: true } },
    { id: 2, options: { recalculateSchedulesFromNow: true } },
  ]);
  assert.deepEqual(persisted, [true, false, true]);
  assert.equal(controller.isEnabled(), true);
});

test('enabling workflows is idempotent and publishes one initialized manager', async () => {
  const WorkflowFeatureController = loadController();
  const lifecycle = [];
  const persisted = [];
  const published = [];
  const manager = {
    initialize: async () => {
      lifecycle.push('initialize');
    },
    dispose: () => {
      lifecycle.push('dispose');
    },
  };
  const controller = new WorkflowFeatureController({
    createManager: () => {
      lifecycle.push('create');
      return manager;
    },
    persistEnabled: async (enabled) => {
      persisted.push(enabled);
    },
    onManagerChanged: (nextManager) => {
      published.push(nextManager);
    },
  });

  const [first, second] = await Promise.all([controller.enable(), controller.enable()]);

  assert.equal(first, manager);
  assert.equal(second, manager);
  assert.equal(controller.isEnabled(), true);
  assert.equal(controller.getManager(), manager);
  assert.equal(controller.requireManager(), manager);
  assert.deepEqual(lifecycle, ['create', 'initialize']);
  assert.deepEqual(persisted, [true]);
  assert.deepEqual(published, [manager]);
});

test('disabling closes the gate before disposal and is idempotent', async () => {
  const WorkflowFeatureController = loadController();
  const persisted = [];
  const published = [];
  let disposeCalls = 0;
  let controller;
  const manager = {
    initialize: async () => undefined,
    dispose: async () => {
      disposeCalls += 1;
      assert.equal(controller.isEnabled(), false);
      assert.equal(controller.getManager(), null);
      assert.throws(() => controller.requireManager(), { message: 'workflow_feature_disabled' });
    },
  };
  controller = new WorkflowFeatureController({
    createManager: () => manager,
    persistEnabled: async (enabled) => {
      persisted.push(enabled);
    },
    onManagerChanged: (nextManager) => {
      published.push(nextManager);
    },
  });

  await controller.enable();
  await Promise.all([controller.disable(), controller.disable()]);

  assert.equal(controller.isEnabled(), false);
  assert.equal(controller.getManager(), null);
  assert.equal(disposeCalls, 1);
  assert.deepEqual(persisted, [true, false]);
  assert.deepEqual(published, [manager, null]);
});

test('dispose closes the runtime without changing the persisted opt-in', async () => {
  const WorkflowFeatureController = loadController();
  const persisted = [];
  let disposeCalls = 0;
  const controller = new WorkflowFeatureController({
    createManager: () => ({
      initialize: async () => undefined,
      dispose: () => {
        disposeCalls += 1;
      },
    }),
    persistEnabled: async (enabled) => {
      persisted.push(enabled);
    },
  });

  await controller.enable();
  persisted.length = 0;
  await Promise.all([controller.dispose(), controller.dispose()]);

  assert.equal(controller.isEnabled(), false);
  assert.equal(controller.getManager(), null);
  assert.equal(disposeCalls, 1);
  assert.deepEqual(persisted, []);
  assert.throws(() => controller.requireManager(), { message: 'workflow_feature_disabled' });
});
