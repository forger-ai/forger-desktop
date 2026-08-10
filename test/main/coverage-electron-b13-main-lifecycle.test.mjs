import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createDeferred, waitForMainLifecycle } from './main-lifecycle-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { registerMainLifecycle } = require('../../dist-electron/main/core/main-lifecycle.js');
const { WorkflowFeatureController } = require('../../dist-electron/main/workflow-feature-controller.js');

const createLifecycleHarness = async (overrides = {}, harnessOptions = {}) => {
  const metadataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b13-lifecycle-'));
  const ready = createDeferred();
  const listeners = new Map();
  const instances = new Map();
  const oauthOptions = [];
  const calls = [];
  const appWindows = new Map();
  const runningApps = new Map();

  const richService = (name, options = {}) => ({
    name,
    options,
    appendExternalProgress: (...args) => calls.push(['progress', ...args]),
    askPeerAgent: async (input) => ({ success: true, input }),
    call: async (input) => ({ called: true, input }),
    callFromAgent: async (input) => ({ called: true, input }),
    callFromApp: async (appId, input) => ({ appId, input }),
    callFromSession: async (input) => ({ input }),
    cancelWakeup: async (input) => ({ cancelled: true, input }),
    cleanupStagedFilesForChat: async () => undefined,
    configureFromApp: async (appId, input) => ({ appId, input }),
    completeNodeFromMcp: (...args) => ({ completed: true, args }),
    create: async (...args) => ({ created: true, args }),
    createSession: (...args) => (calls.push(['create-session', ...args]), 'session-b13'),
    delete: async (...args) => ({ deleted: true, args }),
    deleteToolSecrets: async () => ({ success: true }),
    dispose: () => calls.push(['dispose', name]),
    environmentForApp: (appId) => ({ APP_ID: appId }),
    failNodeFromMcp: (...args) => ({ failed: true, args }),
    get: (id) => ({ id }),
    getNodeContext: (id) => ({ id }),
    getPublicRegistration: () => ({ publicKey: 'public', keyFingerprint: 'fingerprint' }),
    getState: async () => ({ status: 'ready' }),
    getSummary: async () => ({}),
    initialize: async () => calls.push(['initialize', name]),
    list: async (...args) => [{ args }],
    listAgentActionIdsForApp: async () => ['tool.action'],
    listConnectionsForApp: async () => ({ declarations: [], grants: [], instances: [] }),
    listConnectionsForSession: async () => ({ types: [], instances: [] }),
    listSessionGrantsForApp: async () => [],
    listToolsForApp: async () => [],
    listenMcps: async (appIds) => appIds,
    listenRequiredMcps: async (appIds) => ({ servers: appIds, failures: [] }),
    load: async () => name === 'ForgerAccountStore'
      ? { authenticated: true, token: 'token', user: { id: 1 } }
      : {},
    previewOptionalAppToolGrant: async (input, locale) => ({ input, locale }),
    process: async (input, access) => ({ success: true, input, access }),
    publishAgentEvent: (event) => calls.push(['publish', event]),
    recordCreatedAppFromMcp: (...args) => calls.push(['record-created-app', ...args]),
    registerQuestionFromMcp: async (...args) => ({ args }),
    releaseMcps: (...args) => calls.push(['release-mcps', ...args]),
    releaseSession: (...args) => calls.push(['release-session', ...args]),
    requestExternalPermission: async () => null,
    requestPermission: async () => null,
    setOptionalAppToolGrant: async (input, locale) => ({ input, locale }),
    start: async () => calls.push(['start', name]),
    startActiveTools: async () => undefined,
    startIfConfigured: async () => undefined,
    stop: async (...args) => (calls.push(['stop', name, ...args]), { success: true }),
    synthesize: async (input) => ({ success: true, input }),
    update: async (...args) => ({ updated: true, args }),
    updateDevices: async (input) => ({ input }),
    upsert: async (input) => ({ input }),
    runNow: async (...args) => ({ args }),
    validateAgentCall: async (input) => ({ valid: true, input }),
  });

  const serviceClass = (name) => class LifecycleServiceDouble {
    constructor(options = {}) {
      Object.assign(this, richService(name, options));
      instances.set(name, this);
    }
  };

  const state = {
    agentToolSettings: { approvals: {} },
    appAgentConversationManager: null,
    appAgentTaskManager: null,
    appMcpManager: null,
    automationManager: null,
    workflowFeatureController: null,
    workflowManager: null,
    catalogApps: [],
    chatOrchestrator: null,
    cloudDeviceManager: null,
    cloudIdentityStore: null,
    connectionsService: null,
    desktopErrorReporter: {
      reportAppCodexConversationEvent: () => undefined,
      reportAppCodexTaskEvent: () => undefined,
      reportAutomationRunFailure: () => undefined,
      reportChatRunFailure: () => undefined,
      reportForgerMcpHttpFailure: () => undefined,
      reportForgerMcpToolFailure: () => undefined,
    },
    desktopRuntimeBridge: null,
    fileLibrary: null,
    forgerAccount: { authenticated: false },
    forgerMcpServer: null,
    mainWindow: null,
    memoryStore: null,
    officialToolsService: null,
    pendingDeepLink: null,
    registry: { apps: {} },
    secretsStore: null,
    settings: { defaultChatNetworkAccess: true, earlyAccess: { workflowsEnabled: true } },
  };

  const personalAgentStore = {
    requireAgent: async (agentId) => ({ id: agentId, appIds: [], peerAgentGrants: [] }),
    createAgentFromAgent: async (input) => ({ id: 'created-agent', appIds: [], ...input }),
    requireRoutine: async () => ({ agentId: 'agent-1' }),
    updateAgentPermissions: async (input) => ({ id: input.agentId, appIds: input.appIds }),
    listPeerGrants: async () => [{ agentId: 'peer-1' }],
    listRecentPeerThreadsForAgent: async () => [{ threadId: 'thread-1' }],
    requirePeerThreadAccess: async ({ threadId }) => ({ threadId }),
  };
  const routineManager = richService('PersonalAgentRoutineManager');
  routineManager.scheduleWakeup = async (input) => ({ scheduled: true, input });
  const officialTools = richService('OfficialToolsService');
  const connections = richService('ConnectionsService');
  const selfOAuth = richService('SelfOAuthCallbackService');
  selfOAuth.start = async () => undefined;
  const speech = richService('SpeechToTextService');
  const textToSpeech = richService('TextToSpeechService');
  const wakeWord = richService('WakeWordService');
  const liveVoice = richService('LiveVoiceInputService');
  const sidekick = richService('SidekickService');

  class BrowserWindowDouble {
    static getAllWindows() { return []; }
    constructor() {
      this.webContents = { executeJavaScript: async () => undefined };
      this.destroyed = false;
    }
    async loadURL() {}
    close() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }

  const explicit = {
    AGENT_TOOL_DEFINITIONS: [{ id: 'tool.action' }],
    AppAgentConversationManager: serviceClass('AppAgentConversationManager'),
    AppAgentTaskManager: serviceClass('AppAgentTaskManager'),
    AppMcpManager: serviceClass('AppMcpManager'),
    AutomationManager: serviceClass('AutomationManager'),
    WorkflowFeatureController,
    WorkflowManager: serviceClass('WorkflowManager'),
    BrowserWindow: BrowserWindowDouble,
    ChatOrchestrator: serviceClass('ChatOrchestrator'),
    CloudDeviceManager: serviceClass('CloudDeviceManager'),
    CloudIdentityStore: serviceClass('CloudIdentityStore'),
    DesktopRuntimeBridge: serviceClass('DesktopRuntimeBridge'),
    DevCatalogService: serviceClass('DevCatalogService'),
    FORGER_AGENT_CONTRACT_VERSION: '1',
    FileLibrary: serviceClass('FileLibrary'),
    ForgerAccountStore: serviceClass('ForgerAccountStore'),
    ForgerBackendClient: serviceClass('ForgerBackendClient'),
    ForgerMcpServer: serviceClass('ForgerMcpServer'),
    IPC_CHANNELS: {
      loginForgerAccountWithGoogle: 'login-google',
      loginForgerAccountWithApple: 'login-apple',
      appAgentTaskUpdated: 'task',
      appCodexTaskUpdated: 'codex-task',
      appAgentConversationEvent: 'conversation',
      appCodexConversationEvent: 'codex-conversation',
      appAgentThreadEvent: 'thread',
    },
    MemoryMaintenanceManager: serviceClass('MemoryMaintenanceManager'),
    MemoryStore: serviceClass('MemoryStore'),
    SecretsStore: serviceClass('SecretsStore'),
    app: {
      ...(harnessOptions.withoutLocale ? {} : { getLocale: () => 'es-CL' }),
      getPath: () => metadataRoot,
      getVersion: () => '0.0.0-b13',
      on: (event, listener) => listeners.set(event, listener),
      quit: () => calls.push(['quit']),
      whenReady: () => ready.promise,
    },
    appWindows,
    runningApps,
    appendInstallLog: async (...args) => calls.push(['log', ...args]),
    backendBaseUrl: 'https://cloud.test',
    dialog: {},
    cleanupLegacyExternalToolState: async () => undefined,
    closeServer: async () => undefined,
    createWindow: async () => calls.push(['window']),
    ensureCatalogStatuses: () => calls.push(['catalog-status']),
    ensureGlobalAgentsContext: async () => undefined,
    ensurePathInside: () => true,
    ensureRuntimeInstalled: async (type, version) => ({ type, version, binDir: `/${type}/${version}/bin` }),
    flushPendingDeepLink: () => calls.push(['deep-link']),
    fs,
    getAgentPathEntries: async () => ['/runtime/bin'],
    getBackupsRoot: () => path.join(metadataRoot, 'backups'),
    getClaudeAuthStatus: async () => ({ authenticated: true }),
    getAntigravityAuthStatus: async () => ({ authenticated: true }),
    getCloudDeviceAccountStorageKey: () => 'account-1',
    getCloudDevicePath: () => path.join(metadataRoot, 'cloud-device.json'),
    getCloudIdentityPath: () => path.join(metadataRoot, 'cloud-identity.json'),
    getCloudIdentityStore: () => state.cloudIdentityStore,
    getCodexAuthStatus: async () => ({ authenticated: true }),
    getCodexHome: () => path.join(metadataRoot, 'codex-home'),
    getCodexRoot: () => path.join(metadataRoot, 'codex-root'),
    getCodexToolEnvironment: async () => ({ TEST: '1' }),
    getDesktopChatNetworkAccessDefault: () => true,
    getProviderInactivityTimeoutMs: () => 1_000,
    getManifestAppSecretsValidationError: () => null,
    getSecretsStore: () => ({ resolveAppEnv: async () => ({ env: {}, missingRequired: [], secretValues: [] }) }),
    getForgerAccountPath: () => path.join(metadataRoot, 'account.json'),
    getForgerHomeRoot: () => path.join(metadataRoot, 'home'),
    getForgerMetadataRoot: () => metadataRoot,
    getProviderProfilesRoot: () => path.join(metadataRoot, 'profiles'),
    resolveLlmProviderAuthProfile: undefined,
    getSocialAppReviewPromptContext: async () => ({ appRoot: '/review/app' }),
    getFreePort: async () => 1234,
    getLegacyForgerMetadataRoot: () => path.join(metadataRoot, 'legacy'),
    getMemoryStore: () => richService('MemoryStore'),
    getPersonalAgentHeartbeat: async () => ({ supported: true, count: 0, ids: [], agents: [] }),
    getPersonalAgentStore: () => personalAgentStore,
    getPersonalAgentConversationManager: () => richService('PersonalAgentConversationManager'),
    getPersonalAgentRoutineManager: () => routineManager,
    getOfficialToolsService: () => officialTools,
    getConnectionsService: () => connections,
    getSelfOAuthCallbackService: () => selfOAuth,
    getSidekickService: () => sidekick,
    getSpeechToTextService: () => speech,
    getTextToSpeechService: () => textToSpeech,
    getWakeWordService: () => wakeWord,
    getLiveVoiceInputService: () => liveVoice,
    getAudioDevices: async () => ({ inputDevices: [], outputDevices: [] }),
    playTextToSpeechAudio: async () => ({ success: true }),
    cancelTextToSpeechPlayback: async () => undefined,
    deleteTextToSpeechAudio: async () => undefined,
    getPrivateAppsRoot: () => path.join(metadataRoot, 'apps'),
    getPrivateDataRoot: () => path.join(metadataRoot, 'data'),
    getRuntimesRoot: () => path.join(metadataRoot, 'runtimes'),
    getRuntimePathEntries: (runtime) => [runtime.binDir],
    getRuntimeStatus: () => ({ status: 'stopped' }),
    getTempRoot: () => path.join(metadataRoot, 'temp'),
    getVenvExecutables: () => ({}),
    ipcMain: {},
    listCatalogFromBackend: async () => [],
    llmRunsStore: {
      recordChatRunEvent: (...args) => calls.push(['llm-chat', ...args]),
      recordAppPromptTaskEvent: (...args) => calls.push(['llm-task', ...args]),
      recordAppAgentConversationEvent: (...args) => calls.push(['llm-conversation', ...args]),
      recordWorkflowNodeActivity: (...args) => calls.push(['llm-workflow', ...args]),
    },
    mapBackendCategory: (value) => value,
    formatProcessOutputForInstallLog: (value) => value,
    isSecretsVaultUnavailableError: () => false,
    normalizeManifestAppSecrets: () => [],
    persistWorkflowsEarlyAccess: async () => undefined,
    registerForgerCloudOAuth: (options) => oauthOptions.push(options),
    registerIpcHandlers: () => undefined,
    renderManifestAgentPrompt: () => 'prompt',
    resolveClaudeCli: async () => ({ path: '/bin/claude', source: 'test' }),
    resolveAntigravityCliPath: async () => '/bin/antigravity',
    resolveCodexCliPath: async () => '/bin/codex',
    resolveAppFolderGrant: () => null,
    resolveInstalledAgents: async () => [],
    resolveInstalledManifest: async () => null,
    resolveInstalledPromptTemplates: async () => [],
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    shell: { openExternal: async (url) => calls.push(['external', url]) },
    splitManifestCommand: () => [],
    startDevCatalogService: async () => undefined,
    startLocalNetworkShare: async (appId) => ({ success: true, status: { active: true, appId, state: 'ready' } }),
    stopLocalNetworkShare: async () => ({ success: true }),
    startRemoteNetworkShare: async (appId) => ({ success: true, status: { active: true, appId, state: 'ready' } }),
    stopRemoteNetworkShare: async () => ({ success: true }),
    stopRemoteNetworkShareSession: async () => undefined,
    startRemoteAgentSession: async (agentId) => ({ success: true, status: { active: true, agentId, state: 'ready' } }),
    stopRemoteAgentSession: async (agentId) => ({ success: true, status: { active: false, agentId, state: 'closed' } }),
    stopRemoteAgentSessionSession: async () => ({ success: true, status: { active: false, agentId: 'agent-1', state: 'closed' } }),
    state,
    stopInstalledApp: async () => ({ success: true }),
    terminateProcess: async () => undefined,
    toAppSummary: (record) => record,
    toCatalogStatus: (value) => value,
    translateManifestEnvironment: () => ({}),
    truncateForInstallLog: (value) => value,
    upsertInstalledRecord: async (record) => { state.registry.apps[record.appId] = record; },
    ...overrides,
  };
  const deps = new Proxy(explicit, {
    get(target, property) {
      if (Reflect.has(target, property)) return Reflect.get(target, property);
      return async () => undefined;
    },
  });

  registerMainLifecycle(deps);
  ready.resolve();
  await ready.promise;
  await waitForMainLifecycle(harnessOptions.waitFor ?? (() => calls.some(([kind]) => kind === 'window')));
  return {
    appWindows, calls, cleanup: async () => fs.rm(metadataRoot, { recursive: true, force: true }),
    deps, instances, listeners, oauthOptions, personalAgentStore, ready, routineManager, state,
  };
};

