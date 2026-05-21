import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const createSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8').replace(/^sealed:/, ''),
});

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const socketActions = (socket) =>
  socket.sent
    .map((message) => JSON.parse(message))
    .filter((message) => typeof message.data === 'string')
    .map((message) => JSON.parse(message.data));

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event, listener) {
    this.listeners.set(event, listener);
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
    this.listeners.get('close')?.();
  }

  emit(event, data) {
    this.listeners.get(event)?.(data);
  }
}

test('CloudDeviceManager registers per-account devices, encrypts secrets, and responds over the socket', async (t) => {
  const root = await tmpRoot('cloud-device');
  const originalWebSocket = globalThis.WebSocket;
  t.after(async () => {
    globalThis.WebSocket = originalWebSocket;
    FakeWebSocket.instances = [];
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/cloud-device-manager.js');
    globalThis.WebSocket = FakeWebSocket;
    const { CloudDeviceManager } = require('../../dist-electron/main/cloud-device-manager.js');
    const backendCalls = [];
    const relayRequests = [];
    const friendshipEvents = [];
    const backendClient = {
      async registerDevice(input) {
        backendCalls.push(['register', input]);
        return {
          id: 7,
          deviceUid: input.deviceUid,
          name: input.name,
          platform: input.platform,
          paired: true,
          online: true,
          publicKey: input.publicKey,
          keyFingerprint: input.keyFingerprint,
          installedApps: [],
        };
      },
      async listDevices() {
        backendCalls.push(['list']);
        return [{
          id: 7,
          deviceUid: backendCalls[0][1].deviceUid,
          name: 'Work Mac',
          platform: 'darwin_arm64',
          paired: true,
          online: true,
          publicKey: 'public',
          keyFingerprint: 'fingerprint',
          installedApps: [],
        }];
      },
      async createDevicePairingCode(input) {
        backendCalls.push(['pairing', input]);
      },
    };
    const manager = new CloudDeviceManager({
      filePath: path.join(root, 'cloud-device.json'),
      accountStorageKey: () => 'person@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => backendClient,
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [{ id: 'finance-os', name: 'Finance OS', status: 'running', version: '1.2.3' }],
      handleRelayRequest: async (request) => {
        relayRequests.push(request);
        return { request_id: request.request_id, status: 204, headers: {}, body: [] };
      },
      handleFriendshipEvent: async (event) => {
        friendshipEvents.push(event);
      },
    });

    try {
      await manager.start();
      const socket = FakeWebSocket.instances[0];
      assert.ok(socket.url.startsWith('wss://cloud.test/cable?'));
      assert.ok(socket.url.includes('token=session-token'));
      socket.emit('open');
      socket.emit('message', {
        data: JSON.stringify({ type: 'confirm_subscription', identifier: JSON.stringify({ channel: 'DeviceChannel' }) }),
      });
      await manager.generatePairingCode();
      socket.emit('message', {
        data: JSON.stringify({
          message: {
            type: 'relay_request',
            request_id: 'req-1',
            app_id: 'finance-os',
            method: 'GET',
            path: '/health',
          },
        }),
      });
      socket.emit('message', { data: JSON.stringify({ message: { type: 'friendship_changed', friendship: { id: 1 } } }) });
      await waitFor(() => socketActions(socket).some((message) => message.action === 'relay_response'));

      const state = await manager.getState();
      assert.equal(state.connected, true);
      assert.equal(state.currentDevice.id, 7);
      assert.match(state.pairingCode, /^[A-Z0-9]{8}$/);
      assert.equal(relayRequests[0].request_id, 'req-1');
      assert.deepEqual(friendshipEvents, [{ type: 'friendship_changed', friendship: { id: 1 } }]);
      assert.equal(backendCalls.find(([kind]) => kind === 'pairing')[1].deviceId, 7);
      assert.ok(socketActions(socket).some((message) => message.action === 'relay_response' && message.request_id === 'req-1'));
      assert.ok(socketActions(socket).some((message) => message.action === 'heartbeat' && message.installed_apps[0].id === 'finance-os'));
    } finally {
      manager.stop();
    }
    const storedPath = path.join(root, 'cloud-device-person_example_com.json');
    const stored = JSON.parse(await fs.readFile(storedPath, 'utf8'));
    assert.equal(stored.encrypted, true);
    assert.ok(Buffer.from(stored.deviceSecret, 'base64').toString('utf8').startsWith('sealed:'));
  });
});

