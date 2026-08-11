import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const os = require('node:os');
const { CloudDeviceManager } = require('../../dist-electron/main/cloud-device-manager.js');

const desktopDevice = (overrides = {}) => ({
  id: 7,
  deviceUid: 'desktop-uid',
  name: 'Work Mac',
  kind: 'desktop',
  paired: true,
  online: true,
  installedApps: [],
  ...overrides,
});

const mobileDevice = (overrides = {}) => ({
  id: 91,
  deviceUid: 'mobile-uid',
  name: 'Phone',
  kind: 'mobile',
  paired: true,
  online: true,
  installedApps: [],
  ...overrides,
});

const pairingRequest = (overrides = {}) => ({
  id: 21,
  mobileDeviceId: 91,
  desktopDeviceId: 7,
  status: 'pending',
  code: 'PAIR-CODE',
  expiresAt: '2026-08-10T12:00:00.000Z',
  createdAt: '2026-08-10T11:55:00.000Z',
  mobileDevice: mobileDevice(),
  desktopDevice: desktopDevice(),
  ...overrides,
});

const makeManager = (overrides = {}) => {
  const reports = [];
  const activities = [];
  const logs = [];
  const client = {
    registerDevice: async (input) => desktopDevice({ name: input.name }),
    listDevices: async () => [desktopDevice(), mobileDevice()],
    listMobilePairingRequests: async () => [],
    listMobileDesktopAuthorizations: async () => [],
    reportRemoteSessionRequest: async (input) => reports.push(['remote', input]),
    reportAppAccessRequest: async (input) => reports.push(['app', input]),
    reportAgentAccessRequest: async (input) => reports.push(['agent', input]),
    reportAppControlRequest: async (input) => reports.push(['control', input]),
    ...overrides.client,
  };
  const options = {
    filePath: '/tmp/forger-b13-cloud-device.json',
    accountStorageKey: () => 'account-a',
    backendBaseUrl: 'https://cloud.test',
    backendClient: () => client,
    token: () => 'token',
    getCloudIdentity: async () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
    getInstalledApps: () => [],
    getPersonalAgentHeartbeat: async () => ({ supported: true, count: 0, ids: [], agents: [] }),
    onRemoteActivity: (event) => activities.push(event),
    appendInstallLog: async (event, payload) => logs.push([event, payload]),
    reconnectDelayMs: 1,
    socketMonitorIntervalMs: 100_000,
    socketStaleAfterMs: 100_000,
    ...overrides.options,
  };
  const manager = new CloudDeviceManager(options);
  manager.storage.load = async () => ({
    deviceUid: 'desktop-uid',
    deviceSecret: 'desktop-secret',
    cloudId: 7,
  });
  manager.storage.loadOrCreate = async () => ({
    deviceUid: 'desktop-uid',
    deviceSecret: 'desktop-secret',
  });
  manager.storage.save = async () => undefined;
  manager.storage.reset = () => undefined;
  manager.connectSocket = () => undefined;
  return { activities, client, logs, manager, options, reports };
};

test('given stale startup generations, each asynchronous boundary stops before opening a socket', async () => {
  for (const boundary of ['load', 'register', 'refresh']) {
    const { manager } = makeManager();
    manager.stored = boundary === 'register' ? null : {
      deviceUid: 'desktop-uid',
      deviceSecret: 'desktop-secret',
      cloudId: 7,
    };
    manager.loadRegisteredDevice = async () => {
      if (boundary === 'load') manager.stop();
      if (boundary === 'register') manager.stored = null;
    };
    manager.registerDevice = async () => {
      manager.stored = { deviceUid: 'desktop-uid', deviceSecret: 'desktop-secret', cloudId: 7 };
      if (boundary === 'register') manager.stop();
      return desktopDevice();
    };
    manager.refreshDevices = async () => {
      if (boundary === 'refresh') manager.stop();
    };
    let sockets = 0;
    manager.connectSocket = () => { sockets += 1; };

    await manager.start();

    assert.equal(sockets, 0, `${boundary} must not connect a stale generation`);
  }

  const changed = makeManager();
  changed.manager.activeSessionKey = 'previous-account';
  await changed.manager.start();
  assert.equal(changed.manager.activeSessionKey, 'account-a');
});

