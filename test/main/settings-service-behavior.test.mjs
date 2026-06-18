import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSettingsServiceController } = require('../../dist-electron/main/core/settings-service.js');
const { createAgentProviderRuntimeRegistry } = require('../../dist-electron/shared/agent-runtime-registry.js');

const agentProviderRegistry = () => createAgentProviderRuntimeRegistry({
  codex: {
    defaultModel: 'gpt-5.4',
    defaultReasoningEffort: 'medium',
    modelValues: ['gpt-5.4', 'gpt-5.4-mini'],
    reasoningEffortValues: ['none', 'low', 'medium', 'high'],
  },
  claude: {
    defaultModel: 'sonnet',
    defaultEffort: 'medium',
    modelValues: ['sonnet', 'opus'],
    effortValues: ['low', 'medium', 'high', 'max'],
  },
  antigravity: {
    defaultModel: 'gemini-3.5-flash-medium',
    defaultEffort: 'medium',
    modelValues: ['gemini-3.5-flash-medium', 'gemini-3.5-flash-high'],
    effortValues: ['low', 'medium', 'high'],
  },
});

const settingsSeed = () => ({
  userEmail: '',
  plan: 'Free',
  safeMode: true,
  developerMode: { enabled: false, pathEntries: [] },
  defaultAgentProvider: 'auto',
  defaultChatPermissionMode: 'safe',
  defaultChatNetworkAccess: true,
  codexDefaults: { model: 'gpt-5.4', reasoningEffort: 'medium' },
  llmProviderDefaults: {
    codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
    claude: { model: 'sonnet', effort: 'medium' },
    antigravity: { model: 'gemini-3.5-flash-medium', effort: 'medium' },
  },
  agentDefaults: {
    codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
    claude: { model: 'sonnet', effort: 'medium' },
    antigravity: { model: 'gemini-3.5-flash-medium', effort: 'medium' },
  },
  providerConnections: {},
});

const createHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-settings-service-'));
  const state = {
    promptOverridesStore: null,
    settings: {
      ...settingsSeed(),
      ...overrides.settings,
    },
  };
  const controller = createSettingsServiceController({
    agentProviderRegistry: agentProviderRegistry(),
    PromptOverridesStore: class PromptOverridesStore {
      constructor(filePath) {
        this.filePath = filePath;
      }
    },
    fs,
    getAntigravityAuthStatus: overrides.getAntigravityAuthStatus,
    getClaudeAuthStatus: overrides.getClaudeAuthStatus ?? (async () => ({ authenticated: overrides.claudeAuthenticated ?? false })),
    getCodexAuthStatus: overrides.getCodexAuthStatus ?? (async () => ({ authenticated: overrides.codexAuthenticated ?? false })),
    getPromptOverridesPath: () => path.join(root, 'prompt-overrides.json'),
    getSettingsPath: () => path.join(root, 'settings.json'),
    path,
    settingsSeed: settingsSeed(),
    state,
  });
  return {
    controller,
    root,
    settingsPath: path.join(root, 'settings.json'),
    state,
    cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
  };
};