test('CloudDeviceManager tolerates malformed socket frames, subscription rejection, stale sockets, and auth failures', async (t) => {
  const root = await tmpRoot('cloud-device-edges');
  const originalWebSocket = globalThis.WebSocket;
  t.after(async () => {
    globalThis.WebSocket = originalWebSocket;
    FakeWebSocket.instances = [];
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/cloud-device-manager.js');
    globalThis.WebSocket = FakeWebSocket;
    const { CloudDeviceManager } = require('../../dist-electron/main/cloud-device-manager.js');
    let token = 'session-token';
    const invalidAuthCodes = [];
    const friendshipEvents = [];
    const backendClient = {
      async registerDevice(input) {
        return {
          id: 9,
          deviceUid: input.deviceUid,
          name: 'Device',
          platform: 'darwin_arm64',
          paired: true,
          online: true,
          installedApps: [],
        };
      },
      async listDevices() {
        return [{ id: 9, deviceUid: 'uid', name: 'Device', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] }];
      },
      async createDevicePairingCode() {
        throw new Error('pairing_denied');
      },
    };
    const manager = new CloudDeviceManager({
      filePath: path.join(root, 'cloud-device.json'),
      accountStorageKey: () => 'person@example.com',
      backendBaseUrl: 'http://cloud.test',
      backendClient: () => backendClient,
      token: () => token,
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
      handleFriendshipEvent: async (event) => friendshipEvents.push(event),
      onAuthenticationInvalid: async (code) => invalidAuthCodes.push(code),
    });

    await manager.start();
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket.url.startsWith('ws://cloud.test/cable?'));
    socket.emit('open');
    socket.emit('message', { data: '{bad json' });
    assert.equal((await manager.getState()).technicalCode, 'cloud_socket_message_invalid');

    socket.emit('message', { data: JSON.stringify({ type: 'ping' }) });
    socket.emit('message', { data: JSON.stringify({ message: { type: 'friendship_removed', friendship: { id: 2 } } }) });
    await waitFor(() => friendshipEvents.length === 1);
    assert.deepEqual(friendshipEvents[0], { type: 'friendship_removed', friendship: { id: 2 } });

    const pairing = await manager.generatePairingCode();
    assert.equal(pairing.success, false);
    assert.equal(pairing.technicalCode, 'pairing_denied');

    token = undefined;
    socket.emit('message', { data: JSON.stringify({ type: 'reject_subscription' }) });
    await waitFor(() => socket.closed);
    assert.equal((await manager.getState()).connected, false);

	    await manager.start();
	    const staleSocket = FakeWebSocket.instances.at(-1);
	    manager.stop();
	    staleSocket.emit('open');
	    staleSocket.emit('message', { data: JSON.stringify({ type: 'ping' }) });
	    manager.sendHeartbeat('stale-identifier');
	    assert.equal(staleSocket.closed, true);

    const authError = new Error('devices_register_failed_401');
    const authManager = new CloudDeviceManager({
      filePath: path.join(root, 'auth-cloud-device.json'),
      accountStorageKey: () => 'person@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => ({
        async registerDevice() {
          throw authError;
        },
      }),
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
      onAuthenticationInvalid: async (code) => invalidAuthCodes.push(code),
    });
    await authManager.start();
    assert.equal((await authManager.getState()).technicalCode, 'devices_register_failed_401');
    assert.ok(invalidAuthCodes.includes('devices_register_failed_401'));
  });
});

