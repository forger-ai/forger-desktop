import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deriveAppExecutionState, withAppExecutionState } = require('../../dist-electron/shared/app-execution-state.js');

test('shared app execution derivation covers app, share, starting, and error states', () => {
  assert.deepEqual(deriveAppExecutionState({ status: 'installed' }), {
    phase: 'stopped',
    mode: null,
    connectMode: null,
  });
  assert.deepEqual(deriveAppExecutionState({ status: 'installing' }), {
    phase: 'starting',
    mode: 'forger',
    connectMode: null,
  });
  assert.deepEqual(deriveAppExecutionState({ status: 'running' }), {
    phase: 'running',
    mode: 'forger',
    connectMode: null,
  });
  assert.deepEqual(deriveAppExecutionState({
    status: 'installed',
    localNetworkShare: { active: true, appId: 'finance-os' },
  }), {
    phase: 'running',
    mode: 'local_network',
    connectMode: 'local_network',
  });
  assert.deepEqual(deriveAppExecutionState({
    status: 'running',
    localNetworkShare: { active: true, appId: 'finance-os' },
    remoteNetworkShare: { active: true, appId: 'finance-os', state: 'waiting_for_session' },
  }), {
    phase: 'running',
    mode: 'remote_tunnel',
    connectMode: 'remote_tunnel',
  });
  assert.deepEqual(deriveAppExecutionState({
    status: 'installed',
    remoteNetworkShare: { active: true, appId: 'finance-os', state: 'preparing' },
  }), {
    phase: 'starting',
    mode: 'remote_tunnel',
    connectMode: 'remote_tunnel',
  });
  assert.deepEqual(deriveAppExecutionState({
    status: 'conflict',
  }), {
    phase: 'error',
    mode: null,
    connectMode: null,
  });
});

test('shared app execution helper writes the public contract fields', () => {
  assert.deepEqual(withAppExecutionState({
    id: 'finance-os',
    name: 'Finance OS',
    description: 'Money',
    category: 'finance',
    status: 'running',
  }), {
    id: 'finance-os',
    name: 'Finance OS',
    description: 'Money',
    category: 'finance',
    status: 'running',
    executionPhase: 'running',
    executionMode: 'forger',
    connectMode: null,
  });
});
