import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createManifestSupportController } = require('../../dist-electron/main/apps/manifest-support.js');
const { renderManifestAgentPrompt } = require('../../dist-electron/main/manifest-agent-prompts.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const defaults = {
  codex: { model: 'gpt-default', reasoningEffort: 'medium' },
  claude: { model: 'claude-default', effort: 'medium' },
};

const createController = (overrides = {}) => {
  const registry = overrides.registry ?? { apps: {} };
  const promptOverridesStore = overrides.promptOverridesStore ?? {
    applyToPromptTemplates: async (_appId, templates) => templates,
    applyToAgents: async (_appId, agents) => agents,
    list: async () => [],
    validate: async () => ({ valid: true, errors: [], missingVariables: [], extraVariables: [] }),
    update: async (_appId, _bases, input) => ({ id: input.promptId, prompt: input.prompt }),
    restore: async (_appId, _bases, input) => ({ id: input.promptId }),
  };
  const controller = createManifestSupportController({
    fs: overrides.fs ?? fs,
    path: overrides.path ?? path,
    app: { getPath: (name) => `/user-data/${name}` },
    shell: overrides.shell ?? { openExternal: async () => undefined },
    state: overrides.state ?? { secretsStore: null, officialToolsService: null, memoryStore: null, backupsManager: null },
    forgerBackendClient: overrides.forgerBackendClient ?? null,
    forgerAccount: overrides.forgerAccount ?? { authenticated: false, token: null },
    registry,
    catalogApps: overrides.catalogApps ?? [],
    runningApps: overrides.runningApps ?? new Map(),
    cloudSyncSettings: overrides.cloudSyncSettings ?? { appSync: {} },
    settings: { agentDefaults: defaults },
    normalizeSettings: () => ({ agentDefaults: defaults }),
    normalizeCodexReasoningEffort: (value, fallback) => ['low', 'medium', 'high'].includes(value) ? value : fallback,
    normalizeClaudeEffort: (value, fallback) => ['low', 'medium', 'high', 'max'].includes(value) ? value : fallback,
    getCodexDefaults: () => defaults.codex,
    BUILT_IN_CODEX_REASONING: 'medium',
    BUILT_IN_CLAUDE_EFFORT: 'medium',
    CLAUDE_EFFORT_VALUES: new Set(['low', 'medium', 'high', 'max']),
    CODEX_REASONING_VALUES: new Set(['low', 'medium', 'high']),
    SecretsStore: overrides.SecretsStore ?? class {},
    OfficialToolsService: overrides.OfficialToolsService ?? class {},
    MemoryStore: overrides.MemoryStore ?? class {},
    BackupsManager: overrides.BackupsManager ?? class {},
    getForgerMetadataRoot: () => '/metadata',
    getBackupsRoot: () => overrides.backupsRoot ?? '/backups',
    getTempRoot: () => overrides.tempRoot ?? '/tmp',
    getFreePort: async () => 12345,
    getPromptOverridesStore: () => promptOverridesStore,
    getCloudIdentityStore: () => overrides.cloudIdentityStore ?? ({ signText: async () => null }),
    hashFileSha256: overrides.hashFileSha256 ?? (async () => 'checksum'),
    zipDirectory: overrides.zipDirectory ?? (async () => undefined),
    validateArchiveEntries: overrides.validateArchiveEntries ?? (async () => undefined),
    extractArchive: overrides.extractArchive ?? (async () => undefined),
    appendInstallLog: overrides.appendInstallLog ?? (async () => undefined),
    canUseCloudDataSync: overrides.canUseCloudDataSync ?? (() => false),
    renderManifestAgentPrompt,
    withAgentDefaults: (entry, agentDefaults = defaults) => ({
      ...entry,
      runtimeRecommendations: {
        codex: {
          model: entry.runtimeRecommendations?.codex?.model ?? entry.model ?? agentDefaults.codex.model,
          reasoningEffort: entry.runtimeRecommendations?.codex?.reasoningEffort
            ?? entry.reasoningEffort
            ?? agentDefaults.codex.reasoningEffort,
        },
        claude: {
          model: entry.runtimeRecommendations?.claude?.model ?? agentDefaults.claude.model,
          effort: entry.runtimeRecommendations?.claude?.effort ?? agentDefaults.claude.effort,
        },
      },
      model: entry.model ?? agentDefaults.codex.model,
      reasoningEffort: entry.reasoningEffort ?? agentDefaults.codex.reasoningEffort,
    }),
  });
  return { controller, registry };
};

