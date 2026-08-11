import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { createIpcMainRecorder, createTrustedMainWindow } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerMainIpcHandlers } = require('../../dist-electron/main/ipc/main-handlers.js');
const { mainWindow: trustedMainWindow, trustedIpcEvent } = createTrustedMainWindow();

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
      openPath: async () => '',
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
        quit: () => undefined,
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
      listLocalCloudMessages: async () => [],
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
      getAntigravityAuthStatus: async () => ({ installed: true, authenticated: false, source: 'managed' }),
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
      getConnectionsService: () => ({
        call: async () => ({}),
        configure: async () => ({}),
        disconnect: async () => ({}),
        listConnectionsForApp: async () => ({ types: [], instances: [], requirements: [] }),
        listState: async () => ({ types: [], instances: [] }),
        setAppConnectionGrant: async () => null,
        setDefaultConnection: async () => ({}),
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
      listLlmProviderProfiles: async () => ({ providers: {}, activeProfileIds: {}, checkedAt: new Date(0).toISOString() }),
      mainWindow: trustedMainWindow,
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
      sendEncryptedCloudMessage: async (input) => input, sendEncryptedCloudAppShareMessage: async (input) => input,
      serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
      setAppAutoSyncSetting: async () => ({}),
      setActiveLlmProviderProfile: async () => ({ success: true, state: { providers: {}, activeProfileIds: {}, checkedAt: new Date(0).toISOString() } }),
      updateLlmProviderProfileDefaults: async () => ({ success: true, state: { providers: {}, activeProfileIds: {}, checkedAt: new Date(0).toISOString() } }),
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

    if (!Object.hasOwn(overrides, 'getMainWindow')) {
      deps.getMainWindow = () => deps.mainWindow;
    }
    if (!Object.hasOwn(overrides, 'getFriendChatWindows')) {
      deps.getFriendChatWindows = () => [];
    }

    registerMainIpcHandlers(deps);
    return { deps, handlers, IPC_CHANNELS, logs };
};

const eventForWebContents = (id = 101) => {
  const mainFrame = { routingId: id };
  return {
    sender: { id, mainFrame, isDestroyed: () => false },
    senderFrame: mainFrame,
  };
};

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
      deleteBackups: async () => {
        throw new Error('delete_many_denied');
      },
      listBackups: async () => [],
      restoreBackup: async () => {
        throw new Error('restore_denied');
      },
    }),
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.createBackup)(trustedIpcEvent, { appId: 'finance-os', reason: 'manual' }),
    {
      success: false,
      userMessage: 'No pudimos crear el respaldo.',
      technicalCode: 'disk_full',
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.deleteBackup)(trustedIpcEvent, { appId: 'finance-os', backupId: 'b1' }),
    {
      success: false,
      userMessage: 'No pudimos eliminar ese respaldo.',
      technicalCode: 'delete_denied',
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.deleteBackups)(trustedIpcEvent, { appId: 'finance-os', backupIds: ['b1', 'b2'] }),
    {
      success: false,
      userMessage: 'No pudimos eliminar esos respaldos.',
      deleted: [],
      failed: [],
      technicalCode: 'delete_many_denied',
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.restoreBackup)(trustedIpcEvent, { appId: 'finance-os', backupId: 'b1' }),
    {
      success: false,
      userMessage: 'No pudimos restaurar ese respaldo.',
      technicalCode: 'restore_denied',
    },
  );
  assert.deepEqual(logs.map((entry) => entry.event), [
    'backup:create_failed',
    'backup:delete_failed',
    'backup:batch_delete_failed',
    'backup:restore_failed',
  ]);
});

test('main IPC cloud and social handlers return explicit errors when backend services are unavailable', async () => {
  const { handlers, IPC_CHANNELS } = await createDeps();

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listRemoteBackups)(trustedIpcEvent, 'finance-os'), {
    backups: [],
    usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deleteRemoteBackup)(trustedIpcEvent, 5), {
    success: false,
    userMessage: 'Forger Cloud Sync requiere una cuenta de Forger Cloud activa.',
    technicalCode: 'subscription_required',
  });
  await assert.rejects(handlers.get(IPC_CHANNELS.sendFriendRequest)(trustedIpcEvent, 'ada'), /backend_client_missing/);
  await assert.rejects(handlers.get(IPC_CHANNELS.acceptFriendRequest)(trustedIpcEvent, 1), /backend_client_missing/);
  await assert.rejects(handlers.get(IPC_CHANNELS.decideAppMessagePermission)(trustedIpcEvent, 1, 'allow'), /backend_client_missing/);
});

