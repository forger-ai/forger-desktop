import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerBackendClient } = require('../../dist-electron/main/forger-backend-client.js');
const {
  defaultReportingLogPath,
  normalizeRemoteBackup,
  normalizeRemoteBackupsUsage,
  parseAccountPayload,
  safeValidationKeys,
  usernameCooldownMessage,
} = require('../../dist-electron/main/forger-backend/client-helpers.js');
const { ForgerMcpServer } = require('../../dist-electron/main/forger-mcp-server.js');
const { OfficialToolsService } = require('../../dist-electron/main/official-tools-service.js');
const {
  GmailOAuthError,
  runGmailOAuthFlow,
} = require('../../dist-electron/main/tools/gmail/oauth.js');

const createSecretsStore = (overrides = {}) => ({
  hasToolSecret: async () => false,
  getToolSecret: async () => undefined,
  setToolSecret: async () => ({ success: true }),
  deleteToolSecrets: async () => undefined,
  ...overrides,
});

const createGmailContext = (overrides = {}) => ({
  metadataRoot: tmpdir(),
  locale: 'es',
  secretsStore: createSecretsStore(),
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => true,
  getGmailOAuthClientId: async () => 'gmail-client-id',
  exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
  refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
  appendLog: async () => undefined,
  ...overrides,
});

const baseMcpToolDefinitions = [
  {
    id: 'forger_list_catalog',
    packageId: 'forger',
    name: 'Catalogo',
    description: 'Lista el catalogo.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_check_updates',
    packageId: 'forger',
    name: 'Updates',
    description: 'Revisa updates.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'custom_unknown_tool',
    packageId: 'forger',
    name: 'Custom',
    description: 'No tiene handler.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
];

const createMcpServer = (overrides = {}) => {
  const logs = [];
  const definitions = overrides.definitions ?? baseMcpToolDefinitions;
  const server = new ForgerMcpServer({
    getAppVersion: () => '0.1.test',
    getToolDefinitions: () => definitions,
    getToolSettings: () => ({ approvals: {} }),
    appendInstallLog: async (event, payload) => logs.push({ event, payload }),
    requestPermission: () => null,
    listCatalog: async () => [],
    listInstalledApps: () => [],
    checkUpdates: async () => [],
    getRuntimeStatus: () => ({ status: 'stopped' }),
    openApp: async () => ({ success: true }),
    stopApp: async () => ({ success: true }),
    restartApp: async () => ({ success: true }),
    refreshAppView: async () => ({ success: true }),
    updateApp: async () => ({ success: true }),
    listAppPrompts: async () => [],
    testAppPrompt: async () => ({ success: true, valid: true, errors: [], declaredVariables: [], usedVariables: [], missingVariables: [], extraVariables: [] }),
    updateAppPrompt: async () => ({ success: true }),
    restoreAppPrompt: async () => ({ success: true }),
    previewAppToolGrant: async (input) => ({
      success: false,
      appId: input.appId,
      userMessage: 'Sin declaracion.',
      technicalCode: 'app_tools_not_declared',
    }),
    setAppToolGrant: async (input) => ({
      success: true,
      appId: input.appId,
      userMessage: 'Grant actualizado.',
      gate: null,
    }),
    memoryList: async () => [],
    memoryCreate: async () => ({}),
    memoryUpdate: async () => ({}),
    memoryDelete: async () => ({ success: true }),
    listOfficialToolActionIdsForApp: async () => new Set(),
    validateOfficialTool: async () => null,
    callOfficialTool: async () => ({ success: true }),
    ...overrides.options,
  });
  return { server, logs };
};

const callMcp = async (session, body) => await fetch(session.url, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${session.token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
});

const parseToolResult = (payload) => JSON.parse(payload.result.content[0].text);

const createBackendClient = (fetchImpl, reportingLogPath = () => undefined) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const client = new ForgerBackendClient({
    backendBaseUrl: 'https://platform.test',
    token: () => 'token',
    mapBackendCategory: () => 'productivity',
    toCatalogStatus: () => 'not_installed',
    getUserMessage: () => undefined,
    platform: () => 'darwin_arm64',
    desktopVersion: () => '0.2.test',
    reportingLogPath,
  });
  return {
    client,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
};

test('MCP server handles idempotent start, unavailable listen address, and late missing tool definitions', async () => {
  const first = createMcpServer();
  await first.server.start();
  await first.server.start();
  assert.equal(first.logs.filter((entry) => entry.event === 'agent_tool:mcp_server_started').length, 1);
  first.server.stop();

  const originalAddress = http.Server.prototype.address;
  http.Server.prototype.address = () => null;
  try {
    const unavailable = createMcpServer();
    await assert.rejects(
      () => unavailable.server.start(),
      /forger_mcp_server_address_unavailable/,
    );
  } finally {
    http.Server.prototype.address = originalAddress;
  }

  let includeTransientTool = true;
  const transientTool = {
    id: 'transient_tool',
    packageId: 'forger',
    name: 'Transient',
    description: 'Disappears after validation.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  };
  const missing = createMcpServer({
    options: {
      getToolDefinitions: () => {
        if (includeTransientTool) {
          includeTransientTool = false;
          return [transientTool, ...baseMcpToolDefinitions];
        }
        return baseMcpToolDefinitions;
      },
    },
  });
  await missing.server.start();
  const session = missing.server.createSession('run-missing', 'finance-os');
  try {
    const response = await callMcp(session, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'transient_tool', arguments: { ok: true } },
    });
    const payload = await response.json();
    assert.equal(payload.result.isError, true);
    assert.equal(parseToolResult(payload).technicalCode, 'tool_not_found');
    assert.equal(missing.logs.some((entry) => entry.event === 'agent_tool:not_found'), true);

    const fallback = parseToolResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'custom_unknown_tool', arguments: {} },
    })).json());
    assert.equal(fallback.technicalCode, 'tool_not_found');
  } finally {
    missing.server.stop();
  }
});