test('manifest support normalizes prompt templates, agents, variables, runtime, arguments, and secrets', () => {
  const { controller } = createController();
  const manifest = {
    promptTemplates: [
      {
        id: ' summary ',
        title: ' Summary ',
        prompt: ' Review {{file}} ',
        description: ' Monthly review ',
        acceptedFileTypes: ['text/csv', '', 42],
        model: ' gpt-template ',
        reasoningEffort: 'high',
        runtime: { provider: 'codex', model: ' gpt-runtime ', effort: 'low' },
        runtimeRecommendations: {
          codex: { defaultModel: 'gpt-recommended', defaultEffort: 'medium' },
          claude: { model: 'claude-recommended', effort: 'high' },
        },
        arguments: [
          { name: 'file', type: 'file', required: true, multiple: true, acceptedFileTypes: ['text/csv', null], maxBytes: 10 },
          { name: 'file', type: 'string' },
          { name: 'ignored', type: 'number' },
        ],
      },
      { id: 'summary', title: 'Duplicate', prompt: 'drop me' },
      { id: 'empty', title: '', prompt: 'drop me' },
    ],
    agents: [
      {
        id: ' advisor ',
        title: ' Advisor ',
        description: ' Helps ',
        kind: 'orchestrator',
        prompts: {
          initial: {
            body: 'Open {{file}}',
            variables: {
              file: { type: 'path', required: true },
              bad: { type: 'date' },
              'bad space': { type: 'text' },
            },
            runtime: { provider: 'claude', model: ' sonnet ', effort: 'max' },
          },
          steer: { body: ' Steer ', variables: { topic: { type: 'text', required: false } } },
        },
        runtimeRecommendations: { codex: { model: 'gpt-agent', reasoningEffort: 'high' } },
      },
      { id: 'advisor', title: 'Duplicate', initialPrompt: 'drop me' },
      { id: 'bad', title: 'Bad', prompts: { initial: { body: '' } } },
    ],
    appSecrets: [
      { name: ' api key ', usage: ' Used for imports ', label: ' API Key ', required: true },
      { name: 'api key', usage: 'duplicate env name' },
      { name: 'PATH', usage: 'reserved' },
      null,
    ],
  };

  assert.deepEqual(controller.normalizeManifestPromptTemplates(manifest), [
    {
      id: 'summary',
      title: 'Summary',
      prompt: 'Review {{file}}',
      description: 'Monthly review',
      arguments: [
        {
          name: 'file',
          type: 'file',
          required: true,
          multiple: true,
          acceptedFileTypes: ['text/csv'],
          maxBytes: 10,
        },
      ],
      acceptedFileTypes: ['text/csv'],
      model: 'gpt-template',
      reasoningEffort: 'high',
      runtime: { provider: 'codex', model: 'gpt-runtime', effort: 'low' },
      runtimeRecommendations: {
        codex: { model: 'gpt-recommended', reasoningEffort: 'medium' },
        claude: { model: 'claude-recommended', effort: 'high' },
      },
    },
  ]);

  assert.deepEqual(controller.normalizeManifestAgents(manifest), [
    {
      id: 'advisor',
      title: 'Advisor',
      initialPrompt: 'Open {{file}}',
      description: 'Helps',
      kind: 'orchestrator',
      prompts: {
        initial: {
          body: 'Open {{file}}',
          variables: { file: { type: 'path', required: true } },
          runtime: { provider: 'claude', model: 'sonnet', effort: 'max' },
        },
        steer: {
          body: 'Steer',
          variables: { topic: { type: 'text', required: false } },
        },
      },
      runtimeRecommendations: {
        codex: { model: 'gpt-agent', reasoningEffort: 'high' },
      },
    },
  ]);

  assert.deepEqual(controller.normalizeManifestAppSecrets(manifest), [
    { name: 'api key', required: true, usage: 'Used for imports', label: 'API Key' },
  ]);
  assert.equal(controller.getManifestAppSecretsValidationError(manifest), 'La app declara secretos duplicados para la variable API_KEY.');
});

