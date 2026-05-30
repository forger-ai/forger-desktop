import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerMainLifecycle } = require('../../dist-electron/main/core/main-lifecycle.js');

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const withProcessPlatform = (platform, callback) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
  try {
    return callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }
};

const createServiceClass = (name, calls, extraFactory = () => ({})) => class TestLifecycleService {
  constructor(options = {}) {
    this.name = name;
    this.options = options;
    this.started = false;
    calls.constructed.push({ name, options, service: this });
    Object.assign(this, extraFactory(options, this));
  }

  async start() {
    this.started = true;
    calls.started.push(name);
  }

  async stop() {
    this.started = false;
    calls.stopped.push(name);
  }

  dispose() {
    calls.disposed.push(name);
  }

  async initialize() {
    calls.initialized.push(name);
  }

  async load() {
    calls.loaded.push(name);
    return {};
  }

  async getSummary() {
    return {};
  }

  getPublicRegistration() {
    return {};
  }

  async requestPermission() {
    return null;
  }

  async requestExternalPermission() {
    return null;
  }

  createSession() {
    return 'session-token';
  }

  releaseSession() {}

  async listenMcps() {
    return [];
  }

  releaseMcps() {}

  appendExternalProgress() {}

  environmentForApp() {
    return {};
  }

  publishAgentEvent() {}
};