test('given account changes and cloud failures, public registration and naming remain recoverable', async () => {
  let account = 'account-b';
  const authFailures = [];
  const { client, manager, options } = makeManager({
    options: {
      accountStorageKey: () => account,
      onAuthenticationInvalid: async (code) => authFailures.push(code),
    },
  });
  manager.activeSessionKey = 'account-a';
  manager.socket = { close: () => undefined };
  const registered = await manager.registerCloudDevice({ name: ' Desk ' });
  assert.equal(registered.success, true);

  manager.activeSessionKey = 'account-a';
  manager.currentDevice = desktopDevice();
  client.updateDeviceName = async ({ name }) => desktopDevice({ name });
  const renamed = await manager.updateCloudDeviceName({ name: 'Renamed' });
  assert.equal(renamed.success, true);
  assert.equal(renamed.userMessage, 'Renamed esta actualizado.');
  manager.activeSessionKey = account;
  manager.devices = [desktopDevice(), mobileDevice()];
  assert.equal((await manager.updateCloudDeviceName({ name: 'Renamed again' })).success, true);

  options.backendClient = () => null;
  assert.equal((await manager.updateCloudDeviceName({ name: 'No client' })).success, false);
  assert.equal((await manager.registerCloudDevice({ name: 'No client' })).success, false);
  assert.equal((await manager.deleteMobilePairingRequest(1)).success, false);
  assert.equal((await manager.unlinkMobileDeviceFromDesktop(1)).success, false);

  options.backendClient = () => ({
    ...client,
    updateDeviceName: async () => {
      const error = new Error('expired');
      error.technicalCode = 'cloud_name_failed_401';
      throw error;
    },
  });
  manager.currentDevice = desktopDevice();
  await manager.updateCloudDeviceName({ name: 'Expired' });
  assert.deepEqual(authFailures, ['cloud_name_failed_401']);

  options.token = () => undefined;
  await manager.start();
  assert.equal(manager.activeSessionKey, undefined);
  account = 'account-c';
});

test('given mobile pairing requests, accept, reject, delete, and malformed events update visible state safely', async () => {
  const accepted = pairingRequest({ status: 'accepted' });
  const rejected = pairingRequest({ id: 22, status: 'rejected' });
  const { client, manager, options } = makeManager({
    client: {
      acceptMobilePairingRequest: async () => accepted,
      rejectMobilePairingRequest: async () => rejected,
      deleteMobilePairingRequest: async () => undefined,
      revokeMobileDesktopAuthorization: async () => undefined,
    },
  });
  manager.pairingRequests = [pairingRequest(), pairingRequest({ id: 22 })];

  assert.equal((await manager.acceptMobilePairingRequest(21)).success, true);
  assert.equal(manager.pairingRequests[0].status, 'accepted');
  assert.equal((await manager.rejectMobilePairingRequest(22)).success, true);
  assert.equal(manager.pairingRequests[0].status, 'rejected');
  assert.equal((await manager.deleteMobilePairingRequest(21)).success, true);
  assert.equal((await manager.unlinkMobileDeviceFromDesktop(3)).success, true);

  manager.handleMobilePairingRequested({ request: pairingRequest({ id: 31 }) });
  assert.equal(manager.pairingRequests[0].id, 31);
  manager.handleMobilePairingRequested(pairingRequest({ id: 32 }));
  assert.equal(manager.pairingRequests[0].id, 32);
  manager.handleMobilePairingRequested({ request: { id: 'invalid' } });
  assert.equal(manager.lastTechnicalCode, 'mobile_pairing_request_invalid');

  options.backendClient = () => ({ ...client, acceptMobilePairingRequest: async () => undefined });
  assert.equal((await manager.acceptMobilePairingRequest(1)).success, false);
  options.backendClient = () => ({ ...client, rejectMobilePairingRequest: async () => undefined });
  assert.equal((await manager.rejectMobilePairingRequest(1)).success, false);
  options.backendClient = () => ({ ...client, deleteMobilePairingRequest: async () => { throw 'delete failed'; } });
  assert.equal((await manager.deleteMobilePairingRequest(1)).success, false);
  assert.equal(manager.lastTechnicalCode, 'mobile_pairing_delete_failed');
});