test('CloudDeviceManager supports unauthenticated idle state and plaintext device storage fallback', async (t) => {
  const root = await tmpRoot('cloud-device-plaintext');
  const originalWebSocket = globalThis.WebSocket;
  t.after(async () => {
    globalThis.WebSocket = originalWebSocket;
    FakeWebSocket.instances = [];
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8'),
    },
  }, async (require) => {
    clearDistModule('main/cloud-device-manager.js');
    globalThis.WebSocket = FakeWebSocket;
    const { CloudDeviceManager } = require('../../dist-electron/main/cloud-device-manager.js');
    let token;
    const filePath = path.join(root, 'cloud-device.json');
    const backendClient = {
      async registerDevice(input) {
        return {
          id: 11,
          deviceUid: input.deviceUid,
          name: input.name,
          platform: input.platform,
          paired: false,
          online: false,
          installedApps: [],
        };
      },
      async listDevices() {
        return [];
      },
    };
    const manager = new CloudDeviceManager({
      filePath,
      accountStorageKey: () => undefined,
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => backendClient,
      token: () => token,
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
    });

    await manager.start();
    const idleState = await manager.getState();
    assert.equal(idleState.connected, false);
    assert.deepEqual(idleState.devices, []);
    assert.equal(idleState.currentDevice, undefined);

    token = 'session-token';
    await manager.start();
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(stored.encrypted, undefined);
    assert.equal(typeof stored.deviceSecret, 'string');
    assert.equal(FakeWebSocket.instances.length, 1);
    manager.stop();
  });
});

test('CloudDeviceManager reloads encrypted stored devices and resets state when the account changes', async (t) => {
  const root = await tmpRoot('cloud-device-encrypted-reload');
  const originalWebSocket = globalThis.WebSocket;
  t.after(async () => {
    globalThis.WebSocket = originalWebSocket;
    FakeWebSocket.instances = [];
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/cloud-device-manager.js');
    globalThis.WebSocket = FakeWebSocket;
    const { CloudDeviceManager } = require('../../dist-electron/main/cloud-device-manager.js');
    const filePath = path.join(root, 'cloud-device.json');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'cloud-device-person_example_com.json'), JSON.stringify({
      deviceUid: 'stored-device',
      deviceSecret: Buffer.from('sealed:stored-secret', 'utf8').toString('base64'),
      cloudId: 31,
      encrypted: true,
    }), 'utf8');
    let account = 'person@example.com';
    const registeredInputs = [];
    const manager = new CloudDeviceManager({
      filePath,
      accountStorageKey: () => account,
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => ({
        async registerDevice(input) {
          registeredInputs.push(input);
          return {
            id: input.deviceUid === 'stored-device' ? 31 : 32,
            deviceUid: input.deviceUid,
            name: 'Stored Mac',
            platform: 'darwin_arm64',
            paired: true,
            online: true,
            installedApps: [],
          };
        },
        async listDevices() {
          return [
            { id: 31, deviceUid: 'stored-device', name: 'Stored Mac', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] },
            { id: 32, deviceUid: 'new-device', name: 'Other Mac', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] },
          ];
        },
        async createDevicePairingCode() {},
      }),
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
    });

    await manager.start();
    assert.equal(registeredInputs[0].deviceUid, 'stored-device');
    assert.equal(registeredInputs[0].deviceSecret, 'stored-secret');
    assert.equal((await manager.getState()).currentDevice.id, 31);

    account = 'other@example.com';
    const switched = await manager.getState();
    assert.equal(switched.currentDevice.id, 32);
    assert.equal(registeredInputs.at(-1).deviceSecret.length, 64);
    assert.equal(FakeWebSocket.instances.at(-2).closed, true);

    await manager.start();
    const socketBeforeStartSwitch = FakeWebSocket.instances.at(-1);
    account = 'third@example.com';
    await manager.start();
    assert.equal(socketBeforeStartSwitch.closed, true);

    const socketBeforePairingSwitch = FakeWebSocket.instances.at(-1);
    account = 'fourth@example.com';
    const pairedAfterSwitch = await manager.generatePairingCode();
    assert.equal(pairedAfterSwitch.success, true);
    assert.equal(socketBeforePairingSwitch.closed, true);
    manager.stop();
  });
});