const createLifecycleHarness = (overrides = {}) => {
  const ready = createDeferred();
  const calls = {
    appendLogs: [],
    constructed: [],
    createdWindows: 0,
    disposed: [],
    initialized: [],
    loaded: [],
    mkdirs: [],
    oauthRegistered: false,
    oauthOptions: null,
    quitCalls: 0,
    started: [],
    stopped: [],
    terminated: [],
  };
  const appListeners = new Map();
  const ipcMain = {};
  const appWindows = new Map();
  const runningApps = new Map();
  const state = {
    agentToolSettings: { approvals: {} },
    appAgentConversationManager: null,
    appAgentTaskManager: null,
    appMcpManager: null,
    automationManager: null,
    catalogApps: [],
    chatOrchestrator: null,
    cloudDeviceManager: null,
    cloudIdentityStore: null,
    desktopErrorReporter: {
      reportAppCodexConversationEvent: () => undefined,
      reportAppCodexTaskEvent: () => undefined,
      reportAutomationRunFailure: () => undefined,
      reportChatRunFailure: () => undefined,
      reportForgerMcpHttpFailure: () => undefined,
      reportForgerMcpToolFailure: () => undefined,
    },
    desktopRuntimeBridge: null,
    devCatalogService: null,
    fileLibrary: null,
    forgerAccount: { authenticated: false },
    forgerAccountStore: null,
    forgerBackendClient: null,
    forgerMcpServer: null,
    localCatalogJsonUrl: undefined,
    mainWindow: null,
    memoryStore: null,
    officialToolsService: null,
    pendingDeepLink: null,
    registry: { apps: {} },
    secretsStore: null,
  };

  const GenericService = createServiceClass('GenericService', calls);
  const FileLibrary = createServiceClass('FileLibrary', calls, () => ({
    cleanupStagedFilesForChat: async () => {
      throw new Error('cleanup_failed');
    },
  }));
  const ForgerAccountStore = createServiceClass('ForgerAccountStore', calls, () => ({
    load: async () => ({ authenticated: true, token: 'token-1', user: { id: 3 } }),
  }));
  const OfficialToolsService = createServiceClass('OfficialToolsService', calls, () => ({
    callFromAgent: async () => ({}),
    listAgentActionIdsForApp: async () => [],
    validateAgentCall: async () => ({}),
  }));

  const deps = {
    AGENT_TOOL_DEFINITIONS: [],
    AppAgentConversationManager: createServiceClass('AppAgentConversationManager', calls),
    AppAgentTaskManager: createServiceClass('AppAgentTaskManager', calls),
    AppMcpManager: createServiceClass('AppMcpManager', calls),
    AutomationManager: createServiceClass('AutomationManager', calls),
    BrowserWindow: {
      getAllWindows: () => [],
    },
    ChatOrchestrator: createServiceClass('ChatOrchestrator', calls),
    CloudDeviceManager: createServiceClass('CloudDeviceManager', calls),
    CloudIdentityStore: createServiceClass('CloudIdentityStore', calls),
    DEFAULT_NODE_VERSION: '22',
    DesktopRuntimeBridge: createServiceClass('DesktopRuntimeBridge', calls),
    DevCatalogService: GenericService,
    FORGER_AGENT_CONTRACT_VERSION: '1',
    FileLibrary,
    ForgerAccountStore,
    ForgerBackendClient: createServiceClass('ForgerBackendClient', calls),
    ForgerMcpServer: createServiceClass('ForgerMcpServer', calls),
    IPC_CHANNELS: {
      appAgentConversationEvent: 'app-agent-conversation-event',
      appAgentTaskUpdated: 'app-agent-task-updated',
      appAgentThreadEvent: 'app-agent-thread-event',
      appCodexConversationEvent: 'app-codex-conversation-event',
      appCodexTaskUpdated: 'app-codex-task-updated',
      loginForgerAccountWithGoogle: 'login-google',
    },
    MemoryMaintenanceManager: createServiceClass('MemoryMaintenanceManager', calls),
    MemoryStore: createServiceClass('MemoryStore', calls),
    SecretsStore: createServiceClass('SecretsStore', calls),
    anyAppAllowsAgentNetworkAccess: async () => false,
    app: {
      getPath: (name) => `/user-data/${name}`,
      getVersion: () => '0.0.0-test',
      on: (event, listener) => appListeners.set(event, listener),
      quit: () => {
        calls.quitCalls += 1;
      },
      whenReady: () => ready.promise,
    },
    appAllowsAgentNetworkAccess: async () => false,
    appWindows,
    appendInstallLog: async (event, payload) => calls.appendLogs.push({ event, payload }),
    backendBaseUrl: 'https://forger.test',
    buildForgerToolsContextForApp: async () => '',
    buildMemoryContextForApp: async () => '',
    buildMemoryContextForApps: async () => '',
    chooseAgentRuntime: async () => ({ provider: 'codex' }),
    clearForgerAccountSession: async () => undefined,
    closeServer: async (server) => calls.terminated.push(['server', server]),
    createWindow: async () => {
      calls.createdWindows += 1;
    },
    emitAutomationUpdated: () => undefined,
    emitChatRunUpdated: () => undefined,
    ensureBackendPythonEnvironment: async () => undefined,
    ensureCatalogStatuses: () => undefined,
    ensureGlobalAgentsContext: async () => undefined,
    ensurePathInside: () => true,
    ensureRuntimeInstalled: async () => ({ binDir: '/runtime/bin' }),
    ensureSqliteDatabaseParent: async () => undefined,
    flushPendingDeepLink: () => undefined,
    fs: {
      ...fs,
      mkdir: async (targetPath, options) => calls.mkdirs.push({ targetPath, options }),
    },
    getAgentPathEntries: async (appId) => {
      const pathEntries = new Set();
      const record = appId ? state.registry.apps[appId] : undefined;
      const codexNodeRuntime = await deps.ensureRuntimeInstalled('node', deps.DEFAULT_NODE_VERSION);
      for (const entry of deps.getRuntimePathEntries(codexNodeRuntime)) {
        pathEntries.add(entry);
      }
      if (record) {
        for (const entry of await deps.getAppLocalToolPathEntries(record)) {
          pathEntries.add(entry);
        }
        const appNodeRuntime = await deps.ensureRuntimeInstalled('node', deps.normalizeNodeRuntimeVersion(record.requiredNodeVersion));
        const appPythonRuntime = await deps.ensureRuntimeInstalled('python', record.requiredPythonVersion);
        for (const entry of deps.getRuntimePathEntries(appNodeRuntime)) {
          pathEntries.add(entry);
        }
        for (const entry of deps.getRuntimePathEntries(appPythonRuntime)) {
          pathEntries.add(entry);
        }
      }
      return [...pathEntries];
    },
    getAppLocalToolPathEntries: async () => ['/app-tools/bin'],
    getBackupsRoot: () => '/forger/backups',
    getClaudeAuthStatus: async () => {
      throw new Error('claude_status_failed');
    },
    getCloudDeviceAccountStorageKey: () => 'user-3',
    getCloudDevicePath: () => '/forger/.forger/cloud-device.json',
    getCloudIdentityPath: () => '/forger/.forger/cloud-identity.json',
    getCloudIdentityStore: () => state.cloudIdentityStore,
    getCodexAuthStatus: async () => ({ authenticated: true }),
    getCodexHome: () => '/codex-home',
    getCodexRoot: () => '/codex-root',
    getCodexToolEnvironment: async () => ({}),
    getForgerAccountPath: () => '/forger/.forger/account.json',
    getForgerHomeRoot: () => '/forger',
    getForgerMetadataRoot: () => '/forger/.forger',
    getFreePort: async () => 1234,
    getLegacyForgerMetadataRoot: () => '/forger/apps/.forger',
    getMemoryStore: () => ({
      create: async () => ({}),
      delete: async () => ({}),
      list: async () => [],
      update: async () => ({}),
    }),
    getOfficialToolsService: () => new OfficialToolsService(),
    getPrivateAppsRoot: () => '/forger/apps',
    getPrivateDataRoot: () => '/forger/data',
    getRuntimesRoot: () => '/runtimes',
    getRuntimePathEntries: () => ['/runtime/bin'],
    getRuntimeStatus: () => ({ status: 'stopped' }),
    getTempRoot: () => '/tmp/forger',
    getVenvExecutables: () => ({}),
    handleCloudSocialEvent: async () => undefined,
    hasInstalledCodexConversation: async () => false,
    ipcMain,
    listAppPrompts: async () => [],
    listCatalogFromBackend: async () => [],
    loadAgentToolSettings: async () => undefined,
    loadCloudSyncSettings: async () => undefined,
    loadRegistry: async () => undefined,
    loadSettings: async () => undefined,
    mapBackendCategory: (value) => value,
    normalizeNodeRuntimeVersion: (value) => value ?? '22',
    openInstalledApp: async () => ({}),
    openOrFocusAppWindow: async () => undefined,
    registerForgerCloudOAuth: (options) => {
      calls.oauthRegistered = true;
      calls.oauthOptions = options;
    },
    registerIpcHandlers: () => undefined,
    resolveClaudeCli: async () => null,
    resolveCodexCliPath: async () => null,
    resolveInstalledAgents: async () => [],
    resolveInstalledManifest: async () => null,
    resolveInstalledPromptTemplates: async () => [],
    restoreAppPrompt: async () => ({}),
    restartInstalledApp: async () => ({}),
    runningApps,
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    shell: {
      openExternal: async () => undefined,
    },
    splitManifestCommand: () => [],
    startDevCatalogService: async () => undefined,
    state,
    stopInstalledApp: async () => ({}),
    stopRemoteNetworkShareSession: async (sessionId) => {
      calls.terminated.push(['remote-session', sessionId]);
      throw new Error('cloud_close_failed');
    },
    switchForgerAccountSession: async () => ({}),
    terminateProcess: async (child) => calls.terminated.push(['process', child]),
    toAppSummary: (record) => record,
    toCatalogStatus: (value) => value,
    translateManifestEnvironment: () => ({}),
    truncateForInstallLog: (value) => value,
    updateAppPrompt: async () => ({}),
    updateAppRuntime: async () => ({}),
    upsertInstalledRecord: async (record) => {
      state.registry.apps[record.appId] = record;
    },
    waitForHttpOk: async () => undefined,
    ...overrides,
  };

  return { appListeners, calls, deps, ready, state };
};

