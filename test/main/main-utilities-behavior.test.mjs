import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { buildFailureDiagnostic } = require('../../dist-electron/shared/error-diagnostics.js');
const { AGENT_TOOL_DEFINITIONS, AGENT_TOOL_IDS } = require('../../dist-electron/main/core/agent-tool-packages.js');
const { createMainUtilitiesController, __testMainUtilitiesInternals } = require('../../dist-electron/main/core/main-utilities.js');

const installProgressByPhase = {
  downloading: 20,
  extracting: 40,
  preparing: 60,
  installing: 80,
  completed: 100,
  failed: 100,
};

const createController = (overrides = {}) => {
  const state = {
    agentToolSettings: { approvals: {} },
    catalogApps: [],
    desktopUpdater: null,
    forgerAccount: { authenticated: false },
    settings: {},
  };
  const appWindows = new Map();
  const friendChatWindows = new Map();
  const sent = [];
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (...args) => sent.push(args),
    },
  };
  const deps = {
    AGENT_TOOL_DEFINITIONS,
    AGENT_TOOL_IDS,
    APP_FOLDER_GRANT_TTL_MS: 60_000,
    Buffer,
    Date,
    DesktopUpdater: class DesktopUpdater {
      constructor(options) {
        this.options = options;
      }
    },
    IPC_CHANNELS,
    app: {
      getAppPath: () => '/app',
      getPath: (name) => `/user/${name}`,
      getVersion: () => '0.0.0-test',
      isPackaged: false,
    },
    appFolderGrantSecret: 'test-secret',
    appWindows,
    buildFailureDiagnostic: ({ error, fallbackCode }) => ({
      technicalCode: error instanceof Error ? error.message : fallbackCode,
    }),
    cloudDeviceManager: null,
    createHmac,
    desktopErrorReporter: null,
    forgerAccountStore: null,
    friendChatWindows,
    fs,
    getAgentToolSettingsPath: () => '/tmp/forger-agent-tools.json',
    getForgerMetadataRoot: () => '/tmp/forger-metadata',
    getInstallLogPath: () => path.join(tmpdir(), 'forger-main-utilities-test-logs', 'install.log'),
    getMainWindow: () => mainWindow,
    installProgressByPhase,
    isDev: true,
    path,
    publicForgerAccount: (account) => ({ authenticated: Boolean(account.authenticated) }),
    registry: { apps: {} },
    runningApps: new Map(),
    state,
    ...overrides,
  };
  return {
    appWindows,
    controller: createMainUtilitiesController(deps),
    deps,
    friendChatWindows,
    sent,
    state,
  };
};

test('main utility tool settings load, normalize, reject unknown tools, and persist known approvals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-tool-settings-'));
  const settingsPath = path.join(root, 'agent-tools.json');
  try {
    await writeFile(settingsPath, JSON.stringify({
      approvals: {
        forger_open_app: false,
        'gmail.search_messages': true,
        'not_a_connection.search_messages': true,
        unknown_tool: true,
      },
    }), 'utf8');

    const { controller, state } = createController({
      getAgentToolSettingsPath: () => settingsPath,
    });

    await controller.loadAgentToolSettings();
    assert.equal(typeof state.agentToolSettings.approvals.forger_open_app, 'boolean');
    assert.equal(state.agentToolSettings.approvals.forger_list_catalog, false);
    assert.equal(state.agentToolSettings.approvals['gmail.search_messages'], true);
    assert.equal(state.agentToolSettings.approvals['not_a_connection.search_messages'], undefined);
    assert.equal(state.agentToolSettings.approvals.unknown_tool, undefined);
    assert.equal(controller.isAgentToolId('forger_open_app'), true);
    assert.equal(controller.isAgentToolId('gmail.search_messages'), false);
    assert.equal(controller.isAgentToolId('unknown_tool'), false);

    await assert.rejects(
      controller.updateAgentToolApproval({ toolId: 'unknown_tool', requiresApproval: true }),
      /invalid_agent_tool_id/,
    );

    await controller.updateAgentToolApproval({ toolId: 'forger_open_app', requiresApproval: true });
    await controller.updateAgentToolApproval({ toolId: 'gmail.search_messages', requiresApproval: false });
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(saved.approvals.forger_open_app, true);
    assert.equal(saved.approvals['gmail.search_messages'], false);
    assert.equal(saved.approvals['not_a_connection.search_messages'], undefined);
    assert.equal(saved.approvals.unknown_tool, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main utility emits are no-ops for missing windows and send stable public payloads when available', () => {
  const destroyed = createController({
    getMainWindow: () => null,
  });
  assert.doesNotThrow(() => destroyed.controller.emitInstallProgress('finance-os', { success: true, phase: 'completed' }));
  assert.doesNotThrow(() => destroyed.controller.emitRuntimeStatus({ appId: 'finance-os', status: 'stopped' }));
  assert.doesNotThrow(() => destroyed.controller.emitChatRunUpdated({
    run: { runId: 'run-1', appId: 'finance-os', status: 'running' },
  }));
  assert.doesNotThrow(() => destroyed.controller.emitAutomationUpdated({ automation: { id: 'auto-1' } }));
  assert.doesNotThrow(() => destroyed.controller.emitDesktopUpdateProgress({ status: 'idle' }));
  assert.doesNotThrow(() => destroyed.controller.emitForgerAccountUpdated({ authenticated: false }));

  const destroyedWindow = createController({
    getMainWindow: () => ({ isDestroyed: () => true, webContents: { send: () => assert.fail('should not send') } }),
  });
  assert.doesNotThrow(() => destroyedWindow.controller.emitRuntimeStatus({ appId: 'finance-os', status: 'stopped' }));
  assert.doesNotThrow(() => destroyedWindow.controller.emitForgerAccountUpdated({ authenticated: false }));

  const { controller, sent } = createController();
  controller.emitInstallProgress('finance-os', { success: true, phase: 'completed' });
  controller.emitRuntimeStatus({ appId: 'finance-os', status: 'running' });
  controller.emitChatRunUpdated({
    run: { runId: 'run-1', appId: 'finance-os', conversationId: 'conversation-1', status: 'running', progressLog: ['one'] },
  });
  controller.emitAutomationUpdated({ automation: { id: 'auto-1' } });
  controller.emitDesktopUpdateProgress({ status: 'available' });
  controller.emitForgerAccountUpdated({ authenticated: true, userMessage: 'ok' });

  assert.deepEqual(sent, [
    [IPC_CHANNELS.installProgress, { appId: 'finance-os', progress: { success: true, phase: 'completed' } }],
    [IPC_CHANNELS.runtimeStatusChanged, { appId: 'finance-os', status: 'running' }],
    [IPC_CHANNELS.chatRunUpdated, {
      run: { runId: 'run-1', appId: 'finance-os', conversationId: 'conversation-1', status: 'running', progressLog: ['one'] },
    }],
    [IPC_CHANNELS.automationUpdated, { automation: { id: 'auto-1' } }],
    [IPC_CHANNELS.desktopUpdateProgress, { status: 'available' }],
    [IPC_CHANNELS.forgerAccountUpdated, { authenticated: true, userMessage: 'ok' }],
  ]);
});

