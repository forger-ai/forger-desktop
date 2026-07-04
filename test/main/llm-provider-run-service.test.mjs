import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLlmProviderRunService } = require('../../dist-electron/main/llm-provider/run-service.js');
const { LLM_PROVIDER_DESCRIPTORS } = require('../../dist-electron/main/llm-provider/descriptors.js');

test('provider descriptor registry covers supported providers with execution capabilities', () => {
  assert.deepEqual(Object.keys(LLM_PROVIDER_DESCRIPTORS).sort(), ['antigravity', 'claude', 'codex']);
  for (const descriptor of Object.values(LLM_PROVIDER_DESCRIPTORS)) {
    assert.equal(typeof descriptor.run, 'function');
    assert.equal(descriptor.supportsMcp, true);
    assert.equal(descriptor.supportsConversations, true);
    assert.equal(typeof descriptor.label, 'string');
  }
});

test('run service materializes and cleans temporary Codex homes and normalizes usage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-provider-service-'));
  const codexHome = path.join(root, 'codex-home');
  const workdir = path.join(root, 'work');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'auth.json'), '{}', 'utf8');
  let observedCodexHome = '';
  const service = createLlmProviderRunService({
    codexHome,
    getCodexCliPath: async () => '/usr/local/bin/codex',
    getCodexAuthenticated: async () => true,
  });
  try {
    const result = await service.run({
      surface: 'app_prompt_task',
      mode: 'task',
      runtime: { provider: 'codex', model: 'gpt-5.2', effort: 'medium' },
      pathEntries: [],
      environment: {},
      workingDir: workdir,
      prompt: 'hello',
      timeoutMs: 1000,
      codexHomePlan: {
        type: 'temporary',
        rootCodexHome: codexHome,
        prefix: 'forger-provider-service-codex-home',
        trustedRoots: [workdir],
        networkAccess: true,
      },
      runCommandCapture: async (_command, _args, options) => {
        observedCodexHome = options.env.CODEX_HOME;
        assert.equal(options.cwd, workdir);
        assert.equal(options.env.FORGER_ALLOWED_ROOTS, workdir);
        return {
          code: 0,
          stdout: [
            JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }),
            JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } }),
          ].join('\n'),
          stderr: '',
        };
      },
    });
    assert.equal(result.assistantText, 'Done');
    assert.equal(result.threadId, 'thread-1');
    assert.deepEqual(result.usageDelta, {
      inputTokens: 7,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 1,
      turns: 1,
    });
    await assert.rejects(fs.stat(observedCodexHome), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run service materializes Codex auth profile homes into command environment', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-provider-profile-'));
  const codexHome = path.join(root, 'profile-codex-home');
  const workdir = path.join(root, 'work');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  let observedCodexHome = '';
  const service = createLlmProviderRunService({
    getCodexCliPath: async () => '/usr/local/bin/codex',
    getCodexAuthenticated: async () => true,
    resolveAuthProfile: async () => ({
      id: 'codex:work',
      provider: 'codex',
      label: 'Work',
      authMode: 'oauth',
      runtimeAuthMode: 'materialized',
      status: 'connected',
      active: true,
      codexHome,
    }),
  });
  try {
    const result = await service.run({
      surface: 'app_prompt_task',
      mode: 'task',
      runtime: { provider: 'codex', model: 'gpt-5.2', effort: 'medium', authProfileId: 'codex:work' },
      pathEntries: [],
      environment: {},
      workingDir: workdir,
      prompt: 'hello',
      timeoutMs: 1000,
      runCommandCapture: async (_command, _args, options) => {
        observedCodexHome = options.env.CODEX_HOME;
        return {
          code: 0,
          stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Profiled' } }),
          stderr: '',
        };
      },
    });
    assert.equal(result.assistantText, 'Profiled');
    assert.equal(observedCodexHome, codexHome);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run service uses Codex profile auth as the source for isolated homes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-provider-profile-source-'));
  const globalCodexHome = path.join(root, 'global-codex-home');
  const profileCodexHome = path.join(root, 'profile-codex-home');
  const workdir = path.join(root, 'work');
  await fs.mkdir(globalCodexHome, { recursive: true });
  await fs.mkdir(profileCodexHome, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  await fs.writeFile(path.join(globalCodexHome, 'auth.json'), '{"source":"global"}', 'utf8');
  await fs.writeFile(path.join(profileCodexHome, 'auth.json'), '{"source":"profile"}', 'utf8');
  const service = createLlmProviderRunService({
    codexHome: globalCodexHome,
    getCodexCliPath: async () => '/usr/local/bin/codex',
    getCodexAuthenticated: async () => true,
    resolveAuthProfile: async () => ({
      id: 'codex:work',
      provider: 'codex',
      label: 'Work',
      authMode: 'oauth',
      runtimeAuthMode: 'materialized',
      status: 'connected',
      active: true,
      codexHome: profileCodexHome,
    }),
  });
  try {
    await service.run({
      surface: 'app_prompt_task',
      mode: 'task',
      runtime: { provider: 'codex', model: 'gpt-5.2', effort: 'medium', authProfileId: 'codex:work' },
      pathEntries: [],
      environment: {},
      workingDir: workdir,
      prompt: 'hello',
      timeoutMs: 1000,
      codexHomePlan: {
        type: 'temporary',
        rootCodexHome: globalCodexHome,
        prefix: 'forger-provider-service-codex-home',
        trustedRoots: [workdir],
      },
      runCommandCapture: async (_command, _args, options) => {
        const authJson = await fs.readFile(path.join(options.env.CODEX_HOME, 'auth.json'), 'utf8');
        assert.equal(authJson, '{"source":"profile"}');
        return {
          code: 0,
          stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Profile isolated' } }),
          stderr: '',
        };
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run service materializes Claude auth profile config dirs into command environment', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-provider-profile-'));
  const claudeConfigDir = path.join(root, 'claude-config');
  const workdir = path.join(root, 'work');
  await fs.mkdir(claudeConfigDir, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  let observedClaudeConfigDir = '';
  const service = createLlmProviderRunService({
    getClaudeCliPath: async () => '/usr/local/bin/claude',
    getClaudeAuthenticated: async () => true,
    resolveAuthProfile: async () => ({
      id: 'claude:work',
      provider: 'claude',
      label: 'Work',
      authMode: 'oauth',
      runtimeAuthMode: 'materialized',
      status: 'connected',
      active: true,
      claudeConfigDir,
    }),
  });
  try {
    const result = await service.run({
      surface: 'desktop_chat',
      mode: 'conversation',
      runtime: { provider: 'claude', model: 'sonnet', effort: 'medium', authProfileId: 'claude:work' },
      pathEntries: [],
      environment: {},
      workingDir: workdir,
      prompt: 'hello',
      timeoutMs: 1000,
      runCommandCapture: async (_command, _args, options) => {
        observedClaudeConfigDir = options.env.CLAUDE_CONFIG_DIR;
        return {
          code: 0,
          stdout: JSON.stringify({ type: 'result', session_id: 'session-1', result: 'Profiled Claude' }),
          stderr: '',
        };
      },
    });
    assert.equal(result.assistantText, 'Profiled Claude');
    assert.equal(observedClaudeConfigDir, claudeConfigDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run service keeps system Claude profiles on the existing local session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-system-profile-'));
  const workdir = path.join(root, 'work');
  await fs.mkdir(workdir, { recursive: true });
  let observedClaudeConfigDir = 'unset';
  const service = createLlmProviderRunService({
    providerProfilesRoot: path.join(root, 'profiles'),
    getClaudeCliPath: async () => '/usr/local/bin/claude',
    getClaudeAuthenticated: async () => true,
    resolveAuthProfile: async () => ({
      id: 'claude:system',
      provider: 'claude',
      label: 'Claude',
      authMode: 'cli',
      runtimeAuthMode: 'externalActiveOnly',
      status: 'connected',
      active: true,
      claudeConfigDir: path.join(root, 'should-not-be-used'),
    }),
  });
  try {
    const result = await service.run({
      surface: 'desktop_chat',
      mode: 'conversation',
      runtime: { provider: 'claude', model: 'sonnet', effort: 'medium', authProfileId: 'claude:system' },
      pathEntries: [],
      environment: {},
      workingDir: workdir,
      prompt: 'hello',
      timeoutMs: 1000,
      runCommandCapture: async (_command, _args, options) => {
        observedClaudeConfigDir = options.env.CLAUDE_CONFIG_DIR;
        return {
          code: 0,
          stdout: JSON.stringify({ type: 'result', session_id: 'session-1', result: 'System Claude' }),
          stderr: '',
        };
      },
    });
    assert.equal(result.assistantText, 'System Claude');
    assert.equal(observedClaudeConfigDir, undefined);
    await assert.rejects(fs.stat(path.join(root, 'profiles')), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run service rejects invalid auth profiles before launching providers', async () => {
  const service = createLlmProviderRunService({
    getCodexCliPath: async () => '/usr/local/bin/codex',
    getCodexAuthenticated: async () => true,
    resolveAuthProfile: async () => ({
      id: 'codex:expired',
      provider: 'codex',
      label: 'Expired',
      authMode: 'oauth',
      runtimeAuthMode: 'materialized',
      status: 'expired',
      active: true,
    }),
  });
  await assert.rejects(
    service.run({
      surface: 'app_prompt_task',
      mode: 'task',
      runtime: { provider: 'codex', model: 'gpt-5.2', effort: 'medium', authProfileId: 'codex:expired' },
      pathEntries: [],
      environment: {},
      workingDir: os.tmpdir(),
      prompt: 'hello',
      timeoutMs: 1000,
      runCommandCapture: async () => {
        throw new Error('provider_should_not_launch');
      },
    }),
    /provider_auth_profile_not_connected/,
  );
});

test('run service leaves Antigravity auth profiles external-active only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-antigravity-profile-'));
  const workdir = path.join(root, 'work');
  await fs.mkdir(workdir, { recursive: true });
  let observedEnvironment;
  const service = createLlmProviderRunService({
    getAntigravityCliPath: async () => '/usr/local/bin/antigravity',
    getAntigravityAuthenticated: async () => true,
    resolveAuthProfile: async () => ({
      id: 'antigravity:system',
      provider: 'antigravity',
      label: 'Google',
      authMode: 'cli',
      runtimeAuthMode: 'externalActiveOnly',
      status: 'connected',
      active: true,
      codexHome: path.join(root, 'ignored-codex'),
      claudeConfigDir: path.join(root, 'ignored-claude'),
    }),
  });
  try {
    await service.run({
      surface: 'desktop_chat',
      mode: 'conversation',
      runtime: { provider: 'antigravity', model: 'gemini-3.5-flash', effort: 'medium', authProfileId: 'antigravity:system' },
      pathEntries: [],
      environment: {},
      workingDir: workdir,
      configWorkspaceRoot: workdir,
      prompt: 'hello',
      timeoutMs: 1000,
      runCommandCapture: async (_command, _args, options) => {
        observedEnvironment = options.env;
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    });
    assert.equal(observedEnvironment.CODEX_HOME, undefined);
    assert.equal(observedEnvironment.CLAUDE_CONFIG_DIR, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run service classifies readiness failures without leaking paths', async () => {
  const service = createLlmProviderRunService({
    getClaudeAuthenticated: async () => false,
    getClaudeCliPath: async () => '/secret/home/bin/claude',
  });
  await assert.rejects(
    service.run({
      surface: 'desktop_chat',
      mode: 'conversation',
      runtime: { provider: 'claude', model: 'sonnet', effort: 'medium' },
      pathEntries: [],
      environment: {},
      workingDir: '/tmp/work',
      prompt: 'hello',
      timeoutMs: 1000,
      runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
      setupErrorMode: 'chat',
    }),
    (error) => {
      assert.equal(error.chatCode, 'auth_missing');
      assert.equal(error.message, 'claude_auth_missing');
      assert.equal(error.message.includes('/secret/home'), false);
      return true;
    },
  );
});

test('Claude descriptor parses stream-json usage into normalized usage delta', async () => {
  const service = createLlmProviderRunService({
    getClaudeAuthenticated: async () => true,
    getClaudeCliPath: async () => '/usr/local/bin/claude',
  });
  const result = await service.run({
    surface: 'desktop_chat',
    mode: 'conversation',
    runtime: { provider: 'claude', model: 'sonnet', effort: 'medium' },
    pathEntries: [],
    environment: {},
    workingDir: os.tmpdir(),
    prompt: 'hello',
    timeoutMs: 1000,
    runCommandCapture: async () => ({
      code: 0,
      stdout: [
        JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 3, output_tokens: 5 } } }),
        JSON.stringify({ type: 'result', session_id: 'session-1', result: 'Final' }),
      ].join('\n'),
      stderr: '',
    }),
  });
  assert.equal(result.assistantText, 'Final');
  assert.equal(result.threadId, 'session-1');
  assert.deepEqual(result.usageDelta, {
    inputTokens: 13,
    cachedInputTokens: 4,
    outputTokens: 5,
    reasoningOutputTokens: 0,
    turns: 1,
  });
});

test('Claude descriptor classifies zero-exit rate limit stream events as quota failures', async () => {
  const service = createLlmProviderRunService({
    getClaudeAuthenticated: async () => true,
    getClaudeCliPath: async () => '/usr/local/bin/claude',
  });

  await assert.rejects(
    () => service.run({
      surface: 'desktop_chat',
      mode: 'conversation',
      runtime: { provider: 'claude', model: 'sonnet', effort: 'medium' },
      pathEntries: [],
      environment: {},
      workingDir: os.tmpdir(),
      prompt: 'hello',
      timeoutMs: 1000,
      runCommandCapture: async () => ({
        code: 0,
        stdout: [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }),
          JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'rejected',
              resetsAt: Math.floor(Date.now() / 1000) + 60 * 60,
              rateLimitType: 'five_hour',
            },
          }),
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: true,
            api_error_status: 429,
            result: "You've hit your session limit · resets 4pm (America/Santiago)",
          }),
        ].join('\n'),
        stderr: '',
      }),
    }),
    (error) => {
      assert.equal(error.chatCode, 'quota_exceeded');
      assert.match(error.message, /Claude Code quota exceeded/i);
      assert.match(error.message, /resets 4pm/i);
      return true;
    },
  );
});
