/* eslint-disable max-lines */
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getMcpToolAnnotations,
  getMcpToolInputSchema,
} = require('../../dist-electron/main/forger-mcp/tool-metadata.js');
const {
  AppMcpManager,
  findManifestMcp,
} = require('../../dist-electron/main/app-mcp-manager.js');
const { ForgerMcpServer } = require('../../dist-electron/main/forger-mcp-server.js');
const {
  OfficialToolsService,
  normalizeAppToolDeclarations,
} = require('../../dist-electron/main/official-tools-service.js');
const {
  AutomationManager,
  computeNextRunAt,
} = require('../../dist-electron/main/automation-manager.js');
const {
  appendTranscript,
  parseClaudeAssistantMessages,
  parseCodexAssistantMessages,
  resolveCodexCommand,
  runAgentCommand,
} = require('../../dist-electron/main/automation/agent-command-runner.js');

const wait = (ms) => new Promise((resolveWait) => {
  setTimeout(resolveWait, ms);
});

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

const createSecretsStore = (overrides = {}) => ({
  hasToolSecret: async () => false,
  getToolSecret: async () => undefined,
  setToolSecret: async () => ({ success: true }),
  deleteToolSecrets: async () => undefined,
  ...overrides,
});

const parseToolTextResult = (payload) => JSON.parse(payload.result.content[0].text);

const defaultMcpToolDefinitions = [
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
    id: 'forger_list_installed_apps',
    packageId: 'forger',
    name: 'Apps',
    description: 'Lista apps instaladas.',
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
    id: 'forger_create_app',
    packageId: 'forger',
    name: 'Crear app',
    description: 'Crea una app.',
    category: 'app',
    risk: 'medio',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_get_app_runtime_status',
    packageId: 'forger',
    name: 'Estado',
    description: 'Obtiene estado.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_open_app',
    packageId: 'forger',
    name: 'Abrir',
    description: 'Abre una app.',
    category: 'app',
    risk: 'medio',
    defaultRequiresApproval: true,
  },
  {
    id: 'forger_stop_app',
    packageId: 'forger',
    name: 'Detener',
    description: 'Detiene una app.',
    category: 'app',
    risk: 'alto',
    defaultRequiresApproval: true,
  },
  {
    id: 'forger_restart_app',
    packageId: 'forger',
    name: 'Reiniciar',
    description: 'Reinicia una app.',
    category: 'app',
    risk: 'medio',
    defaultRequiresApproval: true,
  },
  {
    id: 'forger_refresh_app_view',
    packageId: 'forger',
    name: 'Refrescar',
    description: 'Refresca una app.',
    category: 'app',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_update_app',
    packageId: 'forger',
    name: 'Actualizar',
    description: 'Actualiza una app.',
    category: 'app',
    risk: 'alto',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_list_app_prompts',
    packageId: 'forger',
    name: 'Prompts',
    description: 'Lista prompts.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_test_app_prompt',
    packageId: 'forger',
    name: 'Probar prompt',
    description: 'Valida prompt.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_update_app_prompt',
    packageId: 'forger',
    name: 'Editar prompt',
    description: 'Edita prompt.',
    category: 'app',
    risk: 'medio',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_restore_app_prompt',
    packageId: 'forger',
    name: 'Restaurar prompt',
    description: 'Restaura prompt.',
    category: 'app',
    risk: 'medio',
    defaultRequiresApproval: false,
  },
  {
    id: 'memory_list',
    packageId: 'forger',
    name: 'Memorias',
    description: 'Lista memoria.',
    category: 'memoria',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'memory_create',
    packageId: 'forger',
    name: 'Crear memoria',
    description: 'Crea memoria.',
    category: 'memoria',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'memory_update',
    packageId: 'forger',
    name: 'Actualizar memoria',
    description: 'Actualiza memoria.',
    category: 'memoria',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'memory_delete',
    packageId: 'forger',
    name: 'Borrar memoria',
    description: 'Borra memoria.',
    category: 'memoria',
    risk: 'medio',
    defaultRequiresApproval: false,
  },
];

