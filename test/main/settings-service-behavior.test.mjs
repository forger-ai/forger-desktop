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
    defaultModel: 'gemini-3.5-flash',
    defaultEffort: 'medium',
    modelValues: ['gemini-3.5-flash', 'gemini-3.1-pro'],
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
    antigravity: { model: 'gemini-3.5-flash', effort: 'medium' },
  },
  agentDefaults: {
    codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
    claude: { model: 'sonnet', effort: 'medium' },
    antigravity: { model: 'gemini-3.5-flash', effort: 'medium' },
  },
  providerConnections: {},
  llmProviderProfiles: {},
  activeProviderProfiles: {},
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
    agentProviderRegistry: overrides.agentProviderRegistry ?? agentProviderRegistry(),
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

test('SettingsService migrates legacy Claude default models to selectable provider defaults', async () => {
  const versionedRegistry = createAgentProviderRuntimeRegistry({
    codex: {
      defaultModel: 'gpt-5.4',
      defaultReasoningEffort: 'medium',
      modelValues: ['gpt-5.4', 'gpt-5.4-mini'],
      reasoningEffortValues: ['none', 'low', 'medium', 'high'],
    },
    claude: {
      defaultModel: 'claude-sonnet-5',
      defaultEffort: 'high',
      modelValues: ['claude-sonnet-5', 'claude-opus-4-8'],
      effortValues: ['low', 'medium', 'high', 'max'],
    },
    antigravity: {
      defaultModel: 'gemini-3.5-flash',
      defaultEffort: 'medium',
      modelValues: ['gemini-3.5-flash', 'gemini-3.1-pro'],
      effortValues: ['low', 'medium', 'high'],
    },
  });
  const harness = await createHarness({
    agentProviderRegistry: versionedRegistry,
    settings: {
      llmProviderDefaults: {
        codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
        claude: { model: 'sonnet', effort: 'medium' },
        antigravity: { model: 'gemini-3.5-flash', effort: 'medium' },
      },
      agentDefaults: {
        codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
        claude: { model: 'sonnet', effort: 'medium' },
        antigravity: { model: 'gemini-3.5-flash', effort: 'medium' },
      },
    },
  });
  try {
    await harness.controller.loadSettings();
    assert.deepEqual(harness.state.settings.agentDefaults.claude, { model: 'claude-sonnet-5', effort: 'medium' });
    assert.deepEqual(harness.state.settings.llmProviderDefaults.claude, { model: 'claude-sonnet-5', effort: 'medium' });
  } finally {
    await harness.cleanup();
  }
});

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
    assert.deepEqual(harness.state.settings.agentDefaults.antigravity, { model: 'gemini-3.5-flash', effort: 'high' });
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
      model: 'gemini-3.5-flash',
      effort: 'high',
    });
    assert.deepEqual(antigravity.agentDefaults.antigravity, { model: 'gemini-3.5-flash', effort: 'high' });
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
    assert.equal(firstSaved.activeProviderProfiles.claude, 'claude:system');
    assert.equal(firstSaved.llmProviderProfiles.claude[0].label, 'Claude');
    assert.equal(firstSaved.llmProviderProfiles.claude[0].runtimeAuthMode, 'externalActiveOnly');

    await harness.controller.markProviderConnected('claude');
    const secondSaved = JSON.parse(await fs.readFile(harness.settingsPath, 'utf8'));
    assert.deepEqual(secondSaved, firstSaved);

    await harness.controller.markProviderConnected('codex');
    const thirdSaved = JSON.parse(await fs.readFile(harness.settingsPath, 'utf8'));
    assert.equal(thirdSaved.defaultAgentProvider, 'claude');
    assert.equal(typeof thirdSaved.providerConnections.codex, 'string');
    assert.equal(thirdSaved.activeProviderProfiles.codex, 'codex:system');
    assert.equal(thirdSaved.llmProviderProfiles.codex[0].runtimeAuthMode, 'externalActiveOnly');

    await harness.controller.markProviderConnected('antigravity');
    const fourthSaved = JSON.parse(await fs.readFile(harness.settingsPath, 'utf8'));
    assert.equal(fourthSaved.activeProviderProfiles.antigravity, 'antigravity:system');
    assert.equal(fourthSaved.llmProviderProfiles.antigravity[0].runtimeAuthMode, 'externalActiveOnly');
  } finally {
    await harness.cleanup();
  }
});

