import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeAppCapabilities,
  normalizeAppCapabilityIds,
} = require('../../dist-electron/shared/capabilities.js');
const {
  AuthConnectAttemptTracker,
} = require('../../dist-electron/shared/auth-connect-attempts.js');
const {
  buildFailureDiagnostic,
  isStableTechnicalCode,
  normalizeErrorReportDiagnostic,
} = require('../../dist-electron/shared/error-diagnostics.js');
const {
  getSharedCopy,
  installProgressByPhase,
  normalizeLocale,
} = require('../../dist-electron/shared/i18n.js');
const runtimeRegistry = require('../../dist-electron/shared/agent-runtime-registry.js');
const {
  buildAntigravityArgs,
  parseAntigravityOutput,
  writeAntigravityMcpConfig,
} = require('../../dist-electron/main/app-agent/mcp.js');

test('capability normalization maps aliases, objects, casing, and unknown values safely', () => {
  assert.deepEqual(normalizeAppCapabilityIds([
    ' LOCAL_FINANCE_DATA ',
    { id: 'employees_and_contracts' },
    { name: 'agent_assisted_posts' },
    { id: 'unknown' },
    null,
    ['app_exports'],
  ]), ['local_finance_data', 'local_business_data', 'agent_assisted_edits']);
  assert.deepEqual(normalizeAppCapabilities(['previred_export']), [{ id: 'app_exports' }]);
  assert.deepEqual(normalizeAppCapabilityIds({ id: 'app_data' }), []);
  assert.deepEqual(normalizeAppCapabilityIds([{ id: ' APP_DATA ' }]), ['app_data']);
  assert.deepEqual(normalizeAppCapabilityIds([
    { name: ' LOCAL_VISUAL_COMPOSITIONS ' },
    { id: 'PAYROLL_CALCULATION' },
    { id: 'USER_SELECTED_FOLDERS' },
  ]), ['local_visual_assets', 'local_business_data', 'user_selected_folders']);
  assert.deepEqual(normalizeAppCapabilityIds([
    { id: 42, name: ' app_exports ' },
    { id: null, name: 'local_recipe_data' },
    { id: '', name: 'app_data' },
    { label: 'no id or name' },
    { id: 'prototype' },
  ]), ['app_exports', 'local_recipe_data']);
});

test('auth connect attempt tracker isolates active, finished, and canceled attempts', () => {
  const tracker = new AuthConnectAttemptTracker();
  const first = tracker.begin('codex');
  assert.equal(first.id, 1);
  assert.equal(tracker.busyProvider, 'codex');
  assert.equal(tracker.isActive(first), true);

  const second = tracker.begin('claude');
  assert.equal(second.id, 2);
  assert.equal(tracker.isActive(first), false);
  assert.equal(tracker.finish(first), null);
  assert.equal(tracker.cancel('codex'), null);
  assert.equal(tracker.cancel('claude'), second);
  assert.equal(second.canceled, true);
  assert.equal(tracker.busyProvider, null);
  assert.equal(tracker.finish(second), null);

  const third = tracker.begin('codex');
  assert.equal(tracker.finish(third), 'codex');
  assert.equal(tracker.busyProvider, null);
});

