import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createIpcMainRecorder } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerMainIpcHandlers } = require('../../dist-electron/main/ipc/main-handlers.js');

const createDeps = async (overrides = {}) => {
  const electronMock = {
    BrowserWindow: {
      fromWebContents: () => null,
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    shell: {
      openExternal: async () => undefined,
    },
  };

    const { handlers, ipcMain } = createIpcMainRecorder();
    const logs = [];
    const deps = {
      APP_CLAUDE_MODEL_OPTIONS: [],
      APP_CODEX_MODEL_OPTIONS: [],
      BetterSqlite3: null,
      BrowserWindow: electronMock.BrowserWindow,
      CODEX_USAGE_DASHBOARD_URL: 'https://platform.openai.com/usage',
      IPC_CHANNELS,
      app: {
        getVersion: () => '0.0.0-test',
      },
      appAgentConversationManager: null,
      appAgentTaskManager: null,
      appendInstallLog: async (event, payload) => logs.push({ event, payload }),
      automationManager: null,
      buildAppSecretsState: async () => ({ declarations: [], connections: [] }),
      buildCodexPromptWithAppContext: ({ userPrompt }) => `app:${userPrompt}`,
      buildForgerToolsContextForApp: async () => 'app tools',
      buildForgerToolsContextForFreeChat: async () => 'free tools',
      canUseCloudDataSync: () => false,
      chatOrchestrator: null,
      cloudDeviceManager: null,
      connectClaudeAuth: async () => ({ success: true }),
      connectCodexAuth: async () => ({ success: true }),
      createRemoteAppBackup: async () => ({ success: true }),
      decryptCloudMessage: async (message) => message,
      decryptCloudMessages: async (messages) => messages,
      desktopErrorReporter: null,
      dialog: electronMock.dialog,
      disconnectCodexAuth: async () => ({ success: true }),
      ensureCatalogStatuses: () => undefined,
      failureDiagnostic: (error, fallbackCode) => ({
        technicalCode: error instanceof Error ? error.message : fallbackCode,
      }),
      forgerBackendClient: null,
      forwardCloudSocialEvent: () => undefined,
      fs,
      getAppDetails: async () => null,
      getBackupsManager: () => ({
        createBackup: async () => ({ success: true }),
        deleteBackup: async () => ({ success: true }),
        listBackups: async () => [],
        restoreBackup: async () => ({ success: true }),
      }),
      getClaudeAuthStatus: async () => ({ authenticated: false }),
      getCloudIdentityStore: () => ({
        getSummary: async () => ({}),
        regenerate: async () => ({}),
        revealSecretKey: async () => ({}),
      }),
      getCodexAuthStatus: async () => ({ authenticated: true }),
      getDesktopUpdater: () => ({
        check: async () => ({ status: 'checking' }),
        download: async () => ({ status: 'downloading' }),
        getState: () => ({ status: 'idle' }),
        install: async () => ({ status: 'installing' }),
      }),
      getFileLibrary: () => ({
        createCategory: async () => ({}),
        deleteCategory: async () => ({}),
        deleteFiles: async () => ({}),
        discardStagedFilesForChat: async () => ({}),
        importFiles: async () => ({}),
        list: async () => [],
        listCategories: async () => [],
        moveFiles: async () => ({}),
        pickFileInfo: async (filePaths) => filePaths,
        renameCategory: async () => ({}),
        renameFile: async () => ({}),
        stageFileForChat: async () => ({}),
      }),
      getInstallLogPath: () => '/tmp/forger-install.log',
      getMemoryStore: () => ({
        create: async () => ({}),
        delete: async () => ({}),
        list: async () => [],
        update: async () => ({}),
      }),
      getOfficialToolsService: () => ({
        activate: async () => ({}),
        callFromApp: async () => ({}),
        configure: async () => ({}),
        deactivate: async () => ({}),
        getInstallGate: async () => null,
        list: async () => [],
        listToolsForApp: async () => [],
        refresh: async () => [],
        setAppToolGrant: async () => null,
      }),
      getPrivateDataRoot: () => '/tmp/forger-private-data',
      getRuntimeStatus: () => ({ status: 'stopped' }),
      getSecretsStore: () => ({
        connectAppSecret: async () => ({ success: true }),
        createUserSecret: async () => ({}),
        deleteUserSecret: async () => ({}),
        disconnectAppSecret: async () => ({ success: true }),
        listUserSecrets: async () => [],
        updateUserSecret: async () => ({}),
      }),
      installAppRuntime: async () => ({ success: true }),
      installSocialAppRuntime: async () => ({ success: true }),
      installWelcome: async () => ({ success: true }),
      ipcMain,
      listAppPrompts: async () => [],
      listCatalogFromBackend: async () => [],
      mainWindow: null,
      normalizeManifestAgentDefaults: () => ({}),
      openInstalledApp: async () => ({ success: true }),
      openOrFocusFriendChatWindow: async () => ({ success: true }),
      path,
      publicForgerAccount: (account) => ({ authenticated: Boolean(account.authenticated) }),
      registry: { apps: {} },
      reinstallClaude: async () => ({ success: true }),
      reinstallCodex: async () => ({ success: true }),
      resolveAppIdForWebContents: () => null,
      resolveInstalledAgents: async () => [],
      resolveInstalledAppSecrets: async () => [],
      resolveInstalledManifest: async () => null,
      resolveSelectedAppDisplayName: (appId) => appId,
      restoreAppPrompt: async () => ({ success: true }),
      restoreAppUserVersionRuntime: async () => ({ success: true }),
      restoreRemoteAppBackup: async () => ({ success: true }),
      sanitizeRendererChatTrace: (input) => ({ traceEvent: input.event }),
      sendEncryptedCloudMessage: async (input) => input,
      serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
      setAppAutoSyncSetting: async () => ({}),
      shell: electronMock.shell,
      signAppFolderGrant: () => ({ canceled: false }),
      state: {
        agentToolSettings: { approvals: {} },
        catalogApps: [],
        cloudSyncSettings: {},
        forgerAccount: { authenticated: false },
        settings: {},
      },
      stopInstalledApp: async () => ({ success: true }),
      switchForgerAccountSession: async (account) => ({ authenticated: Boolean(account.authenticated) }),
      toAppSummary: (record) => record,
      uninstallAppRuntime: async () => ({ success: true }),
      updateAgentDefaults: async () => ({}),
      updateAgentToolApproval: async () => ({}),
      updateAppPrompt: async () => ({ success: true }),
      updateAppRuntime: async () => ({ success: true }),
      updateCodexDefaults: async () => ({}),
      validateAppPrompt: async () => ({ valid: true }),
      ...overrides,
    };

    registerMainIpcHandlers(deps);
    return { deps, handlers, IPC_CHANNELS, logs };
};

const eventForWebContents = (id = 1) => ({ sender: { id } });

test('main IPC backup handlers convert manager failures into user-visible errors and install logs', async () => {
  const error = new Error('disk_full');
  const { handlers, IPC_CHANNELS, logs } = await createDeps({
    getBackupsManager: () => ({
      createBackup: async () => {
        throw error;
      },
      deleteBackup: async () => {
        throw new Error('delete_denied');
      },
      listBackups: async () => [],
      restoreBackup: async () => {
        throw new Error('restore_denied');
      },
    }),
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.createBackup)(null, { appId: 'finance-os', reason: 'manual' }),
    {
      success: false,
      userMessage: 'No pudimos crear el respaldo.',
      technicalCode: 'disk_full',
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.deleteBackup)(null, { appId: 'finance-os', backupId: 'b1' }),
    {
      success: false,
      userMessage: 'No pudimos eliminar ese respaldo.',
      technicalCode: 'delete_denied',
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.restoreBackup)(null, { appId: 'finance-os', backupId: 'b1' }),
    {
      success: false,
      userMessage: 'No pudimos restaurar ese respaldo.',
      technicalCode: 'restore_denied',
    },
  );
  assert.deepEqual(logs.map((entry) => entry.event), [
    'backup:create_failed',
    'backup:delete_failed',
    'backup:restore_failed',
  ]);
});

test('main IPC cloud and social handlers return explicit errors when backend services are unavailable', async () => {
  const { handlers, IPC_CHANNELS } = await createDeps();

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listRemoteBackups)(null, 'finance-os'), {
    backups: [],
    usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deleteRemoteBackup)(null, 5), {
    success: false,
    userMessage: 'Forger Cloud Sync requiere una cuenta demo o pro.',
    technicalCode: 'subscription_required',
  });
  await assert.rejects(handlers.get(IPC_CHANNELS.sendFriendRequest)(null, 'ada'), /backend_client_missing/);
  await assert.rejects(handlers.get(IPC_CHANNELS.acceptFriendRequest)(null, 1), /backend_client_missing/);
  await assert.rejects(handlers.get(IPC_CHANNELS.decideAppMessagePermission)(null, 1, 'allow'), /backend_client_missing/);
});

