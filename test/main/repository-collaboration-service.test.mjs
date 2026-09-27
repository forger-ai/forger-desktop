import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const {
  RepositoryCollaborationStore,
} = require('../../dist-electron/main/repository-collaboration/store.js');
const {
  RepositoryCollaborationService,
} = require('../../dist-electron/main/repository-collaboration/service.js');
async function setup(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'forger-collaboration-'));
  execFileSync('git', ['init', '--quiet', root]);
  const store = new RepositoryCollaborationStore(
    path.join(root, 'state.sqlite'),
  );
  const calls = [],
    sent = [];
  const transport = {
    listGroups: async () => [{ chatId: 'chat@g.us', title: 'Team' }],
    listParticipants: async () => [
      { participantId: 'alice@s.whatsapp.net', displayName: 'Alice' },
      { participantId: 'bob@lid', displayName: 'Bob' },
    ],
    sendMessage: async (x) => {
      if (x.canSend && !(await x.canSend())) throw new Error('revoked');
      sent.push(x);
      return { messageId: 'out-' + sent.length };
    },
  };
  const executor = {
    run: async (x) => {
      calls.push(x);
      return run ? run(x) : { text: 'Listo', conversationId: 'thread-1' };
    },
  };
  const service = new RepositoryCollaborationService({
    store,
    executor,
    transport,
    now: () => 1000,
  });
  const group = await service.configureGroup({
    connectionId: 'c',
    chatId: 'chat@g.us',
    title: 'Team',
    enabled: false,
  });
  const repo = await service.addRepository({
    groupId: group.id,
    name: 'Backend',
    root,
  });
  await service.setAccess({
    groupId: group.id,
    participantId: 'alice@s.whatsapp.net',
    displayName: 'Alice',
    repositoryIds: [repo.id],
  });
  await service.configureGroup({
    connectionId: 'c',
    chatId: 'chat@g.us',
    title: 'Team',
    enabled: true,
  });
  service.start();
  const message = (extra = {}) => ({
    connectionId: 'c',
    chatId: 'chat@g.us',
    messageId: crypto.randomUUID(),
    senderId: 'alice@s.whatsapp.net',
    senderName: 'Alice',
    text: 'Forger, Backend: agrega filtro',
    timestamp: 1001,
    live: true,
    identityVerified: true,
    ...extra,
  });
  const settle = async () => {
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 5));
  };
  return {
    root,
    store,
    service,
    group,
    repo,
    calls,
    sent,
    transport,
    message,
    settle,
    async close() {
      await service.stop();
      store.close();
    },
  };
}
test('normal chat, history, automated messages and unverified or spoofed identities never execute', async () => {
  const f = await setup();
  for (const extra of [
    { text: 'hola' },
    { live: false },
    { timestamp: 999 },
    { automated: true },
    { identityVerified: false },
    { senderId: 'alice@lid' },
    { senderId: 'unknown', senderName: 'Alice' },
  ])
    await f.service.handleMessage(f.message(extra));
  await f.settle();
  assert.equal(f.calls.length, 0);
  await f.close();
});
test('verified own-account instructions execute once and retain author and conversation', async () => {
  const f = await setup();
  const m = f.message({ fromMe: true });
  await f.service.handleMessage(m);
  await f.service.handleMessage(m);
  await f.settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].task.participantId, m.senderId);
  const task = f.store.snapshot('c').tasks[0];
  assert.equal(task.status, 'completed');
  await f.service.handleMessage(
    f.message({ text: `Forger, #${task.id} agrega selección múltiple` }),
  );
  await f.settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].conversationId, 'thread-1');
  assert.ok(f.sent.every((m) => m.text.startsWith('🤖 Forger')));
  await f.close();
});
test('revocation aborts running work, cancels queued work, and suppresses result delivery', async () => {
  let finish;
  const f = await setup(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ text: 'sensitive result' });
      }),
  );
  await f.service.handleMessage(f.message());
  await f.settle();
  await f.service.handleMessage(f.message());
  await f.settle();
  assert.equal(f.calls.length, 1);
  await f.service.setAccess({
    groupId: f.group.id,
    participantId: 'alice@s.whatsapp.net',
    displayName: 'Alice',
    repositoryIds: [],
  });
  assert.equal(f.calls[0].signal.aborted, true);
  finish();
  await f.settle();
  assert.ok(f.store.snapshot('c').tasks.every((t) => t.status === 'cancelled'));
  assert.ok(!f.sent.some((m) => m.text.includes('sensitive result')));
  await f.close();
});
test('outgoing delivery failures never rerun execution', async () => {
  const f = await setup();
  let failures = 2;
  f.transport.sendMessage = async (m) => {
    if (failures-- > 0) throw Error('offline');
    f.sent.push(m);
    return { messageId: 'sent' };
  };
  await f.service.handleMessage(f.message());
  await f.settle();
  await f.service.flushOutbox();
  await f.service.flushOutbox();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.snapshot('c').tasks[0].status, 'completed');
  assert.ok(f.store.snapshot('c').outbox.every((m) => m.status === 'sent'));
  await f.close();
});
test('multi-repository commands require every grant and overlapping roots serialize across aliases', async () => {
  let finish;
  const f = await setup(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const nested = path.join(f.root, 'nested');
  mkdirSync(nested);
  execFileSync('git', ['init', '--quiet', nested]);
  const r2 = await f.service.addRepository({
    groupId: f.group.id,
    name: 'Desktop',
    root: nested,
  });
  await f.service.handleMessage(
    f.message({ text: 'Forger, Backend + Desktop: ambos' }),
  );
  await f.settle();
  assert.equal(f.calls.length, 0);
  await f.service.setAccess({
    groupId: f.group.id,
    participantId: 'alice@s.whatsapp.net',
    displayName: 'Alice',
    repositoryIds: [f.repo.id, r2.id],
  });
  await f.service.handleMessage(f.message());
  await f.service.handleMessage(f.message({ text: 'Forger, Desktop: cambia' }));
  await f.settle();
  assert.equal(f.calls.length, 1);
  finish({ text: 'done' });
  await f.settle();
  assert.equal(f.calls.length, 2);
  finish({ text: 'done' });
  await f.settle();
  await f.close();
});

test('group recipients without every grant only see a generic local-review notice', async () => {
  const f = await setup(async () => ({
    text: 'Confidential implementation details',
    conversationId: 'thread',
  }));
  await f.service.handleMessage(f.message());
  await f.settle();
  await f.service.flushOutbox();
  assert.equal(
    f.store.snapshot('c').tasks[0].result,
    'Confidential implementation details',
  );
  assert.ok(f.sent.length > 0);
  assert.ok(f.sent.every((message) => !message.text.includes('Confidential')));
  assert.ok(f.sent.every((message) => message.replyToMessageId === undefined));
  await f.service.setAccess({
    groupId: f.group.id,
    participantId: 'bob@lid',
    displayName: 'Bob',
    repositoryIds: [f.repo.id],
  });
  await f.service.handleMessage(f.message());
  await f.settle();
  await f.service.flushOutbox();
  assert.ok(f.sent.some((message) => message.text.includes('Confidential')));
  await f.close();
});

test('either authorized human can append to a running task, retaining turn authors and one conversation', async () => {
  let finish;
  const f = await setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.service.setAccess({
    groupId: f.group.id,
    participantId: 'bob@lid',
    displayName: 'Bob',
    repositoryIds: [f.repo.id],
  });
  await f.service.handleMessage(f.message());
  await f.settle();
  const first = f.store.tasks()[0];
  await f.service.handleMessage(
    f.message({
      senderId: 'bob@lid',
      senderName: 'Bob',
      text: `Forger, #${first.id.slice(0, 8)} permite selección múltiple`,
    }),
  );
  assert.equal(f.store.tasks()[1].status, 'queued');
  assert.equal(f.store.tasks()[1].participantId, 'bob@lid');
  assert.equal(f.calls.length, 1);
  finish({ text: 'First done', conversationId: 'shared-thread' });
  await f.settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].conversationId, 'shared-thread');
  finish({ text: 'Second done', conversationId: 'shared-thread' });
  await f.settle();
  await f.close();
});