test('main utility chat emit logs send failures without throwing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-chat-emit-log-'));
  const logPath = path.join(root, 'install.jsonl');
  try {
    const { controller } = createController({
      getInstallLogPath: () => logPath,
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          send: () => {
            throw new TypeError('renderer gone');
          },
        },
      }),
    });

    assert.doesNotThrow(() => controller.emitChatRunUpdated({
      run: {
        runId: 'run-1',
        appId: 'finance-os',
        conversationId: 'conversation-1',
        status: 'failed',
        userMessage: 'nope',
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 25));
    const entries = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.at(-1).event, 'chat_run_update_send_failed');
    assert.equal(entries.at(-1).errorMessage, 'renderer gone');
    assert.equal(entries.at(-1).hasUserMessage, true);

    const stringErrorController = createController({
      getInstallLogPath: () => logPath,
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          send: () => {
            throw 'renderer string failure';
          },
        },
      }),
    }).controller;
    assert.doesNotThrow(() => stringErrorController.emitChatRunUpdated({
      run: {
        runId: 'run-2',
        appId: 'finance-os',
        status: 'failed',
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const updatedEntries = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(updatedEntries.at(-1).errorName, 'string');
    assert.equal(updatedEntries.at(-1).errorMessage, 'renderer string failure');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main utility redacts embedded secrets from both install and desktop logs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-install-log-redaction-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const installLogDir = path.join(root, 'legacy-logs');
  const installLogPath = path.join(installLogDir, 'install.log');
  const metadataRoot = path.join(root, 'metadata');
  await fs.mkdir(installLogDir, { recursive: true, mode: 0o777 });
  await fs.writeFile(installLogPath, '', { mode: 0o666 });
  await fs.chmod(installLogDir, 0o777);
  await fs.chmod(installLogPath, 0o666);
  const { controller } = createController({
    getForgerMetadataRoot: () => metadataRoot,
    getInstallLogPath: () => installLogPath,
  });

  await controller.appendInstallLog('install_failed Bearer event-secret', {
    appId: 'finance-os',
    note: 'upload failed with Bearer bearer-secret but retry is possible',
    requestUrl: 'https://example.com/callback?access_token=query-secret&mode=safe',
    config: 'api_key=key-value-secret status=useful',
    responseDetails: 'Cookie: session=cookie-secret; theme=dark',
    runtimeFailure: new Error('runtime failed: password=error-secret; app remains stopped'),
  });

  const installEntry = JSON.parse((await readFile(installLogPath, 'utf8')).trim());
  const desktopEntry = JSON.parse((await readFile(
    path.join(metadataRoot, 'logs', 'forger-desktop.jsonl'),
    'utf8',
  )).trim());
  const installSerialized = JSON.stringify(installEntry);
  const desktopSerialized = JSON.stringify(desktopEntry);
  for (const secret of [
    'event-secret',
    'bearer-secret',
    'query-secret',
    'key-value-secret',
    'cookie-secret',
    'error-secret',
  ]) {
    assert.equal(installSerialized.includes(secret), false, `install.log leaked ${secret}`);
    assert.equal(desktopSerialized.includes(secret), false, `desktop log leaked ${secret}`);
  }

  assert.equal(installEntry.event, 'install_failed Bearer [REDACTED]');
  assert.equal(installEntry.appId, 'finance-os');
  assert.equal(installEntry.note, 'upload failed with Bearer [REDACTED] but retry is possible');
  assert.equal(installEntry.requestUrl, 'https://example.com/callback?access_token=[REDACTED]&mode=safe');
  assert.equal(installEntry.config, 'api_key=[REDACTED] status=useful');
  assert.equal(installEntry.responseDetails, 'Cookie: [REDACTED]');
  assert.match(installEntry.runtimeFailure.message, /runtime failed: password=\[REDACTED\]; app remains stopped/);
  assert.equal(desktopEntry.event, installEntry.event);
  assert.equal(desktopEntry.context.appId, installEntry.appId);
  assert.equal(desktopEntry.context.note, installEntry.note);
  assert.equal(desktopEntry.context.requestUrl, installEntry.requestUrl);
  assert.equal(desktopEntry.context.config, installEntry.config);
  assert.equal(desktopEntry.context.responseDetails, installEntry.responseDetails);
  assert.equal(desktopEntry.context.runtimeFailure.message, installEntry.runtimeFailure.message);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(installLogDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(installLogPath)).mode & 0o777, 0o600);
  }
});

