import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { createIpcMainRecorder } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const event = { sender: { id: 12 } };

test('BDD: external URL opening supports the home directory and reports shell exceptions safely', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const { registerExternalUrlIpcHandlers } = require('../../dist-electron/main/ipc/external-url-handler.js');
  registerExternalUrlIpcHandlers({
    IPC_CHANNELS, ipcMain, path, fs: { stat: async () => ({}) },
    shell: { openPath: async () => { throw new Error('shell failed'); } },
    failureDiagnostic: (error, fallback) => ({ technicalCode: fallback, sensitiveDetails: { message: error.message } }),
  });
  const result = await handlers.get(IPC_CHANNELS.openExternalUrl)(event, '~');
  assert.deepEqual(result, {
    success: false, userMessage: 'No pudimos abrir ese enlace.', technicalCode: 'open_local_path_failed',
    sensitiveDetails: { message: 'shell failed' },
  });
});

test('BDD: app cloud messaging rejects records without install roots and supplies safe delivery/name defaults', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const { registerAppCloudMessagingIpcHandlers } = require('../../dist-electron/main/ipc/app-cloud-messaging-handlers.js');
  const registry = { apps: { missing: { appId: 'missing' } } };
  let appId = 'missing';
  const sent = [];
  registerAppCloudMessagingIpcHandlers({
    IPC_CHANNELS, ipcMain, registry, resolveAppIdForWebContents: () => appId,
    resolveInstalledManifest: async () => ({ cloudMessaging: { enabled: true } }),
    listLocalCloudMessages: async () => [], sendEncryptedCloudMessage: async (input) => { sent.push(input); return input; },
  });
  await assert.rejects(handlers.get(IPC_CHANNELS.appMessagesSend)(event, { friendUserId: 1, message: 'Hi' }), /app_cloud_messaging_not_declared/);
  await assert.rejects(handlers.get(IPC_CHANNELS.appMessagesList)(event, 1), /app_cloud_messaging_not_declared/);

  appId = 'enabled';
  registry.apps.enabled = { appId: 'enabled', installDir: '/apps/enabled' };
  await handlers.get(IPC_CHANNELS.appMessagesSend)(event, { friendUserId: 1, message: 'Hi' });
  assert.equal(sent[0].delivery, 'persistent');
  assert.equal(sent[0].sourceAppName, 'enabled');
  registry.apps.enabled.name = 'Enabled App';
  const withManifestDefault = async () => ({ cloudMessaging: { enabled: true, defaultDelivery: 'ephemeral' } });
  // Re-registering on a fresh recorder keeps the handler contract observable without mutating production state.
  const fresh = createIpcMainRecorder();
  registerAppCloudMessagingIpcHandlers({
    IPC_CHANNELS, ipcMain: fresh.ipcMain, registry, resolveAppIdForWebContents: () => appId,
    resolveInstalledManifest: withManifestDefault, listLocalCloudMessages: async () => [],
    sendEncryptedCloudMessage: async (input) => input,
  });
  assert.equal((await fresh.handlers.get(IPC_CHANNELS.appMessagesSend)(event, { friendUserId: 1, message: 'Hi' })).delivery, 'ephemeral');
});

test('BDD: app runtime context tolerates missing manifests and unavailable tool lookups', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const { registerAppRuntimeIpcHandlers } = require('../../dist-electron/main/ipc/app-runtime-handlers.js');
  registerAppRuntimeIpcHandlers({
    APP_CLAUDE_MODEL_OPTIONS: ['claude'], APP_CODEX_MODEL_OPTIONS: ['codex'], BrowserWindow: { fromWebContents: () => null },
    IPC_CHANNELS, ipcMain, dialog: {}, fs, registry: { apps: { app: { appId: 'app' } } }, resolveAppIdForWebContents: () => 'app',
    resolveInstalledManifest: async () => assert.fail('no install root'), resolveInstalledAgents: async () => [{ id: 'agent' }],
    normalizeManifestAgentDefaults: (manifest) => manifest ? assert.fail('expected null manifest') : { provider: 'codex' },
    getCodexAuthStatus: async () => ({ authenticated: false }),
    getOfficialToolsService: () => ({ listToolsForApp: async () => [{ id: 'known' }] }), signAppFolderGrant: () => ({}),
  });
  const context = await handlers.get(IPC_CHANNELS.appGetContext)(event);
  assert.equal(context.agents[0].id, 'agent');
  assert.equal(await handlers.get(IPC_CHANNELS.appToolsGetStatus)(event, 'missing'), null);
});

test('BDD: chat orchestration spreads an absent installed-app context safely into start and resume prompts', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const { registerChatIpcHandlers } = require('../../dist-electron/main/ipc/chat-handlers.js');
  const prompts = [];
  let started;
  registerChatIpcHandlers({
    IPC_CHANNELS, ipcMain, appendInstallLog: async () => {},
    buildCodexPromptWithAppContext: (input) => { prompts.push(input); return input.turnKind; },
    buildForgerToolsContextForApp: async () => 'tools', buildForgerToolsContextForFreeChat: async () => '',
    chatOrchestrator: { startRun: async (input) => { started = input; return { runId: 'run', status: 'running' }; } },
    defaultChatNetworkAccess: true, ensurePathInside: () => true, fs,
    getPrivateDataRoot: () => '/tmp', installedAppPromptContext: async () => undefined,
    path, resolveSelectedAppDisplayName: () => 'App', sanitizeRendererChatTrace: () => ({}),
  });
  await handlers.get(IPC_CHANNELS.chatStartRun)(event, { appId: 'app', prompt: 'Do it' });
  assert.deepEqual(prompts.map((input) => input.turnKind), ['start', 'resume']);
  assert.equal(started.prompt, 'start');
  assert.equal(started.resumePrompt, 'resume');
});
