import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));
const bufferText = (value) => Buffer.from(value).toString('utf8');
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
  static supported = true;
  static shown = [];

  static isSupported() {
    return FakeNotification.supported;
  }

  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    FakeNotification.shown.push(this);
  }

  on(event, listener) {
    this.listeners.set(event, listener);
  }

  show() {
    this.visible = true;
  }

  click() {
    this.listeners.get('click')?.();
  }
}

const createSocialDeps = (overrides = {}) => {
  const sentToWindows = [];
  const makeWindow = (focused = false) => ({
    webContents: {
      send: (channel, payload) => sentToWindows.push({ channel, payload }),
    },
    isDestroyed: () => false,
    isFocused: () => focused,
  });
  const openedFriends = [];
  const deps = {
    CLAUDE_CODE_VERSION: '1.0.0',
    DEFAULT_NODE_VERSION: '22.0.0',
    CloudIdentityStore: class {},
    app: { getPath: () => os.tmpdir() },
    appAgentTaskManager: {
      start: async (_appId, input) => ({ runId: 'run-1', input }),
      get: () => ({ runId: 'run-1', status: 'running' }),
      cancel: () => ({ success: true }),
    },
    appWindows: new Map([['finance-os', makeWindow()]]),
    canRunCommand: async () => true,
    cloudDeviceManager: {
      getState: async () => ({
        currentDevice: {
          id: 5,
          deviceUid: 'sender-device',
          publicKey: 'sender-public',
          keyFingerprint: 'sender-fingerprint',
        },
      }),
    },
    cloudIdentityStore: {
      encryptFor: (publicKey, text, keyFingerprint) => ({
        algorithm: 'rsa-oaep-sha256+aes-256-gcm',
        publicKey,
        text,
        keyFingerprint,
      }),
      decrypt: async (payload) => payload.text,
    },
    ensureRuntimeInstalled: async () => ({ bin: os.tmpdir(), npm: 'npm' }),
    existsFile: async () => false,
    fetchBodyFromBuffer: (body) => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    forgerAccount: { authenticated: true, user: { id: 1, username: 'me', email: 'me@example.com' } },
    forgerBackendClient: {
      listFriends: async () => [{ friend: { id: 2, username: 'friend' } }],
      searchFriends: async () => [{
        id: 2,
        username: 'friend',
        devices: [{ id: 8, deviceUid: 'friend-device', publicKey: 'friend-public', keyFingerprint: 'friend-fingerprint' }],
      }],
      sendCloudMessage: async (input) => ({
        id: 10,
        sender: { id: 1, username: 'me' },
        recipient: { id: input.recipientUserId, username: 'friend' },
        text: input.text,
        envelopes: input.envelopes,
        createdAt: '2026-05-21T00:00:00Z',
        updatedAt: '2026-05-21T00:00:00Z',
      }),
      normalizeFriendshipPayload: (friendship) => ({ id: Number(friendship.id), friend: { id: 2, username: 'friend' } }),
      normalizeCloudMessagePayload: (message) => message,
    },
    friendChatWindows: new Map(),
    fs,
    getClaudeRoot: () => os.tmpdir(),
    getCloudIdentityPath: () => path.join(os.tmpdir(), 'identity.json'),
    getCodexAuthStatus: async () => ({ authenticated: true }),
    getRuntimePathEntries: () => [],
    getRuntimeStatus: () => ({ status: 'running' }),
    mainWindow: makeWindow(),
    openInstalledAppUnlocked: async () => ({ success: true }),
    openOrFocusFriendChatWindowForFriend: async (friend) => {
      openedFriends.push(friend);
      return { success: true };
    },
    path,
    registry: { apps: { 'finance-os': { installDir: path.join(os.tmpdir(), 'finance-os') } } },
    resolveInstalledAgents: async () => [{ id: 'assistant', name: 'Assistant' }],
    runCommand: async () => undefined,
    runCommandCapture: async () => ({ code: 1, stdout: '', stderr: '' }),
    runningApps: new Map([['finance-os', { frontendUrl: 'http://app.local/' }]]),
    ...overrides,
  };
  return { deps, sentToWindows, openedFriends };
};

test('cloud social relay blocks unsafe paths, proxies allowed requests, and serves app internal actions', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await withMockedElectron({ Notification: FakeNotification }, async (require) => {
    clearDistModule('main/cloud/social-relay.js');
    const { createCloudSocialRelayController } = require('../../dist-electron/main/cloud/social-relay.js');
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response('ok', {
        status: 201,
        headers: {
          'content-type': 'text/plain',
          'x-secret': 'nope',
          etag: 'abc',
        },
      });
    };
    const { deps } = createSocialDeps();
    const controller = createCloudSocialRelayController(deps);

    const blocked = await controller.handleCloudRelayRequest({
      request_id: 'blocked',
      app_id: 'finance-os',
      method: 'GET',
      path: '/../secrets',
    });
    const encodedBlocked = await controller.handleCloudRelayRequest({
      request_id: 'encoded-blocked',
      app_id: 'finance-os',
      method: 'GET',
      path: '/%2e%2e/secrets',
    });
    const proxied = await controller.handleCloudRelayRequest({
      request_id: 'proxied',
      app_id: 'finance-os',
      method: 'POST',
      path: 'api/import',
      headers: { 'content-type': 'application/json' },
      body: [...Buffer.from('{"ok":true}')],
    });
    const context = await controller.handleCloudRelayRequest({
      request_id: 'context',
      app_id: 'finance-os',
      method: 'POST',
      path: '/__forger_internal/forger_app/context',
      body: [],
    });
    const start = await controller.handleCloudForgerAppRequest({
      request_id: 'start',
      app_id: 'finance-os',
      method: 'POST',
      path: '',
      body: [...Buffer.from('{"prompt":"hello"}')],
    }, '/__forger_internal/forger_app/codex-task/start');
    const invalidJson = await controller.handleCloudForgerAppRequest({
      request_id: 'bad-json',
      app_id: 'finance-os',
      method: 'POST',
      path: '',
      body: [...Buffer.from('{bad json')],
    }, '/__forger_internal/forger_app/codex-task/start');

    assert.equal(blocked.status, 403);
    assert.equal(Buffer.from(blocked.body).toString('utf8'), 'path_blocked');
    assert.equal(encodedBlocked.status, 403);
    assert.equal(Buffer.from(encodedBlocked.body).toString('utf8'), 'path_blocked');
    assert.equal(proxied.status, 201);
    assert.deepEqual(proxied.headers, { 'content-type': 'text/plain', etag: 'abc' });
    assert.equal(requests[0].url, 'http://app.local/api/import');
    assert.equal(bufferText(requests[0].init.body), '{"ok":true}');
    assert.deepEqual(JSON.parse(Buffer.from(context.body).toString('utf8')), {
      agents: [{ id: 'assistant', name: 'Assistant' }],
    });
    assert.equal(JSON.parse(Buffer.from(start.body).toString('utf8')).input.prompt, 'hello');
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(JSON.parse(Buffer.from(invalidJson.body).toString('utf8')), { error: 'invalid_json_body' });
  });
});

