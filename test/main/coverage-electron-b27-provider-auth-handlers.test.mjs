import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { registerProviderAuthIpcHandlers } = await import('../../dist-electron/main/ipc/provider-auth-handlers.js');
const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');

const createHarness = (overrides = {}) => {
  const handlers = new Map();
  const calls = [];
  const delegate = (name, result = { success: true, name }) => async (...args) => {
    calls.push([name, ...args]);
    return result;
  };
  registerProviderAuthIpcHandlers({
    IPC_CHANNELS,
    CODEX_USAGE_DASHBOARD_URL: 'https://example.test/usage',
    fs: {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    path: {},
    shell: { openExternal: delegate('openExternal') },
    getMainWindow: () => null,
    getForgerMetadataRoot: () => '/metadata',
    getCodexAuthStatus: delegate('getCodexAuthStatus', { provider: 'codex' }),
    getClaudeAuthStatus: delegate('getClaudeAuthStatus', { provider: 'claude' }),
    getAntigravityAuthStatus: delegate('getAntigravityAuthStatus', { provider: 'antigravity' }),
    listLlmProviderProfiles: delegate('listProfiles', ['profile']),
    setActiveLlmProviderProfile: delegate('setActiveProfile'),
    updateLlmProviderProfileDefaults: delegate('updateProfile'),
    connectCodexAuth: delegate('connectCodex'),
    disconnectCodexAuth: delegate('disconnectCodex'),
    reinstallCodex: delegate('reinstallCodex'),
    confirmClaudeAuthConnection: delegate('confirmClaude'),
    connectClaudeAuth: delegate('connectClaude'),
    disconnectClaudeAuth: delegate('disconnectClaude'),
    signOutClaudeAuth: delegate('signOutClaude'),
    reinstallClaude: delegate('reinstallClaude'),
    connectAntigravityAuth: delegate('connectAntigravity'),
    startAntigravityAuthSession: async (onEvent) => {
      calls.push(['startAntigravity']);
      onEvent({ type: 'ready' });
      return { success: true, sessionId: 'session' };
    },
    writeAntigravityAuthSession: delegate('writeAntigravity'),
    cancelAntigravityAuthSession: delegate('cancelAntigravity'),
    disconnectAntigravityAuth: delegate('disconnectAntigravity'),
    reinstallAntigravity: delegate('reinstallAntigravity'),
    failureDiagnostic: (error, code) => ({ technicalCode: code, message: String(error) }),
    ...overrides,
  });
  return { handlers, calls };
};

test('provider auth IPC contains session events when no desktop window exists', async () => {
  const harness = createHarness();
  assert.deepEqual(await harness.handlers.get(IPC_CHANNELS.startAntigravityAuthSession)({}), {
    success: true,
    sessionId: 'session',
  });
  assert.deepEqual(harness.calls, [['startAntigravity']]);
});

test('provider auth IPC publishes session events and validates interactive session payloads', async () => {
  const sent = [];
  const harness = createHarness({
    getMainWindow: () => ({ webContents: { send: (...args) => sent.push(args) } }),
  });
  await harness.handlers.get(IPC_CHANNELS.startAntigravityAuthSession)({});
  assert.deepEqual(sent, [[IPC_CHANNELS.antigravityAuthSessionEvent, { type: 'ready' }]]);

  const write = harness.handlers.get(IPC_CHANNELS.writeAntigravityAuthSession);
  assert.equal((await write({}, null)).technicalCode, 'invalid_antigravity_auth_input');
  assert.equal((await write({}, { sessionId: 1, input: 'code' })).success, false);
  assert.equal((await write({}, { sessionId: 'session', input: 2 })).success, false);
  assert.deepEqual(await write({}, { sessionId: 'session', input: 'code' }), { success: true, name: 'writeAntigravity' });

  const cancel = harness.handlers.get(IPC_CHANNELS.cancelAntigravityAuthSession);
  assert.equal((await cancel({}, null)).technicalCode, 'invalid_antigravity_auth_session');
  assert.deepEqual(await cancel({}, 'session'), { success: true, name: 'cancelAntigravity' });
});

test('provider usage IPC routes audit diagnostics through the desktop logger boundary', async () => {
  const providerUsage = require('../../dist-electron/main/provider-usage.js');
  const desktopLogger = require('../../dist-electron/main/desktop-logger.js');
  const originalUsage = providerUsage.getAgentProviderUsageSafely;
  const originalAppend = desktopLogger.appendDesktopLog;
  const logs = [];
  providerUsage.getAgentProviderUsageSafely = async (deps) => {
    await deps.appendLog('provider_usage:test', { safe: true });
    return { success: true, providers: [] };
  };
  desktopLogger.appendDesktopLog = async (entry) => logs.push(entry);
  try {
    const harness = createHarness();
    assert.deepEqual(await harness.handlers.get(IPC_CHANNELS.getAgentProviderUsage)({}), { success: true, providers: [] });
    assert.deepEqual(logs, [{
      metadataRoot: '/metadata',
      service: 'agent-runtime',
      event: 'provider_usage:test',
      context: { safe: true },
    }]);
  } finally {
    providerUsage.getAgentProviderUsageSafely = originalUsage;
    desktopLogger.appendDesktopLog = originalAppend;
  }
});