test('SettingsService normalizes persisted settings, preserves safe fields, and caches prompt override stores', async () => {
  const harness = await createHarness();
  try {
    await fs.writeFile(harness.settingsPath, JSON.stringify({
      userEmail: 'user@example.com',
      plan: 'Pro',
      safeMode: false,
      defaultAgentProvider: 'invalid',
      defaultChatPermissionMode: 'unsafe',
      defaultChatNetworkAccess: false,
      codexDefaults: { model: 'custom-codex', reasoningEffort: 'invalid' },
      agentDefaults: {
        codex: { model: 'agent-codex', reasoningEffort: 'high' },
        claude: { model: 'opus', effort: 'max' },
        antigravity: { model: 'gemini-3.5-flash-high', effort: 'high' },
      },
      providerConnections: {
        codex: '2026-05-20T00:00:00.000Z',
        claude: '',
        other: 'ignored',
      },
    }), 'utf8');

    await harness.controller.loadSettings();
    const store = harness.controller.getPromptOverridesStore();

    assert.equal(harness.state.settings.userEmail, 'user@example.com');
    assert.equal(harness.state.settings.plan, 'Pro');
    assert.equal(harness.state.settings.safeMode, false);
    assert.equal(harness.state.settings.defaultAgentProvider, 'auto');
    assert.equal(harness.state.settings.defaultChatPermissionMode, 'unsafe');
    assert.equal(harness.state.settings.defaultChatNetworkAccess, false);
    assert.deepEqual(harness.state.settings.codexDefaults, { model: 'custom-codex', reasoningEffort: 'medium' });
    assert.deepEqual(harness.state.settings.agentDefaults.codex, { model: 'agent-codex', reasoningEffort: 'high' });
    assert.deepEqual(harness.state.settings.agentDefaults.claude, { model: 'opus', effort: 'max' });
    assert.deepEqual(harness.state.settings.agentDefaults.antigravity, { model: 'gemini-3.5-flash-high', effort: 'high' });
    assert.deepEqual(harness.state.settings.providerConnections, { codex: '2026-05-20T00:00:00.000Z' });
    assert.equal(harness.controller.getPromptOverridesStore(), store);
    assert.equal(store.filePath, path.join(harness.root, 'prompt-overrides.json'));
  } finally {
    await harness.cleanup();
  }
});

test('SettingsService updates defaults and normalizes invalid provider/model inputs', async () => {
  const harness = await createHarness();
  try {
    await harness.controller.loadSettings();
    const codexSettings = await harness.controller.updateCodexDefaults({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'high',
    });
    assert.deepEqual(codexSettings.codexDefaults, { model: 'gpt-5.4-mini', reasoningEffort: 'high' });
    assert.deepEqual(harness.controller.getCodexDefaults(), { model: 'gpt-5.4-mini', reasoningEffort: 'high' });

    const providerOnly = await harness.controller.updateAgentDefaults({ defaultProvider: 'claude', provider: 'bad' });
    assert.equal(providerOnly.defaultAgentProvider, 'claude');
    const permissionOnly = await harness.controller.updateAgentDefaults({ defaultChatPermissionMode: 'unsafe' });
    assert.equal(permissionOnly.defaultChatPermissionMode, 'unsafe');
    const networkOnly = await harness.controller.updateAgentDefaults({ defaultChatNetworkAccess: false });
    assert.equal(networkOnly.defaultChatNetworkAccess, false);
    assert.equal(JSON.parse(await fs.readFile(harness.settingsPath, 'utf8')).defaultChatNetworkAccess, false);

    const codex = await harness.controller.updateAgentDefaults({
      defaultProvider: 'auto',
      provider: 'codex',
      model: 'gpt-5.4',
      effort: 'none',
    });
    assert.equal(codex.defaultAgentProvider, 'auto');
    assert.deepEqual(codex.agentDefaults.codex, { model: 'gpt-5.4', reasoningEffort: 'none' });

    const claude = await harness.controller.updateAgentDefaults({
      defaultProvider: 'codex',
      provider: 'claude',
      model: 'opus',
      effort: 'max',
    });
    assert.equal(claude.defaultAgentProvider, 'codex');
    assert.deepEqual(claude.agentDefaults.claude, { model: 'opus', effort: 'max' });
    assert.equal(JSON.parse(await fs.readFile(harness.settingsPath, 'utf8')).defaultAgentProvider, 'codex');

    const invalidCodex = await harness.controller.updateCodexDefaults({
      model: 123,
      reasoningEffort: 'invalid',
    });
    assert.deepEqual(invalidCodex.codexDefaults, { model: 'gpt-5.4', reasoningEffort: 'medium' });

    const fallbackCodex = await harness.controller.updateAgentDefaults({
      provider: 'codex',
      effort: 'invalid',
    });
    assert.deepEqual(fallbackCodex.agentDefaults.codex, { model: 'gpt-5.4', reasoningEffort: 'medium' });

    const fallbackClaude = await harness.controller.updateAgentDefaults({
      provider: 'claude',
      model: 42,
      effort: 'bad',
    });
    assert.deepEqual(fallbackClaude.agentDefaults.claude, { model: 'opus', effort: 'max' });

    const antigravity = await harness.controller.updateAgentDefaults({
      provider: 'antigravity',
      model: 'gemini-3.5-flash-high',
      effort: 'high',
    });
    assert.deepEqual(antigravity.agentDefaults.antigravity, { model: 'gemini-3.5-flash-high', effort: 'high' });
  } finally {
    await harness.cleanup();
  }
});