test('manifest support covers runtime defaults, prompt variable, and secret edge normalizers', async () => {
  const { controller } = createController();

  assert.equal(controller.normalizeToken(undefined), '');
  assert.equal(controller.normalizeToken('  API Key  '), 'api key');
  assert.equal(controller.ensurePathInside('/apps/demo', '/apps/demo'), true);
  assert.equal(controller.ensurePathInside('/apps/demo', '/apps/demo/data/report.csv'), true);
  assert.equal(controller.ensurePathInside('/apps/demo', '/apps/other/report.csv'), false);
  assert.equal(controller.toPosixRelativePath('backend\\data\\app.sqlite3'), 'backend/data/app.sqlite3');

  assert.deepEqual(controller.normalizeManifestRuntime({ provider: 'claude', model: ' sonnet ', effort: 'not-real' }), {
    provider: 'claude',
    model: 'sonnet',
    effort: 'medium',
  });
  assert.deepEqual(controller.normalizeManifestRuntime({ provider: 'codex', model: ' gpt-5 ', effort: 'not-real' }), {
    provider: 'codex',
    model: 'gpt-5',
    effort: 'medium',
  });
  assert.equal(controller.normalizeManifestRuntime({ provider: 'codex', model: '   ' }), undefined);
  assert.equal(controller.normalizeManifestRuntime({ provider: 'other', model: 'model' }), undefined);
  assert.equal(controller.normalizeManifestRuntime([]), undefined);

  assert.deepEqual(controller.normalizeManifestAgentDefaults(null), defaults);
  assert.deepEqual(controller.normalizeManifestAgentDefaults({ agentProviders: [] }), defaults);
  assert.deepEqual(controller.normalizeManifestAgentDefaults({
    agentProviders: {
      codex: { defaultModel: ' gpt-provider ', defaultEffort: 'high' },
      claude: { defaultModel: ' claude-provider ', defaultEffort: 'max' },
    },
  }), {
    codex: { model: 'gpt-provider', reasoningEffort: 'high' },
    claude: { model: 'claude-provider', effort: 'max' },
  });

  assert.equal(controller.normalizeManifestAgentKind('classic'), 'classic');
  assert.equal(controller.normalizeManifestAgentKind('thread_interface'), 'thread_interface');
  assert.equal(controller.normalizeManifestAgentKind('agent_invocation'), 'agent_invocation');
  assert.equal(controller.normalizeManifestAgentKind('worker'), undefined);

  assert.deepEqual(controller.normalizeManifestAgentPromptVariables({
    'user.name': { type: 'text', required: true },
    'account-id': { type: 'json', required: false },
    _path: { type: 'path' },
    bad: [],
    'bad space': { type: 'text' },
    unsupported: { type: 'number' },
  }), {
    'user.name': { type: 'text', required: true },
    'account-id': { type: 'json', required: false },
    _path: { type: 'path' },
  });
  assert.deepEqual(controller.normalizeManifestAgentPromptVariables([]), {});
  assert.equal(controller.normalizeManifestAgentPromptTemplate({ body: '   ' }), undefined);
  assert.equal(controller.normalizeManifestAgentPrompts([]), undefined);

  assert.equal(controller.isReservedAppSecretEnvName('NPM_TOKEN'), true);
  assert.equal(controller.normalizeAppSecretDeclaration({ name: 'npm token', usage: 'Reserved' }), null);
  assert.equal(controller.normalizeAppSecretDeclaration({ name: 'Webhook', usage: '' }), null);
  assert.equal(controller.getManifestAppSecretsValidationError({ appSecrets: [null] }), 'La app declara un secreto invalido.');
  assert.equal(
    controller.getManifestAppSecretsValidationError({ appSecrets: [{ name: 'Webhook', usage: '' }] }),
    'La app declara un secreto incompleto.',
  );
  assert.equal(
    controller.getManifestAppSecretsValidationError({ appSecrets: [{ name: 'PATH', usage: 'Reserved' }] }),
    'La app declara un secreto con un nombre reservado: PATH.',
  );

  assert.deepEqual(controller.normalizeManifestPromptTemplates({
    promptTemplates: [{
      id: 'legacy',
      title: 'Legacy',
      prompt: 'Use defaults',
      model: 'gpt-legacy',
      reasoningEffort: 'low',
      runtimeRecommendations: { codex: [], claude: { defaultModel: ' claude-alt ', defaultEffort: 'low' } },
      arguments: [
        { name: 'notes', type: 'string', maxLength: 500 },
        { name: 'badMax', type: 'file', maxBytes: -1, acceptedFileTypes: ['', 'application/pdf'] },
      ],
    }],
  }), [{
    id: 'legacy',
    title: 'Legacy',
    prompt: 'Use defaults',
    arguments: [
      { name: 'notes', type: 'string', maxLength: 500 },
      { name: 'badMax', type: 'file', acceptedFileTypes: ['application/pdf'] },
    ],
    model: 'gpt-legacy',
    reasoningEffort: 'low',
    runtimeRecommendations: {
      codex: { model: 'gpt-legacy', reasoningEffort: 'low' },
      claude: { model: 'claude-alt', effort: 'low' },
    },
  }]);
  assert.deepEqual(controller.normalizeManifestAgents({
    agents: [{
      id: 'templated',
      title: 'Templated',
      initialPrompt: 'Start',
      initialPromptTemplate: 'start-here',
      prompts: { resume: { body: 'Resume', runtimeRecommendations: { codex: { effort: 'high' } } } },
    }],
  }), [{
    id: 'templated',
    title: 'Templated',
    initialPrompt: 'Start',
    initialPromptTemplate: 'start-here',
    prompts: {
      resume: {
        body: 'Resume',
        runtimeRecommendations: { codex: { model: 'gpt-default', reasoningEffort: 'high' } },
      },
    },
  }]);
  assert.deepEqual(controller.normalizePromptTemplateArguments([null, 'bad', { name: 'ok', type: 'string' }]), [
    { name: 'ok', type: 'string' },
  ]);
  assert.deepEqual(await controller.resolveInstalledPromptTemplates('missing'), []);
  assert.deepEqual(await controller.resolveInstalledAgents('missing'), []);
  assert.equal(controller.getManifestAppSecretsValidationError(null), null);
  assert.equal(controller.getManifestAppSecretsValidationError({ appSecrets: 'bad' }), null);
});

