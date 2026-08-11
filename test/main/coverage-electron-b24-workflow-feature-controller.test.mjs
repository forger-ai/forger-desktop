import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { WorkflowFeatureController } = require('../../dist-electron/main/workflow-feature-controller.js');

const manager = (overrides = {}) => ({ initialize: async () => undefined, dispose: async () => undefined, ...overrides });

test('workflow feature controller serializes duplicate enablement and supports idempotent gates', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const instance = manager({ initialize: async () => await gate });
  const changes = [];
  const controller = new WorkflowFeatureController({
    createManager: () => instance,
    persistEnabled: async () => undefined,
    onManagerChanged: (value) => changes.push(value),
  });
  await controller.initialize();
  assert.throws(() => controller.requireManager(), /workflow_feature_disabled/);
  const first = controller.enable();
  const duplicate = controller.enable();
  assert.equal(first, duplicate);
  release();
  assert.equal(await first, instance);
  assert.equal(controller.requireManager(), instance);
  assert.equal(await controller.enable(), instance);
  await controller.disable();
  await controller.disable();
  await controller.dispose();
  assert.deepEqual(changes, [instance, null]);
});

test('workflow feature controller restores the gate on preference failure and preserves rollback causes', async () => {
  const restored = manager();
  const changes = [];
  let failDisable = true;
  const controller = new WorkflowFeatureController({
    initialEnabled: true,
    createManager: () => restored,
    persistEnabled: async (enabled) => {
      if (!enabled && failDisable) throw new Error('persist false failed');
    },
    onManagerChanged: (value) => changes.push(value),
  });
  await controller.initialize();
  await assert.rejects(controller.disable(), /persist false failed/);
  assert.equal(controller.requireManager(), restored);
  failDisable = false;
  restored.dispose = async () => { throw new Error('dispose failed'); };
  await assert.rejects(controller.disable(), /dispose failed/);

  for (const failure of ['initialize failed', 'persist true failed']) {
    const rollback = manager({
      initialize: async () => {
        if (failure.startsWith('initialize')) throw new Error(failure);
      },
      dispose: async () => { throw new Error('rollback failed'); },
    });
    const broken = new WorkflowFeatureController({
      createManager: () => rollback,
      persistEnabled: async () => {
        if (failure.startsWith('persist')) throw new Error(failure);
      },
    });
    await assert.rejects(broken.enable(), new RegExp(failure));
  }

  const cleanRollback = new WorkflowFeatureController({
    createManager: () => manager({ initialize: async () => { throw new Error('clean rollback'); } }),
  });
  await assert.rejects(cleanRollback.enable(), /clean rollback/);

  const disposable = manager({ dispose: async () => { throw new Error('final dispose failed'); } });
  const final = new WorkflowFeatureController({ initialEnabled: true, createManager: () => disposable });
  await final.initialize();
  await assert.rejects(final.dispose(), /final dispose failed/);

  const clean = new WorkflowFeatureController({ initialEnabled: true, createManager: () => manager() });
  await clean.initialize();
  await clean.dispose();
});