test('SettingsService falls back to seeds and records first provider connections once', async () => {
  const harness = await createHarness();
  try {
    await harness.controller.loadSettings();
    assert.deepEqual(harness.state.settings, settingsSeed());

    await harness.controller.markProviderConnected('claude');
    const firstSaved = JSON.parse(await fs.readFile(harness.settingsPath, 'utf8'));
    assert.equal(firstSaved.defaultAgentProvider, 'claude');
    assert.equal(typeof firstSaved.providerConnections.claude, 'string');

    await harness.controller.markProviderConnected('claude');
    const secondSaved = JSON.parse(await fs.readFile(harness.settingsPath, 'utf8'));
    assert.deepEqual(secondSaved, firstSaved);

    await harness.controller.markProviderConnected('codex');
    const thirdSaved = JSON.parse(await fs.readFile(harness.settingsPath, 'utf8'));
    assert.equal(thirdSaved.defaultAgentProvider, 'claude');
    assert.equal(typeof thirdSaved.providerConnections.codex, 'string');
  } finally {
    await harness.cleanup();
  }
});

test('SettingsService chooses connected providers by preference and connection age, then applies manifest defaults', async () => {
  const harness = await createHarness({
    codexAuthenticated: true,
    claudeAuthenticated: true,
    settings: {
      providerConnections: {
        claude: '2026-05-20T00:00:00.000Z',
        codex: '2026-05-21T00:00:00.000Z',
      },
      llmProviderDefaults: {
        codex: { model: 'gpt-5.4-mini', reasoningEffort: 'high' },
        claude: { model: 'opus', effort: 'max' },
        antigravity: { model: 'gemini-3.5-flash-high', effort: 'high' },
      },
      agentDefaults: {
        codex: { model: 'gpt-5.4-mini', reasoningEffort: 'high' },
        claude: { model: 'opus', effort: 'max' },
        antigravity: { model: 'gemini-3.5-flash-high', effort: 'high' },
      },
    },
  });
  try {
    assert.equal(await harness.controller.chooseConnectedProvider(), 'claude');
    await harness.controller.updateAgentDefaults({ defaultProvider: 'codex' });
    assert.equal(await harness.controller.chooseConnectedProvider(), 'codex');
    assert.deepEqual(await harness.controller.chooseAgentRuntime({
      provider: 'claude',
      model: 'gpt-5.4-mini',
      effort: 'high',
      recommendations: {
        codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
        claude: { model: 'missing', effort: 'bad' },
        antigravity: { model: 'gemini-3.5-flash-medium', effort: 'medium' },
      },
    }), {
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    });
    assert.deepEqual(harness.controller.withAgentDefaults({
      id: 'agent',
      model: 'unknown',
      reasoningEffort: 'low',
      runtime: { provider: 'claude', model: 'sonnet', effort: 'bad' },
    }), {
      id: 'agent',
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      runtimeRecommendations: {
        codex: { model: 'gpt-5.4-mini', reasoningEffort: 'low' },
        claude: { model: 'opus', effort: 'max' },
        antigravity: { model: 'gemini-3.5-flash-high', effort: 'high' },
      },
      runtime: { provider: 'claude', model: 'sonnet', effort: 'max' },
    });
    assert.deepEqual(await harness.controller.chooseAgentRuntime({
      recommendations: {
        codex: { model: 'gpt-5.4', reasoningEffort: 'none' },
      },
    }), {
      provider: 'codex',
      model: 'gpt-5.4',
      effort: 'none',
    });
    assert.deepEqual(harness.controller.withAgentDefaults({
      id: 'codex-agent',
      runtimeRecommendations: {
        codex: { model: 'bad-model', reasoningEffort: 'bad' },
        claude: { model: 'sonnet', effort: 'low' },
        antigravity: { model: 'gemini-3.5-flash-medium', effort: 'low' },
      },
    }).runtimeRecommendations, {
      codex: { model: 'gpt-5.4-mini', reasoningEffort: 'high' },
      claude: { model: 'sonnet', effort: 'low' },
      antigravity: { model: 'gemini-3.5-flash-medium', effort: 'low' },
    });
  } finally {
    await harness.cleanup();
  }
});

