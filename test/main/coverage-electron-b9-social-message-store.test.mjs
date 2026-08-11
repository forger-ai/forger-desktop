import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SocialMessageStore } = require('../../dist-electron/main/cloud/social-message-store.js');

class FakeDatabase {
  static instances = [];

  constructor(filename) {
    this.filename = filename;
    this.rows = [];
    this.executed = [];
    FakeDatabase.instances.push(this);
  }

  exec(sql) {
    this.executed.push(sql);
  }

  prepare(sql) {
    if (/SELECT \* FROM social_messages/i.test(sql)) {
      return {
        all: (friendUserId) => this.rows.filter((row) => row.friend_user_id === friendUserId),
      };
    }
    if (/INSERT INTO social_messages/i.test(sql)) {
      return {
        run: (params) => {
          this.rows.push({
            id: this.rows.length + 1,
            message_key: params.messageKey,
            client_message_id: params.clientMessageId,
            cloud_message_id: params.cloudMessageId,
            friend_user_id: params.friendUserId,
            type: params.type,
            sender_json: params.senderJson,
            recipient_json: params.recipientJson,
            delivery_mode: params.deliveryMode,
            source: params.source,
            source_app_id: params.sourceAppId,
            source_app_name: params.sourceAppName,
            status: params.status,
            local_state: params.localState,
            metadata_json: params.metadataJson,
            app_share_json: params.appShareJson,
            plaintext: params.plaintext,
            created_at: params.createdAt,
            updated_at: params.updatedAt,
          });
        },
      };
    }
    if (/UPDATE social_messages/i.test(sql)) {
      return {
        run: (localState, updatedAt, clientMessageId) => {
          const row = this.rows.find((candidate) => candidate.client_message_id === clientMessageId);
          if (row) {
            row.local_state = localState;
            row.updated_at = updatedAt;
          }
        },
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

const user = { id: 1, username: 'owner' };
const friend = { id: 2, username: 'friend' };
const baseMessage = (overrides = {}) => ({
  type: 'CloudTextMessage',
  sender: user,
  recipient: friend,
  deliveryMode: 'persistent',
  source: 'user',
  status: 'stored',
  metadata: {},
  envelopes: [],
  createdAt: '2026-08-10T12:00:00.000Z',
  ...overrides,
});

test('Given account-scoped persistence, messages use stable keys, defaults, cache reuse, and state updates', async (t) => {
  FakeDatabase.instances.length = 0;
  const root = await mkdtemp(join(tmpdir(), 'forger-social-store-b9-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let accountKey;
  const store = new SocialMessageStore({
    BetterSqlite3: FakeDatabase,
    filePath: join(root, 'messages'),
    accountStorageKey: () => accountKey,
    currentUserId: () => user.id,
  });

  const outgoing = await store.upsertMessage(baseMessage({
    clientMessageId: 'client-1',
    plaintext: 'hello',
    metadata: undefined,
  }), 'pending');
  assert.equal(outgoing.localState, 'pending');
  assert.equal(FakeDatabase.instances[0].filename, join(root, 'messages-default.sqlite'));
  assert.match(FakeDatabase.instances[0].executed[0], /CREATE TABLE IF NOT EXISTS social_messages/);

  await store.markState('client-1', 'failed');
  const listed = await store.listMessages(friend.id);
  assert.equal(FakeDatabase.instances.length, 1, 'same account reuses its database');
  assert.equal(listed[0].localState, 'failed');
  assert.deepEqual(listed[0].metadata, null);

  const inbound = await store.upsertMessage(baseMessage({
    id: 22,
    sender: friend,
    recipient: user,
    status: 'delivered',
  }));
  assert.equal(inbound.localState, 'received');

  const sentByDefault = await store.upsertMessage(baseMessage({
    clientMessageId: 'client-sent',
    plaintext: 'default state',
  }));
  assert.equal(sentByDefault.localState, 'sent');

  const sharedApp = await store.upsertMessage(baseMessage({
    id: 23,
    type: 'CloudAppShareMessage',
    appShare: { appId: 'notes' },
  }), 'sent');
  assert.equal(sharedApp.type, 'CloudAppShareMessage');

  const local = await store.upsertMessage(baseMessage({
    sender: friend,
    recipient: user,
    createdAt: '2026-08-10T12:01:00.000Z',
    updatedAt: '2026-08-10T12:02:00.000Z',
  }), 'sent');
  assert.equal(local.localState, 'sent');
  assert.deepEqual(FakeDatabase.instances[0].rows.map((row) => row.message_key), [
    'client:client-1',
    'cloud:22',
    'client:client-sent',
    'cloud:23',
    'local:2:1:2026-08-10T12:01:00.000Z',
  ]);
});

test('Given raw persisted rows, listing normalizes every supported variant and discards malformed app shares', async (t) => {
  FakeDatabase.instances.length = 0;
  const root = await mkdtemp(join(tmpdir(), 'forger-social-rows-b9-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let accountKey = 'person/one';
  const store = new SocialMessageStore({
    BetterSqlite3: FakeDatabase,
    filePath: join(root, 'social.db'),
    accountStorageKey: () => accountKey,
    currentUserId: () => user.id,
  });

  await store.listMessages(friend.id);
  const firstDb = FakeDatabase.instances[0];
  assert.equal(firstDb.filename, join(root, 'social-person_one.db'));
  const completeRow = {
    friend_user_id: friend.id,
    type: 'CloudTextMessage',
    cloud_message_id: 1,
    sender_json: JSON.stringify(user),
    recipient_json: JSON.stringify(friend),
    delivery_mode: 'ephemeral',
    source: 'app',
    source_app_id: 'notes',
    source_app_name: 'Notes',
    status: 'delivered',
    client_message_id: 'client-complete',
    metadata_json: JSON.stringify({ trace: true }),
    plaintext: 'payload',
    created_at: '2026-08-10T12:00:00.000Z',
    updated_at: '2026-08-10T12:00:01.000Z',
    local_state: 'pending',
  };
  firstDb.rows.push(
    completeRow,
    { ...completeRow, cloud_message_id: 2, client_message_id: 'failed', status: 'not_delivered', local_state: 'failed' },
    { ...completeRow, cloud_message_id: 3, client_message_id: 'received', status: 'pending_permission', local_state: 'received' },
    { ...completeRow, cloud_message_id: 4, client_message_id: 'blocked', status: 'blocked', local_state: 'unexpected' },
    {
      friend_user_id: friend.id,
      type: 'unexpected',
      cloud_message_id: 'not-a-number',
      sender_json: null,
      recipient_json: null,
      delivery_mode: 'unknown',
      source: 'unknown',
      source_app_id: 5,
      source_app_name: null,
      status: 'unknown',
      client_message_id: null,
      metadata_json: null,
      plaintext: null,
      created_at: null,
      updated_at: null,
      local_state: null,
    },
    { ...completeRow, cloud_message_id: 5, client_message_id: 'bad-json', recipient_json: '{bad json' },
    { ...completeRow, type: 'CloudAppShareMessage', app_share_json: JSON.stringify({ appId: 'notes' }) },
    { ...completeRow, type: 'CloudAppShareMessage', app_share_json: '{bad json' },
    { ...completeRow, type: 'CloudAppShareMessage', app_share_json: null },
  );

  const listed = await store.listMessages(friend.id);
  assert.equal(listed.length, 7);
  assert.deepEqual(listed[0], {
    id: 1,
    type: 'CloudTextMessage',
    sender: user,
    recipient: friend,
    deliveryMode: 'ephemeral',
    source: 'app',
    sourceAppId: 'notes',
    sourceAppName: 'Notes',
    status: 'delivered',
    clientMessageId: 'client-complete',
    metadata: { trace: true },
    envelopes: [],
    plaintext: 'payload',
    createdAt: '2026-08-10T12:00:00.000Z',
    updatedAt: '2026-08-10T12:00:01.000Z',
    localState: 'pending',
  });
  assert.deepEqual(listed[4], {
    id: undefined,
    type: 'CloudTextMessage',
    sender: { id: 0, username: '' },
    recipient: { id: 0, username: '' },
    deliveryMode: 'persistent',
    source: 'user',
    sourceAppId: undefined,
    sourceAppName: undefined,
    status: 'stored',
    clientMessageId: undefined,
    metadata: {},
    envelopes: [],
    plaintext: undefined,
    createdAt: new Date(0).toISOString(),
    updatedAt: undefined,
    localState: 'sent',
  });
  assert.deepEqual(listed[6].appShare, { appId: 'notes' });

  accountKey = 'person-two';
  await store.listMessages(friend.id);
  assert.equal(FakeDatabase.instances.length, 2, 'changing accounts switches database files');
  assert.equal(FakeDatabase.instances[1].filename, join(root, 'social-person-two.db'));
});

test('Given unavailable SQLite, persistence fails with the stable diagnostic code', async () => {
  const store = new SocialMessageStore({
    BetterSqlite3: null,
    filePath: '/unused/messages.sqlite',
    accountStorageKey: () => 'account',
    currentUserId: () => undefined,
  });
  await assert.rejects(store.listMessages(2), /social_message_store_sqlite_unavailable/);
});
