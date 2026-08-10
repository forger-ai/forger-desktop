import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createIpcMainRecorder } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const {
  createHighRiskIpcInputValidators,
  createTrustedIpcMain,
} = require('../../dist-electron/main/ipc/trusted-ipc.js');

const makeTrustedWindow = () => {
  const mainFrame = { routingId: 1 };
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
  };
  return {
    event: { sender: webContents, senderFrame: mainFrame },
    mainFrame,
    window: {
      isDestroyed: () => false,
      webContents,
    },
  };
};

test('trusted IPC rejects every untrusted sender state before invoking a handler', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const trusted = makeTrustedWindow();
  const trustedIpcMain = createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => trusted.window,
  });
  let calls = 0;
  trustedIpcMain.handle('forger:test-trusted', async (_event, value) => {
    calls += 1;
    return value;
  });
  const invoke = handlers.get('forger:test-trusted');

  assert.equal(await invoke(trusted.event, 'ok'), 'ok');
  assert.equal(calls, 1);

  const rejectedEvents = [
    undefined,
    {},
    { sender: { isDestroyed: () => false } },
    { sender: { ...trusted.window.webContents, isDestroyed: () => true }, senderFrame: trusted.mainFrame },
    { sender: trusted.window.webContents, senderFrame: { routingId: 2 } },
  ];
  for (const event of rejectedEvents) {
    await assert.rejects(invoke(event, { raw: 'must-not-leak' }), (error) => {
      assert.equal(error.message, 'ipc_sender_not_authorized');
      assert.doesNotMatch(error.message, /must-not-leak/);
      return true;
    });
  }
  assert.equal(calls, 1);

  trusted.window.isDestroyed = () => true;
  await assert.rejects(invoke(trusted.event), /ipc_sender_not_authorized/);
  assert.equal(calls, 1);

  trusted.window.isDestroyed = () => {
    throw new Error('destroy-state-unavailable');
  };
  await assert.rejects(invoke(trusted.event), /ipc_sender_not_authorized/);
  assert.equal(calls, 1);

  const throwingWindowLookup = createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => {
      throw new Error('window-state-unavailable');
    },
  });
  throwingWindowLookup.handle('forger:test-window-lookup', async () => 'unreachable');
  await assert.rejects(
    handlers.get('forger:test-window-lookup')(trusted.event),
    /ipc_sender_not_authorized/,
  );

  const inaccessibleFrame = makeTrustedWindow();
  Object.defineProperty(inaccessibleFrame.window.webContents, 'mainFrame', {
    get() {
      throw new Error('frame-state-unavailable');
    },
  });
  const inaccessibleFrameIpc = createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => inaccessibleFrame.window,
  });
  inaccessibleFrameIpc.handle('forger:test-frame-lookup', async () => 'unreachable');
  await assert.rejects(
    handlers.get('forger:test-frame-lookup')({ sender: inaccessibleFrame.window.webContents }),
    /ipc_sender_not_authorized/,
  );

  ipcMain.owner = 'raw-ipc';
  ipcMain.readOwner = function readOwner() {
    return this.owner;
  };
  assert.equal(trustedIpcMain.owner, 'raw-ipc');
  assert.equal(trustedIpcMain.readOwner(), 'raw-ipc');

  const bareWebContents = {};
  const bareWindow = { webContents: bareWebContents };
  const bareIpc = createTrustedIpcMain({ ipcMain, getMainWindow: () => bareWindow });
  bareIpc.handle('forger:test-bare-electron-mock', async () => 'bare-ok');
  assert.equal(
    await handlers.get('forger:test-bare-electron-mock')({ sender: bareWebContents }),
    'bare-ok',
  );

  const callableWebContents = () => undefined;
  const callableIpc = createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: callableWebContents }),
  });
  callableIpc.handle('forger:test-callable-electron-mock', async () => 'callable-ok');
  assert.equal(
    await handlers.get('forger:test-callable-electron-mock')({ sender: callableWebContents }),
    'callable-ok',
  );
});

