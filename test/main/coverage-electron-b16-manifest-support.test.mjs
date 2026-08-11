import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createManifestSupportController } = require('../../dist-electron/main/apps/manifest-support.js');
const { renderManifestAgentPrompt } = require('../../dist-electron/main/manifest-agent-prompts.js');

const defaults = {
  codex: { model: 'gpt-default', reasoningEffort: 'medium' },
  claude: { model: 'claude-default', effort: 'medium' },
};

const createController = (overrides = {}) => {
  const registry = overrides.registry ?? { apps: {} };
  const promptOverridesStore = overrides.promptOverridesStore ?? {
    applyToPromptTemplates: async (_appId, templates) => templates,
    applyToAgents: async (_appId, agents) => agents,
    list: async (_appId, bases) => bases,
    validate: async () => ({ valid: true, errors: [], missingVariables: [], extraVariables: [] }),
    update: async () => ({}),
    restore: async () => ({}),
  };
  return createManifestSupportController({
    fs: overrides.fs ?? fs,
    path: overrides.path ?? path,
    app: { getPath: () => '/user-data' },
    shell: overrides.shell ?? { openExternal: async () => undefined },
    state: overrides.state ?? {
      secretsStore: null, officialToolsService: null, connectionsService: null, memoryStore: null, backupsManager: null,
    },
    forgerBackendClient: overrides.forgerBackendClient ?? null,
    forgerAccount: overrides.forgerAccount ?? { authenticated: false, token: null },
    getForgerBackendClient: overrides.getForgerBackendClient,
    getForgerAccount: overrides.getForgerAccount,
    getRegistry: overrides.getRegistry,
    registry,
    catalogApps: overrides.catalogApps ?? [],
    runningApps: overrides.runningApps ?? new Map(),
    cloudSyncSettings: overrides.cloudSyncSettings ?? { appSync: {} },
    settings: { agentDefaults: overrides.agentDefaults ?? defaults },
    normalizeSettings: () => ({ agentDefaults: overrides.agentDefaults ?? defaults }),
    normalizeCodexReasoningEffort: (value, fallback) => ['low', 'medium', 'high'].includes(value) ? value : fallback,
    normalizeClaudeEffort: (value, fallback) => ['low', 'medium', 'high', 'max'].includes(value) ? value : fallback,
    getCodexDefaults: () => defaults.codex,
    BUILT_IN_CODEX_REASONING: 'medium',
    BUILT_IN_CLAUDE_EFFORT: 'medium',
    CLAUDE_EFFORT_VALUES: new Set(['low', 'medium', 'high', 'max']),
    CODEX_REASONING_VALUES: new Set(['low', 'medium', 'high']),
    SecretsStore: overrides.SecretsStore ?? class {},
    OfficialToolsService: overrides.OfficialToolsService ?? class {},
    ConnectionsService: overrides.ConnectionsService ?? class {},
    MemoryStore: overrides.MemoryStore ?? class {},
    BackupsManager: overrides.BackupsManager ?? class {},
    getForgerMetadataRoot: () => '/metadata',
    getBackupsRoot: () => '/backups',
    getTempRoot: () => overrides.tempRoot ?? '/tmp',
    getFreePort: async () => 12345,
    getSelfOAuthCallbackService: overrides.getSelfOAuthCallbackService,
    getPromptOverridesStore: () => promptOverridesStore,
    getCloudIdentityStore: () => overrides.cloudIdentityStore ?? ({ signText: async () => null }),
    hashFileSha256: overrides.hashFileSha256 ?? (async () => 'checksum'),
    zipDirectory: overrides.zipDirectory ?? (async () => undefined),
    validateArchiveEntries: overrides.validateArchiveEntries ?? (async () => undefined),
    extractArchive: overrides.extractArchive ?? (async () => undefined),
    appendInstallLog: overrides.appendInstallLog ?? (async () => undefined),
    emitOfficialToolEvent: overrides.emitOfficialToolEvent,
    canUseCloudDataSync: overrides.canUseCloudDataSync ?? (() => false),
    renderManifestAgentPrompt: overrides.renderManifestAgentPrompt ?? renderManifestAgentPrompt,
    withAgentDefaults: (entry) => entry,
  });
};

