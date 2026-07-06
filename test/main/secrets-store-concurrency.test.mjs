import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';

const tmpRoot = async () => await fs.mkdtemp(path.join(os.tmpdir(), 'forger-secrets-concurrency-'));

const createSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8').replace(/^sealed:/, ''),
});

test('SecretsStore preserves concurrent connection secret writes', async (t) => {
  const root = await tmpRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/secrets-store.js');
    const { SecretsStore } = require('../../dist-electron/main/secrets-store.js');
    const store = new SecretsStore(root);
    const writes = Array.from({ length: 24 }, (_, index) => ({
      connectionId: `connection-${index % 6}`,
      secretName: `secret-${index}`,
      value: `value-${index}`,
    }));

    const results = await Promise.all(
      writes.map((entry) => store.setConnectionSecret(entry.connectionId, entry.secretName, entry.value)),
    );

    assert.deepEqual(results.map((result) => result.success), writes.map(() => true));
    for (const entry of writes) {
      assert.equal(await store.getConnectionSecret(entry.connectionId, entry.secretName), entry.value);
    }
    const files = await fs.readdir(root);
    assert.deepEqual(files.filter((file) => file.endsWith('.tmp')), []);
  });
});