test('CloudDeviceManager covers backend absence, fallback errors, optional pairing clients, and reconnects', async (t) => {
  const root = await tmpRoot('cloud-device-more-edges');
  const originalWebSocket = globalThis.WebSocket;
  const originalSetTimeout = globalThis.setTimeout;
  t.after(async () => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
    FakeWebSocket.instances = [];
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/cloud-device-manager.js');
    globalThis.WebSocket = FakeWebSocket;
    const { CloudDeviceManager } = require('../../dist-electron/main/cloud-device-manager.js');

    let missingClientToken = 'session-token';
    const missingClient = new CloudDeviceManager({
      filePath: path.join(root, 'missing-client.json'),
      accountStorageKey: () => 'missing@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => null,
      token: () => missingClientToken,
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
    });
    await missingClient.start();
    missingClientToken = undefined;
    assert.equal((await missingClient.getState()).technicalCode, 'backend_client_missing');

    let thrownStringToken = 'session-token';
    const thrownString = new CloudDeviceManager({
      filePath: path.join(root, 'thrown-string.json'),
      accountStorageKey: () => 'string@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => ({
        async registerDevice() {
          throw 'not-an-error';
        },
      }),
      token: () => thrownStringToken,
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
    });
    await thrownString.start();
    thrownStringToken = undefined;
    assert.equal((await thrownString.getState()).technicalCode, 'cloud_device_start_failed');

    let nonStringCodeToken = 'session-token';
    const nonStringCodeError = new Error('non_string_code');
    nonStringCodeError.technicalCode = 401;
    const nonStringCode = new CloudDeviceManager({
      filePath: path.join(root, 'non-string-code.json'),
      accountStorageKey: () => 'code@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => ({
        async registerDevice() {
          throw nonStringCodeError;
        },
      }),
      token: () => nonStringCodeToken,
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
    });
    await nonStringCode.start();
    nonStringCodeToken = undefined;
    assert.equal((await nonStringCode.getState()).technicalCode, 'non_string_code');

    let backendClientCalls = 0;
    let missingListToken = 'session-token';
    const missingListClient = new CloudDeviceManager({
      filePath: path.join(root, 'missing-list.json'),
      accountStorageKey: () => 'missing-list@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => {
        backendClientCalls += 1;
        if (backendClientCalls === 1) {
          return {
            async registerDevice(input) {
              return {
                id: 42,
                deviceUid: input.deviceUid,
                name: 'Device',
                platform: 'darwin_arm64',
                paired: true,
                online: true,
                installedApps: [],
              };
            },
          };
        }
        return null;
      },
      token: () => missingListToken,
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
    });
    await missingListClient.start();
    missingListToken = undefined;
    assert.equal((await missingListClient.getState()).currentDevice.id, 42);

    const backendClient = {
      async registerDevice(input) {
        return {
          id: 41,
          deviceUid: input.deviceUid,
          name: 'Device',
          platform: 'darwin_arm64',
          paired: true,
          online: true,
          installedApps: [],
        };
      },
      async listDevices() {
        return [];
      },
      async createDevicePairingCode() {},
    };
    const reconnecting = new CloudDeviceManager({
      filePath: path.join(root, 'reconnect.json'),
      accountStorageKey: () => 'reconnect@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => backendClient,
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
    });

    await reconnecting.start();
    const socket = FakeWebSocket.instances.at(-1);
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({ type: 'confirm_subscription', identifier: JSON.stringify({ channel: 'DeviceChannel' }) }),
    });
    assert.equal((await reconnecting.getState()).connected, true);

    const paired = await reconnecting.generatePairingCode();
    assert.equal(paired.success, true);
    globalThis.setTimeout = (callback) => {
      callback();
      return 1;
    };
    socket.emit('close');
    assert.equal(FakeWebSocket.instances.length >= 2, true);
    reconnecting.stop();

    let staleDuringRegister;
    const staleRegisterSocketCount = FakeWebSocket.instances.length;
    staleDuringRegister = new CloudDeviceManager({
      filePath: path.join(root, 'stale-register.json'),
      accountStorageKey: () => 'stale-register@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => ({
        async registerDevice(input) {
          staleDuringRegister.stop();
          return {
            id: 51,
            deviceUid: input.deviceUid,
            name: 'Device',
            platform: 'darwin_arm64',
            paired: true,
            online: true,
            installedApps: [],
          };
        },
        async listDevices() {
          throw new Error('should_not_refresh_after_stale_register');
        },
      }),
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
    });
    await staleDuringRegister.start();
    assert.equal(FakeWebSocket.instances.length, staleRegisterSocketCount);

    let staleDuringRefresh;
    const staleRefreshSocketCount = FakeWebSocket.instances.length;
    staleDuringRefresh = new CloudDeviceManager({
      filePath: path.join(root, 'stale-refresh.json'),
      accountStorageKey: () => 'stale-refresh@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => ({
        async registerDevice(input) {
          return {
            id: 52,
            deviceUid: input.deviceUid,
            name: 'Device',
            platform: 'darwin_arm64',
            paired: true,
            online: true,
            installedApps: [],
          };
        },
        async listDevices() {
          staleDuringRefresh.stop();
          return [];
        },
      }),
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleRelayRequest: async (request) => ({ request_id: request.request_id, status: 200, headers: {}, body: [] }),
    });
    await staleDuringRefresh.start();
    assert.equal(FakeWebSocket.instances.length, staleRefreshSocketCount);
  });
});