test('given a ready desktop, lifecycle options compose cloud, tools, agents, audio, and workflow boundaries', async () => {
  const harness = await createLifecycleHarness();
  const { calls, deps, instances, oauthOptions, personalAgentStore, routineManager, state } = harness;
  try {
    assert.equal(oauthOptions.length, 2);
    for (const oauth of oauthOptions) {
      assert.equal(oauth.backendClient(), state.forgerBackendClient);
      await oauth.openExternalUrl('https://forger.test/oauth');
      await oauth.refreshCatalog();
    }
    assert.equal(instances.get('ForgerBackendClient').options.reportSanitizerRoots().length > 0, true);

    const cloud = state.cloudDeviceManager.options;
    assert.equal((await cloud.handleAppAccessRequest({ appId: 'app', requestId: 'local', mode: 'local_network' })).success, true);
    assert.equal((await cloud.handleAppAccessRequest({ appId: 'app', requestId: 'remote', mode: 'remote_tunnel' })).success, true);
    assert.equal((await cloud.handleAgentAccessRequest({ agentId: 'agent-1', requestId: 'agent', requestedByDeviceId: 91, requestedByDeviceName: 'Phone' })).success, true);
    assert.equal((await cloud.handleAgentAccessDisconnect({ sessionId: 'session-1' })).success, true);
    assert.equal((await cloud.handleAgentAccessDisconnect({ agentId: 'agent-1' })).success, true);
    assert.equal(await cloud.handleAgentAccessDisconnect({}), undefined);
    assert.equal((await cloud.handleAppControlRequest({ appId: 'app', requestId: 'unsupported', action: 'restart' })).success, false);
    assert.equal((await cloud.handleAppControlRequest({ appId: 'app', requestId: 'stop', action: 'stop_app' })).success, true);
    await cloud.handleFriendshipEvent({ type: 'remote_agent_session_close', sessionId: 'camel-session' });
    await cloud.handleFriendshipEvent({ type: 'remote_agent_session_close', agent_id: 'agent-1' });
    await cloud.handleFriendshipEvent({ type: 'remote_agent_session_close' });

    const mcp = state.forgerMcpServer.options;
    assert.deepEqual(await mcp.getConnectionToolDefinitions(), []);
    assert.equal(mcp.isWorkflowsEnabled(), true);
    assert.equal((await mcp.addAppToPersonalAgent({ agentId: 'agent-1', appId: 'missing' })).success, false);
    state.registry.apps.app = { appId: 'app', name: 'App', installDir: '/apps/app', appIds: [] };
    state.registry.apps.noPath = { appId: 'noPath', name: 'No path' };
    assert.equal(mcp.listInstalledApps().some((app) => app.appId === 'noPath' && !('path' in app)), true);
    personalAgentStore.requireAgent = async () => ({ id: 'agent-1', appIds: ['app'] });
    assert.equal((await mcp.addAppToPersonalAgent({ agentId: 'agent-1', appId: 'app' })).alreadyGranted, true);
    personalAgentStore.requireAgent = async () => ({ id: 'agent-1', appIds: [] });
    assert.equal((await mcp.addAppToPersonalAgent({ agentId: 'agent-1', appId: 'app' })).alreadyGranted, false);
    assert.equal((await mcp.createPersonalAgentFromAgent({ name: 'Helper' })).id, 'created-agent');
    assert.equal((await mcp.listAgentPeers({ agentId: 'agent-1' })).success, true);
    assert.equal((await mcp.askAgent({ agentId: 'agent-1' })).success, true);
    assert.equal((await mcp.readAgentThread({ agentId: 'agent-1', threadId: 'thread-1' })).success, true);
    personalAgentStore.requirePeerThreadAccess = async () => { throw 'denied'; };
    assert.equal((await mcp.readAgentThread({ agentId: 'agent-1', threadId: 'thread-2' })).technicalCode, 'personal_agent_peer_thread_read_failed');
    personalAgentStore.requirePeerThreadAccess = async () => { throw new Error('thread_denied'); };
    assert.equal((await mcp.readAgentThread({ agentId: 'agent-1', threadId: 'thread-3' })).technicalCode, 'thread_denied');
    assert.equal((await mcp.schedulePersonalAgentWakeup({ agentId: 'agent-1', runId: 'run', seconds: 5 })).scheduled, true);
    await mcp.cancelPersonalAgentWakeup({ id: 'wake' });
    await mcp.createAgentRoutine({ agentId: 'agent-1' });
    await mcp.listAgentRoutines({ agentId: 'agent-1' });
    await mcp.updateAgentRoutine({ agentId: 'agent-1', routineId: 'routine-1' });
    await mcp.deleteAgentRoutine({ agentId: 'agent-1', routineId: 'routine-1' });
    personalAgentStore.requireRoutine = async () => ({ agentId: 'other' });
    await assert.rejects(mcp.updateAgentRoutine({ agentId: 'agent-1', routineId: 'routine-1' }), /personal_agent_routine_not_found/);
    await assert.rejects(mcp.deleteAgentRoutine({ agentId: 'agent-1', routineId: 'routine-1' }), /personal_agent_routine_not_found/);
    mcp.recordCreatedApp('run-1', { appId: 'app' });
    assert.deepEqual(await mcp.registerQuestion('run-1', { question: 'Continue?' }), { args: ['run-1', { question: 'Continue?' }] });
    const chatOrchestrator = state.chatOrchestrator;
    state.chatOrchestrator = null;
    mcp.recordCreatedApp('run-without-chat', { appId: 'app' });
    await assert.rejects(mcp.registerQuestion('run-without-chat', {}), /chat_orchestrator_unavailable/);
    state.chatOrchestrator = chatOrchestrator;
    await mcp.previewAppToolGrant({ appId: 'app' }, 'es');
    await mcp.setAppToolGrant({ appId: 'app' }, 'es');
    await mcp.listConnectionGrantsForApp('app');
    await mcp.listConnectionsForSession([]);
    await mcp.callConnectionFromSession({ action: 'list' }, []);
    await mcp.getSpeechToTextState();
    await mcp.getTextToSpeechState();
    assert.equal((await mcp.synthesizeTextToSpeech({}, { appId: 'app', caller: 'app-agent' })).success, false);
    assert.equal((await mcp.synthesizeTextToSpeech({}, { appId: 'app', caller: 'desktop-chat' })).success, true);
    assert.equal((await mcp.processSpeechToText({}, { appId: 'app', caller: 'desktop-chat' })).success, true);
    assert.equal((await mcp.synthesizeTextToSpeech({}, { appId: 'noPath', caller: 'desktop-chat' })).success, true);
    assert.equal((await mcp.processSpeechToText({}, { appId: 'noPath', caller: 'app-agent' })).success, true);
    assert.deepEqual(mcp.workflowGetNodeContext('node'), { id: 'node' });
    assert.equal(mcp.workflowCompleteNode('node', {}).failed, undefined);
    assert.equal(mcp.workflowFailNode('node', {}).failed, true);
    assert.equal((await mcp.workflowsList()).length, 1);
    assert.deepEqual(mcp.workflowsGet('workflow'), { id: 'workflow' });
    await mcp.workflowsUpsert({ id: 'workflow' });
    await mcp.workflowsRun('workflow');
    const workflowManager = state.workflowManager;
    state.workflowManager = null;
    assert.equal(mcp.workflowGetNodeContext('node'), null);
    assert.equal(mcp.workflowCompleteNode('node', {}).technicalCode, 'workflow_manager_unavailable');
    assert.equal(mcp.workflowFailNode('node', {}).technicalCode, 'workflow_manager_unavailable');
    assert.deepEqual(mcp.workflowsList(), []);
    assert.equal(mcp.workflowsGet('workflow'), null);
    await assert.rejects(mcp.workflowsUpsert({ id: 'workflow' }), /workflow_manager_unavailable/);
    await assert.rejects(mcp.workflowsRun('workflow'), /workflow_manager_unavailable/);
    state.workflowManager = workflowManager;
    const workflowFeatureController = state.workflowFeatureController;
    state.workflowFeatureController = null;
    assert.equal(mcp.isWorkflowsEnabled(), false);
    state.workflowFeatureController = workflowFeatureController;

    const chat = state.chatOrchestrator.options;
    assert.equal(await chat.resolveChatAppRoot('app', 'normal'), null);
    assert.equal(await chat.resolveChatAppRoot('app', 'social_app_review'), '/review/app');
    assert.equal(await chat.getAntigravityCliPath(), '/bin/antigravity');
    assert.equal(await chat.getAntigravityAuthenticated(), true);
    await chat.resolveAuthProfile({ provider: 'codex' });
    chat.onRunUpdated({ run: { appId: 'forger', runId: 'forger-run', status: 'completed' } });
    chat.onRunUpdated({ run: { appId: 'missing', runId: 'missing-run', status: 'completed' } });
    chat.onRunUpdated({ run: { appId: '', runId: 'global-run', status: 'completed' } });
    deps.appWindows.set('app', { isDestroyed: () => false, webContents: { send: () => undefined } });
    chat.onRunUpdated({ run: { appId: 'app', runId: 'app-run', conversationId: 'conversation', status: 'completed' } });
    deps.appWindows.set('app', { isDestroyed: () => false, webContents: { getURL: () => 'forger-app://app', send: () => undefined } });
    chat.onRunUpdated({ run: { appId: 'app', runId: 'app-run-url', status: 'completed' } });

    for (const manager of [state.appAgentTaskManager, state.appAgentConversationManager]) {
      assert.equal(await manager.options.appAllowsAgentRuntimeControl('app'), false);
      assert.equal(await manager.options.getAntigravityCliPath(), '/bin/antigravity');
      assert.equal(await manager.options.getAntigravityAuthenticated(), true);
      await assert.rejects(manager.options.resolveFolderGrant('app', 'missing'), /folder_grant_not_found/);
      await manager.options.resolveAuthProfile({ provider: 'codex' });
    }
    state.appAgentTaskManager.options.onTaskUpdated({ task: { appId: 'missing', status: 'running' } });
    state.appAgentTaskManager.options.onTaskUpdated({ task: { appId: 'app', status: 'running' } });
    assert.equal(await state.appAgentTaskManager.options.appAllowsAgentRuntimeControl('noPath'), false);
    assert.equal(await state.appAgentConversationManager.options.appAllowsAgentRuntimeControl('noPath'), false);
    state.appAgentConversationManager.options.onConversationEvent({
      type: 'conversation.updated',
      conversation: { appId: 'missing', conversationId: 'thread', title: 'Thread' },
    });
    state.appAgentConversationManager.options.onConversationEvent({
      type: 'conversation.updated',
      conversation: { appId: 'app', conversationId: 'thread-app', title: 'Thread' },
    });
    state.appAgentConversationManager.options.onConversationEvent({
      type: 'conversation.updated',
      conversation: { appId: 'noPath', conversationId: 'thread-no-path', title: 'Thread' },
    });

    const bridge = state.desktopRuntimeBridge.options;
    assert.deepEqual(bridge.getAppContext('missing'), { locale: 'es', rawLocale: null });
    assert.equal((await bridge.getTaskStatus()).antigravity, true);
    deps.runningApps.set('app', { locale: 'en', rawLocale: 'en-US' });
    assert.deepEqual(bridge.getAppContext('app'), { locale: 'en', rawLocale: 'en-US' });
    assert.equal((await bridge.getAppPlatformCapabilities('app')).speechToText, false);
    assert.equal((await bridge.getAppPlatformCapabilities('noPath')).speechToText, false);
    assert.equal(await bridge.requestFolderGrant('app', 'missing'), null);
    await bridge.listFolderGrants('app');
    await bridge.revokeFolderGrant('app', 'grant');
    await bridge.officialTools.listToolsForApp('app');
    await bridge.officialTools.callFromApp('app', {});
    await bridge.connections.listConnectionsForApp('app');
    await bridge.connections.callFromApp('app', {});
    await bridge.connections.configureFromApp('app', {});
    await bridge.updateAudioInputDevices({ inputDevices: [{ id: 'mic', label: 'Mic', kind: 'audioinput', groupId: 'g', default: true, supported: true, requiresDisplayCapture: false }] });
    await bridge.createLiveVoiceSession('app', { deviceId: 'mic', consumerKind: 'dictation', task: 'write', language: 'es' });
    await bridge.stopLiveVoiceSession('app', { consumerId: 'consumer' });
    await bridge.processSpeechToText('app', {});
    await bridge.processSpeechToText('noPath', {});
    await bridge.synthesizeTextToSpeech({ text: 'hola' });

    const automation = state.automationManager.options;
    assert.equal(await automation.getAntigravityCliPath(), '/bin/antigravity');
    assert.equal(await automation.getAntigravityAuthenticated(), true);
    await automation.resolveAuthProfile({ provider: 'codex' });

    const workflow = instances.get('WorkflowManager').options;
    assert.equal(workflow.getInstalledApps().length >= 2, true);
    assert.equal(await workflow.getCodexCliPath(), '/bin/codex');
    assert.equal(await workflow.getClaudeCliPath(), '/bin/claude');
    assert.deepEqual(await workflow.getCodexPathEntries(), ['/runtime/bin']);
    assert.equal(await workflow.getAntigravityCliPath(), '/bin/antigravity');
    assert.equal(await workflow.getCodexAuthenticated(), true);
    assert.equal(await workflow.getAntigravityAuthenticated(), true);
    assert.equal(workflow.createForgerMcpSession('node', ['app'], ['tool.action'], []).length > 0, true);
    workflow.releaseForgerMcpSession('session');
    await workflow.listenAppMcps(['app'], 'listener');
    await workflow.listenRequiredAppMcps(['app'], 'listener');
    workflow.releaseAppMcps('listener');
    assert.equal((await workflow.getPersonalAgent('agent-1')).id, 'agent-1');
    personalAgentStore.requireAgent = async () => { throw new Error('missing'); };
    assert.equal(await workflow.getPersonalAgent('missing'), null);
    await workflow.callForgerToolAction({ id: 'tool.action' });
    await workflow.callConnectionAction({ id: 'connection.action' });
    await workflow.callConnectorAction({ id: 'connector.action' });
    assert.deepEqual([...workflow.getValidToolIds()], ['tool.action']);
    workflow.onAgentRunActivity({ sourceRef: { appId: 'app' } });
    workflow.onAgentRunActivity({ sourceRef: {} });
    workflow.onAgentRunActivity('plain');
    workflow.onWorkflowUpdated({ workflow: { id: 'workflow' } });

    const memory = state.memoryMaintenanceManager.options;
    assert.equal(await memory.getCodexAuthenticated(), true);
    assert.equal(await memory.getCodexCliPath(), '/bin/codex');
    assert.deepEqual(await memory.getCodexPathEntries(), ['/runtime/bin']);
    assert.equal(memory.createForgerMcpSession('memory'), 'session-b13');
    memory.releaseForgerMcpSession('session');
    await memory.buildMemoryContext();
    await memory.resolveAuthProfile({ provider: 'codex' });
    const forgerMcpServer = state.forgerMcpServer;
    const appMcpManager = state.appMcpManager;
    state.forgerMcpServer = null;
    state.appMcpManager = null;
    assert.equal(workflow.createForgerMcpSession('node', ['app'], [], []), null);
    assert.deepEqual(await workflow.listenAppMcps(['app'], 'missing'), []);
    assert.equal((await workflow.listenRequiredAppMcps(['app'], 'missing')).failures.length, 1);
    assert.equal(memory.createForgerMcpSession('memory-missing'), null);
    state.forgerMcpServer = forgerMcpServer;
    state.appMcpManager = appMcpManager;

    assert.equal(calls.some(([kind]) => kind === 'external'), true);
    assert.equal(routineManager.name, 'PersonalAgentRoutineManager');
  } finally {
    await harness.cleanup();
  }
});