test('main lifecycle initializes services, wires task status through provider-agnostic auth, and logs cleanup failures', async () => {
  const { calls, deps, ready, state } = createLifecycleHarness();

  registerMainLifecycle(deps);
  ready.resolve();
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.oauthRegistered, true);
  assert.equal(calls.createdWindows, 1);
  assert.ok(calls.mkdirs.some((entry) => entry.targetPath === '/forger/apps'));
  assert.ok(calls.started.includes('CloudDeviceManager'));
  assert.ok(calls.started.includes('ForgerMcpServer'));
  assert.ok(calls.started.includes('DesktopRuntimeBridge'));
  assert.ok(calls.initialized.includes('AutomationManager'));
  assert.deepEqual(calls.appendLogs, [
    {
      event: 'files:chat_staging_cleanup_failed',
      payload: { error: { message: 'cleanup_failed' } },
    },
  ]);

  state.registry.apps['finance-os'] = { appId: 'finance-os', userMessage: 'Use local data' };
  state.localCatalogJsonUrl = 'file:///catalog.json';
  assert.equal(state.forgerBackendClient.options.localCatalogJsonUrl(), 'file:///catalog.json');
  assert.equal(state.forgerBackendClient.options.token(), 'token-1');
  assert.equal(state.forgerBackendClient.options.getUserMessage('finance-os'), 'Use local data');
  assert.equal(calls.oauthOptions.backendClient(), state.forgerBackendClient);
  await calls.oauthOptions.openExternalUrl('https://forger.test/oauth');
  await calls.oauthOptions.refreshCatalog();
  assert.equal(state.cloudDeviceManager.options.backendClient(), state.forgerBackendClient);
  assert.equal(state.cloudDeviceManager.options.token(), 'token-1');
  assert.deepEqual(state.cloudDeviceManager.options.getCloudIdentity(), {});
  assert.deepEqual(state.cloudDeviceManager.options.getInstalledApps(), [state.registry.apps['finance-os']]);
  await state.cloudDeviceManager.options.handleFriendshipEvent({ type: 'noop' });
  await state.cloudDeviceManager.options.handleFriendshipEvent({ type: 'remote_tunnel_close', session_id: 'session-1' });
  await state.cloudDeviceManager.options.onAuthenticationInvalid('cloud_session_expired');

  const taskStatus = await state.desktopRuntimeBridge.options.getTaskStatus();
  assert.deepEqual(taskStatus, { connected: true, codex: true, claude: false });
  assert.equal(state.desktopRuntimeBridge.options.getInstalledApp('finance-os'), state.registry.apps['finance-os']);
  assert.equal(state.desktopRuntimeBridge.options.getConversationManager(), state.appAgentConversationManager);
  assert.equal(state.desktopRuntimeBridge.options.getTaskManager(), state.appAgentTaskManager);

  assert.equal(state.chatOrchestrator.options.createForgerMcpSession('run-1', 'forger', 'es'), 'session-token');
  assert.deepEqual(await state.chatOrchestrator.options.getCodexPathEntries(), ['/runtime/bin']);
  assert.equal(await state.chatOrchestrator.options.getCodexCliPath(), null);
  assert.equal(await state.chatOrchestrator.options.getClaudeCliPath(), null);
});

