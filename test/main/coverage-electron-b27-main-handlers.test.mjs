import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createIpcMainRecorder, createTrustedMainWindow } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');
const { registerMainIpcHandlers } = await import('../../dist-electron/main/ipc/main-handlers.js');
const { mainWindow, trustedIpcEvent } = createTrustedMainWindow();

const createDeps = (overrides = {}) => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const deps = {
    APP_CLAUDE_MODEL_OPTIONS: [],
    APP_CODEX_MODEL_OPTIONS: [],
    BetterSqlite3: null,
    BrowserWindow: { fromWebContents: () => null },
    CODEX_USAGE_DASHBOARD_URL: 'https://example.test/usage',
    IPC_CHANNELS,
    app: { getVersion: () => '1.0.0', getPath: () => '/tmp/user-data' },
    appAgentConversationManager: null,
    appendInstallLog: async () => undefined,
    buildCodexPromptWithAppContext: (input) => JSON.stringify(input),
    buildForgerToolsContextForApp: async () => 'app tools',
    buildForgerToolsContextForFreeChat: async () => 'free tools',
    canUseCloudDataSync: () => false,
    chatOrchestrator: null,
    cloudDeviceManager: null,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ensureCatalogStatuses: () => undefined,
    failureDiagnostic: (error, fallbackCode) => ({ technicalCode: error instanceof Error ? error.message : fallbackCode }),
    forgerBackendClient: null,
    forwardCloudSocialEvent: () => undefined,
    fs,
    getConnectionsService: () => ({
      call: async () => ({}),
      configure: async () => ({}),
      disconnect: async () => ({}),
      listConnectionsForApp: async () => ({ types: [], instances: [], requirements: [] }),
      listState: async () => ({ types: [], instances: [] }),
      setAppConnectionGrant: async () => null,
      setDefaultConnection: async () => ({}),
    }),
    getFileLibrary: () => ({}),
    getForgerMetadataRoot: () => '/tmp/metadata',
    getInstallLogPath: () => '/tmp/install.log',
    getOfficialToolsService: () => ({
      activate: async () => ({}),
      callFromAgent: async () => ({}),
      configure: async () => ({}),
      deactivate: async () => ({}),
      getInstallGate: async () => null,
      list: async () => [],
      refresh: async () => [],
      setAppToolGrant: async () => null,
    }),
    getPrivateDataRoot: () => '/tmp/forger-data',
    ipcMain,
    listCatalogFromBackend: async () => [],
    mainWindow,
    path,
    publicForgerAccount: (account) => ({ authenticated: Boolean(account.authenticated) }),
    registry: { apps: {} },
    resolveInstalledManifest: async () => null,
    resolveSelectedAppDisplayName: (appId) => appId,
    sanitizeRendererChatTrace: (input) => ({ traceEvent: input.event }),
    serializeErrorForInstallLog: (error) => ({ message: String(error) }),
    shell: { openExternal: async () => undefined },
    state: {
      agentToolSettings: { approvals: {} },
      catalogApps: [],
      cloudSyncSettings: {},
      forgerAccount: { authenticated: false },
      settings: {},
    },
    toAppSummary: (record) => record,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'getMainWindow')) deps.getMainWindow = () => deps.mainWindow;
  if (!Object.hasOwn(overrides, 'getFriendChatWindows')) deps.getFriendChatWindows = () => [];
  registerMainIpcHandlers(deps);
  return { deps, handlers };
};

const taskStore = () => {
  const upserts = [];
  return {
    upserts,
    store: {
      upsert: async (input) => { upserts.push(input); return input; },
      appendStatusUpdate: async () => undefined,
    },
  };
};

