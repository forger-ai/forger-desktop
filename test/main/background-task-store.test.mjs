import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BackgroundTaskStore, isActiveBackgroundTaskStatus } = require('../../dist-electron/main/background-task-store.js');

test('background task store persists tasks sorted by recency and recovers from corrupt JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-background-tasks-'));
  const updates = [];
  const store = new BackgroundTaskStore(root, { onUpdated: (task) => updates.push(task) });

  const first = await store.upsert({
    id: 'social-upload:recipes:1',
    source: 'social-upload',
    title: 'Subiendo Recipes a Social',
    status: 'running',
    app: { id: 'recipes', name: 'Recipes' },
    statusUpdates: [{ message: 'Preparando app' }],
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
  });
  const second = await store.upsert({
    id: 'automation:run-1',
    source: 'automation',
    title: 'Automatizacion diaria',
    status: 'succeeded',
    result: { status: 'success', message: 'Lista.' },
    createdAt: '2026-05-25T11:00:00.000Z',
    updatedAt: '2026-05-25T11:05:00.000Z',
    completedAt: '2026-05-25T11:05:00.000Z',
  });

  assert.equal(first.statusUpdates.length, 1);
  assert.equal(updates.length, 2);
  assert.deepEqual((await store.list()).map((task) => task.id), [second.id, first.id]);
  assert.equal((await store.get(first.id)).app.name, 'Recipes');

  const reloaded = new BackgroundTaskStore(root);
  assert.deepEqual((await reloaded.list()).map((task) => task.id), [second.id, first.id]);

  await writeFile(path.join(root, 'background-tasks.json'), '{bad json', 'utf8');
  assert.deepEqual(await reloaded.list(), []);
});

test('background task store appends status updates and keeps a bounded history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-background-tasks-cap-'));
  const store = new BackgroundTaskStore(root, { maxTasks: 2 });

  await store.upsert({ id: 'old', source: 'social-upload', title: 'Old', status: 'succeeded', updatedAt: '2026-05-25T08:00:00.000Z' });
  await store.upsert({ id: 'middle', source: 'social-upload', title: 'Middle', status: 'succeeded', updatedAt: '2026-05-25T09:00:00.000Z' });
  await store.upsert({ id: 'new', source: 'social-upload', title: 'New', status: 'running', updatedAt: '2026-05-25T10:00:00.000Z' });

  assert.deepEqual((await store.list()).map((task) => task.id), ['new', 'middle']);

  await store.appendStatusUpdate('new', {
    message: 'Subiendo a Social',
    status: 'running',
    createdAt: '2026-05-25T10:01:00.000Z',
  });

  const updated = await store.get('new');
  assert.equal(updated.statusUpdates.at(-1).message, 'Subiendo a Social');
  assert.equal(isActiveBackgroundTaskStatus(updated.status), true);
  assert.equal(isActiveBackgroundTaskStatus('succeeded'), false);
});