test('given a lazy Connections service, OAuth and manifest callbacks use the current secure dependencies', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b16-manifest-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let capturedOptions;
  class ConnectionsService {
    constructor(options) { capturedOptions = options; }

    async listConnectionsForApp() {
      return {
        requirements: [{
          granted: false,
          declaration: { type: 'gmail', reason: 'Read mail', actions: ['gmail.search_messages'] },
          definition: { type: 'gmail', displayName: 'Gmail' },
          resolvedActions: [{ id: 'gmail.search_messages', name: 'Search' }],
          instances: [],
        }],
      };
    }

    async listState() { return {}; }
  }
  class OfficialToolsService {
    async list() { return { tools: [] }; }

    async listAgentActionIdsForApp() { return new Set(); }
  }
  const manifest = {
    connections: [{ type: 'gmail', reason: 'Read mail', actions: ['gmail.search_messages'] }],
    agents: [{ id: 'agent', title: 'Agent', initialPrompt: 'Help' }],
    promptTemplates: [{ id: 'summary', title: 'Summary', prompt: 'Summarize' }],
  };
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  const opened = [];
  let account = { token: null };
  let backend = null;
  const controller = createController({
    ConnectionsService,
    OfficialToolsService,
    registry: { apps: { notes: { appId: 'notes', installDir: root } } },
    catalogApps: [{ id: 'catalog', name: undefined, connections: manifest.connections }],
    shell: { openExternal: async (url) => opened.push(url) },
    getForgerAccount: () => account,
    getForgerBackendClient: () => backend,
    getSelfOAuthCallbackService: () => ({ start: async () => undefined }),
  });
  controller.getConnectionsService();
  await capturedOptions.openExternalUrl('https://accounts.test');
  assert.equal(capturedOptions.isForgerAccountAuthenticated(), false);
  await assert.rejects(capturedOptions.getGmailOAuthClientId(), /forger_account_required/);
  await assert.rejects(capturedOptions.exchangeGmailOAuthCode({ code: 'code' }), /forger_account_required/);
  await assert.rejects(capturedOptions.refreshGmailOAuthAccessToken({ refreshToken: 'refresh' }), /forger_account_required/);

  account = { token: 'token' };
  backend = {
    getGmailOAuthClientId: async () => 'client-id',
    exchangeGmailOAuthCode: async (input) => ({ input }),
    refreshGmailOAuthAccessToken: async (input) => ({ input }),
  };
  assert.equal(capturedOptions.isForgerAccountAuthenticated(), true);
  assert.equal(await capturedOptions.getGmailOAuthClientId(), 'client-id');
  assert.deepEqual(await capturedOptions.exchangeGmailOAuthCode({ code: 'code' }), { input: { code: 'code' } });
  assert.deepEqual(await capturedOptions.refreshGmailOAuthAccessToken({ refreshToken: 'refresh' }), { input: { refreshToken: 'refresh' } });
  assert.deepEqual(opened, ['https://accounts.test']);

  assert.equal((await controller.resolveAppConnectionDeclarations('notes')).appName, 'notes');
  assert.equal((await controller.resolveAppConnectionDeclarations('catalog')).appName, 'catalog');
  assert.equal(await controller.resolveAppConnectionDeclarations('missing'), null);
  assert.equal((await controller.resolveAppToolDeclarations('notes')).appName, 'notes');
  assert.equal((await controller.resolveAppToolDeclarations('catalog')).appName, 'catalog');
  assert.match(await controller.buildForgerToolsContextForApp('notes'), /Declared app Connections/);
  assert.match(await controller.buildForgerToolsContextForFreeChat(), /Connections available/);

  class EmptyConnectionsService {
    async listConnectionsForApp() { return undefined; }

    async listState() { return undefined; }
  }
  const emptyController = createController({ ConnectionsService: EmptyConnectionsService, OfficialToolsService });
  assert.match(await emptyController.buildForgerToolsContextForApp('notes'), /has not declared any Connections/);
  assert.match(await emptyController.buildForgerToolsContextForFreeChat(), /Connections available/);
});

