import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createIpcMainRecorder } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerMainIpcHandlers } = require('../../dist-electron/main/ipc/main-handlers.js');

test('main IPC delegates remote network share handlers', async () => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  registerMainIpcHandlers({
    APP_CLAUDE_MODEL_OPTIONS: [],
    APP_CODEX_MODEL_OPTIONS: [],
    BetterSqlite3: null,
    BrowserWindow: { fromWebContents: () => null },
    CODEX_USAGE_DASHBOARD_URL: 'https://platform.openai.com/usage',
    IPC_CHANNELS,
    app: { getVersion: () => '0.0.0-test' },
    buildForgerToolsContextForApp: async () => '',
    buildForgerToolsContextForFreeChat: async () => '',
    chatOrchestrator: null,
    cloudDeviceManager: null,
    connectClaudeAuth: async () => ({}),
    connectCodexAuth: async () => ({}),
    createRemoteAppBackup: async () => ({}),
    decryptCloudMessage: async (message) => message,
    decryptCloudMessages: async (messages) => messages,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    disconnectCodexAuth: async () => ({}),
    ensureCatalogStatuses: () => undefined,
    failureDiagnostic: () => ({ technicalCode: 'failed' }),
    forgerBackendClient: null,
    forwardCloudSocialEvent: () => undefined,
    fs: {},
    getAppDetails: async () => null,
    getBackupsManager: () => ({}),
    getClaudeAuthStatus: async () => ({}),
    getCloudIdentityStore: () => ({}),
    getCodexAuthStatus: async () => ({}),
    getDesktopUpdater: () => ({}),
    getFileLibrary: () => ({}),
    getMemoryStore: () => ({}),
    getOfficialToolsService: () => ({}),
    getPrivateDataRoot: () => '/tmp',
    getRuntimeStatus: () => ({}),
    getLocalNetworkShareStatus: () => ({}),
    getRemoteNetworkShareStatus: (appId) => ({ active: true, appId, state: 'connected', tunnelUrl: 'https://finance.loca.lt' }),
    getSecretsStore: () => ({}),
    installAppRuntime: async () => ({}),
    installWelcome: async () => ({}),
    ipcMain,
    listAppPrompts: async () => [],
    listCatalogFromBackend: async () => [],
    normalizeManifestAgentDefaults: () => ({}),
    openInstalledApp: async () => ({}),
    openOrFocusFriendChatWindow: async () => ({}),
    path: {},
    publicForgerAccount: () => ({}),
    registry: { apps: {} },
    reinstallClaude: async () => ({}),
    reinstallCodex: async () => ({}),
    resolveAppIdForWebContents: () => null,
    resolveInstalledAgents: async () => [],
    resolveInstalledAppSecrets: async () => [],
    resolveInstalledManifest: async () => null,
    resolveSelectedAppDisplayName: (appId) => appId,
    restoreAppPrompt: async () => ({}),
    restoreAppUserVersionRuntime: async () => ({}),
    restoreRemoteAppBackup: async () => ({}),
    sanitizeRendererChatTrace: () => ({}),
    sendEncryptedCloudMessage: async (input) => input,
    serializeErrorForInstallLog: (error) => ({ message: String(error) }),
    setAppAutoSyncSetting: async () => ({}),
    shell: { openExternal: async () => undefined },
    signAppFolderGrant: () => ({}),
    state: { agentToolSettings: { approvals: {} }, catalogApps: [], forgerAccount: {}, settings: {} },
    stopInstalledApp: async () => ({}),
    switchForgerAccountSession: async () => ({}),
    toAppSummary: (record) => record,
    uninstallAppRuntime: async () => ({}),
    updateAgentDefaults: async () => ({}),
    updateAgentToolApproval: async () => ({}),
    updateAppPrompt: async () => ({}),
    updateAppRuntime: async () => ({}),
    updateCodexDefaults: async () => ({}),
    validateAppPrompt: async () => ({}),
    startLocalNetworkShare: async () => ({}),
    stopLocalNetworkShare: async () => ({}),
    startRemoteNetworkShare: async (appId) => ({ success: true, appId, status: { active: true, appId, state: 'preparing' } }),
    stopRemoteNetworkShare: async (appId) => ({ success: true, appId, status: { active: false, appId, state: 'closed' } }),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.startRemoteNetworkShare)(null, 'finance-os'), {
    success: true,
    appId: 'finance-os',
    status: { active: true, appId: 'finance-os', state: 'preparing' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.stopRemoteNetworkShare)(null, 'finance-os'), {
    success: true,
    appId: 'finance-os',
    status: { active: false, appId: 'finance-os', state: 'closed' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getRemoteNetworkShareStatus)(null, 'finance-os'), {
    active: true,
    appId: 'finance-os',
    state: 'connected',
    tunnelUrl: 'https://finance.loca.lt',
  });
});