test('failure diagnostics classify unstable command and auth failures without leaking command output into details', () => {
  assert.equal(isStableTechnicalCode('desktop_install_failed'), true);
  assert.equal(isStableTechnicalCode(123), false);
  assert.equal(isStableTechnicalCode(null), false);
  assert.equal(isStableTechnicalCode('command_failed_1'), false);
  assert.equal(isStableTechnicalCode('bad spaces'), false);

  const commandError = {
    message: 'failed',
    exitCode: 2,
    signal: 'SIGTERM',
    command: 'codex',
    args: ['run', 'secret'],
    cwd: '/tmp/app',
    stderr: 'command_failed_2: stderr',
  };
  const diagnostic = buildFailureDiagnostic({
    fallbackCode: 'desktop_install_failed',
    technicalCode: 'command_failed_2',
    error: commandError,
  });
  assert.equal(diagnostic.technicalCode, 'command_failed');
  assert.deepEqual(diagnostic.details, { exitCode: 2, classifier: 'command_failed', signal: 'SIGTERM' });
  assert.equal(diagnostic.sensitiveDetails.command, 'codex');
  assert.deepEqual(diagnostic.sensitiveDetails.args, ['run', 'secret']);
  assert.deepEqual(buildFailureDiagnostic({
    fallbackCode: 'desktop_error',
    rawError: 'command_failed_null',
  }), {
    technicalCode: 'command_failed',
    details: { exitCode: null, classifier: 'command_failed' },
    sensitiveDetails: { rawError: 'command_failed_null' },
  });

  assert.equal(buildFailureDiagnostic({
    fallbackCode: 'desktop_error',
    error: new Error('env: node: No such file or directory'),
  }).technicalCode, 'codex_node_runtime_missing');
  assert.equal(buildFailureDiagnostic({
    fallbackCode: 'desktop_error',
    rawError: '401 Unauthorized Failed to refresh token',
  }).technicalCode, 'codex_auth_expired');
  assert.deepEqual(buildFailureDiagnostic({
    fallbackCode: 'desktop_error',
    rawError: 'Fatal process out of memory\nFailed to reserve virtual memory for CodeRange',
  }), {
    technicalCode: 'node_fatal_oom_code_range',
    details: { classifier: 'node_fatal_oom_code_range' },
    sensitiveDetails: { rawError: 'Fatal process out of memory\nFailed to reserve virtual memory for CodeRange' },
  });
  assert.deepEqual(buildFailureDiagnostic({
    fallbackCode: 'desktop_error',
    rawError: 'rename failed with ENOTEMPTY',
  }), {
    technicalCode: 'filesystem_enotempty',
    details: { classifier: 'filesystem_enotempty' },
    sensitiveDetails: { rawError: 'rename failed with ENOTEMPTY' },
  });
  assert.equal(buildFailureDiagnostic({
    fallbackCode: 'bad fallback',
    rawError: 'unknown',
  }).technicalCode, 'desktop_error');
  assert.deepEqual(buildFailureDiagnostic({
    fallbackCode: 'desktop_error',
    rawError: 'command_failed_5',
  }), {
    technicalCode: 'command_failed',
    details: { exitCode: '5', classifier: 'command_failed' },
    sensitiveDetails: { rawError: 'command_failed_5' },
  });
  assert.deepEqual(buildFailureDiagnostic({
    fallbackCode: 'desktop_error',
    error: { stdout: 'ok', stderr: 'command_failed_9: stderr' },
  }), {
    technicalCode: 'command_failed',
    details: { exitCode: '9', classifier: 'command_failed' },
    sensitiveDetails: { stdout: 'ok', stderr: 'command_failed_9: stderr' },
  });
  assert.deepEqual(buildFailureDiagnostic({
    fallbackCode: 'desktop_error',
    error: 'plain string failure',
  }), {
    technicalCode: 'desktop_error',
    sensitiveDetails: { rawError: 'plain string failure' },
  });
  assert.deepEqual(buildFailureDiagnostic({
    fallbackCode: 'desktop_error',
    technicalCode: 'stable_code',
    error: new Error('stable failure'),
    details: { public: true },
    sensitiveDetails: { private: true },
  }).details, { public: true });
});

test('error report diagnostics normalize unstable technical codes from source and operation', () => {
  const stable = { technicalCode: 'stable_code', details: { public: true } };
  assert.equal(normalizeErrorReportDiagnostic(stable), stable);
  const missingCode = { source: 'main', operation: 'startup' };
  assert.equal(normalizeErrorReportDiagnostic(missingCode), missingCode);
  const normalized = normalizeErrorReportDiagnostic({
    source: 'Renderer UI',
    operation: 'Submit Feedback',
    technicalCode: 'command_failed_null',
    details: { public: true },
  });
  assert.equal(normalized.technicalCode, 'command_failed');
  assert.equal(normalized.details.exitCode, null);
  assert.equal(normalized.sensitiveDetails.rawTechnicalCode, 'command_failed_null');
});

