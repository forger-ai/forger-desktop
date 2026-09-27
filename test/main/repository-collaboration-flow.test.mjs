import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const managerModule = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
const {
  WhatsAppLocalStore,
} = require('../../dist-electron/main/connections/modules/whatsapp/store.js');
const {
  ConnectionsService,
} = require('../../dist-electron/main/connections-service.js');
const { SecretsStore } = require('../../dist-electron/main/secrets-store.js');
const {
  RepositoryCollaborationService,
} = require('../../dist-electron/main/repository-collaboration/service.js');
const {
  RepositoryCollaborationStore,
} = require('../../dist-electron/main/repository-collaboration/store.js');
const {
  WhatsAppRepositoryTransport,
} = require('../../dist-electron/main/repository-collaboration/whatsapp-transport.js');

const waitFor = async (condition, description, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
};

test(
  'two authorized people collaborate from live WhatsApp through durable tasks, then add a second repository and receive results',
  { timeout: 30000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'forger-collaboration-flow-')),
    );
    const backendRoot = path.join(root, 'backend');
    const desktopRoot = path.join(root, 'desktop');
    for (const directory of [backendRoot, desktopRoot]) {
      await mkdir(directory);
      execFileSync('git', ['init', '--quiet', directory]);
    }
    const chatId = '120363123456789@g.us';
    const alice = '56911111111@s.whatsapp.net';
    const bob = '77123456@lid';
    const activatedAt = Date.now();
    const messageTimestamp = Math.ceil(activatedAt / 1000) + 1;
    const handlers = new Map();
    const runtimeEvents = [];
    const logs = [];
    const delivered = [];
    const received = [];
    const processed = [];
    const executions = [];
    let whatsappStore;
    let whatsappManager;
    let releaseFirst;
    let service;
    let collaborationStore;

    const rawMessage = (
      id,
      text,
      { fromMe = false, participant = bob, pushName = 'Bob' } = {},
    ) => ({
      key: {
        remoteJid: chatId,
        id,
        fromMe,
        ...(!fromMe ? { participant } : {}),
      },
      pushName,
      messageTimestamp,
      message: { conversation: text },
    });
    const socket = {
      user: { id: '56911111111:3@s.whatsapp.net' },
      ev: { on: (event, callback) => handlers.set(event, callback) },
      requestPairingCode: async () => {
        handlers.get('connection.update')({ connection: 'open' });
        return 'test-pairing';
      },
      groupMetadata: async (requested) => {
        assert.equal(requested, chatId);
        return {
          id: chatId,
          subject: 'Forger team',
          participants: [{ id: alice }, { id: bob }],
        };
      },
      sendMessage: async (target, content, options) => {
        assert.equal(target, chatId);
        const raw = rawMessage(`out-${delivered.length + 1}`, content.text, {
          fromMe: true,
          pushName: 'Alice',
        });
        delivered.push({ target, text: content.text, options, raw });
        // WhatsApp also echoes this device's outgoing messages. They must never create tasks.
        setImmediate(() =>
          handlers.get('messages.upsert')({ type: 'notify', messages: [raw] }),
        );
        return raw;
      },
      end: () => undefined,
    };
    const loadBaileys = async () => ({
      useMultiFileAuthState: async () => ({
        state: { creds: { registered: true, me: { id: socket.user.id } } },
        saveCreds: async () => undefined,
      }),
      default: () => socket,
    });

    // Inject only the socket dependency at the real factory boundary; all manager,
    // connection routing, normalizers, SQLite stores and transport logic stay real.
    t.mock.method(
      managerModule,
      'createWhatsAppConnectionManager',
      (context, options) => {
        whatsappStore = new WhatsAppLocalStore(context.metadataRoot);
        whatsappManager = new managerModule.WhatsAppConnectionManager(
          whatsappStore,
          options,
          loadBaileys,
        );
        return whatsappManager;
      },
    );
    const connections = new ConnectionsService({
      metadataRoot: path.join(root, 'metadata'),
      secretsStore: new SecretsStore(path.join(root, 'secrets')),
      emitEvent: (event) => runtimeEvents.push(event),
      appendLog: async (event, details) => logs.push({ event, details }),
    });
    t.after(async () => {
      releaseFirst?.();
      await connections.stop();
      await service?.stop();
      collaborationStore?.close();
      await whatsappManager?.stopListening();
      await whatsappStore?.clear();
      await rm(root, { recursive: true, force: true });
    });

    const configured = await connections.configure({
      type: 'whatsapp',
      label: 'Alice account',
    });
    assert.equal(configured.success, true);
    const connectionId = configured.instance.id;
    const paired = await connections.call({
      type: 'whatsapp',
      connectionId,
      actionId: 'whatsapp.start_pairing',
      input: { method: 'pairing_code', phoneNumber: '56911111111' },
    });
    assert.equal(paired.success, true);
    const status = await connections.call({
      type: 'whatsapp',
      connectionId,
      actionId: 'whatsapp.connection.status',
    });
    assert.equal(status.data.connected, true);
    handlers.get('chats.upsert')([{ id: chatId, subject: 'Forger team' }]);
    await waitFor(
      async () => Boolean(await whatsappStore.getChat(chatId)),
      'observed group',
    );

    collaborationStore = new RepositoryCollaborationStore(
      path.join(root, 'collaboration.sqlite'),
    );
    const transport = new WhatsAppRepositoryTransport(connections);
    service = new RepositoryCollaborationService({
      store: collaborationStore,
      transport,
      now: () => activatedAt,
      executor: {
        run: async (input) => {
          executions.push(input);
          if (executions.length === 1)
            await new Promise((resolve) => {
              releaseFirst = resolve;
            });
          assert.equal(input.signal.aborted, false);
          for (const repository of input.repositories)
            await writeFile(
              path.join(repository.root, 'flow-result.txt'),
              input.prompt,
            );
          return {
            text: `Resultado verificado: ${input.prompt}`,
            conversationId:
              input.conversationId ?? `conversation-${executions.length}`,
          };
        },
      },
    });
    connections.setWhatsAppMessageHandler(async (message) => {
      const persisted = await whatsappStore.readMessages({
        chatId,
        limit: 500,
      });
      assert.ok(
        persisted.some(
          (saved) => saved.stableMessageRef.id === message.messageId,
        ),
        'intake receives only persisted messages',
      );
      received.push(message);
      const claimed = await service.routeMessage(message);
      processed.push(message.messageId);
      return claimed;
    });
    const groups = await service.listGroups(connectionId);
    assert.deepEqual(groups, [{ chatId, title: 'Forger team' }]);
    const roster = await service.listParticipants(connectionId, chatId);
    assert.deepEqual(
      roster.map((person) => person.participantId).sort(),
      [alice, bob].sort(),
    );
    assert.equal(
      roster.find((person) => person.participantId === alice).isSelf,
      true,
    );

    const group = await service.configureGroup({
      connectionId,
      chatId,
      title: 'Forger team',
      enabled: false,
    });
    const backend = await service.addRepository({
      groupId: group.id,
      name: 'Backend',
      root: backendRoot,
    });
    for (const [participantId, displayName] of [
      [alice, 'Alice'],
      [bob, 'Bob'],
    ]) {
      await service.setAccess({
        groupId: group.id,
        participantId,
        displayName,
        repositoryIds: [backend.id],
      });
    }
    await service.configureGroup({
      connectionId,
      chatId,
      title: 'Forger team',
      enabled: true,
    });
    service.start();
    await connections.start();

    // A fresh timestamp is deliberate: event origin, not timestamp alone, excludes history.
    handlers.get('messaging-history.set')({
      messages: [rawMessage('history-1', 'Forger, Backend: historical change')],
      chats: [],
      contacts: [],
    });
    handlers.get('messages.upsert')({
      type: 'append',
      messages: [rawMessage('append-1', 'Forger, Backend: appended history')],
    });
    await waitFor(
      () => runtimeEvents.some((event) => event.phase === 'sync_ready'),
      'history sync completion',
    );
    await waitFor(
      async () =>
        (await whatsappStore.readMessages({ chatId, limit: 500 })).some(
          (message) => message.stableMessageRef.id === 'append-1',
        ),
      'append persisted',
    );
    assert.equal(received.length, 0);
    assert.equal(collaborationStore.tasks().length, 0);

    const first = rawMessage('alice-1', 'Forger, Backend: agrega exportación', {
      fromMe: true,
      pushName: 'Alice',
    });
    handlers.get('messages.upsert')({
      type: 'notify',
      messages: [first, first],
    });
    await waitFor(() => executions.length === 1, 'Alice first execution');
    assert.equal(
      collaborationStore.tasks().length,
      1,
      'the duplicate creates no extra durable task',
    );
    assert.equal(
      executions[0].task.participantId,
      alice,
      'own human messages use verified local identity',
    );
    assert.equal(executions[0].task.participantName, 'Alice');
    const parent = collaborationStore.tasks()[0];
    const continuation = rawMessage(
      'bob-1',
      `Forger, #${parent.id.slice(0, 8)} agrega selección múltiple`,
    );
    handlers.get('messages.upsert')({
      type: 'notify',
      messages: [continuation],
    });
    await waitFor(
      () => collaborationStore.tasks().length === 2,
      'Bob queued continuation',
    );
    const child = collaborationStore
      .tasks()
      .find((task) => task.parentTaskId === parent.id);
    assert.equal(child.status, 'queued');
    assert.equal(child.participantId, bob);
    assert.equal(
      executions.length,
      1,
      'the occupied checkout serializes the continuation',
    );
    releaseFirst();
    await waitFor(
      () =>
        collaborationStore.tasks().every((task) => task.status === 'completed'),
      'both turns complete',
    );
    assert.equal(executions.length, 2);
    assert.equal(executions[1].conversationId, 'conversation-1');
    assert.deepEqual(
      executions[1].repositories.map((repository) => repository.root),
      [backendRoot],
    );
    assert.equal(
      await readFile(path.join(backendRoot, 'flow-result.txt'), 'utf8'),
      'agrega selección múltiple',
    );

    // The group can grow without losing its existing conversation or granting access implicitly.
    const desktop = await service.addRepository({
      groupId: group.id,
      name: 'Desktop',
      root: desktopRoot,
    });
    assert.deepEqual(collaborationStore.allowedRepositoryIds(group.id, bob), [
      backend.id,
    ]);
    const forbidden = rawMessage(
      'bob-denied',
      'Forger, Desktop: cambia sin permiso',
    );
    handlers.get('messages.upsert')({ type: 'notify', messages: [forbidden] });
    await waitFor(
      () => processed.includes('bob-denied'),
      'ungranted request rejected through intake',
    );
    assert.equal(collaborationStore.tasks().length, 2);
    assert.equal(executions.length, 2);
    for (const [participantId, displayName] of [
      [alice, 'Alice'],
      [bob, 'Bob'],
    ]) {
      await service.setAccess({
        groupId: group.id,
        participantId,
        displayName,
        repositoryIds: [backend.id, desktop.id],
      });
    }
    const multi = rawMessage(
      'bob-2',
      'Forger, Backend + Desktop: conecta exportación',
    );
    handlers.get('messages.upsert')({
      type: 'notify',
      messages: [multi, multi],
    });
    await waitFor(
      () =>
        collaborationStore.tasks().length === 3 &&
        collaborationStore.tasks().every((task) => task.status === 'completed'),
      'authorized multi-repository change',
    );
    assert.equal(executions.length, 3);
    assert.deepEqual(
      executions[2].repositories.map((repository) => repository.root).sort(),
      [backendRoot, desktopRoot].sort(),
    );
    assert.equal(executions[2].task.participantId, bob);
    assert.equal(
      executions[2].conversationId,
      undefined,
      'a new request begins a separate conversation',
    );
    assert.equal(
      await readFile(path.join(desktopRoot, 'flow-result.txt'), 'utf8'),
      'conecta exportación',
    );

    // Exercise actual transport pacing, manager rate limits, quoted-message lookup and SQLite outbox ACKs.
    for (
      let attempt = 0;
      attempt < 5 &&
      collaborationStore.outbox().some((entry) => entry.status === 'pending');
      attempt++
    )
      await service.flushOutbox();
    assert.ok(collaborationStore.outbox().length >= 6);
    assert.ok(
      collaborationStore.outbox().every((entry) => entry.status === 'sent'),
    );
    assert.equal(delivered.length, collaborationStore.outbox().length);
    assert.ok(
      delivered.every((message) => message.text.startsWith('🤖 Forger')),
    );
    assert.ok(
      delivered.some((message) =>
        message.text.includes(
          'Resultado verificado: agrega selección múltiple',
        ),
      ),
    );
    assert.ok(
      delivered.some((message) =>
        message.text.includes('Resultado verificado: conecta exportación'),
      ),
    );
    assert.ok(
      delivered.every(
        (message) =>
          !message.options?.quoted ||
          message.options.quoted.key.remoteJid === chatId,
      ),
    );
    await waitFor(async () => (await whatsappStore.readMessages({ chatId, limit: 500 }))
      .some((message) => message.stableMessageRef.id === delivered.at(-1).raw.key.id), 'last automated echo persisted');
    assert.ok(!received.some((message) => message.messageId === delivered.at(-1).raw.key.id), 'outbound echoes never enter either operator');
    assert.equal(collaborationStore.tasks().length, 3);
    assert.equal(executions.length, 3);
    assert.ok(
      received
        .filter((message) => !message.automated)
        .every((message) => message.connectionId === connectionId),
    );
    assert.equal(
      logs.filter(
        (entry) =>
          entry.event.includes('delivery_failed') ||
          entry.event.includes('ingest_failed'),
      ).length,
      0,
    );
    const reopened = new RepositoryCollaborationStore(
      path.join(root, 'collaboration.sqlite'),
    );
    assert.equal(reopened.snapshot(connectionId).tasks.length, 3);
    assert.equal(reopened.snapshot(connectionId).repositories.length, 2);
    assert.ok(
      reopened
        .snapshot(connectionId)
        .repositories.every((repository) => !('root' in repository)),
    );
    reopened.close();
  },
);
