import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  createLlmProviderRunService,
  LlmProviderRunService,
} = require('../../dist-electron/main/llm-provider/run-service.js');
const { LLM_PROVIDER_DESCRIPTORS } = require('../../dist-electron/main/llm-provider/descriptors.js');

const baseRun = (provider, overrides = {}) => ({
  surface: 'desktop_chat',
  mode: 'conversation',
  runtime: { provider, model: 'model', effort: 'medium' },
  pathEntries: [],
  environment: { INPUT: 'yes' },
  workingDir: '/workspace',
  prompt: 'hello',
  timeoutMs: 1_000,
  runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
  ...overrides,
});

const connectedProfile = (provider, id, overrides = {}) => ({
  id,
  provider,
  label: 'Profile',
  authMode: 'oauth',
  runtimeAuthMode: provider === 'antigravity' ? 'externalActiveOnly' : 'materialized',
  status: 'connected',
  active: true,
  ...overrides,
});

const withDescriptorRun = async (provider, implementation, operation) => {
  const original = LLM_PROVIDER_DESCRIPTORS[provider].run;
  LLM_PROVIDER_DESCRIPTORS[provider].run = implementation;
  try {
    return await operation();
  } finally {
    LLM_PROVIDER_DESCRIPTORS[provider].run = original;
  }
};

test('run service resolves provider commands and validates readiness per provider', async () => {
  const originalResolve = LLM_PROVIDER_DESCRIPTORS.codex.resolveCommand;
  LLM_PROVIDER_DESCRIPTORS.codex.resolveCommand = async (cliPath, pathEntries) => ({
    command: `${cliPath}-resolved`,
    prefixArgs: ['entry.js'],
    pathEntries,
  });
  try {
    const empty = new LlmProviderRunService();
    assert.deepEqual(await empty.resolveCommand('claude', '/claude', ['/bin']), {
      command: '/claude',
      prefixArgs: [],
      pathEntries: ['/bin'],
    });
    assert.deepEqual(await empty.resolveCommand('codex', '/codex', ['/bin']), {
      command: '/codex-resolved',
      prefixArgs: ['entry.js'],
      pathEntries: ['/bin'],
    });
  } finally {
    LLM_PROVIDER_DESCRIPTORS.codex.resolveCommand = originalResolve;
  }

  for (const provider of ['codex', 'claude', 'antigravity']) {
    const empty = createLlmProviderRunService();
    await assert.rejects(empty.assertReady(provider), new RegExp(`${provider}_auth_missing`));
  }

  const gitCalls = [];
  const service = createLlmProviderRunService({
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => true,
    getAntigravityAuthenticated: async () => true,
    getCodexCliPath: async () => '/codex',
    getClaudeCliPath: async () => '/claude',
    getAntigravityCliPath: async () => '/antigravity',
    ensureGitAvailable: async () => gitCalls.push('git'),
  });
  await service.assertReady('codex');
  await service.assertReady('claude');
  await service.assertReady('antigravity');
  assert.deepEqual(gitCalls, ['git']);

  for (const [provider, option] of [
    ['codex', 'getCodexAuthenticated'],
    ['claude', 'getClaudeAuthenticated'],
    ['antigravity', 'getAntigravityAuthenticated'],
  ]) {
    const missingCli = createLlmProviderRunService({ [option]: async () => true });
    await assert.rejects(missingCli.assertReady(provider, 'chat'), (error) => {
      assert.equal(error.message, `${provider}_cli_missing`);
      assert.equal(error.chatCode, 'capability_unavailable');
      return true;
    });
  }

  await assert.rejects(
    createLlmProviderRunService({ getCodexAuthenticated: async () => true }).assertReady('codex'),
    /codex_cli_missing/,
  );

  const missingAuth = createLlmProviderRunService({ getCodexAuthenticated: async () => false });
  await assert.rejects(missingAuth.assertReady('codex', 'chat'), (error) => {
    assert.equal(error.message, 'codex_auth_missing');
    assert.equal(error.chatCode, 'auth_missing');
    return true;
  });
});