test('given runtime and prompt variants, defaults and render validation remain deterministic', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b16-prompts-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const manifest = {
    agentProviders: { antigravity: { model: 'gemini-3-pro', effort: 'high' } },
    promptTemplates: [{
      id: 'template', title: 'Template', prompt: 'Hello {{name}}',
      arguments: [{ name: 'name', type: 'string', required: true }],
    }, { id: 'plain', title: 'Plain', prompt: 'No variables' }],
    agents: [{ id: 'agent', title: 'Agent', initialPrompt: 'Plain {{topic}}' }],
  };
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  const controller = createController({ registry: { apps: { prompts: { appId: 'prompts', installDir: root } } } });

  assert.deepEqual(controller.normalizeManifestAgentDefaults(manifest).antigravity, { model: 'gemini-3.5-flash', effort: 'high' });
  assert.deepEqual(controller.normalizeManifestRuntime({ provider: 'antigravity', model: 'gemini-3-pro', permissionMode: 'safe' }), {
    provider: 'antigravity', model: 'gemini-3.5-flash', effort: 'medium', permissionMode: 'safe',
  });
  assert.equal(controller.normalizeManifestAgents({
    agents: [{ id: 'safe', title: 'Safe', initialPrompt: 'Help', permissionMode: 'safe' }],
  })[0].runtime.permissionMode, 'safe');

  assert.equal((await controller.testAppPrompt({ appId: 'missing', kind: 'agent', id: 'agent' })).technicalCode, 'app_prompt_not_found');
  assert.equal((await controller.testAppPrompt({ appId: 'prompts', kind: 'invalid', id: 'agent' })).technicalCode, 'app_prompt_kind_invalid');
  assert.equal((await controller.testAppPrompt({ appId: 'prompts', kind: 'agent', id: 'missing' })).technicalCode, 'app_prompt_not_found');
  assert.equal((await controller.testAppPrompt({ appId: 'prompts', kind: 'agent', id: 'agent' })).success, true);

  const withoutVariables = await controller.testAppPrompt({ appId: 'prompts', kind: 'promptTemplate', id: 'template' });
  assert.equal(withoutVariables.success, true);
  const invalid = await controller.testAppPrompt({
    appId: 'prompts', kind: 'promptTemplate', id: 'template', prompt: 'Hello {{name}}', variables: { extra: true },
  });
  assert.equal(invalid.technicalCode, 'app_prompt_invalid');
  assert.deepEqual(invalid.missingVariables, ['name']);
  assert.deepEqual(invalid.extraVariables, ['extra']);
  assert.equal((await controller.testAppPrompt({
    appId: 'prompts', kind: 'promptTemplate', id: 'template', variables: { name: 2 },
  })).technicalCode, 'app_prompt_invalid');
  assert.equal((await controller.testAppPrompt({
    appId: 'prompts', kind: 'promptTemplate', id: 'plain', variables: {},
  })).success, true);

  const noReviewController = createController({
    registry: { apps: { prompts: { appId: 'prompts', installDir: root } } },
    promptOverridesStore: {
      applyToPromptTemplates: async (_appId, templates) => templates,
      applyToAgents: async (_appId, agents) => agents,
      list: async () => [],
      validate: async () => ({ valid: true, errors: [], missingVariables: [], extraVariables: [] }),
    },
  });
  assert.equal((await noReviewController.testAppPrompt({
    appId: 'prompts', kind: 'promptTemplate', id: 'plain',
  })).renderedPrompt, 'No variables');

  const changingManifest = {
    agents: [{ id: 'agent', title: 'Agent', prompts: { initial: { body: 'Help' } } }],
  };
  let reads = 0;
  const changedController = createController({
    fs: {
      ...fs,
      readFile: async () => JSON.stringify((reads += 1) === 1 ? changingManifest : { agents: [] }),
    },
    registry: { apps: { prompts: { appId: 'prompts', installDir: root } } },
  });
  assert.equal((await changedController.testAppPrompt({
    appId: 'prompts', kind: 'agentPrompt', id: 'agent:initial',
  })).technicalCode, 'app_prompt_not_found');

  const brokenController = createController({
    registry: { apps: { prompts: { appId: 'prompts', installDir: root } } },
    promptOverridesStore: {
      applyToPromptTemplates: async (_appId, templates) => templates,
      applyToAgents: async (_appId, agents) => agents,
      list: async () => { throw new Error('prompt_store_offline'); },
      validate: async () => ({ valid: true, errors: [], missingVariables: [], extraVariables: [] }),
    },
  });
  assert.equal((await brokenController.testAppPrompt({
    appId: 'prompts', kind: 'agent', id: 'agent',
  })).success, false);
});