test('main IPC external link handlers reject unsafe URLs and return diagnostics on shell failures', async () => {
  const openedPaths = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-open-link-'));
  const filePath = path.join(tempDir, 'note.txt');
  const blockedPath = path.join(tempDir, 'blocked.txt');
  const homePath = path.join(os.homedir(), 'forger-open-link-missing.txt');
  await fs.writeFile(filePath, 'hello', 'utf8');
  await fs.writeFile(blockedPath, 'blocked', 'utf8');
  const { handlers, IPC_CHANNELS } = await createDeps({
    shell: {
      openExternal: async () => {
        throw new Error('shell_blocked');
      },
      openPath: async (targetPath) => {
        openedPaths.push(targetPath);
        return targetPath === blockedPath ? 'permission denied' : '';
      },
    },
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, 'javascript:alert(1)'), {
    success: false,
    userMessage: 'No pudimos abrir ese enlace.',
    technicalCode: 'unsupported_url_protocol',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, 'relative/file.txt'), {
    success: false,
    userMessage: 'No pudimos abrir ese enlace.',
    technicalCode: 'unsupported_url_protocol',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, 'http://example.com'), {
    success: false,
    userMessage: 'No pudimos abrir ese enlace.',
    technicalCode: 'shell_blocked',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, 'https://example.com'), {
    success: false,
    userMessage: 'No pudimos abrir ese enlace.',
    technicalCode: 'shell_blocked',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, `${filePath}:12`), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, pathToFileURL(filePath).toString()), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, '~/forger-open-link-missing.txt'), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, blockedPath), {
    success: false,
    userMessage: 'No pudimos abrir ese enlace.',
    technicalCode: 'open_local_path_failed',
    sensitiveDetails: { error: 'permission denied' },
  });
  assert.deepEqual(openedPaths, [filePath, filePath, homePath, blockedPath]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openCodexUsageDashboard)(trustedIpcEvent), {
    success: false,
    technicalCode: 'shell_blocked',
    userMessage: 'No pudimos abrir el panel de uso de Codex.',
  });
  assert.equal((await handlers.get(IPC_CHANNELS.getAgentProviderUsage)(trustedIpcEvent)).success, true);
});

