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
          kind: 'desktop',
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
      getInstalledApps: () => [{
        id: 'finance-os',
        name: 'Finance OS',
        status: 'running',
        version: '1.2.3',
        localNetworkShareSupported: true,
        remoteTunnelSupported: true,
        executionPhase: 'running',
        executionMode: 'forger',
        connectMode: null,
      }],
      handleFriendshipEvent: async (event) => {
        friendshipEvents.push(event);
      },
    });

    try {
      await manager.registerCloudDevice({ name: 'Device' });
      const socket = FakeWebSocket.instances[0];
      assert.ok(socket.url.startsWith('wss://cloud.test/cable?'));
      assert.ok(socket.url.includes('token=session-token'));
      socket.emit('open');
      socket.emit('message', {
        data: JSON.stringify({ type: 'confirm_subscription', identifier: JSON.stringify({ channel: 'DeviceChannel' }) }),
      });
      await manager.generatePairingCode();
      socket.emit('message', { data: JSON.stringify({ message: { type: 'friendship_changed', friendship: { id: 1 } } }) });
      await waitFor(() => friendshipEvents.length === 1);

      const state = await manager.getState();
      assert.equal(state.connected, true);
      assert.equal(state.currentDevice.id, 7);
      assert.match(state.pairingCode, /^[A-Z0-9]{8}$/);
      assert.deepEqual(friendshipEvents, [{ type: 'friendship_changed', friendship: { id: 1 } }]);
      assert.equal(backendCalls.find(([kind]) => kind === 'pairing')[1].deviceId, 7);
      assert.ok(socketActions(socket).some((message) =>
        message.action === 'heartbeat' &&
        message.installed_apps[0].id === 'finance-os' &&
        message.installed_apps[0].localNetworkShareSupported === true &&
        message.installed_apps[0].remoteTunnelSupported === true &&
        message.installed_apps[0].executionPhase === 'running' &&
        message.installed_apps[0].executionMode === 'forger' &&
        message.installed_apps[0].connectMode === null &&
        message.runtime_statuses['finance-os'].executionPhase === 'running' &&
        message.runtime_statuses['finance-os'].executionMode === 'forger' &&
        message.runtime_statuses['finance-os'].connectMode === null,
      ));
    } finally {
      manager.stop();
    }
    const storedPath = path.join(root, 'cloud-device-person_example_com.json');
    const stored = JSON.parse(await fs.readFile(storedPath, 'utf8'));
    assert.equal(stored.encrypted, true);
    assert.ok(Buffer.from(stored.deviceSecret, 'base64').toString('utf8').startsWith('sealed:'));
  });
});

test('CloudDeviceManager handles mobile remote session requests over DeviceChannel and reports visible status', async (t) => {
  const root = await tmpRoot('cloud-device-remote-session');
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
    const reports = [];
    const requested = [];
    const socialEvents = [];
    const backendClient = {
      async registerDevice(input) {
        return {
          id: 71,
          deviceUid: input.deviceUid,
          name: 'Device',
          platform: 'darwin_arm64',
          paired: true,
          online: true,
          installedApps: [],
        };
      },
      async listDevices() {
        return [{ id: 71, deviceUid: 'uid', name: 'Device', kind: 'desktop', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] }];
      },
      async reportRemoteSessionRequest(input) {
        reports.push(input);
      },
    };
    const manager = new CloudDeviceManager({
      filePath: path.join(root, 'cloud-device.json'),
      accountStorageKey: () => 'person@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => backendClient,
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleFriendshipEvent: async (event) => socialEvents.push(event),
      handleRemoteSessionRequest: async (request) => {
        requested.push(request);
        return {
          success: true,
          status: {
            active: true,
            appId: request.appId,
            state: 'waiting_for_session',
            sessionId: 'session-public-token',
            portalUrl: '/portal/tunnels/7',
            frontendUrl: '/remote-assets/session-public-token/',
            connectionCount: 0,
          },
        };
      },
    });

    await manager.registerCloudDevice({ name: 'Device' });
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        message: {
          type: 'remote_session_requested',
          request_id: 'request-1',
          app_id: 'finance-os',
          requested_by_device_id: 91,
        },
      }),
    });
    await waitFor(() => reports.length === 2);

    assert.deepEqual(requested, [{ requestId: 'request-1', appId: 'finance-os', requestedByDeviceId: 91 }]);
    assert.deepEqual(reports.map((report) => report.status), ['preparing', 'ready']);
    assert.equal(reports[0].requestId, 'request-1');
    assert.equal(reports[0].appId, 'finance-os');
    assert.equal(reports[1].remoteStatus.state, 'waiting_for_session');
    assert.equal(reports[1].portalUrl, '/portal/tunnels/7');
    assert.deepEqual(socialEvents, []);

    manager.options.handleRemoteSessionRequest = async (request) => {
      requested.push(request);
      return {
        success: false,
        technicalCode: 'remote_tunnel_not_supported',
        status: { active: false, appId: request.appId, state: 'error', technicalCode: 'remote_tunnel_not_supported' },
      };
    };
    socket.emit('message', {
      data: JSON.stringify({ message: { type: 'remote_session_requested', request_id: 'request-2', app_id: 'finance-os' } }),
    });
    await waitFor(() => reports.length === 4);
    assert.equal(reports[2].status, 'preparing');
    assert.equal(reports[3].status, 'error');
    assert.equal(reports[3].technicalCode, 'remote_tunnel_not_supported');

    socket.emit('message', {
      data: JSON.stringify({ message: { type: 'remote_session_requested', request_id: 'request-3', app_id: '/__forger_internal' } }),
    });
    await waitFor(() => reports.length === 5);
    assert.equal(reports[4].status, 'error');
    assert.equal(reports[4].technicalCode, 'remote_session_request_invalid');
    assert.equal(requested.length, 2);
    manager.stop();
  });
});