test('Gmail OAuth setup maps backend errors, string failures, listen errors, and unavailable ports', async () => {
  const runRejectedCallback = async (exchangeGmailOAuthCode, expectedCode) => {
    const context = createGmailContext({
      openExternalUrl: async (url) => {
        const parsed = new URL(url);
        const callbackUrl = new URL(parsed.searchParams.get('redirect_uri'));
        callbackUrl.searchParams.set('state', parsed.searchParams.get('state'));
        callbackUrl.searchParams.set('code', 'oauth-code');
        const response = await fetch(callbackUrl);
        assert.equal(response.status, 500);
      },
      exchangeGmailOAuthCode,
    });
    await assert.rejects(
      () => runGmailOAuthFlow(context),
      (error) => error instanceof GmailOAuthError && error.technicalCode === expectedCode,
    );
  };

  await runRejectedCallback(async () => {
    throw new GmailOAuthError('OAuth especifico fallo.', 'gmail_specific_failed');
  }, 'gmail_specific_failed');

  await runRejectedCallback(async () => {
    throw 'backend unavailable';
  }, 'gmail_oauth_backend_exchange_failed');

  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function listenWithError() {
    process.nextTick(() => this.emit('error', new Error('gmail listen failed')));
    return this;
  };
  try {
    await assert.rejects(
      () => runGmailOAuthFlow(createGmailContext()),
      /gmail listen failed/,
    );
  } finally {
    http.Server.prototype.listen = originalListen;
  }

  const originalAddress = http.Server.prototype.address;
  http.Server.prototype.address = () => null;
  try {
    await assert.rejects(
      () => runGmailOAuthFlow(createGmailContext()),
      (error) => error instanceof GmailOAuthError && error.technicalCode === 'gmail_oauth_port_unavailable',
    );
  } finally {
    http.Server.prototype.address = originalAddress;
  }
});

test('OfficialToolsService covers execution fallbacks, missing declarations, and absent installed records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-official-tool-gaps-'));
  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore: createSecretsStore({ hasToolSecret: async () => true }),
    getFreePort: async () => 1234,
    openExternalUrl: async () => undefined,
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => 'gmail-client-id',
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
    getAppToolDeclarations: async () => null,
  });

  try {
    assert.deepEqual(await service.listToolsForApp('missing-app'), []);
    assert.deepEqual(await service.listAgentActionIdsForApp('missing-app'), new Set());

    await service.load();
    await service.recordError('gmail', new Error('ignored_without_install'));
    const activate = await service.activate('gmail');
    assert.equal(activate.success, true);

    service.getTool = async () => ({ id: 'gmail', name: 'Gmail', status: 'unknown', configured: false });
    const notReady = await service.validateAgentCall({
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
    });
    assert.equal(notReady.technicalCode, 'tool_not_configured');

    service.validateAgentCall = async () => null;
    service.modulesById.delete('gmail');
    const missingExecutor = await service.callFromAgent({
      toolId: 'gmail',
      actionId: 'gmail.connection.status',
    });
    assert.equal(missingExecutor.technicalCode, 'tool_executor_missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OfficialToolsService returns activation failures while configuring inactive tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-official-tool-activation-'));
  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore: createSecretsStore(),
    getFreePort: async () => 1234,
    openExternalUrl: async () => undefined,
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => 'gmail-client-id',
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
    getAppToolDeclarations: async () => null,
  });

  try {
    service.activate = async () => ({ success: false, userMessage: 'No disponible.', technicalCode: 'activation_failed' });
    const result = await service.configure({ toolId: 'gmail' });
    assert.equal(result.technicalCode, 'activation_failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backend helpers and reporting calls tolerate malformed payloads and failing report logs', async () => {
  assert.equal(safeValidationKeys({ errors: null }), undefined);
  assert.equal(safeValidationKeys('bad-payload'), undefined);
  assert.deepEqual(normalizeRemoteBackupsUsage(null), {
    usedBytes: 0,
    limitBytes: 0,
    backupCount: 0,
    backupCountLimit: 0,
  });
  assert.equal(normalizeRemoteBackup(null), undefined);
  assert.match(usernameCooldownMessage(undefined), /30 dias/);
  assert.deepEqual(parseAccountPayload('bad-payload', 'token', undefined), { authenticated: false });

  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.match(defaultReportingLogPath(), /forger-desktop(?:-dev)?[\\/]logs[\\/]reporting\.log$/);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }

  const root = await mkdtemp(join(tmpdir(), 'forger-report-log-failure-'));
  const harness = createBackendClient(async () => new Response('{}', { status: 200 }), () => root);
  try {
    const result = await harness.client.submitUsageEvent({
      eventName: 'desktop_started',
      installationIdentifier: 'install-1',
      surface: 'desktop',
    });
    assert.deepEqual(result, { success: true });
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }

  const errorLogRoot = await mkdtemp(join(tmpdir(), 'forger-report-log-network-'));
  const failedHarness = createBackendClient(async () => {
    throw new Error('network down');
  }, () => errorLogRoot);
  try {
    const result = await failedHarness.client.submitUsageEvent({
      eventName: 'desktop_started',
      installationIdentifier: 'install-1',
      surface: 'desktop',
    });
    assert.equal(result.technicalCode, 'usage_event_network_failed');
  } finally {
    failedHarness.restore();
    await rm(errorLogRoot, { recursive: true, force: true });
  }
});