test('manifest support covers malformed manifest fallbacks and cloud backup guard branches', async () => {
  const officialToolOptions = [];
  class FakeOfficialToolsService {
    constructor(options) {
      officialToolOptions.push(options);
    }

    async list() {
      return { tools: [] };
    }

    async listAgentActionIdsForApp() {
      return new Set();
    }
  }
  const backupManager = {
    async createBackup() {
      return {
        success: true,
        backup: { appId: 'finance-os', backupId: 'b1', appName: 'Finance OS', appVersion: '1.0.0' },
      };
    },
    backupDirectory() {
      return null;
    },
  };
  const { controller } = createController({
    state: {
      secretsStore: null,
      officialToolsService: null,
      memoryStore: null,
      backupsManager: backupManager,
    },
    registry: { apps: { 'finance-os': { appId: 'finance-os', name: 'Finance OS', version: '1.0.0', installDir: '/apps/finance-os' } } },
    forgerBackendClient: { listRemoteBackups: async () => ({ backups: [] }) },
    forgerAccount: { authenticated: true, token: 'token' },
    canUseCloudDataSync: () => true,
  });

  assert.equal(await controller.anyAppAllowsAgentNetworkAccess(['missing-app']), false);
  assert.deepEqual(controller.normalizeManifestAppSecrets(null), []);
  assert.deepEqual(controller.normalizeManifestAppSecrets({ appSecrets: 'bad' }), []);
  assert.deepEqual(controller.normalizeManifestPromptTemplates({
    promptTemplates: [null, 'bad', { id: '', title: 'Missing id', prompt: 'Prompt' }],
  }), []);
  assert.deepEqual(controller.normalizeManifestAgents({
    agents: [null, 'bad', { id: '', title: 'Missing id', initialPrompt: 'Prompt' }],
  }), []);
  assert.deepEqual(await controller.resolveAppToolDeclarations('catalog-missing'), null);
  assert.equal((await controller.createRemoteAppBackup({ appId: 'finance-os' })).technicalCode, 'local_backup_missing');

  const noAccountTools = createController({
    OfficialToolsService: FakeOfficialToolsService,
    forgerBackendClient: {},
    forgerAccount: { authenticated: false, token: null },
  }).controller;
  const service = noAccountTools.getOfficialToolsService();
  assert.equal(service instanceof FakeOfficialToolsService, true);
  await assert.rejects(() => officialToolOptions[0].getGmailOAuthClientId(), /forger_account_required/);
  await assert.rejects(() => officialToolOptions[0].exchangeGmailOAuthCode({ code: 'abc' }), /forger_account_required/);
  await assert.rejects(() => officialToolOptions[0].refreshGmailOAuthAccessToken({ refreshToken: 'secret' }), /forger_account_required/);

  const missingBackend = createController({
    canUseCloudDataSync: () => true,
  }).controller;
  assert.equal((await missingBackend.restoreRemoteAppBackup(1)).technicalCode, 'backend_client_missing');

  const missingSubscription = createController({
    forgerBackendClient: { listRemoteBackups: async () => ({ backups: [] }) },
    canUseCloudDataSync: () => false,
  }).controller;
  assert.equal((await missingSubscription.restoreRemoteAppBackup(1)).technicalCode, 'subscription_required');

  const backupOptions = [];
  class FakeBackupsManager {
    constructor(options) {
      backupOptions.push(options);
    }
  }
  const backupController = createController({
    BackupsManager: FakeBackupsManager,
    registry: { apps: { 'finance-os': { appId: 'finance-os', name: 'Finance OS', version: '2.0.0', installDir: '/apps/finance-os' } } },
  }).controller;
  backupController.getBackupsManager();
  assert.deepEqual(backupOptions[0].getInstalledApp('finance-os'), {
    appId: 'finance-os',
    name: 'Finance OS',
    version: '2.0.0',
    installDir: '/apps/finance-os',
  });
});