test('main utility removes escaped-quote secrets from install and desktop logs without dropping safe prose', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-install-log-escaped-secret-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const installLogPath = path.join(root, 'legacy-logs', 'install.log');
  const metadataRoot = path.join(root, 'metadata');
  const { controller } = createController({
    getForgerMetadataRoot: () => metadataRoot,
    getInstallLogPath: () => installLogPath,
  });
  const adversarial = String.raw`before {\"token\":\"abc\\\"LEAK-INSTALL\"} after`;

  await controller.appendInstallLog(adversarial, {
    nested: { message: adversarial },
    runtimeFailure: new Error(adversarial),
  });

  const installEntry = JSON.parse((await readFile(installLogPath, 'utf8')).trim());
  const desktopEntry = JSON.parse((await readFile(
    path.join(metadataRoot, 'logs', 'forger-desktop.jsonl'),
    'utf8',
  )).trim());
  const expected = String.raw`before {\"token\":\"[REDACTED]\"} after`;
  for (const entry of [installEntry, desktopEntry]) {
    assert.equal(JSON.stringify(entry).includes('LEAK-INSTALL'), false);
    assert.equal(entry.event, expected);
    const payload = entry.context ?? entry;
    assert.equal(payload.nested.message, expected);
    assert.equal(payload.runtimeFailure.message, expected);
  }
});

test('main utility applies semantic compound-key redaction consistently to both log sinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-install-log-compound-secret-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const installLogPath = path.join(root, 'legacy-logs', 'install.log');
  const metadataRoot = path.join(root, 'metadata');
  const { controller } = createController({
    getForgerMetadataRoot: () => metadataRoot,
    getInstallLogPath: () => installLogPath,
  });
  const detail = String.raw`safe author=Ada githubToken=LEAK-COMPOUND escaped={\"stripeSecretKey\":\"LEAK-ESCAPED-COMPOUND\",\"authorizationStatus\":\"connected\"} done`;

  await controller.appendInstallLog('compound_secret_check', {
    detail,
    author: 'Ada',
    authority: 'local',
    authorizationStatus: 'connected',
    sessionToken: 'LEAK-STRUCTURED-COMPOUND',
  });

  const entries = [
    JSON.parse((await readFile(installLogPath, 'utf8')).trim()),
    JSON.parse((await readFile(path.join(metadataRoot, 'logs', 'forger-desktop.jsonl'), 'utf8')).trim()),
  ];
  for (const entry of entries) {
    assert.equal(JSON.stringify(entry).includes('LEAK'), false);
    const payload = entry.context ?? entry;
    assert.equal(payload.author, 'Ada');
    assert.equal(payload.authority, 'local');
    assert.equal(payload.authorizationStatus, 'connected');
    assert.equal(payload.sessionToken, '[REDACTED]');
    assert.equal(
      payload.detail,
      String.raw`safe author=Ada githubToken=[REDACTED] escaped={\"stripeSecretKey\":\"[REDACTED]\",\"authorizationStatus\":\"connected\"} done`,
    );
  }
});

test('main utility install log and account helpers tolerate no-op failure paths', async () => {
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  try {
    const { controller, state } = createController({
      fs: {
        ...fs,
        mkdir: async () => undefined,
        chmod: async () => undefined,
        appendFile: async () => {
          throw new Error('disk_full');
        },
      },
    });

    await controller.appendInstallLog('install:ignored');
    await controller.loadAgentToolSettings();
    await controller.clearForgerAccountSession('already_clear');

    assert.equal(warns.length, 1);
    assert.match(warns[0][0], /Failed to write Forger install log/);
    assert.equal(state.forgerAccount.authenticated, false);
    assert.equal(typeof state.agentToolSettings.approvals.forger_open_app, 'boolean');
  } finally {
    console.warn = originalWarn;
  }
});

