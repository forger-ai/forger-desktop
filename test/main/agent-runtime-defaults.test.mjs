import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSettingsServiceController } = require('../../dist-electron/main/core/settings-service.js');
const { createAgentProviderRuntimeRegistry } = require('../../dist-electron/shared/agent-runtime-registry.js');

const agentProviderRegistry = () => createAgentProviderRuntimeRegistry({
  codex: {
    defaultModel: 'gpt-5.4',
    defaultReasoningEffort: 'medium',
    modelValues: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5'],
    reasoningEffortValues: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  claude: {
    defaultModel: 'sonnet',
    defaultEffort: 'medium',
    modelValues: ['sonnet', 'opus', 'haiku'],
    effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  antigravity: {
    defaultModel: 'gemini-3.5-flash',
    defaultEffort: 'medium',
    modelValues: ['gemini-3.5-flash', 'gemini-3.1-pro'],
    effortValues: ['low', 'medium', 'high'],
  },
});

const createController = async (overrides = {}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'forger-settings-'));
  const settingsPath = path.join(dir, 'settings.json');
  const state = {
    settings: {
      userEmail: '',
      plan: 'Free',
      safeMode: false,
      defaultAgentProvider: 'auto',
      codexDefaults: { model: 'gpt-5.4-mini', reasoningEffort: 'high' },
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
      providerConnections: {},
      ...overrides.settings,
    },
    promptOverridesStore: null,
  };
  const controller = createSettingsServiceController({
    agentProviderRegistry: agentProviderRegistry(),
    PromptOverridesStore: class {},
    fs: { mkdir, writeFile, readFile },
    getClaudeAuthStatus: async () => ({ authenticated: overrides.claudeAuthenticated ?? false }),
    getCodexAuthStatus: async () => ({ authenticated: overrides.codexAuthenticated ?? false }),
    getPromptOverridesPath: () => path.join(dir, 'prompt-overrides.json'),
    getSettingsPath: () => settingsPath,
    path,
    settingsSeed: state.settings,
    state,
  });
  return {
    controller,
    state,
    settingsPath,
    cleanup: async () => await rm(dir, { recursive: true, force: true }),
  };
};

test('first authenticated provider becomes the desktop default provider', async () => {
  const harness = await createController();
  try {
    await harness.controller.markProviderConnected('claude');
    assert.equal(harness.state.settings.defaultAgentProvider, 'claude');
    assert.ok(harness.state.settings.providerConnections.claude);

    await harness.controller.markProviderConnected('codex');
    assert.equal(harness.state.settings.defaultAgentProvider, 'claude');
    assert.ok(harness.state.settings.providerConnections.codex);
  } finally {
    await harness.cleanup();
  }
});

test('agent runtime uses desktop defaults when no explicit model is requested', async () => {
  const harness = await createController({ claudeAuthenticated: true });
  try {
    await harness.controller.markProviderConnected('claude');

    assert.deepEqual(await harness.controller.chooseAgentRuntime(), {
      provider: 'claude',
      model: 'opus',
      effort: 'max',
    });
    assert.deepEqual(await harness.controller.chooseAgentRuntime({ provider: 'codex' }), {
      provider: 'codex',
      model: 'gpt-5.4-mini',
      effort: 'high',
    });
  } finally {
    await harness.cleanup();
  }
});

test('agent runtime treats requested models as provider-specific recommendations', async () => {
  const harness = await createController({ codexAuthenticated: true });
  try {
    await harness.controller.markProviderConnected('codex');

    assert.deepEqual(await harness.controller.chooseAgentRuntime({ model: 'gpt-5.5', effort: 'xhigh' }), {
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
    });
    assert.deepEqual(await harness.controller.chooseAgentRuntime({ model: 'unknown-model', effort: 'high' }), {
      provider: 'codex',
      model: 'gpt-5.4-mini',
      effort: 'high',
    });
  } finally {
    await harness.cleanup();
  }
});

test('codex recommendations fall back to claude defaults when claude is the selected provider', async () => {
  const harness = await createController({ claudeAuthenticated: true });
  try {
    await harness.controller.markProviderConnected('claude');

    assert.deepEqual(await harness.controller.chooseAgentRuntime({ model: 'gpt-5.5', effort: 'high' }), {
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    });
  } finally {
    await harness.cleanup();
  }
});

test('agent runtime chooses the recommendation for the selected provider', async () => {
  const harness = await createController({ claudeAuthenticated: true });
  try {
    await harness.controller.markProviderConnected('claude');

    assert.deepEqual(await harness.controller.chooseAgentRuntime({
      recommendations: {
        codex: { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
        claude: { model: 'sonnet', effort: 'medium' },
      },
    }), {
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
    });
  } finally {
    await harness.cleanup();
  }
});
