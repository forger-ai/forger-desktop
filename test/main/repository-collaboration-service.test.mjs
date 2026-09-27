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