test('given malformed signed backups, authenticity checks reject unsupported, incomplete, unavailable, and invalid keys', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b16-backups-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const remote = {
    id: 1,
    appId: 'notes',
    metadata: { local_backup_id: 'backup' },
    checksumSha256: 'checksum',
    signature: 'signature',
    signatureKeyFingerprint: 'fingerprint',
    signatureAlgorithm: 'rsa-sha256',
  };
  const backend = {
    listRemoteBackups: async () => ({ backups: [remote] }),
    downloadRemoteBackup: async (_id, target) => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, 'zip');
      return {};
    },
    listDevices: async () => [],
  };
  const controller = createController({
    forgerBackendClient: backend,
    canUseCloudDataSync: () => true,
    tempRoot: root,
    hashFileSha256: async () => 'checksum',
  });

  remote.signatureAlgorithm = 'ed25519';
  await assert.rejects(controller.restoreRemoteAppBackup(1), /remote_backup_signature_algorithm_unsupported/);
  remote.signatureAlgorithm = 'rsa-sha256';
  remote.metadata = {};
  await assert.rejects(controller.restoreRemoteAppBackup(1), /remote_backup_signature_payload_invalid/);
  remote.metadata = { local_backup_id: 'backup' };
  const invalidKey = 'not-a-public-key';
  remote.signatureKeyFingerprint = createHash('sha256').update(invalidKey).digest('hex');
  backend.listDevices = async () => [{ keyFingerprint: remote.signatureKeyFingerprint, publicKey: invalidKey }];
  await assert.rejects(controller.restoreRemoteAppBackup(1), /remote_backup_signature_invalid/);

  const unavailableKeyController = createController({
    forgerBackendClient: {
      listRemoteBackups: async () => ({ backups: [remote] }),
      downloadRemoteBackup: async (_id, target) => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, 'zip');
        return { checksumSha256: 'checksum' };
      },
    },
    getForgerBackendClient: () => null,
    canUseCloudDataSync: () => true,
    tempRoot: root,
    hashFileSha256: async () => 'checksum',
  });
  await assert.rejects(unavailableKeyController.restoreRemoteAppBackup(1), /remote_backup_signature_key_unavailable/);
});