test('a participant removed after queueing cannot execute and offline pause cancels work', async () => {
  let finish;
  const f = await setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.service.setAccess({
    groupId: f.group.id,
    participantId: 'bob@lid',
    displayName: 'Bob',
    repositoryIds: [f.repo.id],
  });
  await f.service.handleMessage(f.message());
  await f.settle();
  await f.service.handleMessage(
    f.message({ senderId: 'bob@lid', senderName: 'Bob' }),
  );
  f.transport.listParticipants = async () => [
    { participantId: 'alice@s.whatsapp.net', displayName: 'Alice' },
  ];
  finish({ text: 'Done', conversationId: 'thread' });
  await f.settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.tasks()[1].status, 'cancelled');
  await f.service.handleMessage(f.message());
  await f.settle();
  f.transport.listGroups = async () => {
    throw new Error('Offline');
  };
  await f.service.configureGroup({
    connectionId: 'c',
    chatId: 'chat@g.us',
    title: 'Team',
    enabled: false,
  });
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.store.tasks()[2].status, 'cancelling');
  finish({ text: 'Partial output' });
  await f.settle();
  assert.equal(f.store.tasks()[2].status, 'cancelled');
  await f.close();
});

test('roster failure leaves a message retryable and never consumes it before durable acceptance', async () => {
  const f = await setup();
  const roster = f.transport.listParticipants;
  f.transport.listParticipants = async () => {
    throw new Error('temporary failure');
  };
  const message = f.message();
  await assert.rejects(f.service.handleMessage(message));
  f.transport.listParticipants = roster;
  await f.service.handleMessage(message);
  await f.settle();
  assert.equal(f.calls.length, 1);
  await f.close();
});

test('revocation during outgoing delay prevents send even when access is granted again later', async () => {
  const f = await setup();
  let waiting;
  let release;
  const blocked = new Promise((resolve) => {
    waiting = resolve;
  });
  f.transport.sendMessage = async (message) => {
    waiting();
    await new Promise((resolve) => {
      release = resolve;
    });
    if (!(await message.canSend())) throw new Error('revoked');
    f.sent.push(message);
    return { messageId: 'should-not-send' };
  };
  await f.service.handleMessage(f.message());
  await blocked;
  await f.service.setAccess({
    groupId: f.group.id,
    participantId: 'alice@s.whatsapp.net',
    displayName: 'Alice',
    repositoryIds: [],
  });
  await f.service.setAccess({
    groupId: f.group.id,
    participantId: 'alice@s.whatsapp.net',
    displayName: 'Alice',
    repositoryIds: [f.repo.id],
  });
  release();
  await f.settle();
  assert.equal(f.sent.length, 0);
  assert.ok(f.store.outbox().every((output) => output.status === 'suppressed'));
  await f.close();
});