test('main IPC external link handlers reject unsafe URLs and return diagnostics on shell failures', async () => {
  const { handlers, IPC_CHANNELS } = await createDeps({
    shell: {
      openExternal: async () => {
        throw new Error('shell_blocked');
      },
    },
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(null, 'http://example.com'), {
    success: false,
    userMessage: 'No pudimos abrir ese enlace.',
    technicalCode: 'unsupported_url_protocol',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(null, 'https://example.com'), {
    success: false,
    userMessage: 'No pudimos abrir ese enlace.',
    technicalCode: 'shell_blocked',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openCodexUsageDashboard)(), {
    success: false,
    technicalCode: 'shell_blocked',
    userMessage: 'No pudimos abrir el panel de uso de Codex.',
  });
});

test('main IPC app-scoped handlers enforce app-window authorization before exposing app capabilities', async () => {
  const { handlers, IPC_CHANNELS } = await createDeps();

  await assert.rejects(handlers.get(IPC_CHANNELS.appSelectExternalFolder)(eventForWebContents()), /app_window_not_authorized/);
  await assert.rejects(handlers.get(IPC_CHANNELS.appAiSubscriptionStatus)(eventForWebContents()), /app_window_not_authorized/);
  await assert.rejects(handlers.get(IPC_CHANNELS.appToolsListAvailable)(eventForWebContents()), /app_window_not_authorized/);
  await assert.rejects(handlers.get(IPC_CHANNELS.appToolsGetStatus)(eventForWebContents(), 'gmail'), /app_window_not_authorized/);
  await assert.rejects(handlers.get(IPC_CHANNELS.appToolsCall)(eventForWebContents(), { toolId: 'gmail.search_messages' }), /app_window_not_authorized/);
  await assert.rejects(handlers.get(IPC_CHANNELS.appMessagesSend)(eventForWebContents(), { friendUserId: 1, body: 'hi' }), /app_window_not_authorized/);
  await assert.rejects(handlers.get(IPC_CHANNELS.appMessagesList)(eventForWebContents(), 1), /app_window_not_authorized/);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appGetContext)(eventForWebContents()), {});
});

test('main IPC app-scoped handlers delegate authorized context, tools, folders, and app messages', async () => {
  const calls = [];
  const { handlers, IPC_CHANNELS } = await createDeps({
    BrowserWindow: {
      fromWebContents: (sender) => ({ sender, isDestroyed: () => false }),
    },
    dialog: {
      showOpenDialog: async (...args) => {
        calls.push(['dialog', args.length]);
        return { canceled: false, filePaths: ['/tmp/shared'] };
      },
    },
    fs: {
      ...fs,
      realpath: async (targetPath) => `/real${targetPath}`,
    },
    getCodexAuthStatus: async () => ({ authenticated: true }),
    getOfficialToolsService: () => ({
      activate: async () => ({}),
      callFromApp: async (appId, input) => {
        calls.push(['callFromApp', appId, input.toolId]);
        return { ok: true };
      },
      configure: async () => ({}),
      deactivate: async () => ({}),
      getInstallGate: async () => null,
      list: async () => [],
      listToolsForApp: async (appId) => {
        calls.push(['listToolsForApp', appId]);
        return [{ id: 'gmail', name: 'Gmail' }];
      },
      refresh: async () => [],
      setAppToolGrant: async () => null,
    }),
    normalizeManifestAgentDefaults: (manifest) => ({ provider: manifest?.agentProvider ?? 'codex' }),
    registry: {
      apps: {
        'finance-os': {
          appId: 'finance-os',
          installDir: '/apps/finance-os',
          name: 'Finance OS',
        },
      },
    },
    resolveAppIdForWebContents: () => 'finance-os',
    resolveInstalledAgents: async () => [{ id: 'advisor' }],
    resolveInstalledManifest: async () => ({
      agentProvider: 'claude',
      cloudMessaging: { enabled: true, defaultDelivery: 'ephemeral' },
    }),
    sendEncryptedCloudMessage: async (input) => {
      calls.push(['sendEncryptedCloudMessage', input]);
      return { id: 1, ...input };
    },
    signAppFolderGrant: (appId, folderPath) => ({ appId, folderPath, signature: 'sig' }),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.appAiSubscriptionStatus)(eventForWebContents()), {
    connected: true,
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appGetContext)(eventForWebContents()), {
    agents: [{ id: 'advisor' }],
    agentDefaults: { provider: 'claude' },
    agentModelOptions: {
      codex: [],
      claude: [],
    },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appToolsListAvailable)(eventForWebContents()), [
    { id: 'gmail', name: 'Gmail' },
  ]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appToolsGetStatus)(eventForWebContents(), 'gmail'), {
    id: 'gmail',
    name: 'Gmail',
  });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appToolsCall)(eventForWebContents(), { toolId: 'gmail.search' }),
    { ok: true },
  );
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appSelectExternalFolder)(eventForWebContents()), {
    appId: 'finance-os',
    folderPath: '/real/tmp/shared',
    signature: 'sig',
  });
  const canceledPicker = await createDeps({
    BrowserWindow: {
      fromWebContents: () => null,
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    resolveAppIdForWebContents: () => 'finance-os',
  });
  assert.deepEqual(await canceledPicker.handlers.get(IPC_CHANNELS.appSelectExternalFolder)(eventForWebContents()), {
    canceled: true,
  });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appMessagesSend)(eventForWebContents(), {
      friendUserId: 7,
      body: 'hello',
    }),
    {
      id: 1,
      friendUserId: 7,
      body: 'hello',
      delivery: 'ephemeral',
      source: 'app',
      sourceAppId: 'finance-os',
      sourceAppName: 'Finance OS',
    },
  );
  assert.deepEqual(calls, [
    ['listToolsForApp', 'finance-os'],
    ['listToolsForApp', 'finance-os'],
    ['callFromApp', 'finance-os', 'gmail.search'],
    ['dialog', 2],
    ['sendEncryptedCloudMessage', {
      friendUserId: 7,
      body: 'hello',
      delivery: 'ephemeral',
      source: 'app',
      sourceAppId: 'finance-os',
      sourceAppName: 'Finance OS',
    }],
  ]);
});

