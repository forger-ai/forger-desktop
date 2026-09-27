import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const {
  RepositoryCollaborationStore,
} = require('../../dist-electron/main/repository-collaboration/store.js');
test('SQLite receipts and interrupted work survive restart without automatic rerun', () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), 'forger-collab-')),
    'tasks.sqlite',
  );
  const s = new RepositoryCollaborationStore(filename);
  const g = s.configureGroup(
    { connectionId: 'c', chatId: 'chat', title: 'Team', enabled: true },
    100,
  );
  const r = s.addRepository(g.id, 'Backend', '/tmp/backend');
  s.setAccess({
    groupId: g.id,
    participantId: 'p',
    displayName: 'P',
    repositoryIds: [r.id],
  });
  assert.equal(
    s.claimMessage({
      connectionId: 'c',
      chatId: 'chat',
      messageId: 'm',
      senderId: 'p',
    }),
    true,
  );
  assert.equal(
    s.claimMessage({
      connectionId: 'c',
      chatId: 'chat',
      messageId: 'm',
      senderId: 'p',
    }),
    false,
  );
  const t = s.createTask(
    {
      groupId: g.id,
      participantId: 'p',
      participantName: 'P',
      repositoryIds: [r.id],
      prompt: 'edit',
      sourceMessageId: 'm',
    },
    101,
  );
  s.updateTask(t.id, { status: 'running' }, 102);
  const reopened = new RepositoryCollaborationStore(filename);
  reopened.recoverInterrupted(103);
  assert.equal(reopened.task(t.id).status, 'needs_attention');
  assert.equal(
    reopened.claimMessage({
      connectionId: 'c',
      chatId: 'chat',
      messageId: 'm',
      senderId: 'p',
    }),
    false,
  );
  assert.equal('root' in reopened.snapshot('c').repositories[0], false);
  s.close();
  reopened.close();
});

test('acceptance receipt and task are one transaction, and grants cannot cross group boundaries', () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), 'forger-collab-atomic-')),
    'state.sqlite',
  );
  const store = new RepositoryCollaborationStore(filename);
  const first = store.configureGroup(
    { connectionId: 'c', chatId: 'first', title: 'First', enabled: false },
    1,
  );
  const second = store.configureGroup(
    { connectionId: 'c', chatId: 'second', title: 'Second', enabled: false },
    1,
  );
  const repo = store.addRepository(first.id, 'Repo', '/tmp/repo');
  assert.throws(() =>
    store.setAccess({
      groupId: second.id,
      participantId: 'p',
      displayName: 'P',
      repositoryIds: [repo.id],
    }),
  );
  assert.deepEqual(store.allowedRepositoryIds(second.id, 'p'), []);
  const message = {
    connectionId: 'c',
    chatId: 'first',
    messageId: 'm',
    senderId: 'p',
  };
  const task = {
    groupId: first.id,
    participantId: 'p',
    participantName: 'P',
    prompt: 'Do work',
    sourceMessageId: 'm',
    repositoryIds: ['missing'],
  };
  assert.throws(() => store.createTaskForMessage(message, task, 2));
  const accepted = store.createTaskForMessage(
    message,
    { ...task, repositoryIds: [repo.id] },
    3,
  );
  assert.ok(accepted);
  assert.equal(
    store.createTaskForMessage(
      message,
      { ...task, repositoryIds: [repo.id] },
      4,
    ),
    null,
  );
  assert.equal(store.tasks().length, 1);
  store.close();
});