test('manifest support resolves installed manifests before catalog declarations and applies defaults', async (t) => {
  const root = await tmpRoot('manifest-support');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'finance-os');
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    agentProviders: {
      codex: { model: 'gpt-manifest', reasoningEffort: 'high' },
      claude: { model: 'claude-manifest', effort: 'max' },
    },
    agentRuntime: { networkAccess: true },
    tools: {
      required: [{ toolId: 'gmail', reason: 'Read mail', actions: ['gmail.read'] }, { toolId: '', reason: 'drop', actions: ['x'] }],
      optional: [{ toolId: 'gmail', reason: 'Send mail', actions: ['gmail.send'] }],
    },
    promptTemplates: [{ id: 'summary', title: 'Summary', prompt: 'Summarize' }],
    agents: [{ id: 'advisor', title: 'Advisor', initialPrompt: 'Help' }],
  }), 'utf8');

  const { controller, registry } = createController({
    registry: {
      apps: {
        'finance-os': { appId: 'finance-os', name: 'Finance OS Local', installDir, version: '1.0.0', status: 'installed' },
      },
    },
    catalogApps: [
      {
        id: 'finance-os',
        name: 'Finance OS Catalog',
        tools: { required: [{ toolId: 'catalog', reason: 'Catalog tool', actions: ['catalog.only'] }] },
        agents: [{ id: 'catalog-agent', title: 'Catalog Agent', initialPrompt: 'Catalog' }],
        promptTemplates: [{ id: 'catalog-template', title: 'Catalog Template', prompt: 'Catalog' }],
      },
      {
        id: 'recipes',
        name: 'Recipes',
        tools: { required: [{ toolId: 'recipes', reason: 'Search', actions: ['recipes.search'] }] },
        agents: [{ id: 'chef', title: 'Chef', initialPrompt: 'Cook' }],
        promptTemplates: [{ id: 'recipe', title: 'Recipe', prompt: 'Write' }],
      },
    ],
  });

  assert.equal(registry.apps['finance-os'].installDir, installDir);
  assert.equal(await controller.appAllowsAgentNetworkAccess('finance-os'), true);
  assert.equal(await controller.anyAppAllowsAgentNetworkAccess(['missing', 'finance-os']), true);

  const declarations = await controller.resolveAppToolDeclarations('finance-os');
  assert.equal(declarations.appName, 'Finance OS Local');
  assert.deepEqual(declarations.required.map((tool) => [tool.toolId, tool.actions]), [['gmail', ['gmail.read']]]);
  assert.deepEqual(declarations.optional.map((tool) => [tool.toolId, tool.actions]), [['gmail', ['gmail.send']]]);
  assert.deepEqual(declarations.agents.map((agent) => agent.id), ['advisor']);
  assert.deepEqual(declarations.promptTemplates.map((template) => template.id), ['summary']);

  const catalogDeclarations = await controller.resolveAppToolDeclarations('recipes');
  assert.equal(catalogDeclarations.appName, 'Recipes');
  assert.deepEqual(catalogDeclarations.required.map((tool) => [tool.toolId, tool.actions]), [['recipes', ['recipes.search']]]);
  assert.deepEqual(catalogDeclarations.agents.map((agent) => agent.id), ['chef']);
  assert.equal(await controller.resolveAppToolDeclarations('missing'), null);

  const agents = await controller.resolveInstalledAgents('finance-os');
  assert.equal(agents[0].model, 'gpt-manifest');
  assert.equal(agents[0].reasoningEffort, 'high');
  assert.equal(agents[0].runtimeRecommendations.claude.model, 'claude-manifest');

  const templates = await controller.resolveInstalledPromptTemplates('finance-os');
  assert.equal(templates[0].model, 'gpt-manifest');
});

test('manifest support handles invalid manifests and legacy codex conversation fallback', async (t) => {
  const root = await tmpRoot('manifest-support-legacy');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const validDir = path.join(root, 'valid');
  const invalidDir = path.join(root, 'invalid');
  await fs.mkdir(validDir, { recursive: true });
  await fs.mkdir(invalidDir, { recursive: true });
  await fs.writeFile(path.join(validDir, 'manifest.json'), JSON.stringify({
    codexConversation: { enabled: true },
  }), 'utf8');
  await fs.writeFile(path.join(invalidDir, 'manifest.json'), '{not json', 'utf8');
  const arrayDir = path.join(root, 'array');
  await fs.mkdir(arrayDir, { recursive: true });
  await fs.writeFile(path.join(arrayDir, 'manifest.json'), JSON.stringify([{ agentRuntime: { networkAccess: true } }]), 'utf8');

  const { controller } = createController({
    registry: {
      apps: {
        legacy: { appId: 'legacy', name: 'Legacy', installDir: validDir, version: '1.0.0', status: 'installed' },
        broken: { appId: 'broken', name: 'Broken', installDir: invalidDir, version: '1.0.0', status: 'installed' },
        array: { appId: 'array', name: 'Array', installDir: arrayDir, version: '1.0.0', status: 'installed' },
      },
    },
  });

  assert.equal(await controller.resolveInstalledManifest(invalidDir), null);
  assert.equal(await controller.resolveInstalledManifest(arrayDir), null);
  assert.equal(await controller.appAllowsAgentNetworkAccess('broken'), false);
  assert.equal(await controller.appAllowsAgentNetworkAccess('array'), false);
  assert.deepEqual(await controller.resolveInstalledPromptTemplates('broken'), []);
  assert.equal(await controller.hasInstalledCodexConversation('legacy'), true);

  const agents = await controller.resolveInstalledAgents('legacy');
  assert.deepEqual(agents.map((agent) => [agent.id, agent.legacy]), [['legacy-codex-conversation', true]]);
});

