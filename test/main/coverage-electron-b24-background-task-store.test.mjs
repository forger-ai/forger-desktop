import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { BackgroundTaskStore, isActiveBackgroundTaskStatus, makeBackgroundTaskId } = require('../../dist-electron/main/background-task-store.js');

test('background task store normalizes corrupt legacy rows and applies every update fallback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b24-background-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'background-tasks.json');
  const store = new BackgroundTaskStore(root, { maxTasks: 0 });
  assert.equal(await store.get('missing'), null);
  await assert.rejects(store.appendStatusUpdate('missing', { message: 'nope' }), /background_task_not_found/);

  const created = await store.upsert({ id: 'task', source: 'social-upload' });
  assert.equal(created.title, 'task');
  assert.equal(created.status, 'queued');
  assert.deepEqual(created.statusUpdates, []);
  const inherited = await store.upsert({ id: 'task', source: 'social-upload', result: { status: 'success' }, app: { id: 'a', name: 'A' }, relatedEntity: { type: 'x', id: 'y' } });
  assert.equal(inherited.createdAt, created.createdAt);
  const done = await store.upsert({ id: 'task', source: 'social-upload', status: 'failed', completedAt: undefined });
  assert.equal(done.completedAt, done.updatedAt);
  assert.equal((await store.upsert({ id: 'task', source: 'social-upload' })).completedAt, done.completedAt);
  const updated = await store.appendStatusUpdate('task', { message: '  retried  ' });
  assert.equal(updated.status, 'failed');
  assert.equal(updated.statusUpdates.at(-1).message, 'retried');
  assert.match(makeBackgroundTaskId('job'), /^job:/);
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'canceled', 'skipped']) {
    assert.equal(isActiveBackgroundTaskStatus(status), status === 'queued' || status === 'running');
  }

  await fs.writeFile(file, JSON.stringify({ invalid: true }));
  assert.deepEqual(await store.list(), []);
  await fs.writeFile(file, JSON.stringify([
    null,
    3,
    {},
    { id: 1, source: 'automation', title: 'bad', status: 'queued' },
    { id: 'bad-source', source: 1, title: 'bad', status: 'queued' },
    { id: 'bad-title', source: 'automation', title: 1, status: 'queued' },
    { id: 'bad-status', source: 'automation', title: 'bad', status: 'mystery' },
    {
      id: 'legacy', source: 'other', title: ` ${'x'.repeat(200)} `, status: 'skipped', statusUpdates: 'invalid',
      result: { status: 'success' }, app: { id: 'a', name: 'A' }, relatedEntity: { type: 'x', id: '1' }, completedAt: 'done',
    },
    {
      id: 'updates', source: 'automation', title: 'Updates', status: 'running',
      statusUpdates: [null, { message: 1 }, { message: ' ok ', status: 'unknown' }, { message: 'done', status: 'succeeded', createdAt: 'then' }],
      createdAt: 'created', updatedAt: 'updated',
    },
    { id: 'no-updates', source: 'automation', title: 'No updates', status: 'queued' },
  ]));
  const normalized = await store.list();
  assert.deepEqual(new Set(normalized.map((task) => task.id)), new Set(['legacy', 'updates', 'no-updates']));
  assert.equal(normalized.find((task) => task.id === 'legacy').source, 'social-upload');
  assert.equal(normalized.find((task) => task.id === 'legacy').statusUpdates.length, 0);
  assert.equal(normalized.find((task) => task.id === 'updates').statusUpdates.length, 2);
});