test('given optional startup and service failures, lifecycle logs errors and preserves recoverable APIs', async () => {
  let validationError = 'invalid secrets';
  let vaultUnavailable = true;
  const failingStart = () => ({
    startIfConfigured: async () => { throw new Error('start failed'); },
    getState: async () => ({ status: 'error' }),
    process: async () => ({}),
    synthesize: async () => ({}),
  });
  const harness = await createLifecycleHarness({
    SecretsStore: class SecretsStoreWithLegacyTools {
      async deleteToolSecrets() { return { success: true }; }
    },
    CloudIdentityStore: class FailingCloudIdentityStore {
      async getSummary() { throw new Error('identity failed'); }
      getPublicRegistration() { return {}; }
    },
    cleanupLegacyExternalToolState: async () => { throw new Error('legacy cleanup failed'); },
    getOfficialToolsService: () => ({
      load: async () => undefined,
      startActiveTools: async () => { throw new Error('tool start failed'); },
    }),
    getConnectionsService: () => ({ load: async () => undefined }),
    getSelfOAuthCallbackService: () => ({ start: async () => { throw new Error('oauth failed'); } }),
    startSidekickIfPaired: async () => { throw new Error('sidekick failed'); },
    getSpeechToTextService: failingStart,
    getTextToSpeechService: failingStart,
    getWakeWordService: failingStart,
    getPersonalAgentRoutineManager: undefined,
    getManifestAppSecretsValidationError: () => validationError,
    getSecretsStore: () => ({ resolveAppEnv: async () => { throw new Error('secrets failed'); } }),
    isSecretsVaultUnavailableError: () => vaultUnavailable,
    resolveInstalledManifest: async () => ({
      platformCapabilities: {
        speechToText: true,
        textToSpeech: true,
        audioInput: true,
        workspaceFolders: true,
        agentRuntimeControl: true,
        sidekickDisplay: true,
        sidekickSpeech: true,
      },
    }),
    resolveAppFolderGrant: () => ({ path: os.tmpdir(), expiresAt: '2026-08-10T12:00:00.000Z' }),
    getSocialAppReviewPromptContext: async () => ({ appRoot: 42 }),
    resolveAntigravityCliPath: undefined,
    getAntigravityAuthStatus: async () => { throw new Error('antigravity status failed'); },
    stopLocalNetworkShare: async () => { throw new Error('local stop failed'); },
    stopRemoteNetworkShare: async () => { throw new Error('remote stop failed'); },
    stopRemoteAgentSessionSession: async () => { throw new Error('agent stop failed'); },
  }, { withoutLocale: true });
  const { calls, instances, state } = harness;
  try {
    const loggedEvents = calls.filter(([kind]) => kind === 'log').map(([, event]) => event);
    for (const event of [
      'legacy_external_tools_cleanup:failed',
      'self_oauth_callback:start_failed',
      'sidekick:start_if_paired_failed',
      'official_tools:start_active_failed',
      'speech_to_text:start_configured_failed',
      'text_to_speech:start_configured_failed',
      'wake_word:start_configured_failed',
    ]) assert.equal(loggedEvents.includes(event), true, event);

    const cloud = state.cloudDeviceManager.options;
    assert.equal((await cloud.handleAppControlRequest({ appId: 'app', requestId: 'stop-errors', action: 'stop_app' })).success, true);
    await cloud.handleFriendshipEvent({ type: 'remote_agent_session_close', sessionId: 'session-error' });
    assert.equal(calls.some(([, event]) => event === 'agent_access:cloud_disconnect_failed'), true);

    const mcp = state.forgerMcpServer.options;
    await assert.rejects(mcp.schedulePersonalAgentWakeup({ agentId: 'agent-1' }), /personal_agent_routines_unavailable/);
    state.registry.apps.app = { appId: 'app', name: 'App', installDir: '/apps/app' };
    assert.equal((await mcp.synthesizeTextToSpeech({}, { appId: 'app', caller: 'app-agent' })).success, undefined);
    assert.equal((await mcp.processSpeechToText({}, { appId: 'app', caller: 'app-agent' })).success, undefined);

    const appMcp = state.appMcpManager.options;
    await assert.rejects(appMcp.resolveAppSecretsEnvironment('app', {}), /invalid_app_secrets_manifest/);
    validationError = null;
    await assert.rejects(appMcp.resolveAppSecretsEnvironment('app', {}), /secrets_vault_unavailable/);
    vaultUnavailable = false;
    await assert.rejects(appMcp.resolveAppSecretsEnvironment('app', {}), /secrets failed/);

    assert.equal(await state.chatOrchestrator.options.resolveChatAppRoot('app', 'social_app_review'), null);
    assert.equal(await state.chatOrchestrator.options.getAntigravityCliPath(), null);
    assert.equal(await state.appAgentTaskManager.options.getAntigravityCliPath(), null);
    assert.equal(await state.appAgentConversationManager.options.getAntigravityCliPath(), null);
    assert.equal(await state.automationManager.options.getAntigravityCliPath(), null);
    const workflow = instances.get('WorkflowManager').options;
    assert.equal(await workflow.getAntigravityCliPath(), null);

    assert.equal(await state.appAgentTaskManager.options.appAllowsAgentRuntimeControl('app'), true);
    assert.equal(await state.appAgentConversationManager.options.appAllowsAgentRuntimeControl('app'), true);
    const capabilities = await state.desktopRuntimeBridge.options.getAppPlatformCapabilities('app');
    assert.equal(Object.values(capabilities).every(Boolean), true);
    assert.equal((await state.desktopRuntimeBridge.options.processSpeechToText('app', {})).success, undefined);
    const grant = await state.desktopRuntimeBridge.options.requestFolderGrant('app', 'grant-token');
    assert.equal(grant.realPath, await fs.realpath(os.tmpdir()));
    assert.deepEqual(await state.desktopRuntimeBridge.options.getTaskStatus(), {
      connected: true,
      codex: true,
      claude: true,
      antigravity: false,
    });
  } finally {
    await harness.cleanup();
  }
});