test('personal agent IPC filters grants to installed apps and existing official tool actions', async () => {
  const createInputs = [];
  const updateInputs = [];
  const { handlers, IPC_CHANNELS } = await createDeps({
    getOfficialToolsService: () => ({
      activate: async () => ({}),
      callFromApp: async () => ({}),
      configure: async () => ({}),
      deactivate: async () => ({}),
      getInstallGate: async () => null,
      list: async () => ({
        tools: [
          { id: 'gmail', actions: [{ id: 'gmail.search_messages' }] },
          { id: 'forger_chrome_extension', actions: [{ id: 'forger_chrome_extension.navigate' }] },
        ],
      }),
      listToolsForApp: async () => [],
      refresh: async () => ({ tools: [] }),
      setAppToolGrant: async () => null,
    }),
    getPersonalAgentStore: () => ({
      createAgent: async (input) => {
        createInputs.push(input);
        return { id: 'agent-1', ...input };
      },
      updateAgentPermissions: async (input) => {
        updateInputs.push(input);
        return { id: input.agentId, ...input };
      },
      requireAgent: async (agentId) => ({
        id: agentId,
        appIds: [],
        toolIds: [],
        connectionGrants: [],
        peerAgentGrants: [],
      }),
    }),
    registry: {
      apps: {
        'finance-os': { appId: 'finance-os', name: 'Finance OS' },
      },
    },
    toAppSummary: (record) => ({ id: record.appId, name: record.name, status: 'installed' }),
  });

  await handlers.get(IPC_CHANNELS.personalAgentsCreate)(trustedIpcEvent, {
    name: 'Ops',
    appIds: ['finance-os', 'missing-app'],
    toolIds: ['gmail.search_messages', 'forger_chrome_extension.navigate', 'missing.tool'],
  });
  await handlers.get(IPC_CHANNELS.personalAgentUpdatePermissions)(trustedIpcEvent, {
    agentId: 'agent-1',
    appIds: ['missing-app', 'finance-os'],
    toolIds: ['missing.tool', 'forger_chrome_extension.navigate'],
  });

  assert.deepEqual(createInputs[0].appIds, ['finance-os']);
  assert.deepEqual(createInputs[0].toolIds, ['gmail.search_messages', 'forger_chrome_extension.navigate']);
  assert.deepEqual(updateInputs[0].appIds, ['finance-os']);
  assert.deepEqual(updateInputs[0].toolIds, ['forger_chrome_extension.navigate']);
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

test('app-runtime and app-cloud IPC remain app-window-only when Desktop windows share the preload', async () => {
  const appWindow = createTrustedMainWindow({ id: 301 });
  const friendWindow = createTrustedMainWindow({ id: 302 });
  const { handlers, IPC_CHANNELS } = await createDeps({
    getFriendChatWindows: () => [friendWindow.mainWindow],
    getCodexAuthStatus: async () => ({ authenticated: true }),
    listLocalCloudMessages: async () => [{ id: 9, friendUserId: 7 }],
    registry: {
      apps: {
        'finance-os': { appId: 'finance-os', installDir: '/apps/finance-os' },
      },
    },
    resolveAppIdForWebContents: (id) => id === appWindow.mainWindow.webContents.id ? 'finance-os' : null,
    resolveInstalledManifest: async () => ({ cloudMessaging: { enabled: true } }),
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAiSubscriptionStatus)(appWindow.trustedIpcEvent),
    { connected: true },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appMessagesList)(appWindow.trustedIpcEvent, 7),
    [{ id: 9, friendUserId: 7 }],
  );
  for (const event of [trustedIpcEvent, friendWindow.trustedIpcEvent]) {
    await assert.rejects(
      handlers.get(IPC_CHANNELS.appAiSubscriptionStatus)(event),
      /app_window_not_authorized/,
    );
    await assert.rejects(
      handlers.get(IPC_CHANNELS.appMessagesList)(event, 7),
      /app_window_not_authorized/,
    );
  }
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

  const listCalls = [];
  const enabled = await createDeps({
    listLocalCloudMessages: async (friendUserId) => {
      listCalls.push(friendUserId);
      return [{ id: 9, friendUserId, decrypted: true }];
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
  assert.deepEqual(listCalls, [3]);
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
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatStartRun)(trustedIpcEvent, { prompt: 'hello' }), {
    runId: '',
    status: 'failed',
  });
  assert.equal(await withoutChat.handlers.get(IPC_CHANNELS.chatGetRun)(trustedIpcEvent, { runId: 'run-1' }), null);
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatCancelRun)(trustedIpcEvent, { runId: 'run-1' }), { success: false });
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatApprovePermission)(trustedIpcEvent, { runId: 'run-1' }), { success: false });
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatApplyRun)(trustedIpcEvent, { runId: 'run-1' }), {
    success: false,
    technicalCode: 'chat_orchestrator_unavailable',
  });
  assert.deepEqual(await withoutChat.handlers.get(IPC_CHANNELS.chatUndo)(trustedIpcEvent, { runId: 'run-1' }), {
    success: false,
    technicalCode: 'chat_orchestrator_unavailable',
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatStartRun)(trustedIpcEvent, {
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
  assert.equal(starts[0].networkAccess, true);
  assert.deepEqual(starts[0].sharedFiles.map((file) => file.path), ['/tmp/forger-data/ok.csv']);
  assert.match(starts[0].prompt, /ok\.csv/);
  assert.doesNotMatch(starts[0].prompt, /networkAccess|NETWORK ACCESS/);
  assert.doesNotMatch(starts[0].prompt, /blocked\.txt/);
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatStartRun)(trustedIpcEvent, {
      prompt: 'free chat without internet',
      networkAccess: false,
      sharedFiles: [],
    }),
    { runId: 'run-1', status: 'running' },
  );
  assert.equal(starts.length, 2);
  assert.equal(starts[1].appId, null);
  assert.equal(starts[1].networkAccess, false);
  assert.doesNotMatch(starts[1].prompt, /NETWORK ACCESS/);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatGetRun)(trustedIpcEvent, { runId: 'run-1' }), { runId: 'run-1' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatCancelRun)(trustedIpcEvent, { runId: 'run-1' }), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatApprovePermission)(trustedIpcEvent, { runId: 'run-1' }), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatApplyRun)(trustedIpcEvent, { runId: 'run-1' }), { success: true });
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
    await handlers.get(IPC_CHANNELS.resolveAppUpdateConflict)(trustedIpcEvent, 'missing-app'),
    {
      success: false,
      userMessage: 'No hay una actualizacion en conflicto para resolver.',
      technicalCode: 'no_pending_update_conflict',
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.resolveAppUpdateConflict)(trustedIpcEvent, 'finance-os'),
    { runId: 'run-conflict', status: 'running' },
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].appId, 'finance-os');
  assert.equal(starts[0].dangerMode, true);
  assert.match(starts[0].prompt, /Finance OS/);
  assert.match(starts[0].prompt, /app tools context/);

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatApprovePermission)(trustedIpcEvent, { runId: 'run-1', requestId: 'req-1', decision: 'allow' }),
    { success: true, approved: true },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatUndo)(trustedIpcEvent, { runId: 'run-1' }),
    { success: true, undoRunId: 'run-1' },
  );

  assert.deepEqual(await handlers.get(IPC_CHANNELS.chatTrace)(trustedIpcEvent, { event: 'unknown_event' }), { success: false });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatTrace)(trustedIpcEvent, { event: 'chat_run_event_received', runId: 'run-1' }),
    { success: true },
  );
  assert.deepEqual(logs.at(-1), {
    event: 'chat_renderer_trace',
    payload: { event: 'chat_run_event_received', runId: 'run-1' },
  });
});