test('CloudDeviceManager handles mobile app access requests for local network and remote tunnel', async (t) => {
  const root = await tmpRoot('cloud-device-app-access');
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
    const reports = [];
    const requested = [];
    const backendClient = {
      async registerDevice(input) {
        return {
          id: 71,
          deviceUid: input.deviceUid,
          name: 'Device',
          platform: 'darwin_arm64',
          paired: true,
          online: true,
          installedApps: [],
        };
      },
      async listDevices() {
        return [{ id: 71, deviceUid: 'uid', name: 'Device', kind: 'desktop', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] }];
      },
      async reportAppAccessRequest(input) {
        reports.push(input);
      },
    };
    const manager = new CloudDeviceManager({
      filePath: path.join(root, 'cloud-device.json'),
      accountStorageKey: () => 'person@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => backendClient,
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleAppAccessRequest: async (request) => {
        requested.push(request);
        if (request.mode === 'local_network') {
          return {
            success: true,
            userMessage: 'Red local activa.',
            status: {
              active: true,
              appId: request.appId,
              url: 'http://192.168.1.10:5000',
              connectUrl: 'http://192.168.1.10:5000/connect/token',
            },
          };
        }
        return {
          success: true,
          status: {
            active: true,
            appId: request.appId,
            state: 'waiting_for_session',
            sessionId: 'session-public-token',
            frontendUrl: '/remote-assets/session-public-token/',
          },
        };
      },
    });

    await manager.registerCloudDevice({ name: 'Device' });
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        message: {
          type: 'app_access_requested',
          request_id: 101,
          mode: 'local_network',
          app_id: 'finance-os',
          requested_by_device_id: 91,
        },
      }),
    });
    await waitFor(() => reports.length === 2);
    socket.emit('message', {
      data: JSON.stringify({
        message: {
          type: 'app_access_requested',
          request_id: 102,
          mode: 'remote_tunnel',
          app_id: 'finance-os',
        },
      }),
    });
    await waitFor(() => reports.length === 4);

    assert.deepEqual(requested.map((request) => request.mode), ['local_network', 'remote_tunnel']);
    assert.deepEqual(reports.map((report) => report.status), ['preparing', 'ready', 'preparing', 'ready']);
    assert.equal(reports[1].accessStatus.connectUrl, 'http://192.168.1.10:5000/connect/token');
    assert.equal(reports[3].accessStatus.sessionId, 'session-public-token');
    manager.stop();
  });
});