test('main IPC enriches catalog entries, returns a null access gate, and normalizes absent device names', async () => {
  const deviceNames = [];
  const { handlers } = createDeps({
    cloudDeviceManager: {
      updateCloudDeviceName: async ({ name }) => { deviceNames.push(name); return { success: true }; },
    },
    getLocalNetworkShareStatus: (appId) => appId === 'shared' ? { active: true, url: 'http://local' } : undefined,
    getRemoteNetworkShareStatus: (appId) => appId === 'shared' ? { active: true, url: 'https://remote' } : undefined,
    listCatalogFromBackend: async () => [{ id: 'shared' }, { id: 'plain' }],
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listCatalogApps)(trustedIpcEvent), [
    {
      id: 'shared',
      localNetworkShare: { active: true, url: 'http://local' },
      remoteNetworkShare: { active: true, url: 'https://remote' },
    },
    { id: 'plain' },
  ]);
  assert.equal(await handlers.get(IPC_CHANNELS.getAppToolsInstallGate)(trustedIpcEvent, 'shared'), null);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateCloudDeviceName)(trustedIpcEvent, null), { success: true });
  assert.deepEqual(deviceNames, ['']);
});

test('main IPC builds installed-app prompts for every stack alias and explicit runtime control', async () => {
  const dataRoot = await fs.mkdtemp(path.join(tmpdir(), 'b27-main-chat-'));
  const promptInputs = [];
  const manifests = [
    { stack: { backend: { language: 'python' }, frontend: { language: 'typescript' } } },
    { stack: { backend: { framework: 'fastapi' }, frontend: { framework: 'react' } } },
    { stack: { backend: { package_manager: 'uv' }, frontend: { bundler: 'vite' } } },
    { stack: { backend: {}, frontend: { ui: 'mui' } } },
  ];
  let manifestIndex = 0;
  try {
    const { handlers } = createDeps({
      buildCodexPromptWithAppContext: (input) => { promptInputs.push(input); return 'prompt'; },
      chatOrchestrator: { startRun: async () => ({ runId: 'run', status: 'running' }) },
      getPrivateDataRoot: () => dataRoot,
      registry: { apps: { demo: { appId: 'demo', installDir: '/apps/demo' } } },
      resolveInstalledManifest: async () => manifests[manifestIndex++],
    });
    for (let index = 0; index < manifests.length; index += 1) {
      await handlers.get(IPC_CHANNELS.chatStartRun)(trustedIpcEvent, {
        appId: 'demo',
        prompt: 'work',
        provider: 'codex',
        model: 'gpt-test',
        reasoningEffort: 'high',
        effort: 'medium',
      });
    }
    assert.match(promptInputs[0].appStack, /backend python/);
    assert.match(promptInputs[0].runtime, /provider codex, model gpt-test, reasoning high, effort medium/);
    assert.match(promptInputs.at(-2).appStack, /frontend mui/);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test('main IPC applies Windows path containment semantics to shared chat files', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const starts = [];
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  try {
    const { handlers } = createDeps({
      chatOrchestrator: { startRun: async (input) => { starts.push(input); return { runId: 'run', status: 'running' }; } },
      fs: {
        ...fs,
        mkdir: async () => undefined,
        realpath: async (value) => value,
      },
      getPrivateDataRoot: () => 'C:\\Forger\\data',
      path: path.win32,
    });
    await handlers.get(IPC_CHANNELS.chatStartRun)(trustedIpcEvent, {
      prompt: 'inspect',
      sharedFiles: [{ path: 'C:\\Forger\\data\\Report.txt', name: 'Report.txt' }],
    });
    assert.deepEqual(starts[0].sharedFiles.map((entry) => entry.name), ['Report.txt']);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('main IPC keeps deterministic fallback errors for non-Error backup failures', async () => {
  const { handlers } = createDeps({
    createRemoteAppBackup: async () => { throw 'offline'; },
    restoreRemoteAppBackup: async () => { throw 503; },
  });
  assert.equal((await handlers.get(IPC_CHANNELS.createRemoteBackup)(trustedIpcEvent, { appId: 'demo' })).technicalCode, 'remote_backup_create_failed');
  assert.equal((await handlers.get(IPC_CHANNELS.restoreRemoteBackup)(trustedIpcEvent, { remoteBackupId: 1 })).technicalCode, 'remote_backup_restore_failed');
});

test('installed app rename rejects malformed inputs and uses the persisted fallback when registry state changes concurrently', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'b27-main-rename-'));
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ id: 'demo' }), 'utf8');
  const registry = { apps: { demo: { appId: 'demo', installDir: root, privateLocal: true, name: 'Old' } } };
  try {
    const { handlers } = createDeps({
      registry,
      upsertInstalledRecord: async () => { delete registry.apps.demo; },
    });
    assert.equal((await handlers.get(IPC_CHANNELS.renameInstalledApp)(trustedIpcEvent, null)).technicalCode, 'app_not_installed');
    const result = await handlers.get(IPC_CHANNELS.renameInstalledApp)(trustedIpcEvent, { appId: 'demo', name: 'New' });
    assert.equal(result.success, true);
    assert.equal(result.app.name, 'New');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('social and friendship IPC delegates when available and rejects privileged actions without a backend', async () => {
  const backend = createDeps({
    forgerBackendClient: {
      listFriends: async () => [{ id: 1 }],
      searchFriends: async (username) => [{ username }],
    },
  });
  assert.deepEqual(await backend.handlers.get(IPC_CHANNELS.listFriends)(trustedIpcEvent), [{ id: 1 }]);
  assert.deepEqual(await backend.handlers.get(IPC_CHANNELS.searchFriends)(trustedIpcEvent, 'ada'), [{ username: 'ada' }]);

  const missing = createDeps();
  assert.deepEqual(await missing.handlers.get(IPC_CHANNELS.listFriends)(trustedIpcEvent), []);
  assert.deepEqual(await missing.handlers.get(IPC_CHANNELS.searchFriends)(trustedIpcEvent, 'ada'), []);
  await assert.rejects(missing.handlers.get(IPC_CHANNELS.declineFriendRequest)(trustedIpcEvent, 1), /backend_client_missing/);
  await assert.rejects(missing.handlers.get(IPC_CHANNELS.cancelFriendRequest)(trustedIpcEvent, 1), /backend_client_missing/);
  await assert.rejects(missing.handlers.get(IPC_CHANNELS.markFriendChatRead)(trustedIpcEvent, 1), /backend_client_missing/);
});

test('conversation diagnostics resolve the app conversation manager and submit without an attachment token', async () => {
  const snapshots = [];
  const submitted = [];
  const { handlers } = createDeps({
    appAgentConversationManager: {
      getDiagnosticSnapshot: async (...args) => { snapshots.push(args); return null; },
    },
    forgerBackendClient: {
      submitConversationDiagnosticReport: async (input, attachments) => { submitted.push({ input, attachments }); return { success: true }; },
    },
    getCodexHome: () => '/codex',
    getForgerHomeRoot: () => '/forger',
    getPrivateAppsRoot: () => '/apps',
  });
  await handlers.get(IPC_CHANNELS.prepareConversationDiagnosticReport)(trustedIpcEvent, {
    source: 'app_agent_conversation',
    appId: 'demo',
    conversationId: 'conversation',
    title: 'Diagnostic',
  });
  assert.deepEqual(snapshots, [['demo', 'conversation', undefined]]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.submitConversationDiagnosticReport)(trustedIpcEvent, {
    source: 'desktop_chat', conversationId: 'conversation', title: 'Diagnostic',
  }), { success: true });
  assert.deepEqual(submitted[0].attachments, []);
});

test('desktop log IPC falls back to the install-log directory when metadata roots are unavailable', async () => {
  const desktopLogger = require('../../dist-electron/main/desktop-logger.js');
  const originalAppend = desktopLogger.appendDesktopLog;
  const logs = [];
  desktopLogger.appendDesktopLog = async (input) => logs.push(input);
  try {
    const { handlers } = createDeps({
      getForgerMetadataRoot: undefined,
      getInstallLogPath: () => '/logs/install.jsonl',
    });
    assert.deepEqual(await handlers.get(IPC_CHANNELS.desktopLog)(trustedIpcEvent, { event: 'ready' }), { success: true });
    assert.equal(logs[0].metadataRoot, '/logs');
  } finally {
    desktopLogger.appendDesktopLog = originalAppend;
  }
});

test('social uploads preserve fallback names, slugs, categories, and non-link success messages', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'b27-social-upload-'));
  const symbolRoot = path.join(root, 'symbol');
  const localRoot = path.join(root, 'local');
  await fs.mkdir(symbolRoot);
  await fs.mkdir(localRoot);
  await fs.writeFile(path.join(symbolRoot, 'app.txt'), 'symbol', 'utf8');
  await fs.writeFile(path.join(localRoot, 'app.txt'), 'local', 'utf8');
  const tasks = taskStore();
  const uploads = [];
  const installed = [];
  const registry = {
    apps: {
      symbol: { appId: 'symbol', installDir: symbolRoot, socialSource: { userAppId: 3 }, description: 'Symbol' },
      local: { appId: 'local', installDir: localRoot, privateLocal: true, description: 'Local' },
    },
  };
  try {
    const { handlers, deps } = createDeps({
      forgerBackendClient: {
        uploadSocialApp: async (input) => {
          uploads.push(input);
          return { id: uploads.length, name: '', slug: '', owner: { username: 'owner' } };
        },
        createSocialAppShare: async () => ({}),
      },
      getBackgroundTaskStore: () => tasks.store,
      registry,
      state: {
        agentToolSettings: { approvals: {} },
        catalogApps: [{ id: 'symbol', name: 'Old' }, { id: 'other', name: 'Other' }, { id: 'local', name: 'Old local' }],
        cloudSyncSettings: {}, forgerAccount: { authenticated: true }, settings: {},
      },
      upsertInstalledRecord: async (record) => installed.push(record),
      validateArchiveEntries: async () => undefined,
      zipDirectory: async (_source, zipPath) => fs.writeFile(zipPath, 'zip', 'utf8'),
    });
    const symbol = await handlers.get(IPC_CHANNELS.uploadSocialApp)(trustedIpcEvent, { appId: 'symbol', name: '✨' });
    const local = await handlers.get(IPC_CHANNELS.uploadSocialApp)(trustedIpcEvent, { appId: 'local', name: '   ' });
    const explicit = await handlers.get(IPC_CHANNELS.uploadSocialApp)(trustedIpcEvent, { appId: 'local', slug: 'custom-local' });

    assert.equal(symbol.success, true);
    assert.equal(symbol.share.deepLink, undefined);
    assert.equal(tasks.upserts.find((entry) => entry.status === 'succeeded').result.message, 'App subida a Social.');
    assert.equal(uploads[0].slug, 'social-app');
    assert.equal(uploads[0].category, 'productivity');
    assert.equal(uploads[1].name, 'local');
    assert.equal(uploads[1].slug, 'local');
    assert.equal(uploads[2].slug, 'custom-local');
    assert.equal(installed[0].name, '✨');
    assert.equal(installed[0].publishedSocialSource.slug, 'symbol');
    assert.deepEqual(deps.state.catalogApps.find((entry) => entry.id === 'other'), { id: 'other', name: 'Other' });
    assert.equal(local.success, true);
    assert.equal(explicit.success, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('social upload failures use safe diagnostic fallbacks and retain structured details', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'b27-social-upload-fail-'));
  await fs.writeFile(path.join(root, 'app.txt'), 'app', 'utf8');
  const tasks = taskStore();
  try {
    const { handlers } = createDeps({
      failureDiagnostic: () => ({ technicalCode: null, details: { stage: 'archive' } }),
      forgerBackendClient: { uploadSocialApp: async () => assert.fail('archive failure stops upload') },
      getBackgroundTaskStore: () => tasks.store,
      registry: { apps: { demo: { appId: 'demo', installDir: root, privateLocal: true } } },
      validateArchiveEntries: async () => undefined,
      zipDirectory: async () => { throw new Error('archive_failed'); },
    });
    const result = await handlers.get(IPC_CHANNELS.uploadSocialApp)(trustedIpcEvent, { appId: 'demo' });
    assert.equal(result.success, false);
    const failed = tasks.upserts.at(-1);
    assert.equal(failed.result.technicalCode, 'social_upload_failed');
    assert.deepEqual(failed.result.details, { stage: 'archive' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