const createForgerMcpHarness = async (overrides = {}) => {
  const logs = [];
  const progress = [];
  const toolFailures = [];
  const httpFailures = [];
  const toolDefinitions = overrides.toolDefinitions ?? defaultMcpToolDefinitions;
  const server = new ForgerMcpServer({
    getAppVersion: () => '0.1.test',
    getToolDefinitions: () => toolDefinitions,
    getToolSettings: () => ({
      approvals: {
        forger_open_app: true,
        forger_stop_app: true,
        forger_restart_app: true,
        ...(overrides.approvals ?? {}),
      },
    }),
    appendInstallLog: async (event, payload) => logs.push({ event, payload }),
    requestPermission: overrides.requestPermission ?? (() => null),
    listCatalog: async () => [{ id: 'finance-os', name: 'Finance OS' }],
    listInstalledApps: () => [{ id: 'finance-os', name: 'Finance OS', status: 'installed', description: 'Finanzas' }],
    checkUpdates: async () => [{ id: 'finance-os', name: 'Finance OS', status: 'update_available', description: 'Finanzas' }],
    createLocalApp: async (input, locale) => ({ success: true, userMessage: 'Creada.', app: { appId: 'created-app', ...input }, locale }),
    recordCreatedApp: overrides.recordCreatedApp ?? (() => undefined),
    registerQuestion: overrides.registerQuestion ?? (async (runId, input) => ({
      requestId: 'question-request-1',
      chatId: `${runId}-chat`,
      questions: input.questions,
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
    getRuntimeStatus: (appId) => ({ status: appId === 'finance-os' ? 'running' : 'stopped' }),
    openApp: async (appId) => ({ success: true, appId }),
    stopApp: async (appId) => ({ success: true, appId }),
    restartApp: async (appId, options) => {
      options?.onProgress?.('Reiniciando app');
      return { success: true, appId };
    },
    refreshAppView: async () => ({ success: true, userMessage: 'Vista refrescada.' }),
    updateApp: async (appId, locale) => ({ success: true, appId, locale }),
    listAppPrompts: async () => [{ kind: 'agent', id: 'assistant', title: 'Assistant' }],
    testAppPrompt: async (input) => ({ success: true, valid: true, input, errors: [], declaredVariables: [], usedVariables: [], missingVariables: [], extraVariables: [] }),
    updateAppPrompt: async (input) => ({ success: true, input }),
    restoreAppPrompt: async (input) => ({ success: true, input }),
    memoryList: async () => [{ id: 'mem-1', scope: 'app', kind: 'fact', text: 'Dato' }],
    memoryCreate: async (input, access) => ({ id: 'mem-new', scope: input.scope, kind: input.kind, text: input.text, access }),
    memoryUpdate: async (input) => ({ id: input.id, scope: 'app', kind: 'fact', text: input.text ?? 'Updated' }),
    memoryDelete: async (id) => ({ success: id === 'mem-1' }),
    listOfficialToolActionIdsForApp: async () => new Set(),
    validateOfficialTool: async () => null,
    callOfficialTool: async () => ({ success: true }),
    onToolProgress: (input) => progress.push(input),
    onToolFailure: (input) => toolFailures.push(input),
    onHttpFailure: (input) => httpFailures.push(input),
    ...overrides.options,
  });
  await server.start();
  return {
    server,
    logs,
    progress,
    toolFailures,
    httpFailures,
    stop: () => server.stop(),
  };
};

const callMcp = async (session, body, token = session.token) => await fetch(session.url, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('MCP tool schemas expose strict Gmail contracts and safe annotations', () => {
  assert.equal(getMcpToolInputSchema('memory_list').additionalProperties, false);
  assert.deepEqual(getMcpToolInputSchema('memory_create').required, ['scope', 'kind']);
  assert.equal(getMcpToolInputSchema('memory_create').properties.read_when.type, 'string');
  assert.deepEqual(getMcpToolInputSchema('memory_update').required, ['id']);
  assert.deepEqual(getMcpToolInputSchema('memory_delete').required, ['id']);
  assert.deepEqual(getMcpToolInputSchema('forger_open_app').required, ['appId']);
  assert.deepEqual(getMcpToolInputSchema('forger_create_app').required, ['name', 'description', 'purpose']);
  assert.equal(getMcpToolInputSchema('forger_create_app').properties.agentPrompt, undefined);
  assert.deepEqual(getMcpToolInputSchema('forger_ask_question').required, ['questions']);
  assert.equal(getMcpToolInputSchema('forger_ask_question').properties.chatId, undefined);
  assert.equal(getMcpToolInputSchema('forger_ask_question').properties.questions.maxItems, 5);
  assert.deepEqual(
    getMcpToolInputSchema('forger_ask_question').properties.questions.items.properties.options.items.required,
    ['id', 'label', 'description'],
  );
  assert.deepEqual(getMcpToolInputSchema('forger_restore_app_prompt').required, ['appId', 'kind', 'id']);
  assert.deepEqual(getMcpToolInputSchema('forger_test_app_prompt').required, ['appId', 'kind', 'id']);
  assert.equal(getMcpToolInputSchema('forger_test_app_prompt').properties.variables.type, 'object');

  const searchSchema = getMcpToolInputSchema('gmail.search_messages');
  assert.deepEqual(searchSchema.required, ['query']);
  assert.equal(searchSchema.properties.maxResults.type, 'number');

  const readThreadSchema = getMcpToolInputSchema('gmail.read_thread');
  assert.equal(readThreadSchema.additionalProperties, false);
  assert.equal(readThreadSchema.properties.threadId.type, 'string');

  const sendSchema = getMcpToolInputSchema('gmail.send_email');
  assert.deepEqual(sendSchema.required, ['to', 'subject', 'body']);
  assert.equal(sendSchema.additionalProperties, false);
  assert.equal(sendSchema.properties.attachments.items.required[0], 'filePath');

  const readAttachmentSchema = getMcpToolInputSchema('gmail.read_attachment');
  assert.deepEqual(readAttachmentSchema.required, ['messageId']);
  assert.equal(readAttachmentSchema.properties.attachmentId.type, 'string');

  assert.deepEqual(getMcpToolAnnotations({
    id: 'memory_list',
    category: 'memoria',
  }), {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(getMcpToolAnnotations({
    id: 'forger_update_app',
    category: 'app',
  }), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(getMcpToolInputSchema('unknown_tool'), {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
});

test('official tool declarations dedupe entries and app grants gate optional tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-tools-service-'));
  const declarations = normalizeAppToolDeclarations({
    required: [
      { toolId: 'gmail', reason: 'Necesita leer correo', actions: ['gmail.search_messages', ''] },
      { toolId: 'gmail', reason: 'Duplicado', actions: ['gmail.send_email'] },
      { toolId: '', reason: 'bad', actions: ['gmail.search_messages'] },
    ],
    optional: [
      { toolId: 'gmail', reason: 'Puede enviar', actions: ['gmail.send_email'] },
    ],
  });
  assert.deepEqual(declarations.required, [{
    toolId: 'gmail',
    reason: 'Necesita leer correo',
    actions: ['gmail.search_messages'],
  }]);

  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore: createSecretsStore(),
    getFreePort: async () => 1234,
    openExternalUrl: async () => undefined,
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => 'gmail-client',
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'access' }),
    getAppToolDeclarations: async () => ({
      appName: 'Finance OS',
      required: [],
      optional: declarations.optional,
      agents: [],
      promptTemplates: [],
    }),
  });

  try {
    const refreshed = await service.refresh('en');
    assert.equal(refreshed.tools.some((tool) => tool.id === 'gmail' && tool.name === 'Gmail'), true);
    assert.equal(await service.getTool('missing-tool'), null);
    await service.activate('gmail');
    assert.deepEqual(await service.listToolsForApp('finance-os'), []);
    let gate = await service.getInstallGate('finance-os');
    assert.equal(gate.optional[0].granted, false);
    assert.equal(gate.canInstall, true);

    gate = await service.setAppToolGrant({ appId: 'finance-os', toolId: 'gmail', granted: true });
    assert.equal(gate.optional[0].granted, true);
    assert.deepEqual([...await service.listAgentActionIdsForApp('finance-os')], ['gmail.send_email']);
    assert.equal((await service.listToolsForApp('finance-os')).map((tool) => tool.id).join(','), 'gmail');

    const status = await service.callFromAgent({
      toolId: 'gmail',
      actionId: 'gmail.connection.status',
    });
    assert.deepEqual(status, { success: true, data: { connected: false } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official tools configure Gmail through OAuth callback and clean grants on deactivate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-tools-configure-'));
  const secrets = new Map();
  const deletedTools = [];
  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore: createSecretsStore({
      hasToolSecret: async (toolId, secretName) => secrets.has(`${toolId}:${secretName}`),
      getToolSecret: async (toolId, secretName) => secrets.get(`${toolId}:${secretName}`),
      setToolSecret: async (toolId, secretName, value) => {
        secrets.set(`${toolId}:${secretName}`, value);
        return { success: true };
      },
      deleteToolSecrets: async (toolId) => {
        deletedTools.push(toolId);
        for (const key of [...secrets.keys()]) {
          if (key.startsWith(`${toolId}:`)) {
            secrets.delete(key);
          }
        }
      },
    }),
    getFreePort: async () => 1234,
    openExternalUrl: async (url) => {
      const parsed = new URL(url);
      const callbackUrl = new URL(parsed.searchParams.get('redirect_uri'));
      callbackUrl.searchParams.set('state', parsed.searchParams.get('state'));
      callbackUrl.searchParams.set('code', 'oauth-code');
      const response = await fetch(callbackUrl);
      assert.equal(response.status, 200);
    },
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => 'gmail-client',
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
    getAppToolDeclarations: async () => ({
      appName: 'Finance OS',
      required: [],
      optional: [{ toolId: 'gmail', reason: 'Puede enviar', actions: ['gmail.send_email'] }],
      agents: [],
      promptTemplates: [],
    }),
  });

  try {
    const configured = await service.configure({ toolId: 'gmail' });
    assert.equal(configured.success, true);
    assert.equal((await service.getTool('gmail')).status, 'configured');
    await service.setAppToolGrant({ appId: 'finance-os', toolId: 'gmail', granted: true });
    assert.equal((await service.getInstallGate('finance-os')).optional[0].granted, true);

    const deactivated = await service.deactivate('gmail');
    assert.equal(deactivated.success, true);
    assert.deepEqual(deletedTools, ['gmail']);
    assert.equal(secrets.size, 0);
    assert.deepEqual(await service.listAgentActionIdsForApp('finance-os'), new Set());
    const registry = JSON.parse(await readFile(join(root, 'official-tools.json'), 'utf8'));
    assert.deepEqual(registry.appGrants['finance-os'], {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official tools enforce app declarations before configured tool execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-tools-declarations-'));
  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore: createSecretsStore(),
    getFreePort: async () => 1234,
    openExternalUrl: async () => {
      throw new Error('browser_blocked');
    },
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => '   ',
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
    getAppToolDeclarations: async (appId) => {
      if (appId === 'finance-os') {
        return {
          appName: 'Finance OS',
          required: [{ toolId: 'gmail', reason: 'Necesita leer', actions: ['gmail.search_messages', 'gmail.connection.status'] }],
          optional: [],
          agents: [],
          promptTemplates: [],
        };
      }
      if (appId === 'mailer') {
        return {
          appName: 'Mailer',
          required: [],
          optional: [{ toolId: 'gmail', reason: 'Puede enviar', actions: ['gmail.send_email'] }],
          agents: [],
          promptTemplates: [],
        };
      }
      return null;
    },
  });

  try {
    assert.equal((await service.deactivate('unknown-tool')).technicalCode, 'tool_not_found');
    assert.equal((await service.callFromApp('unknown-app', {
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
    })).technicalCode, 'app_tools_not_declared');

    await service.activate('gmail');
    const status = await service.callFromApp('finance-os', {
      toolId: 'gmail',
      actionId: 'gmail.connection.status',
    });
    assert.deepEqual(status, { success: true, data: { connected: false } });

    const notConfigured = await service.callFromApp('finance-os', {
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: 'from:bank' },
    });
    assert.equal(notConfigured.technicalCode, 'tool_not_configured');

    const optionalDenied = await service.callFromApp('mailer', {
      toolId: 'gmail',
      actionId: 'gmail.send_email',
    });
    assert.equal(optionalDenied.technicalCode, 'app_tool_permission_denied');

    const undeclaredAction = await service.callFromAgent({
      toolId: 'gmail',
      actionId: 'gmail.read_thread',
    }, { appId: 'finance-os', requireAppGrant: true });
    assert.equal(undeclaredAction.technicalCode, 'app_tool_action_not_declared');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official tools preserve registry fallbacks, error status, required gates, and agent grant validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-tools-edge-'));
  await writeFile(join(root, 'official-tools.json'), '{bad json', 'utf8');
  const deletedTools = [];
  const declarationsByApp = new Map([
    ['required-app', {
      appName: 'Required App',
      required: [{ toolId: 'gmail', reason: 'Necesita Gmail', actions: ['gmail.search_messages'] }],
      optional: [],
      agents: [],
      promptTemplates: [],
    }],
    ['optional-app', {
      appName: 'Optional App',
      required: [],
      optional: [{ toolId: 'gmail', reason: 'Puede enviar', actions: ['gmail.send_email'] }],
      agents: [],
      promptTemplates: [],
    }],
  ]);
  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore: createSecretsStore({
      deleteToolSecrets: async (toolId) => deletedTools.push(toolId),
    }),
    getFreePort: async () => 1234,
    openExternalUrl: async () => {
      throw new Error('browser_blocked');
    },
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => '   ',
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
    getAppToolDeclarations: async (appId) => declarationsByApp.get(appId) ?? null,
  });

  try {
    assert.equal((await service.activate('missing-tool')).technicalCode, 'tool_not_found');
    assert.equal((await service.configure({ toolId: 'missing-tool' })).technicalCode, 'tool_not_found');
    assert.equal(await service.getInstallGate('missing-app'), null);
    assert.deepEqual(await service.listAgentActionIdsForApp('missing-app'), new Set());

    const gate = await service.getInstallGate('required-app');
    assert.equal(gate.required[0].available, false);
    assert.equal(gate.canInstall, false);
    assert.deepEqual([...await service.listAgentActionIdsForApp('required-app')], ['gmail.search_messages']);

    const noAppGrant = await service.validateAgentCall({
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
    }, { requireAppGrant: true });
    assert.equal(noAppGrant.technicalCode, 'app_tools_not_declared');

    const missingAppGrant = await service.validateAgentCall({
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
    }, { appId: 'missing-app', requireAppGrant: true });
    assert.equal(missingAppGrant.technicalCode, 'app_tools_not_declared');

    const agentUndeclaredTool = await service.validateAgentCall({
      toolId: 'gmail-missing',
      actionId: 'gmail.search_messages',
    }, { appId: 'required-app', requireAppGrant: true });
    assert.equal(agentUndeclaredTool.technicalCode, 'app_tool_not_declared');

    await service.activate('gmail');
    const failedConfigure = await service.configure({ toolId: 'gmail' });
    assert.equal(failedConfigure.success, false);
    assert.equal(failedConfigure.technicalCode, 'gmail_oauth_client_missing');
    assert.equal((await service.getTool('gmail')).status, 'error');

    const errorStatus = await service.callFromAgent({
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: 'from:bank' },
    });
    assert.equal(errorStatus.technicalCode, 'tool_configuration_error');

    await service.setAppToolGrant({ appId: 'optional-app', toolId: 'gmail', granted: true });
    const kept = await service.deactivate('gmail', { keepSecrets: true });
    assert.equal(kept.success, true);
    assert.deepEqual(deletedTools, []);

    const registry = JSON.parse(await readFile(join(root, 'official-tools.json'), 'utf8'));
    assert.deepEqual(registry.appGrants['optional-app'], {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official tools validate unavailable, undeclared, optional, and malformed registry branches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-tools-validation-'));
  await writeFile(join(root, 'official-tools.json'), JSON.stringify({
    version: 1,
    installed: [],
    appGrants: [],
  }), 'utf8');
  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore: createSecretsStore(),
    getFreePort: async () => 1234,
    openExternalUrl: async () => undefined,
    isForgerAccountAuthenticated: () => true,
    getGmailOAuthClientId: async () => 'gmail-client',
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
    getAppToolDeclarations: async (appId) => {
      if (appId === 'finance-os') {
        return {
          appName: 'Finance OS',
          required: [{ toolId: 'gmail', reason: 'Necesita Gmail', actions: ['gmail.search_messages'] }],
          optional: [],
          agents: [],
          promptTemplates: [],
        };
      }
      if (appId === 'mailer') {
        return {
          appName: 'Mailer',
          required: [],
          optional: [{ toolId: 'gmail', reason: 'Puede enviar', actions: ['gmail.send_email'] }],
          agents: [],
          promptTemplates: [],
        };
      }
      return null;
    },
  });

  try {
    assert.deepEqual(normalizeAppToolDeclarations(null), { required: [], optional: [] });
    assert.deepEqual(normalizeAppToolDeclarations({ required: 'bad', optional: [null, [], { toolId: ' ', reason: 'bad', actions: [] }] }), {
      required: [],
      optional: [],
    });

    const inactive = await service.callFromAgent({
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: 'from:bank' },
    });
    assert.equal(inactive.technicalCode, 'tool_not_active');

    const undeclaredTool = await service.callFromApp('finance-os', {
      toolId: 'gmail-missing',
      actionId: 'gmail.search_messages',
    });
    assert.equal(undeclaredTool.technicalCode, 'app_tool_not_declared');

    await service.activate('gmail');
    const undeclaredAppAction = await service.callFromApp('finance-os', {
      toolId: 'gmail',
      actionId: 'gmail.send_email',
    });
    assert.equal(undeclaredAppAction.technicalCode, 'app_tool_action_not_declared');

    const optionalAgentDenied = await service.validateAgentCall({
      toolId: 'gmail',
      actionId: 'gmail.send_email',
    }, { appId: 'mailer', requireAppGrant: true });
    assert.equal(optionalAgentDenied.technicalCode, 'app_tool_permission_denied');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Forger MCP app-agent sessions filter Gmail tools and return validation failures before execution', async () => {
  const logs = [];
  const toolDefinitions = [
    {
      id: 'gmail.search_messages',
      packageId: 'gmail',
      name: 'Buscar correos',
      description: 'Busca correos de Gmail.',
      category: 'correo',
      risk: 'medio',
      defaultRequiresApproval: false,
    },
    {
      id: 'gmail.send_email',
      packageId: 'gmail',
      name: 'Enviar correo',
      description: 'Envia correos de Gmail.',
      category: 'correo',
      risk: 'alto',
      defaultRequiresApproval: false,
    },
    {
      id: 'forger_list_installed_apps',
      packageId: 'forger',
      name: 'Apps',
      description: 'Lista apps instaladas.',
      category: 'app',
      risk: 'bajo',
      defaultRequiresApproval: false,
    },
  ];
  const server = new ForgerMcpServer({
    getAppVersion: () => '0.1.test',
    getToolDefinitions: () => toolDefinitions,
    getToolSettings: () => ({ approvals: {} }),
    appendInstallLog: async (event, payload) => logs.push({ event, payload }),
    requestPermission: () => null,
    listCatalog: async () => [],
    listInstalledApps: () => [{ id: 'finance-os', name: 'Finance OS', status: 'installed', description: 'Finanzas' }],
    checkUpdates: async () => [],
    getRuntimeStatus: () => ({ status: 'stopped' }),
    openApp: async () => ({ success: true }),
    stopApp: async () => ({ success: true }),
    restartApp: async () => ({ success: true }),
    refreshAppView: async () => ({ success: true }),
    updateApp: async () => ({ success: true }),
    listAppPrompts: async () => [],
    updateAppPrompt: async () => ({ success: true }),
    restoreAppPrompt: async () => ({ success: true }),
    memoryList: async () => [],
    memoryCreate: async () => ({}),
    memoryUpdate: async () => ({}),
    memoryDelete: async () => ({ success: true }),
    listOfficialToolActionIdsForApp: async () => new Set(['gmail.search_messages']),
    validateOfficialTool: async (input) => (
      input.actionId === 'gmail.send_email'
        ? { success: false, userMessage: 'Sin permiso.', technicalCode: 'app_tool_permission_denied' }
        : null
    ),
    callOfficialTool: async (input) => ({ success: true, data: { actionId: input.actionId } }),
  });
  await server.start();
  const session = server.createSession('run-1', 'finance-os', { caller: 'app-agent', appIds: ['finance-os'] });

  try {
    const listResponse = await fetch(session.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const listPayload = await listResponse.json();
    const names = listPayload.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['forger_ask_question', 'forger_list_installed_apps', 'gmail.search_messages']);

    const deniedResponse = await fetch(session.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'gmail.send_email', arguments: { to: ['user@example.com'] } },
      }),
    });
    const deniedPayload = await deniedResponse.json();
    assert.equal(deniedPayload.result.isError, true);
    assert.deepEqual(parseToolTextResult(deniedPayload), {
      success: false,
      userMessage: 'Sin permiso.',
      technicalCode: 'app_tool_permission_denied',
    });

    const allowedResponse = await fetch(session.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'gmail.search_messages', arguments: { query: 'from:bank' } },
      }),
    });
    const allowedPayload = await allowedResponse.json();
    assert.equal(allowedPayload.result.isError, false);
    assert.deepEqual(parseToolTextResult(allowedPayload), {
      success: true,
      data: { actionId: 'gmail.search_messages' },
    });
    assert.equal(logs.some((entry) => entry.event === 'agent_tool:mcp_tools_list_built'), true);
  } finally {
    server.stop();
  }
});