test('main utility forwards safe process diagnostics to the configured reporter', () => {
  const reports = [];
  __testMainUtilitiesInternals.resetProcessErrorHandlersForTests();
  const beforeUncaught = new Set(process.listeners('uncaughtException'));
  const beforeUnhandled = new Set(process.listeners('unhandledRejection'));
  createController({
    desktopErrorReporter: {
      reportMainUncaughtException: (error) => reports.push(['uncaught', error.message]),
      reportMainUnhandledRejection: (reason) => reports.push(['rejection', reason]),
    },
  });
  createController({
    desktopErrorReporter: {
      reportMainUncaughtException: (error) => reports.push(['second-uncaught', error.message]),
      reportMainUnhandledRejection: (reason) => reports.push(['second-rejection', reason]),
    },
  });
  const newUncaught = process.listeners('uncaughtException').filter((listener) => !beforeUncaught.has(listener));
  const newUnhandled = process.listeners('unhandledRejection').filter((listener) => !beforeUnhandled.has(listener));
  try {
    assert.equal(newUncaught.length, 1);
    assert.equal(newUnhandled.length, 1);
    __testMainUtilitiesInternals.handleMainUncaughtException(new Error('main crashed'));
    __testMainUtilitiesInternals.handleMainUnhandledRejection('promise failed');
    assert.deepEqual(reports, [
      ['second-uncaught', 'main crashed'],
      ['second-rejection', 'promise failed'],
    ]);
  } finally {
    __testMainUtilitiesInternals.resetProcessErrorHandlersForTests();
  }
});

test('main utility signs folder grants and resolves app ids from live app windows only', () => {
  const { appWindows, controller } = createController();
  appWindows.set('finance-os', {
    isDestroyed: () => false,
    webContents: { id: 7 },
  });
  appWindows.set('recipes', {
    isDestroyed: () => true,
    webContents: { id: 8 },
  });

  assert.equal(controller.resolveAppIdForWebContents(7), 'finance-os');
  assert.equal(controller.resolveAppIdForWebContents(8), null);

  const grant = controller.signAppFolderGrant('finance-os', '/shared/folder');
  assert.equal(grant.canceled, false);
  assert.equal(grant.path, '/shared/folder');
  assert.match(grant.grantToken, /^[^.]+\.[^.]+$/);
  const [payload] = grant.grantToken.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), {
    appId: 'finance-os',
    path: '/shared/folder',
    exp: Math.floor(new Date(grant.expiresAt).getTime() / 1000),
  });
  assert.deepEqual(controller.verifyAppFolderGrant('finance-os', grant.grantToken), {
    path: '/shared/folder',
    expiresAt: new Date(Math.floor(new Date(grant.expiresAt).getTime() / 1000) * 1000).toISOString(),
  });
  assert.equal(controller.verifyAppFolderGrant('recipes', grant.grantToken), null);
  assert.equal(controller.verifyAppFolderGrant('finance-os', `${payload}.bad-signature`), null);
});

