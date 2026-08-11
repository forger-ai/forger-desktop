import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3');

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

class FakeNotification {
  static isSupported() { return false; }
  on() {}
  show() {}
}

const delivery = (overrides = {}) => ({
  id: 101,
  sender: { id: 2, username: 'friend' },
  recipient: { id: 1, username: 'me' },
  targetUserId: 1,
  targetCloudDeviceId: 5,
  deviceUid: 'device-5',
  keyFingerprint: 'fingerprint-5',
  clientMessageId: 'delivery-101',
  messageType: 'CloudTextMessage',
  deliveryMode: 'persistent',
  source: 'user',
  ciphertext: JSON.stringify({ text: 'decrypted text' }),
  metadata: {},
  createdAt: '2026-08-10T00:00:00.000Z',
  expiresAt: '2026-09-10T00:00:00.000Z',
  ...overrides,
});

const createDeps = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-social-b17-'));
  const forwarded = [];
  const acknowledgements = [];
  const currentDevice = {
    id: 5,
    deviceUid: 'device-5',
    publicKey: 'sender-public',
    keyFingerprint: 'fingerprint-5',
  };
  const friend = {
    id: 2,
    username: 'friend',
    devices: [{ id: 8, deviceUid: 'device-8', publicKey: 'friend-public', keyFingerprint: 'fingerprint-8' }],
  };
  const backend = {
    listFriends: async () => [{ friend }],
    searchFriends: async () => [friend],
    listDevices: async () => [currentDevice],
    listCloudMessages: async () => [],
    listCloudMessageDeliveries: async () => [],
    ackCloudMessageDeliveries: async (deviceId, ids) => acknowledgements.push({ deviceId, ids }),
    sendCloudMessageDeliveries: async () => [],
    sendCloudAppShareDeliveries: async () => [],
    normalizeFriendshipPayload: (value) => value,
    normalizeCloudMessagePayload: (value) => value,
    normalizeCloudMessageDeliveryPayload: (value) => value,
  };
  const makeWindow = () => ({
    webContents: { send: (channel, payload) => forwarded.push({ channel, payload }) },
    isDestroyed: () => false,
    isFocused: () => false,
  });
  const deps = {
    BetterSqlite3,
    CLAUDE_CODE_VERSION: '1.2.3',
    DEFAULT_NODE_VERSION: '22.0.0',
    CloudIdentityStore: class {},
    app: { getPath: () => root },
    appWindows: new Map([['app', makeWindow()]]),
    canRunCommand: async () => false,
    cloudDeviceManager: { getState: async () => ({ currentDevice }) },
    cloudIdentityStore: {
      getPublicRegistration: async () => ({ keyFingerprint: 'fingerprint-5' }),
      encryptFor: (publicKey, text, keyFingerprint) => ({ publicKey, text, keyFingerprint }),
      decrypt: async (payload) => {
        if (payload.fail) throw new Error('decrypt failed');
        return payload.text;
      },
    },
    ensureRuntimeInstalled: async () => ({ npm: 'npm', bin: root }),
    existsFile: async () => false,
    forgerAccount: { authenticated: true, user: { id: 1, username: 'me' } },
    forgerBackendClient: backend,
    friendChatWindows: new Map([[2, makeWindow()]]),
    fs,
    getClaudeRoot: () => path.join(root, 'claude'),
    getCloudIdentityPath: () => path.join(root, 'identity.json'),
    getSocialMessagesPath: () => path.join(root, 'social.sqlite'),
    getRuntimePathEntries: () => [],
    mainWindow: makeWindow(),
    openOrFocusFriendChatWindowForFriend: async () => ({ success: true }),
    path,
    registry: { apps: {} },
    runCommand: async () => undefined,
    runCommandCapture: async () => ({ code: 1, stdout: '', stderr: '' }),
    ...overrides,
  };
  return { root, deps, backend, friend, currentDevice, acknowledgements, forwarded };
};