test('main lifecycle service callbacks preserve fallbacks, permissions, and update side effects', async () => {
  const openedWindows = [];
  const runtimeRequests = [];
  const runtimeEntries = [];
  const emittedRuns = [];
  const reports = [];
  const { deps, ready, state } = createLifecycleHarness({
    emitChatRunUpdated: (event) => emittedRuns.push(event),
    ensureRuntimeInstalled: async (type, version) => {
      runtimeRequests.push([type, version]);
      return { type, version, binDir: `/${type}/${version}/bin` };
    },
    getClaudeAuthStatus: async () => ({ authenticated: false }),
    getRuntimePathEntries: (runtime) => {
      runtimeEntries.push(runtime);
      return [`${runtime.binDir}/path`];
    },
    openOrFocusAppWindow: async (appId, appName, frontendUrl) => {
      openedWindows.push({ appId, appName, frontendUrl });
    },
  });
  state.desktopErrorReporter = {
    reportAppCodexConversationEvent: () => undefined,
    reportAppCodexTaskEvent: () => undefined,
    reportAutomationRunFailure: (input) => reports.push(['automation', input]),
    reportChatRunFailure: (input) => reports.push(['chat', input]),
    reportForgerMcpHttpFailure: () => undefined,
    reportForgerMcpToolFailure: () => undefined,
  };
  state.registry.apps['finance-os'] = {
    appId: 'finance-os',
    name: 'Finance OS',
    requiredNodeVersion: '20',
    requiredPythonVersion: '3.11',
    pendingUpdate: { targetVersion: '0.2.0' },
    status: 'conflict',
    updateAvailable: true,
  };

  registerMainLifecycle(deps);
  ready.resolve();
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));

  const permissionCalls = [];
  state.appAgentTaskManager.requestPermission = async () => {
    permissionCalls.push('task');
    return null;
  };
  state.appAgentConversationManager.requestPermission = async () => {
    permissionCalls.push('conversation');
    return 'conversation-decision';
  };
  state.chatOrchestrator.requestExternalPermission = async () => {
    permissionCalls.push('chat');
    return 'chat-decision';
  };

  assert.equal(await state.forgerMcpServer.options.requestPermission('run-1', { id: 'req-1' }), 'conversation-decision');
  assert.deepEqual(permissionCalls, ['task', 'conversation']);

  state.appAgentTaskManager.requestPermission = async () => 'task-decision';
  assert.equal(await state.forgerMcpServer.options.requestPermission('run-2', { id: 'req-2' }), 'task-decision');

  state.appAgentTaskManager.requestPermission = async () => null;
  state.appAgentConversationManager.requestPermission = async () => null;
  assert.equal(await state.forgerMcpServer.options.requestPermission('run-3', { id: 'req-3' }), 'chat-decision');

  assert.deepEqual(await state.forgerMcpServer.options.refreshAppView('missing-app'), {
    success: false,
    userMessage: 'La app no esta abierta.',
    technicalCode: 'app_not_running',
  });

  deps.runningApps.set('finance-os', { frontendUrl: 'http://127.0.0.1:5173' });
  assert.deepEqual(await state.forgerMcpServer.options.refreshAppView('finance-os'), {
    success: true,
    userMessage: 'Vista abierta correctamente.',
  });
  deps.runningApps.set('ghost-app', { frontendUrl: 'http://127.0.0.1:5174' });
  assert.deepEqual(await state.forgerMcpServer.options.refreshAppView('ghost-app'), {
    success: true,
    userMessage: 'Vista abierta correctamente.',
  });
  assert.deepEqual(openedWindows, [
    { appId: 'finance-os', appName: 'Finance OS', frontendUrl: 'http://127.0.0.1:5173' },
    { appId: 'ghost-app', appName: 'ghost-app', frontendUrl: 'http://127.0.0.1:5174' },
  ]);

  const reloads = [];
  deps.appWindows.set('finance-os', {
    isDestroyed: () => false,
    webContents: {
      reloadIgnoringCache: () => reloads.push('reload'),
    },
  });
  assert.deepEqual(await state.forgerMcpServer.options.refreshAppView('finance-os'), {
    success: true,
    userMessage: 'Vista reiniciada correctamente.',
  });
  assert.deepEqual(reloads, ['reload']);

  assert.deepEqual(await state.appAgentTaskManager.options.getCodexPathEntries('finance-os'), [
    '/node/22/bin/path',
    '/app-tools/bin',
    '/node/20/bin/path',
    '/python/3.11/bin/path',
  ]);
  state.desktopRuntimeBridge.environmentForApp = (appId) => ({ APP_ID: appId });
  assert.equal(state.appMcpManager.options.getInstalledApp('finance-os'), state.registry.apps['finance-os']);
  assert.deepEqual(state.appMcpManager.options.getDesktopRuntimeEnvironment('finance-os'), { APP_ID: 'finance-os' });
  assert.deepEqual(await state.chatOrchestrator.options.getCodexPathEntries('finance-os'), [
    '/node/22/bin/path',
    '/app-tools/bin',
    '/node/20/bin/path',
    '/python/3.11/bin/path',
  ]);
  assert.deepEqual(runtimeRequests, [
    ['node', '22'],
    ['node', '20'],
    ['python', '3.11'],
    ['node', '22'],
    ['node', '20'],
    ['python', '3.11'],
  ]);
  assert.equal(await state.appAgentTaskManager.options.getCodexCliPath(), null);
  assert.equal(await state.appAgentTaskManager.options.getClaudeCliPath(), null);
  assert.deepEqual(await state.appAgentTaskManager.options.getCodexPathEntries(), ['/node/22/bin/path']);
  assert.deepEqual(await state.appAgentTaskManager.options.getCodexEnvironment(), {});
  assert.deepEqual(await state.automationManager.options.getCodexPathEntries(), ['/node/22/bin/path']);
  assert.equal(await state.automationManager.options.getCodexCliPath(), null);
  assert.equal(await state.automationManager.options.getClaudeCliPath(), null);
  assert.equal(await state.automationManager.options.getCodexAuthenticated(), true);
  assert.equal(await state.automationManager.options.getClaudeAuthenticated(), false);
  assert.equal(
    state.automationManager.options.createForgerMcpSession('auto-run-1', 'forger', ['finance-os']),
    'session-token',
  );
  assert.deepEqual(state.automationManager.options.getInstalledApps(), [state.registry.apps['finance-os']]);
  state.automationManager.options.releaseForgerMcpSession('auto-session');
  await state.automationManager.options.listenAppMcps(['finance-os'], 'auto-run-1');
  state.automationManager.options.releaseAppMcps('auto-run-1');
  assert.equal(await state.appAgentConversationManager.options.getCodexAuthenticated(), true);
  assert.equal(await state.appAgentConversationManager.options.getClaudeAuthenticated(), false);
  assert.equal(await state.appAgentConversationManager.options.getCodexCliPath(), null);
  assert.equal(await state.appAgentConversationManager.options.getClaudeCliPath(), null);
  assert.deepEqual(await state.appAgentConversationManager.options.getCodexEnvironment('finance-os'), {});
  assert.equal(await state.appAgentConversationManager.options.hasCodexConversation('finance-os'), false);
  assert.deepEqual(await state.appAgentConversationManager.options.resolveAgents('finance-os'), []);
  assert.equal(state.appAgentConversationManager.options.canRequestPermission('missing-app'), false);
  assert.equal(state.appAgentTaskManager.options.canRequestPermission('finance-os'), true);
  deps.appWindows.set('finance-os', { isDestroyed: () => true });
  assert.equal(state.appAgentTaskManager.options.canRequestPermission('finance-os'), false);

  await state.chatOrchestrator.options.onUpdateConflictResolved('finance-os');
  assert.equal(state.registry.apps['finance-os'].version, '0.2.0');
  assert.equal(state.registry.apps['finance-os'].status, 'installed');
  assert.equal(state.registry.apps['finance-os'].pendingUpdate, undefined);

  state.chatOrchestrator.options.onRunUpdated({
    run: {
      appId: 'finance-os',
      runId: 'run-failed',
      status: 'failed',
      errorCode: 'runner_failed',
      userMessage: 'No pudimos completar la tarea.',
    },
  });
	  state.automationManager.options.onAutomationUpdated({
	    automation: { id: 'auto-1', selectedAppIds: ['finance-os'] },
	    run: { id: 'auto-run-1', status: 'failed', userMessage: 'Automation failed' },
	  });
	  state.automationManager.options.onAutomationUpdated({
	    automation: { id: 'auto-2', selectedAppIds: ['finance-os'] },
	    run: { id: 'auto-run-2', status: 'failed', error: 'Automation crashed', userMessage: 'Fallback message' },
	  });
	  state.automationManager.options.onAutomationUpdated({
	    automation: { id: 'auto-3', selectedAppIds: ['finance-os'] },
	    run: { id: 'auto-run-3', status: 'failed' },
	  });
	  assert.deepEqual(emittedRuns.map((event) => event.run.runId), ['run-failed']);
	  assert.deepEqual(reports, [
	    ['chat', {
      appId: 'finance-os',
      runId: 'run-failed',
      errorCode: 'runner_failed',
      message: 'No pudimos completar la tarea.',
    }],
    ['automation', {
      automationId: 'auto-1',
	      runId: 'auto-run-1',
	      selectedAppIds: ['finance-os'],
	      error: 'Automation failed',
	    }],
	    ['automation', {
	      automationId: 'auto-2',
	      runId: 'auto-run-2',
	      selectedAppIds: ['finance-os'],
	      error: 'Automation crashed',
	    }],
	    ['automation', {
	      automationId: 'auto-3',
	      runId: 'auto-run-3',
	      selectedAppIds: ['finance-os'],
	      error: 'automation_run_failed',
	    }],
	  ]);
  assert.equal(runtimeEntries.length, 8);
  assert.deepEqual(await state.chatOrchestrator.options.getCodexEnvironment('finance-os'), {});
  assert.equal(await state.chatOrchestrator.options.getCodexAuthenticated(), true);
  assert.equal(await state.chatOrchestrator.options.getClaudeAuthenticated(), false);
  assert.deepEqual(await state.appAgentTaskManager.options.getCodexEnvironment('finance-os'), {});
  assert.equal(await state.appAgentTaskManager.options.getCodexAuthenticated(), true);
  assert.equal(await state.appAgentTaskManager.options.getClaudeAuthenticated(), false);
});

