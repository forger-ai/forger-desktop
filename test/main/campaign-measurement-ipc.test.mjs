import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createIpcMainRecorder, createTrustedMainWindow, clearDistModule, createPreloadElectronMock, requireExposedApi, withMockedElectron } from './electron-test-helpers.mjs';
const require = createRequire(import.meta.url);
const { registerCampaignMeasurementIpcHandlers } = require('../../dist-electron/main/ipc/campaign-measurement-handlers.js');
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');

test('narrow campaign methods compose preload through trusted main IPC into owner, rejecting extra properties and other windows', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const { mainWindow, trustedIpcEvent } = createTrustedMainWindow();
  const calls = [];
  const owner = { initialize: async (...values) => calls.push(['initialize', ...values]), getStatus: async () => calls.push(['status']),
    setConsent: async (...args) => calls.push(['consent', ...args]), recordFirstAppCreated: async () => calls.push(['created']) };
  registerCampaignMeasurementIpcHandlers({ ipcMain, getMainWindow: () => mainWindow, getMeasurement: () => owner, hasExistingApps: () => false });
  const preload = createPreloadElectronMock();
  preload.electronMock.ipcRenderer.invoke = (channel, ...args) => handlers.get(channel)(trustedIpcEvent, ...args);
  await withMockedElectron(preload.electronMock, (mockedRequire) => {
    clearDistModule('preload/index.js'); mockedRequire('../../dist-electron/preload/index.js');
  });
  const api = requireExposedApi(preload.exposed, 'forger');
  await api.initializeCampaignMeasurement(false);
  await api.getCampaignMeasurementStatus();
  await api.setCampaignMeasurementConsent({ enabled: true, campaignCode: 'ig_202609_paid_01' });
  await api.recordCampaignFirstAppCreated();
  assert.deepEqual(calls, [['initialize', false, false], ['status'], ['consent', true, 'ig_202609_paid_01'], ['created']]);
  for (const input of [{ enabled: true, email: 'private' }, { enabled: 'true' }, { enabled: true, campaignCode: 'private' }, null]) {
    await assert.rejects(api.setCampaignMeasurementConsent(input), /invalid/);
  }
  await assert.rejects(api.initializeCampaignMeasurement('false'), /invalid/);
  await assert.rejects(handlers.get(IPC_CHANNELS.setCampaignMeasurementConsent)({}, { enabled: true }), /not_authorized/);
  const friend = createTrustedMainWindow();
  await assert.rejects(handlers.get(IPC_CHANNELS.setCampaignMeasurementConsent)(friend.trustedIpcEvent, { enabled: true }), /not_authorized/);
  await assert.rejects(handlers.get(IPC_CHANNELS.setCampaignMeasurementConsent)({ sender: trustedIpcEvent.sender }, { enabled: true }), /not_authorized/);
  await assert.rejects(handlers.get(IPC_CHANNELS.setCampaignMeasurementConsent)({ ...trustedIpcEvent, senderFrame: {} }, { enabled: true }), /not_authorized/);
  assert.equal(calls.length, 4);
});

test('main-owned installed app evidence prevents a reset renderer from becoming a new profile', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const { mainWindow, trustedIpcEvent } = createTrustedMainWindow();
  let existing;
  registerCampaignMeasurementIpcHandlers({ ipcMain, getMainWindow: () => mainWindow, hasExistingApps: () => true,
    getMeasurement: () => ({ initialize: async (value) => { existing = value; } }) });
  await handlers.get(IPC_CHANNELS.initializeCampaignMeasurement)(trustedIpcEvent, false);
  assert.equal(existing, true);
});