test('manifest support builds app secret state and prompt override fallback responses', async (t) => {
  const root = await tmpRoot('manifest-support-secrets');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'app');
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    appSecrets: [
      { name: 'API Key', usage: 'Connects to provider', label: 'API Key', required: true },
      { name: 'Webhook', usage: 'Receives events' },
    ],
    promptTemplates: [{ id: 'summary', title: 'Summary', prompt: 'Summarize {{topic}}' }],
  }), 'utf8');

  class FakeSecretsStore {
    async listUserSecrets() {
      return [{ id: 'secret-1', name: 'Personal API Key' }];
    }

    async getMappedSecretId(_appId, name) {
      return name === 'API Key' ? 'secret-1' : 'missing-secret';
    }
  }

  const promptOverridesStore = {
    applyToPromptTemplates: async (_appId, templates) => templates,
    applyToAgents: async (_appId, agents) => agents,
    list: async (_appId, bases) => bases.map((base) => ({ id: base.id, title: base.title, currentPrompt: base.prompt })),
    validate: async () => {
      throw new Error('validation failed');
    },
    update: async () => {
      throw new Error('update failed');
    },
    restore: async () => {
      throw new Error('restore failed');
    },
  };

  const { controller } = createController({
    SecretsStore: FakeSecretsStore,
    promptOverridesStore,
    registry: {
      apps: {
        secrets: { appId: 'secrets', name: 'Secrets App', installDir, version: '1.0.0', status: 'installed' },
      },
    },
  });

  assert.deepEqual(await controller.resolveInstalledAppSecrets('missing'), []);
  assert.deepEqual(await controller.resolveInstalledAppSecrets('secrets'), [
    { name: 'API Key', required: true, usage: 'Connects to provider', label: 'API Key' },
    { name: 'Webhook', required: false, usage: 'Receives events' },
  ]);

  const state = await controller.buildAppSecretsState('secrets');
  assert.equal(state.appName, 'Secrets App');
  assert.deepEqual(state.appSecrets.map((entry) => ({
    name: entry.appSecret.name,
    envName: entry.envName,
    connected: entry.connected,
    userSecretName: entry.userSecretName,
  })), [
    { name: 'API Key', envName: 'API_KEY', connected: true, userSecretName: 'Personal API Key' },
    { name: 'Webhook', envName: 'WEBHOOK', connected: false, userSecretName: undefined },
  ]);

  assert.equal((await controller.listAppPrompts('missing')).length, 0);
  const validation = await controller.validateAppPrompt({ appId: 'secrets', promptId: 'summary', prompt: 'Hi' });
  assert.equal(validation.valid, false);
  assert.equal(validation.missingVariables.length, 0);
  assert.equal((await controller.updateAppPrompt({ appId: 'secrets', promptId: 'summary', prompt: 'Hi' })).success, false);
  assert.equal((await controller.restoreAppPrompt({ appId: 'secrets', promptId: 'summary' })).success, false);
});