test('restart preserves queued work and marks uncertain running work for explicit fresh retry', async () => {
  const f = await setup();
  await f.service.stop();
  const input = {
    groupId: f.group.id,
    participantId: 'alice@s.whatsapp.net',
    participantName: 'Alice',
    prompt: 'work',
    repositoryIds: [f.repo.id],
    sourceMessageId: 'saved',
  };
  const interrupted = f.store.createTask(input, 1001);
  f.store.updateTask(
    interrupted.id,
    { status: 'running', conversationId: 'ambiguous-thread' },
    1002,
  );
  f.store.createTask({ ...input, sourceMessageId: 'queued' }, 1003);
  f.service.start();
  await f.settle();
  assert.equal(f.store.task(interrupted.id).status, 'needs_attention');
  assert.equal(f.calls.length, 1);
  await f.service.retryTask({ taskId: interrupted.id });
  await f.settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].conversationId, undefined);
  assert.equal(f.calls[1].task.parentTaskId, null);
  await f.close();
});

test('failed parent work blocks continuations and exposes only a safe runtime error code', async () => {
  let reject;
  const f = await setup(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await f.service.handleMessage(f.message());
  await f.settle();
  const parent = f.store.tasks()[0];
  await f.service.handleMessage(
    f.message({ text: `Forger, #${parent.id.slice(0, 8)} continúa` }),
  );
  reject(new Error('repository_execution_auth_required'));
  await f.settle();
  assert.equal(f.store.task(parent.id).errorCode, 'authentication_required');
  assert.equal(f.store.tasks()[1].status, 'needs_attention');
  assert.equal(f.calls.length, 1);
  assert.ok(
    f.sent.every((message) => !message.text.includes('repository_execution')),
  );
  await f.close();
});

test('canonical repository locks serialize the same folder across independent groups', async () => {
  let finish;
  const f = await setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.transport.listGroups = async () => [
    { chatId: 'chat@g.us', title: 'Team' },
    { chatId: 'other@g.us', title: 'Other' },
  ];
  const second = await f.service.configureGroup({
    connectionId: 'c',
    chatId: 'other@g.us',
    title: 'Other',
    enabled: false,
  });
  const repository = await f.service.addRepository({
    groupId: second.id,
    name: 'Shared',
    root: f.root,
  });
  await f.service.setAccess({
    groupId: second.id,
    participantId: 'alice@s.whatsapp.net',
    displayName: 'Alice',
    repositoryIds: [repository.id],
  });
  await f.service.configureGroup({
    connectionId: 'c',
    chatId: 'other@g.us',
    title: 'Other',
    enabled: true,
  });
  await f.service.handleMessage(f.message());
  await f.service.handleMessage(
    f.message({ chatId: 'other@g.us', text: 'Forger, Shared: edit' }),
  );
  await f.settle();
  assert.equal(f.calls.length, 1);
  finish({ text: 'first' });
  await f.settle();
  assert.equal(f.calls.length, 2);
  finish({ text: 'second' });
  await f.settle();
  await f.close();
});

test('replaced repository roots fail closed before a queued task executes', async () => {
  const f = await setup();
  await f.service.stop();
  const child = path.join(f.root, 'project');
  mkdirSync(child);
  execFileSync('git', ['init', '--quiet', child]);
  const repository = await f.service.addRepository({
    groupId: f.group.id,
    name: 'Child',
    root: child,
  });
  await f.service.setAccess({
    groupId: f.group.id,
    participantId: 'alice@s.whatsapp.net',
    displayName: 'Alice',
    repositoryIds: [f.repo.id, repository.id],
  });
  const task = f.store.createTask(
    {
      groupId: f.group.id,
      participantId: 'alice@s.whatsapp.net',
      participantName: 'Alice',
      prompt: 'edit',
      repositoryIds: [repository.id],
      sourceMessageId: 'saved',
    },
    1001,
  );
  renameSync(child, child + '-moved');
  symlinkSync(child + '-moved', child, 'dir');
  f.service.start();
  await f.settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.task(task.id).status, 'failed');
  assert.equal(f.store.task(task.id).errorCode, 'repository_unavailable');
  await f.close();
});

test('remote cancellation sends a readable acknowledgement and retains the lock until execution exits', async () => {
  let finish;
  const f = await setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.service.handleMessage(f.message());
  await f.settle();
  const task = f.store.tasks()[0];
  await f.service.handleMessage(
    f.message({ text: `Forger, cancelar #${task.id.slice(0, 8)}` }),
  );
  await f.service.flushOutbox();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.store.task(task.id).status, 'cancelling');
  assert.ok(f.sent.some((message) => message.text.includes('cancelando')));
  await f.service.handleMessage(f.message());
  await f.settle();
  assert.equal(f.calls.length, 1);
  finish({ text: 'partial' });
  await f.settle();
  assert.equal(f.store.task(task.id).status, 'cancelled');
  assert.equal(f.calls.length, 2);
  finish({ text: 'next complete' });
  await f.settle();
  await f.close();
});