test('Forger MCP server handles auth, JSON-RPC lifecycle, session release, and HTTP failures', async () => {
  const harness = await createForgerMcpHarness();
  assert.equal(harness.server.createSession('before-start', 'finance-os') === null, false);
  const stopped = new ForgerMcpServer({
    getAppVersion: () => '0.1.test',
    getToolDefinitions: () => [],
    getToolSettings: () => ({ approvals: {} }),
    appendInstallLog: async (event, payload) => harness.logs.push({ event, payload }),
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
    updateAppPrompt: async () => ({ success: true }),
    restoreAppPrompt: async () => ({ success: true }),
    memoryList: async () => [],
    memoryCreate: async () => ({}),
    memoryUpdate: async () => ({}),
    memoryDelete: async () => ({ success: true }),
    listOfficialToolActionIdsForApp: async () => new Set(),
    validateOfficialTool: async () => null,
    callOfficialTool: async () => ({ success: true }),
  });
  assert.equal(stopped.createSession('run-unavailable', 'finance-os'), null);

  const session = harness.server.createSession('run-1', 'forger', { caller: 'free-chat', locale: 'es' });
  try {
    const notFound = await fetch(session.url.replace('/mcp', '/bad'), { method: 'GET' });
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: 'not_found' });

    const unauthorized = await fetch(session.url, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });

    const initialized = await callMcp(session, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    const initializedPayload = await initialized.json();
    assert.equal(initialized.status, 200);
    assert.equal(initializedPayload.result.serverInfo.version, '0.1.test');

    const notification = await callMcp(session, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.equal(notification.status, 202);

    const batch = await callMcp(session, [
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3 },
      { jsonrpc: '2.0', id: 4, method: 'missing/method' },
    ]);
    const batchPayload = await batch.json();
    assert.equal(batch.status, 200);
    assert.equal(batchPayload[0].result.constructor, Object);
    assert.equal(batchPayload[1].error.code, -32600);
    assert.equal(batchPayload[2].error.code, -32601);

    const unknownTool = await callMcp(session, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'unknown_tool', arguments: { ok: true } },
    });
    assert.equal((await unknownTool.json()).error.message, 'Unknown tool');

    const badJson = await callMcp(session, '{bad json');
    const badJsonPayload = await badJson.json();
    assert.equal(badJson.status, 500);
    assert.equal(badJsonPayload.error.code, -32603);
    assert.equal(harness.httpFailures.some((entry) => entry.appId === 'forger' && entry.runId === 'run-1'), true);

    harness.server.releaseSession(session.token);
    assert.equal(harness.logs.some((entry) => entry.event === 'agent_tool:mcp_session_released'), true);
  } finally {
    harness.stop();
  }
});

