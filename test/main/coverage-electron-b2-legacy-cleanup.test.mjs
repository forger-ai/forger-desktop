import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BUILT_IN_CONNECTION_TYPES } = require('../../dist-electron/shared/connection-catalog.js');
const { cleanupLegacyExternalToolState } = require('../../dist-electron/main/legacy-external-tools-cleanup.js');

const createRoot = async (t, label) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), `forger-coverage-b2-${label}-`));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  return root;
};

const successfulSecretsStore = {
  deleteToolSecrets: async () => ({ success: true, userMessage: 'deleted' }),
};

test('legacy cleanup is idempotent for absent, empty, and structurally invalid registry sections', async (t) => {
  const root = await createRoot(t, 'legacy-idempotent');
  await cleanupLegacyExternalToolState({ metadataRoot: root, secretsStore: successfulSecretsStore });

  const registryPath = path.join(root, 'official-tools.json');
  const unchanged = JSON.stringify({
    version: 1,
    installed: { local_tool: { id: 'local_tool' } },
    appGrants: { app: { local_tool: true }, malformed: null },
  });
  await fs.writeFile(registryPath, unchanged, 'utf8');
  await cleanupLegacyExternalToolState({ metadataRoot: root, secretsStore: successfulSecretsStore });
  assert.equal(await fs.readFile(registryPath, 'utf8'), unchanged);

  const invalidSections = JSON.stringify({ installed: [], appGrants: 'invalid' });
  await fs.writeFile(registryPath, invalidSections, 'utf8');
  await cleanupLegacyExternalToolState({ metadataRoot: root, secretsStore: successfulSecretsStore });
  assert.equal(await fs.readFile(registryPath, 'utf8'), invalidSections);

  await fs.writeFile(registryPath, 'null', 'utf8');
  await cleanupLegacyExternalToolState({ metadataRoot: root, secretsStore: successfulSecretsStore });
  assert.equal(await fs.readFile(registryPath, 'utf8'), 'null');
});

test('legacy cleanup rejects unreadable registry content instead of overwriting it', async (t) => {
  const root = await createRoot(t, 'legacy-invalid-json');
  await fs.writeFile(path.join(root, 'official-tools.json'), '{invalid-json', 'utf8');
  await assert.rejects(
    cleanupLegacyExternalToolState({ metadataRoot: root, secretsStore: successfulSecretsStore }),
    SyntaxError,
  );
});

test('legacy cleanup logs secret and metadata deletion failures without aborting other connectors', async (t) => {
  const root = await createRoot(t, 'legacy-failures');
  const logs = [];
  const originalRm = fs.rm;
  fs.rm = async (targetPath, options) => {
    const toolId = path.basename(String(targetPath));
    if (toolId === BUILT_IN_CONNECTION_TYPES[0]) throw new Error('metadata_denied');
    if (toolId === BUILT_IN_CONNECTION_TYPES[1]) throw 'metadata_unknown';
    return await originalRm(targetPath, options);
  };
  try {
    await cleanupLegacyExternalToolState({
      metadataRoot: root,
      secretsStore: {
        deleteToolSecrets: async (toolId) => {
          if (toolId === BUILT_IN_CONNECTION_TYPES[0]) throw new Error('secret_denied');
          if (toolId === BUILT_IN_CONNECTION_TYPES[1]) throw 'secret_unknown';
          return { success: true, userMessage: 'deleted' };
        },
      },
      appendLog: async (event, payload = {}) => {
        logs.push([event, payload]);
      },
    });
  } finally {
    fs.rm = originalRm;
  }

  assert.deepEqual(logs.filter(([event]) => event.endsWith('secret_delete_failed')).map(([, payload]) => payload.message).sort(), [
    'secret_denied',
    'unknown_error',
  ]);
  assert.deepEqual(logs.filter(([event]) => event.endsWith('metadata_delete_failed')).map(([, payload]) => payload.message).sort(), [
    'metadata_denied',
    'unknown_error',
  ]);
});

test('legacy cleanup atomically prunes old grants and tolerates chmod failures after the rename', async (t) => {
  const root = await createRoot(t, 'legacy-prune');
  const registryPath = path.join(root, 'official-tools.json');
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    installed: { gmail: { id: 'gmail' }, local_tool: { id: 'local_tool' } },
    appGrants: { app: { gmail: true, local_tool: true } },
  }), 'utf8');
  const logs = [];
  const originalChmod = fs.chmod;
  fs.chmod = async () => {
    throw new Error('chmod_unavailable');
  };
  try {
    await cleanupLegacyExternalToolState({
      metadataRoot: root,
      secretsStore: successfulSecretsStore,
      appendLog: async (event, payload = {}) => {
        logs.push([event, payload]);
      },
    });
  } finally {
    fs.chmod = originalChmod;
  }

  assert.deepEqual(JSON.parse(await fs.readFile(registryPath, 'utf8')), {
    version: 1,
    installed: { local_tool: { id: 'local_tool' } },
    appGrants: { app: { local_tool: true } },
  });
  assert.deepEqual(logs, [['legacy_external_tools_cleanup:registry_pruned', {}]]);
});