test('CloudIdentityStore creates encrypted local identity material and decrypts its own envelopes', async (t) => {
  const root = await tmpRoot('cloud-identity');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/cloud-identity-store.js');
    const { CloudIdentityStore } = require('../../dist-electron/main/cloud-identity-store.js');
    const store = new CloudIdentityStore(path.join(root, 'identity.json'));

    const summary = await store.getSummary();
    const registration = await store.getPublicRegistration();
    const secret = await store.revealSecretKey();
    const encrypted = store.encryptFor(registration.publicKey, 'hola cloud', registration.keyFingerprint);
    const decrypted = await store.decrypt(encrypted);
    const signature = await store.signText('payload');
    const regenerated = await store.regenerate();
    const stored = JSON.parse(await fs.readFile(path.join(root, 'identity.json'), 'utf8'));

    assert.equal(summary.keyFingerprint, registration.keyFingerprint);
    assert.match(summary.publicKey, /BEGIN PUBLIC KEY/);
    assert.match(secret, /BEGIN PRIVATE KEY/);
    assert.equal(decrypted, 'hola cloud');
    assert.equal(signature.algorithm, 'rsa-sha256');
    assert.equal(signature.keyFingerprint, registration.keyFingerprint);
    assert.equal(encrypted.algorithm, 'rsa-oaep-sha256+aes-256-gcm');
    assert.notEqual(regenerated.keyFingerprint, summary.keyFingerprint);
    assert.equal(stored.version, 1);
    assert.match(stored.encryptedPrivateKey, /^c2VhbGVkOi/);
  });
});

test('CloudIdentityStore reports unavailable encryption before creating identity material', async (t) => {
  const root = await tmpRoot('cloud-identity-unavailable');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8'),
    },
  }, async (require) => {
    clearDistModule('main/cloud-identity-store.js');
    const { CloudIdentityStore } = require('../../dist-electron/main/cloud-identity-store.js');
    const store = new CloudIdentityStore(path.join(root, 'identity.json'));

    await assert.rejects(() => store.getSummary(), /cloud_identity_encryption_unavailable/);
    assert.equal(await fs.stat(path.join(root, 'identity.json')).catch(() => null), null);
  });
});