test('cloud social relay normalizes open/proxy failures and internal action fallbacks', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await withMockedElectron({ Notification: FakeNotification }, async (require) => {
    clearDistModule('main/cloud/social-relay.js');
    const { createCloudSocialRelayController } = require('../../dist-electron/main/cloud/social-relay.js');

    const openBlocked = createCloudSocialRelayController(createSocialDeps({
      openInstalledAppUnlocked: async () => ({ success: false, technicalCode: 'app_install_missing' }),
    }).deps);
    const openResponse = await openBlocked.handleCloudRelayRequest({
      request_id: 'open-failed',
      app_id: 'finance-os',
      method: 'GET',
      path: '/api',
    });
    assert.equal(openResponse.status, 424);
    assert.equal(bufferText(openResponse.body), 'app_install_missing');

    const notRunning = createCloudSocialRelayController(createSocialDeps({
      runningApps: new Map(),
    }).deps);
    const notRunningResponse = await notRunning.handleCloudRelayRequest({
      request_id: 'not-running',
      app_id: 'finance-os',
      method: 'GET',
      path: '/api',
    });
    assert.equal(notRunningResponse.status, 424);
    assert.equal(bufferText(notRunningResponse.body), 'app_not_running');

    globalThis.fetch = async () => {
      throw new Error('proxy exploded');
    };
    const proxy = createCloudSocialRelayController(createSocialDeps().deps);
    const proxyError = await proxy.handleCloudRelayRequest({
      request_id: 'proxy-error',
      app_id: 'finance-os',
      method: 'GET',
      path: '/api',
    });
    assert.equal(proxyError.status, 502);
    assert.equal(bufferText(proxyError.body), 'proxy exploded');

    const unavailableTasks = createCloudSocialRelayController(createSocialDeps({
      appAgentTaskManager: null,
    }).deps);
    const method = await unavailableTasks.handleCloudForgerAppRequest({
      request_id: 'method',
      app_id: 'finance-os',
      method: 'GET',
      path: '',
      body: [],
    }, '/__forger_internal/forger_app/ai-subscription-status');
    const subscription = await unavailableTasks.handleCloudForgerAppRequest({
      request_id: 'subscription',
      app_id: 'finance-os',
      method: 'POST',
      path: '',
      body: [],
    }, '/__forger_internal/forger_app/ai-subscription-status/');
    const start = await unavailableTasks.handleCloudForgerAppRequest({
      request_id: 'start-missing',
      app_id: 'finance-os',
      method: 'POST',
      path: '',
      body: [],
    }, '/__forger_internal/forger_app/codex-task/start');
    const get = await unavailableTasks.handleCloudForgerAppRequest({
      request_id: 'get-missing',
      app_id: 'finance-os',
      method: 'POST',
      path: '',
      body: [...Buffer.from('{"runId":99}')],
    }, '/__forger_internal/forger_app/codex-task/get');
    const cancel = await unavailableTasks.handleCloudForgerAppRequest({
      request_id: 'cancel-missing',
      app_id: 'finance-os',
      method: 'POST',
      path: '',
      body: [],
    }, '/__forger_internal/forger_app/codex-task/cancel');
    const unknown = await unavailableTasks.handleCloudForgerAppRequest({
      request_id: 'unknown',
      app_id: 'finance-os',
      method: 'POST',
      path: '',
      body: [],
    }, '/__forger_internal/forger_app/nope');
    const activeTaskManager = createCloudSocialRelayController(createSocialDeps().deps);
    const activeGet = await activeTaskManager.handleCloudForgerAppRequest({
      request_id: 'get-active',
      app_id: 'finance-os',
      method: 'POST',
      path: '',
      body: [...Buffer.from('{"runId":"run-1"}')],
    }, '/__forger_internal/forger_app/codex-task/get');

    assert.equal(method.status, 405);
    assert.deepEqual(JSON.parse(bufferText(method.body)), { error: 'method_not_allowed' });
    assert.deepEqual(JSON.parse(bufferText(subscription.body)), { connected: true });
    assert.equal(start.status, 503);
    assert.deepEqual(JSON.parse(bufferText(start.body)), { error: 'app_codex_task_manager_unavailable' });
    assert.equal(JSON.parse(bufferText(get.body)), null);
    assert.deepEqual(JSON.parse(bufferText(cancel.body)), { success: false });
    assert.deepEqual(JSON.parse(bufferText(activeGet.body)), { runId: 'run-1', status: 'running' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(bufferText(unknown.body)), { error: 'unknown_forger_app_action' });

    const failingContext = createCloudSocialRelayController(createSocialDeps({
      resolveInstalledAgents: async () => {
        throw new Error('context failed');
      },
    }).deps);
    const contextError = await failingContext.handleCloudForgerAppRequest({
      request_id: 'context-error',
      app_id: 'finance-os',
      method: 'POST',
      path: '',
      body: [],
    }, '/__forger_internal/forger_app/context');
    assert.equal(contextError.status, 500);
    assert.deepEqual(JSON.parse(bufferText(contextError.body)), { error: 'context failed' });
  });
});