test('main lifecycle shutdown disposes managers, stops bridges, terminates running apps, and quits non-mac windows', async () => {
  const backend = { pid: 1 };
  const frontend = { pid: 2 };
  const proxyServer = { close: () => undefined };
  const { appListeners, calls, deps, ready, state } = createLifecycleHarness({
    runningApps: new Map([['finance-os', { backend, frontend, proxyServer }]]),
  });

  registerMainLifecycle(deps);
  ready.resolve();
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));

  state.devCatalogService = { stop: () => calls.stopped.push('DevCatalogService') };
  appListeners.get('before-quit')();
  assert.ok(calls.disposed.includes('AutomationManager'));
  assert.ok(calls.disposed.includes('AppMcpManager'));
  assert.ok(calls.stopped.includes('DesktopRuntimeBridge'));
  assert.ok(calls.stopped.includes('CloudDeviceManager'));
  assert.ok(calls.stopped.includes('DevCatalogService'));
  assert.ok(calls.stopped.includes('ForgerMcpServer'));
  assert.deepEqual(calls.terminated, [
    ['process', backend],
    ['process', frontend],
    ['server', proxyServer],
  ]);
  assert.equal(state.desktopRuntimeBridge, null);
  assert.equal(state.forgerMcpServer, null);

  withProcessPlatform('linux', () => appListeners.get('window-all-closed')());
  assert.equal(calls.quitCalls, 1);
});

test('main lifecycle tolerates missing optional cleanup callback', async () => {
  const { calls, deps, ready } = createLifecycleHarness({
    FileLibrary: createServiceClass('FileLibraryWithoutCleanup', {
      appendLogs: [],
      constructed: [],
      disposed: [],
      initialized: [],
      loaded: [],
      started: [],
      stopped: [],
    }),
  });

  registerMainLifecycle(deps);
  ready.resolve();
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.appendLogs.some((entry) => entry.event === 'files:chat_staging_cleanup_failed'), false);
});

test('main lifecycle wires pending deep-link flush after the first window load', async () => {
  const onceCalls = [];
  const { deps, ready, state } = createLifecycleHarness({
    flushPendingDeepLink: () => onceCalls.push(['flushed']),
  });
  state.mainWindow = {
    webContents: {
      once: (event, listener) => onceCalls.push([event, listener]),
    },
  };
  state.pendingDeepLink = { type: 'app', appId: 'finance-os' };

  registerMainLifecycle(deps);
  ready.resolve();
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(onceCalls.length, 1);
  assert.equal(onceCalls[0][0], 'did-finish-load');
  onceCalls[0][1]();
  assert.deepEqual(onceCalls.at(-1), ['flushed']);
});