test('main IPC file picker uses the owning window and rejects it after destruction', async () => {
  const dialogCalls = [];
  let destroyed = false;
  const pickerWindow = createTrustedMainWindow();
  pickerWindow.mainWindow.isDestroyed = () => destroyed;
  const { handlers, IPC_CHANNELS } = await createDeps({
    dialog: {
      showOpenDialog: async (...args) => {
        dialogCalls.push(args);
        return { canceled: true, filePaths: [] };
      },
    },
    mainWindow: pickerWindow.mainWindow,
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesPickForChat)(pickerWindow.trustedIpcEvent), []);
  destroyed = true;
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesPickForChat)(pickerWindow.trustedIpcEvent),
    /ipc_sender_not_authorized/,
  );

  assert.equal(dialogCalls.length, 1);
  assert.equal(dialogCalls[0][0], pickerWindow.mainWindow);
  assert.deepEqual(dialogCalls[0][1], { properties: ['openFile', 'multiSelections'] });

  const canceled = await createDeps({
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
  });
  assert.deepEqual(await canceled.handlers.get(IPC_CHANNELS.filesPickForChat)(trustedIpcEvent), []);
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
    await handlers.get(IPC_CHANNELS.createRemoteBackup)(trustedIpcEvent, { appId: 'finance-os' }),
    {
      success: false,
      userMessage: 'No pudimos subir el respaldo a Forger Cloud.',
      technicalCode: 'upload_denied',
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.restoreRemoteBackup)(trustedIpcEvent, { remoteBackupId: 42 }),
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
    await handlers.get(IPC_CHANNELS.loginForgerAccount)(trustedIpcEvent, { email: 'ada@example.com', password: 'secret' }),
    { authenticated: true, success: true, userMessage: 'ok', technicalCode: undefined },
  );
  assert.deepEqual(deps.state.catalogApps, catalog);
  assert.equal(switched[0].account.token, 'token-1');

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.updateForgerAccountProfile)(trustedIpcEvent, { username: 'ada' }),
    { authenticated: true, success: true, userMessage: 'saved', technicalCode: undefined },
  );
  assert.equal(switched.at(-1).account.username, 'ada');

  assert.deepEqual(await handlers.get(IPC_CHANNELS.logoutForgerAccount)(trustedIpcEvent), {
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
      updateCloudDeviceName: async (input) => ({ success: true, updated: input.name }),
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

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listInstalledApps)(trustedIpcEvent), [{ id: 'finance-os', name: 'Finance OS' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listCatalogApps)(trustedIpcEvent), [{
    id: 'finance-os',
    name: 'Finance OS',
    localNetworkShare: { active: true, appId: 'finance-os', url: 'http://192.168.1.20:5555' },
  }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.startLocalNetworkShare)(trustedIpcEvent, 'finance-os'), {
    success: true,
    appId: 'finance-os',
    status: { active: true, appId: 'finance-os' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.stopLocalNetworkShare)(trustedIpcEvent, 'finance-os'), {
    success: true,
    appId: 'finance-os',
    status: { active: false, appId: 'finance-os' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getLocalNetworkShareStatus)(trustedIpcEvent, 'finance-os'), {
    active: true,
    appId: 'finance-os',
    url: 'http://192.168.1.20:5555',
  });
  assert.equal(calls.some(([name]) => name === 'ensureCatalogStatuses'), true);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCloudSyncSettings)(trustedIpcEvent), { enabled: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getSettings)(trustedIpcEvent), { locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listLlmProviderProfiles)(trustedIpcEvent), { providers: {}, activeProfileIds: {}, checkedAt: new Date(0).toISOString() });
  assert.equal((await handlers.get(IPC_CHANNELS.setActiveLlmProviderProfile)(trustedIpcEvent, { provider: 'codex', profileId: 'codex:system' })).success, true);
  assert.equal((await handlers.get(IPC_CHANNELS.updateLlmProviderProfileDefaults)(trustedIpcEvent, { provider: 'codex', profileId: 'codex:system', model: 'gpt-5' })).success, true);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getForgerAccount)(trustedIpcEvent), { authenticated: false });

  assert.equal((await handlers.get(IPC_CHANNELS.registerForgerAccount)(trustedIpcEvent, {})).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.loginForgerAccount)(trustedIpcEvent, {})).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.updateForgerAccountProfile)(trustedIpcEvent, { username: 'ada' })).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.submitProductFeedback)(trustedIpcEvent, {})).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.submitUsageEvent)(trustedIpcEvent, { eventName: 'app_opened' })).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.submitDesktopErrorReport)(trustedIpcEvent, { source: 'main', operation: 'op', message: 'fail' })).technicalCode, 'backend_client_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.submitAppRating)(trustedIpcEvent, { appId: 'finance-os' })).technicalCode, 'backend_client_missing');

  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCloudDevices)(trustedIpcEvent), { connected: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateCloudDeviceName)(trustedIpcEvent, { name: 'Studio Mac' }), { success: true, updated: 'Studio Mac' });
  assert.equal((await handlers.get(IPC_CHANNELS.generateDevicePairingCode)(trustedIpcEvent)).pairingCode, 'ABC12345');
  assert.equal((await handlers.get(IPC_CHANNELS.getCloudIdentity)(trustedIpcEvent)).keyFingerprint, 'fingerprint');
  assert.equal((await handlers.get(IPC_CHANNELS.revealCloudSecretKey)(trustedIpcEvent)).privateKey, 'secret');
  assert.equal((await handlers.get(IPC_CHANNELS.regenerateCloudSecretKey)(trustedIpcEvent)).keyFingerprint, 'new-fingerprint');
  assert.equal(calls.some(([name]) => name === 'cloudDeviceStart'), true);

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listUserSecrets)(trustedIpcEvent), [{ id: 'secret-1' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.connectAppSecret)(trustedIpcEvent, { appId: 'finance-os', appSecretName: 'API_KEY', userSecretId: 'secret-1' }), { success: true });
  assert.equal((await handlers.get(IPC_CHANNELS.connectAppSecret)(trustedIpcEvent, { appId: 'finance-os', appSecretName: 'MISSING', userSecretId: 'secret-1' })).technicalCode, 'app_secret_not_declared');

  assert.deepEqual((await handlers.get(IPC_CHANNELS.memoryList)(trustedIpcEvent, { scope: 'global' }))[0].access, { caller: 'settings' });
  assert.equal((await handlers.get(IPC_CHANNELS.memoryCreate)(trustedIpcEvent, { text: 'Dato' })).input.source, 'settings');
  assert.equal((await handlers.get(IPC_CHANNELS.memoryUpdate)(trustedIpcEvent, { id: 'mem-1' })).access.caller, 'settings');
  assert.equal((await handlers.get(IPC_CHANNELS.memoryDelete)(trustedIpcEvent, 'mem-1')).success, true);

  assert.equal((await handlers.get(IPC_CHANNELS.getDesktopUpdateState)(trustedIpcEvent)).status, 'idle');
  assert.equal((await handlers.get(IPC_CHANNELS.checkDesktopUpdates)(trustedIpcEvent)).status, 'available');
  assert.equal((await handlers.get(IPC_CHANNELS.downloadDesktopUpdate)(trustedIpcEvent)).status, 'downloaded');
  assert.equal((await handlers.get(IPC_CHANNELS.installDesktopUpdate)(trustedIpcEvent)).status, 'installing');
  assert.deepEqual(await handlers.get(IPC_CHANNELS.desktopUpdateQuitForInstall)(trustedIpcEvent), { success: true });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.logoutForgerAccount)(trustedIpcEvent), { authenticated: false, success: true });
  assert.equal(deps.state.catalogApps.length, 1);
});