test('main IPC app message list enforces manifest opt-in and decrypts backend messages when enabled', async () => {
  const disabled = await createDeps({
    registry: {
      apps: {
        'finance-os': { appId: 'finance-os', installDir: '/apps/finance-os' },
      },
    },
    resolveAppIdForWebContents: () => 'finance-os',
    resolveInstalledManifest: async () => ({ cloudMessaging: { enabled: false } }),
  });
  await assert.rejects(
    disabled.handlers.get(IPC_CHANNELS.appMessagesList)(eventForWebContents(), 3),
    /app_cloud_messaging_not_declared/,
  );
  await assert.rejects(
    disabled.handlers.get(IPC_CHANNELS.appMessagesSend)(eventForWebContents(), { friendUserId: 3, body: 'hello' }),
    /app_cloud_messaging_not_declared/,
  );

  const decryptCalls = [];
  const enabled = await createDeps({
    decryptCloudMessages: async (messages) => {
      decryptCalls.push(messages);
      return messages.map((message) => ({ ...message, decrypted: true }));
    },
    forgerBackendClient: {
      listCloudMessages: async (friendUserId) => [{ id: 9, friendUserId }],
    },
    registry: {
      apps: {
        'finance-os': { appId: 'finance-os', installDir: '/apps/finance-os' },
      },
    },
    resolveAppIdForWebContents: () => 'finance-os',
    resolveInstalledManifest: async () => ({ cloudMessaging: { enabled: true } }),
  });
  assert.deepEqual(await enabled.handlers.get(IPC_CHANNELS.appMessagesList)(eventForWebContents(), 3), [
    { id: 9, friendUserId: 3, decrypted: true },
  ]);
  assert.deepEqual(decryptCalls, [[{ id: 9, friendUserId: 3 }]]);
});

test('main IPC chat handlers use safe fallbacks and sanitize shared files before starting a run', async () => {
  const starts = [];
  const { handlers, IPC_CHANNELS } = await createDeps({
    buildCodexPromptWithAppContext: ({ userPrompt, sharedFiles }) => JSON.stringify({ userPrompt, sharedFiles }),
    buildForgerToolsContextForApp: async () => '',
    chatOrchestrator: {
      approvePermission: async () => ({ success: true }),
      applyRun: async () => ({ success: true }),
      cancelRun: () => ({ success: true }),
      getRun: () => ({ runId: 'run-1' }),
      startRun: async (input) => {
        starts.push(input);
        return { runId: 'run-1', status: 'running' };
      },
      undo: async () => ({ success: true }),
    },
    fs: {
      ...fs,
      mkdir: async () => undefined,
      realpath: async (targetPath) => {
        if (targetPath.includes('blocked')) {
          return '/private/blocked.txt';
        }
        return targetPath;
      },
    },
    getPrivateDataRoot: () => '/tmp/forger-data',
  });

  const withoutChat = await createDeps();
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatStartRun)(null, { prompt: 'hello' }), {
    runId: '',
    status: 'failed',
  });
  assert.equal(await withoutChat.handlers.get(IPC_CHANNELS.chatGetRun)(null, { runId: 'run-1' }), null);
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatCancelRun)(null, { runId: 'run-1' }), { success: false });
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatApprovePermission)(null, { runId: 'run-1' }), { success: false });
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatApplyRun)(null, { runId: 'run-1' }), {
    success: false,
    technicalCode: 'chat_orchestrator_unavailable',
  });
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatUndo)(null, { runId: 'run-1' }), {
    success: false,
    technicalCode: 'chat_orchestrator_unavailable',
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatStartRun)(null, {
      appId: 'finance-os',
      prompt: 'load files',
      sharedFiles: [
        { path: 'ok.csv', relativePath: 'ok.csv', name: 'ok.csv' },
        { path: '../blocked.txt', relativePath: '../blocked.txt', name: 'blocked.txt' },
      ],
    }),
    { runId: 'run-1', status: 'running' },
  );
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].sharedFiles.map((file) => file.path), ['/tmp/forger-data/ok.csv']);
  assert.match(starts[0].prompt, /ok\.csv/);
  assert.doesNotMatch(starts[0].prompt, /blocked\.txt/);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatGetRun)(null, { runId: 'run-1' }), { runId: 'run-1' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatCancelRun)(null, { runId: 'run-1' }), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatApprovePermission)(null, { runId: 'run-1' }), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatApplyRun)(null, { runId: 'run-1' }), { success: true });
});

