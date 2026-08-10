import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { createMainUtilitiesController, __testMainUtilitiesInternals } = require('../../dist-electron/main/core/main-utilities.js');

const createController = (overrides = {}) => createMainUtilitiesController({
  AGENT_TOOL_DEFINITIONS: [],
  AGENT_TOOL_IDS: [],
  APP_FOLDER_GRANT_TTL_MS: 60_000,
  Buffer,
  Date,
  DesktopUpdater: class {},
  IPC_CHANNELS,
  app: { getAppPath: () => '/app', getPath: () => '/user', getVersion: () => '1.0.0', isPackaged: false },
  appFolderGrantSecret: 'secret',
  appWindows: new Map(),
  buildFailureDiagnostic: ({ fallbackCode }) => ({ technicalCode: fallbackCode }),
  cloudDeviceManager: null,
  createHmac,
  desktopErrorReporter: null,
  forgerAccountStore: null,
  friendChatWindows: new Map(),
  fs: {
    mkdir: async () => undefined,
    chmod: async () => undefined,
    appendFile: async () => undefined,
    readFile: async () => { throw new Error('missing'); },
    writeFile: async () => undefined,
    readdir: async () => [],
  },
  getAgentToolSettingsPath: () => '/settings.json',
  getForgerMetadataRoot: () => '/metadata',
  getInstallLogPath: () => '/logs/install.jsonl',
  getMainWindow: () => null,
  installProgressByPhase: { failed: 100 },
  isDev: false,
  path,
  publicForgerAccount: (account) => account,
  registry: { apps: {} },
  runningApps: new Map(),
  state: { agentToolSettings: { approvals: {} }, catalogApps: [], desktopUpdater: null, forgerAccount: { authenticated: false } },
  ...overrides,
});

const signPayload = (payload) => {
  const encoded = Buffer.from(payload).toString('base64url');
  const signature = createHmac('sha256', 'secret').update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};

test('main process diagnostics ignore benign closed-pipe errors and retain reporter identity', () => {
  const reports = [];
  __testMainUtilitiesInternals.resetProcessErrorHandlersForTests();
  try {
    createController({
      desktopErrorReporter: {
        reportMainUncaughtException: (error) => reports.push(error),
        reportMainUnhandledRejection: (reason) => reports.push(reason),
      },
    });
    const benign = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    __testMainUtilitiesInternals.handleMainUncaughtException(benign);
    assert.deepEqual(reports, []);
  } finally {
    __testMainUtilitiesInternals.resetProcessErrorHandlersForTests();
  }
});

test('main utility diagnostics classify every desktop log service and serialize regular command failures', async () => {
  const desktopLogger = require('../../dist-electron/main/desktop-logger.js');
  const originalAppend = desktopLogger.appendDesktopLog;
  const services = [];
  desktopLogger.appendDesktopLog = async (entry) => services.push(entry.service);
  try {
    const controller = createController();
    for (const event of [
      'whatsapp_connected',
      'official_tool_called',
      'mcp_started',
      'app_agent_started',
      'installed_app_ready',
      'backend_request',
      'ordinary_event',
    ]) {
      await controller.appendInstallLog(event);
    }
    assert.deepEqual(services, [
      'tool:whatsapp',
      'official-tools',
      'mcp',
      'agent-runtime',
      'installed-app',
      'backend-client',
      'desktop-main',
    ]);

    const command = new controller.CommandFailedError('tool', [], '/cwd', null, 'SIGTERM', '', 'failed');
    assert.equal(command.message, 'command_failed_null');
    const serialized = controller.serializeErrorForInstallLog(new TypeError('typed'));
    assert.equal(serialized.name, 'TypeError');
    assert.equal(serialized.message, 'typed');
    assert.match(serialized.stack, /^TypeError: typed/);
  } finally {
    desktopLogger.appendDesktopLog = originalAppend;
  }
});

test('folder grants reject malformed, expired, and non-JSON signed capabilities', () => {
  const controller = createController();
  for (const token of ['', 'payload', 'payload.signature.extra']) {
    assert.equal(controller.verifyAppFolderGrant('finance-os', token), null);
  }
  assert.equal(controller.verifyAppFolderGrant('finance-os', signPayload('not-json')), null);
  assert.equal(controller.verifyAppFolderGrant('finance-os', signPayload(JSON.stringify({
    appId: 'finance-os', path: '/folder', exp: 0,
  }))), null);
  assert.equal(controller.verifyAppFolderGrant('finance-os', signPayload(JSON.stringify({
    appId: 'finance-os', path: '/folder', exp: 'tomorrow',
  }))), null);
});

test('background task updates respect missing, destroyed, and live desktop windows', () => {
  const sent = [];
  createController().emitBackgroundTaskUpdated({ task: { id: 'none' } });
  createController({
    getMainWindow: () => ({ isDestroyed: () => true, webContents: { send: () => assert.fail('destroyed') } }),
  }).emitBackgroundTaskUpdated({ task: { id: 'destroyed' } });
  createController({
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }),
  }).emitBackgroundTaskUpdated({ task: { id: 'live' } });
  assert.deepEqual(sent, [[IPC_CHANNELS.backgroundTaskUpdated, { task: { id: 'live' } }]]);
});

test('version comparison reaches lexical tie-breaking only with normalized strings', () => {
  const controller = createController();
  assert.equal(controller.isVersionNewer('v1.0', '1.0'), true);
  assert.equal(controller.isVersionNewer('1.0', 'v1.0'), false);
});