test('given optional providers and bridge services are absent, lifecycle exposes explicit fallback values', async () => {
  const harness = await createLifecycleHarness({
    getAntigravityAuthStatus: undefined,
    resolveAntigravityCliPath: undefined,
    getOfficialToolsService: () => null,
    getConnectionsService: () => null,
    getPersonalAgentRoutineManager: undefined,
    resolveClaudeCli: async () => null,
  });
  const { instances, state } = harness;
  try {
    assert.equal(state.desktopRuntimeBridge.options.officialTools, undefined);
    assert.equal(state.desktopRuntimeBridge.options.connections, undefined);
    assert.deepEqual(await state.desktopRuntimeBridge.options.getTaskStatus(), {
      connected: true,
      codex: true,
      claude: true,
    });
    for (const manager of [state.chatOrchestrator, state.appAgentTaskManager, state.appAgentConversationManager, state.automationManager]) {
      assert.equal(await manager.options.getAntigravityAuthenticated(), false);
      assert.equal(await manager.options.getAntigravityCliPath(), null);
    }
    const workflow = instances.get('WorkflowManager').options;
    assert.equal(await workflow.getClaudeCliPath(), null);
    assert.equal(await workflow.getAntigravityAuthenticated(), false);
    assert.equal(await workflow.getAntigravityCliPath(), null);
  } finally {
    await harness.cleanup();
  }
});

test('given a development startup failure, lifecycle surfaces the failure to diagnostics', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalConsoleError = console.error;
  const errors = [];
  process.env.NODE_ENV = 'development';
  console.error = (...args) => errors.push(args);
  const harness = await createLifecycleHarness({
    createWindow: async () => {
      throw new Error('window failed');
    },
  }, { waitFor: () => errors.length === 1 });
  try {
    await waitForMainLifecycle(() => errors.length === 1);
    assert.match(errors[0][1].message, /window failed/);
  } finally {
    console.error = originalConsoleError;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await harness?.cleanup();
  }
});