test('main IPC chat handlers delegate permissions, undo, conflict resolution, and renderer traces safely', async () => {
  const starts = [];
  const { handlers, IPC_CHANNELS, logs } = await createDeps({
    buildCodexPromptWithAppContext: (input) => JSON.stringify(input),
    buildForgerToolsContextForApp: async () => 'app tools context',
    chatOrchestrator: {
      approvePermission: (input) => ({ success: true, approved: input.decision === 'allow' }),
      applyRun: async () => ({ success: true }),
      cancelRun: () => ({ success: true }),
      getRun: () => ({ runId: 'run-1' }),
      startRun: async (input) => {
        starts.push(input);
        return { runId: 'run-conflict', status: 'running' };
      },
      undo: async (input) => ({ success: true, undoRunId: input.runId }),
    },
    getPrivateDataRoot: () => '/tmp/forger-private-data',
    registry: {
      apps: {
        'finance-os': {
          appId: 'finance-os',
          status: 'conflict',
          pendingUpdate: { version: '0.2.0' },
        },
      },
    },
    resolveSelectedAppDisplayName: () => 'Finance OS',
    sanitizeRendererChatTrace: (input) => ({ event: input.event, runId: input.runId ?? null }),
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.resolveAppUpdateConflict)(null, 'missing-app'),
    {
      success: false,
      userMessage: 'No hay una actualizacion en conflicto para resolver.',
      technicalCode: 'no_pending_update_conflict',
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.resolveAppUpdateConflict)(null, 'finance-os'),
    { runId: 'run-conflict', status: 'running' },
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].appId, 'finance-os');
  assert.equal(starts[0].dangerMode, true);
  assert.match(starts[0].prompt, /Finance OS/);
  assert.match(starts[0].prompt, /app tools context/);

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatApprovePermission)(null, { runId: 'run-1', requestId: 'req-1', decision: 'allow' }),
    { success: true, approved: true },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatUndo)(null, { runId: 'run-1' }),
    { success: true, undoRunId: 'run-1' },
  );

  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatTrace)(null, { event: 'unknown_event' }), { success: false });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatTrace)(null, { event: 'chat_run_event_received', runId: 'run-1' }),
    { success: true },
  );
  assert.deepEqual(logs.at(-1), {
    event: 'chat_renderer_trace',
    payload: { event: 'chat_run_event_received', runId: 'run-1' },
  });
});

test('main IPC file picker uses the owning window when available and falls back for destroyed windows', async () => {
  const dialogCalls = [];
  const pickedPaths = [];
  const mainWindow = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  const { handlers, IPC_CHANNELS } = await createDeps({
    dialog: {
      showOpenDialog: async (...args) => {
        dialogCalls.push(args);
        return { canceled: false, filePaths: ['/tmp/one.csv', '/tmp/two.csv'] };
      },
    },
    getFileLibrary: () => ({
      pickFileInfo: async (filePaths) => {
        pickedPaths.push(filePaths);
        return filePaths.map((filePath) => ({ path: filePath, name: path.basename(filePath) }));
      },
    }),
    mainWindow,
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesPickForChat)(), [
    { path: '/tmp/one.csv', name: 'one.csv' },
    { path: '/tmp/two.csv', name: 'two.csv' },
  ]);
  mainWindow.destroyed = true;
  await handlers.get(IPC_CHANNELS.filesPickForChat)();

  assert.equal(dialogCalls.length, 2);
  assert.equal(dialogCalls[0][0], mainWindow);
  assert.deepEqual(dialogCalls[0][1], { properties: ['openFile', 'multiSelections'] });
  assert.deepEqual(dialogCalls[1][0], { properties: ['openFile', 'multiSelections'] });
  assert.deepEqual(pickedPaths, [
    ['/tmp/one.csv', '/tmp/two.csv'],
    ['/tmp/one.csv', '/tmp/two.csv'],
  ]);

  const canceled = await createDeps({
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
  });
  assert.deepEqual(await canceled.handlers.get(IPC_CHANNELS.filesPickForChat)(), []);
});

test('main IPC remote backup and account handlers preserve safe fallbacks and refresh catalog state', async () => {
  const logs = [];
  const catalog = [{ id: 'finance-os' }];
  const switched = [];
  const { handlers, IPC_CHANNELS, deps } = await createDeps({
    appendInstallLog: async (event, payload) => logs.push({ event, payload }),
    createRemoteAppBackup: async () => {
      throw new Error('upload_denied');
    },
    listCatalogFromBackend: async () => catalog,
    restoreRemoteAppBackup: async () => {
      throw new Error('restore_denied');
    },
    switchForgerAccountSession: async (account, result) => {
      switched.push({ account, result });
      deps.state.forgerAccount = { ...account, authenticated: Boolean(account.authenticated) };
      return { authenticated: Boolean(account.authenticated) };
    },
    forgerBackendClient: {
      loginAccount: async () => ({ success: true, authenticated: true, token: 'token-1', userMessage: 'ok' }),
      logoutAccount: async () => {
        throw new Error('logout_network_failed');
      },
      updateAccountProfile: async () => ({ success: true, authenticated: true, username: 'ada', userMessage: 'saved' }),
    },
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.createRemoteBackup)(null, { appId: 'finance-os' }),
    {
      success: false,
      userMessage: 'No pudimos subir el respaldo a Forger Cloud.',
      technicalCode: 'upload_denied',
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.restoreRemoteBackup)(null, { remoteBackupId: 42 }),
    {
      success: false,
      userMessage: 'No pudimos restaurar el respaldo cloud.',
      technicalCode: 'restore_denied',
    },
  );
  assert.deepEqual(logs.map((entry) => entry.event), [
    'remote_backup:create_failed',
    'remote_backup:restore_failed',
  ]);

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.loginForgerAccount)(null, { email: 'ada@example.com', password: 'secret' }),
    { authenticated: true, success: true, userMessage: 'ok', technicalCode: undefined },
  );
  assert.deepEqual(deps.state.catalogApps, catalog);
  assert.equal(switched[0].account.token, 'token-1');

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.updateForgerAccountProfile)(null, { username: 'ada' }),
    { authenticated: true, success: true, userMessage: 'saved', technicalCode: undefined },
  );
  assert.equal(switched.at(-1).account.username, 'ada');

  assert.deepEqual(await handlers.get(IPC_CHANNELS.logoutForgerAccount)(), {
    authenticated: false,
    success: true,
  });
  assert.deepEqual(deps.state.catalogApps, catalog);
});