test('run service composes provider profiles, environment, permissions, and supplied CLI paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b26-run-profiles-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const profilesRoot = path.join(root, 'profiles');
  const captures = [];

  const codexProfile = connectedProfile('codex', 'codex:work', {
    codexHome: path.join(root, 'codex-home'),
    rootCodexHome: path.join(root, 'codex-root'),
  });
  const codexService = createLlmProviderRunService({
    codexHome: '/global-codex',
    providerProfilesRoot: profilesRoot,
    getCodexAuthenticated: async () => true,
    ensureGitAvailable: async () => captures.push({ git: true }),
    resolveAuthProfile: async () => codexProfile,
  });
  await withDescriptorRun('codex', async (input) => {
    captures.push(input);
    return { code: 0, assistantText: 'codex', toolEvents: 0 };
  }, async () => codexService.run(baseRun('codex', {
    cliPath: '/provided-codex',
    checkReady: false,
    runtime: { provider: 'codex', model: 'gpt', effort: 'high', permissionMode: 'unsafe', authProfileId: 'codex:work' },
    permissionMode: 'safe',
  })));
  assert.equal(captures[1].cliPath, '/provided-codex');
  assert.equal(captures[1].environment.CODEX_HOME, undefined);
  assert.equal(captures[1].environment.INPUT, 'yes');
  assert.equal(captures[1].codexHome, codexProfile.codexHome);
  assert.equal(captures[1].rootCodexHome, codexProfile.rootCodexHome);
  assert.equal(captures[1].model, 'gpt');
  assert.equal(captures[1].effort, 'high');
  assert.equal(captures[1].permissionMode, 'unsafe');

  const claudeService = createLlmProviderRunService({
    providerProfilesRoot: profilesRoot,
    getClaudeAuthenticated: async () => true,
    getClaudeCliPath: async () => '/claude',
    getProviderProfile: async () => connectedProfile('claude', 'claude:work', { claudeConfigDir: '/explicit-claude' }),
  });
  let claudeCapture;
  await withDescriptorRun('claude', async (input) => {
    claudeCapture = input;
    return { code: 0, assistantText: 'claude', toolEvents: 0 };
  }, async () => claudeService.run(baseRun('claude', {
    runtime: { provider: 'claude', model: 'sonnet', effort: 'low', authProfileId: 'claude:work' },
    permissionMode: 'approve',
  })));
  assert.equal(claudeCapture.environment.CLAUDE_CONFIG_DIR, '/explicit-claude');
  assert.equal(claudeCapture.permissionMode, 'approve');
  assert.equal(claudeCapture.codexHome, undefined);

  const antigravityService = createLlmProviderRunService({
    providerProfilesRoot: profilesRoot,
    getAntigravityAuthenticated: async () => true,
    getAntigravityCliPath: async () => '/antigravity',
    resolveAuthProfile: async () => connectedProfile('antigravity', 'antigravity:system'),
  });
  let antigravityCapture;
  await withDescriptorRun('antigravity', async (input) => {
    antigravityCapture = input;
    return { code: 0, assistantText: 'google', toolEvents: 0 };
  }, async () => antigravityService.run(baseRun('antigravity', {
    runtime: { provider: 'antigravity', model: 'gemini', effort: 'medium', authProfileId: 'antigravity:system' },
  })));
  assert.deepEqual(antigravityCapture.environment, { INPUT: 'yes' });
  assert.equal(antigravityCapture.rootCodexHome, undefined);

  const noProfileClaude = createLlmProviderRunService({
    getClaudeAuthenticated: async () => true,
    getClaudeCliPath: async () => '/claude',
  });
  await withDescriptorRun('claude', async (input) => {
    assert.deepEqual(input.environment, { INPUT: 'yes' });
    return { code: 0, assistantText: 'claude', toolEvents: 0 };
  }, async () => noProfileClaude.run(baseRun('claude')));
});

test('run service creates profile directories with safe names and skips external profiles', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b26-run-profile-dirs-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const profilesRoot = path.join(root, 'profiles');
  const captures = [];
  const service = createLlmProviderRunService({
    providerProfilesRoot: profilesRoot,
    getClaudeAuthenticated: async () => true,
    getClaudeCliPath: async () => '/claude',
    resolveAuthProfile: async (_provider, id) => connectedProfile('claude', id),
  });
  await withDescriptorRun('claude', async (input) => {
    captures.push(input);
    return { code: 0, assistantText: 'ok', toolEvents: 0 };
  }, async () => {
    await service.run(baseRun('claude', { runtime: { provider: 'claude', model: 'm', effort: 'low', authProfileId: 'claude: work !!' } }));
    await service.run(baseRun('claude', { runtime: { provider: 'claude', model: 'm', effort: 'low', authProfileId: '!!!' } }));
  });
  assert.equal(captures[0].environment.CLAUDE_CONFIG_DIR, path.join(profilesRoot, 'claude', 'claude-work'));
  assert.equal(captures[1].environment.CLAUDE_CONFIG_DIR, path.join(profilesRoot, 'claude', 'default'));

  const external = await service.materializeProviderProfileDirectory('claude', 'claude:external', 'externalActiveOnly');
  assert.equal(external, undefined);
  const noRoot = await createLlmProviderRunService().materializeProviderProfileDirectory('claude', 'claude:work', 'materialized');
  assert.equal(noRoot, undefined);
});

