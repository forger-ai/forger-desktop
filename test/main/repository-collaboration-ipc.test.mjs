import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createPreloadElectronMock, createIpcMainRecorder, createTrustedMainWindow, withMockedElectron, clearDistModule, requireExposedApi } from './electron-test-helpers.mjs';
const require = createRequire(import.meta.url);
const { registerRepositoryCollaborationIpcHandlers } = require('../../dist-electron/main/ipc/repository-collaboration-handlers.js');
const { createTrustedIpcMain } = require('../../dist-electron/main/ipc/trusted-ipc.js');
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');

const harness = (selection = { canceled: false, filePaths: ['/explicitly/chosen'] }) => {
  const handlers = new Map();
  const calls = [];
  const sender = { mainFrame: {} };
  const service = new Proxy({}, { get: (_, name) => async (input) => { calls.push([name, input]); return name === 'addRepository' ? { id: 'r1', groupId: 'g1', name: input.name } : {}; } });
  let dialogs = 0;
  const ipcMain = createTrustedIpcMain({ ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) }, getMainWindow: () => ({ webContents: sender }) });
  registerRepositoryCollaborationIpcHandlers({ ipcMain, IPC_CHANNELS, getService: () => service, dialog: { showOpenDialog: async (options) => { dialogs += 1; assert.deepEqual(options.properties, ['openDirectory']); return selection; } } });
  return { calls, dialogs: () => dialogs, run: (channel, input, event = { sender, senderFrame: sender.mainFrame }) => handlers.get(IPC_CHANNELS[channel])(event, input) };
};

test('Given an explicitly chosen folder, only main can provide its root; cancellation has no effect', async () => {
  const h = harness();
  await h.run('repositoryCollaborationAddRepository', { groupId: 'g1', name: 'Backend' });
  assert.deepEqual(h.calls, [['addRepository', { groupId: 'g1', name: 'Backend', root: '/explicitly/chosen' }]]);
  const cancelled = harness({ canceled: true, filePaths: [] });
  assert.equal(await cancelled.run('repositoryCollaborationAddRepository', { groupId: 'g1', name: 'Backend' }), null);
  assert.equal(cancelled.calls.length, 0);
});

test('Given invalid input or an untrusted sender, no dialog or service action executes', async () => {
  const h = harness();
  await assert.rejects(h.run('repositoryCollaborationAddRepository', { groupId: 'g1', name: 'Backend', root: '/injected' }), /ipc_input_invalid/);
  await assert.rejects(h.run('repositoryCollaborationCancelTask', { taskId: '', commands: 'bad' }), /ipc_input_invalid/);
  await assert.rejects(h.run('repositoryCollaborationSetAccess', { groupId: 'g1', participantId: 'alice@lid', displayName: 'Alice', repositoryIds: 'all' }), /ipc_input_invalid/);
  await assert.rejects(h.run('repositoryCollaborationAddRepository', { groupId: 'g1', name: 'Backend' }, { sender: {} }), /ipc_sender_not_authorized/);
  assert.equal(h.dialogs(), 0);
  assert.equal(h.calls.length, 0);
});

test('The public preload exposes and forwards every collaboration operation to a registered channel', async () => {
  const h = createPreloadElectronMock();
  await withMockedElectron(h.electronMock, (require) => { clearDistModule('preload/index.js'); require('../../dist-electron/preload/index.js'); });
  const api = requireExposedApi(h.exposed, 'forger');
  for (const suffix of ['Snapshot', 'ListGroups', 'ListParticipants', 'ConfigureGroup', 'AddRepository', 'RemoveRepository', 'SetAccess', 'CancelTask', 'RetryTask']) {
    const name = `repositoryCollaboration${suffix}`;
    assert.equal(typeof api[name], 'function');
    await api[name]({ probe: true });
    assert.equal(h.invokeCalls.at(-1)[0], IPC_CHANNELS[name]);
  }
});

test('The main composition registers the protected native folder choice, including cancellation', async () => {
  const { registerMainIpcHandlers } = require('../../dist-electron/main/ipc/main-handlers.js');
  const { handlers, ipcMain } = createIpcMainRecorder();
  const { mainWindow, trustedIpcEvent } = createTrustedMainWindow();
  registerMainIpcHandlers({
    IPC_CHANNELS, ipcMain, getMainWindow: () => mainWindow, getFriendChatWindows: () => [],
    state: { agentToolSettings: { approvals: {} }, catalogApps: [], settings: {}, forgerAccount: {}, cloudSyncSettings: {} },
    app: { getVersion: () => 'test' }, registry: { apps: {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  });
  assert.equal(await handlers.get(IPC_CHANNELS.repositoryCollaborationAddRepository)(trustedIpcEvent, { groupId: 'g1', name: 'Backend' }), null);
  for (const suffix of ['Snapshot', 'ListGroups', 'ListParticipants', 'ConfigureGroup', 'AddRepository', 'RemoveRepository', 'SetAccess', 'CancelTask', 'RetryTask']) {
    assert.equal(typeof handlers.get(IPC_CHANNELS[`repositoryCollaboration${suffix}`]), 'function');
  }
});