test('main IPC delegates common service handlers and returns backend-missing fallbacks', async () => {
  const calls = [];
  const accountState = { authenticated: false };
  const { handlers, IPC_CHANNELS, deps } = await createDeps({
    registry: {
      apps: {
        'finance-os': { id: 'finance-os', name: 'Finance OS', status: 'installed' },
      },
    },
    toAppSummary: (record) => ({ id: record.id, name: record.name }),
    listCatalogFromBackend: async () => [{ id: 'finance-os', name: 'Finance OS' }],
    getLocalNetworkShareStatus: (appId) => ({ active: true, appId, url: 'http://192.168.1.20:5555' }),
    startLocalNetworkShare: async (appId) => ({ success: true, appId, status: { active: true, appId } }),
    stopLocalNetworkShare: async (appId) => ({ success: true, appId, status: { active: false, appId } }),
    ensureCatalogStatuses: () => calls.push(['ensureCatalogStatuses']),
    state: {
      agentToolSettings: { approvals: {} },
      catalogApps: [],
      cloudSyncSettings: { enabled: true },
      forgerAccount: accountState,
      settings: { locale: 'es' },
    },
    getCloudIdentityStore: () => ({
      getSummary: async () => ({ keyFingerprint: 'fingerprint' }),
      revealSecretKey: async () => ({ privateKey: 'secret' }),
      regenerate: async () => ({ keyFingerprint: 'new-fingerprint' }),
    }),
    cloudDeviceManager: {
      getState: async () => ({ connected: true }),
      generatePairingCode: async () => ({ success: true, pairingCode: 'ABC12345' }),
      start: async () => calls.push(['cloudDeviceStart']),
    },
    getDesktopUpdater: () => ({
      check: async () => ({ status: 'available' }),
      download: async () => ({ status: 'downloaded' }),
      getState: () => ({ status: 'idle' }),
      install: async () => ({ status: 'installing' }),
    }),
    getMemoryStore: () => ({
      create: async (input, access) => ({ input, access }),
      delete: async (id, access) => ({ id, access, success: true }),
      list: async (input, access) => [{ input, access }],
      update: async (input, access) => ({ input, access }),
    }),
    getSecretsStore: () => ({
      connectAppSecret: async () => ({ success: true }),
      createUserSecret: async (input) => ({ input }),
      deleteUserSecret: async (id) => ({ id }),
      disconnectAppSecret: async () => ({ success: true }),
      listUserSecrets: async () => [{ id: 'secret-1' }],
      updateUserSecret: async (input) => ({ input }),
    }),
    resolveInstalledAppSecrets: async () => [{ name: 'API_KEY' }],
    switchForgerAccountSession: async (account) => {
      Object.assign(accountState, account);
      return { authenticated: Boolean(account.authenticated) };
    },
    publicForgerAccount: (account) => ({ authenticated: Boolean(account.authenticated) }),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listInstalledApps)(), [{ id: 'finance-os', name: 'Finance OS' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listCatalogApps)(), [{
    id: 'finance-os',
    name: 'Finance OS',
    localNetworkShare: { active: true, appId: 'finance-os', url: 'http://192.168.1.20:5555' },
  }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.startLocalNetworkShare)(null, 'finance-os'), {
    success: true,
    appId: 'finance-os',
    status: { active: true, appId: 'finance-os' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.stopLocalNetworkShare)(null, 'finance-os'), {
    success: true,
    appId: 'finance-os',
    status: { active: false, appId: 'finance-os' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getLocalNetworkShareStatus)(null, 'finance-os'), {
    active: true,
    appId: 'finance-os',
    url: 'http://192.168.1.20:5555',
  });
  assert.equal(calls.some(([name]) => name === 'ensureCatalogStatuses'), true);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCloudSyncSettings)(), { enabled: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getSettings)(), { locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getForgerAccount)(), { authenticated: false });

  assert.equal((await handlers.get(IPC_CHANNELS.registerForgerAccount)(null, {})).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.loginForgerAccount)(null, {})).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.updateForgerAccountProfile)(null, { username: 'ada' })).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.submitProductFeedback)(null, {})).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.submitUsageEvent)(null, { eventName: 'app_opened' })).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.submitDesktopErrorReport)(null, { source: 'main', operation: 'op', message: 'fail' })).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.submitAppRating)(null, { appId: 'finance-os' })).technicalCode, 'backend_client_missing');

  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCloudDevices)(), { connected: true });
  assert.equal((await handlers.get(IPC_CHANNELS.generateDevicePairingCode)()).pairingCode, 'ABC12345');
  assert.equal((await handlers.get(IPC_CHANNELS.getCloudIdentity)()).keyFingerprint, 'fingerprint');
  assert.equal((await handlers.get(IPC_CHANNELS.revealCloudSecretKey)()).privateKey, 'secret');
  assert.equal((await handlers.get(IPC_CHANNELS.regenerateCloudSecretKey)()).keyFingerprint, 'new-fingerprint');
  assert.equal(calls.some(([name]) => name === 'cloudDeviceStart'), true);

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listUserSecrets)(), [{ id: 'secret-1' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.connectAppSecret)(null, { appId: 'finance-os', appSecretName: 'API_KEY', userSecretId: 'secret-1' }), { success: true });
  assert.equal((await handlers.get(IPC_CHANNELS.connectAppSecret)(null, { appId: 'finance-os', appSecretName: 'MISSING', userSecretId: 'secret-1' })).technicalCode, 'app_secret_not_declared');

  assert.deepEqual((await handlers.get(IPC_CHANNELS.memoryList)(null, { scope: 'global' }))[0].access, { caller: 'settings' });
  assert.equal((await handlers.get(IPC_CHANNELS.memoryCreate)(null, { text: 'Dato' })).input.source, 'settings');
  assert.equal((await handlers.get(IPC_CHANNELS.memoryUpdate)(null, { id: 'mem-1' })).access.caller, 'settings');
  assert.equal((await handlers.get(IPC_CHANNELS.memoryDelete)(null, 'mem-1')).success, true);

  assert.equal((await handlers.get(IPC_CHANNELS.getDesktopUpdateState)()).status, 'idle');
  assert.equal((await handlers.get(IPC_CHANNELS.checkDesktopUpdates)()).status, 'available');
  assert.equal((await handlers.get(IPC_CHANNELS.downloadDesktopUpdate)()).status, 'downloaded');
  assert.equal((await handlers.get(IPC_CHANNELS.installDesktopUpdate)()).status, 'installing');

  assert.deepEqual(await handlers.get(IPC_CHANNELS.logoutForgerAccount)(), { authenticated: false, success: true });
  assert.equal(deps.state.catalogApps.length, 1);
});