test('cloud social relay resolves local database and Claude command paths without network installs', async (t) => {
  const root = await tmpRoot('social-relay-runtime');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'finance-os');
  const backendData = path.join(installDir, 'backend', 'data');
  await fs.mkdir(backendData, { recursive: true });
  await fs.writeFile(path.join(backendData, 'app.sqlite3'), 'sqlite');
  await fs.writeFile(path.join(installDir, 'backend', 'direct.db'), 'direct sqlite');

  await withMockedElectron({ Notification: FakeNotification }, async (require) => {
    clearDistModule('main/cloud/social-relay.js');
    const { createCloudSocialRelayController } = require('../../dist-electron/main/cloud/social-relay.js');
    const claudeRoot = path.join(root, 'claude');
    const managedClaudePath = path.join(claudeRoot, 'node_modules', '.bin', 'claude');
    const commands = [];
    const { deps } = createSocialDeps({
      getClaudeRoot: () => claudeRoot,
      registry: { apps: { 'finance-os': { installDir } } },
      existsFile: async (candidate) => candidate === managedClaudePath,
      canRunCommand: async (command, args) => {
        commands.push({ command, args });
        return command === managedClaudePath;
      },
    });
    const controller = createCloudSocialRelayController(deps);

    assert.equal(await controller.findSqliteFile(path.join(root, 'missing-directory')), null);
    assert.equal(await controller.findSqliteFile(path.join(installDir, 'backend')), path.join(installDir, 'backend', 'direct.db'));
    assert.equal(await controller.resolveAppDbPath('finance-os'), path.join(installDir, 'backend', 'direct.db'));
    await fs.rm(path.join(installDir, 'backend', 'direct.db'), { force: true });
    assert.equal(await controller.resolveAppDbPath('finance-os'), path.join(backendData, 'app.sqlite3'));
    assert.equal(await controller.resolveManagedClaudeCliPath(claudeRoot), managedClaudePath);
    assert.deepEqual(await controller.resolveClaudeCli(), { path: managedClaudePath, source: 'managed' });
    assert.equal(await controller.ensureClaudeCliInstalled(), managedClaudePath);
    assert.deepEqual(commands[0], { command: managedClaudePath, args: ['--version'] });

    const systemController = createCloudSocialRelayController(createSocialDeps({
      existsFile: async () => false,
      canRunCommand: async (command) => command === '/usr/local/bin/claude',
      runCommandCapture: async () => ({ code: 0, stdout: '/usr/local/bin/claude\n', stderr: '' }),
    }).deps);
    assert.deepEqual(await systemController.resolveSystemClaudeCliPath(), '/usr/local/bin/claude');
    assert.deepEqual(await systemController.resolveClaudeCli(), { path: '/usr/local/bin/claude', source: 'system' });

    await withPlatform('win32', async () => {
      const windowsCommands = [];
      const windowsController = createCloudSocialRelayController(createSocialDeps({
        getClaudeRoot: () => claudeRoot,
        existsFile: async (candidate) => candidate.endsWith('claude.cmd'),
        canRunCommand: async (command, args) => {
          windowsCommands.push({ command, args });
          return command.endsWith('claude.cmd');
        },
      }).deps);

      assert.equal(await windowsController.resolveManagedClaudeCliPath(claudeRoot), path.join(claudeRoot, 'node_modules', '.bin', 'claude.cmd'));
      assert.equal(windowsCommands[0].command.endsWith('claude.cmd'), true);
    });
  });
});