test('Forger MCP tools cover approvals, memory failures, app operations, and progress callbacks', async () => {
  const permissionDecisions = new Map([
    ['forger_open_app', null],
    ['forger_stop_app', false],
    ['forger_restart_app', true],
  ]);
  const harness = await createForgerMcpHarness({
    requestPermission: async (_runId, request) => permissionDecisions.get(request.permission),
    options: {
      memoryList: async (input) => {
        if (input.scope === 'global') {
          throw new Error('memory_scope_forbidden');
        }
        return [{ id: 'mem-1', scope: 'app', kind: 'fact', text: 'Dato' }];
      },
    },
  });
  const session = harness.server.createSession('run-2', 'finance-os', { caller: 'desktop-chat', appIds: ['finance-os'] });
  const automationSession = harness.server.createSession('run-3', 'finance-os', { caller: 'automation', appIds: ['finance-os'] });
  try {
    const unavailable = await callMcp(session, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forger_open_app', arguments: { appId: 'finance-os' } },
    });
    const unavailableResult = parseToolTextResult(await unavailable.json());
    assert.equal(unavailableResult.technicalCode, 'permission_unavailable');
    assert.equal(unavailableResult.authorization.status, 'unavailable');

    const denied = await callMcp(session, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'forger_stop_app', arguments: { appId: 'finance-os' } },
    });
    const deniedResult = parseToolTextResult(await denied.json());
    assert.equal(deniedResult.technicalCode, 'permission_denied');
    assert.equal(deniedResult.authorization.status, 'denied');

    const restarted = await callMcp(session, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'forger_restart_app', arguments: { appId: 'finance-os' } },
    });
    const restartedResult = parseToolTextResult(await restarted.json());
    assert.equal(restartedResult.success, true);
    assert.equal(restartedResult.authorization.status, 'approved');
    assert.equal(harness.progress.some((entry) => entry.message.includes('Reiniciando')), true);

    const catalog = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'forger_list_catalog', arguments: {} },
    })).json());
    const installed = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'forger_list_installed_apps', arguments: {} },
    })).json());
    const updates = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'forger_check_updates', arguments: {} },
    })).json());
    const createdApp = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: {
        name: 'forger_create_app',
        arguments: {
          name: 'Planner',
          description: 'Organiza prioridades.',
          purpose: 'Ayuda a planificar la semana.',
          lookAndFeel: 'Claro y enfocado.',
        },
      },
    })).json());
    const status = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'forger_get_app_runtime_status', arguments: { appId: 'finance-os' } },
    })).json());
    const opened = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: { name: 'forger_open_app', arguments: { appId: 'finance-os' } },
    })).json());
    const refreshed = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'forger_refresh_app_view', arguments: { appId: 'finance-os' } },
    })).json());
    const updated = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'forger_update_app', arguments: { appId: 'finance-os' } },
    })).json());
    const prompts = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'forger_list_app_prompts', arguments: { appId: 'finance-os' } },
    })).json());
    const testedPrompt = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'forger_test_app_prompt',
        arguments: {
          appId: 'finance-os',
          kind: 'agentPrompt',
          id: 'advisor:initial',
          prompt: 'Review {{topic}}',
          variables: { topic: 'budget' },
        },
      },
    })).json());
    assert.equal(catalog.apps.length, 1);
    assert.equal(installed.apps.length, 1);
    assert.equal(updates.updates.length, 1);
    assert.equal(createdApp.success, true);
    assert.equal(createdApp.app.appId, 'created-app');
    assert.equal(createdApp.app.agentPrompt, undefined);
    assert.equal(status.status.status, 'running');
    assert.equal(opened.appId, 'finance-os');
    assert.equal(refreshed.userMessage, 'Vista refrescada.');
    assert.equal(updated.locale, undefined);
    assert.equal(prompts.prompts[0].id, 'assistant');
    assert.equal(testedPrompt.input.id, 'advisor:initial');
    assert.equal(testedPrompt.input.variables.topic, 'budget');

    const invalidPrompt = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'forger_update_app_prompt', arguments: { appId: 'finance-os', kind: 'bad' } },
    })).json());
    const invalidRestore = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'forger_restore_app_prompt', arguments: { appId: 'finance-os', kind: 'bad' } },
    })).json());
    const restored = parseToolTextResult(await (await callMcp(automationSession, {
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'forger_restore_app_prompt', arguments: { appId: 'finance-os', kind: 'agent', id: 'assistant' } },
    })).json());
    assert.equal(invalidPrompt.technicalCode, 'app_prompt_kind_invalid');
    assert.equal(invalidRestore.technicalCode, 'app_prompt_kind_invalid');
    assert.equal(restored.input.id, 'assistant');

    const memoryCreated = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'memory_create', arguments: { scope: 'global', kind: 'fact', text: 'Dato global' } },
    })).json());
    const memoryUpdated = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'memory_update', arguments: { id: 'mem-1', text: 'Nuevo' } },
    })).json());
    const memoryDeleted = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'memory_delete', arguments: { id: 'missing' } },
    })).json());
    const memoryFailed = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: { name: 'memory_list', arguments: { scope: 'global' } },
    })).json());
    assert.equal(memoryCreated.success, true);
    assert.equal(memoryCreated.memory.source, undefined);
    assert.equal(memoryUpdated.memory.text, 'Nuevo');
    assert.equal(memoryDeleted.success, false);
    assert.equal(memoryFailed.success, false);
    assert.equal(memoryFailed.technicalCode, 'memory_error');
    assert.equal(harness.logs.some((entry) => entry.payload?.reason === 'automation_non_interactive'), true);
  } finally {
    harness.stop();
  }
});

test('Forger MCP question tool validates input and rejects duplicate active questions', async () => {
  let activeQuestion = null;
  const harness = await createForgerMcpHarness({
    registerQuestion: async (runId, input) => {
      if (activeQuestion) {
        throw new Error('active_question_exists');
      }
      activeQuestion = {
        requestId: 'question-request-1',
        chatId: `${runId}-chat`,
        questions: input.questions,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      return activeQuestion;
    },
  });
  const session = harness.server.createSession('run-question', 'forger', { caller: 'free-chat', appIds: ['finance-os'] });
  try {
    const invalid = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'forger_ask_question',
        arguments: {
          questions: [{
            id: 'q1',
            question: 'Que prefieres?',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
              { id: 'c', label: 'C' },
              { id: 'd', label: 'D' },
            ],
          }],
        },
      },
    })).json());
    assert.equal(invalid.success, false);
    assert.equal(invalid.technicalCode, 'question_input_invalid');

    const missingDescription = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'forger_ask_question',
        arguments: {
          questions: [{
            id: 'missing-description',
            question: 'Que alcance quieres?',
            options: [
              { id: 'small', label: 'Simple' },
              { id: 'complete', label: 'Completo', description: 'Incluye flujo principal y ajustes.' },
            ],
          }],
        },
      },
    })).json());
    assert.equal(missingDescription.success, false);
    assert.equal(missingDescription.technicalCode, 'question_input_invalid');

    const created = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'forger_ask_question',
        arguments: {
          questions: [{
            id: 'scope',
            question: 'Que alcance quieres?',
            options: [
              { id: 'small', label: 'Simple', description: 'Aplica solo el flujo principal solicitado.' },
              { id: 'complete', label: 'Completo', description: 'Incluye flujo principal y ajustes.' },
            ],
          }],
        },
      },
    })).json());
    assert.equal(created.success, true);
    assert.equal(created.questionRequest.chatId, 'run-question-chat');
    assert.equal(created.questionRequest.questions[0].options[0].description, 'Aplica solo el flujo principal solicitado.');
    assert.equal(created.questionRequest.questions[0].options[1].description, 'Incluye flujo principal y ajustes.');

    const duplicate = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'forger_ask_question',
        arguments: {
          questions: [{
            id: 'again',
            question: 'Otra pregunta?',
            options: [
              { id: 'yes', label: 'Si', description: 'Continua con el alcance propuesto.' },
              { id: 'no', label: 'No', description: 'Mantiene la conversación detenida hasta aclarar el alcance.' },
            ],
          }],
        },
      },
    })).json());
    assert.equal(duplicate.success, false);
    assert.equal(duplicate.technicalCode, 'active_question_exists');
  } finally {
    harness.stop();
  }
});

test('Forger MCP tools exercise approved app runtime calls, memory access, and unavailable approval broker', async () => {
  const memoryCalls = [];
  const runtimeCalls = [];
  const harness = await createForgerMcpHarness({
    requestPermission: (_runId, request) => {
      if (request.permission === 'forger_open_app') {
        return null;
      }
      return Promise.resolve(true);
    },
    options: {
      openApp: async (appId) => {
        runtimeCalls.push(['open', appId]);
        return { success: true, appId, userMessage: 'Abierta.' };
      },
      stopApp: async (appId) => {
        runtimeCalls.push(['stop', appId]);
        return { success: true, appId, userMessage: 'Detenida.' };
      },
      memoryCreate: async (input, access) => {
        memoryCalls.push(['create', input, access]);
        return { id: 'mem-created', scope: input.scope, kind: input.kind, text: input.text, source: input.source };
      },
      memoryUpdate: async (input, access) => {
        memoryCalls.push(['update', input, access]);
        if (input.id === 'text-required') {
          throw new Error('memory_text_required');
        }
        if (input.id === 'app-required') {
          throw new Error('memory_app_required');
        }
        if (input.id === 'not-found') {
          throw new Error('memory_not_found');
        }
        if (input.id === 'generic-error') {
          throw new Error('unexpected_memory_backend_error');
        }
        return { id: input.id, scope: 'app', kind: 'fact', text: input.text ?? 'Updated' };
      },
      memoryDelete: async (id, access) => {
        memoryCalls.push(['delete', id, access]);
        return { success: true };
      },
    },
  });
  const desktopSession = harness.server.createSession('run-5', 'finance-os', { caller: 'desktop-chat', appIds: ['finance-os'] });
  const freeChatSession = harness.server.createSession('run-6', 'forger', { caller: 'free-chat', appIds: ['finance-os', 'recipes'] });

  try {
    const unavailable = parseToolTextResult(await (await callMcp(desktopSession, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forger_open_app', arguments: { appId: 'finance-os' } },
    })).json());
    assert.equal(unavailable.technicalCode, 'permission_unavailable');
    assert.equal(harness.logs.some((entry) => entry.event === 'agent_tool:approval_unavailable'), true);

    const stopped = parseToolTextResult(await (await callMcp(desktopSession, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'forger_stop_app', arguments: { appId: 'finance-os' } },
    })).json());
    assert.equal(stopped.success, true);
    assert.equal(stopped.authorization.status, 'approved');
    assert.deepEqual(runtimeCalls, [['stop', 'finance-os']]);

    const created = parseToolTextResult(await (await callMcp(freeChatSession, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_create', arguments: { scope: 'app', kind: 'fact', text: 'Dato app' } },
    })).json());
    assert.equal(created.memory.source, 'agent');
    assert.deepEqual(memoryCalls[0][2], {
      caller: 'free-chat',
      appId: undefined,
      appIds: ['finance-os', 'recipes'],
      runId: 'run-6',
    });

    const listed = parseToolTextResult(await (await callMcp(freeChatSession, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'memory_list', arguments: { scope: 'app' } },
    })).json());
    assert.equal(listed.memories[0].id, 'mem-1');

    const deleted = parseToolTextResult(await (await callMcp(freeChatSession, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'memory_delete', arguments: { id: 'mem-created' } },
    })).json());
    assert.equal(deleted.success, true);

    const textRequired = parseToolTextResult(await (await callMcp(freeChatSession, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'memory_update', arguments: { id: 'text-required' } },
    })).json());
    const appRequired = parseToolTextResult(await (await callMcp(freeChatSession, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'memory_update', arguments: { id: 'app-required' } },
    })).json());
    const notFound = parseToolTextResult(await (await callMcp(freeChatSession, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'memory_update', arguments: { id: 'not-found' } },
    })).json());
    const generic = parseToolTextResult(await (await callMcp(freeChatSession, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'memory_update', arguments: { id: 'generic-error' } },
    })).json());
    assert.equal(textRequired.technicalCode, 'memory_error');
    assert.equal(appRequired.technicalCode, 'memory_error');
    assert.equal(notFound.technicalCode, 'memory_error');
    assert.equal(generic.technicalCode, 'memory_error');
    assert.notEqual(textRequired.userMessage, appRequired.userMessage);
    assert.notEqual(notFound.userMessage, appRequired.userMessage);
    assert.notEqual(generic.userMessage, notFound.userMessage);
  } finally {
    harness.stop();
  }
});