test('main lifecycle forwards manager events only to live app windows and recreates windows on activate', async () => {
  const { appListeners, calls, deps, ready, state } = createLifecycleHarness({
    BrowserWindow: {
      getAllWindows: () => [],
    },
  });
  const reports = [];
  state.desktopErrorReporter = {
    reportAppCodexConversationEvent: (event) => reports.push(['conversation', event.type]),
    reportAppCodexTaskEvent: (event) => reports.push(['task', event.task.status]),
    reportAutomationRunFailure: () => undefined,
    reportChatRunFailure: () => undefined,
    reportForgerMcpHttpFailure: () => undefined,
    reportForgerMcpToolFailure: () => undefined,
  };

  registerMainLifecycle(deps);
  ready.resolve();
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));

  const sends = [];
  const liveWindow = {
    webContents: {
      send: (channel, payload) => sends.push([channel, payload]),
    },
    isDestroyed: () => false,
  };
  const destroyedWindow = {
    webContents: {
      send: (channel, payload) => sends.push(['destroyed', channel, payload]),
    },
    isDestroyed: () => true,
  };

  deps.appWindows.set('finance-os', liveWindow);
  state.appAgentTaskManager.options.onTaskUpdated({
    task: { appId: 'finance-os', runId: 'task-1', status: 'running' },
  });
  state.appAgentConversationManager.options.onConversationEvent({
    type: 'message.created',
    conversation: {
      appId: 'finance-os',
      conversationId: 'thread-1',
      title: 'Review',
      createdAt: 'now',
      updatedAt: 'now',
      messages: [],
    },
    run: {
      runId: 'run-1',
      status: 'running',
      createdAt: 'now',
      updatedAt: 'now',
      progressLog: ['working'],
    },
  });
  state.appAgentConversationManager.options.onConversationEvent({
    type: 'run.message.completed',
    conversation: {
      appId: 'finance-os',
      conversationId: 'thread-1',
      title: 'Review',
      createdAt: 'now',
      updatedAt: 'now',
      messages: [],
    },
    run: {
      runId: 'run-1',
      status: 'completed',
      createdAt: 'now',
      updatedAt: 'now',
    },
  });
  state.appAgentConversationManager.options.onConversationEvent({
    type: 'run.failed',
    progress: { message: 'Failed after tool call' },
    conversation: {
      appId: 'finance-os',
      conversationId: 'thread-1',
      title: 'Review',
      createdAt: 'now',
      updatedAt: 'now',
      messages: [],
    },
    run: {
      runId: 'run-1',
      status: 'failed',
      error: 'tool failed',
      createdAt: 'now',
      updatedAt: 'now',
    },
  });
  state.desktopRuntimeBridge = null;
  state.appAgentConversationManager.options.onConversationEvent({
    type: 'conversation.created',
    conversation: {
      appId: 'finance-os',
      conversationId: 'thread-2',
      title: 'Started elsewhere',
      activeRun: { status: 'running' },
      createdAt: 'now',
      updatedAt: 'now',
      messages: [],
    },
  });
  state.appAgentConversationManager.options.onConversationEvent({
    type: 'conversation.updated',
    conversation: {
      appId: 'finance-os',
      conversationId: 'thread-3',
      title: 'Idle thread',
      createdAt: 'now',
      updatedAt: 'now',
      messages: [],
    },
  });

  deps.appWindows.set('finance-os', destroyedWindow);
  state.appAgentTaskManager.options.onTaskUpdated({
    task: { appId: 'finance-os', runId: 'task-2', status: 'completed' },
  });

	  assert.deepEqual(sends.map((entry) => entry[0]), [
	    'app-agent-task-updated',
	    'app-codex-task-updated',
	    'app-agent-conversation-event',
	    'app-codex-conversation-event',
	    'app-agent-thread-event',
	    'app-agent-conversation-event',
	    'app-codex-conversation-event',
	    'app-agent-conversation-event',
	    'app-codex-conversation-event',
	    'app-agent-thread-event',
	    'app-agent-conversation-event',
	    'app-codex-conversation-event',
	    'app-agent-thread-event',
	    'app-agent-conversation-event',
	    'app-codex-conversation-event',
	    'app-agent-thread-event',
	  ]);
  assert.deepEqual(sends.find((entry) => entry[0] === 'app-agent-thread-event')[1], {
    type: 'run.message',
    desktop_thread_id: 'thread-1',
    desktop_run_id: 'run-1',
    thread: {
      desktop_thread_id: 'thread-1',
      title: 'Review',
      status: 'running',
    },
    run: {
      desktop_thread_id: 'thread-1',
      desktop_run_id: 'run-1',
      status: 'running',
      progressLog: ['working'],
    },
  });
  assert.deepEqual(sends
    .filter((entry) => entry[0] === 'app-agent-thread-event')
    .find((entry) => entry[1].type === 'run.failed')[1], {
    type: 'run.failed',
    desktop_thread_id: 'thread-1',
    desktop_run_id: 'run-1',
    thread: {
      desktop_thread_id: 'thread-1',
      title: 'Review',
      status: 'failed',
    },
    run: {
      desktop_thread_id: 'thread-1',
      desktop_run_id: 'run-1',
      status: 'failed',
      error: 'tool failed',
    },
    progress: { message: 'Failed after tool call' },
  });
  const createdThreadEvent = sends.filter((entry) => entry[0] === 'app-agent-thread-event')[2][1];
  assert.deepEqual(createdThreadEvent, {
    type: 'thread.created',
    desktop_thread_id: 'thread-2',
    thread: {
      desktop_thread_id: 'thread-2',
      title: 'Started elsewhere',
      status: 'running',
    },
  });
  const idleThreadEvent = sends.filter((entry) => entry[0] === 'app-agent-thread-event')[3][1];
  assert.deepEqual(idleThreadEvent, {
    type: 'conversation.updated',
    desktop_thread_id: 'thread-3',
    thread: {
      desktop_thread_id: 'thread-3',
      title: 'Idle thread',
      status: 'idle',
    },
  });
  assert.equal(sends.some((entry) => entry[0] === 'destroyed'), false);
  assert.deepEqual(reports, [
    ['task', 'running'],
    ['conversation', 'message.created'],
    ['conversation', 'run.message.completed'],
    ['conversation', 'run.failed'],
    ['conversation', 'conversation.created'],
    ['conversation', 'conversation.updated'],
    ['task', 'completed'],
  ]);

  const createdBeforeActivate = calls.createdWindows;
  await appListeners.get('activate')();
  assert.equal(calls.createdWindows, createdBeforeActivate + 1);
});