test('an authorized multi-project instruction receives exactly its explicitly selected roots', async () => {
  const f = await setup();
  const nested = path.join(f.root, 'client');
  mkdirSync(nested);
  execFileSync('git', ['init', '--quiet', nested]);
  const second = await f.service.addRepository({
    groupId: f.group.id,
    name: 'Desktop',
    root: nested,
  });
  await f.service.setAccess({
    groupId: f.group.id,
    participantId: 'alice@s.whatsapp.net',
    displayName: 'Alice',
    repositoryIds: [f.repo.id, second.id],
  });
  await f.service.handleMessage(
    f.message({ text: 'Forger, Backend + Desktop: actualiza ambos' }),
  );
  await f.settle();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(
    f.calls[0].repositories.map((repository) => repository.id).sort(),
    [f.repo.id, second.id].sort(),
  );
  assert.equal(f.calls[0].prompt, 'actualiza ambos');
  await f.close();
});

test('durable queued work waits for WhatsApp to reconnect without becoming failed or replaying', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const f = await setup();
  await f.service.stop();
  const task = f.store.createTask(
    {
      groupId: f.group.id,
      participantId: 'alice@s.whatsapp.net',
      participantName: 'Alice',
      prompt: 'queued while offline',
      repositoryIds: [f.repo.id],
      sourceMessageId: 'saved-offline',
    },
    1001,
  );
  const roster = f.transport.listParticipants;
  f.transport.listParticipants = async () => {
    throw new Error('not connected yet');
  };
  f.service.start();
  await f.settle();
  assert.equal(f.store.task(task.id).status, 'queued');
  assert.equal(f.calls.length, 0);
  f.transport.listParticipants = roster;
  context.mock.timers.tick(10000);
  await f.settle();
  assert.equal(f.store.task(task.id).status, 'completed');
  assert.equal(f.calls.length, 1);
  await f.close();
});

test('project registration rejects symlinks, external Git metadata, and broad roots before granting access', async () => {
  const f = await setup();
  const linked = path.join(f.root, 'linked');
  symlinkSync(f.root, linked, 'dir');
  await assert.rejects(
    f.service.addRepository({
      groupId: f.group.id,
      name: 'Linked',
      root: linked,
    }),
  );
  const external = path.join(f.root, 'external');
  mkdirSync(external);
  writeFileSync(
    path.join(external, '.git'),
    `gitdir: ${path.join(f.root, '.git')}\n`,
  );
  await assert.rejects(
    f.service.addRepository({
      groupId: f.group.id,
      name: 'External',
      root: external,
    }),
  );
  await assert.rejects(
    f.service.addRepository({
      groupId: f.group.id,
      name: 'Home',
      root: homedir(),
    }),
  );
  await assert.rejects(
    f.service.addRepository({
      groupId: f.group.id,
      name: 'System',
      root: path.parse(f.root).root,
    }),
  );
  assert.equal(f.store.repositories(f.group.id).length, 1);
  await f.close();
});

test('a delayed membership refresh cannot cancel work that already completed', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let finish;
  const f = await setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.service.handleMessage(f.message());
  await f.settle();
  await f.service.flushOutbox();
  const task = f.store.tasks()[0];
  const roster = f.transport.listParticipants;
  let blockNext = true;
  let releaseMembership;
  f.transport.listParticipants = async (...args) => {
    if (blockNext) {
      blockNext = false;
      return new Promise((resolve) => {
        releaseMembership = resolve;
      });
    }
    return roster(...args);
  };
  context.mock.timers.tick(10000);
  assert.equal(typeof releaseMembership, 'function');
  finish({ text: 'Completed before roster refresh', conversationId: 'thread' });
  await f.settle();
  assert.equal(f.store.task(task.id).status, 'completed');
  releaseMembership([]);
  await f.settle();
  assert.equal(f.store.task(task.id).status, 'completed');
  await f.close();
});

test('shutdown preserves queued reservations that have not begun executing', async () => {
  const f = await setup();
  const roster = f.transport.listParticipants;
  let rosterCalls = 0;
  let releaseMembership;
  f.transport.listParticipants = async (...args) => {
    rosterCalls += 1;
    // Acceptance and the receipt delivery perform the first two lookups; execution reserves its roots before the third.
    if (rosterCalls === 3)
      return new Promise((resolve) => {
        releaseMembership = resolve;
      });
    return roster(...args);
  };
  await f.service.handleMessage(f.message());
  const task = f.store.tasks()[0];
  const stopping = f.service.stop();
  assert.equal(f.store.task(task.id).status, 'queued');
  releaseMembership(await roster());
  await stopping;
  assert.equal(f.store.task(task.id).status, 'queued');
  assert.equal(f.calls.length, 0);
  f.transport.listParticipants = roster;
  f.service.start();
  await f.settle();
  assert.equal(f.store.task(task.id).status, 'completed');
  assert.equal(f.calls.length, 1);
  await f.close();
});