test('cloud social relay covers relay body, Claude fallback, and recipient key edge cases', async (t) => {
  const root = await tmpRoot('social-relay-edges');
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ Notification: FakeNotification }, async (require) => {
    clearDistModule('main/cloud/social-relay.js');
    const { createCloudSocialRelayController } = require('../../dist-electron/main/cloud/social-relay.js');
    const relayRequests = [];
    globalThis.fetch = async (url, init) => {
      relayRequests.push({ url: String(url), init });
      return new Response(null, { status: 204, headers: { 'last-modified': 'today', 'x-drop': 'secret' } });
    };

    const relay = createCloudSocialRelayController(createSocialDeps().deps);
    assert.deepEqual(relay.parseRelayJsonBody(), {});
    assert.deepEqual(relay.parseRelayJsonBody([...Buffer.from('[1,2]')]), {});
    const head = await relay.handleCloudRelayRequest({
      request_id: 'head',
      app_id: 'finance-os',
      method: 'HEAD',
      path: '/status',
      body: [...Buffer.from('ignored')],
    });
    const malformedPath = await relay.handleCloudRelayRequest({
      request_id: 'malformed-path',
      app_id: 'finance-os',
      method: 'GET',
      path: '/%E0%A4%A',
    });
    assert.equal(head.status, 204);
    assert.equal(relayRequests[0].init.body, undefined);
    assert.deepEqual(head.headers, { 'last-modified': 'today' });
    assert.equal(malformedPath.status, 403);
    assert.equal(bufferText(malformedPath.body), 'path_blocked');

    assert.equal(await relay.resolveAppDbPath('missing-app'), null);
    assert.equal(await createCloudSocialRelayController(createSocialDeps({
      registry: { apps: { 'finance-os': { installDir: path.join(root, 'missing-backend') } } },
    }).deps).resolveAppDbPath('finance-os'), null);
    const emptyBackendRoot = path.join(root, 'empty-backend-app');
    await fs.mkdir(path.join(emptyBackendRoot, 'backend'), { recursive: true });
    assert.equal(await createCloudSocialRelayController(createSocialDeps({
      registry: { apps: { 'finance-os': { installDir: emptyBackendRoot } } },
    }).deps).resolveAppDbPath('finance-os'), null);
    assert.equal(await relay.resolveSystemClaudeCliPath(), null);
    assert.equal(await createCloudSocialRelayController(createSocialDeps({
      existsFile: async () => true,
      canRunCommand: async () => false,
    }).deps).resolveManagedClaudeCliPath(root), null);
    assert.equal(await createCloudSocialRelayController(createSocialDeps({
      runCommandCapture: async () => ({ code: 0, stdout: '\n', stderr: '' }),
    }).deps).resolveSystemClaudeCliPath(), null);
    assert.equal(await createCloudSocialRelayController(createSocialDeps({
      canRunCommand: async () => false,
      runCommandCapture: async () => ({ code: 0, stdout: '/bin/claude\n', stderr: '' }),
    }).deps).resolveSystemClaudeCliPath(), null);
    assert.equal(await createCloudSocialRelayController(createSocialDeps({
      runCommandCapture: async () => {
        throw new Error('which failed');
      },
    }).deps).resolveSystemClaudeCliPath(), null);

    const installRoot = path.join(root, 'claude-install');
    const noNpm = createCloudSocialRelayController(createSocialDeps({
      getClaudeRoot: () => installRoot,
      existsFile: async () => false,
      ensureRuntimeInstalled: async () => ({ bin: root }),
    }).deps);
    await assert.rejects(() => noNpm.ensureClaudeCliInstalled(), /runtime_npm_executable_not_found/);
    assert.match(await fs.readFile(path.join(installRoot, 'package.json'), 'utf8'), /forger-claude-code-runtime/);

    const installFailureRoot = path.join(root, 'claude-install-failure');
    const installFailure = createCloudSocialRelayController(createSocialDeps({
      getClaudeRoot: () => installFailureRoot,
      existsFile: async () => false,
      ensureRuntimeInstalled: async () => ({ npm: 'npm', bin: root }),
      runCommand: async () => undefined,
    }).deps);
    await assert.rejects(() => installFailure.ensureClaudeCliInstalled(), /claude_cli_install_failed/);

    const installSuccessRoot = path.join(root, 'claude-install-success');
    const installedClaudePath = path.join(installSuccessRoot, 'node_modules', '.bin', 'claude');
    let installCompleted = false;
    const installSuccess = createCloudSocialRelayController(createSocialDeps({
      getClaudeRoot: () => installSuccessRoot,
      existsFile: async (candidate) => installCompleted && candidate === installedClaudePath,
      canRunCommand: async (command) => command === installedClaudePath,
      ensureRuntimeInstalled: async () => ({ npm: 'npm', bin: root }),
      runCommand: async () => {
        installCompleted = true;
      },
    }).deps);
    assert.equal(await installSuccess.ensureClaudeCliInstalled(), installedClaudePath);

    const noSenderEnvelope = createCloudSocialRelayController(createSocialDeps({
      cloudDeviceManager: null,
      forgerAccount: { authenticated: true },
    }).deps);
    assert.equal((await noSenderEnvelope.buildEncryptedEnvelopes({
      devices: [{ id: 9, deviceUid: 'friend-device', publicKey: 'friend-public' }],
    }, 'hi')).length, 1);
    const noCiphertext = await noSenderEnvelope.decryptCloudMessage({
      sender: { id: 2, username: 'friend' },
      recipient: { id: 1, username: 'me' },
      envelopes: [{}],
    });
    assert.equal(noCiphertext.plaintext, undefined);
    assert.deepEqual(await noSenderEnvelope.decryptCloudMessages([noCiphertext]), [noCiphertext]);
    await noSenderEnvelope.wait(0);

    const lazyIdentity = createCloudSocialRelayController(createSocialDeps({
      cloudIdentityStore: null,
      CloudIdentityStore: class {
        encryptFor(publicKey, text, keyFingerprint) {
          return { publicKey, text, keyFingerprint };
        }

        async decrypt(payload) {
          return payload.text;
        }
      },
    }).deps);
    const lazyEnvelope = await lazyIdentity.buildEncryptedEnvelopes({
      devices: [{ id: 7, deviceUid: 'device-7', publicKey: 'public-7', keyFingerprint: 'fingerprint-7' }],
    }, 'secret');
    assert.equal(JSON.parse(lazyEnvelope[0].ciphertext).keyFingerprint, 'fingerprint-7');

    let typeReads = 0;
    const changingEvent = {
      get type() {
        typeReads += 1;
        return typeReads === 1 ? 'cloud_message' : 'unknown';
      },
      message: {},
    };
    assert.equal(await lazyIdentity.prepareCloudSocialEvent(changingEvent), null);

    let notificationTypeReads = 0;
    lazyIdentity.showIncomingCloudMessageNotification({
      get type() {
        notificationTypeReads += 1;
        return notificationTypeReads === 1 ? 'cloud_message' : 'friendship_changed';
      },
      message: {
        sender: { id: 2, username: 'friend' },
        recipient: { id: 1, username: 'me' },
        plaintext: 'hidden',
      },
    });
    assert.equal(FakeNotification.shown.some((notification) => notification.options.body === 'hidden'), false);

    const missingRecipientKey = createCloudSocialRelayController(createSocialDeps({
      forgerBackendClient: {
        listFriends: async () => [],
        searchFriends: async () => [{ id: 2, username: 'friend', devices: [{ id: 8, deviceUid: 'friend-device' }] }],
      },
    }).deps);
    await assert.rejects(
      () => missingRecipientKey.sendEncryptedCloudMessage({ recipientUsername: 'friend', text: 'Hola' }),
      (error) => error.technicalCode === 'recipient_cloud_key_missing',
    );
    await assert.rejects(
      () => createCloudSocialRelayController(createSocialDeps({ forgerBackendClient: null }).deps)
        .sendEncryptedCloudMessage({ recipientUsername: 'friend', text: 'Hola' }),
      /backend_client_missing/,
    );
    await assert.rejects(
      () => createCloudSocialRelayController(createSocialDeps({
        forgerBackendClient: {
          listFriends: async () => [],
          searchFriends: async () => [],
        },
      }).deps).sendEncryptedCloudMessage({ recipientUserId: 404, text: 'Hola' }),
      /recipient_not_found/,
    );
  });
});