test('Forger MCP server covers official execution, app prompt success, tool failures, and auth header fallbacks', async () => {
  const harness = await createForgerMcpHarness({
    approvals: { forger_open_app: false },
    toolDefinitions: [
      ...defaultMcpToolDefinitions,
      {
        id: 'gmail.search_messages',
        packageId: 'gmail',
        name: 'Buscar correos',
        description: 'Busca Gmail.',
        category: 'correo',
        risk: 'medio',
        defaultRequiresApproval: false,
      },
    ],
    options: {
      callOfficialTool: async (input) => ({ success: true, data: { actionId: input.actionId, query: input.input.query } }),
      updateAppPrompt: async (input) => ({ success: true, runtime: input.runtime, provider: input.provider, model: input.model, effort: input.effort, reasoningEffort: input.reasoningEffort }),
      openApp: async () => {
        throw new Error('open_failed');
      },
    },
  });
  const session = harness.server.createSession('run-4', 'finance-os', { caller: 'desktop-chat', appIds: ['finance-os'] });

  try {
    const arrayAuth = await fetch(session.url, {
      method: 'POST',
      headers: [
        ['authorization', `Bearer ${session.token}`],
        ['authorization', 'Bearer duplicate'],
      ],
      body: '{}',
    });
    assert.equal(arrayAuth.status, 401);

    const official = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'gmail.search_messages', arguments: { query: 'from:bank' } },
    })).json());
    assert.deepEqual(official, {
      success: true,
      data: { actionId: 'gmail.search_messages', query: 'from:bank' },
    });

    const prompt = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'forger_update_app_prompt',
        arguments: {
          appId: 'finance-os',
          kind: 'agentPrompt',
          id: 'assistant',
          prompt: 'Nueva instruccion',
          runtime: { provider: 'claude', model: 'claude-sonnet', effort: 'high' },
          provider: 'codex',
          model: 'gpt-5',
          effort: 'medium',
          reasoningEffort: 'xhigh',
        },
      },
    })).json());
    assert.equal(prompt.success, true);
    assert.deepEqual(prompt.runtime, { provider: 'claude', model: 'claude-sonnet', effort: 'high' });
    assert.equal(prompt.provider, 'codex');
    assert.equal(prompt.model, 'gpt-5');
    assert.equal(prompt.effort, 'medium');
    assert.equal(prompt.reasoningEffort, 'xhigh');

    const invalidRuntime = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'forger_update_app_prompt',
        arguments: {
          appId: 'finance-os',
          kind: 'agentPrompt',
          id: 'assistant',
          prompt: 'Ignora runtime invalido',
          runtime: [],
          provider: 'bad-provider',
          model: '   ',
          effort: 'bad-effort',
          reasoningEffort: 'bad-reasoning',
        },
      },
    })).json());
    assert.equal(invalidRuntime.success, true);
    assert.equal('runtime' in invalidRuntime, false);
    assert.equal('provider' in invalidRuntime, false);

    const incompleteRuntime = parseToolTextResult(await (await callMcp(session, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'forger_update_app_prompt',
        arguments: {
          appId: 'finance-os',
          kind: 'agentPrompt',
          id: 'assistant',
          prompt: 'Ignora runtime incompleto',
          runtime: { provider: 'codex' },
        },
      },
    })).json());
    assert.equal(incompleteRuntime.success, true);
    assert.equal('runtime' in incompleteRuntime, false);

    const failure = await callMcp(session, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'forger_open_app', arguments: { appId: 'finance-os' } },
    });
    const failurePayload = await failure.json();
    assert.equal(failure.status, 500);
    assert.equal(failurePayload.error.message, 'open_failed');
    assert.equal(harness.toolFailures.some((entry) => entry.error.message === 'open_failed'), true);
    assert.equal(harness.httpFailures.some((entry) => entry.error.message === 'open_failed'), true);
  } finally {
    harness.stop();
  }
});

test('app MCP manager ignores unsupported manifests and reports unsafe context start failures', async () => {
  assert.equal(findManifestMcp(null), null);
  assert.equal(findManifestMcp({ mcp: { type: 'stdio', command: 'python server.py' } }), null);
  assert.deepEqual(findManifestMcp({ mcp: { type: 'http', command: 'python server.py' } }), {
    type: 'http',
    command: 'python server.py',
  });

  const root = await mkdtemp(join(tmpdir(), 'forger-app-mcp-'));
  const appRoot = join(root, 'app');
  const failures = [];
  const logs = [];
  const manager = new AppMcpManager({
    getInstalledApp: () => ({
      appId: 'finance-os',
      installDir: appRoot,
      requiredPythonVersion: '3.12.0',
    }),
    resolveInstalledManifest: async () => ({
      mcp: {
        type: 'http',
        context: '../outside',
        command: 'python server.py',
        healthcheck: 'healthz',
        environment: { PYTHONPATH: 'src' },
      },
    }),
    ensureRuntimeInstalled: async () => ({ rootDir: join(root, 'python'), python: '/usr/bin/python3' }),
    ensureBackendPythonEnvironment: async () => undefined,
    getVenvExecutables: () => ({ python: '/usr/bin/python3', pip: '/usr/bin/pip3' }),
    getFreePort: async () => 4567,
    splitManifestCommand: (command) => command.split(/\s+/),
    ensurePathInside: (rootPath, targetPath) => {
      const normalizedRoot = `${resolve(rootPath)}/`;
      return resolve(targetPath).startsWith(normalizedRoot);
    },
    translateManifestEnvironment: (environment) => ({ ...environment }),
    ensureSqliteDatabaseParent: async () => undefined,
    getRuntimePathEntries: () => [],
    waitForHttpOk: async () => undefined,
    terminateProcess: async () => undefined,
    appendInstallLog: async (event, payload) => {
      logs.push({ event, payload });
    },
    truncateForInstallLog: (value) => value.slice(0, 80),
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    onMcpStartFailed: (input) => failures.push(input),
  });

  try {
    assert.deepEqual(await manager.listenMcps(['finance-os'], 'run-1'), []);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].appId, 'finance-os');
    assert.equal(failures[0].runId, 'run-1');
    assert.equal(failures[0].error.message, 'app_mcp_context_outside_app');
    assert.equal(logs.some((entry) => entry.event === 'app_mcp:start_failed'), true);
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('automation command helpers parse assistant messages and resolve Windows cmd shims safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-agent-command-'));
  const transcriptPath = join(root, 'run.log');
  await appendTranscript(transcriptPath, 'meta', 'started');
  assert.match(await readFile(transcriptPath, 'utf8'), /\[meta\] started\n$/);

  assert.deepEqual(parseCodexAssistantMessages('', ''), []);
  assert.deepEqual(parseCodexAssistantMessages('', [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'From stderr' } }),
  ].join('\n')), ['From stderr']);
  assert.deepEqual(parseCodexAssistantMessages([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'First' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'First' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Second' } }),
    JSON.stringify({ type: 'other', item: { type: 'agent_message', text: 'Ignored' } }),
    'not-json',
  ].join('\n')), ['First', 'Second']);
  assert.deepEqual(parseClaudeAssistantMessages('', ''), []);
  assert.deepEqual(parseClaudeAssistantMessages([
    JSON.stringify({ message: { content: [{ text: 'Hello' }, { text: 'World' }] } }),
    JSON.stringify({ text: 'Plain text' }),
    JSON.stringify({ result: 'Done' }),
    JSON.stringify({ type: 'assistant' }),
    JSON.stringify({ message: { content: [null, { value: 'ignored' }] } }),
    JSON.stringify({ message: { content: 123 } }),
    'not-json',
  ].join('\n')), ['Hello\nWorld', 'Plain text', 'Done']);

  const command = await resolveCodexCommand('/opt/codex/bin/codex', ['/usr/local/bin']);
  assert.deepEqual(command, {
    command: '/opt/codex/bin/codex',
    prefixArgs: [],
    pathEntries: ['/opt/codex/bin', '/usr/local/bin'],
  });

  const nodePath = join(root, 'node.exe');
  const codexCmd = join(root, 'node_modules', '.bin', 'codex.cmd');
  const codexEntrypoint = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await mkdir(join(root, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  await writeFile(nodePath, '', 'utf8');
  await writeFile(codexCmd, '', 'utf8');
  await writeFile(codexEntrypoint, '', 'utf8');
  const windowsCommand = await withPlatform('win32', async () => (
    await resolveCodexCommand(codexCmd, [root])
  ));
  assert.deepEqual(windowsCommand, {
    command: nodePath,
    prefixArgs: [codexEntrypoint],
    pathEntries: [root, join(root, 'node_modules', '.bin'), root],
  });

  await assert.rejects(
    withPlatform('win32', async () => await resolveCodexCommand(join(root, 'missing.cmd'), [])),
    /codex_js_entrypoint_missing/,
  );
  await assert.rejects(
    withPlatform('win32', async () => await resolveCodexCommand(codexCmd, [join(root, 'empty-bin')])),
    /codex_js_entrypoint_missing/,
  );
  await rm(root, { recursive: true, force: true });
});