test('run service materializes none and provided Codex home plans with root fallbacks', async () => {
  const captures = [];
  const service = createLlmProviderRunService({
    codexHome: '/global-root',
    getCodexAuthenticated: async () => true,
    getCodexCliPath: async () => '/codex',
  });
  await withDescriptorRun('codex', async (input) => {
    captures.push(input);
    return { code: 0, assistantText: 'ok', toolEvents: 0 };
  }, async () => {
    await service.run(baseRun('codex', { codexHomePlan: undefined }));
    await service.run(baseRun('codex', { codexHomePlan: { type: 'none' } }));
    await service.run(baseRun('codex', { codexHomePlan: { type: 'provided', path: '/provided', rootCodexHome: '/explicit-root' } }));
    await service.run(baseRun('codex', { codexHomePlan: { type: 'provided', path: '/provided-global' } }));
  });
  assert.equal(captures[0].codexHome, undefined);
  assert.equal(captures[0].rootCodexHome, '/global-root');
  assert.equal(captures[1].codexHome, undefined);
  assert.equal(captures[2].rootCodexHome, '/explicit-root');
  assert.equal(captures[3].rootCodexHome, '/global-root');

  const pathFallbackService = createLlmProviderRunService({
    getCodexAuthenticated: async () => true,
    getCodexCliPath: async () => '/codex',
  });
  await withDescriptorRun('codex', async (input) => {
    assert.equal(input.rootCodexHome, '/provided-path');
    return { code: 0, assistantText: 'ok', toolEvents: 0 };
  }, async () => pathFallbackService.run(baseRun('codex', {
    codexHomePlan: { type: 'provided', path: '/provided-path' },
  })));
});

test('run service prepares persistent homes and always cleans temporary homes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b26-run-homes-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const persistent = path.join(root, 'persistent');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'auth.json'), '{"auth":true}', 'utf8');
  const service = createLlmProviderRunService({
    getCodexAuthenticated: async () => true,
    getCodexCliPath: async () => '/codex',
  });
  const observed = [];
  await withDescriptorRun('codex', async (input) => {
    observed.push(input.codexHome);
    assert.equal(await fs.readFile(path.join(input.codexHome, 'auth.json'), 'utf8'), '{"auth":true}');
    if (observed.length === 3) throw new Error('provider_failed');
    return { code: 0, assistantText: 'ok', toolEvents: 0 };
  }, async () => {
    await service.run(baseRun('codex', {
      codexHomePlan: { type: 'persistent', rootCodexHome: source, targetCodexHome: persistent, trustedRoots: ['/workspace'], networkAccess: true },
    }));
    await service.run(baseRun('codex', {
      codexHomePlan: { type: 'temporary', rootCodexHome: source, prefix: 'forger-b26-run-temp', trustedRoots: ['/workspace'], networkAccess: false },
    }));
    await assert.rejects(service.run(baseRun('codex', {
      codexHomePlan: { type: 'temporary', rootCodexHome: source, prefix: 'forger-b26-run-temp', trustedRoots: [], networkAccess: undefined },
    })), /provider_failed/);
  });
  assert.equal((await fs.stat(persistent)).isDirectory(), true);
  assert.equal((await fs.stat(observed[0])).isDirectory(), true);
  await assert.rejects(fs.stat(observed[1]), /ENOENT/);
  await assert.rejects(fs.stat(observed[2]), /ENOENT/);
});

test('profile Codex roots override every isolation-plan source consistently', async () => {
  const profile = connectedProfile('codex', 'codex:work', {
    codexHome: '/profile-home',
    rootCodexHome: '/profile-root',
  });
  const service = createLlmProviderRunService({
    getCodexAuthenticated: async () => true,
    getCodexCliPath: async () => '/codex',
    resolveAuthProfile: async () => profile,
  });
  const plans = [
    undefined,
    { type: 'none' },
    { type: 'provided', path: '/provided', rootCodexHome: '/old-root' },
    { type: 'persistent', rootCodexHome: '/old-root', targetCodexHome: '/target', trustedRoots: [] },
    { type: 'temporary', rootCodexHome: '/old-root', prefix: 'forger-b26', trustedRoots: [] },
  ];
  for (const plan of plans) {
    const resolved = service.resolveCodexHomePlan(plan, profile.codexHome, profile.rootCodexHome);
    assert.equal(resolved.rootCodexHome, '/profile-root');
    if (!plan || plan.type === 'none') assert.equal(resolved.path, '/profile-home');
  }
  assert.equal(service.resolveCodexHomePlan({ type: 'none' }, undefined, undefined).type, 'none');
  assert.equal(service.resolveCodexHomePlan(undefined, undefined, undefined), undefined);
  assert.equal(service.resolveCodexHomePlan(undefined, '/profile-home', undefined).rootCodexHome, '/profile-home');
});