test('cloud social relay encrypts message envelopes, decrypts events, and notifies unread focused-safe messages', async () => {
  FakeNotification.shown = [];
  await withMockedElectron({ Notification: FakeNotification }, async (require) => {
    clearDistModule('main/cloud/social-relay.js');
    const { createCloudSocialRelayController } = require('../../dist-electron/main/cloud/social-relay.js');
    const { deps, sentToWindows, openedFriends } = createSocialDeps();
    const controller = createCloudSocialRelayController(deps);

    const sent = await controller.sendEncryptedCloudMessage({ recipientUsername: '@friend', text: 'Hola' });
    const outgoingEnvelopePayloads = sent.envelopes.map((envelope) => JSON.parse(envelope.ciphertext));
    assert.equal(sent.plaintext, 'Hola');
    assert.deepEqual(outgoingEnvelopePayloads.map((payload) => payload.publicKey).sort(), ['friend-public', 'sender-public']);

    const prepared = await controller.prepareCloudSocialEvent({
      type: 'cloud_message',
      message: {
        id: 20,
        sender: { id: 2, username: 'friend', firstName: 'Friend' },
        recipient: { id: 1, username: 'me' },
        envelopes: [{ ciphertext: JSON.stringify({ text: 'Mensaje secreto' }) }],
      },
    });
    assert.equal(prepared.message.plaintext, 'Mensaje secreto');
    assert.equal(controller.isUnreadIncomingCloudMessage(prepared), true);
    await controller.handleCloudSocialEvent({
      type: 'cloud_message',
      message: {
        id: 21,
        sender: { id: 2, username: 'friend', firstName: 'Friend' },
        recipient: { id: 1, username: 'me' },
        envelopes: [{ ciphertext: JSON.stringify({ text: 'Nuevo mensaje' }) }],
      },
    });

    assert.equal(FakeNotification.shown.length, 1);
    assert.equal(FakeNotification.shown[0].options.title, 'Friend');
    assert.equal(FakeNotification.shown[0].options.body, 'Nuevo mensaje');
    assert.ok(sentToWindows.some((entry) => entry.channel === 'forger:cloud-friendship:event' && entry.payload.unread === true));
    FakeNotification.shown[0].click();
    assert.equal(openedFriends[0].username, 'friend');
  });
});

test('cloud social relay keeps invalid, focused, self, and unsupported-notification events quiet', async () => {
  FakeNotification.shown = [];
  FakeNotification.supported = false;
  await withMockedElectron({ Notification: FakeNotification }, async (require) => {
    clearDistModule('main/cloud/social-relay.js');
    const { createCloudSocialRelayController } = require('../../dist-electron/main/cloud/social-relay.js');
    const focusedWindow = {
      webContents: { send: () => undefined },
      isDestroyed: () => false,
      isFocused: () => true,
    };
    const { deps } = createSocialDeps({
      friendChatWindows: new Map([[2, focusedWindow]]),
      forgerBackendClient: {
        normalizeFriendshipPayload: () => null,
        normalizeCloudMessagePayload: (message) => message,
      },
    });
    const controller = createCloudSocialRelayController(deps);

    assert.equal(controller.isCloudSocialEvent(null), false);
    assert.equal(controller.isCloudSocialEvent({ type: 'other' }), false);
    assert.equal(await controller.prepareCloudSocialEvent({ type: 'friendship_changed', friendship: { id: 1 } }), null);
    assert.equal(await controller.prepareCloudSocialEvent({
      type: 'cloud_message',
      message: {
        sender: { id: 2, username: 'friend' },
        recipient: { id: 1, username: 'me' },
        envelopes: [{ ciphertext: '{bad json' }],
      },
    }).then((event) => event.message.plaintext), undefined);
    assert.equal(controller.isUnreadIncomingCloudMessage({ type: 'friendship_changed', friendship: { id: 1 } }), false);
    assert.equal(controller.isUnreadIncomingCloudMessage({
      type: 'cloud_message',
      message: { sender: { id: 1, username: 'me' }, recipient: { id: 2, username: 'friend' }, envelopes: [] },
    }), false);
    assert.equal(controller.isUnreadIncomingCloudMessage({
      type: 'cloud_message',
      message: { sender: { id: 2, username: 'friend' }, recipient: { id: 1, username: 'me' }, envelopes: [] },
    }), false);
    assert.equal(controller.isUnreadIncomingCloudMessage({
      type: 'cloud_message',
      message: { sender: { id: 2, username: 'friend' }, recipient: { id: 99, username: 'other' }, envelopes: [] },
    }), false);

    controller.showIncomingCloudMessageNotification({
      type: 'ephemeral_cloud_message',
      message: {
        sender: { id: 3, username: 'other' },
        recipient: { id: 1, username: 'me' },
        envelopes: [],
        plaintext: 'quiet',
      },
    });
    await controller.handleCloudSocialEvent({ type: 'not-real' });
    assert.equal(FakeNotification.shown.length, 0);
  });
  FakeNotification.supported = true;
});