test('CloudDeviceManager handles mobile app control requests for app stop', async (t) => {
  const root = await tmpRoot('cloud-device-app-control');
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
    const reports = [];
    const requested = [];
    const backendClient = {
      async registerDevice(input) {
        return {
          id: 72,
          deviceUid: input.deviceUid,
          name: 'Device',
          platform: 'darwin_arm64',
          paired: true,
          online: true,
          installedApps: [],
        };
      },
      async listDevices() {
        return [{ id: 72, deviceUid: 'uid', name: 'Device', kind: 'desktop', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] }];
      },
      async reportAppControlRequest(input) {
        reports.push(input);
      },
    };
    const manager = new CloudDeviceManager({
      filePath: path.join(root, 'cloud-device.json'),
      accountStorageKey: () => 'person@example.com',
      backendBaseUrl: 'https://cloud.test',
      backendClient: () => backendClient,
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      handleAppControlRequest: async (request) => {
        requested.push(request);
        return { success: true, userMessage: 'stopped' };
      },
    });

    await manager.registerCloudDevice({ name: 'Device' });
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        message: {
          type: 'app_control_requested',
          request_id: 201,
          action: 'stop_app',
          app_id: 'finance-os',
          requested_by_device_id: 91,
        },
      }),
    });
    await waitFor(() => reports.length === 2);
    socket.emit('message', {
      data: JSON.stringify({
        message: {
          type: 'app_control_requested',
          request_id: 202,
          action: 'bad_action',
          app_id: 'finance-os',
        },
      }),
    });
    await waitFor(() => reports.length === 3);

    assert.deepEqual(requested, [{
      requestId: '201',
      appId: 'finance-os',
      action: 'stop_app',
      requestedByDeviceId: 91,
    }]);
    assert.deepEqual(reports.map((report) => report.status), ['preparing', 'done', 'error']);
    assert.equal(reports[2].technicalCode, 'app_control_request_invalid');
    manager.stop();
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
        return [{ id: 9, deviceUid: 'uid', name: 'Device', kind: 'desktop', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] }];
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
      handleFriendshipEvent: async (event) => friendshipEvents.push(event),
      onAuthenticationInvalid: async (code) => invalidAuthCodes.push(code),
    });

    await manager.registerCloudDevice({ name: 'Device' });
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

      await manager.registerCloudDevice({ name: 'Device' });
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
      onAuthenticationInvalid: async (code) => invalidAuthCodes.push(code),
    });
    await authManager.registerCloudDevice({ name: 'Device' });
    assert.equal((await authManager.getState()).technicalCode, 'devices_register_failed_401');
    assert.ok(invalidAuthCodes.includes('devices_register_failed_401'));
  });
});

test('CloudDeviceManager reconnects when an open socket stops receiving cloud activity', async (t) => {
  const root = await tmpRoot('cloud-device-stale-socket');
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
    const backendClient = {
      async registerDevice(input) {
        return {
          id: 11,
          deviceUid: input.deviceUid,
          name: 'Device',
          platform: 'darwin_arm64',
          paired: true,
          online: true,
          installedApps: [],
        };
      },
      async listDevices() {
        return [{ id: 11, deviceUid: 'uid', name: 'Device', kind: 'desktop', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] }];
      },
    };
    const manager = new CloudDeviceManager({
      filePath: path.join(root, 'cloud-device.json'),
      accountStorageKey: () => 'person@example.com',
      backendBaseUrl: 'http://cloud.test',
      backendClient: () => backendClient,
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      reconnectDelayMs: 0,
      socketMonitorIntervalMs: 1,
      socketStaleAfterMs: 1,
    });

    try {
      await manager.registerCloudDevice({ name: 'Device' });
      const socket = FakeWebSocket.instances[0];
      socket.emit('open');
      socket.emit('message', {
        data: JSON.stringify({ type: 'confirm_subscription', identifier: JSON.stringify({ channel: 'DeviceChannel' }) }),
      });

      await waitFor(() => FakeWebSocket.instances.length > 1);

      assert.equal(socket.closed, true);
      assert.equal((await manager.getState()).technicalCode, 'cloud_socket_stale');
    } finally {
      manager.stop();
    }
  });
});