test('given optional mobile lists fail, device refresh preserves the last visible values', async () => {
  const { client, manager, options } = makeManager();
  manager.stored = { deviceUid: 'desktop-uid', deviceSecret: 'secret', cloudId: 7 };
  manager.currentDevice = desktopDevice({ name: 'Old' });
  manager.pairingRequests = [pairingRequest()];
  manager.mobileDesktopAuthorizations = [{ id: 8 }];
  client.listMobilePairingRequests = async () => { throw new Error('pairings unavailable'); };
  client.listMobileDesktopAuthorizations = async () => { throw new Error('authorizations unavailable'); };

  await manager.refreshDevices();
  assert.equal(manager.currentDevice.name, 'Work Mac');
  assert.equal(manager.pairingRequests.length, 1);
  assert.equal(manager.mobileDesktopAuthorizations.length, 1);

  options.backendClient = () => null;
  await manager.refreshDevices();
  assert.equal(manager.devices.length, 2);
});

test('given missing handlers and thrown handlers, remote and app requests always report a terminal error', async () => {
  const { activities, client, manager, options, reports } = makeManager();
  manager.devices = [mobileDevice({ name: '', platform: 'ios' })];

  await manager.handleRemoteSessionRequested({ type: 'remote_session_requested', request_id: 'remote-missing', app_id: 'finance' });
  await manager.handleAppAccessRequested({ type: 'app_access_requested', request_id: 'app-missing', app_id: 'finance', mode: 'remote_tunnel', requested_by_device_id: 91 });
  assert.equal(reports.some(([, entry]) => entry.technicalCode === 'remote_session_handler_missing'), true);
  assert.equal(reports.some(([, entry]) => entry.technicalCode === 'app_access_handler_missing'), true);
  await manager.handleRemoteSessionRequested({ type: 'remote_session_requested', request_id: 'remote-invalid' });
  await manager.handleAppAccessRequested({ type: 'app_access_requested', request_id: 'app-invalid' });
  await manager.handleAppAccessRequested({ type: 'app_access_requested' });

  options.handleRemoteSessionRequest = async () => { throw 'remote exploded'; };
  options.handleAppAccessRequest = async () => { throw 'app exploded'; };
  await manager.handleRemoteSessionRequested({ type: 'remote_session_requested', request_id: 'remote-error', app_id: 'finance', requested_by_device_id: 91 });
  await manager.handleAppAccessRequested({ type: 'app_access_requested', request_id: 'app-error', app_id: 'finance', mode: 'remote_tunnel', requested_by_device_id: 91 });
  assert.equal(reports.some(([, entry]) => entry.technicalCode === 'remote_session_request_failed'), true);
  assert.equal(reports.some(([, entry]) => entry.technicalCode === 'app_access_request_failed'), true);
  assert.equal(activities.every((entry) => entry.requesterMobileDevice?.name === 'Mobile device'), true);

  options.handleAppAccessRequest = async (request) => ({
    success: false,
    status: { active: false, appId: request.appId, state: 'error' },
  });
  await manager.handleAppAccessRequested({ type: 'app_access_requested', request_id: 'app-local', app_id: 'finance', mode: 'local_network' });
  assert.equal(reports.at(-1)[1].technicalCode, undefined);
  options.handleAppAccessRequest = async (request) => ({
    success: false,
    status: { active: false, appId: request.appId, state: 'error', technicalCode: 'status-error' },
  });
  await manager.handleAppAccessRequested({ type: 'app_access_requested', request_id: 'app-status-error', app_id: 'finance', mode: 'remote_tunnel' });
  assert.equal(reports.at(-1)[1].technicalCode, 'status-error');

  client.reportRemoteSessionRequest = async () => { throw new Error('report down'); };
  client.reportAppAccessRequest = async () => { throw new Error('report down'); };
  await manager.reportRemoteSessionRequest({ requestId: 'r', appId: 'a', status: 'error' });
  await manager.reportAppAccessRequest({ requestId: 'r', appId: 'a', status: 'error' });
});