test('one failed destination preserves its order without blocking replies to another group', async () => {
  const f = await setup();
  f.transport.listGroups = async () => [
    { chatId: 'chat@g.us', title: 'Team' },
    { chatId: 'other@g.us', title: 'Other' },
  ];
  const second = await f.service.configureGroup({
    connectionId: 'c',
    chatId: 'other@g.us',
    title: 'Other',
    enabled: false,
  });
  const repository = await f.service.addRepository({
    groupId: second.id,
    name: 'Shared',
    root: f.root,
  });
  await f.service.setAccess({
    groupId: second.id,
    participantId: 'alice@s.whatsapp.net',
    displayName: 'Alice',
    repositoryIds: [repository.id],
  });
  await f.service.configureGroup({
    connectionId: 'c',
    chatId: 'other@g.us',
    title: 'Other',
    enabled: true,
  });
  f.store.enqueueOutput({
    groupId: f.group.id,
    participantId: 'alice@s.whatsapp.net',
    text: '🤖 Forger first pending',
  });
  f.store.enqueueOutput({
    groupId: f.group.id,
    participantId: 'alice@s.whatsapp.net',
    text: '🤖 Forger second pending',
  });
  f.store.enqueueOutput({
    groupId: second.id,
    participantId: 'alice@s.whatsapp.net',
    text: '🤖 Forger other group ready',
  });
  const attempts = [];
  f.transport.sendMessage = async (message) => {
    attempts.push(message.text);
    if (message.chatId === 'chat@g.us')
      throw new Error('destination unavailable');
    if (!(await message.canSend())) throw new Error('revoked');
    f.sent.push(message);
    return { messageId: 'delivered-to-other-group' };
  };
  await f.service.flushOutbox();
  assert.deepEqual(attempts, [
    '🤖 Forger first pending',
    '🤖 Forger other group ready',
  ]);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(
    f.store.outbox().map((output) => output.status),
    ['pending', 'pending', 'sent'],
  );
  await f.close();
});

test('configuration and retry reject missing groups, foreign projects and former participants', async () => {
    const f = await setup();
    try {
        f.service.start();
        await assert.rejects(f.service.addRepository({ groupId: 'missing', name: 'X', root: f.root }), /configurado/);
        await assert.rejects(f.service.configureGroup({ connectionId: 'c', chatId: 'missing', title: 'X', enabled: false }), /disponible/);
        await assert.rejects(f.service.addRepository({ groupId: f.group.id, name: 'Other', root: f.root }), /vinculado/);
        await assert.rejects(f.service.setAccess({ groupId: f.group.id, participantId: 'outsider', displayName: 'X', repositoryIds: [f.repo.id] }), /pertenece/);
        await assert.rejects(f.service.setAccess({ groupId: f.group.id, participantId: 'alice@s.whatsapp.net', displayName: 'X', repositoryIds: ['missing'] }), /vinculados/);
        await assert.rejects(f.service.retryTask({ taskId: 'missing' }), /reintentarse/);
        await assert.rejects(f.service.cancelTask({ taskId: 'missing' }), /disponible/);
        await f.service.handleMessage(f.message());
        await f.settle();
        const task = f.store.tasks()[0];
        await assert.rejects(f.service.retryTask({ taskId: task.id }), /reintentarse/);
        f.store.updateTask(task.id, { status: 'failed' }, 1002);
        f.transport.listParticipants = async () => [];
        await assert.rejects(f.service.retryTask({ taskId: task.id }), /acceso/);
        await assert.rejects(f.service.configureGroup({ connectionId: 'c', chatId: 'chat@g.us', title: 'Team', enabled: true }), /autoriza/);
        await f.service.removeRepository({ groupId: f.group.id, repositoryId: f.repo.id });
        assert.deepEqual(f.service.snapshot('c').repositories, []);
        await assert.rejects(f.service.retryTask({ taskId: task.id }), /acceso/);
    }
    finally {
        await f.close();
    }
});
test('invalid timestamps, oversized commands and missing task references never create executable work', async () => {
    const f = await setup();
    try {
        for (const extra of [{ messageId: '' }, { senderId: '' }, { timestamp: NaN }, { timestamp: 301001 }, { text: 'Forger, ' + 'x'.repeat(12001) }, { chatId: 'absent@g.us' }])
            await f.service.handleMessage(f.message(extra));
        await f.service.handleMessage(f.message({ text: 'Forger, estado #missing' }));
        await f.service.handleMessage(f.message({ text: 'Forger, #missing continue' }));
        await f.settle();
        assert.equal(f.calls.length, 0);
        assert.ok(f.sent.some(x => x.text.includes('Task not found')));
        await f.service.stop();
        await f.service.handleMessage(f.message());
        assert.equal(f.store.tasks().length, 0);
    }
    finally {
        await f.close();
    }
});
test('reply continuation follows the latest attributable turn and failed chains require local review', async () => {
    const f = await setup();
    try {
        f.transport.listParticipants = async () => [{ participantId: 'alice@s.whatsapp.net' }];
        await f.service.handleMessage(f.message({ senderName: undefined }));
        await f.settle();
        await f.service.flushOutbox();
        const first = f.store.tasks()[0];
        const completed = f.store.outbox().find(x => x.taskId === first.id && x.text.includes('Completed'));
        await f.service.handleMessage(f.message({ text: 'Forger, continue', replyToMessageId: completed.messageId }));
        await f.settle();
        await f.service.handleMessage(f.message({ text: `Forger, #${first.id} third` }));
        await f.settle();
        const tasks = f.store.tasks();
        assert.equal(tasks.length, 3);
        const second = tasks.find(x => x.prompt === 'continue');
        const third = tasks.find(x => x.prompt === 'third');
        assert.equal(third.parentTaskId, second.id);
        assert.equal(first.participantName, 'alice@s.whatsapp.net');
        f.store.updateTask(third.id, { status: 'failed' }, 1002);
        await f.service.handleMessage(f.message({ text: `Forger, #${first.id} fourth` }));
        await f.settle();
        assert.equal(f.store.tasks().length, 3);
        assert.ok(f.sent.some(x => x.text.includes('Review this task')));
        const status = f.message({ text: `Forger, estado #${first.id}` });
        await f.service.handleMessage(status);
        await f.settle();
        const outputs = f.store.outbox().length;
        await f.service.handleMessage(status);
        await f.settle();
        assert.equal(f.store.outbox().length, outputs);
    }
    finally {
        await f.close();
    }
});
for (const [failure, code] of [[Error('repository_execution_auth_required'), 'authentication_required'], [Error('repository_execution_roots_invalid'), 'repository_unavailable'], ['non-error', 'execution_failed']])
    test(`execution reports safe ${code} without exposing exception details`, async () => {
        const f = await setup(async () => { throw failure; });
        try {
            await f.service.handleMessage(f.message());
            await f.settle();
            assert.equal(f.store.tasks()[0].errorCode, code);
        }
        finally {
            await f.close();
        }
    });
