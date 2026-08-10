import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSettingsServiceController } = require('../../dist-electron/main/core/settings-service.js');
const { createAgentProviderRuntimeRegistry } = require('../../dist-electron/shared/agent-runtime-registry.js');

const registry = createAgentProviderRuntimeRegistry({
  codex: {
    defaultModel: 'gpt-5.4', defaultReasoningEffort: 'medium',
    modelValues: ['gpt-5.4', 'gpt-5.4-mini'], reasoningEffortValues: ['none', 'low', 'medium', 'high'],
  },
  claude: {
    defaultModel: 'sonnet', defaultEffort: 'medium',
    modelValues: ['sonnet', 'opus'], effortValues: ['low', 'medium', 'high', 'max'],
  },
  antigravity: {
    defaultModel: 'gemini-3.5-flash', defaultEffort: 'medium',
    modelValues: ['gemini-3.5-flash', 'gemini-3.1-pro'], effortValues: ['low', 'medium', 'high'],
  },
});

const seed = () => ({
  userEmail: '', plan: 'Free', safeMode: true,
  earlyAccess: { workflowsEnabled: false },
  developerMode: { enabled: false, pathEntries: [] },
  defaultAgentProvider: 'auto', defaultChatPermissionMode: 'safe', defaultChatNetworkAccess: true,
  providerInactivityTimeoutMinutes: { codex: 240, claude: 240, antigravity: 240 },
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
  providerConnections: {}, llmProviderProfiles: {}, activeProviderProfiles: {},
});

const createHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-settings-b18-'));
  const settingsPath = path.join(root, 'settings.json');
  const state = { promptOverridesStore: null, settings: { ...seed(), ...overrides.settings } };
  const deps = {
    agentProviderRegistry: registry,
    PromptOverridesStore: class { constructor(filePath) { this.filePath = filePath; } },
    fs: overrides.fileSystem ?? fs,
    getClaudeAuthStatus: overrides.getClaudeAuthStatus ?? (async () => ({ authenticated: false })),
    getCodexAuthStatus: overrides.getCodexAuthStatus ?? (async () => ({ authenticated: false })),
    getAntigravityAuthStatus: overrides.getAntigravityAuthStatus,
    getPromptOverridesPath: () => path.join(root, 'prompts.json'),
    getSettingsPath: () => settingsPath,
    path,
    settingsSeed: seed(),
    state,
  };
  if (overrides.withMetadataRoot !== false) deps.getMetadataRoot = () => root;
  return {
    root, settingsPath, state,
    controller: createSettingsServiceController(deps),
    cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
  };
};

test('given rich and malformed provider profiles, normalization filters, deduplicates, labels, and provider-specific defaults safely', async () => {
  const harness = await createHarness();
  try {
    const normalized = harness.controller.normalizeSettings({
      providerInactivityTimeoutMinutes: 'invalid',
      llmProviderProfiles: {
        codex: [null, [], {}, {
          id: ' codex:work ', provider: 'wrong', label: ' ', authMode: 'bad', runtimeAuthMode: 'bad',
          status: 'bad', source: 'bad', installSource: 'bad', accountHint: 9,
          defaultModel: 'gpt-5.4-mini', defaultEffort: 'high', connectedAt: 9,
        }, {
          id: 'codex:work', label: 'Latest', authMode: 'api_key', runtimeAuthMode: 'externalActiveOnly',
          status: 'connected', source: 'desktop', installSource: 'managed', accountHint: ' mail@example.com ',
          defaultModel: 'gpt-5.4', defaultEffort: undefined,
          connectedAt: ' now ', lastCheckedAt: ' checked ', lastUsedAt: ' used ', unavailableReason: ' none ',
        }],
        claude: [{
          id: 'claude:work', authMode: 'oauth', runtimeAuthMode: 'materialized', status: 'connected',
          source: 'local_cli', installSource: 'system', defaultModel: 'opus', defaultEffort: 'max',
        }],
        antigravity: [{
          id: 'antigravity:work', authMode: 'cli', runtimeAuthMode: 'materialized', status: 'connected',
          source: 'legacy_provider_connections', installSource: 'unknown', defaultModel: 'gemini-3.1-pro', defaultEffort: 'high',
        }, {
          id: 'antigravity:fallback-runtime', authMode: 'bad', runtimeAuthMode: 'bad', status: 'missing',
        }],
      },
      activeProviderProfiles: {
        codex: 'codex:work', claude: 'claude:work', antigravity: 'antigravity:work',
      },
    });
    assert.equal(normalized.llmProviderProfiles.codex.length, 1);
    assert.equal(normalized.llmProviderProfiles.codex[0].label, 'Latest');
    assert.equal(normalized.llmProviderProfiles.codex[0].accountHint, 'mail@example.com');
    assert.equal(normalized.llmProviderProfiles.codex[0].defaultEffort, undefined);
    assert.equal(normalized.llmProviderProfiles.claude[0].label, 'Claude');
    assert.equal(normalized.llmProviderProfiles.claude[0].defaultModel, 'opus');
    assert.equal(normalized.llmProviderProfiles.claude[0].defaultEffort, 'max');
    assert.equal(normalized.llmProviderProfiles.antigravity[0].runtimeAuthMode, 'externalActiveOnly');
    assert.equal(normalized.llmProviderProfiles.antigravity[0].defaultModel, 'gemini-3.1-pro');
    assert.equal(normalized.activeProviderProfiles.antigravity, 'antigravity:work');

    const firstConnected = harness.controller.normalizeSettings({
      llmProviderProfiles: {
        codex: [{ id: 'codex:first', status: 'connected' }],
      },
    });
    assert.equal(firstConnected.activeProviderProfiles.codex, 'codex:first');
  } finally {
    await harness.cleanup();
  }
});