test('main utility summarizes updates and closes friend chat windows without touching destroyed windows', () => {
  const closed = [];
  const { controller, friendChatWindows, state } = createController({
    runningApps: new Map([
      ['finance-os', { frontendUrl: 'http://127.0.0.1:1' }],
      ['notes', { frontendUrl: 'http://127.0.0.1:2' }],
    ]),
  });
  state.catalogApps = [
    { id: 'finance-os', name: 'Finance OS', description: 'Money', category: 'finance', latestVersion: '0.2.0' },
    { id: 'recipes', name: 'Recipes', description: 'Food', category: 'home', latestVersion: '0.1.0' },
  ];

    assert.equal(controller.isVersionNewer('0.2.0', '0.1.9'), true);
  assert.equal(controller.isVersionNewer('0.1.0', '0.2.0'), false);
  assert.equal(controller.isVersionNewer('1.0.0', '1.0.0'), false);
  assert.equal(controller.isVersionNewer('1.0.1', '1.0'), true);
  assert.equal(controller.isVersionNewer('1.0', '1.0.1'), false);
  assert.equal(controller.isVersionNewer(undefined, '1.0.0'), false);
  assert.equal(controller.isVersionNewer('1.0.0', undefined), false);
  assert.equal(controller.isVersionNewer('v1.0.0', '1.0.0'), true);
  assert.equal(controller.isVersionNewer('1.0.0-beta.2', '1.0.0-beta.1'), true);
  assert.equal(controller.isVersionNewer('beta-b', 'beta-a'), true);
  assert.equal(controller.isVersionNewer('beta-a', 'beta-a'), false);
  assert.deepEqual(controller.parseVersionParts(' v2.10.3-beta '), [2, 10, 3]);
  assert.equal(controller.parseVersionParts('beta'), null);
  assert.deepEqual(controller.toAppSummary({
    appId: 'finance-os',
    name: 'Old Finance',
    description: 'Old',
    category: 'productivity',
    status: 'installed',
    userMessage: 'Ready',
    version: '0.1.9',
  }), {
    id: 'finance-os',
    name: 'Finance OS',
    description: 'Money',
    longDescription: 'Money',
    category: 'finance',
    version: '0.1.9',
    latestVersion: '0.2.0',
    updateAvailable: true,
    status: 'running',
    userMessage: 'En ejecucion',
    changelog: undefined,
    iconUrl: undefined,
    beta: undefined,
    privateLocal: undefined,
    socialSource: undefined,
    publishedSocialSource: undefined,
    localNetworkShareSupported: undefined,
    remoteTunnelSupported: undefined,
    lastErrorOperation: undefined,
    executionPhase: 'running',
    executionMode: 'forger',
    connectMode: null,
  });
  assert.deepEqual(controller.toAppSummary({
    appId: 'recipes',
    name: 'Recipes Local',
    description: 'Local recipes',
    category: 'home',
    status: 'installed',
    userMessage: 'Ready',
    version: '0.1.0',
  }), {
    id: 'recipes',
    name: 'Recipes',
    description: 'Food',
    longDescription: 'Food',
    category: 'home',
    version: '0.1.0',
    latestVersion: '0.1.0',
    updateAvailable: false,
    status: 'installed',
    userMessage: 'Ready',
    changelog: undefined,
    iconUrl: undefined,
    beta: undefined,
    privateLocal: undefined,
    socialSource: undefined,
    publishedSocialSource: undefined,
    localNetworkShareSupported: undefined,
    remoteTunnelSupported: undefined,
    lastErrorOperation: undefined,
    executionPhase: 'stopped',
    executionMode: null,
    connectMode: null,
  });
  assert.deepEqual(controller.toAppSummary({
    appId: 'journal',
    name: 'Journal',
    description: 'Daily notes',
    category: 'productivity',
    status: 'installed',
    userMessage: 'Ready',
    version: '0.1.0',
  }), {
    id: 'journal',
    name: 'Journal',
    description: 'Daily notes',
    longDescription: 'Daily notes',
    category: 'productivity',
    version: '0.1.0',
    latestVersion: undefined,
    updateAvailable: false,
    status: 'installed',
    userMessage: 'Ready',
    changelog: undefined,
    iconUrl: undefined,
    beta: undefined,
    privateLocal: undefined,
    socialSource: undefined,
    publishedSocialSource: undefined,
    localNetworkShareSupported: undefined,
    remoteTunnelSupported: undefined,
    lastErrorOperation: undefined,
    executionPhase: 'stopped',
    executionMode: null,
    connectMode: null,
  });
  assert.deepEqual(controller.toAppSummary({
    appId: 'notes',
    name: 'Local Notes',
    description: 'Private notes',
    category: 'productivity',
    status: 'installed',
    userMessage: 'Ready',
    version: '0.1.0',
  }), {
    id: 'notes',
    name: 'Local Notes',
    description: 'Private notes',
    longDescription: 'Private notes',
    category: 'productivity',
    version: '0.1.0',
    latestVersion: undefined,
    updateAvailable: false,
    status: 'running',
    userMessage: 'En ejecucion',
    changelog: undefined,
    iconUrl: undefined,
    beta: undefined,
    privateLocal: undefined,
    socialSource: undefined,
    publishedSocialSource: undefined,
    localNetworkShareSupported: undefined,
    remoteTunnelSupported: undefined,
    lastErrorOperation: undefined,
    executionPhase: 'running',
    executionMode: 'forger',
    connectMode: null,
  });

  friendChatWindows.set(1, { isDestroyed: () => false, close: () => closed.push(1) });
  friendChatWindows.set(2, { isDestroyed: () => true, close: () => closed.push(2) });
  controller.closeFriendChatWindows();
  assert.deepEqual(closed, [1]);
  assert.equal(friendChatWindows.size, 0);
});

test('main utility enriches app summaries with shared execution state for share modes', () => {
  const { controller } = createController({
    getLocalNetworkShareStatus: (appId) => appId === 'finance-os'
      ? { active: true, appId, url: 'http://192.168.1.20:5173' }
      : undefined,
    getRemoteNetworkShareStatus: (appId) => appId === 'recipes'
      ? { active: true, appId, state: 'waiting_for_session', portalUrl: 'https://cloud.test/portal' }
      : undefined,
  });

  assert.equal(controller.toAppSummary({
    appId: 'finance-os',
    name: 'Finance OS',
    description: 'Money',
    category: 'finance',
    status: 'installed',
    version: '1.0.0',
  }).executionMode, 'local_network');
  assert.equal(controller.toAppSummary({
    appId: 'finance-os',
    name: 'Finance OS',
    description: 'Money',
    category: 'finance',
    status: 'installed',
    version: '1.0.0',
  }).connectMode, 'local_network');

  const remote = controller.toAppSummary({
    appId: 'recipes',
    name: 'Recipes',
    description: 'Food',
    category: 'home',
    status: 'installed',
    version: '1.0.0',
  });
  assert.equal(remote.executionPhase, 'running');
  assert.equal(remote.executionMode, 'remote_tunnel');
  assert.equal(remote.connectMode, 'remote_tunnel');
});