test('cloud social relay falls back notification copy and forwards events without a main window', async () => {
  FakeNotification.shown = [];
  FakeNotification.supported = true;

  await withMockedElectron({ Notification: FakeNotification }, async (require) => {
    clearDistModule('main/cloud/social-relay.js');
    const { createCloudSocialRelayController } = require('../../dist-electron/main/cloud/social-relay.js');
    const friendWindowEvents = [];
    const { deps, sentToWindows, openedFriends } = createSocialDeps({
      mainWindow: null,
      friendChatWindows: new Map([[2, {
        webContents: { send: (channel, payload) => friendWindowEvents.push({ channel, payload }) },
        isDestroyed: () => false,
        isFocused: () => false,
      }]]),
      forgerBackendClient: {
        normalizeFriendshipPayload: (friendship) => ({ id: Number(friendship.id), friend: { id: 2, username: 'friend' } }),
        normalizeCloudMessagePayload: (message) => message,
      },
    });
    const controller = createCloudSocialRelayController(deps);
    const longBody = `  ${'mensaje '.repeat(40)}  `;

    await controller.handleCloudSocialEvent({
      type: 'friendship_changed',
      friendship: { id: '44' },
    });
    controller.showIncomingCloudMessageNotification({
      type: 'ephemeral_cloud_message',
      message: {
        sender: { id: 2, username: 'friend', firstName: '   ' },
        recipient: { id: 1, username: 'me' },
        envelopes: [],
        plaintext: longBody,
      },
    });
    controller.showIncomingCloudMessageNotification({
      type: 'cloud_message',
      message: {
        sender: { id: 3, username: 'quiet' },
        recipient: { id: 1, username: 'me' },
        envelopes: [],
        plaintext: '   ',
      },
    });

    assert.ok(sentToWindows.some((entry) => entry.payload.type === 'friendship_changed' && entry.payload.friendship.id === 44));
    assert.ok(friendWindowEvents.some((entry) => entry.payload.type === 'friendship_changed'));
    assert.equal(FakeNotification.shown.length, 2);
    assert.equal(FakeNotification.shown[0].options.title, '@friend');
    assert.equal(FakeNotification.shown[0].options.body.length, 120);
    assert.match(FakeNotification.shown[0].options.body, /\.\.\.$/);
    assert.equal(FakeNotification.shown[1].options.body, 'Nuevo mensaje en Social');
    FakeNotification.shown[0].click();
    assert.equal(openedFriends[0].username, 'friend');
  });
});

test('MemoryStore enforces caller scope, sanitizes entries, and builds bounded context', async (t) => {
  const root = await tmpRoot('memory-store');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const { MemoryStore } = await import('../../dist-electron/main/memory-store.js');
  const store = new MemoryStore(root);

  const global = await store.create({
    scope: 'global',
    kind: 'fact',
    text: '  Use local data only.  ',
    source: 'agent',
  });
  const app = await store.create({
    scope: 'app',
    appId: 'finance-os',
    kind: 'workflow',
    text: 'Import CSV before analysis.',
    source: 'automation',
  }, { caller: 'automation', appIds: ['finance-os'] });
  await store.create({
    scope: 'app',
    appId: 'recipes',
    kind: 'profile',
    text: 'Vegetarian recipes.',
  });

  assert.equal(global.text, 'Use local data only.');
  assert.equal(app.appId, 'finance-os');
  await assert.rejects(
    () => store.create({ scope: 'global', text: 'bad' }, { caller: 'app-agent', appId: 'finance-os' }),
    /memory_scope_forbidden/,
  );
  await assert.rejects(
    () => store.update({ id: app.id, appId: 'recipes' }, { caller: 'app-agent', appId: 'finance-os' }),
    /memory_scope_forbidden/,
  );

  const appVisible = await store.list({}, { caller: 'app-agent', appId: 'finance-os' });
  assert.deepEqual(appVisible.map((entry) => entry.text).sort(), ['Import CSV before analysis.', 'Use local data only.']);
  assert.equal((await store.list({ appId: 'recipes' }, { caller: 'app-agent', appId: 'finance-os' })).length, 0);
  const context = await store.buildContext({ caller: 'app-agent', appId: 'finance-os' }, 80);
  assert.ok(context.startsWith('Memoria relevante:'));
  assert.ok(context.length <= 80);

  const persisted = JSON.parse(await fs.readFile(path.join(root, 'memory.json'), 'utf8'));
  assert.equal(persisted.entries.length, 3);
  assert.equal(await store.delete(app.id, { caller: 'automation', appIds: ['finance-os'] }).then((result) => result.success), true);
});