test('main IPC delegates cloud account, social, telemetry, auth, and browser success paths', async () => {
  const calls = [];
  const catalog = [{ id: 'finance-os', name: 'Finance OS' }];
  const accountState = { authenticated: false };
  const { handlers, IPC_CHANNELS, deps } = await createDeps({
    canUseCloudDataSync: () => true,
    connectClaudeAuth: async () => ({ success: true, provider: 'claude' }),
    connectCodexAuth: async () => ({ success: true, provider: 'codex' }),
    decryptCloudMessage: async (message) => ({ ...message, decrypted: true }),
    decryptCloudMessages: async (messages) => messages.map((message) => ({ ...message, decrypted: true })),
    disconnectCodexAuth: async () => ({ success: true, disconnected: true }),
    forgerBackendClient: {
      acceptFriendRequest: async (id) => ({ id, status: 'accepted' }),
      cancelFriendRequest: async (id) => ({ id, status: 'canceled' }),
      decideAppMessagePermission: async (id, decision) => ({ id, decision }),
      declineFriendRequest: async (id) => ({ id, status: 'declined' }),
      deleteRemoteBackup: async (id) => ({ success: true, id }),
      listCloudMessages: async (friendUserId) => [{ id: 4, friendUserId, body: 'hello' }],
      listFriends: async () => [{ id: 1, username: 'ada' }],
      listRemoteBackups: async (appId) => ({ backups: [{ id: 1, appId }], usage: { usedBytes: 5 } }),
      loginAccount: async () => ({ success: false, authenticated: false, userMessage: 'bad login', technicalCode: 'invalid_credentials' }),
      markFriendChatRead: async (friendUserId) => ({ id: 2, friendUserId, unreadCount: 0 }),
      registerAccount: async (input) => ({ success: true, authenticated: true, email: input.email, token: 'registered' }),
      searchFriends: async (username) => [{ id: 2, username }],
      sendFriendRequest: async (username) => ({ id: 3, username, status: 'pending' }),
      submitAppRating: async (input) => ({ success: true, rating: input.rating }),
      submitDesktopErrorReport: async (input) => ({ success: true, report: input }),
      submitProductFeedback: async (input) => ({ success: true, feedback: input }),
      submitUsageEvent: async (input) => ({ success: true, event: input }),
      updateAccountProfile: async () => ({ success: false, authenticated: true, userMessage: 'name taken', technicalCode: 'username_taken' }),
    },
    forwardCloudSocialEvent: (event) => calls.push(['socialEvent', event]),
    getClaudeAuthStatus: async () => ({ installed: true, authenticated: true, source: 'managed' }),
    getCodexAuthStatus: async () => ({ installed: true, authenticated: true }),
    getDesktopUpdater: () => ({
      check: async () => ({ status: 'available' }),
      download: async () => ({ status: 'downloaded' }),
      getState: () => ({ status: 'idle' }),
      install: async () => ({ status: 'installed' }),
    }),
    listCatalogFromBackend: async () => catalog,
    openOrFocusFriendChatWindow: async (friendship) => ({ success: true, friendship }),
    publicForgerAccount: (account) => ({ authenticated: Boolean(account.authenticated), email: account.email }),
    reinstallClaude: async () => ({ success: true, reinstalled: 'claude' }),
    reinstallCodex: async () => ({ success: true, reinstalled: 'codex' }),
    sendEncryptedCloudMessage: async (input) => ({ id: 9, ...input }),
    shell: {
      openExternal: async (url) => calls.push(['openExternal', url]),
    },
    state: {
      agentToolSettings: { approvals: { gmail: true } },
      catalogApps: [],
      cloudSyncSettings: {},
      forgerAccount: accountState,
      settings: {},
    },
    switchForgerAccountSession: async (account) => {
      Object.assign(accountState, account);
      return { authenticated: Boolean(account.authenticated), email: account.email };
    },
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listRemoteBackups)(null, 'finance-os'), {
    backups: [{ id: 1, appId: 'finance-os' }],
    usage: { usedBytes: 5 },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deleteRemoteBackup)(null, 1), { success: true, id: 1 });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.registerForgerAccount)(null, { email: 'ada@example.com' }), {
    success: true,
    authenticated: true,
    email: 'ada@example.com',
    token: 'registered',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.loginForgerAccount)(null, { email: 'ada@example.com' }), {
    authenticated: false,
    email: undefined,
    success: false,
    userMessage: 'bad login',
    technicalCode: 'invalid_credentials',
  });
  assert.deepEqual(deps.state.catalogApps, catalog);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateForgerAccountProfile)(null, { username: 'taken' }), {
    authenticated: false,
    email: undefined,
    success: false,
    userMessage: 'name taken',
    technicalCode: 'username_taken',
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listFriends)(), [{ id: 1, username: 'ada' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.searchFriends)(null, 'lovelace'), [{ id: 2, username: 'lovelace' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.sendFriendRequest)(null, 'ada'), { id: 3, username: 'ada', status: 'pending' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.acceptFriendRequest)(null, 3), { id: 3, status: 'accepted' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.declineFriendRequest)(null, 3), { id: 3, status: 'declined' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.cancelFriendRequest)(null, 3), { id: 3, status: 'canceled' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.markFriendChatRead)(null, 2), { id: 2, friendUserId: 2, unreadCount: 0 });
  assert.equal(calls.some(([name]) => name === 'socialEvent'), true);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openFriendChatWindow)(null, { id: 2 }), {
    success: true,
    friendship: { id: 2 },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listCloudMessages)(null, 2), [
    { id: 4, friendUserId: 2, body: 'hello', decrypted: true },
  ]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.sendCloudMessage)(null, { friendUserId: 2, body: 'hi' }), {
    id: 9,
    friendUserId: 2,
    body: 'hi',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.decideAppMessagePermission)(null, 5, 'allow'), {
    id: 5,
    decision: 'allow',
    decrypted: true,
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.submitAppRating)(null, { appId: 'finance-os', rating: 5 }), {
    success: true,
    rating: 5,
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.submitProductFeedback)(null, { message: 'idea' }), {
    success: true,
    feedback: { message: 'idea' },
  });
  assert.equal((await handlers.get(IPC_CHANNELS.submitUsageEvent)(null, { eventName: 'app_opened' })).event.desktopVersion, '0.0.0-test');
  assert.equal((await handlers.get(IPC_CHANNELS.submitDesktopErrorReport)(null, { source: 'main' })).report.arch, process.arch);

  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(null, 'https://example.com/path'), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openCodexUsageDashboard)(), { success: true });
  assert.deepEqual(calls.filter(([name]) => name === 'openExternal').map((entry) => entry[1]), [
    'https://example.com/path',
    'https://platform.openai.com/usage',
  ]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCodexAuthStatus)(), { installed: true, authenticated: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.connectCodexAuth)(), { success: true, provider: 'codex' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.disconnectCodexAuth)(), { success: true, disconnected: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.reinstallCodex)(), { success: true, reinstalled: 'codex' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getClaudeAuthStatus)(), { installed: true, authenticated: true, source: 'managed' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.connectClaudeAuth)(), { success: true, provider: 'claude' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.reinstallClaude)(), { success: true, reinstalled: 'claude' });
  assert.equal(Array.isArray(await handlers.get(IPC_CHANNELS.listAgentTools)()), true);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAgentToolSettings)(), { approvals: { gmail: true } });
  assert.equal((await handlers.get(IPC_CHANNELS.getDesktopUpdateState)()).status, 'idle');
  assert.equal((await handlers.get(IPC_CHANNELS.checkDesktopUpdates)()).status, 'available');
  assert.equal((await handlers.get(IPC_CHANNELS.downloadDesktopUpdate)()).status, 'downloaded');
  assert.equal((await handlers.get(IPC_CHANNELS.installDesktopUpdate)()).status, 'installed');
});