test('manifest support handles remote backup safety, checksum, signatures, and cleanup branches', async (t) => {
  const root = await tmpRoot('manifest-support-remote-backups');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const tempRoot = path.join(root, 'tmp');
  const removed = [];
  const fsWithRmCapture = {
    ...fs,
    rm: async (target, options) => {
      removed.push(path.relative(root, target));
      return await fs.rm(target, options);
    },
  };
  const localBackup = {
    appId: 'finance-os',
    appName: 'Finance OS',
    appVersion: '1.0.0',
    backupId: 'backup-1',
    createdAt: '2026-05-21T00:00:00Z',
    reason: 'manual',
    fileCount: 1,
    totalBytes: 4,
    files: [],
  };
  const backupsManager = {
    async createBackup() {
      return { success: true, backup: localBackup };
    },
    backupDirectory() {
      return path.join(root, 'local-backup');
    },
    async restoreBackupDirectory(input) {
      return { success: true, userMessage: `restored:${input.appId}:${path.basename(input.backupDir)}` };
    },
  };
  await fs.mkdir(path.join(root, 'local-backup'), { recursive: true });
  const remoteBackups = [{
    id: 7,
    appId: 'finance-os',
    appName: 'Finance OS',
    backupId: 'backup-1',
    checksumSha256: 'remote-checksum',
  }];
  const backendCalls = [];
  const backendClient = {
    async createRemoteBackup(input) {
      backendCalls.push(['create', input]);
      return { success: true, remoteBackup: { id: 7 } };
    },
    async listRemoteBackups() {
      backendCalls.push(['list']);
      return { backups: remoteBackups };
    },
    async downloadRemoteBackup(id, downloadPath) {
      backendCalls.push(['download', id, path.relative(root, downloadPath)]);
      await fs.mkdir(path.dirname(downloadPath), { recursive: true });
      await fs.writeFile(downloadPath, 'zip', 'utf8');
      return { checksumSha256: 'download-checksum' };
    },
  };
  const { controller } = createController({
    fs: fsWithRmCapture,
    state: { secretsStore: null, officialToolsService: null, memoryStore: null, backupsManager },
    forgerBackendClient: backendClient,
    forgerAccount: { authenticated: true, token: 'token' },
    canUseCloudDataSync: () => true,
    tempRoot,
    hashFileSha256: async (filePath) => filePath.endsWith('.zip') ? 'download-checksum' : 'other',
    zipDirectory: async (_source, archivePath) => {
      await fs.mkdir(path.dirname(archivePath), { recursive: true });
      await fs.writeFile(archivePath, 'zip', 'utf8');
    },
    validateArchiveEntries: async () => undefined,
    extractArchive: async (_archive, destination) => {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, 'metadata.json'), '{}', 'utf8');
    },
    cloudIdentityStore: {
      signText: async () => ({ signature: 'sig', keyFingerprint: 'fingerprint', algorithm: 'rsa-sha256' }),
    },
  });

  assert.equal((await controller.createRemoteAppBackup({ appId: 'finance-os', backupType: 'manual' })).success, true);
  const createCall = backendCalls.find(([kind]) => kind === 'create')[1];
  assert.equal(createCall.signature, 'sig');
  assert.equal(createCall.signatureKeyFingerprint, 'fingerprint');
  assert.equal(createCall.source, 'manual');
  assert.ok(removed.some((entry) => entry.endsWith('.zip')));

  const restored = await controller.restoreRemoteAppBackup(7);
  assert.equal(restored.success, true);
  assert.match(restored.userMessage, /^restored:finance-os:/);
  assert.ok(removed.some((entry) => entry.includes('-extracted-')));

  assert.equal((await controller.restoreRemoteAppBackup(99)).technicalCode, 'remote_backup_not_found');

  const mismatchController = createController({
    state: { secretsStore: null, officialToolsService: null, memoryStore: null, backupsManager },
    forgerBackendClient: backendClient,
    forgerAccount: { authenticated: true, token: 'token' },
    canUseCloudDataSync: () => true,
    tempRoot,
    hashFileSha256: async () => 'wrong-checksum',
  }).controller;
  await assert.rejects(mismatchController.restoreRemoteAppBackup(7), /remote_backup_checksum_mismatch/);

  assert.equal((await createController().controller.createRemoteAppBackup({ appId: 'finance-os' })).technicalCode, 'backend_client_missing');
  assert.equal((await createController({ forgerBackendClient: backendClient }).controller.createRemoteAppBackup({ appId: 'finance-os' })).technicalCode, 'cloud_account_required');
  assert.equal((await createController({
    forgerBackendClient: backendClient,
    forgerAccount: { authenticated: true, token: 'token' },
    canUseCloudDataSync: () => false,
  }).controller.createRemoteAppBackup({ appId: 'finance-os' })).technicalCode, 'subscription_required');
});