test('MemoryStore recovers malformed files and validates update/delete/write edge cases', async (t) => {
  const root = await tmpRoot('memory-store-edges');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'memory.json'), '{bad json', 'utf8');
  const { MemoryStore } = await import('../../dist-electron/main/memory-store.js');
  const store = new MemoryStore(root);

  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.create({ scope: 'global', text: '   ' }), /memory_text_required/);
  await assert.rejects(() => store.update({ id: 'missing', text: 'new' }), /memory_not_found/);
  assert.equal((await store.delete('missing')).success, false);
  await assert.rejects(
    () => store.create({ scope: 'app', text: 'No app id' }, { caller: 'app-agent' }),
    /memory_app_required/,
  );
  await assert.rejects(
    () => store.create({ scope: 'app', appId: 'recipes', text: 'Wrong app' }, { caller: 'automation', appIds: ['finance-os'] }),
    /memory_scope_forbidden/,
  );

  const longText = 'x'.repeat(2_100);
  const global = await store.create({ scope: 'global', kind: 'unknown', text: longText, source: 'robot' }, { caller: 'automation', appIds: [] });
  assert.equal(global.kind, 'preference');
  assert.equal(global.source, 'user');
  assert.equal(global.text.length, 2_000);

  const app = await store.create({ scope: 'app', appId: 'finance-os', kind: 'fact', text: 'Keep app scoped' }, { caller: 'settings' });
  const moved = await store.update({ id: app.id, scope: 'global', kind: 'constraint', text: 'Now global' }, { caller: 'desktop-chat' });
  assert.equal(moved.scope, 'global');
  assert.equal(moved.appId, undefined);
  await assert.rejects(() => store.update({ id: app.id, text: '   ' }, { caller: 'desktop-chat' }), /memory_text_required/);
  assert.deepEqual((await store.list({ kind: 'constraint' })).map((entry) => entry.id), [app.id]);
});

test('MemoryStore ignores invalid persisted entries and returns empty context cleanly', async (t) => {
  const root = await tmpRoot('memory-store-persisted');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'memory.json'), JSON.stringify({
    entries: [
      null,
      { id: 'bad-kind', scope: 'global', kind: 'unknown', text: 'drop', createdAt: '2026-05-21T00:00:00Z', updatedAt: '2026-05-21T00:00:00Z' },
      { id: 'ok', scope: 'global', kind: 'fact', text: 'Keep this', createdAt: '2026-05-21T00:00:00Z', updatedAt: '2026-05-21T00:00:00Z' },
    ],
  }), 'utf8');
  const { MemoryStore } = await import('../../dist-electron/main/memory-store.js');
  const store = new MemoryStore(root);

  assert.deepEqual((await store.list()).map((entry) => entry.id), ['ok']);
  assert.equal(await store.buildContext({ caller: 'automation', appIds: ['finance-os'] }), 'Memoria relevante:\n- [global/fact] Keep this');
  const empty = new MemoryStore(path.join(root, 'empty'));
  assert.equal(await empty.buildContext({ caller: 'app-agent' }), '');
});

test('DesktopErrorReporter filters expected errors, dedupes repeated failures, and keeps app context', async () => {
  const { DesktopErrorReporter } = await import('../../dist-electron/main/error-reporting.js');
  const sent = [];
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  const reporter = new DesktopErrorReporter({
    getMainWindow: () => window,
    getAppVersion: () => '0.2.test',
    getInstalledApp: (appId) => appId === 'finance-os' ? { version: '1.2.3' } : null,
    platform: 'darwin',
    arch: 'arm64',
    dedupeTtlMs: 60_000,
  });

	  reporter.reportChatRunFailure({ appId: 'finance-os', runId: 'run-1', errorCode: 'auth_missing' });
	  reporter.reportAppCodexTaskEvent({
	    task: {
	      appId: 'finance-os',
	      runId: 'run-ignored',
	      templateId: 'review',
	      status: 'completed',
	    },
	  });
	  reporter.reportAppCodexTaskEvent({
	    task: {
	      appId: 'finance-os',
      runId: 'run-2',
      templateId: 'review',
      status: 'failed',
      error: 'Task failed',
      progressLog: Array.from({ length: 12 }, (_, index) => `step-${index}`),
    },
  });
  reporter.reportAppCodexTaskEvent({
    task: {
      appId: 'finance-os',
      runId: 'run-2',
      templateId: 'review',
      status: 'failed',
      error: 'Task failed again',
      progressLog: [],
    },
  });
	  reporter.reportMainUnhandledRejection('boom');
	  reporter.request({
	    source: 'desktop',
	    operation: 'manual-report',
	    message: 'Manual report without a technical code',
	  });

	  assert.equal(sent.length, 3);
	  assert.equal(sent[0].channel, 'forger:error-report:requested');
	  assert.equal(sent[0].payload.desktopVersion, '0.2.test');
	  assert.equal(sent[0].payload.platform, 'darwin');
	  assert.equal(sent[0].payload.appVersion, '1.2.3');
	  assert.deepEqual(sent[0].payload.details.progressLog, ['step-2', 'step-3', 'step-4', 'step-5', 'step-6', 'step-7', 'step-8', 'step-9', 'step-10', 'step-11']);
	  assert.equal(sent[1].payload.technicalCode, 'main_unhandled_rejection');
	  assert.equal(sent[1].payload.sensitiveDetails.reason, 'boom');
	  assert.equal(sent[2].payload.operation, 'manual-report');
	  assert.equal(sent[2].payload.technicalCode, undefined);
	});