test('SettingsService chooses provider fallbacks when auth or connection metadata is missing', async () => {
  const unauthenticated = await createHarness();
  try {
    assert.equal(await unauthenticated.controller.chooseConnectedProvider(), 'codex');
  } finally {
    await unauthenticated.cleanup();
  }

  const claudeOnly = await createHarness({ claudeAuthenticated: true });
  try {
    assert.equal(await claudeOnly.controller.chooseConnectedProvider(), 'claude');
  } finally {
    await claudeOnly.cleanup();
  }

  const bothWithoutTimestamps = await createHarness({
    codexAuthenticated: true,
    claudeAuthenticated: true,
  });
  try {
    assert.equal(await bothWithoutTimestamps.controller.chooseConnectedProvider(), 'codex');
  } finally {
    await bothWithoutTimestamps.cleanup();
  }

  let antigravityChecks = 0;
  const codexFastPath = await createHarness({
    codexAuthenticated: true,
    getAntigravityAuthStatus: async () => {
      antigravityChecks += 1;
      throw new Error('antigravity_should_not_block_codex');
    },
  });
  try {
    assert.equal(await codexFastPath.controller.chooseConnectedProvider(), 'codex');
    assert.equal(antigravityChecks, 0);
  } finally {
    await codexFastPath.cleanup();
  }
});

test('SettingsService normalizes malformed shapes, trims model names, and survives auth status failures', async () => {
  const malformed = await createHarness({
    settings: {
      userEmail: 42,
      plan: false,
      safeMode: 'yes',
      defaultAgentProvider: 'bad',
      codexDefaults: [],
      agentDefaults: {
        codex: [],
        claude: [],
      },
      providerConnections: [],
    },
  });
  try {
    assert.deepEqual(malformed.controller.normalizeSettings(malformed.state.settings), settingsSeed());
  } finally {
    await malformed.cleanup();
  }

  const trimmed = await createHarness();
  try {
    const codex = await trimmed.controller.updateCodexDefaults({
      model: ' gpt-5.4-mini ',
      reasoningEffort: 'low',
    });
    assert.deepEqual(codex.agentDefaults.codex, { model: 'gpt-5.4-mini', reasoningEffort: 'low' });

    const runtime = await trimmed.controller.chooseAgentRuntime({
      provider: 'codex',
      model: ' gpt-5.4 ',
      effort: 'bad',
      recommendations: {
        codex: { model: 'gpt-5.4-mini', reasoningEffort: 'high' },
      },
    });
    assert.deepEqual(runtime, { provider: 'codex', model: 'gpt-5.4', effort: 'low' });
  } finally {
    await trimmed.cleanup();
  }

  const authFailures = await createHarness({
    getCodexAuthStatus: async () => {
      throw new Error('codex_failed');
    },
    getClaudeAuthStatus: async () => {
      throw new Error('claude_failed');
    },
  });
  try {
    assert.equal(await authFailures.controller.chooseConnectedProvider(), 'codex');
  } finally {
    await authFailures.cleanup();
  }
});