test('manifest support lazy services build memory/tool contexts, prompt successes, sync logs, and backup helpers', async (t) => {
  const serviceInstances = [];
  const memoryContexts = [];
  const installLogs = [];
  const openedUrls = [];
  const backendCalls = [];
  const backupOptions = [];
  class FakeOfficialToolsService {
    constructor(options) {
      this.options = options;
      serviceInstances.push(this);
    }

    async list() {
      return { tools: [{ id: 'gmail', status: 'configured' }] };
    }

    async listAgentActionIdsForApp(appId) {
      return new Set([`gmail.read:${appId}`]);
    }
  }
  class FakeMemoryStore {
    constructor(root) {
      this.root = root;
    }

    async buildContext(input) {
      memoryContexts.push({ root: this.root, input });
      return `memory:${input.caller}:${input.appId ?? input.appIds.join(',')}`;
    }
  }
  class FakeBackupsManager {
    constructor(options) {
      this.options = options;
      backupOptions.push(options);
    }

    async createBackup() {
      return { success: false, userMessage: 'backup failed', technicalCode: 'backup_failed' };
    }
  }
  const promptOverridesStore = {
    applyToPromptTemplates: async (_appId, templates) => templates,
    applyToAgents: async (_appId, agents) => agents,
    list: async (_appId, bases) => bases,
    validate: async () => ({ valid: true, errors: [], missingVariables: [], extraVariables: [] }),
    update: async (_appId, _bases, input) => ({ id: input.promptId, prompt: input.prompt }),
    restore: async (_appId, _bases, input) => ({ id: input.promptId, prompt: 'original' }),
  };
  const installDir = await tmpRoot('manifest-services');
  t.after(async () => {
    await fs.rm(installDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    promptTemplates: [{ id: 'summary', title: 'Summary', prompt: 'Summarize' }],
  }), 'utf8');
  const runningApps = new Map([['finance-os', {}]]);
  const { controller: testController } = createController({
    OfficialToolsService: FakeOfficialToolsService,
    MemoryStore: FakeMemoryStore,
    BackupsManager: FakeBackupsManager,
    promptOverridesStore,
    registry: {
      apps: {
        'finance-os': { appId: 'finance-os', name: 'Finance OS', installDir, version: '1.0.0', status: 'installed' },
      },
    },
    runningApps,
  });
  testController.getBackupsManager();
  assert.equal(backupOptions[0].isAppRunning('finance-os'), true);
  assert.equal(backupOptions[0].getInstalledApp('missing'), undefined);
  assert.deepEqual(backupOptions[0].listInstalledApps()[0].appId, 'finance-os');

  assert.equal(await testController.buildMemoryContextForApp('finance-os'), 'memory:app-agent:finance-os');
  assert.equal(await testController.buildMemoryContextForApps(['finance-os']), 'memory:automation:finance-os');
  assert.equal(memoryContexts.length, 2);
  assert.match(await testController.buildForgerToolsContextForApp('finance-os'), /gmail/i);
  assert.match(await testController.buildForgerToolsContextForFreeChat(), /gmail/i);
  assert.equal(serviceInstances.length, 1);

  await assert.rejects(serviceInstances[0].options.getGmailOAuthClientId(), /forger_account_required/);

  assert.deepEqual(await testController.updateAppPrompt({ appId: 'finance-os', promptId: 'summary', prompt: 'New' }), {
    success: true,
    userMessage: 'Prompt actualizado.',
    prompt: { id: 'summary', prompt: 'New' },
  });
  assert.deepEqual(await testController.restoreAppPrompt({ appId: 'finance-os', promptId: 'summary' }), {
    success: true,
    userMessage: 'Prompt original restaurado.',
    prompt: { id: 'summary', prompt: 'original' },
  });
  assert.equal(testController.getManifestAppSecretsValidationError({ appSecrets: [] }), null);
  assert.equal(testController.formatProcessOutputForInstallLog('visible', []), 'visible');
  assert.equal(
    testController.formatProcessOutputForInstallLog('secret output', ['secret']),
    '[salida omitida porque la app recibio secretos]',
  );

  const syncController = createController({
    OfficialToolsService: FakeOfficialToolsService,
    MemoryStore: FakeMemoryStore,
    BackupsManager: FakeBackupsManager,
    cloudSyncSettings: { appSync: { 'finance-os': { autoSync: true } } },
    canUseCloudDataSync: () => true,
    forgerBackendClient: { createRemoteBackup: async () => ({ success: true }) },
    forgerAccount: { authenticated: true, token: 'token' },
    appendInstallLog: async (event, payload) => installLogs.push({ event, payload }),
  }).controller;
  await syncController.syncAppToCloudIfEnabled('finance-os');
  await syncController.syncAppToCloudIfEnabled('disabled');
  assert.deepEqual(installLogs, [{
    event: 'cloud_sync:auto_failed',
    payload: { appId: 'finance-os', technicalCode: 'backup_failed' },
  }]);

  const oauthController = createController({
    OfficialToolsService: FakeOfficialToolsService,
    shell: { openExternal: async (url) => openedUrls.push(url) },
    forgerBackendClient: {
      getGmailOAuthClientId: async () => {
        backendCalls.push(['client-id']);
        return 'gmail-client-id';
      },
      exchangeGmailOAuthCode: async (input) => {
        backendCalls.push(['exchange', input]);
        return { accessToken: 'access', refreshToken: 'refresh' };
      },
      refreshGmailOAuthAccessToken: async (input) => {
        backendCalls.push(['refresh', input]);
        return { accessToken: 'next-access' };
      },
    },
    forgerAccount: { authenticated: true, token: 'token' },
  }).controller;
  oauthController.getOfficialToolsService();
  const oauthOptions = serviceInstances.at(-1).options;
  await oauthOptions.openExternalUrl('https://accounts.google.test');
  assert.deepEqual(openedUrls, ['https://accounts.google.test']);
  assert.equal(oauthOptions.isForgerAccountAuthenticated(), true);
  assert.equal(await oauthOptions.getGmailOAuthClientId(), 'gmail-client-id');
  assert.deepEqual(await oauthOptions.exchangeGmailOAuthCode({ code: 'code-1' }), {
    accessToken: 'access',
    refreshToken: 'refresh',
  });
  assert.deepEqual(await oauthOptions.refreshGmailOAuthAccessToken({ refreshToken: 'refresh' }), {
    accessToken: 'next-access',
  });
  assert.deepEqual(backendCalls.map(([kind]) => kind), ['client-id', 'exchange', 'refresh']);

  const unauthenticatedController = createController({
    OfficialToolsService: FakeOfficialToolsService,
  }).controller;
  unauthenticatedController.getOfficialToolsService();
  await assert.rejects(serviceInstances.at(-1).options.exchangeGmailOAuthCode({ code: 'code-2' }), /forger_account_required/);
});