test('DesktopErrorReporter covers crash, MCP, automation, conversation, and window suppression paths', async (t) => {
  const { DesktopErrorReporter } = await import('../../dist-electron/main/error-reporting.js');
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });
  const sent = [];
  let destroyed = false;
  let currentWindow = {
    isDestroyed: () => destroyed,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  const reporter = new DesktopErrorReporter({
    getMainWindow: () => currentWindow,
    getAppVersion: () => '0.2.test',
    getInstalledApp: (appId) => ({ version: `${appId}-version` }),
    platform: 'linux',
    arch: 'x64',
    dedupeTtlMs: 10,
  });

  currentWindow = null;
  reporter.reportRendererProcessGone({ reason: 'crashed', exitCode: 9 });
  assert.equal(sent.length, 0);

  currentWindow = {
    isDestroyed: () => destroyed,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  destroyed = true;
  reporter.reportRendererProcessGone({ reason: 'crashed', exitCode: 9 });
  assert.equal(sent.length, 0);
  destroyed = false;

  reporter.reportRendererProcessGone({ reason: 'crashed', exitCode: 9 });
  reporter.reportRendererProcessGone({ reason: 'crashed-again', exitCode: 10 });
  assert.equal(sent.length, 1);
  now += 11;
  reporter.reportRendererProcessGone({ reason: 'reloaded', exitCode: 0 });
  assert.equal(sent.length, 2);

  const crash = new Error('main crashed');
  reporter.reportMainUncaughtException(crash);
  reporter.reportMainUnhandledRejection(new Error('reject error'));
  reporter.reportAppCodexConversationEvent({
    type: 'run.started',
    conversation: { appId: 'finance-os', conversationId: 'conv-ignored' },
  });
  reporter.reportAppCodexConversationEvent({
    type: 'run.failed',
    conversation: { appId: 'finance-os', conversationId: 'conv-1' },
    run: {
      runId: 'run-conv',
      status: 'failed',
      error: '',
      progressLog: Array.from({ length: 11 }, (_, index) => `conv-${index}`),
    },
  });
  reporter.reportAppCodexStartFailure({
    appId: 'finance-os',
    operation: 'app.codex-conversation.send-message',
    error: 'start failed',
  });
  reporter.reportAppCodexStartFailure({
    appId: 'finance-os',
    operation: 'app.codex-task.start',
    error: new Error('task start failed'),
  });
	  reporter.reportAppMcpStartFailure({ appId: 'finance-os', runId: 'mcp-run', error: new Error('mcp failed') });
	  reporter.reportAppMcpStartFailure({ appId: 'recipes', runId: 'mcp-string-run', error: 'mcp string failed' });
	  reporter.reportForgerMcpToolFailure({ appId: 'finance-os', runId: 'tool-run', toolName: 123, error: 'tool failed' });
	  reporter.reportForgerMcpToolFailure({ appId: 'finance-os', runId: 'tool-run-2', toolName: 'load_data', error: new Error('tool crashed') });
	  reporter.reportForgerMcpHttpFailure({ error: null, appId: 'finance-os', runId: 'http-run' });
	  reporter.reportForgerMcpHttpFailure({ error: new Error('http crashed') });
	  reporter.reportChatRunFailure({ appId: 'finance-os', runId: 'chat-run', message: 'visible chat failure' });
	  reporter.reportChatRunFailure({ appId: 'finance-os', runId: 'chat-run-2' });
	  reporter.reportAutomationRunFailure({
	    automationId: 'automation-1',
	    runId: 'automation-run',
	    selectedAppIds: ['finance-os', 'recipes'],
	    error: new Error('automation failed'),
	  });
	  reporter.reportAutomationRunFailure({
	    automationId: 'automation-2',
	    runId: 'automation-run-2',
	    selectedAppIds: ['finance-os'],
	    error: 'automation string failed',
	  });

  const payloads = sent.map((entry) => entry.payload);
  assert.equal(sent.every((entry) => entry.channel === 'forger:error-report:requested'), true);
  assert.equal(payloads.find((payload) => payload.technicalCode === 'main_uncaught_exception').message, 'main crashed');
  assert.equal(payloads.find((payload) => payload.technicalCode === 'main_unhandled_rejection').sensitiveDetails.stack.includes('reject error'), true);
  assert.equal(payloads.find((payload) => payload.technicalCode === 'app_agent_conversation_failed').message, 'App agent conversation failed.');
  assert.deepEqual(payloads.find((payload) => payload.technicalCode === 'app_agent_conversation_failed').details.progressLog, [
    'conv-1',
    'conv-2',
    'conv-3',
    'conv-4',
    'conv-5',
    'conv-6',
    'conv-7',
    'conv-8',
    'conv-9',
    'conv-10',
  ]);
  assert.equal(payloads.find((payload) => payload.technicalCode === 'agent_app_agent_conversation_send_message_failed').message, 'start failed');
  assert.equal(payloads.find((payload) => payload.technicalCode === 'agent_app_agent_task_start_failed').sensitiveDetails.stack.includes('task start failed'), true);
	  assert.equal(payloads.find((payload) => payload.technicalCode === 'app_mcp_start_failed').appVersion, 'finance-os-version');
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'mcp-string-run').sensitiveDetails.stack, undefined);
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'tool-run').details.toolName, null);
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'tool-run-2').details.toolName, 'load_data');
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'tool-run-2').sensitiveDetails.stack.includes('tool crashed'), true);
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'http-run').message, 'Forger MCP request failed.');
	  assert.equal(payloads.find((payload) => payload.operation === 'forger-mcp.http' && !payload.appId).sensitiveDetails.stack.includes('http crashed'), true);
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'chat-run').message, 'visible chat failure');
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'chat-run-2').message, 'Desktop chat run failed.');
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'automation-run').appId, undefined);
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'automation-run-2').appId, 'finance-os');
	  assert.equal(payloads.find((payload) => payload.details?.runId === 'automation-run-2').sensitiveDetails.stack, undefined);
	});