test('given invalid, missing, failed, and closed agent handlers, reports and activity stay consistent', async () => {
  const { activities, client, logs, manager, options, reports } = makeManager();
  manager.devices = [mobileDevice()];
  await manager.handleAgentAccessRequested({ type: 'agent_access_requested', request_id: 'invalid-with-id' });
  await manager.handleAgentAccessRequested({ type: 'agent_access_requested' });
  await manager.handleAgentAccessRequested({ type: 'agent_access_requested', request_id: 'missing', agent_id: 'agent-1' });
  assert.equal(reports.some(([, entry]) => entry.technicalCode === 'agent_access_handler_missing'), true);

  options.handleAgentAccessRequest = async () => { throw 'agent exploded'; };
  await manager.handleAgentAccessRequested({
    type: 'agent_access_requested',
    request_id: 'agent-error',
    agent_id: 'agent-1',
    agent_name: 'Researcher',
    requested_by_device_id: 91,
  });
  assert.equal(activities.at(-1).technicalCode, 'agent_access_request_failed');
  options.handleAgentAccessRequest = async (request) => ({
    success: false,
    status: { active: false, agentId: request.agentId, state: 'error' },
  });
  await manager.handleAgentAccessRequested({
    type: 'personal_agent_access_requested',
    request_id: 'agent-rejected',
    agent_id: 'agent-1',
  });

  await manager.handleAgentAccessDisconnectRequested({ type: 'agent_access_disconnect_requested', request_id: 'invalid' });
  await manager.handleAgentAccessDisconnectRequested({ type: 'agent_access_disconnect_requested' });
  await manager.handleAgentAccessDisconnectRequested({ type: 'agent_access_disconnect_requested', request_id: 'missing-handler', agent_id: 'agent-1' });
  options.handleAgentAccessDisconnect = async () => undefined;
  await manager.handleAgentAccessDisconnectRequested({ type: 'agent_access_disconnect_requested', request_id: 'closed', session_id: 'session-1' });
  await manager.handleAgentAccessDisconnectRequested({ type: 'agent_access_disconnect_requested', session_id: 'session-no-report' });
  options.handleAgentAccessDisconnect = async () => ({
    success: false,
    technicalCode: 'disconnect-rejected',
    status: { active: false, agentId: 'agent-result', state: 'error' },
  });
  await manager.handleAgentAccessDisconnectRequested({ type: 'agent_access_disconnect_requested', request_id: 'rejected', session_id: 'session-rejected' });
  options.handleAgentAccessDisconnect = async () => { throw 'disconnect exploded'; };
  await manager.handleAgentAccessDisconnectRequested({ type: 'agent_access_disconnect_requested', request_id: 'failed', agent_id: 'agent-1' });
  await manager.handleAgentAccessDisconnectRequested({ type: 'agent_access_disconnect_requested', request_id: 'failed-unknown', session_id: 'session-only' });
  assert.equal(activities.at(-1).technicalCode, 'agent_access_disconnect_request_failed');

  client.reportAgentAccessRequest = async () => { throw 'report exploded'; };
  await manager.reportAgentAccessRequest({ requestId: 'report-error', agentId: 'agent-1', status: 'error' });
  assert.equal(manager.lastTechnicalCode, 'agent_access_request_report_failed');
  options.appendInstallLog = async () => { throw new Error('log unavailable'); };
  await manager.logAgentAccess('agent_access:test', {});
  options.appendInstallLog = undefined;
  await manager.logAgentAccess('agent_access:test', {});
  assert.equal(logs.length > 0, true);
});