test('selection and queue limits produce guidance without accepting oversized work', async () => {
    let release;
    const f = await setup(() => new Promise(resolve => { release = resolve; }));
    try {
        const repositories = [f.repo];
        for (let i = 0; i < 10; i++)
            repositories.push(f.store.addRepository(f.group.id, `Repo${i}`, `/unavailable/${i}`));
        f.store.setAccess({ groupId: f.group.id, participantId: 'alice@s.whatsapp.net', displayName: 'Alice', repositoryIds: repositories.map(x => x.id) });
        await f.service.handleMessage(f.message({ text: 'Forger, ambiguous' }));
        await f.service.handleMessage(f.message({ text: `Forger, ${repositories.map(x => x.name).join(' + ')}: too much` }));
        assert.equal(f.store.tasks().length, 0);
        await f.service.handleMessage(f.message());
        await f.settle();
        for (let i = 0; i < 100; i++)
            f.store.createTask({ groupId: f.group.id, participantId: 'alice@s.whatsapp.net', participantName: 'Alice', repositoryIds: [f.repo.id], prompt: 'queued', sourceMessageId: `queued${i}` }, 1001);
        await f.service.handleMessage(f.message());
        assert.equal(f.store.tasks().length, 101);
        assert.ok(f.store.outbox().some(x => x.text.includes('queue is full')));
        release({ text: 'Done' });
        await f.service.stop();
    }
    finally {
        release?.({ text: 'Done' });
        await f.close();
    }
});
for (const mode of ['paused', 'no-grant', 'cancelled', 'author-left', 'requester-left', 'revoked-during-roster', 'paused-during-roster', 'author-left-before-send', 'requester-left-before-send', 'new-recipient-before-send'])
    test(`pending delivery is suppressed or retained safely when ${mode}`, async () => {
        const f = await setup();
        try {
            const author = 'alice@s.whatsapp.net', requester = 'bob@lid';
            f.store.setAccess({ groupId: f.group.id, participantId: requester, displayName: 'Bob', repositoryIds: [f.repo.id] });
            const task = f.store.createTask({ groupId: f.group.id, participantId: author, participantName: 'Alice', repositoryIds: [f.repo.id], prompt: 'work', sourceMessageId: 'm' }, 1001);
            f.store.updateTask(task.id, { status: mode === 'cancelled' ? 'cancelled' : 'completed' }, 1002);
            f.store.enqueueOutput({ groupId: f.group.id, taskId: task.id, participantId: requester, text: 'private result' });
            let rosterCalls = 0;
            f.transport.listParticipants = async () => {
                rosterCalls++;
                if (mode === 'revoked-during-roster' && rosterCalls === 1)
                    f.store.setAccess({ groupId: f.group.id, participantId: author, displayName: 'Alice', repositoryIds: [] });
                if (mode === 'paused-during-roster' && rosterCalls === 1)
                    f.store.configureGroup({ connectionId: 'c', chatId: 'chat@g.us', title: 'Team', enabled: false }, 1003);
                if (mode === 'author-left' || (mode === 'author-left-before-send' && rosterCalls >= 2))
                    return [{ participantId: requester }];
                if (mode === 'requester-left' || (mode === 'requester-left-before-send' && rosterCalls >= 2))
                    return [{ participantId: author }];
                if (mode === 'new-recipient-before-send' && rosterCalls >= 2)
                    return [{ participantId: author }, { participantId: requester }, { participantId: 'new@lid' }];
                return [{ participantId: author }, { participantId: requester }];
            };
            if (mode === 'paused')
                f.store.configureGroup({ connectionId: 'c', chatId: 'chat@g.us', title: 'Team', enabled: false }, 1003);
            if (mode === 'no-grant')
                f.store.setAccess({ groupId: f.group.id, participantId: requester, displayName: 'Bob', repositoryIds: [] });
            await f.service.flushOutbox();
            assert.equal(f.sent.length, 0);
            assert.notEqual(f.store.outbox()[0].status, 'sent');
        }
        finally {
            await f.close();
        }
    });
