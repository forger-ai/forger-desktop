import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collectLocalHardware } = require('../../dist-electron/main/local-development/hardware.js');

const platform = (overrides = {}) => ({
  platform: () => 'darwin', arch: () => 'arm64', release: () => 'test-release',
  cpus: () => [{ model: 'Apple M1' }, { model: 'Apple M1' }],
  totalmem: () => 8 * 1024 ** 3, freemem: () => 512 * 1024 ** 2,
  ...overrides,
});

test('hardware observation keeps unified memory, free bytes and usable memory distinct', async () => {
  const result = await collectLocalHardware(os.tmpdir(), {
    system: platform(),
    disk: async () => ({ bavail: 7n, bsize: 4096n }),
    displays: async () => JSON.stringify({ SPDisplaysDataType: [{
      sppci_model: 'Apple M1', spdisplays_metal: 'spdisplays_metal3',
      spdisplays_vram: '8192 MB', serial_number: 'DO-NOT-COLLECT',
    }] }),
    now: () => '2026-09-26T12:00:00.000Z',
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.observedAt, '2026-09-26T12:00:00.000Z');
  assert.equal(result.memory.totalBytes, 8 * 1024 ** 3);
  assert.equal(result.memory.freeBytes, 512 * 1024 ** 2);
  assert.equal(result.memory.availableForModelBytes, null);
  assert.equal(result.memory.unified, true);
  assert.equal(result.disk.availableBytes, 7 * 4096);
  assert.equal(result.gpu.devices[0].name, 'Apple M1');
  assert.equal(result.gpu.devices[0].backendReported, 'metal');
  assert.equal(result.gpu.devices[0].usableMemoryBytes, null);
  assert.equal(result.gpu.accelerationTested, false);
  assert.equal(result.performance, null);
  assert.equal(result.recommendation.status, 'insufficient_evidence');
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-COLLECT|8192 MB/);
});

test('unavailable OS and GPU values remain unknown instead of becoming compatible hardware', async () => {
  const result = await collectLocalHardware(os.tmpdir(), {
    system: platform({ cpus: () => [], totalmem: () => 0, freemem: () => Number.NaN }),
    disk: async () => { throw new Error('private path or other sensitive details'); },
    displays: async () => { throw new Error('blocked'); },
  });
  assert.equal(result.cpu.logicalCores, null);
  assert.equal(result.memory.totalBytes, null);
  assert.equal(result.memory.freeBytes, null);
  assert.equal(result.memory.unified, null);
  assert.equal(result.disk.availableBytes, null);
  assert.equal(result.gpu.devices.length, 0);
  assert.equal(result.recommendation.status, 'insufficient_evidence');
  assert.ok(result.unavailable.includes('gpu_detection_failed'));
  assert.ok(result.unavailable.includes('disk_detection_failed'));
  assert.doesNotMatch(JSON.stringify(result), /private path/);
});

test('non-Apple ARM and desktop systems are not assumed to have usable GPU memory', async () => {
  for (const family of ['linux', 'win32']) {
    const result = await collectLocalHardware(os.tmpdir(), {
      system: platform({ platform: () => family, cpus: () => [{ model: 'Example CPU' }] }),
      disk: async () => ({ bavail: 0n, bsize: 4096n }),
      displays: async () => { throw new Error('must not probe Apple hardware'); },
    });
    assert.equal(result.memory.unified, null);
    assert.equal(result.disk.availableBytes, 0);
    assert.equal(result.gpu.accelerationTested, false);
    assert.ok(result.unavailable.includes('gpu_platform_probe_not_implemented'));
  }
});

test('malformed/empty GPU responses and implausible disk numbers are not performance data', async () => {
  for (const response of ['invalid-json', '{}', '{"SPDisplaysDataType":[null,{}]}']) {
    const result = await collectLocalHardware(os.tmpdir(), {
      system: platform(), disk: async () => ({ bavail: -1n, bsize: 4096n }),
      displays: async () => response,
    });
    assert.equal(result.gpu.devices.length, 0);
    assert.equal(result.disk.availableBytes, null);
    assert.equal(result.performance, null);
  }
});

test('macOS reports Metal support independently from a measured acceleration backend', async () => {
  for (const metal of ['spdisplays_supported', 'spdisplays_unsupported']) {
    const result = await collectLocalHardware(os.tmpdir(), {
      system: platform(), disk: async () => ({ bavail: 1n, bsize: 4096n }),
      displays: async () => JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M1', spdisplays_metal: metal }] }),
    });
    assert.equal(result.gpu.devices[0].backendReported, metal === 'spdisplays_supported' ? 'metal' : null);
    assert.equal(result.gpu.accelerationTested, false);
  }
});

test('real host observation reads disk and OS without inference or compatibility claims', async () => {
  const result = await collectLocalHardware(os.tmpdir(), { displays: async () => '{}' });
  const disk = await fs.statfs(os.tmpdir(), { bigint: true });
  assert.equal(result.os.platform, process.platform);
  assert.equal(result.os.architecture, process.arch);
  assert.equal(result.memory.totalBytes, os.totalmem());
  assert.equal(typeof result.disk.availableBytes, 'number');
  assert.ok(result.disk.availableBytes <= Number(disk.blocks * disk.bsize));
  assert.equal(result.recommendation.status, 'insufficient_evidence');
});