test('main lifecycle service option callbacks cover catalog, memory, tools, MCP fallbacks, and non-error updates', async () => {
  const catalog = [{ id: 'finance-os', name: 'Finance OS' }];
  const emittedAutomation = [];
  const emittedRuns = [];
  const reports = [];
  const officialCalls = [];
  const memoryCalls = [];
  const progress = [];
  const { deps, ready, state } = createLifecycleHarness({
    emitAutomationUpdated: (event) => emittedAutomation.push(event),
    emitChatRunUpdated: (event) => emittedRuns.push(event),
    getMemoryStore: () => ({
      create: async (input, access) => {
        memoryCalls.push(['create', input, access]);
        return { input, access };
      },
      delete: async (id, access) => {
        memoryCalls.push(['delete', id, access]);
        return { success: true };
      },
      list: async (input, access) => {
        memoryCalls.push(['list', input, access]);
        return [];
      },
      update: async (input, access) => {
        memoryCalls.push(['update', input, access]);
        return { input, access };
      },
    }),
	    getOfficialToolsService: () => ({
	      callFromAgent: async (input, access) => {
	        officialCalls.push(['call', input, access]);
	        return { called: true };
      },
      load: async () => undefined,
      listAgentActionIdsForApp: async (appId) => {
        officialCalls.push(['list', appId]);
        return ['gmail.read'];
      },
      validateAgentCall: async (input, access) => {
        officialCalls.push(['validate', input, access]);
        return { valid: true };
      },
	    }),
	    getCodexAuthStatus: async () => ({ authenticated: false }),
	    getClaudeAuthStatus: async () => ({ authenticated: false }),
	    listCatalogFromBackend: async () => catalog,
	    resolveClaudeCli: async () => ({ path: '/bin/claude', source: 'test' }),
	  });
  state.desktopErrorReporter = {
    reportAppCodexConversationEvent: () => undefined,
    reportAppCodexTaskEvent: () => undefined,
    reportAutomationRunFailure: (input) => reports.push(['automation', input]),
    reportChatRunFailure: (input) => reports.push(['chat', input]),
    reportForgerMcpHttpFailure: (input) => reports.push(['http', input]),
    reportForgerMcpToolFailure: (input) => reports.push(['tool', input]),
    reportAppMcpStartFailure: (input) => reports.push(['mcp-start', input]),
  };
  state.registry.apps['finance-os'] = {
    appId: 'finance-os',
    name: 'Finance OS',
    requiredNodeVersion: '20',
    requiredPythonVersion: '3.11',
    updateAvailable: true,
  };

  registerMainLifecycle(deps);
  ready.resolve();
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));

  state.chatOrchestrator.appendExternalProgress = (runId, message) => progress.push([runId, message]);
  assert.deepEqual(await state.forgerMcpServer.options.listCatalog(), catalog);
  assert.deepEqual(await state.forgerMcpServer.options.checkUpdates(), [state.registry.apps['finance-os']]);
  assert.deepEqual(state.forgerMcpServer.options.listInstalledApps(), [state.registry.apps['finance-os']]);
	  assert.equal(state.forgerMcpServer.options.getAppVersion(), '0.0.0-test');
	  assert.deepEqual(state.forgerMcpServer.options.getToolDefinitions(), []);
	  assert.equal(state.forgerMcpServer.options.getToolSettings(), state.agentToolSettings);
	  assert.deepEqual(await state.desktopRuntimeBridge.options.getTaskStatus(), { connected: false, codex: false, claude: false });
	  assert.equal(await state.chatOrchestrator.options.getClaudeCliPath(), '/bin/claude');
	  assert.equal(await state.appAgentTaskManager.options.getClaudeCliPath(), '/bin/claude');
	  assert.equal(await state.appAgentConversationManager.options.getClaudeCliPath(), '/bin/claude');
	  assert.deepEqual(await state.chatOrchestrator.options.getCodexEnvironment(), {});
	  assert.equal(await state.automationManager.options.getClaudeCliPath(), '/bin/claude');

  await state.forgerMcpServer.options.memoryList({ q: 'cash' }, { caller: 'test' });
  await state.forgerMcpServer.options.memoryCreate({ text: 'cash' }, { caller: 'test' });
  await state.forgerMcpServer.options.memoryUpdate({ id: 'm1' }, { caller: 'test' });
  await state.forgerMcpServer.options.memoryDelete('m1', { caller: 'test' });
  assert.deepEqual(memoryCalls.map((entry) => entry[0]), ['list', 'create', 'update', 'delete']);

  assert.deepEqual(await state.forgerMcpServer.options.listOfficialToolActionIdsForApp('finance-os'), ['gmail.read']);
  assert.deepEqual(await state.forgerMcpServer.options.validateOfficialTool({ toolId: 'gmail' }, {
    appId: 'finance-os',
    caller: 'desktop-chat',
  }), { valid: true });
  assert.deepEqual(await state.forgerMcpServer.options.callOfficialTool({ toolId: 'gmail' }, {
    appId: 'finance-os',
    caller: 'app-agent',
  }), { called: true });
  assert.equal(officialCalls.find((entry) => entry[0] === 'validate')[2].requireAppGrant, false);
  assert.equal(officialCalls.at(-1)[2].requireAppGrant, true);

  state.forgerMcpServer.options.onToolProgress({ runId: 'run-1', message: 'Working' });
  state.forgerMcpServer.options.onToolFailure({ appId: 'finance-os', runId: 'run-1', error: new Error('tool') });
  state.forgerMcpServer.options.onHttpFailure({ appId: 'finance-os', runId: 'run-1', error: new Error('http') });
  state.appMcpManager.options.onMcpStartFailed({ appId: 'finance-os', runId: 'run-1', error: new Error('mcp') });
  assert.deepEqual(progress, [['run-1', 'Working']]);
  assert.deepEqual(reports.map((entry) => entry[0]), ['tool', 'http', 'mcp-start']);

	  const desktopRuntimeBridge = state.desktopRuntimeBridge;
	  state.desktopRuntimeBridge = null;
	  assert.deepEqual(state.appMcpManager.options.getDesktopRuntimeEnvironment('finance-os'), {});
	  state.desktopRuntimeBridge = desktopRuntimeBridge;

	  assert.equal(state.chatOrchestrator.options.createForgerMcpSession('run-desktop', 'finance-os', 'es'), 'session-token');
	  assert.equal(state.appAgentTaskManager.options.createForgerMcpSession('task-run', 'finance-os'), 'session-token');
	  assert.equal(state.appAgentConversationManager.options.createForgerMcpSession('thread-run', 'finance-os', 'es'), 'session-token');
	  state.chatOrchestrator.options.releaseForgerMcpSession('chat-session');
	  state.appAgentTaskManager.options.releaseForgerMcpSession('task-session');
	  state.appAgentConversationManager.options.releaseForgerMcpSession('thread-session');
	  deps.appWindows.set('finance-os', { isDestroyed: () => false });
	  assert.equal(state.appAgentConversationManager.options.canRequestPermission('finance-os'), true);

	  state.registry.apps.recipes = { appId: 'recipes', name: 'Recipes', updateAvailable: false };
	  const mcpListenCalls = [];
	  state.appMcpManager.listenMcps = async (appIds, runId) => {
	    mcpListenCalls.push([appIds, runId]);
	    return appIds;
	  };
	  assert.deepEqual(await state.chatOrchestrator.options.listenAppMcps(['finance-os'], 'run-one-app'), ['finance-os']);
	  assert.deepEqual(await state.appAgentTaskManager.options.listenAppMcps(['finance-os'], 'task-one-app'), ['finance-os']);
	  assert.deepEqual(await state.appAgentConversationManager.options.listenAppMcps(['finance-os'], 'thread-one-app'), ['finance-os']);
	  state.chatOrchestrator.options.releaseAppMcps('run-one-app');
	  state.appAgentTaskManager.options.releaseAppMcps('task-one-app');
	  state.appAgentConversationManager.options.releaseAppMcps('thread-one-app');
	  assert.deepEqual(await state.chatOrchestrator.options.listenAppMcps([], 'run-all-apps'), ['finance-os', 'recipes']);
	  assert.deepEqual(mcpListenCalls.at(-1), [['finance-os', 'recipes'], 'run-all-apps']);

	  const taskManager = state.appAgentTaskManager;
	  const conversationManager = state.appAgentConversationManager;
	  const chatOrchestrator = state.chatOrchestrator;
	  state.appAgentTaskManager = null;
	  state.appAgentConversationManager = null;
	  state.chatOrchestrator = null;
	  assert.equal(await state.forgerMcpServer.options.requestPermission('run-no-manager', { id: 'req' }), null);
	  assert.doesNotThrow(() => state.forgerMcpServer.options.onToolProgress({ runId: 'run-no-chat', message: 'No chat' }));
	  state.appAgentTaskManager = taskManager;
	  state.appAgentConversationManager = conversationManager;
	  state.chatOrchestrator = chatOrchestrator;

	  const appMcpManager = state.appMcpManager;
	  state.appMcpManager = null;
	  assert.deepEqual(await state.automationManager.options.listenAppMcps(['finance-os'], 'auto-no-manager'), []);
	  assert.deepEqual(await state.chatOrchestrator.options.listenAppMcps([], 'run-no-manager'), []);
	  assert.deepEqual(await state.appAgentTaskManager.options.listenAppMcps(['finance-os'], 'task-no-manager'), []);
	  assert.deepEqual(await state.appAgentConversationManager.options.listenAppMcps(['finance-os'], 'thread-no-manager'), []);
	  state.automationManager.options.releaseAppMcps('auto-no-manager');
	  state.chatOrchestrator.options.releaseAppMcps('run-no-manager');
	  state.appAgentTaskManager.options.releaseAppMcps('task-no-manager');
	  state.appAgentConversationManager.options.releaseAppMcps('thread-no-manager');
  state.appMcpManager = appMcpManager;

	  const forgerMcpServer = state.forgerMcpServer;
	  state.forgerMcpServer = null;
	  assert.equal(state.automationManager.options.createForgerMcpSession('run-1', 'finance-os', ['finance-os']), null);
	  assert.equal(state.chatOrchestrator.options.createForgerMcpSession('run-1', 'finance-os'), null);
	  assert.equal(state.appAgentTaskManager.options.createForgerMcpSession('run-1', 'finance-os'), null);
	  assert.equal(state.appAgentConversationManager.options.createForgerMcpSession('run-1', 'finance-os'), null);
	  state.automationManager.options.releaseForgerMcpSession('missing');
	  state.chatOrchestrator.options.releaseForgerMcpSession('missing');
  state.appAgentTaskManager.options.releaseForgerMcpSession('missing');
  state.appAgentConversationManager.options.releaseForgerMcpSession('missing');
  state.forgerMcpServer = forgerMcpServer;

  await state.chatOrchestrator.options.onUpdateConflictResolved('finance-os');
  assert.equal(state.registry.apps['finance-os'].status, undefined);
  state.chatOrchestrator.options.onRunUpdated({ run: { appId: 'finance-os', runId: 'run-ok', status: 'completed' } });
  state.automationManager.options.onAutomationUpdated({
    automation: { id: 'auto-1', selectedAppIds: ['finance-os'] },
    run: { id: 'auto-run-1', status: 'completed' },
  });
  assert.deepEqual(emittedRuns.map((event) => event.run.runId), ['run-ok']);
  assert.deepEqual(emittedAutomation.map((event) => event.run.id), ['auto-run-1']);
  assert.equal(reports.some(([kind]) => kind === 'chat' || kind === 'automation'), false);
});