test('CloudIdentityStore reloads valid material and replaces malformed persisted identities', async (t) => {
  const root = await tmpRoot('cloud-identity-reload');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/cloud-identity-store.js');
    const { CloudIdentityStore } = require('../../dist-electron/main/cloud-identity-store.js');
    const identityPath = path.join(root, 'identity.json');

    const initial = await new CloudIdentityStore(identityPath).getSummary();
    const reloaded = await new CloudIdentityStore(identityPath).getSummary();
    assert.equal(reloaded.keyFingerprint, initial.keyFingerprint);

    await fs.writeFile(identityPath, JSON.stringify({
      version: 1,
      publicKey: initial.publicKey,
      encryptedPrivateKey: '',
      keyFingerprint: initial.keyFingerprint,
    }), 'utf8');
    const replacedMissingSecret = await new CloudIdentityStore(identityPath).getSummary();
    assert.notEqual(replacedMissingSecret.keyFingerprint, initial.keyFingerprint);

    await fs.writeFile(identityPath, '{not-json', 'utf8');
    const replacedInvalidJson = await new CloudIdentityStore(identityPath).getSummary();
    assert.match(replacedInvalidJson.publicKey, /BEGIN PUBLIC KEY/);
  });
});

test('registerForgerCloudOAuth handles missing backend and successful localhost callback without live credentials', async () => {
  await withMockedElectron({}, async (require) => {
    clearDistModule('main/forger-cloud-oauth.js');
    const { registerForgerCloudOAuth } = require('../../dist-electron/main/forger-cloud-oauth.js');
    const handlers = new Map();
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };

    registerForgerCloudOAuth({
      ipcMain,
      channel: 'cloud:google-login-missing',
      backendClient: () => null,
      saveAccount: async () => { throw new Error('should_not_save'); },
      openExternalUrl: async () => { throw new Error('should_not_open'); },
    });
    const missing = await handlers.get('cloud:google-login-missing')();
    assert.deepEqual(missing, {
      success: false,
      authenticated: false,
      userMessage: 'No pudimos conectar con Forger Cloud.',
      technicalCode: 'backend_client_missing',
    });

    const events = [];
    const saved = [];
    const refreshed = [];
    registerForgerCloudOAuth({
      ipcMain,
      channel: 'cloud:google-login-success',
      backendClient: () => ({
        async getGoogleLoginOAuthClientId() {
          return 'google-client-id';
        },
        async createGoogleLoginSession(input) {
          assert.equal(input.clientId, 'google-client-id');
          assert.equal(input.code, 'callback-code');
          assert.match(input.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/google\/callback$/);
          assert.ok(input.codeVerifier.length > 40);
          return {
            success: true,
            authenticated: true,
            token: 'session-token',
            user: { id: 1, email: 'person@example.com', username: 'person', confirmed: true },
          };
        },
      }),
      saveAccount: async (account, details) => {
        saved.push({ account, details });
        return { authenticated: true, token: account.token, user: account.user, userMessage: details.userMessage };
      },
      openExternalUrl: async (url) => {
        events.push(['open', url]);
        const authUrl = new URL(url);
        assert.equal(authUrl.origin + authUrl.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
        assert.equal(authUrl.searchParams.get('scope'), 'openid email profile');
        const redirectUri = authUrl.searchParams.get('redirect_uri');
        const state = authUrl.searchParams.get('state');
        await new Promise((resolve, reject) => {
          http.get(`${new URL(redirectUri).origin}/not-google`, (response) => {
            assert.equal(response.statusCode, 404);
            response.resume();
            response.on('end', resolve);
          }).on('error', reject);
        });
        await new Promise((resolve, reject) => {
          http.get(`${redirectUri}?state=${state}&code=callback-code`, (response) => {
            response.resume();
            response.on('end', resolve);
          }).on('error', reject);
        });
      },
      appendLog: async (event, payload) => events.push([event, payload]),
      refreshCatalog: async () => refreshed.push(true),
    });

    const success = await handlers.get('cloud:google-login-success')();
    assert.equal(success.success, true);
    assert.equal(success.authenticated, true);
    assert.equal(success.token, 'session-token');
    assert.equal(saved.length, 1);
    assert.equal(refreshed.length, 1);
    assert.ok(events.some(([event]) => event === 'forger_cloud_oauth:open_browser'));
  });
});