test('main IPC covers conflict, backup, memory, secret, cloud-device, and free-chat fallback branches', async () => {
  const backupCalls = [];
  const starts = [];
  let dataRootRealpathAttempts = 0;
  const { handlers, IPC_CHANNELS } = await createDeps({
    buildForgerToolsContextForFreeChat: async () => 'free official tools',
    chatOrchestrator: {
      approvePermission: () => ({ success: true }),
      applyRun: async () => ({ success: true }),
      cancelRun: () => ({ success: true }),
      getRun: () => null,
      startRun: async (input) => {
        starts.push(input);
        return { runId: 'free-run', status: 'running' };
      },
      undo: async () => ({ success: true }),
    },
    fs: {
      ...fs,
      mkdir: async () => undefined,
      realpath: async (targetPath) => {
        if (targetPath === '/tmp/forger-private-data') {
          dataRootRealpathAttempts += 1;
          if (dataRootRealpathAttempts === 1) {
            throw new Error('missing_root');
          }
          return '/tmp/forger-private-data';
        }
        if (targetPath.endsWith('shared.csv')) {
          return '/tmp/forger-private-data/nested/shared.csv';
        }
        return targetPath;
      },
    },
    getBackupsManager: () => ({
      createBackup: async (input) => {
        backupCalls.push(['create', input]);
        return { success: true, backupId: 'b-created' };
      },
      deleteBackup: async (input) => {
        backupCalls.push(['delete', input]);
        return { success: true };
      },
      listBackups: async (appId) => {
        backupCalls.push(['list', appId]);
        return [{ backupId: 'b1', appId }];
      },
      restoreBackup: async (input) => {
        backupCalls.push(['restore', input]);
        return { success: true };
      },
    }),
    getCloudIdentityStore: () => ({
      getSummary: async () => ({ keyFingerprint: 'fingerprint' }),
      regenerate: async () => ({ keyFingerprint: 'new-fingerprint' }),
      revealSecretKey: async () => ({ privateKey: 'secret' }),
    }),
    getMemoryStore: () => ({
      create: async (input, access) => ({ input, access }),
      delete: async (id, access) => ({ id, access, success: true }),
      list: async (input, access) => ({ input, access }),
      update: async (input, access) => ({ input, access }),
    }),
    getPrivateDataRoot: () => '/tmp/forger-private-data',
    getSecretsStore: () => ({
      connectAppSecret: async () => ({ success: true }),
      createUserSecret: async (input) => ({ id: 'secret-created', input }),
      deleteUserSecret: async (id) => ({ success: true, id }),
      disconnectAppSecret: async (appId, name) => ({ success: true, appId, name }),
      listUserSecrets: async () => [],
      updateUserSecret: async (input) => ({ id: input.id, input }),
    }),
    registry: {
      apps: {
        'finance-os': { appId: 'finance-os', status: 'conflict', pendingUpdate: { version: '0.2.0' } },
      },
    },
    resolveInstalledAppSecrets: async () => [{ name: 'API_KEY' }],
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listBackups)(null, 'finance-os'), [{ backupId: 'b1', appId: 'finance-os' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.createBackup)(null, { appId: 'finance-os' }), {
    success: true,
    backupId: 'b-created',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deleteBackup)(null, { appId: 'finance-os', backupId: 'b1' }), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.restoreBackup)(null, { appId: 'finance-os', backupId: 'b1' }), { success: true });
  assert.deepEqual(backupCalls.map(([name]) => name), ['list', 'create', 'delete', 'restore']);

  const noChatConflict = await createDeps({
    registry: {
      apps: {
        'finance-os': { appId: 'finance-os', status: 'conflict', pendingUpdate: { version: '0.2.0' } },
      },
    },
  });
  assert.deepEqual(await noChatConflict.handlers.get(IPC_CHANNELS.resolveAppUpdateConflict)(null, 'finance-os'), {
    success: false,
    userMessage: 'El agente no esta disponible para resolver el conflicto.',
    technicalCode: 'chat_orchestrator_unavailable',
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCloudDevices)(), { devices: [], connected: false });
  assert.equal((await handlers.get(IPC_CHANNELS.generateDevicePairingCode)()).technicalCode, 'cloud_device_manager_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.createUserSecret)(null, { name: 'API key' })).id, 'secret-created');
  assert.equal((await handlers.get(IPC_CHANNELS.updateUserSecret)(null, { id: 'secret-1' })).id, 'secret-1');
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deleteUserSecret)(null, { id: 'secret-1' }), { success: true, id: 'secret-1' });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.disconnectAppSecret)(null, { appId: 'finance-os', appSecretName: 'API_KEY' }),
    { success: true, appId: 'finance-os', name: 'API_KEY' },
  );

  assert.deepEqual(await handlers.get(IPC_CHANNELS.memoryList)(null), {
    input: {},
    access: { caller: 'settings' },
  });
  assert.equal((await handlers.get(IPC_CHANNELS.memoryCreate)(null, { text: 'Remember this' })).input.source, 'settings');
  assert.equal((await handlers.get(IPC_CHANNELS.memoryUpdate)(null, { id: 'mem-1', text: 'Updated' })).access.caller, 'settings');
  assert.equal((await handlers.get(IPC_CHANNELS.memoryDelete)(null, 'mem-1')).success, true);

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatStartRun)(null, {
      prompt: 'hello',
      sharedFiles: [
        { path: 'nested/shared.csv', name: undefined, relativePath: undefined, sizeBytes: undefined, modifiedAt: undefined, source: undefined },
      ],
    }),
    { runId: 'free-run', status: 'running' },
  );
  assert.equal(starts[0].appId, null);
  assert.equal(starts[0].sharedFiles[0].path, '/tmp/forger-private-data/nested/shared.csv');
  assert.match(starts[0].prompt, /free official tools/);
  assert.match(starts[0].prompt, /shared\.csv/);
});