test('locale and shared copy helpers normalize supported languages and install progress', () => {
  assert.equal(normalizeLocale(), 'es');
  assert.equal(normalizeLocale('EN-us'), 'en');
  assert.equal(normalizeLocale('fr-FR'), 'es');
  assert.equal(installProgressByPhase.completed, 100);
  assert.equal(installProgressByPhase.failed, 100);
  assert.match(getSharedCopy('en').install.downloading, /Downloading/);
  assert.match(getSharedCopy('de').install.downloading, /Descargando/);
  assert.match(getSharedCopy('es').chat.failures.permissionDenied, /denegado/);
  assert.match(getSharedCopy('es').chat.failures.canceled(' Revisa logs.'), /Revisa logs/);
  assert.match(getSharedCopy('es').chat.failures.codexCliFailed('', ''), /Codex CLI/);
  assert.match(getSharedCopy('en').chat.failures.codexRequestFailed('timeout', ' See logs.'), /timeout.*See logs/);
  assert.match(getSharedCopy('en').chat.failures.codexCliFailed('', ' See logs.'), /See logs/);
  assert.match(getSharedCopy('en').chat.failures.codexRequestFailed('', ''), /Codex/);
  assert.match(getSharedCopy('en').tools.configurationError('Gmail'), /Gmail has a configuration error\./);
  assert.match(getSharedCopy('en').tools.configurationError('Gmail', 'missing token'), /missing token/);
  assert.match(getSharedCopy('es').tools.configurationError('Gmail', 'sin token'), /sin token/);
  assert.match(getSharedCopy('es').tools.configurationError('Gmail'), /Gmail tiene un error de configuración\./);
  assert.match(getSharedCopy('en').agentTools.approvalWaiting('Gmail'), /Gmail/);
  assert.match(getSharedCopy('en').chat.failures.canceled(' See logs.'), /See logs/);
  assert.match(getSharedCopy('en').chat.failures.codexCliFailed('node missing', ''), /node missing/);
  assert.match(getSharedCopy('es').chat.failures.codexRequestFailed('', ' Revisa logs.'), /Revisa logs/);
  assert.equal(getSharedCopy(null), getSharedCopy('es'));
});