test('registerForgerCloudOAuth maps callback rejection, backend failure, and browser launch errors safely', async () => {
  await withMockedElectron({}, async (require) => {
    clearDistModule('main/forger-cloud-oauth.js');
    const { registerForgerCloudOAuth } = require('../../dist-electron/main/forger-cloud-oauth.js');
    const handlers = new Map();
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };

    const registerFlow = (channel, openExternalUrl, createGoogleLoginSession = async () => {
      throw new Error('should_not_exchange');
    }) => {
      const events = [];
      registerForgerCloudOAuth({
        ipcMain,
        channel,
        backendClient: () => ({
          async getGoogleLoginOAuthClientId() {
            return 'google-client-id';
          },
          createGoogleLoginSession,
        }),
        saveAccount: async () => { throw new Error('should_not_save'); },
        openExternalUrl,
        appendLog: async (event, payload) => events.push({ event, payload }),
      });
      return events;
    };

    registerFlow('cloud:google-login-state', async (url) => {
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      await new Promise((resolve, reject) => {
        http.get(`${redirectUri}?state=wrong&code=callback-code`, (response) => {
          assert.equal(response.statusCode, 500);
          response.resume();
          response.on('end', resolve);
        }).on('error', reject);
      });
    });
    const stateMismatch = await handlers.get('cloud:google-login-state')();
    assert.equal(stateMismatch.success, false);
    assert.equal(stateMismatch.technicalCode, 'google_login_state_mismatch');

    registerFlow('cloud:google-login-denied', async (url) => {
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      const state = authUrl.searchParams.get('state');
      await new Promise((resolve, reject) => {
        http.get(`${redirectUri}?state=${state}&error=access_denied`, (response) => {
          assert.equal(response.statusCode, 500);
          response.resume();
          response.on('end', resolve);
        }).on('error', reject);
      });
    });
    const denied = await handlers.get('cloud:google-login-denied')();
    assert.equal(denied.success, false);
    assert.equal(denied.technicalCode, 'google_login_access_denied');

    registerFlow('cloud:google-login-google-error', async (url) => {
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      const state = authUrl.searchParams.get('state');
      await new Promise((resolve, reject) => {
        http.get(`${redirectUri}?state=${state}&error=server_error`, (response) => {
          assert.equal(response.statusCode, 500);
          response.resume();
          response.on('end', resolve);
        }).on('error', reject);
      });
    });
    const googleError = await handlers.get('cloud:google-login-google-error')();
    assert.equal(googleError.success, false);
    assert.equal(googleError.technicalCode, 'google_login_google_error');

    registerFlow('cloud:google-login-code-missing', async (url) => {
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      const state = authUrl.searchParams.get('state');
      await new Promise((resolve, reject) => {
        http.get(`${redirectUri}?state=${state}`, (response) => {
          assert.equal(response.statusCode, 500);
          response.resume();
          response.on('end', resolve);
        }).on('error', reject);
      });
    });
    const codeMissing = await handlers.get('cloud:google-login-code-missing')();
    assert.equal(codeMissing.success, false);
    assert.equal(codeMissing.technicalCode, 'google_login_code_missing');

    registerFlow('cloud:google-login-backend-failed', async (url) => {
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      const state = authUrl.searchParams.get('state');
      await new Promise((resolve, reject) => {
        http.get(`${redirectUri}?state=${state}&code=callback-code`, (response) => {
          assert.equal(response.statusCode, 500);
          response.resume();
          response.on('end', resolve);
        }).on('error', reject);
      });
    }, async () => ({
      success: false,
      authenticated: false,
      userMessage: 'Google no confirmo este correo.',
      technicalCode: 'google_login_failed_403',
    }));
    const backendFailed = await handlers.get('cloud:google-login-backend-failed')();
    assert.equal(backendFailed.success, false);
    assert.equal(backendFailed.technicalCode, 'google_login_failed_403');

    registerFlow('cloud:google-login-backend-defaults', async (url) => {
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      const state = authUrl.searchParams.get('state');
      await new Promise((resolve, reject) => {
        http.get(`${redirectUri}?state=${state}&code=callback-code`, (response) => {
          assert.equal(response.statusCode, 500);
          response.resume();
          response.on('end', resolve);
        }).on('error', reject);
      });
    }, async () => ({
      success: false,
      authenticated: false,
    }));
    const backendDefaults = await handlers.get('cloud:google-login-backend-defaults')();
    assert.equal(backendDefaults.success, false);
    assert.equal(backendDefaults.technicalCode, 'google_login_failed');
    assert.equal(backendDefaults.userMessage, 'No pudimos iniciar sesion con Google.');

    const launchEvents = registerFlow('cloud:google-login-launch-failed', async () => {
      throw new Error('browser_blocked');
    });
    const launchFailed = await handlers.get('cloud:google-login-launch-failed')();
    assert.equal(launchFailed.success, false);
    assert.equal(launchFailed.technicalCode, 'google_login_unhandled_error');
    assert.equal(launchEvents.some((entry) => entry.event === 'forger_cloud_oauth:failed'), true);

    registerFlow('cloud:google-login-launch-string-failed', async () => {
      throw 'browser_blocked';
    });
    const stringLaunchFailed = await handlers.get('cloud:google-login-launch-string-failed')();
    assert.equal(stringLaunchFailed.success, false);
    assert.equal(stringLaunchFailed.technicalCode, 'google_login_unhandled_error');
    assert.equal(stringLaunchFailed.userMessage, 'No pudimos iniciar sesion con Google.');
  });
});