test('main IPC delegates app lifecycle, prompt, secret, official-tool, and file-library commands', async () => {
  const calls = [];
  const fileLibrary = {
    createCategory: async (input) => ({ op: 'createCategory', input }),
    deleteCategory: async (input) => ({ op: 'deleteCategory', input }),
    deleteFiles: async (input) => ({ op: 'deleteFiles', input }),
    discardStagedFilesForChat: async (input) => ({ op: 'discard', input }),
    importFiles: async (input) => ({ op: 'import', input }),
    list: async (input) => ({ op: 'list', input }),
    listCategories: async () => [{ id: 'uncategorized' }],
    moveFiles: async (input) => ({ op: 'move', input }),
    renameCategory: async (input) => ({ op: 'renameCategory', input }),
    renameFile: async (input) => ({ op: 'renameFile', input }),
    stageFileForChat: async (input) => ({ op: 'stage', input }),
  };
  const officialTools = {
    activate: async (toolId, locale) => ({ op: 'activate', toolId, locale }),
    callFromApp: async () => ({}),
    configure: async (input) => ({ op: 'configure', input }),
    deactivate: async (toolId, options) => ({ op: 'deactivate', toolId, options }),
    getInstallGate: async (appId, locale) => ({ appId, locale }),
    list: async (locale) => [{ id: 'gmail', locale }],
    listToolsForApp: async () => [],
    refresh: async (locale) => [{ id: 'gmail', refreshed: true, locale }],
    setAppToolGrant: async (input, locale) => ({ input, locale }),
  };
  const { handlers, IPC_CHANNELS } = await createDeps({
    buildAppSecretsState: async (appId) => ({ appId, appSecrets: [] }),
    getAppDetails: async (appId) => ({ appId, name: 'Finance OS' }),
    getFileLibrary: () => fileLibrary,
    getOfficialToolsService: () => officialTools,
    getRuntimeStatus: (appId) => ({ appId, status: 'running' }),
    installAppRuntime: async (appId, locale) => ({ op: 'install', appId, locale }),
    installSocialAppRuntime: async (input, locale) => ({ op: 'installSocial', input, locale }),
    installWelcome: async (appId, userLanguage) => ({ op: 'welcome', appId, userLanguage }),
    listAppPrompts: async (appId) => [{ appId, id: 'summary' }],
    openInstalledApp: async (appId, locale) => ({ op: 'open', appId, locale }),
    restoreAppPrompt: async (input) => ({ op: 'restorePrompt', input }),
    restoreAppUserVersionRuntime: async (appId) => ({ op: 'restoreUserVersion', appId }),
    setAppAutoSyncSetting: async (appId, autoSync) => ({ appId, autoSync }),
    stopInstalledApp: async (appId) => ({ op: 'stop', appId }),
    uninstallAppRuntime: async (appId) => ({ op: 'uninstall', appId }),
    updateAgentDefaults: async (input) => ({ op: 'updateAgentDefaults', input }),
    updateAgentToolApproval: async (input) => ({ op: 'updateAgentToolApproval', input }),
    updateAppPrompt: async (input) => ({ op: 'updatePrompt', input }),
    updateAppRuntime: async (appId, locale) => ({ op: 'update', appId, locale }),
    updateCodexDefaults: async (input) => ({ op: 'updateCodexDefaults', input }),
    validateAppPrompt: async (input) => ({ op: 'validatePrompt', input }),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.installApp)(null, 'finance-os', 'es'), { op: 'install', appId: 'finance-os', locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.installSocialApp)(null, { appId: 9 }, 'es'), { op: 'installSocial', input: { appId: 9 }, locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateApp)(null, 'finance-os', 'es'), { op: 'update', appId: 'finance-os', locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.uninstallApp)(null, 'finance-os'), { op: 'uninstall', appId: 'finance-os' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openApp)(null, 'finance-os', 'es'), { op: 'open', appId: 'finance-os', locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.stopApp)(null, 'finance-os'), { op: 'stop', appId: 'finance-os' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.installWelcome)(null, 'finance-os', 'es'), { op: 'welcome', appId: 'finance-os', userLanguage: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAppRuntimeStatus)(null, 'finance-os'), { appId: 'finance-os', status: 'running' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAppDetails)(null, 'finance-os'), { appId: 'finance-os', name: 'Finance OS' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAppSecrets)(null, 'finance-os'), { appId: 'finance-os', appSecrets: [] });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.setAppAutoSync)(null, 'finance-os', true), { appId: 'finance-os', autoSync: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.restoreAppUserVersion)(null, 'finance-os'), { op: 'restoreUserVersion', appId: 'finance-os' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listAppPrompts)(null, 'finance-os'), [{ appId: 'finance-os', id: 'summary' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.validateAppPrompt)(null, { appId: 'finance-os' }), { op: 'validatePrompt', input: { appId: 'finance-os' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateAppPrompt)(null, { appId: 'finance-os' }), { op: 'updatePrompt', input: { appId: 'finance-os' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.restoreAppPrompt)(null, { appId: 'finance-os' }), { op: 'restorePrompt', input: { appId: 'finance-os' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateCodexDefaults)(null, { model: 'gpt' }), { op: 'updateCodexDefaults', input: { model: 'gpt' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateAgentDefaults)(null, { provider: 'codex' }), { op: 'updateAgentDefaults', input: { provider: 'codex' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateAgentToolApproval)(null, { toolId: 'gmail' }), { op: 'updateAgentToolApproval', input: { toolId: 'gmail' } });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listOfficialTools)(null, 'es'), [{ id: 'gmail', locale: 'es' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.refreshOfficialTools)(null, 'es'), [{ id: 'gmail', refreshed: true, locale: 'es' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.activateOfficialTool)(null, 'gmail', 'es'), { op: 'activate', toolId: 'gmail', locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.configureOfficialTool)(null, { toolId: 'gmail' }), { op: 'configure', input: { toolId: 'gmail' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deactivateOfficialTool)(null, 'gmail', 'es'), { op: 'deactivate', toolId: 'gmail', options: { locale: 'es' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAppToolsInstallGate)(null, 'finance-os', 'es'), { appId: 'finance-os', locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.setAppToolGrant)(null, { appId: 'finance-os', toolId: 'gmail' }, 'es'), {
    input: { appId: 'finance-os', toolId: 'gmail' },
    locale: 'es',
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesStageForChat)(null, { fileId: 'file-1' }), { op: 'stage', input: { fileId: 'file-1' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesDiscardStagedForChat)(null, { fileId: 'file-1' }), { op: 'discard', input: { fileId: 'file-1' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesList)(null), { op: 'list', input: {} });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesListCategories)(), [{ id: 'uncategorized' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesCreateCategory)(null, { name: 'Docs' }), { op: 'createCategory', input: { name: 'Docs' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesRenameCategory)(null, { id: 'c1', name: 'Docs' }), { op: 'renameCategory', input: { id: 'c1', name: 'Docs' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesDeleteCategory)(null, { id: 'c1' }), { op: 'deleteCategory', input: { id: 'c1' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesImport)(null, { paths: ['/tmp/a.txt'] }), { op: 'import', input: { paths: ['/tmp/a.txt'] } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesMove)(null, { fileIds: ['f1'] }), { op: 'move', input: { fileIds: ['f1'] } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesRename)(null, { fileId: 'f1' }), { op: 'renameFile', input: { fileId: 'f1' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesDelete)(null, { fileIds: ['f1'] }), { op: 'deleteFiles', input: { fileIds: ['f1'] } });
  assert.deepEqual(calls, []);
});