test('given developer settings, omitted fields retain state while validated paths and explicit disable persist atomically', async () => {
  const harness = await createHarness();
  try {
    const first = await harness.controller.updateDeveloperMode({ enabled: true, pathEntries: [harness.root, harness.root, ' '] });
    assert.equal(first.developerMode.enabled, true);
    assert.deepEqual(first.developerMode.pathEntries, [harness.root]);
    const retained = await harness.controller.updateDeveloperMode({});
    assert.deepEqual(retained.developerMode, first.developerMode);
    const disabled = await harness.controller.updateDeveloperMode({ enabled: false });
    assert.equal(disabled.developerMode.enabled, false);
    assert.deepEqual(JSON.parse(await fs.readFile(harness.settingsPath, 'utf8')).developerMode, disabled.developerMode);
  } finally {
    await harness.cleanup();
  }

  const fallbackRoot = await createHarness({ withMetadataRoot: false });
  try {
    await fs.writeFile(fallbackRoot.settingsPath, JSON.stringify({ safeMode: true }));
    await fs.writeFile(path.join(fallbackRoot.root, 'workflows.json'), '[]');
    await fallbackRoot.controller.loadSettings();
    assert.equal(fallbackRoot.state.settings.earlyAccess.workflowsEnabled, false);
  } finally {
    await fallbackRoot.cleanup();
  }
});

test('given provider disconnects and profile mutations, no-op, invalid, missing, disconnected, and success contracts remain explicit', async () => {
  const harness = await createHarness({
    settings: {
      defaultAgentProvider: 'claude',
      providerConnections: { claude: '2026-01-01T00:00:00.000Z' },
      llmProviderProfiles: {
        claude: [
          { id: 'claude:work', provider: 'claude', label: 'Work', authMode: 'oauth', runtimeAuthMode: 'materialized', status: 'connected', source: 'desktop' },
          { id: 'claude:old', provider: 'claude', label: 'Old', authMode: 'oauth', runtimeAuthMode: 'materialized', status: 'expired', source: 'desktop' },
        ],
      },
      activeProviderProfiles: { claude: 'claude:work' },
    },
  });
  try {
    await harness.controller.markProviderDisconnected('codex');
    assert.equal(harness.state.settings.defaultAgentProvider, 'claude');

    assert.equal((await harness.controller.setActiveLlmProviderProfile({ provider: 'bad', profileId: '' })).technicalCode, 'invalid_provider_profile');
    assert.equal((await harness.controller.setActiveLlmProviderProfile({ provider: 'claude', profileId: 'claude:old' })).technicalCode, 'provider_profile_not_connected');
    assert.equal((await harness.controller.updateLlmProviderProfileDefaults({ provider: 'bad', profileId: '' })).technicalCode, 'invalid_provider_profile');
    assert.equal((await harness.controller.updateLlmProviderProfileDefaults({ provider: 'claude', profileId: 'claude:missing' })).technicalCode, 'provider_profile_not_found');

    const unchangedDefaults = await harness.controller.updateLlmProviderProfileDefaults({ provider: 'claude', profileId: 'claude:work' });
    assert.equal(unchangedDefaults.success, true);
    assert.equal(unchangedDefaults.state.providers.claude.find((item) => item.id === 'claude:work').defaultModel, undefined);

    for (const [provider, profileId, model, effort] of [
      ['claude', 'claude:work', 'opus', 'max'],
    ]) {
      const result = await harness.controller.updateLlmProviderProfileDefaults({ provider, profileId, model, effort });
      assert.equal(result.success, true);
      const profile = result.state.providers[provider].find((item) => item.id === profileId);
      assert.equal(profile.defaultModel, model);
      assert.equal(profile.defaultEffort, effort);
    }
    await harness.controller.markProviderDisconnected('claude');
    assert.equal(harness.state.settings.defaultAgentProvider, 'auto');

    const antigravityDefaults = await harness.controller.updateAgentDefaults({ provider: 'antigravity' });
    assert.deepEqual(antigravityDefaults.agentDefaults.antigravity, { model: 'gemini-3.5-flash', effort: 'medium' });
  } finally {
    await harness.cleanup();
  }
});