test('registerForgerCloudOAuth reports callback port and timeout failures without saving an account', async () => {
  await withMockedElectron({}, async (require) => {
    clearDistModule('main/forger-cloud-oauth.js');
    const { registerForgerCloudOAuth } = require('../../dist-electron/main/forger-cloud-oauth.js');
    const handlers = new Map();
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
    const backendClient = () => ({
      async getGoogleLoginOAuthClientId() {
        return 'google-client-id';
      },
      async createGoogleLoginSession() {
        throw new Error('should_not_exchange');
      },
    });

    const originalAddress = http.Server.prototype.address;
    http.Server.prototype.address = () => null;
    try {
      registerForgerCloudOAuth({
        ipcMain,
        channel: 'cloud:google-login-port-unavailable',
        backendClient,
        saveAccount: async () => { throw new Error('should_not_save'); },
        openExternalUrl: async () => { throw new Error('should_not_open'); },
      });
      const result = await handlers.get('cloud:google-login-port-unavailable')();
      assert.equal(result.success, false);
      assert.equal(result.technicalCode, 'google_login_port_unavailable');
    } finally {
      http.Server.prototype.address = originalAddress;
    }

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const opened = [];
    globalThis.setTimeout = (callback) => {
      callback();
      return { immediate: true };
    };
    globalThis.clearTimeout = () => undefined;
    try {
      registerForgerCloudOAuth({
        ipcMain,
        channel: 'cloud:google-login-timeout',
        backendClient,
        saveAccount: async () => { throw new Error('should_not_save'); },
        openExternalUrl: async (url) => {
          opened.push(url);
        },
      });
      const result = await handlers.get('cloud:google-login-timeout')();
      assert.equal(result.success, false);
      assert.equal(result.technicalCode, 'google_login_timeout');
      assert.match(result.userMessage, /Google no respondio/);
      assert.equal(opened.length, 1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }

    const originalListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function listenWithError() {
      process.nextTick(() => this.emit('error', new Error('listen failed')));
      return this;
    };
    try {
      registerForgerCloudOAuth({
        ipcMain,
        channel: 'cloud:google-login-listen-error',
        backendClient,
        saveAccount: async () => { throw new Error('should_not_save'); },
        openExternalUrl: async () => { throw new Error('should_not_open'); },
      });
      const result = await handlers.get('cloud:google-login-listen-error')();
      assert.equal(result.success, false);
      assert.equal(result.technicalCode, 'google_login_unhandled_error');
      assert.equal(result.userMessage, 'listen failed');
    } finally {
      http.Server.prototype.listen = originalListen;
    }
  });
});
