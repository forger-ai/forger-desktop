import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPublishedAppInfoUpdater } = require('../../dist-electron/main/core/main-lifecycle-mcp-handlers.js');

const createState = ({ backendClient, apps = {} } = {}) => ({
  forgerBackendClient: backendClient ?? null,
  registry: { apps },
});

test('published app info rejects updates when the backend capability or publication target is unavailable', async () => {
  const missingClient = createPublishedAppInfoUpdater(createState());
  assert.deepEqual(await missingClient({ userAppId: 41 }), {
    success: false,
    userMessage: 'No pudimos actualizar la informacion publicada de esta app.',
    technicalCode: 'backend_client_missing',
  });

  const missingMethod = createPublishedAppInfoUpdater(createState({ backendClient: {} }));
  assert.equal((await missingMethod({ userAppId: 41 })).technicalCode, 'backend_client_missing');

  const updateSocialApp = async () => ({ id: 41 });
  const missingTarget = createPublishedAppInfoUpdater(createState({ backendClient: { updateSocialApp } }));
  assert.equal((await missingTarget({})).technicalCode, 'published_app_target_not_found');
  assert.equal((await missingTarget({ appId: 'missing-app' })).technicalCode, 'published_app_target_not_found');
  assert.equal((await missingTarget({ userAppId: 0 })).technicalCode, 'published_app_target_not_found');
});

test('published app info resolves direct, published, and legacy Social targets and forwards only requested fields', async () => {
  const updates = [];
  const updateSocialApp = async (input) => {
    updates.push(input);
    return { id: input.id, name: input.name ?? 'Existing name' };
  };
  const state = createState({
    backendClient: { updateSocialApp },
    apps: {
      published: { publishedSocialSource: { userAppId: 51 }, socialSource: { userAppId: 52 } },
      legacy: { socialSource: { userAppId: 61 } },
    },
  });
  const update = createPublishedAppInfoUpdater(state);

  const direct = await update({
    userAppId: 41,
    visibility: 'public',
    name: 'Finance',
    shortDescription: 'Short',
    description: 'Description',
    longDescription: 'Long description',
    category: 'finance',
  });
  assert.deepEqual(updates[0], {
    id: 41,
    visibility: 'public',
    name: 'Finance',
    shortDescription: 'Short',
    description: 'Description',
    longDescription: 'Long description',
    category: 'finance',
  });
  assert.deepEqual(direct, {
    success: true,
    app: { id: 41, name: 'Finance' },
    userMessage: 'Informacion publicada actualizada.',
  });

  await update({ appId: 'published' });
  await update({ appId: 'legacy' });
  assert.deepEqual(updates.slice(1), [{ id: 51 }, { id: 61 }]);
});

test('published app info reports backend Error messages without exposing non-Error values', async () => {
  const errors = [new Error('backend_unavailable'), 'raw-provider-failure'];
  const update = createPublishedAppInfoUpdater(createState({
    backendClient: {
      updateSocialApp: async () => {
        throw errors.shift();
      },
    },
  }));

  assert.equal((await update({ userAppId: 71 })).technicalCode, 'backend_unavailable');
  assert.equal((await update({ userAppId: 71 })).technicalCode, 'published_app_info_update_failed');
});