test('trusted IPC accepts only live top frames from the current Desktop window set', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const main = makeTrustedWindow();
  const friend = makeTrustedWindow();
  const unknown = makeTrustedWindow();
  let friendWindows = [friend.window];
  const trustedIpcMain = createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => main.window,
    getAdditionalTrustedWindows: () => friendWindows,
  });
  let calls = 0;
  trustedIpcMain.handle('forger:test-desktop-windows', async () => ++calls);
  const invoke = handlers.get('forger:test-desktop-windows');

  assert.equal(await invoke(main.event), 1);
  assert.equal(await invoke(friend.event), 2);
  await assert.rejects(invoke(unknown.event), /ipc_sender_not_authorized/);
  await assert.rejects(
    invoke({ sender: friend.window.webContents, senderFrame: unknown.mainFrame }),
    /ipc_sender_not_authorized/,
  );

  friendWindows = [];
  await assert.rejects(invoke(friend.event), /ipc_sender_not_authorized/);
  friendWindows = [friend.window];
  friend.window.isDestroyed = () => true;
  await assert.rejects(invoke(friend.event), /ipc_sender_not_authorized/);
  assert.equal(calls, 2);

  const invalidWindowSet = createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => main.window,
    getAdditionalTrustedWindows: () => null,
  });
  invalidWindowSet.handle('forger:test-invalid-window-set', async () => 'unreachable');
  await assert.rejects(
    handlers.get('forger:test-invalid-window-set')(main.event),
    /ipc_sender_not_authorized/,
  );
});

test('trusted IPC validates registered high-risk inputs before invoking services', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const trusted = makeTrustedWindow();
  const trustedIpcMain = createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => trusted.window,
    inputValidators: createHighRiskIpcInputValidators(IPC_CHANNELS),
  });
  const calls = [];
  for (const channel of [
    IPC_CHANNELS.deleteBackup,
    IPC_CHANNELS.deleteBackups,
    IPC_CHANNELS.restoreBackup,
    IPC_CHANNELS.installApp,
    IPC_CHANNELS.updateApp,
    IPC_CHANNELS.uninstallApp,
    IPC_CHANNELS.createUserSecret,
    IPC_CHANNELS.updateUserSecret,
    IPC_CHANNELS.deleteUserSecret,
    IPC_CHANNELS.connectAppSecret,
    IPC_CHANNELS.disconnectAppSecret,
  ]) {
    trustedIpcMain.handle(channel, async (_event, ...args) => {
      calls.push([channel, ...args]);
      return { success: true };
    });
  }

  const invalidCases = [
    [IPC_CHANNELS.deleteBackup, { appId: 'demo', backupId: 2 }],
    [IPC_CHANNELS.deleteBackups, { appId: 'demo', backupIds: 'b1' }],
    [IPC_CHANNELS.restoreBackup, { appId: '', backupId: 'b1' }],
    [IPC_CHANNELS.installApp, { appId: 'demo' }],
    [IPC_CHANNELS.updateApp, ''],
    [IPC_CHANNELS.uninstallApp, null],
    [IPC_CHANNELS.createUserSecret, { name: 'API key' }],
    [IPC_CHANNELS.updateUserSecret, { id: 'secret-1', name: 42 }],
    [IPC_CHANNELS.deleteUserSecret, { id: '' }],
    [IPC_CHANNELS.connectAppSecret, { appId: 'demo', appSecretName: 'API_KEY' }],
    [IPC_CHANNELS.disconnectAppSecret, { appId: 'demo' }],
  ];
  for (const [channel, payload] of invalidCases) {
    await assert.rejects(
      handlers.get(channel)(trusted.event, payload),
      (error) => error instanceof Error && error.message === 'ipc_input_invalid',
    );
  }
  assert.deepEqual(calls, []);

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.deleteBackup)(trusted.event, { appId: 'demo', backupId: 'b1' }),
    { success: true },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.installApp)(trusted.event, 'demo', undefined),
    { success: true },
  );
  assert.deepEqual(calls, [
    [IPC_CHANNELS.deleteBackup, { appId: 'demo', backupId: 'b1' }],
    [IPC_CHANNELS.installApp, 'demo', undefined],
  ]);
});