test('CloudDeviceManager socket monitor handles stale generations and closed sockets', async (t) => {
  const root = await tmpRoot('cloud-device-socket-monitor');
  const originalWebSocket = globalThis.WebSocket;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  t.after(async () => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    FakeWebSocket.instances = [];
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/cloud-device-manager.js');
    const intervalCallbacks = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.setInterval = (callback) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    };
    globalThis.clearInterval = () => undefined;
    globalThis.setTimeout = () => 1;
    globalThis.clearTimeout = () => undefined;
    const { CloudDeviceManager } = require('../../dist-electron/main/cloud-device-manager.js');
    const backendClient = {
      async registerDevice(input) {
        return {
          id: 17,
          deviceUid: input.deviceUid,
          name: 'Device',
          platform: 'darwin_arm64',
          paired: true,
          online: true,
          installedApps: [],
        };
      },
      async listDevices() {
        return [{ id: 17, deviceUid: 'uid', name: 'Device', kind: 'desktop', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] }];
      },
    };
    const manager = new CloudDeviceManager({
      filePath: path.join(root, 'cloud-device.json'),
      accountStorageKey: () => 'person@example.com',
      backendBaseUrl: 'http://cloud.test',
      backendClient: () => backendClient,
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
      reconnectDelayMs: 100_000,
    });

    await manager.registerCloudDevice({ name: 'Device' });
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    const monitorCallback = intervalCallbacks[0];
    const savedSocket = manager.socket;
    manager.socket = null;
    manager.stored = null;
    manager.connectSocket();
    manager.socket = savedSocket;
    manager.stored = { deviceUid: 'uid', deviceSecret: 'secret', cloudId: 17 };
    manager.connected = true;
    monitorCallback();
    socket.readyState = 0;
    manager.sendHeartbeat(JSON.stringify({ channel: 'DeviceChannel' }));
    monitorCallback();
    assert.equal(socket.closed, true);
    assert.equal((await manager.getState()).technicalCode, 'cloud_socket_not_open');
    manager.stop();
    manager.ensureSocketHealth(999);

    intervalCallbacks.length = 0;
    await manager.registerCloudDevice({ name: 'Device' });
    const healthSocket = FakeWebSocket.instances.at(-1);
    healthSocket.emit('open');
    healthSocket.readyState = 0;
    await manager.registerCloudDevice({ name: 'Device' });
    assert.equal(healthSocket.closed, true);
    manager.stop();

    intervalCallbacks.length = 0;
    await manager.registerCloudDevice({ name: 'Device' });
    const staleHealthSocket = FakeWebSocket.instances.at(-1);
    staleHealthSocket.emit('open');
    manager.lastSocketActivityAt = Date.now() - 100;
    manager.options.socketStaleAfterMs = 1;
    await manager.registerCloudDevice({ name: 'Device' });
    assert.equal(staleHealthSocket.closed, true);
    manager.stop();

    intervalCallbacks.length = 0;
    await manager.registerCloudDevice({ name: 'Device' });
    const staleGenerationSocket = FakeWebSocket.instances.at(-1);
    staleGenerationSocket.emit('open');
    staleGenerationSocket.emit('open');
    const staleGenerationMonitorCallback = intervalCallbacks[0];
    await manager.registerCloudDevice({ name: 'Device' });
    staleGenerationSocket.emit('error');
    staleGenerationMonitorCallback();
    manager.stop();
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
    });

    await manager.start();
    const idleState = await manager.getState();
    assert.equal(idleState.connected, false);
    assert.deepEqual(idleState.devices, []);
    assert.equal(idleState.currentDevice, undefined);
    assert.equal(idleState.registrationRequired, false);

    token = 'session-token';
    await manager.registerCloudDevice({ name: 'Device' });
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
            { id: 31, deviceUid: 'stored-device', name: 'Stored Mac', kind: 'desktop', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] },
            { id: 32, deviceUid: 'new-device', name: 'Other Mac', kind: 'desktop', platform: 'darwin_arm64', paired: true, online: true, installedApps: [] },
          ];
        },
        async createDevicePairingCode() {},
      }),
      token: () => 'session-token',
      getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
      getInstalledApps: () => [],
    });

    await manager.registerCloudDevice({ name: 'Device' });
    assert.equal(registeredInputs[0].deviceUid, 'stored-device');
    assert.equal(registeredInputs[0].deviceSecret, 'stored-secret');
    assert.equal((await manager.getState()).currentDevice.id, 31);

    account = 'other@example.com';
    const switched = await manager.getState();
    assert.equal(switched.currentDevice, undefined);
    assert.equal(switched.registrationRequired, true);
    await manager.registerCloudDevice({ name: 'Device' });
    assert.equal((await manager.getState()).currentDevice.id, 32);
    assert.equal(registeredInputs.at(-1).deviceSecret.length, 64);
    assert.equal(FakeWebSocket.instances.at(-2).closed, true);

    await manager.registerCloudDevice({ name: 'Device' });
    const socketBeforeStartSwitch = FakeWebSocket.instances.at(-1);
    account = 'third@example.com';
    await manager.registerCloudDevice({ name: 'Device' });
    assert.equal(socketBeforeStartSwitch.closed, true);

    const socketBeforePairingSwitch = FakeWebSocket.instances.at(-1);
    account = 'fourth@example.com';
    const pairedAfterSwitch = await manager.generatePairingCode();
    assert.equal(pairedAfterSwitch.success, false);
    assert.equal(pairedAfterSwitch.technicalCode, 'cloud_device_not_registered');
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
    });
    await missingClient.registerCloudDevice({ name: 'Device' });
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
    });
    await thrownString.registerCloudDevice({ name: 'Device' });
    thrownStringToken = undefined;
    assert.equal((await thrownString.getState()).technicalCode, 'cloud_device_register_failed');

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
    });
    await nonStringCode.registerCloudDevice({ name: 'Device' });
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
    });
    await missingListClient.registerCloudDevice({ name: 'Device' });
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
    });

    await reconnecting.registerCloudDevice({ name: 'Device' });
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
    });
    await staleDuringRegister.registerCloudDevice({ name: 'Device' });
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
    });
    await staleDuringRefresh.registerCloudDevice({ name: 'Device' });
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
