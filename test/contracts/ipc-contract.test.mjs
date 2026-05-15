import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');

test('IPC channels stay unique', () => {
  const channels = Object.values(IPC_CHANNELS);
  assert.equal(new Set(channels).size, channels.length);
});