test('agent runtime registry normalizes providers, defaults, fallbacks, and runtime source', () => {
  assert.equal(runtimeRegistry.normalizeAgentProviderPreference('bad', 'claude'), 'claude');
  assert.equal(runtimeRegistry.normalizeProvider('bad'), undefined);
  assert.equal(runtimeRegistry.normalizeCodexModel('bad', 'gpt-5.5'), 'gpt-5.5');
  assert.equal(runtimeRegistry.normalizeClaudeModel('bad', 'opus'), 'opus');
  assert.equal(runtimeRegistry.normalizeCodexReasoningEffort('bad', 'high'), 'high');
  assert.equal(runtimeRegistry.normalizeClaudeEffort('max'), 'max');
  assert.equal(runtimeRegistry.normalizeRuntimeEffort('claude', 'bad', 'xhigh'), 'xhigh');
  assert.equal(runtimeRegistry.normalizeRuntimeEffort('codex', 'bad', 'xhigh'), 'xhigh');
  assert.equal(runtimeRegistry.normalizeRuntimeEffort('claude', 'bad', 'not-a-claude-effort'), 'medium');
  assert.equal(runtimeRegistry.normalizeRuntimeEffort('codex', 'bad', 'not-a-codex-effort'), 'medium');
  assert.equal(runtimeRegistry.normalizeAgentProviderPreference('bad'), 'auto');
  assert.equal(runtimeRegistry.normalizeCodexReasoningEffort('bad'), 'medium');
  assert.equal(runtimeRegistry.normalizeClaudeModel('bad'), 'claude-sonnet-4-6');
  assert.equal(runtimeRegistry.normalizeClaudeEffort('bad'), 'medium');
  assert.equal(runtimeRegistry.getDefaultCodexReasoningEffort('gpt-5.3-codex-spark'), 'high');
  assert.equal(runtimeRegistry.getDefaultClaudeEffort('opusplan'), 'high');
  assert.equal(runtimeRegistry.getDefaultCodexReasoningEffort('unknown-model'), 'medium');
  assert.equal(runtimeRegistry.getDefaultClaudeEffort('unknown-model'), 'medium');
  assert.equal(runtimeRegistry.isAgentProvider('codex'), true);
  assert.equal(runtimeRegistry.isAgentProvider('bad'), false);
  assert.equal(runtimeRegistry.isAgentProviderPreference('auto'), true);
  assert.equal(runtimeRegistry.normalizeAgentPermissionMode('unsafe'), 'unsafe');
  assert.equal(runtimeRegistry.normalizeAgentPermissionMode('bad'), 'safe');
  assert.equal(runtimeRegistry.isCodexModel('gpt-5.4'), true);
  assert.equal(runtimeRegistry.isCodexModel('bad'), false);
  assert.equal(runtimeRegistry.isCodexReasoningEffort('low'), true);
  assert.equal(runtimeRegistry.isClaudeModel('sonnet'), true);
  assert.equal(runtimeRegistry.isClaudeEffort('max'), true);
  const providerRegistry = runtimeRegistry.createAgentProviderRuntimeRegistry({
    codex: {
      defaultModel: 'codex-a',
      defaultReasoningEffort: 'low',
      modelValues: ['codex-a', 'codex-b'],
      reasoningEffortValues: ['low', 'high'],
    },
    claude: {
      defaultModel: 'claude-a',
      defaultEffort: 'medium',
      modelValues: ['claude-a', 'claude-b'],
      effortValues: ['medium', 'max'],
    },
    antigravity: {
      defaultModel: 'ag-a',
      defaultEffort: 'medium',
      modelValues: ['ag-a', 'ag-b'],
      effortValues: ['low', 'medium', 'high'],
    },
  });
  assert.equal(providerRegistry.codex.defaultModel, 'codex-a');
  assert.equal(runtimeRegistry.normalizeAgentProviderModel(providerRegistry, 'codex', ' codex-b ', 'codex-a'), 'codex-b');
  assert.equal(runtimeRegistry.normalizeAgentProviderModel(providerRegistry, 'claude', 'missing', 'claude-b'), 'claude-b');
  assert.equal(runtimeRegistry.normalizeAgentProviderModel(providerRegistry, 'antigravity', 'ag-b', 'ag-a'), 'ag-b');
  assert.equal(runtimeRegistry.normalizeAgentProviderEffort(providerRegistry, 'codex', 'high', 'low'), 'high');
  assert.equal(runtimeRegistry.normalizeAgentProviderEffort(providerRegistry, 'claude', 'bad', 'max'), 'max');
  assert.equal(runtimeRegistry.normalizeAgentProviderEffort(providerRegistry, 'antigravity', 'bad', 'low'), 'low');
  assert.equal(runtimeRegistry.DEFAULT_AGENT_PROVIDER_RUNTIME_REGISTRY.codex.defaultModel, runtimeRegistry.DEFAULT_CODEX_MODEL);
  assert.equal(runtimeRegistry.getAgentModelOptions('claude')[0].realModelName, 'claude-opus-4-8');
  assert.equal(runtimeRegistry.getDefaultClaudeEffort('claude-opus-4-8'), 'high');
  assert.equal(runtimeRegistry.getAgentModelOptions('codex')[0].realModelName, 'gpt-5.5');
  assert.equal(runtimeRegistry.legacyCodexRuntime(), undefined);
  assert.equal(runtimeRegistry.legacyCodexRuntime({}), undefined);
  assert.deepEqual(runtimeRegistry.legacyCodexRuntime({ model: 'gpt-5.3-codex', effort: 'xhigh' }), {
    provider: 'codex',
    model: 'gpt-5.3-codex',
    effort: 'xhigh',
  });
  assert.deepEqual(runtimeRegistry.normalizeAgentRuntime({
    provider: 'claude',
    model: 'opus',
    effort: 'bad',
  }), {
    provider: 'claude',
    model: 'opus',
    effort: 'high',
  });
  assert.deepEqual(runtimeRegistry.normalizeAgentRuntime(undefined, {
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'high',
  }), {
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    effort: 'high',
  });
  assert.deepEqual(runtimeRegistry.normalizeAgentRuntime(undefined, {
    provider: 'claude',
    model: 'opus',
    reasoningEffort: 'max',
  }), {
    provider: 'claude',
    model: 'opus',
    effort: 'max',
  });
  assert.deepEqual(runtimeRegistry.normalizeAgentRuntime({
    provider: 'codex',
    model: 'custom-codex-model',
    effort: 'none',
  }), {
    provider: 'codex',
    model: 'custom-codex-model',
    effort: 'none',
  });
  assert.deepEqual(runtimeRegistry.normalizeAgentRuntime(null, {
    model: 'legacy-only',
    reasoningEffort: 'low',
  }), {
    provider: 'codex',
    model: 'legacy-only',
    effort: 'low',
  });
  assert.deepEqual(runtimeRegistry.normalizeAgentRuntime({
    provider: 'claude',
    model: 'custom-claude-model',
    effort: 'max',
  }), {
    provider: 'claude',
    model: 'custom-claude-model',
    effort: 'max',
  });
  assert.deepEqual(runtimeRegistry.normalizeAgentRuntime(
    { provider: 'bad', model: 'ignored' },
    { provider: 'claude', model: 'sonnet[1m]', effort: 'xhigh' },
  ), {
    provider: 'codex',
    model: 'sonnet[1m]',
    effort: 'xhigh',
  });
  assert.deepEqual(runtimeRegistry.resolveAgentRuntime(undefined, runtimeRegistry.DEFAULT_AGENT_DEFAULTS), {
    provider: 'codex',
    model: 'gpt-5.4',
    effort: 'medium',
  });
  assert.deepEqual(runtimeRegistry.resolveAgentRuntime({ provider: 'claude', model: 'bad', effort: 'bad' }, {
    codex: { model: 'gpt-5.5', reasoningEffort: 'low' },
    claude: { model: 'haiku', effort: 'low' },
  }), {
    provider: 'claude',
    model: 'haiku',
    effort: 'medium',
    permissionMode: 'safe',
  });
  assert.deepEqual(runtimeRegistry.resolveAgentRuntime({ provider: 'codex', model: 'bad', effort: 'bad' }, {
    codex: { model: 'gpt-5.5', reasoningEffort: 'low' },
    claude: { model: 'haiku', effort: 'low' },
  }), {
    provider: 'codex',
    model: 'gpt-5.5',
    effort: 'medium',
    permissionMode: 'safe',
  });
  assert.deepEqual(runtimeRegistry.runtimeFromDefaults({
    codex: { model: 'gpt-5.2', reasoningEffort: 'none' },
    claude: { model: 'sonnet', effort: 'medium' },
  }), {
    provider: 'codex',
    model: 'gpt-5.2',
    effort: 'none',
  });
  assert.deepEqual(runtimeRegistry.runtimeFromUserDefaults({
    codexAuthenticated: true,
    claudeAuthenticated: true,
    defaultProvider: 'claude',
    defaults: {
      codex: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
      claude: { model: 'opus', effort: 'max' },
    },
    providerConnections: {
      codex: '2026-05-20T00:00:00.000Z',
      claude: '2026-05-21T00:00:00.000Z',
    },
  }), {
    provider: 'claude',
    model: 'opus',
    effort: 'max',
  });
  assert.deepEqual(runtimeRegistry.runtimeFromUserDefaults({
    codexAuthenticated: true,
    claudeAuthenticated: true,
    defaultProvider: 'auto',
    defaults: {
      codex: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
      claude: { model: 'sonnet', effort: 'high' },
    },
    providerConnections: {
      codex: '2026-05-21T00:00:00.000Z',
      claude: '2026-05-20T00:00:00.000Z',
    },
  }), {
    provider: 'claude',
    model: 'sonnet',
    effort: 'high',
  });
  assert.deepEqual(runtimeRegistry.runtimeFromUserDefaults({
    codexAuthenticated: false,
    claudeAuthenticated: true,
    defaultProvider: 'codex',
    defaults: {
      codex: { model: 'gpt-5.3-codex', reasoningEffort: 'low' },
      claude: { model: 'opus', effort: 'max' },
    },
  }), {
    provider: 'claude',
    model: 'opus',
    effort: 'max',
  });
  assert.equal(runtimeRegistry.resolveRuntimeSource(undefined, { provider: 'codex', model: 'gpt-5.5' }), 'override');
  assert.equal(runtimeRegistry.resolveRuntimeSource({ provider: 'claude', model: 'sonnet' }, undefined), 'manifest');
  assert.equal(runtimeRegistry.resolveRuntimeSource(undefined, undefined), 'global');
  assert.equal(runtimeRegistry.agentRuntimeEquals(
    { provider: 'codex', model: 'gpt-5.4', effort: 'medium' },
    { provider: 'codex', model: 'gpt-5.4', effort: 'medium' },
  ), true);
  assert.equal(runtimeRegistry.agentRuntimeEquals(
    { provider: 'codex', model: 'gpt-5.4', effort: 'medium' },
    { provider: 'claude', model: 'sonnet', effort: 'medium' },
  ), false);
  assert.equal(runtimeRegistry.agentRuntimeEquals(null, { provider: 'codex', model: 'gpt-5.4', effort: 'medium' }), false);
  assert.equal(runtimeRegistry.agentRuntimeEquals(undefined, undefined), false);
  const defaultsCopy = runtimeRegistry.getDefaultAgentDefaults();
  defaultsCopy.codex.model = 'mutated';
  assert.equal(runtimeRegistry.DEFAULT_AGENT_DEFAULTS.codex.model, 'gpt-5.4');
});