test('revoking one participant suppresses their notices and affected task results without discarding unrelated output', async () => {
    const f = await setup();
    try {
        const alice = 'alice@s.whatsapp.net', bob = 'bob@lid';
        f.store.setAccess({ groupId: f.group.id, participantId: bob, displayName: 'Bob', repositoryIds: [f.repo.id] });
        const task = f.store.createTask({ groupId: f.group.id, participantId: bob, participantName: 'Bob', repositoryIds: [f.repo.id], prompt: 'work', sourceMessageId: 'm' }, 1001);
        f.store.updateTask(task.id, { status: 'completed' }, 1002);
        for (const output of [{ participantId: alice, text: 'notice' }, { participantId: bob, text: 'result', taskId: task.id }, { participantId: bob, text: 'unrelated' }])
            f.store.enqueueOutput({ groupId: f.group.id, ...output });
        await f.service.setAccess({ groupId: f.group.id, participantId: alice, displayName: 'Alice', repositoryIds: [] });
        const outbox = f.store.outbox();
        assert.equal(outbox.find(x => x.text === 'notice').status, 'suppressed');
        assert.equal(outbox.find(x => x.text === 'result').status, 'suppressed');
        assert.equal(outbox.find(x => x.text === 'unrelated').status, 'pending');
    }
    finally {
        await f.close();
    }
});
test('cancelled parent cascades to queued continuations and suppresses their pending acknowledgements', async () => {
    const f = await setup();
    try {
        await f.service.stop();
        const base = { groupId: f.group.id, participantId: 'alice@s.whatsapp.net', participantName: 'Alice', repositoryIds: [f.repo.id], prompt: 'work', sourceMessageId: 'm' };
        const parent = f.store.createTask(base, 1001), child = f.store.createTask({ ...base, parentTaskId: parent.id }, 1002);
        f.store.enqueueOutput({ groupId: f.group.id, taskId: child.id, participantId: base.participantId, text: 'queued' });
        await f.service.cancelTask({ taskId: parent.id });
        assert.equal(f.store.task(child.id).status, 'cancelled');
        assert.equal(f.store.outbox()[0].status, 'suppressed');
        await f.service.cancelTask({ taskId: parent.id });
        await f.service.flushOutbox();
    }
    finally {
        await f.close();
    }
});
for (const mode of ['paused', 'revoked', 'shutdown'])
    test(`intake rechecks ${mode} after waiting for live membership`, async () => {
        const f = await setup();
        try {
            let release;
            f.transport.listParticipants = () => new Promise(resolve => { release = resolve; });
            const intake = f.service.handleMessage(f.message());
            await new Promise(resolve => setImmediate(resolve));
            let stopping;
            if (mode === 'paused')
                f.store.configureGroup({ connectionId: 'c', chatId: 'chat@g.us', title: 'Team', enabled: false }, 1002);
            if (mode === 'revoked')
                f.store.setAccess({ groupId: f.group.id, participantId: 'alice@s.whatsapp.net', displayName: 'Alice', repositoryIds: [] });
            if (mode === 'shutdown')
                stopping = f.service.stop();
            release([{ participantId: 'alice@s.whatsapp.net' }]);
            await intake;
            await stopping;
            assert.equal(f.store.tasks().length, 0);
        }
        finally {
            await f.close();
        }
    });
for (const outcome of ['absent', 'offline', 'shutdown'])
    test(`periodic membership verification ${outcome} prevents unattended writes`, async (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        let finish;
        const f = await setup(() => new Promise(resolve => { finish = resolve; }));
        try {
            await f.service.handleMessage(f.message());
            await f.settle();
            await f.service.flushOutbox();
            let release;
            f.transport.listParticipants = async () => new Promise((resolve, reject) => { release = () => outcome === 'offline' ? reject(Error('offline')) : resolve([]); });
            t.mock.timers.tick(10000);
            let stopping;
            if (outcome === 'shutdown')
                stopping = f.service.stop();
            release();
            await new Promise(resolve => setImmediate(resolve));
            finish({ text: 'should not publish' });
            await stopping;
            await f.settle();
            assert.notEqual(f.store.tasks()[0].status, 'completed');
        }
        finally {
            finish?.({ text: 'stopped' });
            await f.close();
        }
    });