test('given app-control boundary variants, invalid and failing commands cannot escape the channel', async () => {
  const { client, manager, options, reports } = makeManager();
  await manager.handleAppControlRequested({ type: 'app_control_requested', request_id: 'invalid' });
  await manager.handleAppControlRequested({ type: 'app_control_requested' });
  await manager.handleAppControlRequested({ type: 'app_control_requested', request_id: 'missing-handler', app_id: 'finance', action: 'stop_app' });
  options.handleAppControlRequest = async () => { throw 'control exploded'; };
  await manager.handleAppControlRequested({ type: 'app_control_requested', request_id: 'failed', app_id: 'finance', action: 'stop_app' });
  options.handleAppControlRequest = async () => ({ success: false });
  await manager.handleAppControlRequested({ type: 'app_control_requested', request_id: 'rejected', app_id: 'finance', action: 'stop_app' });
  assert.deepEqual(reports.filter(([kind]) => kind === 'control').map(([, entry]) => entry.status), [
    'error', 'error', 'preparing', 'error', 'preparing', 'error',
  ]);
  client.reportAppControlRequest = async () => { throw new Error('report unavailable'); };
  await manager.reportAppControlRequest({ requestId: 'r', appId: 'finance', status: 'error' });
});

test('given heartbeat and socket races, stale results never send and old generations never reconnect', async () => {
  const { manager, options } = makeManager();
  const sent = [];
  const socket = { readyState: 1, send: (message) => sent.push(message), close: () => undefined };
  manager.socket = socket;
  options.getPersonalAgentHeartbeat = async () => {
    manager.socket = null;
    return { supported: true, count: 0, ids: [], agents: [] };
  };
  await manager.sendHeartbeat('identifier');
  assert.deepEqual(sent, []);

  options.getPersonalAgentHeartbeat = async () => { throw new Error('heartbeat unavailable'); };
  manager.socket = socket;
  await manager.sendHeartbeat('identifier');
  assert.equal(sent.length, 1);

  let reconnects = 0;
  manager.connectSocket = () => { reconnects += 1; };
  manager.forceReconnectSocket(manager.generation + 1, 'stale');
  assert.equal(reconnects, 0);

  manager.socketMonitorTimer = setInterval(() => undefined, 100_000);
  manager.startSocketMonitor('identifier', manager.generation);
  manager.clearSocketTimers();
  assert.equal(manager.socketMonitorTimer, null);

  manager.recordRemoteActivity({ kind: 'app', targetId: 'finance', state: 'preparing', requestedByDeviceId: 999 });

  let monitorCallback;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback) => {
    monitorCallback = callback;
    return { fake: true };
  };
  globalThis.clearInterval = () => undefined;
  try {
    manager.socketMonitorTimer = null;
    manager.startSocketMonitor('identifier', manager.generation);
    manager.generation += 1;
    monitorCallback();
    assert.equal(manager.socketMonitorTimer, null);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('given hostname and channel fallbacks, registration and dispatch remain deterministic', async () => {
  const { manager } = makeManager();
  const originalHostname = os.hostname;
  os.hostname = () => '';
  try {
    manager.stored = null;
    const registered = await manager.registerDevice('');
    assert.equal(registered.name, 'Forger Desktop');
    manager.currentDevice = undefined;
    manager.storage.load = async () => ({ deviceUid: 'uid', deviceSecret: 'secret', cloudId: 7 });
    const loaded = await manager.loadRegisteredDevice();
    assert.equal(loaded.name, 'Forger Desktop');
  } finally {
    os.hostname = originalHostname;
  }

  await manager.handleSocketMessage('identifier', JSON.stringify({
    message: { type: 'mobile_pairing_requested', request: pairingRequest({ id: 44 }) },
  }));
  assert.equal(manager.pairingRequests[0].id, 44);
  await manager.handleSocketMessage('identifier', JSON.stringify({
    message: {
      type: 'personal_agent_access_requested',
      action: 'disconnect',
      request_id: 'disconnect-via-channel',
      session_id: 'session-44',
    },
  }));
  await manager.handleSocketMessage('identifier', JSON.stringify({
    message: {
      type: 'desktop_agent_access_requested',
      action: 'disconnect',
      request_id: 'desktop-disconnect-via-channel',
      session_id: 'session-45',
    },
  }));
});