test('antigravity CLI contract fixture captures real agy command semantics', async () => {
  const fixture = await fs.readFile(new URL('../fixtures/antigravity-cli-contract.md', import.meta.url), 'utf8');
  assert.match(fixture, /Observed version: `1\.0\.9`/);
  assert.match(fixture, /--print\s+Run a single prompt non-interactively and print the response/);
  assert.match(fixture, /-c\s+Short alias for --continue/);
  assert.match(fixture, /Resume a conversation by ID: `agy --conversation <conversation-id>`/);
  assert.match(fixture, /not standalone subcommands[\s\S]*`auth`/);
});

test('antigravity MCP helper writes workspace config and restores existing content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-antigravity-mcp-'));
  try {
    const configPath = path.join(root, '.agents', 'mcp_config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { existing: { command: 'node' } } }, null, 2), 'utf8');

    const handle = await writeAntigravityMcpConfig(root, [{
      name: 'forger',
      url: 'http://127.0.0.1:9988/mcp',
      token: 'secret-token',
      tokenEnvVar: 'FORGER_MCP_TOKEN',
    }]);
    assert.equal(handle.configPath, configPath);
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.deepEqual(written.mcpServers.existing, { command: 'node' });
    assert.deepEqual(written.mcpServers.forger, {
      serverUrl: 'http://127.0.0.1:9988/mcp',
      headers: { Authorization: 'Bearer secret-token' },
    });

    await handle.cleanup();
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), {
      mcpServers: { existing: { command: 'node' } },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('antigravity MCP helper serializes config writes per workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-antigravity-mcp-lock-'));
  const configPath = path.join(root, '.agents', 'mcp_config.json');
  try {
    const first = await writeAntigravityMcpConfig(root, [{
      name: 'first',
      url: 'http://127.0.0.1:9001/mcp',
      token: 'first-token',
      tokenEnvVar: 'FIRST_TOKEN',
    }]);
    assert.ok(first);
    const secondPromise = writeAntigravityMcpConfig(root, [{
      name: 'second',
      url: 'http://127.0.0.1:9002/mcp',
      token: 'second-token',
      tokenEnvVar: 'SECOND_TOKEN',
    }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers), ['first']);

    await first.cleanup();
    const second = await secondPromise;
    assert.ok(second);
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers), ['second']);

    await second.cleanup();
    await assert.rejects(() => fs.readFile(configPath, 'utf8'), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('antigravity runner args and parser follow agy print and conversation flags', () => {
  assert.deepEqual(buildAntigravityArgs({
    prompt: 'Review this app',
    model: 'gemini-3.5-flash-high',
    threadId: 'conv-123',
    addDirs: ['/tmp/forger-app/subdir'],
    logFile: '/tmp/forger-app/.forger/tmp/antigravity-run.log',
    hasMcpServers: true,
    permissionMode: 'safe',
  }), [
    '--log-file',
    '/tmp/forger-app/.forger/tmp/antigravity-run.log',
    '--model',
    'gemini-3.5-flash-high',
    '--conversation',
    'conv-123',
    '--add-dir',
    '/tmp/forger-app/subdir',
    '--dangerously-skip-permissions',
    '--print',
    'Review this app',
    '--print-timeout',
    '5m',
  ]);
  assert.deepEqual(parseAntigravityOutput('Conversation ID: conv-456\nDone.\n'), {
    assistantText: 'Done.',
    threadId: 'conv-456',
    toolEvents: [],
  });
  assert.deepEqual(parseAntigravityOutput(
    'Done.\n',
    '',
    'I0618 printmode.go:156] Print mode: conversation=5e0a064b-919d-4b65-bc3b-0a4eca4491f3, sending message\n',
  ), {
    assistantText: 'Done.',
    threadId: '5e0a064b-919d-4b65-bc3b-0a4eca4491f3',
    toolEvents: [],
  });
});