test('given Google runtime defaults and every embedded runtime kind, recommendations preserve provider identity and auth profiles', async () => {
  const harness = await createHarness({
    settings: {
      providerConnections: { antigravity: '2026-01-01T00:00:00.000Z' },
      llmProviderProfiles: {
        antigravity: [{
          id: 'antigravity:work', provider: 'antigravity', label: 'Google Work', authMode: 'oauth',
          runtimeAuthMode: 'externalActiveOnly', status: 'connected', source: 'desktop',
          defaultModel: 'gemini-3.1-pro', defaultEffort: 'high',
        }],
      },
      activeProviderProfiles: { antigravity: 'antigravity:work' },
    },
    getAntigravityAuthStatus: async () => ({ authenticated: true }),
  });
  try {
    assert.deepEqual(await harness.controller.chooseAgentRuntime({
      provider: 'antigravity', authProfileId: 'antigravity:work',
      recommendations: { antigravity: { model: 'bad', effort: 'bad' } },
    }), {
      provider: 'antigravity', model: 'gemini-3.1-pro', effort: 'high', authProfileId: 'antigravity:work',
    });
    assert.equal(await harness.controller.chooseConnectedProvider(), 'antigravity');

    const noProfiles = await createHarness();
    try {
      assert.equal((await noProfiles.controller.setActiveLlmProviderProfile({ provider: 'codex', profileId: 'codex:missing' })).technicalCode, 'provider_profile_not_found');
      assert.equal((await noProfiles.controller.updateLlmProviderProfileDefaults({ provider: 'codex', profileId: 'codex:missing' })).technicalCode, 'provider_profile_not_found');
      assert.equal((await noProfiles.controller.chooseAgentRuntime({ provider: 'claude' })).authProfileId, undefined);
      assert.equal((await noProfiles.controller.chooseAgentRuntime({ provider: 'antigravity' })).authProfileId, undefined);
    } finally {
      await noProfiles.cleanup();
    }

    const defaults = {
      codex: { model: '', reasoningEffort: '' },
      claude: { model: '', effort: '' },
      antigravity: { model: '', effort: '' },
    };
    const antigravity = harness.controller.withAgentDefaults({
      id: 'google', runtime: { provider: 'antigravity', model: 'bad', effort: 'bad', authProfileId: 'google-profile' },
    }, defaults);
    assert.equal(antigravity.runtime.provider, 'antigravity');
    assert.equal(antigravity.runtime.authProfileId, 'google-profile');
    const codex = harness.controller.withAgentDefaults({
      id: 'codex', runtime: { provider: 'codex', model: 'bad', effort: 'bad', authProfileId: 'codex-profile' },
    }, defaults);
    assert.equal(codex.runtime.provider, 'codex');
    assert.equal(codex.runtime.authProfileId, 'codex-profile');
    assert.equal(harness.controller.withAgentDefaults({
      id: 'codex-without-profile', runtime: { provider: 'codex', model: 'bad', effort: 'bad' },
    }, defaults).runtime.authProfileId, undefined);
    assert.equal(harness.controller.withAgentDefaults({
      id: 'google-without-profile', runtime: { provider: 'antigravity', model: 'bad', effort: 'bad' },
    }, defaults).runtime.authProfileId, undefined);
    assert.equal(harness.controller.withAgentDefaults({
      id: 'claude-profile', runtime: { provider: 'claude', model: 'bad', effort: 'bad', authProfileId: 'claude-profile' },
    }, defaults).runtime.authProfileId, 'claude-profile');
    const plain = harness.controller.withAgentDefaults({ id: 'plain' }, defaults);
    assert.equal(plain.runtime, undefined);
  } finally {
    await harness.cleanup();
  }
});