test('main lifecycle app-agent conversation callbacks cover runtime paths, environments, and auth', async () => {
  const runtimeRequests = [];
  const environments = [];
  const { deps, ready, state } = createLifecycleHarness({
    ensureRuntimeInstalled: async (type, version) => {
      runtimeRequests.push([type, version]);
      return { type, version, binDir: `/${type}/${version}/bin` };
    },
    getCodexToolEnvironment: async (appId, runtime) => {
      environments.push([appId, runtime]);
      return { APP_ID: appId ?? 'none', PYTHON_BIN: runtime?.binDir ?? 'none' };
    },
    getRuntimePathEntries: (runtime) => [`${runtime.binDir}/path`],
    getClaudeAuthStatus: async () => ({ authenticated: true }),
  });
  state.registry.apps['finance-os'] = {
    appId: 'finance-os',
    name: 'Finance OS',
    requiredNodeVersion: '20.2.0',
    requiredPythonVersion: '3.12',
    status: 'installed',
  };

  registerMainLifecycle(deps);
  ready.resolve();
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await state.appAgentConversationManager.options.getCodexPathEntries('finance-os'), [
    '/node/22/bin/path',
    '/app-tools/bin',
    '/node/20.2.0/bin/path',
    '/python/3.12/bin/path',
  ]);
  assert.deepEqual(await state.appAgentConversationManager.options.getCodexPathEntries(), ['/node/22/bin/path']);
  assert.deepEqual(await state.appAgentConversationManager.options.getCodexEnvironment('finance-os'), {
    APP_ID: 'finance-os',
    PYTHON_BIN: '/python/3.12/bin',
  });
  assert.deepEqual(await state.appAgentConversationManager.options.getCodexEnvironment(), {
    APP_ID: 'none',
    PYTHON_BIN: 'none',
  });
  assert.equal(await state.appAgentConversationManager.options.getClaudeAuthenticated(), true);
  assert.deepEqual(runtimeRequests, [
    ['node', '22'],
    ['node', '20.2.0'],
    ['python', '3.12'],
    ['node', '22'],
    ['python', '3.12'],
  ]);
  assert.deepEqual(environments.map(([appId]) => appId), ['finance-os', undefined]);
});