test('membership lost after executor completion cancels the task and never shares its result', async () => {
    let finish;
    const f = await setup(() => new Promise(resolve => { finish = resolve; }));
    try {
        await f.service.handleMessage(f.message());
        await f.settle();
        await f.service.flushOutbox();
        f.transport.listParticipants = async () => [];
        finish({ text: 'private result' });
        await f.settle();
        assert.equal(f.store.tasks()[0].status, 'cancelled');
        assert.ok(f.sent.every(x => !x.text.includes('private result')));
    }
    finally {
        finish?.({ text: 'stop' });
        await f.close();
    }
});
test('revocation during final membership verification prevents successful task completion', async () => {
    let finish;
    const f = await setup(() => new Promise(resolve => { finish = resolve; }));
    try {
        await f.service.handleMessage(f.message());
        await f.settle();
        await f.service.flushOutbox();
        f.transport.listParticipants = async () => { f.store.setAccess({ groupId: f.group.id, participantId: 'alice@s.whatsapp.net', displayName: 'Alice', repositoryIds: [] }); return [{ participantId: 'alice@s.whatsapp.net' }]; };
        finish({ text: 'private result' });
        await f.settle();
        assert.notEqual(f.store.tasks()[0].status, 'completed');
    }
    finally {
        finish?.({ text: 'stop' });
        await f.close();
    }
});
test('a task whose grants were revoked while the process was stopped is cancelled on restart', async () => {
    const f = await setup();
    try {
        await f.service.stop();
        const task = f.store.createTask({ groupId: f.group.id, participantId: 'alice@s.whatsapp.net', participantName: 'Alice', repositoryIds: [f.repo.id], prompt: 'work', sourceMessageId: 'm' }, 1001);
        f.store.setAccess({ groupId: f.group.id, participantId: 'alice@s.whatsapp.net', displayName: 'Alice', repositoryIds: [] });
        f.service.start();
        assert.equal(f.store.task(task.id).status, 'cancelled');
        assert.equal(f.calls.length, 0);
    }
    finally {
        await f.close();
    }
});
test('queued intake is ignored if stopped before its microtask runs and runtime failures stay safely classified', async () => {
    const f = await setup(async () => { throw Error('repository_execution_runtime_missing'); });
    try {
        await f.service.handleMessage(f.message());
        await f.settle();
        assert.equal(f.store.tasks()[0].errorCode, 'runtime_unavailable');
        const pending = f.service.handleMessage(f.message());
        const stopping = f.service.stop();
        await pending;
        await stopping;
        assert.equal(f.store.tasks().length, 1);
    }
    finally {
        await f.close();
    }
});
test('an authorized participant cannot continue another task outside their current project grants', async () => {
    const f = await setup();
    try {
        await f.service.handleMessage(f.message());
        await f.settle();
        const task = f.store.tasks()[0];
        const other = f.store.addRepository(f.group.id, 'Other', '/tmp/other');
        f.store.setAccess({ groupId: f.group.id, participantId: 'bob@lid', displayName: 'Bob', repositoryIds: [other.id] });
        await f.service.handleMessage(f.message({ senderId: 'bob@lid', text: `Forger, #${task.id} continue` }));
        assert.equal(f.store.tasks().length, 1);
    }
    finally {
        await f.close();
    }
});
test('successful tasks without a conversation retain a null session rather than inventing a resume id', async () => {
    const f = await setup(async () => ({ text: 'Done' }));
    try {
        await f.service.handleMessage(f.message());
        await f.settle();
        const first = f.store.tasks()[0];
        assert.equal(first.conversationId, null);
        await f.service.handleMessage(f.message({ text: `Forger, #${first.id} next` }));
        await f.settle();
        assert.ok(f.store.tasks().every(x => x.conversationId === null));
    }
    finally {
        await f.close();
    }
});
test('repository preflight detects changed canonical identity before the executor starts', async (t) => {
    const f = await setup();
    try {
        const validation = require('../../dist-electron/main/repository-collaboration/repository-validation.js');
        t.mock.method(validation, 'validateRepositoryRoot', async () => '/changed/canonical-root');
        await f.service.handleMessage(f.message());
        await f.settle();
        assert.equal(f.calls.length, 0);
        assert.equal(f.store.tasks()[0].errorCode, 'repository_unavailable');
    }
    finally {
        await f.close();
    }
});
test('shutdown during delivery stops the next queued reply and suppresses an unavailable group', async (t) => {
    const f = await setup();
    let stopping;
    try {
        const input = { groupId: f.group.id, participantId: 'alice@s.whatsapp.net', text: 'notice' };
        f.store.enqueueOutput(input);
        f.store.enqueueOutput(input);
        f.transport.sendMessage = async () => { stopping = f.service.stop(); return { messageId: 'last' }; };
        await f.service.flushOutbox();
        await stopping;
        assert.equal(f.store.outbox().filter(x => x.status === 'sent').length, 1);
        f.transport.sendMessage = async () => ({ messageId: 'next' });
        f.service.start();
        await f.service.flushOutbox();
        f.store.enqueueOutput(input);
        const mock = t.mock.method(f.store, 'group', () => undefined);
        await f.service.flushOutbox();
        mock.mock.restore();
        assert.equal(f.store.outbox().at(-1).status, 'suppressed');
    }
    finally {
        await stopping;
        await f.close();
    }
});
test('a missing task snapshot during a failed execution cannot fabricate a completed result', async (t) => {
    let fail;
    const f = await setup(() => new Promise((_resolve, reject) => { fail = reject; }));
    try {
        await f.service.handleMessage(f.message());
        await f.settle();
        await f.service.flushOutbox();
        const mock = t.mock.method(f.store, 'task', () => undefined);
        fail(Error('failed'));
        await f.settle();
        mock.mock.restore();
        assert.equal(f.store.tasks()[0].status, 'failed');
    }
    finally {
        fail?.(Error('stopped'));
        await f.close();
    }
});