test('main IPC delegates cloud account, social, telemetry, auth, and browser success paths', async () => {
  const calls = [];
  const catalog = [{ id: 'finance-os', name: 'Finance OS' }];
  const accountState = { authenticated: false };
  let quitCalls = 0;
  const { handlers, IPC_CHANNELS, deps } = await createDeps({
    app: {
      getVersion: () => '0.0.0-test',
      quit: () => {
        quitCalls += 1;
      },
    },
    canUseCloudDataSync: () => true,
    connectClaudeAuth: async () => ({ success: true, provider: 'claude' }),
    connectCodexAuth: async () => ({ success: true, provider: 'codex' }),
    decryptCloudMessage: async (message) => ({ ...message, decrypted: true }),
    decryptCloudMessages: async (messages) => messages.map((message) => ({ ...message, decrypted: true })),
    listLocalCloudMessages: async (friendUserId) => [{ id: 4, friendUserId, body: 'hello', decrypted: true }],
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
      openPath: async (targetPath) => {
        calls.push(['openPath', targetPath]);
        return '';
      },
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

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listRemoteBackups)(trustedIpcEvent, 'finance-os'), {
    backups: [{ id: 1, appId: 'finance-os' }],
    usage: { usedBytes: 5 },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deleteRemoteBackup)(trustedIpcEvent, 1), { success: true, id: 1 });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.registerForgerAccount)(trustedIpcEvent, { email: 'ada@example.com' }), {
    success: true,
    authenticated: true,
    email: 'ada@example.com',
    token: 'registered',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.loginForgerAccount)(trustedIpcEvent, { email: 'ada@example.com' }), {
    authenticated: false,
    email: undefined,
    success: false,
    userMessage: 'bad login',
    technicalCode: 'invalid_credentials',
  });
  assert.deepEqual(deps.state.catalogApps, catalog);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateForgerAccountProfile)(trustedIpcEvent, { username: 'taken' }), {
    authenticated: false,
    email: undefined,
    success: false,
    userMessage: 'name taken',
    technicalCode: 'username_taken',
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listFriends)(trustedIpcEvent), [{ id: 1, username: 'ada' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.searchFriends)(trustedIpcEvent, 'lovelace'), [{ id: 2, username: 'lovelace' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.sendFriendRequest)(trustedIpcEvent, 'ada'), { id: 3, username: 'ada', status: 'pending' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.acceptFriendRequest)(trustedIpcEvent, 3), { id: 3, status: 'accepted' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.declineFriendRequest)(trustedIpcEvent, 3), { id: 3, status: 'declined' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.cancelFriendRequest)(trustedIpcEvent, 3), { id: 3, status: 'canceled' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.markFriendChatRead)(trustedIpcEvent, 2), { id: 2, friendUserId: 2, unreadCount: 0 });
  assert.equal(calls.some(([name]) => name === 'socialEvent'), true);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openFriendChatWindow)(trustedIpcEvent, { id: 2 }), {
    success: true,
    friendship: { id: 2 },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listCloudMessages)(trustedIpcEvent, 2), [
    { id: 4, friendUserId: 2, body: 'hello', decrypted: true },
  ]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.sendCloudMessage)(trustedIpcEvent, { friendUserId: 2, body: 'hi' }), {
    id: 9,
    friendUserId: 2,
    body: 'hi',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.decideAppMessagePermission)(trustedIpcEvent, 5, 'allow'), {
    id: 5,
    decision: 'allow',
    decrypted: true,
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.submitAppRating)(trustedIpcEvent, { appId: 'finance-os', rating: 5 }), {
    success: true,
    rating: 5,
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.submitProductFeedback)(trustedIpcEvent, { message: 'idea' }), {
    success: true,
    feedback: { message: 'idea' },
  });
  assert.equal((await handlers.get(IPC_CHANNELS.submitUsageEvent)(trustedIpcEvent, { eventName: 'app_opened' })).event.desktopVersion, '0.0.0-test');
  assert.equal((await handlers.get(IPC_CHANNELS.submitDesktopErrorReport)(trustedIpcEvent, { source: 'main' })).report.arch, process.arch);

  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, 'https://example.com/path'), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openExternalUrl)(trustedIpcEvent, 'http://example.com/path'), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openCodexUsageDashboard)(trustedIpcEvent), { success: true });
  assert.equal((await handlers.get(IPC_CHANNELS.getAgentProviderUsage)(trustedIpcEvent)).providers[0].provider, 'codex');
  assert.deepEqual(calls.filter(([name]) => name === 'openExternal').map((entry) => entry[1]), [
    'https://example.com/path',
    'http://example.com/path',
    'https://platform.openai.com/usage',
  ]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCodexAuthStatus)(trustedIpcEvent), { installed: true, authenticated: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.connectCodexAuth)(trustedIpcEvent), { success: true, provider: 'codex' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.disconnectCodexAuth)(trustedIpcEvent), { success: true, disconnected: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.reinstallCodex)(trustedIpcEvent), { success: true, reinstalled: 'codex' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getClaudeAuthStatus)(trustedIpcEvent), { installed: true, authenticated: true, source: 'managed' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.connectClaudeAuth)(trustedIpcEvent), { success: true, provider: 'claude' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.reinstallClaude)(trustedIpcEvent), { success: true, reinstalled: 'claude' });
  assert.equal(Array.isArray(await handlers.get(IPC_CHANNELS.listAgentTools)(trustedIpcEvent)), true);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAgentToolSettings)(trustedIpcEvent), { approvals: { gmail: true } });
  assert.equal((await handlers.get(IPC_CHANNELS.getDesktopUpdateState)(trustedIpcEvent)).status, 'idle');
  assert.equal((await handlers.get(IPC_CHANNELS.checkDesktopUpdates)(trustedIpcEvent)).status, 'available');
  assert.equal((await handlers.get(IPC_CHANNELS.downloadDesktopUpdate)(trustedIpcEvent)).status, 'downloaded');
  assert.equal((await handlers.get(IPC_CHANNELS.installDesktopUpdate)(trustedIpcEvent)).status, 'installed');
  assert.deepEqual(await handlers.get(IPC_CHANNELS.desktopUpdateQuitForInstall)(trustedIpcEvent), { success: true });
  assert.equal(quitCalls, 1);
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
      deleteBackups: async (input) => {
        backupCalls.push(['deleteMany', input]);
        return { success: true, deleted: input.backupIds.map((backupId) => ({ appId: input.appId, backupId })), failed: [] };
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

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listBackups)(trustedIpcEvent, 'finance-os'), [{ backupId: 'b1', appId: 'finance-os' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.createBackup)(trustedIpcEvent, { appId: 'finance-os' }), {
    success: true,
    backupId: 'b-created',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deleteBackup)(trustedIpcEvent, { appId: 'finance-os', backupId: 'b1' }), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deleteBackups)(trustedIpcEvent, { appId: 'finance-os', backupIds: ['b1', 'b2'] }), {
    success: true,
    deleted: [
      { appId: 'finance-os', backupId: 'b1' },
      { appId: 'finance-os', backupId: 'b2' },
    ],
    failed: [],
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.restoreBackup)(trustedIpcEvent, { appId: 'finance-os', backupId: 'b1' }), { success: true });
  assert.deepEqual(backupCalls.map(([name]) => name), ['list', 'create', 'delete', 'deleteMany', 'restore']);

  const noChatConflict = await createDeps({
    registry: {
      apps: {
        'finance-os': { appId: 'finance-os', status: 'conflict', pendingUpdate: { version: '0.2.0' } },
      },
    },
  });
  assert.deepEqual(await noChatConflict.handlers.get(IPC_CHANNELS.resolveAppUpdateConflict)(trustedIpcEvent, 'finance-os'), {
    success: false,
    userMessage: 'El agente no esta disponible para resolver el conflicto.',
    technicalCode: 'chat_orchestrator_unavailable',
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCloudDevices)(trustedIpcEvent), { devices: [], connected: false });
  assert.equal((await handlers.get(IPC_CHANNELS.updateCloudDeviceName)(trustedIpcEvent, { name: 'Studio Mac' })).technicalCode, 'cloud_device_manager_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.generateDevicePairingCode)(trustedIpcEvent)).technicalCode, 'cloud_device_manager_missing');
  assert.equal((await handlers.get(IPC_CHANNELS.createUserSecret)(trustedIpcEvent, { name: 'API key', value: 'secret-value' })).id, 'secret-created');
  assert.equal((await handlers.get(IPC_CHANNELS.updateUserSecret)(trustedIpcEvent, { id: 'secret-1', name: 'API key' })).id, 'secret-1');
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deleteUserSecret)(trustedIpcEvent, { id: 'secret-1' }), { success: true, id: 'secret-1' });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.disconnectAppSecret)(trustedIpcEvent, { appId: 'finance-os', appSecretName: 'API_KEY' }),
    { success: true, appId: 'finance-os', name: 'API_KEY' },
  );

  assert.deepEqual(await handlers.get(IPC_CHANNELS.memoryList)(trustedIpcEvent), {
    input: {},
    access: { caller: 'settings' },
  });
  assert.equal((await handlers.get(IPC_CHANNELS.memoryCreate)(trustedIpcEvent, { text: 'Remember this' })).input.source, 'settings');
  assert.equal((await handlers.get(IPC_CHANNELS.memoryUpdate)(trustedIpcEvent, { id: 'mem-1', text: 'Updated' })).access.caller, 'settings');
  assert.equal((await handlers.get(IPC_CHANNELS.memoryDelete)(trustedIpcEvent, 'mem-1')).success, true);

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.chatStartRun)(trustedIpcEvent, {
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

test('main IPC delegates app lifecycle, prompt, secret, official-tool, and file-library commands', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-file-delegation-'));
  t.after(async () => await fs.rm(tempDir, { recursive: true, force: true }));
  const stagedPath = path.join(tempDir, 'staged.png');
  await fs.writeFile(stagedPath, 'image', 'utf8');
  const calls = [];
  const discardedFileInputs = [];
  const fileLibrary = {
    createCategory: async (input) => ({ op: 'createCategory', input }),
    deleteCategory: async (input) => ({ op: 'deleteCategory', input }),
    deleteFiles: async (input) => ({ op: 'deleteFiles', input }),
    discardStagedFilesForChat: async (input) => {
      discardedFileInputs.push(input);
      return { op: 'discard', input };
    },
    importFiles: async (input) => ({ op: 'import', input }),
    list: async (input) => ({ op: 'list', input }),
    listCategories: async () => [{ id: 'uncategorized' }],
    moveFiles: async (input) => ({ op: 'move', input }),
    renameCategory: async (input) => ({ op: 'renameCategory', input }),
    renameFile: async (input) => ({ op: 'renameFile', input }),
    stageFileForChat: async () => ({
      sourcePath: stagedPath,
      name: 'staged.png',
      sizeBytes: 5,
      modifiedAt: (await fs.stat(stagedPath)).mtime.toISOString(),
      type: 'image',
      staged: true,
    }),
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
  const connections = {
    listConnectionsForApp: async () => ({ types: [], instances: [], requirements: [] }),
    setAppConnectionGrant: async (input) => ({ input }),
  };
  const { handlers, IPC_CHANNELS } = await createDeps({
    buildAppSecretsState: async (appId) => ({ appId, appSecrets: [] }),
    getConnectionsService: () => connections,
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

  assert.deepEqual(await handlers.get(IPC_CHANNELS.installApp)(trustedIpcEvent, 'finance-os', 'es'), { op: 'install', appId: 'finance-os', locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.installSocialApp)(trustedIpcEvent, { appId: 9 }, 'es'), { op: 'installSocial', input: { appId: 9 }, locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateApp)(trustedIpcEvent, 'finance-os', 'es'), { op: 'update', appId: 'finance-os', locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.uninstallApp)(trustedIpcEvent, 'finance-os'), { op: 'uninstall', appId: 'finance-os' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.openApp)(trustedIpcEvent, 'finance-os', 'es'), { op: 'open', appId: 'finance-os', locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.stopApp)(trustedIpcEvent, 'finance-os'), { op: 'stop', appId: 'finance-os' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.installWelcome)(trustedIpcEvent, 'finance-os', 'es'), { op: 'welcome', appId: 'finance-os', userLanguage: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAppRuntimeStatus)(trustedIpcEvent, 'finance-os'), { appId: 'finance-os', status: 'running' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAppDetails)(trustedIpcEvent, 'finance-os'), { appId: 'finance-os', name: 'Finance OS' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAppSecrets)(trustedIpcEvent, 'finance-os'), { appId: 'finance-os', appSecrets: [] });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.setAppAutoSync)(trustedIpcEvent, 'finance-os', true), { appId: 'finance-os', autoSync: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.restoreAppUserVersion)(trustedIpcEvent, 'finance-os'), { op: 'restoreUserVersion', appId: 'finance-os' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listAppPrompts)(trustedIpcEvent, 'finance-os'), [{ appId: 'finance-os', id: 'summary' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.validateAppPrompt)(trustedIpcEvent, { appId: 'finance-os' }), { op: 'validatePrompt', input: { appId: 'finance-os' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateAppPrompt)(trustedIpcEvent, { appId: 'finance-os' }), { op: 'updatePrompt', input: { appId: 'finance-os' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.restoreAppPrompt)(trustedIpcEvent, { appId: 'finance-os' }), { op: 'restorePrompt', input: { appId: 'finance-os' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateCodexDefaults)(trustedIpcEvent, { model: 'gpt' }), { op: 'updateCodexDefaults', input: { model: 'gpt' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateAgentDefaults)(trustedIpcEvent, { provider: 'codex' }), { op: 'updateAgentDefaults', input: { provider: 'codex' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateAgentToolApproval)(trustedIpcEvent, { toolId: 'gmail' }), { op: 'updateAgentToolApproval', input: { toolId: 'gmail' } });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.listOfficialTools)(trustedIpcEvent, 'es'), [{ id: 'gmail', locale: 'es' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.refreshOfficialTools)(trustedIpcEvent, 'es'), [{ id: 'gmail', refreshed: true, locale: 'es' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.activateOfficialTool)(trustedIpcEvent, 'gmail', 'es'), { op: 'activate', toolId: 'gmail', locale: 'es' });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.configureOfficialTool)(trustedIpcEvent, { toolId: 'gmail' }), { op: 'configure', input: { toolId: 'gmail' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.deactivateOfficialTool)(trustedIpcEvent, 'gmail', 'es'), { op: 'deactivate', toolId: 'gmail', options: { locale: 'es' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getAppToolsInstallGate)(trustedIpcEvent, 'finance-os', 'es'), { appId: 'finance-os', locale: 'es', connectionRequired: [], connectionOptional: [] });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.setAppToolGrant)(trustedIpcEvent, { appId: 'finance-os', toolId: 'gmail' }, 'es'), { appId: 'finance-os', locale: 'es', connectionRequired: [], connectionOptional: [] });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.setAppConnectionGrant)(trustedIpcEvent, { appId: 'finance-os', type: 'gmail', granted: true }, 'es'), { appId: 'finance-os', locale: 'es', connectionRequired: [], connectionOptional: [] });

  const staged = await handlers.get(IPC_CHANNELS.filesStageForChat)(trustedIpcEvent, { fileId: 'file-1' });
  assert.equal(staged.name, 'staged.png');
  assert.equal(typeof staged.grantId, 'string');
  assert.equal(Object.hasOwn(staged, 'sourcePath'), false);
  const importResult = await handlers.get(IPC_CHANNELS.filesImport)(trustedIpcEvent, { grantIds: [staged.grantId] });
  assert.equal(importResult.op, 'import');
  assert.equal(importResult.input.sources.length, 1);
  assert.equal(importResult.input.sources[0].grantId, staged.grantId);
  assert.equal(importResult.input.sources[0].name, 'staged.png');
  assert.equal(importResult.input.sources[0].staged, true);
  assert.equal(Object.hasOwn(importResult.input, 'sourcePaths'), false);
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.filesDiscardStagedForChat)(trustedIpcEvent, { grantIds: [staged.grantId] }),
    { success: true },
  );
  assert.deepEqual(discardedFileInputs.at(-1), { sourcePaths: [await fs.realpath(stagedPath)] });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesList)(trustedIpcEvent), { op: 'list', input: {} });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesListCategories)(trustedIpcEvent), [{ id: 'uncategorized' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesCreateCategory)(trustedIpcEvent, { name: 'Docs' }), { op: 'createCategory', input: { name: 'Docs' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesRenameCategory)(trustedIpcEvent, { id: 'c1', name: 'Docs' }), { op: 'renameCategory', input: { id: 'c1', name: 'Docs' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesDeleteCategory)(trustedIpcEvent, { id: 'c1' }), { op: 'deleteCategory', input: { id: 'c1' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesMove)(trustedIpcEvent, { fileIds: ['f1'] }), { op: 'move', input: { fileIds: ['f1'] } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesRename)(trustedIpcEvent, { fileId: 'f1' }), { op: 'renameFile', input: { fileId: 'f1' } });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.filesDelete)(trustedIpcEvent, { fileIds: ['f1'] }), { op: 'deleteFiles', input: { fileIds: ['f1'] } });
  assert.deepEqual(calls, []);
});