test('SettingsService migrates legacy local-active profiles to system profiles', async () => {
  const harness = await createHarness({
    settings: {
      providerConnections: {
        claude: '2026-06-01T00:00:00.000Z',
      },
      llmProviderProfiles: {
        claude: [
          {
            id: 'claude:local-active',
            provider: 'claude',
            label: 'Claude',
            authMode: 'cli',
            runtimeAuthMode: 'materialized',
            status: 'connected',
            source: 'local_cli',
          },
        ],
      },
      activeProviderProfiles: {
        claude: 'claude:local-active',
      },
    },
  });
  try {
    const listed = await harness.controller.listLlmProviderProfiles();
    assert.equal(listed.activeProfileIds.claude, 'claude:system');
    assert.equal(listed.providers.claude.some((profile) => profile.id === 'claude:local-active'), false);
    assert.equal(listed.providers.claude.find((profile) => profile.id === 'claude:system').runtimeAuthMode, 'externalActiveOnly');
    assert.deepEqual(await harness.controller.chooseAgentRuntime({
      provider: 'claude',
      authProfileId: 'claude:local-active',
    }), {
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      authProfileId: 'claude:system',
    });
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
        antigravity: { model: 'gemini-3.5-flash', effort: 'high' },
      },
      agentDefaults: {
        codex: { model: 'gpt-5.4-mini', reasoningEffort: 'high' },
        claude: { model: 'opus', effort: 'max' },
        antigravity: { model: 'gemini-3.5-flash', effort: 'high' },
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
        antigravity: { model: 'gemini-3.5-flash', effort: 'medium' },
      },
    }), {
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      authProfileId: 'claude:system',
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
        antigravity: { model: 'gemini-3.5-flash', effort: 'medium' },
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
      authProfileId: 'codex:system',
    });
    assert.equal(await harness.controller.chooseAgentRuntime({
      provider: 'codex',
      model: 'bad-model',
      strict: true,
    }).then(() => 'ok', (error) => error.message), 'agent_runtime_model_unsupported');
    assert.equal(await harness.controller.chooseAgentRuntime({
      provider: 'codex',
      model: 'gpt-5.4',
      effort: 'xhigh',
      strict: true,
    }).then(() => 'ok', (error) => error.message), 'agent_runtime_effort_unsupported');
    assert.deepEqual(harness.controller.withAgentDefaults({
      id: 'codex-agent',
      runtimeRecommendations: {
        codex: { model: 'bad-model', reasoningEffort: 'bad' },
        claude: { model: 'sonnet', effort: 'low' },
        antigravity: { model: 'gemini-3.5-flash', effort: 'low' },
      },
    }).runtimeRecommendations, {
      codex: { model: 'gpt-5.4-mini', reasoningEffort: 'high' },
      claude: { model: 'sonnet', effort: 'low' },
      antigravity: { model: 'gemini-3.5-flash', effort: 'low' },
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

test('SettingsService exposes provider profile state and keeps system as the effective default without secrets', async () => {
  const harness = await createHarness({
    settings: {
      providerConnections: {
        codex: '2026-06-01T00:00:00.000Z',
      },
      llmProviderProfiles: {
        codex: [
          {
            id: 'codex:work',
            provider: 'codex',
            label: 'Work',
            authMode: 'oauth',
            runtimeAuthMode: 'materialized',
            accountHint: 'user@example.com',
            status: 'connected',
            source: 'desktop',
            defaultModel: 'gpt-5.4-mini',
            defaultEffort: 'high',
          },
        ],
      },
      activeProviderProfiles: {
        codex: 'codex:work',
      },
    },
  });
	  try {
	    const initial = await harness.controller.listLlmProviderProfiles();
	    assert.equal(initial.activeProfileIds.codex, 'codex:system');
	    assert.equal(initial.providers.codex.some((profile) => profile.id === 'codex:system'), true);
	    assert.equal(initial.providers.codex.find((profile) => profile.id === 'codex:system').active, true);
	    assert.equal(initial.providers.codex.find((profile) => profile.id === 'codex:system').isDefault, true);
	    assert.equal(initial.providers.codex.find((profile) => profile.id === 'codex:system').runtimeAuthMode, 'externalActiveOnly');
	    assert.equal(initial.providers.codex.find((profile) => profile.id === 'codex:work').active, false);
	    assert.equal(initial.providers.codex.find((profile) => profile.id === 'codex:work').accountHint, 'user@example.com');
	    assert.equal(JSON.stringify(initial).includes('secret'), false);
	    assert.deepEqual(await harness.controller.chooseAgentRuntime({ provider: 'codex' }), {
	      provider: 'codex',
	      model: 'gpt-5.4',
	      effort: 'medium',
	      authProfileId: 'codex:system',
	    });
	    const updatedDefaults = await harness.controller.updateLlmProviderProfileDefaults({
	      provider: 'codex',
	      profileId: 'codex:system',
	      model: 'gpt-5.4',
	      effort: 'high',
	    });
	    assert.equal(updatedDefaults.success, true);
	    assert.equal(updatedDefaults.state.providers.codex.find((profile) => profile.id === 'codex:system').defaultModel, 'gpt-5.4');
	    assert.deepEqual(await harness.controller.chooseAgentRuntime({ provider: 'codex' }), {
	      provider: 'codex',
	      model: 'gpt-5.4',
	      effort: 'high',
	      authProfileId: 'codex:system',
	    });

    const selected = await harness.controller.setActiveLlmProviderProfile({
      provider: 'codex',
      profileId: 'codex:system',
    });
    assert.equal(selected.success, true);
    assert.equal(selected.state.activeProfileIds.codex, 'codex:system');
    assert.equal((await harness.controller.chooseAgentRuntime({ provider: 'codex' })).authProfileId, 'codex:system');

    await harness.controller.markProviderDisconnected('codex');
    const disconnected = await harness.controller.listLlmProviderProfiles();
    assert.equal(disconnected.activeProfileIds.codex, undefined);
    assert.equal(disconnected.providers.codex.find((profile) => profile.id === 'codex:system').status, 'missing');
  } finally {
    await harness.cleanup();
  }
});

test('SettingsService only returns active connected auth profiles for agent runtimes', async () => {
  const harness = await createHarness({
    settings: {
      providerConnections: {
        codex: '2026-06-01T00:00:00.000Z',
      },
      llmProviderProfiles: {
        codex: [
          {
            id: 'codex:expired',
            provider: 'codex',
            label: 'Expired',
            authMode: 'oauth',
            runtimeAuthMode: 'materialized',
            status: 'expired',
            source: 'desktop',
          },
          {
            id: 'codex:work',
            provider: 'codex',
            label: 'Work',
            authMode: 'oauth',
            runtimeAuthMode: 'materialized',
            status: 'connected',
            source: 'desktop',
          },
        ],
      },
      activeProviderProfiles: {
        codex: 'codex:expired',
      },
    },
  });
  try {
	    const listed = await harness.controller.listLlmProviderProfiles();
	    assert.equal(listed.activeProfileIds.codex, 'codex:system');
	    assert.equal(listed.providers.codex.find((profile) => profile.id === 'codex:system').active, true);
	    assert.equal(listed.providers.codex.find((profile) => profile.id === 'codex:work').active, false);

    await assert.rejects(
      harness.controller.chooseAgentRuntime({
        provider: 'codex',
        authProfileId: 'codex:expired',
      }),
      /provider_profile_not_found/,
    );
	    assert.equal((await harness.controller.chooseAgentRuntime({ provider: 'codex' })).authProfileId, 'codex:system');

    const missing = await harness.controller.setActiveLlmProviderProfile({
      provider: 'codex',
      profileId: 'codex:missing',
    });
    assert.equal(missing.success, false);
    assert.equal(missing.technicalCode, 'provider_profile_not_found');

    const expired = await harness.controller.setActiveLlmProviderProfile({
      provider: 'codex',
      profileId: 'codex:expired',
    });
    assert.equal(expired.success, false);
    assert.equal(expired.technicalCode, 'provider_profile_not_connected');

    const selected = await harness.controller.setActiveLlmProviderProfile({
      provider: 'codex',
      profileId: 'codex:system',
    });
    assert.equal(selected.success, true);
    assert.equal((await harness.controller.chooseAgentRuntime({ provider: 'codex' })).authProfileId, 'codex:system');
  } finally {
    await harness.cleanup();
  }
});

test('SettingsService rejects explicit profile overrides that do not belong to the provider', async () => {
  const harness = await createHarness({
    settings: {
      providerConnections: {
        codex: '2026-06-01T00:00:00.000Z',
        claude: '2026-06-02T00:00:00.000Z',
      },
      llmProviderProfiles: {
        codex: [
          {
            id: 'codex:work',
            provider: 'codex',
            label: 'Work',
            authMode: 'oauth',
            runtimeAuthMode: 'materialized',
            status: 'connected',
            source: 'desktop',
          },
        ],
        claude: [
          {
            id: 'claude:work',
            provider: 'claude',
            label: 'Claude Work',
            authMode: 'oauth',
            runtimeAuthMode: 'materialized',
            status: 'connected',
            source: 'desktop',
          },
        ],
      },
      activeProviderProfiles: {
        codex: 'codex:work',
        claude: 'claude:work',
      },
    },
  });
  try {
    await assert.rejects(
      harness.controller.chooseAgentRuntime({
        provider: 'codex',
        authProfileId: 'claude:work',
      }),
      /provider_profile_not_found/,
    );
    await assert.rejects(
      harness.controller.chooseAgentRuntime({
        provider: 'claude',
        authProfileId: 'claude:missing',
      }),
      /provider_profile_not_found/,
    );
  } finally {
    await harness.cleanup();
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
