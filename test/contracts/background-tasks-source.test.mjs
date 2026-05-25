import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const readSource = async (relativePath) => await readFile(path.join(root, relativePath), 'utf8');

test('social upload is tracked as a background task instead of reusing app opening state', async () => {
  const controller = await readSource('src/renderer/app/RendererAppController.tsx');
  const uploadStart = controller.indexOf('const uploadSocialApp = async');
  const uploadEnd = controller.indexOf('const handleUploadSocial', uploadStart);
  const uploadSource = controller.slice(uploadStart, uploadEnd);

  assert.ok(uploadSource.includes('setBackgroundTasksDrawerOpen'), 'social upload should update background task state');
  assert.equal(uploadSource.includes('openingAppIdsRef.current'), false, 'social upload must not mark the app as opening');
});

test('automation updates are bridged into the background task history', async () => {
  const controller = await readSource('src/renderer/app/RendererAppController.tsx');

  assert.ok(controller.includes('upsertAutomationBackgroundTask'));
  assert.ok(controller.includes('backgroundTasksUpsert'));
});