const withController = async (fixture, operation) => await withMockedElectron(
  { Notification: FakeNotification },
  async (mockRequire) => {
    clearDistModule('main/cloud/social-relay.js');
    const { createCloudSocialRelayController } = mockRequire('../../dist-electron/main/cloud/social-relay.js');
    return await operation(createCloudSocialRelayController(fixture.deps));
  },
);

test('given pending cloud deliveries, text and app-share payloads decrypt, persist, acknowledge, and list locally', async () => {
  const fixture = await createDeps();
  const appShare = { id: 9, userAppId: 10, shareKind: 'public_app', appVisibilityAtSend: 'public', appNameSnapshot: 'App', appSlugSnapshot: 'app', appOwnerUsernameSnapshot: 'me' };
  fixture.backend.listCloudMessageDeliveries = async () => [
    delivery(),
    delivery({ id: 102, clientMessageId: 'delivery-102', messageType: 'CloudAppShareMessage', appShare, ciphertext: JSON.stringify({ fail: true }) }),
  ];
  try {
    await withController(fixture, async (controller) => {
      const stored = await controller.processPendingCloudMessageDeliveries();
      assert.equal(stored.length, 2);
      assert.equal(stored[0].plaintext, 'decrypted text');
      assert.equal(stored[1].type, 'CloudAppShareMessage');
      assert.equal(stored[1].plaintext, undefined);
      assert.deepEqual(fixture.acknowledgements, [{ deviceId: 5, ids: [101, 102] }]);
      const listed = await controller.listLocalCloudMessages(2);
      assert.deepEqual(listed.map((message) => message.clientMessageId), ['delivery-101', 'delivery-102']);
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('given unavailable delivery dependencies, missing devices, and an empty inbox, polling returns without acknowledgement', async () => {
  for (const overrides of [
    { forgerBackendClient: null },
    { cloudDeviceManager: null },
    { cloudDeviceManager: { getState: async () => ({ currentDevice: null }) } },
  ]) {
    const fixture = await createDeps(overrides);
    try {
      await withController(fixture, async (controller) => {
        assert.deepEqual(await controller.processPendingCloudMessageDeliveries(), []);
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
  const fixture = await createDeps();
  try {
    await withController(fixture, async (controller) => {
      assert.deepEqual(await controller.processPendingCloudMessageDeliveries(), []);
      assert.deepEqual(fixture.acknowledgements, []);
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('given legacy history succeeds or fails, local history remains available and imports only valid decryptions', async () => {
  for (const legacyFailure of [false, true]) {
    const fixture = await createDeps();
    fixture.backend.listCloudMessages = async () => {
      if (legacyFailure) throw new Error('offline');
      return [{
        id: 50,
        type: 'CloudTextMessage',
        sender: fixture.friend,
        recipient: { id: 1, username: 'me' },
        deliveryMode: 'persistent',
        source: 'user',
        status: 'stored',
        metadata: {},
        envelopes: [{ ciphertext: JSON.stringify({ text: 'legacy' }) }],
        createdAt: '2026-08-09T00:00:00.000Z',
      }];
    };
    try {
      await withController(fixture, async (controller) => {
        const listed = await controller.listLocalCloudMessages(2);
        assert.equal(listed.length, legacyFailure ? 0 : 1);
        if (!legacyFailure) assert.equal(listed[0].plaintext, 'legacy');
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('given delivery encryption limits, missing account, absent keys, deduplication, and maximum device count are enforced', async () => {
  const missingAccount = await createDeps({ forgerAccount: { authenticated: false } });
  try {
    await withController(missingAccount, async (controller) => {
      await assert.rejects(() => controller.buildEncryptedDeliveries(missingAccount.friend, 'hello'), /forger_account_missing/);
    });
  } finally {
    await fs.rm(missingAccount.root, { recursive: true, force: true });
  }

  const fixture = await createDeps();
  try {
    await withController(fixture, async (controller) => {
      fixture.backend.listDevices = async () => [];
      await assert.rejects(
        () => controller.buildEncryptedDeliveries({ id: 2, username: 'empty', devices: [] }, 'hello'),
        (error) => error.technicalCode === 'cloud_delivery_key_missing',
      );
      fixture.backend.listDevices = async () => [{ ...fixture.currentDevice, id: 8 }];
      const deduplicated = await controller.buildEncryptedDeliveries(fixture.friend, 'hello');
      assert.equal(deduplicated.length, 1);
      const tooMany = Array.from({ length: 21 }, (_value, index) => ({
        id: index + 20, deviceUid: `device-${index}`, publicKey: `key-${index}`,
      }));
      fixture.backend.listDevices = async () => [];
      await assert.rejects(
        () => controller.buildEncryptedDeliveries({ id: 2, username: 'many', devices: tooMany }, 'hello'),
        (error) => error.technicalCode === 'cloud_delivery_too_many_devices',
      );
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('given an app share, recipient lookup, current-device preference, fallback delivery, acknowledgement, and missing delivery are explicit', async () => {
  const fixture = await createDeps();
  const share = { id: 4, userAppId: 44, shareKind: 'public_app', appVisibilityAtSend: 'public', appNameSnapshot: 'Shared', appSlugSnapshot: 'shared', appOwnerUsernameSnapshot: 'me' };
  const makeResult = (targetCloudDeviceId, includeShare = true) => delivery({
    id: 301 + targetCloudDeviceId,
    targetCloudDeviceId,
    messageType: 'CloudAppShareMessage',
    ...(includeShare ? { appShare: share } : {}),
  });
  try {
    await withController(fixture, async (controller) => {
      fixture.backend.sendCloudAppShareDeliveries = async () => [makeResult(9), makeResult(5)];
      let result = await controller.sendEncryptedCloudAppShareMessage({ recipientUserId: 2, userAppId: 44, clientMessageId: 'share-current' });
      assert.equal(result.type, 'CloudAppShareMessage');
      assert.equal(result.localState, 'sent');
      assert.deepEqual(fixture.acknowledgements.at(-1), { deviceId: 5, ids: [306] });

      fixture.deps.cloudDeviceManager.getState = async () => ({ currentDevice: null });
      fixture.backend.sendCloudAppShareDeliveries = async () => [makeResult(9)];
      result = await controller.sendEncryptedCloudAppShareMessage({ recipientUsername: '@friend', userAppId: 44 });
      assert.equal(result.appShare.id, 4);

      fixture.backend.sendCloudAppShareDeliveries = async () => [makeResult(9, false)];
      await assert.rejects(
        () => controller.sendEncryptedCloudAppShareMessage({ recipientUsername: 'friend', userAppId: 44 }),
        /cloud_app_share_delivery_missing/,
      );
      fixture.backend.searchFriends = async () => [];
      await assert.rejects(
        () => controller.sendEncryptedCloudAppShareMessage({ recipientUsername: 'missing', userAppId: 44 }),
        /recipient_not_found/,
      );
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  const missingBackend = await createDeps({ forgerBackendClient: null });
  try {
    await withController(missingBackend, async (controller) => {
      await assert.rejects(() => controller.sendEncryptedCloudAppShareMessage({ recipientUserId: 2, userAppId: 44 }), /backend_client_missing/);
    });
  } finally {
    await fs.rm(missingBackend.root, { recursive: true, force: true });
  }
});

test('given message delivery failure and heartbeat polling, pending state fails safely and stored events forward to every surface', async () => {
  const fixture = await createDeps();
  fixture.backend.sendCloudMessageDeliveries = async () => { throw new Error('network offline'); };
  try {
    await withController(fixture, async (controller) => {
      await assert.rejects(
        () => controller.sendEncryptedCloudMessage({ recipientUsername: 'friend', text: 'will fail', clientMessageId: 'failed-message' }),
        /network offline/,
      );
      fixture.backend.listCloudMessageDeliveries = async () => [delivery({ id: 909, clientMessageId: 'heartbeat-message' })];
      await controller.handleCloudSocialEvent({ type: 'heartbeat_ack' });
      assert.equal(fixture.forwarded.some((entry) => entry.payload.message?.clientMessageId === 'heartbeat-message'), true);
      assert.deepEqual(fixture.acknowledgements.at(-1), { deviceId: 5, ids: [909] });

      fixture.backend.listCloudMessageDeliveries = async () => { throw new Error('poll offline'); };
      await controller.handleCloudSocialEvent({ type: 'heartbeat_ack' });
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('given numeric recipients, message lookup selects by id while an absent app-share friend stops before search', async () => {
  const fixture = await createDeps();
  fixture.backend.sendCloudMessageDeliveries = async (input) => input.deliveries.map((item, index) => delivery({
    id: 700 + index,
    targetCloudDeviceId: item.cloudDeviceId,
    clientMessageId: input.clientMessageId,
  }));
  try {
    await withController(fixture, async (controller) => {
      const sent = await controller.sendEncryptedCloudMessage({ recipientUserId: 2, text: 'by id' });
      assert.equal(sent.localState, 'sent');
      fixture.backend.listFriends = async () => [];
      await assert.rejects(
        () => controller.sendEncryptedCloudAppShareMessage({ recipientUserId: 404, userAppId: 1 }),
        /recipient_not_found/,
      );
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('given delivery events, normalization rejection, acknowledgement failure, and absent current device remain nonfatal', async () => {
  for (const mode of ['invalid', 'ack-fails', 'no-device']) {
    const fixture = await createDeps();
    if (mode === 'invalid') fixture.backend.normalizeCloudMessageDeliveryPayload = () => null;
    if (mode === 'ack-fails') fixture.backend.ackCloudMessageDeliveries = async () => { throw new Error('ack offline'); };
    if (mode === 'no-device') fixture.deps.cloudDeviceManager = null;
    try {
      await withController(fixture, async (controller) => {
        const result = await controller.prepareCloudSocialEvent({ type: 'cloud_message_delivery', delivery: delivery() });
        if (mode === 'invalid') assert.equal(result, null);
        else assert.equal(result.type, 'cloud_message');
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('given Claude CLI version and platform boundaries, exact managed installs are reused and fallbacks remain explicit', async () => {
  const fixture = await createDeps();
  const managed = path.join(fixture.root, 'claude', 'node_modules', '.bin', 'claude');
  const packageJson = path.join(fixture.root, 'claude', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
  await fs.mkdir(path.dirname(packageJson), { recursive: true });
  await fs.writeFile(packageJson, JSON.stringify({ version: '1.2.3' }));
  fixture.deps.existsFile = async (candidate) => candidate === managed;
  fixture.deps.canRunCommand = async (candidate) => candidate === managed;
  try {
    await withController(fixture, async (controller) => {
      assert.equal(await controller.ensureClaudeCliInstalled(), managed);
      assert.deepEqual(await controller.resolveClaudeCli(), { path: managed, source: 'managed' });
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  for (const versionValue of [17, undefined]) {
    const next = await createDeps();
    const nextPackage = path.join(next.root, 'claude', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
    await fs.mkdir(path.dirname(nextPackage), { recursive: true });
    await fs.writeFile(nextPackage, JSON.stringify({ version: versionValue }));
    const nextManaged = path.join(next.root, 'claude', 'node_modules', '.bin', 'claude');
    next.deps.existsFile = async (candidate) => candidate === nextManaged || candidate.endsWith('package.json');
    next.deps.canRunCommand = async (candidate) => candidate === nextManaged;
    let installed = false;
    next.deps.runCommand = async () => { installed = true; };
    try {
      await withController(next, async (controller) => {
        assert.equal(await controller.ensureClaudeCliInstalled(), nextManaged);
        assert.equal(installed, true);
      });
    } finally {
      await fs.rm(next.root, { recursive: true, force: true });
    }
  }

  const system = await createDeps({
    runCommandCapture: async (command) => ({ code: 0, stdout: command === 'where' ? 'C:\\bin\\claude.cmd\r\n' : '', stderr: '' }),
    canRunCommand: async () => true,
  });
  try {
    await withController(system, async (controller) => {
      assert.equal(await withPlatform('win32', () => controller.resolveSystemClaudeCliPath()), 'C:\\bin\\claude.cmd');
    });
  } finally {
    await fs.rm(system.root, { recursive: true, force: true });
  }

  const absent = await createDeps();
  try {
    await withController(absent, async (controller) => {
      assert.equal(await controller.resolveClaudeCli(), null);
    });
  } finally {
    await fs.rm(absent.root, { recursive: true, force: true });
  }
});

test('given identity and account fallbacks, envelope preference, account storage, and missing-recipient branches stay deterministic', async () => {
  const fixture = await createDeps();
  try {
    await withController(fixture, async (controller) => {
      const decrypted = await controller.decryptCloudMessage({
        sender: fixture.friend,
        recipient: { id: 1, username: 'me' },
        envelopes: [
          { keyFingerprint: 'other', ciphertext: JSON.stringify({ fail: true }) },
          { keyFingerprint: 'fingerprint-5', ciphertext: JSON.stringify({ text: 'preferred' }) },
        ],
      });
      assert.equal(decrypted.plaintext, 'preferred');
      const withoutPreferred = await controller.decryptCloudMessage({
        sender: fixture.friend,
        recipient: { id: 1, username: 'me' },
        envelopes: [{ ciphertext: JSON.stringify({ text: 'fallback' }) }],
      });
      assert.equal(withoutPreferred.plaintext, 'fallback');
      await assert.rejects(
        () => controller.buildEncryptedEnvelopes({}, 'missing'),
        (error) => error.technicalCode === 'recipient_cloud_key_missing',
      );
      fixture.backend.listDevices = async () => [fixture.currentDevice];
      assert.equal((await controller.buildEncryptedDeliveries({ id: 2, username: 'friend' }, 'own only')).length, 1);
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  const noBackend = await createDeps({ forgerBackendClient: null });
  try {
    await withController(noBackend, async (controller) => {
      assert.equal((await controller.buildEncryptedDeliveries({
        id: 2,
        username: 'friend',
        devices: [{ id: 8, deviceUid: 'friend', publicKey: 'key' }],
      }, 'recipient only')).length, 1);
    });
  } finally {
    await fs.rm(noBackend.root, { recursive: true, force: true });
  }

  const noUser = await createDeps({ forgerAccount: { authenticated: false, user: undefined } });
  try {
    await withController(noUser, async (controller) => {
      await assert.rejects(
        () => controller.sendEncryptedCloudMessage({ recipientUsername: 'friend', text: 'pending before account guard' }),
        /forger_account_missing/,
      );
      await controller.getSocialMessageStore().listMessages(2);
    });
  } finally {
    await fs.rm(noUser.root, { recursive: true, force: true });
  }

  const noFriendName = await createDeps();
  noFriendName.backend.listFriends = async () => [];
  try {
    await withController(noFriendName, async (controller) => {
      await assert.rejects(
        () => controller.sendEncryptedCloudMessage({ recipientUserId: 404, text: 'missing' }),
        /recipient_not_found/,
      );
      noFriendName.backend.normalizeCloudMessagePayload = () => null;
      assert.equal(await controller.prepareCloudSocialEvent({ type: 'cloud_message', message: {} }), null);
    });
  } finally {
    await fs.rm(noFriendName.root, { recursive: true, force: true });
  }
});

test('given PATH is absent during managed installation, runtime path construction uses its empty fallback', async () => {
  const fixture = await createDeps();
  const originalPath = process.env.PATH;
  let observedPath;
  fixture.deps.runCommand = async (_command, _args, options) => { observedPath = options.env.PATH; };
  let installed = false;
  const managed = path.join(fixture.root, 'claude', 'node_modules', '.bin', 'claude');
  fixture.deps.existsFile = async (candidate) => installed && candidate === managed;
  fixture.deps.canRunCommand = async (candidate) => candidate === managed;
  fixture.deps.runCommand = async (_command, _args, options) => {
    observedPath = options.env.PATH;
    installed = true;
  };
  try {
    delete process.env.PATH;
    await withController(fixture, async (controller) => {
      assert.equal(await controller.ensureClaudeCliInstalled(), managed);
      assert.equal(typeof observedPath, 'string');
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