test('given malformed optional manifest fields, normalizers and secret state fail closed', async (t) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform }));

  class SecretsStore {
    async listUserSecrets() { return [{ id: 'secret-1', name: 'Primary' }]; }

    async getMappedSecretId() { return undefined; }
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b16-secrets-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    appSecrets: [{ name: 'api key', usage: 'Connect' }],
  }));
  const controller = createController({
    SecretsStore,
    registry: { apps: { notes: { appId: 'notes', name: undefined, installDir: root } } },
  });
  assert.equal(controller.ensurePathInside('/apps/notes', '/apps/notes/data.txt'), true);
  assert.deepEqual(controller.normalizeManifestPromptTemplates({
    promptTemplates: [{ id: 1, title: 2, prompt: 3 }],
  }), []);
  const agents = controller.normalizeManifestAgents({
    agents: [
      { id: 1, title: 2, prompts: { initial: { body: 3 } } },
      { id: 'missing-prompt', title: 'Missing' },
      { id: 'legacy', title: 'Legacy', prompts: { initial: { body: 'Help' } }, model: 'gpt', reasoningEffort: 'high' },
    ],
  });
  assert.equal(agents[0].model, 'gpt');
  assert.equal(controller.normalizeManifestAgentPromptTemplate({ body: 3 }), undefined);
  assert.deepEqual(controller.normalizePromptTemplateArguments([{ name: 3, type: 'string' }]), []);
  assert.equal(controller.normalizeAppSecretDeclaration({ name: 3, usage: 'Use' }), null);
  assert.equal(controller.normalizeAppSecretDeclaration({ name: 'key', usage: 3 }), null);
  assert.match(controller.getManifestAppSecretsValidationError({ appSecrets: [{ name: 3, usage: 'Use' }] }), /incompleto/);
  assert.match(controller.getManifestAppSecretsValidationError({ appSecrets: [{ name: 'key', usage: 3 }] }), /incompleto/);

  const secretState = await controller.buildAppSecretsState('notes');
  assert.equal(secretState.appName, 'notes');
  assert.equal(secretState.appSecrets.length, 1);
  assert.equal(secretState.appSecrets[0].connected, false);

  const providerDefaults = controller.normalizeManifestAgentDefaults({
    agentProviders: {
      codex: { reasoningEffort: 'high' },
      claude: { effort: 'high' },
      antigravity: { effort: 'high' },
    },
  });
  assert.equal(providerDefaults.codex.model, 'gpt-default');
  assert.equal(providerDefaults.claude.model, 'claude-default');
  assert.equal(providerDefaults.antigravity.model, 'gemini-3.5-flash');
  assert.equal(controller.normalizeManifestRuntime({ provider: 'antigravity', model: 'gemini' }).permissionMode, undefined);

  const fallbackController = createController({
    agentDefaults: {
      ...defaults,
      antigravity: { model: 'gemini-3.5-pro', effort: 'max' },
    },
  });
  const fallbackDefaults = fallbackController.normalizeManifestAgentDefaults({
    agentProviders: {
      codex: { model: 'gpt-explicit' },
      claude: { model: 'claude-explicit' },
      antigravity: { effort: 'high' },
    },
  });
  assert.equal(fallbackDefaults.codex.reasoningEffort, 'medium');
  assert.equal(fallbackDefaults.claude.effort, 'medium');
  assert.equal(fallbackDefaults.antigravity.model, 'gemini-3.5-flash');
  const directDefaults = controller.normalizeManifestPromptTemplates({
    promptTemplates: [{
      id: 'runtime', title: 'Runtime', prompt: 'Run',
      runtimeRecommendations: { codex: { model: 'gpt-x' }, claude: { model: 'claude-x' } },
    }],
  })[0].runtimeRecommendations;
  assert.equal(directDefaults.codex.reasoningEffort, 'medium');
  assert.equal(directDefaults.claude.effort, 'medium');
  const claudeDefault = controller.normalizeManifestPromptTemplates({
    promptTemplates: [{
      id: 'claude-runtime', title: 'Claude runtime', prompt: 'Run',
      runtimeRecommendations: { claude: { effort: 'high' } },
    }],
  })[0].runtimeRecommendations;
  assert.equal(claudeDefault.claude.model, 'sonnet');
});

test('given successful automatic sync, a signed snapshot reports success once', async () => {
  const logs = [];
  const backupsManager = {
    createBackup: async () => ({
      success: true,
      backup: { appId: 'notes', backupId: 'backup', appName: 'Notes', appVersion: '1', createdAt: 'now', reason: 'manual', fileCount: 0, totalBytes: 0, files: [] },
    }),
    backupDirectory: () => '/backup',
  };
  const controller = createController({
    state: { secretsStore: null, officialToolsService: null, connectionsService: null, memoryStore: null, backupsManager },
    forgerBackendClient: { createRemoteBackup: async () => ({ success: true }) },
    forgerAccount: { authenticated: true, token: 'token' },
    canUseCloudDataSync: () => true,
    cloudSyncSettings: { appSync: { notes: { autoSync: true } } },
    cloudIdentityStore: { signText: async () => ({ signature: 'sig', keyFingerprint: 'fingerprint', algorithm: 'rsa-sha256' }) },
    appendInstallLog: async (event) => logs.push(event),
  });
  await controller.syncAppToCloudIfEnabled('notes');
  assert.deepEqual(logs, ['cloud_sync:auto_success']);
});
