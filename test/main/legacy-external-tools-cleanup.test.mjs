import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  cleanupLegacyExternalToolState,
} = require('../../dist-electron/main/legacy-external-tools-cleanup.js');

test('legacy external tool cleanup deletes only external official-tool state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-legacy-external-cleanup-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'official-tools', 'gmail'), { recursive: true });
  await mkdir(join(root, 'official-tools', 'whatsapp'), { recursive: true });
  await mkdir(join(root, 'official-tools', 'forger_chrome_extension'), { recursive: true });
  await mkdir(join(root, 'connections', 'whatsapp', 'connection-1'), { recursive: true });
  await writeFile(join(root, 'official-tools', 'gmail', 'index.json'), '{}', 'utf8');
  await writeFile(join(root, 'connections.json'), JSON.stringify({ version: 1, instances: { 'connection-1': { id: 'connection-1', type: 'whatsapp' } } }), 'utf8');
  await writeFile(join(root, 'official-tools.json'), JSON.stringify({
    version: 1,
    installed: {
      gmail: { id: 'gmail' },
      whatsapp: { id: 'whatsapp' },
      forger_chrome_extension: { id: 'forger_chrome_extension' },
    },
    appGrants: {
      'finance-os': {
        gmail: true,
        whatsapp: true,
        forger_chrome_extension: true,
      },
    },
  }, null, 2), 'utf8');

  const deletedToolSecrets = [];
  await cleanupLegacyExternalToolState({
    metadataRoot: root,
    secretsStore: {
      deleteToolSecrets: async (toolId) => {
        deletedToolSecrets.push(toolId);
        return { success: true, userMessage: 'ok' };
      },
    },
  });

  const registry = JSON.parse(await readFile(join(root, 'official-tools.json'), 'utf8'));
  assert.deepEqual(registry.installed, {
    forger_chrome_extension: { id: 'forger_chrome_extension' },
  });
  assert.deepEqual(registry.appGrants, {
    'finance-os': {
      forger_chrome_extension: true,
    },
  });
  assert.equal(deletedToolSecrets.includes('gmail'), true);
  assert.equal(deletedToolSecrets.includes('whatsapp'), true);
  assert.equal(deletedToolSecrets.includes('forger_chrome_extension'), false);
  await assert.rejects(readFile(join(root, 'official-tools', 'gmail', 'index.json'), 'utf8'), /ENOENT/);
  assert.equal(await readFile(join(root, 'connections.json'), 'utf8'), JSON.stringify({ version: 1, instances: { 'connection-1': { id: 'connection-1', type: 'whatsapp' } } }));
  assert.equal(await readFile(join(root, 'official-tools.json'), 'utf8').then((raw) => raw.includes('forger_chrome_extension')), true);
});