test('automation command runner executes isolated Codex commands with MCP args and streams assistant messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-agent-command-runner-'));
  const codexHome = join(root, 'codex-home');
  const binDir = join(root, 'bin');
  const transcriptPath = join(root, 'run.log');
  const capturePath = join(root, 'capture.json');
  const fakeCli = join(root, 'fake-codex.js');
  const streamedMessages = [];
  await mkdir(codexHome, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), '{"token":"test"}', 'utf8');
  await writeFile(fakeCli, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
    '  args: process.argv.slice(2),',
    '  env: {',
    '    CODEX_HOME: process.env.CODEX_HOME,',
    '    FORGER_ALLOWED_ROOTS: process.env.FORGER_ALLOWED_ROOTS,',
    '    FORGER_MCP_TOKEN: process.env.FORGER_MCP_TOKEN,',
    '    FINANCE_MCP_TOKEN: process.env.FINANCE_MCP_TOKEN,',
    '    PATH: process.env.PATH,',
    '  },',
    '}));',
    'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Primero" } }));',
    'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Segundo" } }));',
    'console.error("diagnostic line");',
  ].join('\n'), 'utf8');
  await chmod(fakeCli, 0o755);

  try {
    const result = await runAgentCommand(
      { command: fakeCli, prefixArgs: [], pathEntries: [binDir] },
      {
        runtime: { provider: 'codex', model: '', effort: '' },
        cwd: root,
        codexHome,
        prompt: 'Haz la tarea',
        transcriptPath,
        mcpServers: [
          {
            name: 'forger',
            url: 'http://127.0.0.1:1/mcp',
            token: 'forger-token',
            tokenEnvVar: 'FORGER_MCP_TOKEN',
          },
          {
            name: 'finance-os',
            url: 'http://127.0.0.1:2/mcp',
            token: 'finance-token',
            tokenEnvVar: 'FINANCE_MCP_TOKEN',
            toolTimeoutSec: 42,
          },
        ],
        networkAccess: true,
        onAssistantMessages: (messages) => streamedMessages.push(messages),
      },
    );
    const capture = JSON.parse(await readFile(capturePath, 'utf8'));
    const transcript = await readFile(transcriptPath, 'utf8');

    assert.equal(result.code, 0);
    assert.deepEqual(parseCodexAssistantMessages(result.stdout), ['Primero', 'Segundo']);
    assert.equal(capture.env.FORGER_ALLOWED_ROOTS, root);
    assert.equal(capture.env.FORGER_MCP_TOKEN, 'forger-token');
    assert.equal(capture.env.FINANCE_MCP_TOKEN, 'finance-token');
    assert.equal(capture.env.PATH.split(delimiter)[0], binDir);
    assert.match(capture.env.CODEX_HOME, /forger-automation-codex-home-/);
    await assert.rejects(access(capture.env.CODEX_HOME));
    assert.ok(capture.args.includes('--ask-for-approval'));
    assert.ok(capture.args.includes('sandbox_workspace_write.network_access=true'));
    assert.ok(capture.args.includes('mcp_servers.finance-os.tool_timeout_sec=42'));
    assert.ok(capture.args.includes('apps.forger.default_tools_approval_mode="auto"'));
    assert.ok(capture.args.includes('gpt-5.3-codex'));
    assert.deepEqual(streamedMessages.at(-1), ['Primero', 'Segundo']);
    assert.match(transcript, /\[stdout\].*Primero/);
    assert.match(transcript, /\[stderr\] diagnostic line/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('automation command runner writes transient Claude MCP config and removes it after execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-claude-command-runner-'));
  const transcriptPath = join(root, 'run.log');
  const capturePath = join(root, 'claude-capture.json');
  const fakeClaude = join(root, 'fake-claude.js');
  await writeFile(fakeClaude, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const configIndex = args.indexOf("--mcp-config");',
    'const configPath = configIndex >= 0 ? args[configIndex + 1] : "";',
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
    '  args,',
    '  configPath,',
    '  config: configPath ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null,',
    '  env: { CODEX_HOME: process.env.CODEX_HOME, TOOL_TOKEN: process.env.TOOL_TOKEN },',
    '}));',
    'console.log(JSON.stringify({ message: { content: "Claude listo" } }));',
  ].join('\n'), 'utf8');
  await chmod(fakeClaude, 0o755);

  try {
    const result = await runAgentCommand(
      { command: fakeClaude, prefixArgs: [], pathEntries: [] },
      {
        runtime: { provider: 'claude', model: 'claude-sonnet', effort: 'high' },
        cwd: root,
        codexHome: join(root, 'codex-home'),
        prompt: 'Resume',
        transcriptPath,
        mcpServers: [{
          name: 'forger',
          url: 'http://127.0.0.1:1/mcp',
          token: 'tool-token',
          tokenEnvVar: 'TOOL_TOKEN',
        }],
        onAssistantMessages: (messages) => assert.deepEqual(messages, ['Claude listo']),
      },
    );
    const capture = JSON.parse(await readFile(capturePath, 'utf8'));

    assert.equal(result.code, 0);
    assert.deepEqual(parseClaudeAssistantMessages(result.stdout), ['Claude listo']);
    assert.equal(capture.env.CODEX_HOME, undefined);
    assert.equal(capture.env.TOOL_TOKEN, 'tool-token');
    assert.equal(capture.config.mcpServers.forger.headers.Authorization, 'Bearer ${TOOL_TOKEN}');
    assert.deepEqual(capture.args.slice(0, 2), ['-p', 'Resume']);
    assert.ok(capture.args.includes('--permission-mode'));
    await assert.rejects(access(capture.configPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('automation command runner records spawn errors and cleans transient Codex home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-agent-command-error-'));
  const codexHome = join(root, 'codex-home');
  const transcriptPath = join(root, 'run.log');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), '{"token":"test"}', 'utf8');

  try {
    await assert.rejects(
      runAgentCommand(
        { command: join(root, 'missing-codex'), prefixArgs: [], pathEntries: [] },
        {
          runtime: { provider: 'codex', model: 'gpt-test', effort: 'low' },
          cwd: root,
          codexHome,
          prompt: 'Haz la tarea',
          transcriptPath,
          mcpServers: [],
        },
      ),
      /ENOENT/,
    );
    const transcript = await readFile(transcriptPath, 'utf8');
    assert.match(transcript, /missing-codex exec/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('automation command runner records failed exits and timeout kills in transcripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-agent-command-failures-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), '{"token":"test"}', 'utf8');
  const failingCli = join(root, 'failing-codex.js');
  const hangingCli = join(root, 'hanging-codex.js');
  await writeFile(failingCli, [
    '#!/usr/bin/env node',
    'console.log("partial stdout");',
    'console.error("partial stderr");',
    'process.exit(7);',
  ].join('\n'), 'utf8');
  await writeFile(hangingCli, [
    '#!/usr/bin/env node',
    'console.log("started");',
    'setInterval(() => {}, 1000);',
  ].join('\n'), 'utf8');
  await chmod(failingCli, 0o755);
  await chmod(hangingCli, 0o755);

  try {
    const failed = await runAgentCommand(
      { command: failingCli, prefixArgs: [], pathEntries: [] },
      {
        runtime: { provider: 'codex', model: 'gpt-test', effort: 'low' },
        cwd: root,
        codexHome,
        prompt: 'Fail',
        transcriptPath: join(root, 'failed.log'),
        mcpServers: [],
      },
    );
    assert.equal(failed.code, 7);
    assert.equal(failed.stdout.trim(), 'partial stdout');
    assert.equal(failed.stderr.trim(), 'partial stderr');
    assert.match(await readFile(join(root, 'failed.log'), 'utf8'), /\[stderr\] partial stderr/);

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, _ms, ...args) => originalSetTimeout(callback, 5, ...args);
    try {
      await assert.rejects(
        runAgentCommand(
          { command: hangingCli, prefixArgs: [], pathEntries: [] },
          {
            runtime: { provider: 'codex', model: 'gpt-test', effort: 'low' },
            cwd: root,
            codexHome,
            prompt: 'Hang',
            transcriptPath: join(root, 'timeout.log'),
            mcpServers: [],
          },
        ),
        /codex_timeout_after_300000ms/,
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    const originalSetTimeoutForWindows = globalThis.setTimeout;
    globalThis.setTimeout = (callback, _ms, ...args) => originalSetTimeoutForWindows(callback, 5, ...args);
    try {
      await assert.rejects(
        withPlatform('win32', async () => await runAgentCommand(
          { command: hangingCli, prefixArgs: [], pathEntries: [] },
          {
            runtime: { provider: 'codex', model: 'gpt-test', effort: 'low' },
            cwd: root,
            codexHome,
            prompt: 'Hang on Windows',
            transcriptPath: join(root, 'timeout-windows.log'),
            mcpServers: [],
          },
        )),
        /codex_timeout_after_300000ms/,
      );
    } finally {
      globalThis.setTimeout = originalSetTimeoutForWindows;
    }
    const originalProcessKill = process.kill;
    const originalSetTimeoutForKillFailure = globalThis.setTimeout;
    process.kill = () => {
      throw new Error('process_group_kill_failed');
    };
    globalThis.setTimeout = (callback, _ms, ...args) => originalSetTimeoutForKillFailure(callback, 5, ...args);
    try {
      await assert.rejects(
        runAgentCommand(
          { command: hangingCli, prefixArgs: [], pathEntries: [] },
          {
            runtime: { provider: 'codex', model: 'gpt-test', effort: 'low' },
            cwd: root,
            codexHome,
            prompt: 'Hang after kill failure',
            transcriptPath: join(root, 'timeout-kill-failure.log'),
            mcpServers: [],
          },
        ),
        /codex_timeout_after_300000ms/,
      );
    } finally {
      process.kill = originalProcessKill;
      globalThis.setTimeout = originalSetTimeoutForKillFailure;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('automation manager records failed runs without invoking live credentials or network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-automation-'));
  const updates = [];
  const released = [];
  const manager = new AutomationManager({
    forgerHomeRoot: join(root, 'home'),
    metadataRoot: join(root, 'metadata'),
    codexHome: join(root, 'codex-home'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.3-codex', effort: 'low' }),
    getInstalledApps: () => [{ id: 'finance-os', name: 'Finance OS', status: 'installed', description: 'Finanzas' }],
    getCodexCliPath: async () => '/usr/bin/codex',
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getAgentNetworkAccess: async () => false,
    getCodexAuthenticated: async () => false,
    getClaudeAuthenticated: async () => false,
    createForgerMcpSession: () => {
      throw new Error('should_not_create_mcp_without_auth');
    },
    releaseForgerMcpSession: (token) => released.push(token),
    listenAppMcps: async () => {
      throw new Error('should_not_listen_app_mcps_without_auth');
    },
    releaseAppMcps: (runId) => released.push(`app:${runId}`),
    onAutomationUpdated: (event) => updates.push(event),
  });

  try {
    await manager.initialize();
    const automation = await manager.create({
      name: '   Weekly report   ',
      prompt: 'Run the report',
      selectedAppIds: ['finance-os', '../bad', 'finance-os'],
      enabled: false,
      frequency: { type: 'weekly', weeklyDay: 1, timeOfDay: '25:99' },
    });
    assert.equal(automation.name, 'Weekly report');
    assert.deepEqual(automation.selectedAppIds, ['finance-os']);
    assert.equal(automation.frequency.timeOfDay, '23:59');

    const queued = await manager.runNow(automation.id);
    assert.equal(queued.status, 'queued');

    let runs = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      runs = await manager.listRuns(automation.id);
      if (runs[0]?.status === 'failed') {
        break;
      }
      await wait(20);
    }

    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].error, 'codex_auth_missing');
    assert.equal(runs[0].userMessage, 'No se pudo ejecutar porque Codex no tiene una sesion activa.');
    const transcript = await manager.getRunTranscript(runs[0].id);
    assert.match(transcript.transcript, /Run failed: codex_auth_missing/);
    assert.deepEqual(released, [`app:${runs[0].id}`]);
    assert.equal(updates.some((event) => event.run?.status === 'failed'), true);
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('automation manager handles lifecycle validation, corrupted storage, and overlapping run skips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-automation-lifecycle-'));
  const fakeCodex = join(root, 'slow-codex.js');
  const metadataRoot = join(root, 'metadata');
  await mkdir(join(root, 'codex-home'), { recursive: true });
  await mkdir(metadataRoot, { recursive: true });
  await writeFile(join(root, 'codex-home', 'auth.json'), '{"token":"test"}', 'utf8');
  await writeFile(join(metadataRoot, 'automations.json'), '{bad json', 'utf8');
  await writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    'setTimeout(() => {',
    '  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Lento" } }));',
    '}, 150);',
  ].join('\n'), 'utf8');
  await chmod(fakeCodex, 0o755);
  const updates = [];
  const manager = new AutomationManager({
    forgerHomeRoot: root,
    metadataRoot,
    codexHome: join(root, 'codex-home'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.3-codex', effort: 'low' }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => fakeCodex,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getAgentNetworkAccess: async () => false,
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => false,
    releaseAppMcps: () => undefined,
    onAutomationUpdated: (event) => updates.push(event),
  });

  try {
    await manager.initialize();
    assert.deepEqual(manager.list(), []);
    await assert.rejects(manager.create({ name: ' ', prompt: 'Do it', selectedAppIds: [], enabled: false, frequency: { type: 'hourly' } }), /automation_name_required/);
    await assert.rejects(manager.create({ name: 'Name', prompt: ' ', selectedAppIds: [], enabled: false, frequency: { type: 'hourly' } }), /automation_prompt_required/);
    await assert.rejects(manager.update({ id: 'missing', name: 'Name', prompt: 'Do it', selectedAppIds: [], enabled: false, frequency: { type: 'hourly' } }), /automation_not_found/);
    assert.equal((await manager.delete('missing')).technicalCode, 'automation_not_found');

    const created = await manager.create({
      name: 'Lifecycle',
      prompt: 'Run slowly',
      selectedAppIds: ['finance-os'],
      enabled: true,
      frequency: { type: 'daily', timeOfDay: '07:15' },
    });
    assert.equal(created.enabled, true);
    assert.ok(created.nextRunAt);

    const updated = await manager.update({
      id: created.id,
      name: 'Lifecycle updated',
      prompt: 'Run slowly again',
      selectedAppIds: ['finance-os', 'recipes'],
      enabled: true,
      frequency: { type: 'weekly', weeklyDay: -10, timeOfDay: 'bad' },
    });
    assert.equal(updated.name, 'Lifecycle updated');
    assert.equal(updated.frequency.weeklyDay, 0);
    assert.equal(updated.frequency.timeOfDay, '09:00');

    const paused = await manager.pause(created.id);
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, null);
    const resumed = await manager.resume(created.id);
    assert.equal(resumed.enabled, true);
    assert.ok(resumed.nextRunAt);

    const firstRun = await manager.runNow(created.id);
    const skippedRun = await manager.runNow(created.id);
    assert.equal(firstRun.status, 'queued');
    assert.equal(skippedRun.status, 'skipped');
    assert.equal(skippedRun.error, 'automation_already_running');

    let runs = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      runs = await manager.listRuns(created.id);
      if (runs.some((run) => run.status === 'succeeded')) {
        break;
      }
      await wait(20);
    }
    assert.equal(runs.some((run) => run.status === 'succeeded'), true);
    assert.equal(updates.some((event) => event.run?.status === 'skipped'), true);

    await writeFile(join(metadataRoot, 'automation-runs', `${created.id}.index.json`), '{bad json', 'utf8');
    assert.deepEqual(await manager.listRuns(created.id), []);

    await writeFile(join(metadataRoot, 'automation-runs', `${created.id}.index.json`), JSON.stringify(['bad-run']), 'utf8');
    await writeFile(join(metadataRoot, 'automation-runs', 'bad-run.json'), '{bad json', 'utf8');
    assert.deepEqual(await manager.listRuns(created.id), []);

    assert.equal((await manager.delete(created.id)).success, true);
    assert.deepEqual(manager.list(), []);
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('automation manager records successful Codex runs with memory context and releases MCP sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-automation-success-'));
  const fakeCodex = join(root, 'fake-codex.js');
  const capturePath = join(root, 'codex-run.json');
  const updates = [];
  const released = [];
  await mkdir(join(root, 'codex-home'), { recursive: true });
  await writeFile(join(root, 'codex-home', 'auth.json'), '{"token":"test"}', 'utf8');
  await writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
    '  args: process.argv.slice(2),',
    '  env: { FORGER_MCP_TOKEN: process.env.FORGER_MCP_TOKEN, APP_MCP_TOKEN: process.env.APP_MCP_TOKEN },',
    '}));',
    'console.log(JSON.stringify({ type: "session.started" }));',
    'setTimeout(() => console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Parcial" } })), 5);',
    'setTimeout(() => console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Completado" } })), 10);',
    'setTimeout(() => console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Completado" } })), 15);',
  ].join('\n'), 'utf8');
  await chmod(fakeCodex, 0o755);

  const manager = new AutomationManager({
    forgerHomeRoot: root,
    metadataRoot: join(root, 'metadata'),
    codexHome: join(root, 'codex-home'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.3-codex', effort: 'medium' }),
    getInstalledApps: () => [{ id: 'finance-os', name: 'Finance OS', status: 'installed', description: 'Finanzas' }],
    getCodexCliPath: async () => fakeCodex,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getAgentNetworkAccess: async (appIds) => appIds.includes('finance-os'),
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => false,
    createForgerMcpSession: (runId, appId, appIds) => ({
      url: `http://127.0.0.1/${runId}/${appId}/${appIds.join(',')}`,
      token: 'forger-token',
    }),
    releaseForgerMcpSession: (token) => released.push(`forger:${token}`),
    buildMemoryContext: async () => 'MEMORIA:\n- Prefiere resumen corto.',
    listenAppMcps: async () => [{
      name: 'finance-os',
      url: 'http://127.0.0.1/app-mcp',
      token: 'app-token',
      tokenEnvVar: 'APP_MCP_TOKEN',
    }],
    releaseAppMcps: (runId) => released.push(`app:${runId}`),
    onAutomationUpdated: (event) => updates.push(event),
  });

  try {
    await manager.initialize();
    const automation = await manager.create({
      name: 'Daily',
      prompt: 'Run daily summary',
      selectedAppIds: ['finance-os'],
      enabled: false,
      frequency: { type: 'hourly' },
    });
    await manager.runNow(automation.id);

    let runs = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      runs = await manager.listRuns(automation.id);
      if (runs[0]?.status === 'succeeded') {
        break;
      }
      await wait(20);
    }

    const capture = JSON.parse(await readFile(capturePath, 'utf8'));
    const transcript = await manager.getRunTranscript(runs[0].id);
    assert.equal(runs[0].status, 'succeeded');
    assert.equal(runs[0].userMessage, 'Completado');
    assert.deepEqual(runs[0].userMessages, ['Parcial', 'Completado']);
    assert.match(transcript.transcript, /MEMORIA:/);
    assert.equal(capture.env.FORGER_MCP_TOKEN, 'forger-token');
    assert.equal(capture.env.APP_MCP_TOKEN, 'app-token');
    assert.ok(capture.args.includes('sandbox_workspace_write.network_access=true'));
    assert.deepEqual(released, [`forger:forger-token`, `app:${runs[0].id}`]);
    assert.equal(updates.some((event) => event.run?.status === 'succeeded'), true);
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('automation manager normalizes stored entries, trims app ids, and ignores malformed runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-automation-normalize-'));
  const metadataRoot = join(root, 'metadata');
  const updates = [];
  const manager = new AutomationManager({
    forgerHomeRoot: root,
    metadataRoot,
    codexHome: join(root, 'codex-home'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'low' }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => join(root, 'codex'),
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => false,
    onAutomationUpdated: (event) => updates.push(event),
  });

  try {
    await mkdir(metadataRoot, { recursive: true });
    await writeFile(join(metadataRoot, 'automations.json'), JSON.stringify([
      {
        id: 'stored',
        name: '  Stored automation  ',
        prompt: '  Do stored work  ',
        frequency: { type: 'weekly', timeOfDay: '99:99', weeklyDay: 9 },
        selectedAppIds: [' finance-os ', '../bad', 'finance-os', '', 'recipes_1'],
        enabled: true,
      },
    ]), 'utf8');

    await manager.initialize();
    const [stored] = manager.list();
    assert.equal(stored.name, 'Stored automation');
    assert.equal(stored.prompt, 'Do stored work');
    assert.deepEqual(stored.selectedAppIds, ['finance-os', 'recipes_1']);
    assert.deepEqual(stored.frequency, { type: 'weekly', timeOfDay: '23:59', weeklyDay: 6 });
    assert.equal(stored.running, false);
    assert.equal(typeof stored.nextRunAt, 'string');

    const updated = await manager.update({
      id: 'stored',
      name: 'Updated',
      prompt: 'Run',
      selectedAppIds: [' recipes-1 ', 'bad/path'],
      frequency: { type: 'daily', timeOfDay: '99:70' },
    });
    assert.equal(updated.enabled, true);
    assert.deepEqual(updated.selectedAppIds, ['recipes-1']);
    assert.deepEqual(updated.frequency, { type: 'daily', timeOfDay: '23:59' });

    await mkdir(join(metadataRoot, 'automation-runs'), { recursive: true });
    await writeFile(join(metadataRoot, 'automation-runs', 'stored.index.json'), JSON.stringify(['bad-json', 'missing']), 'utf8');
    await writeFile(join(metadataRoot, 'automation-runs', 'bad-json.json'), '{bad json', 'utf8');
    assert.deepEqual(await manager.listRuns('stored'), []);
    assert.equal(await manager.getRunTranscript('bad-json'), null);
    assert.equal(updates.length, 0);
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('automation manager maps missing provider setup to user-facing run failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-automation-cli-missing-'));
  const metadataRoot = join(root, 'metadata');
  const createManager = (provider, overrides = {}) => new AutomationManager({
    forgerHomeRoot: root,
    metadataRoot,
    codexHome: join(root, 'codex-home'),
    getAgentRuntime: async () => ({ provider, model: 'test-model', effort: 'low' }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => overrides.codexCliPath ?? null,
    getClaudeCliPath: async () => overrides.claudeCliPath ?? null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => overrides.codexAuthenticated ?? true,
    getClaudeAuthenticated: async () => overrides.claudeAuthenticated ?? true,
    onAutomationUpdated: () => undefined,
  });

  const codex = createManager('codex');
  const codexAuth = createManager('codex', {
    codexCliPath: process.execPath,
    codexAuthenticated: false,
  });
  const claude = createManager('claude');
  const claudeAuth = createManager('claude', {
    claudeCliPath: process.execPath,
    claudeAuthenticated: false,
  });
  try {
    await codex.initialize();
    await assert.rejects(() => codex.pause('missing'), /automation_not_found/);
    await assert.doesNotReject(() => codex.executeRun('missing-automation', 'missing-run'));
    await assert.doesNotReject(() => codex.updateLastRun('missing-automation', {
      id: 'missing-run',
      automationId: 'missing-automation',
      status: 'failed',
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      userMessage: 'Missing automation ignored.',
    }));
    const codexAutomation = await codex.create({
      name: 'Codex missing',
      prompt: 'Run',
      selectedAppIds: 'not-an-array',
      enabled: false,
      frequency: { type: 'hourly' },
    });
    assert.deepEqual(codexAutomation.selectedAppIds, []);
    await assert.doesNotReject(() => codex.updateRunUserMessage(codexAutomation.id, 'missing-run', 'Ignored', ['Ignored']));
    await codex.runNow(codexAutomation.id);

    let codexRuns = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      codexRuns = await codex.listRuns(codexAutomation.id);
      if (codexRuns[0]?.status === 'failed') {
        break;
      }
      await wait(20);
    }
    assert.equal(codexRuns[0].error, 'codex_cli_missing');
    assert.match(codexRuns[0].userMessage, /Codex no esta listo/);

    await codexAuth.initialize();
    const codexAuthAutomation = await codexAuth.create({
      name: 'Codex auth missing',
      prompt: 'Run',
      selectedAppIds: [],
      enabled: false,
      frequency: { type: 'hourly' },
    });
    await codexAuth.runNow(codexAuthAutomation.id);
    let codexAuthRuns = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      codexAuthRuns = await codexAuth.listRuns(codexAuthAutomation.id);
      if (codexAuthRuns[0]?.status === 'failed') {
        break;
      }
      await wait(20);
    }
    assert.equal(codexAuthRuns[0].error, 'codex_auth_missing');

    await claude.initialize();
    const claudeAutomation = await claude.create({
      name: 'Claude missing',
      prompt: 'Run',
      selectedAppIds: [],
      enabled: false,
      frequency: { type: 'hourly' },
    });
    await claude.runNow(claudeAutomation.id);

    let claudeRuns = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      claudeRuns = await claude.listRuns(claudeAutomation.id);
      if (claudeRuns[0]?.status === 'failed') {
        break;
      }
      await wait(20);
    }
    assert.equal(claudeRuns[0].error, 'claude_cli_missing');
    assert.match(claudeRuns[0].userMessage, /Claude Code no esta listo/);

    await claudeAuth.initialize();
    const claudeAuthAutomation = await claudeAuth.create({
      name: 'Claude auth',
      prompt: 'Run',
      selectedAppIds: [],
      enabled: false,
      frequency: { type: 'hourly' },
    });
    await claudeAuth.runNow(claudeAuthAutomation.id);

    let claudeAuthRuns = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      claudeAuthRuns = await claudeAuth.listRuns(claudeAuthAutomation.id);
      if (claudeAuthRuns[0]?.status === 'failed') {
        break;
      }
      await wait(20);
    }
    assert.equal(claudeAuthRuns[0].error, 'claude_auth_missing');
    assert.match(claudeAuthRuns[0].userMessage, /Claude Code no tiene una sesion activa/);
  } finally {
    codex.dispose();
    claude.dispose();
    claudeAuth.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('automation manager rejects run ids that escape run storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-automation-paths-'));
  const metadataRoot = join(root, 'metadata');
  const manager = new AutomationManager({
    forgerHomeRoot: root,
    metadataRoot,
    codexHome: join(root, 'codex-home'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'low' }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => join(root, 'codex'),
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => false,
    onAutomationUpdated: () => undefined,
  });

  try {
    await manager.initialize();
    const automation = await manager.create({
      name: 'Path guard',
      prompt: 'Run',
      selectedAppIds: [],
      enabled: false,
      frequency: { type: 'hourly' },
    });

    await mkdir(join(metadataRoot, 'automation-runs'), { recursive: true });
    await writeFile(
      join(metadataRoot, 'automation-runs', `${automation.id}.index.json`),
      JSON.stringify(['../outside']),
      'utf8',
    );

    await assert.rejects(manager.getRunTranscript('../outside'), /automation_run_path_outside_storage/);
    await assert.rejects(manager.listRuns(automation.id), /automation_run_path_outside_storage/);
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('automation manager maps Codex timeout exits to the timeout user message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-automation-timeout-'));
  const fakeCodex = join(root, 'timeout-codex.js');
  await mkdir(join(root, 'codex-home'), { recursive: true });
  await writeFile(join(root, 'codex-home', 'auth.json'), '{"token":"test"}', 'utf8');
  await writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    'console.error("codex_timeout_after_1000");',
    'process.exit(1);',
  ].join('\n'), 'utf8');
  await chmod(fakeCodex, 0o755);

  const manager = new AutomationManager({
    forgerHomeRoot: root,
    metadataRoot: join(root, 'metadata'),
    codexHome: join(root, 'codex-home'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'low' }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => fakeCodex,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getAgentNetworkAccess: async () => false,
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => false,
    releaseAppMcps: () => undefined,
    onAutomationUpdated: () => undefined,
  });

  try {
    await manager.initialize();
    const automation = await manager.create({
      name: 'Timeout',
      prompt: 'Run',
      selectedAppIds: [],
      enabled: false,
      frequency: { type: 'hourly' },
    });
    await manager.runNow(automation.id);

    let runs = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      runs = await manager.listRuns(automation.id);
      if (runs[0]?.status === 'failed') {
        break;
      }
      await wait(20);
    }

    assert.equal(runs[0].error, 'codex_timeout_after_1000');
    assert.equal(runs[0].userMessage, 'La automatizacion se detuvo porque tardo demasiado en responder.');
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('automation manager runs due stored schedules and keeps enabled automations scheduled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-automation-scheduled-'));
  const metadataRoot = join(root, 'metadata');
  const fakeCodex = join(root, 'scheduled-codex.js');
  const capturePath = join(root, 'scheduled-capture.json');
  const updates = [];
  await mkdir(join(root, 'codex-home'), { recursive: true });
  await mkdir(metadataRoot, { recursive: true });
  await writeFile(join(root, 'codex-home', 'auth.json'), '{"token":"test"}', 'utf8');
  await writeFile(join(metadataRoot, 'automations.json'), JSON.stringify([
    {
      id: 'scheduled',
      name: 'Scheduled report',
      prompt: 'Run scheduled report',
      frequency: { type: 'hourly' },
      selectedAppIds: [],
      enabled: true,
      running: true,
      nextRunAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]), 'utf8');
  await writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
    '  args: process.argv.slice(2),',
    '  prompt: process.argv.at(-1),',
    '  cwd: process.cwd(),',
    '}));',
    'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Scheduled done" } }));',
  ].join('\n'), 'utf8');
  await chmod(fakeCodex, 0o755);

  const manager = new AutomationManager({
    forgerHomeRoot: root,
    metadataRoot,
    codexHome: join(root, 'codex-home'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'low' }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => fakeCodex,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getAgentNetworkAccess: async () => false,
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => false,
    releaseAppMcps: () => undefined,
    onAutomationUpdated: (event) => updates.push(event),
  });

  try {
    await manager.initialize();

    let runs = [];
    let [scheduled] = manager.list();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      runs = await manager.listRuns('scheduled');
      [scheduled] = manager.list();
      if (runs[0]?.status === 'succeeded' && scheduled.running === false) {
        break;
      }
      await wait(20);
    }

    const capture = JSON.parse(await readFile(capturePath, 'utf8'));
    assert.equal(runs[0].trigger, 'scheduled');
    assert.equal(runs[0].status, 'succeeded');
    assert.equal(runs[0].userMessage, 'Scheduled done');
    assert.equal(scheduled.running, false);
    assert.equal(scheduled.enabled, true);
    assert.ok(Date.parse(scheduled.nextRunAt) > Date.now());
    assert.match(capture.prompt, /Run scheduled report/);
    assert.equal(updates.some((event) => event.automation.running === true && event.run?.status === 'queued'), true);
    assert.equal(updates.some((event) => event.automation.running === false && event.run?.status === 'succeeded'), true);
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('automation next-run calculation handles hourly, daily, and weekly rollover', () => {
  assert.equal(
    computeNextRunAt({ type: 'hourly' }, new Date('2026-05-21T10:15:00.000Z')),
    '2026-05-21T11:15:00.000Z',
  );
  const daily = new Date(computeNextRunAt(
    { type: 'daily', timeOfDay: '09:30' },
    new Date(2026, 4, 21, 10, 0, 0, 0),
  ));
  assert.equal(daily.getDate(), 22);
  assert.equal(daily.getHours(), 9);
  assert.equal(daily.getMinutes(), 30);
  assert.ok(daily > new Date(2026, 4, 21, 10, 0, 0, 0));

  const weekly = new Date(computeNextRunAt(
    { type: 'weekly', weeklyDay: 4, timeOfDay: '10:30' },
    new Date(2026, 4, 21, 10, 0, 0, 0),
  ));
  assert.equal(weekly.getDay(), 4);
  assert.equal(weekly.getHours(), 10);
  assert.equal(weekly.getMinutes(), 30);
  assert.ok(weekly > new Date(2026, 4, 21, 10, 0, 0, 0));
  const nextThursday = new Date(computeNextRunAt(
    { type: 'weekly', weeklyDay: 4, timeOfDay: '10:00' },
    new Date(2026, 4, 21, 14, 0, 0, 0),
  ));
  assert.equal(nextThursday.getDay(), 4);
  assert.equal(nextThursday.getHours(), 10);
  assert.equal(nextThursday.getMinutes(), 0);
  assert.ok(nextThursday > new Date(2026, 4, 21, 14, 0, 0, 0));
});