test('main utility logs install diagnostics and serializes command failures with truncation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-install-log-'));
  const logPath = path.join(root, 'install.jsonl');
  try {
    const { controller } = createController({
      getInstallLogPath: () => logPath,
      app: {
        getAppPath: () => '/dev-app',
        getPath: (name) => `/user/${name}`,
        getVersion: () => '0.0.0-test',
        isPackaged: true,
      },
      isDev: false,
    });
    const longStdout = 'x'.repeat(60_005);
    const commandError = new controller.CommandFailedError('git', ['status'], '/repo', 1, null, longStdout, 'bad');

    await controller.appendInstallLog('install:test', {
      appId: 'demo-app',
      token: 'super-secret-token',
      details: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    });
    const serialized = controller.serializeErrorForInstallLog(commandError);
    const plain = controller.serializeErrorForInstallLog('plain failure');
    const entry = JSON.parse(await readFile(logPath, 'utf8'));

    assert.equal(entry.event, 'install:test');
    assert.equal(entry.appId, 'demo-app');
    assert.equal(entry.token, '[REDACTED]');
    assert.doesNotMatch(entry.details, /abcdefghijklmnopqrstuvwxyz/);
    assert.equal(entry.packaged, true);
    assert.equal(entry.dev, false);
    assert.equal(serialized.command, 'git');
    assert.equal(serialized.exitCode, 1);
    assert.match(serialized.stdout, /\.\.\.\[truncated 5 chars\]$/);
    assert.deepEqual(plain, { message: 'plain failure' });
    assert.equal(controller.truncateForInstallLog('short'), 'short');
    if (process.platform !== 'win32') {
      assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main utility discovers runtime archives and checksum files by platform token and fallback rules', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-runtimes-'));
  try {
    const { controller } = createController({
      app: {
        getAppPath: () => root,
        getPath: (name) => `/user/${name}`,
        getVersion: () => '0.0.0-test',
        isPackaged: false,
      },
    });
    const runtimeRoot = path.join(root, 'resources', 'runtimes');
    await fs.mkdir(runtimeRoot, { recursive: true });
    await writeFile(path.join(runtimeRoot, 'node-darwin-arm64.tar.gz'), 'archive', 'utf8');
    await writeFile(path.join(runtimeRoot, 'node-darwin-arm64.sha256'), 'sum', 'utf8');
    const pythonRoot = path.join(root, 'python-runtimes');
    await fs.mkdir(pythonRoot, { recursive: true });
    const pythonArchives = {
      darwin_arm64: 'cpython-3.12.13+20260414-aarch64-apple-darwin-install_only_stripped.tar.gz',
      darwin_x64: 'cpython-3.12.13+20260414-x86_64-apple-darwin-install_only_stripped.tar.gz',
      linux_x64: 'cpython-3.12.13+20260414-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',
      win32_x64: 'cpython-3.12.13+20260414-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
    };
    for (const archiveName of Object.values(pythonArchives)) {
      await writeFile(path.join(pythonRoot, archiveName), 'archive', 'utf8');
    }
    await writeFile(path.join(pythonRoot, `${pythonArchives.linux_x64}.sha256`), 'sum', 'utf8');
    const gitRoot = path.join(root, 'git-runtimes');
    await fs.mkdir(gitRoot, { recursive: true });
    await writeFile(path.join(gitRoot, 'git-2.54.0-aarch64-apple-darwin.tar.gz'), 'archive', 'utf8');
    await writeFile(path.join(gitRoot, 'MinGit-2.54.0-64-bit.zip'), 'archive', 'utf8');
    const zipRoot = path.join(root, 'zip-runtimes');
    await fs.mkdir(zipRoot, { recursive: true });
    await writeFile(path.join(zipRoot, 'node-linux_x64.zip'), 'archive', 'utf8');
    await writeFile(path.join(zipRoot, 'node-linux_x64.zip.sha256'), 'sum', 'utf8');
    const windowsRoot = path.join(root, 'windows-runtimes');
    await fs.mkdir(windowsRoot, { recursive: true });
    await writeFile(path.join(windowsRoot, 'node-v22.22.2-darwin-x64.tar.gz'), 'archive', 'utf8');
    await writeFile(path.join(windowsRoot, 'node-x86_64-pc-windows-msvc.zip'), 'archive', 'utf8');
    await writeFile(path.join(windowsRoot, 'node-x86_64-pc-windows-msvc.zip.sha256'), 'sum', 'utf8');
    const emptyRoot = path.join(root, 'empty-runtimes');
    await fs.mkdir(emptyRoot, { recursive: true });
    const fallbackRoot = path.join(root, 'fallback-runtimes');
    await fs.mkdir(fallbackRoot, { recursive: true });
    await writeFile(path.join(fallbackRoot, 'single-runtime.zip'), 'archive', 'utf8');
    const ambiguousRoot = path.join(root, 'ambiguous-runtimes');
    await fs.mkdir(ambiguousRoot, { recursive: true });
    await writeFile(path.join(ambiguousRoot, 'one-runtime.zip'), 'archive', 'utf8');
    await writeFile(path.join(ambiguousRoot, 'two-runtime.zip'), 'archive', 'utf8');

    const archive = await controller.findRuntimeArchive(runtimeRoot, 'darwin_arm64');
    const checksum = await controller.findRuntimeChecksumFile(runtimeRoot, archive, 'darwin_arm64');
    const pythonDarwinArmArchive = await controller.findRuntimeArchive(pythonRoot, 'darwin_arm64');
    const pythonDarwinX64Archive = await controller.findRuntimeArchive(pythonRoot, 'darwin_x64');
    const pythonLinuxArchive = await controller.findRuntimeArchive(pythonRoot, 'linux_x64');
    const pythonLinuxChecksum = await controller.findRuntimeChecksumFile(pythonRoot, pythonLinuxArchive, 'linux_x64');
    const pythonWindowsArchive = await controller.findRuntimeArchive(pythonRoot, 'win32_x64');
    const gitDarwinArchive = await controller.findRuntimeArchive(gitRoot, 'darwin_arm64');
    const gitWindowsArchive = await controller.findRuntimeArchive(gitRoot, 'win32_x64');
    const zipArchive = await controller.findRuntimeArchive(zipRoot, 'linux_x64');
    const zipChecksum = await controller.findRuntimeChecksumFile(zipRoot, zipArchive, 'linux_x64');
    const windowsArchive = await controller.findRuntimeArchive(windowsRoot, 'win32_x64');
    const windowsChecksum = await controller.findRuntimeChecksumFile(windowsRoot, windowsArchive, 'win32_x64');
    const fallbackArchive = await controller.findRuntimeArchive(fallbackRoot, 'linux_x64');

    assert.equal(controller.getBundledResourcesRoot(), runtimeRoot);
    const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: path.join(root, 'packaged-resources'),
    });
    try {
      const packaged = createController({
        app: {
          getAppPath: () => root,
          getPath: (name) => `/user/${name}`,
          getVersion: () => '0.0.0-test',
          isPackaged: true,
        },
      });
      assert.equal(packaged.controller.getBundledResourcesRoot(), path.join(root, 'packaged-resources', 'runtimes'));
    } finally {
      if (resourcesDescriptor) {
        Object.defineProperty(process, 'resourcesPath', resourcesDescriptor);
      } else {
        delete process.resourcesPath;
      }
    }
    assert.equal(path.basename(archive), 'node-darwin-arm64.tar.gz');
    assert.equal(path.basename(checksum), 'node-darwin-arm64.sha256');
    assert.equal(path.basename(pythonDarwinArmArchive), pythonArchives.darwin_arm64);
    assert.equal(path.basename(pythonDarwinX64Archive), pythonArchives.darwin_x64);
    assert.equal(path.basename(pythonLinuxArchive), pythonArchives.linux_x64);
    assert.equal(path.basename(pythonLinuxChecksum), `${pythonArchives.linux_x64}.sha256`);
    assert.equal(path.basename(pythonWindowsArchive), pythonArchives.win32_x64);
    assert.equal(path.basename(gitDarwinArchive), 'git-2.54.0-aarch64-apple-darwin.tar.gz');
    assert.equal(path.basename(gitWindowsArchive), 'MinGit-2.54.0-64-bit.zip');
    assert.equal(path.basename(zipArchive), 'node-linux_x64.zip');
    assert.equal(path.basename(zipChecksum), 'node-linux_x64.zip.sha256');
    assert.equal(path.basename(windowsArchive), 'node-x86_64-pc-windows-msvc.zip');
    assert.equal(path.basename(windowsChecksum), 'node-x86_64-pc-windows-msvc.zip.sha256');
    assert.equal(fallbackArchive, null);
    assert.equal(await controller.findRuntimeArchive(ambiguousRoot, 'linux_x64'), null);
    assert.equal(await controller.findRuntimeArchive(emptyRoot, 'linux_x64'), null);
    assert.deepEqual(controller.runtimePlatformTokens('linux_x64'), [
      'linux_x64',
      'linux-x64',
      'x86_64-unknown-linux-gnu',
      'x86_64-unknown-linux-musl',
      'x64-linux',
    ]);
    assert.deepEqual(controller.runtimePlatformTokens('darwin_x64'), [
      'darwin_x64',
      'darwin-x64',
      'x64-apple-darwin',
      'x86_64-apple-darwin',
    ]);
    assert.deepEqual(controller.runtimePlatformTokens('win32_x64'), [
      'win32_x64',
      'win32-x64',
      'win-x64',
      'x86_64-pc-windows-msvc',
      'windows-x64',
      '64-bit',
    ]);
    assert.deepEqual(controller.runtimePlatformTokens('darwin_arm64').includes('aarch64-apple-darwin'), true);
    assert.equal(controller.stripArchiveExtension('runtime.tar.gz'), 'runtime');
    assert.equal(controller.stripArchiveExtension('runtime.tgz'), 'runtime');
    assert.equal(controller.stripArchiveExtension('runtime.zip'), 'runtime');
    assert.equal(controller.stripArchiveExtension('runtime.bin'), 'runtime.bin');
    assert.equal(await controller.findRuntimeArchive(path.join(root, 'missing'), 'darwin_arm64'), null);
    assert.equal(await controller.findRuntimeChecksumFile(runtimeRoot, path.join(runtimeRoot, 'no-sum.zip'), 'missing_platform'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main utility reports runtime errors, catalog statuses, account switches, and chat trace events', async () => {
  const saved = [];
  const cleared = [];
  const cloudCalls = [];
  const { controller, friendChatWindows, sent, state } = createController({
    cloudDeviceManager: {
      start: async () => cloudCalls.push('start'),
      stop: () => cloudCalls.push('stop'),
    },
    forgerAccountStore: {
      save: async (account) => saved.push(account),
      clear: async () => cleared.push('clear'),
    },
    publicForgerAccount: (account) => ({
      authenticated: Boolean(account.authenticated),
      email: account.email,
    }),
    registry: {
      apps: {
        'finance-os': {
          appId: 'finance-os',
          name: 'Finance OS',
          version: '0.1.0',
          installDir: '/apps/finance-os',
          status: 'installed',
        },
        recipes: {
          appId: 'recipes',
          name: 'Recipes',
          version: '0.1.0',
          installDir: '/apps/recipes',
          status: 'installed',
        },
      },
    },
    runningApps: new Map([['finance-os', { frontendUrl: 'http://127.0.0.1:1' }]]),
  });
  friendChatWindows.set(3, { isDestroyed: () => false, close: () => undefined });

  const runtimeError = controller.runtimeError('No runtime', 'missing_runtime', 'installing');
  const diagnostic = controller.failureDiagnostic(new Error('bad'), 'fallback');
  const flattenError = new Error("EPERM: operation not permitted, rename 'C:\\Users\\ExampleUser\\Forger\\apps\\finance-os\\finance-os\\frontend' -> 'C:\\Users\\ExampleUser\\Forger\\apps\\finance-os\\frontend'");
  flattenError.stack = `${flattenError.name}: ${flattenError.message}\n    at moveFlattenChild (runtime-install.js:1:1)\n    at flattenSingleTopLevelDirectory (runtime-install.js:2:1)`;
  const flattenDiagnostic = buildFailureDiagnostic({ error: flattenError, fallbackCode: 'install_failed_unknown' });
  const trace = controller.buildChatRunIpcTracePayload({
    runId: 'run-1',
    appId: 'demo-app',
    status: 'running',
    userMessage: 'hello',
    progressLog: [{ message: 'one' }, { message: 'two' }],
  });
  const rendererTrace = controller.sanitizeRendererChatTrace({
    event: 'chat_run_message_appended',
    timestamp: 123,
    runId: 'run-1',
    messageCount: 2,
    foundConversation: true,
  });
  const completeRendererTrace = controller.sanitizeRendererChatTrace({
    event: 'chat_run_event_received',
    timestamp: '2026-05-21T00:00:00.000Z',
    runId: 123,
    appId: 'finance-os',
    conversationId: 'conversation-1',
    activeConversationId: 'conversation-2',
    status: 'completed',
    messageCount: '2',
    foundConversation: 'yes',
  });
  const switched = await controller.switchForgerAccountSession({
    authenticated: true,
    token: 'token',
    email: 'user@example.com',
  }, { userMessage: 'ok' });
  await controller.clearForgerAccountSession('expired');

  assert.equal(runtimeError.progress, 80);
  assert.equal(diagnostic.technicalCode, 'bad');
  assert.equal(flattenDiagnostic.technicalCode, 'install_extract_flatten_failed');
  assert.equal(flattenDiagnostic.details.classifier, 'install_extract_flatten_failed');
  assert.equal(flattenDiagnostic.details.operation, 'flatten');
  assert.equal(flattenDiagnostic.details.errorCode, 'EPERM');
  assert.equal(flattenDiagnostic.details.sourceName, 'frontend');
  assert.equal(flattenDiagnostic.details.targetName, 'frontend');
  assert.deepEqual(trace, {
    runId: 'run-1',
    appId: 'demo-app',
    conversationId: null,
    status: 'running',
    hasUserMessage: true,
    progressCount: 2,
  });
  assert.deepEqual(rendererTrace, {
    traceEvent: 'chat_run_message_appended',
    timestamp: null,
    runId: 'run-1',
    appId: null,
    conversationId: null,
    activeConversationId: null,
    status: null,
    messageCount: 2,
    foundConversation: true,
  });
  assert.deepEqual(completeRendererTrace, {
    traceEvent: 'chat_run_event_received',
    timestamp: '2026-05-21T00:00:00.000Z',
    runId: null,
    appId: 'finance-os',
    conversationId: 'conversation-1',
    activeConversationId: 'conversation-2',
    status: 'completed',
    messageCount: null,
    foundConversation: null,
  });
  assert.deepEqual(switched, { authenticated: true, email: 'user@example.com', userMessage: 'ok', technicalCode: undefined });
  assert.equal(state.forgerAccount.authenticated, false);
  assert.equal(saved.length, 1);
  assert.deepEqual(cleared, ['clear']);
  assert.deepEqual(cloudCalls, ['stop', 'start', 'stop']);
  assert.equal(controller.toCatalogStatus('finance-os'), 'running');
  assert.equal(controller.toCatalogStatus('recipes'), 'installed');
  assert.equal(controller.toCatalogStatus('missing'), 'not_installed');
  assert.equal(controller.mapBackendCategory('finance'), 'finance');
  assert.equal(controller.mapBackendCategory('home'), 'home');
  assert.equal(controller.mapBackendCategory('health'), 'health');
  assert.equal(controller.mapBackendCategory('developer_tools'), 'developer_tools');
  assert.equal(controller.mapBackendCategory('unknown'), 'productivity');
  assert.equal(sent.at(-1)[0], IPC_CHANNELS.forgerAccountUpdated);
});

test('main utility desktop updater is cached and emits progress through the main window', () => {
  const { controller, sent, state } = createController();
  const updater = controller.getDesktopUpdater();
  assert.equal(controller.getDesktopUpdater(), updater);
  assert.equal(state.desktopUpdater, updater);

  updater.options.onStateChanged({ status: 'checking' });
  assert.deepEqual(sent.at(-1), [IPC_CHANNELS.desktopUpdateProgress, { status: 'checking' }]);
});
