import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../../dist-electron/shared/agent-runtime-registry.js');

test('agent runtime registry exposes complete provider labels and connection choices', () => {
  assert.equal(registry.providerOptionLabel('antigravity'), 'Google');
  assert.equal(registry.providerOptionLabel('future-provider'), 'future-provider');
  assert.deepEqual(registry.buildChatProviderOptions(), []);
  assert.deepEqual(registry.buildChatProviderOptions({ lockedProvider: 'claude' }).map(({ value }) => value), ['claude']);
  assert.deepEqual(registry.buildChatProviderOptions({ codexAuthenticated: true, lockedProvider: 'codex' }).map(({ value }) => value), ['auto', 'codex']);
  assert.deepEqual(registry.buildChatProviderOptions({ antigravityAuthenticated: true, claudeAuthenticated: true }).map(({ value }) => value), ['auto', 'claude', 'antigravity']);
  assert.deepEqual(registry.buildChatProviderOptions({ lockedProvider: 'unknown' }), []);
});

test('agent runtime registry resolves model metadata, aliases, and effort constraints for every provider', () => {
  assert.equal(registry.getAgentModelOptions('antigravity'), registry.ANTIGRAVITY_MODEL_OPTIONS);
  assert.equal(registry.getCodexModelOption(' gpt-5.4 ')?.realModelName, 'gpt-5.4');
  assert.equal(registry.getCodexModelOption(null), undefined);
  assert.equal(registry.getClaudeModelOption('sonnet')?.realModelName, 'sonnet');
  assert.equal(registry.getClaudeModelOption('missing'), undefined);
  assert.equal(registry.getAntigravityModelOption('gemini-3.1-pro')?.defaultEffort, 'high');
  assert.equal(registry.getAntigravityModelOption('missing'), undefined);
  assert.deepEqual(registry.getAntigravityLegacyModelAlias('gemini-3.1-pro-low'), { model: 'gemini-3.1-pro', effort: 'low' });
  assert.equal(registry.getAntigravityLegacyModelAlias(' '), undefined);
  assert.equal(registry.getDefaultAntigravityEffort('gemini-3.1-pro-low'), 'low');
  assert.equal(registry.getDefaultAntigravityEffort('missing'), registry.DEFAULT_ANTIGRAVITY_EFFORT);
  assert.deepEqual(registry.getRuntimeSupportedEfforts('antigravity', 'gemini-3.1-pro'), ['low', 'high']);
  assert.deepEqual(registry.getRuntimeSupportedEfforts('antigravity', 'missing'), ['low', 'medium', 'high']);
  assert.ok(registry.getRuntimeSupportedEfforts('claude', 'missing').includes('max'));
  assert.ok(registry.getRuntimeSupportedEfforts('codex', 'missing').includes('none'));

  assert.equal(registry.normalizeRuntimeEffortForModel('antigravity', 'gemini-3.1-pro', 'low'), 'low');
  assert.equal(registry.normalizeRuntimeEffortForModel('antigravity', 'gemini-3.1-pro', 'medium'), 'high');
  assert.equal(registry.normalizeRuntimeEffortForModel('codex', 'gpt-5.3-codex', 'ultra', 'medium'), 'low');
  assert.equal(registry.normalizeRuntimeEffortForModel('claude', 'missing', 'invalid', 'max'), 'max');
});

test('agent runtime registry normalizes Antigravity aliases and provider-specific fallbacks', () => {
  assert.deepEqual(registry.normalizeAntigravityModelAndEffort('gemini-3.1-pro-low'), { model: 'gemini-3.1-pro', effort: 'low' });
  assert.deepEqual(registry.normalizeAntigravityModelAndEffort('missing', 'invalid', 'gemini-3.1-pro', 'low'), { model: 'gemini-3.1-pro', effort: 'high' });
  assert.equal(registry.resolveAntigravityCliModel('gemini-3.1-pro', 'low'), 'gemini-3.1-pro-low');
  assert.equal(registry.resolveAntigravityCliModel('custom-model', 'high'), 'gemini-3.5-flash-high');
  assert.equal(registry.normalizeAntigravityModel('gemini-3.1-pro-low'), 'gemini-3.1-pro');
  assert.equal(registry.normalizeAntigravityModel('missing', 'fallback'), 'fallback');

  const custom = registry.createAgentProviderRuntimeRegistry({
    codex: { defaultModel: 'codex-default', defaultReasoningEffort: 'medium', modelValues: ['codex-default'], reasoningEffortValues: ['low', 'medium'] },
    claude: { defaultModel: 'claude-default', defaultEffort: 'high', modelValues: ['claude-default'], effortValues: ['low', 'high'] },
    antigravity: { defaultModel: 'google-default', defaultEffort: 'medium', modelValues: ['google-default'], effortValues: ['low', 'medium'] },
  });
  assert.equal(registry.normalizeAgentProviderModel(custom, 'codex', 'codex-default'), 'codex-default');
  assert.equal(registry.normalizeAgentProviderModel(custom, 'claude', 'missing', 'fallback'), 'fallback');
  assert.equal(registry.normalizeAgentProviderModel(custom, 'antigravity', ''), 'google-default');
  assert.equal(registry.normalizeAgentProviderEffort(custom, 'claude', 'low', 'invalid'), 'low');
  assert.equal(registry.normalizeAgentProviderEffort(custom, 'claude', 'invalid', 'low'), 'low');
  assert.equal(registry.normalizeAgentProviderEffort(custom, 'antigravity', 'low', 'invalid'), 'low');
  assert.equal(registry.normalizeAgentProviderEffort(custom, 'antigravity', 'invalid', 'medium'), 'medium');
  assert.equal(registry.normalizeAgentProviderEffort(custom, 'codex', 'low', 'invalid'), 'low');
  assert.equal(registry.normalizeAgentProviderEffort(custom, 'codex', 'invalid', 'medium'), 'medium');
  assert.equal(registry.normalizeRuntimeEffort('claude', 'invalid', 'low'), 'low');
  assert.equal(registry.normalizeRuntimeEffort('antigravity', 'invalid', 'high'), 'high');
  assert.equal(registry.normalizeRuntimeEffort('antigravity', 'invalid', undefined), registry.DEFAULT_ANTIGRAVITY_EFFORT);
  assert.equal(registry.normalizeRuntimeEffort('codex', 'invalid', 'xhigh'), 'xhigh');
});

test('agent runtime request validation separates model support from effort support', () => {
  const current = registry.DEFAULT_AGENT_PROVIDER_RUNTIME_REGISTRY;
  assert.doesNotThrow(() => registry.validateAgentRuntimeRequest(current, 'codex'));
  assert.doesNotThrow(() => registry.validateAgentRuntimeRequest(current, 'claude', { model: 'claude-sonnet-5' }));
  assert.throws(
    () => registry.validateAgentRuntimeRequest(current, 'codex', { model: 'missing' }),
    (error) => error.code === 'agent_runtime_model_unsupported',
  );
  assert.throws(
    () => registry.validateAgentRuntimeRequest(current, 'antigravity', { model: 'gemini-3.1-pro', effort: 'medium' }),
    (error) => error.code === 'agent_runtime_effort_unsupported',
  );
  assert.throws(
    () => registry.validateAgentRuntimeRequest(current, 'claude', { effort: 'invalid' }),
    (error) => error.code === 'agent_runtime_effort_unsupported',
  );
  assert.doesNotThrow(() => registry.validateAgentRuntimeRequest(current, 'antigravity', { effort: 'high' }));
});

test('agent runtime normalization retains permission and auth profile across all providers', () => {
  const antigravity = registry.normalizeAgentRuntime({
    authProfileId: ' google-profile ', effort: 'low', model: 'gemini-3.1-pro', permissionMode: 'unsafe', provider: 'antigravity',
  });
  assert.deepEqual(antigravity, {
    authProfileId: 'google-profile', effort: 'low', model: 'gemini-3.1-pro', permissionMode: 'unsafe', provider: 'antigravity',
  });
  assert.deepEqual(registry.normalizeAgentRuntime({ model: 'gemini-3.5-flash', provider: 'antigravity' }), {
    effort: 'medium', model: 'gemini-3.5-flash', provider: 'antigravity',
  });
  assert.deepEqual(registry.normalizeAgentRuntime(
    { model: 'gemini-3.1-pro', provider: 'antigravity' },
    { effort: 'low', model: 'gemini-3.5-flash', provider: 'antigravity' },
  ), { effort: 'low', model: 'gemini-3.1-pro', provider: 'antigravity' });
  assert.deepEqual(registry.normalizeAgentRuntime(
    { model: 'gemini-3.1-pro', provider: 'antigravity' },
    { model: 'gemini-3.5-flash', provider: 'antigravity', reasoningEffort: 'low' },
  ), { effort: 'low', model: 'gemini-3.1-pro', provider: 'antigravity' });
  assert.deepEqual(registry.normalizeAgentRuntime({ model: 'claude-sonnet-5', provider: 'claude' }), {
    effort: 'high', model: 'claude-sonnet-5', provider: 'claude',
  });
  assert.deepEqual(registry.normalizeAgentRuntime({ model: 'claude-sonnet-5', permissionMode: 'unsafe', authProfileId: 'c', provider: 'claude' }), {
    authProfileId: 'c', effort: 'high', model: 'claude-sonnet-5', permissionMode: 'unsafe', provider: 'claude',
  });
  assert.deepEqual(registry.normalizeAgentRuntime({ model: 'gpt-5.4', provider: 'codex' }), {
    effort: 'medium', model: 'gpt-5.4', provider: 'codex',
  });
  assert.deepEqual(registry.normalizeAgentRuntime({ model: 'gpt-5.4', permissionMode: 'unsafe', authProfileId: 'x', provider: 'codex' }), {
    authProfileId: 'x', effort: 'medium', model: 'gpt-5.4', permissionMode: 'unsafe', provider: 'codex',
  });
  assert.deepEqual(registry.resolveAgentRuntime(antigravity), antigravity);
  assert.equal(Object.hasOwn(registry.resolveAgentRuntime({ model: 'gemini-3.5-flash', provider: 'antigravity' }), 'authProfileId'), false);
  assert.equal(Object.hasOwn(registry.resolveAgentRuntime({ model: 'claude-sonnet-5', provider: 'claude' }), 'authProfileId'), false);
  assert.equal(Object.hasOwn(registry.resolveAgentRuntime({ model: 'gpt-5.4', provider: 'codex' }), 'authProfileId'), false);
  assert.equal(registry.resolveAgentRuntime({ authProfileId: 'a', model: 'claude-sonnet-5', provider: 'claude' }).authProfileId, 'a');
  assert.equal(registry.resolveAgentRuntime({ authProfileId: 'a', model: 'gpt-5.4', provider: 'codex' }).authProfileId, 'a');
  assert.deepEqual(registry.resolveAgentRuntime(undefined), {
    effort: registry.DEFAULT_CODEX_REASONING_EFFORT, model: registry.DEFAULT_CODEX_MODEL, provider: 'codex',
  });
  assert.equal(registry.legacyCodexRuntime(), undefined);
  assert.equal(registry.normalizeAgentRuntime([], {}), undefined);
  assert.equal(registry.normalizeAgentRuntime(null, { model: 'gpt-5.4', reasoningEffort: 'high' })?.provider, 'codex');
});

test('agent runtime defaults choose connection order and construct every provider runtime', () => {
  assert.equal(registry.chooseDefaultAgentProvider(), 'codex');
  assert.equal(registry.chooseDefaultAgentProvider({ defaultProvider: 'claude' }), 'claude');
  assert.equal(registry.chooseDefaultAgentProvider({ antigravityAuthenticated: true }), 'antigravity');
  assert.equal(registry.chooseDefaultAgentProvider({ claudeAuthenticated: true, codexAuthenticated: true, defaultProvider: 'claude' }), 'claude');
  assert.equal(registry.chooseDefaultAgentProvider({
    antigravityAuthenticated: true,
    claudeAuthenticated: true,
    codexAuthenticated: true,
    providerConnections: {
      antigravity: '2026-01-03T00:00:00.000Z', claude: '2026-01-01T00:00:00.000Z', codex: '2026-01-02T00:00:00.000Z',
    },
  }), 'claude');
  assert.equal(registry.chooseDefaultAgentProvider({ claudeAuthenticated: true, codexAuthenticated: true }), 'codex');

  assert.equal(registry.runtimeFromDefaultsForProvider('claude').provider, 'claude');
  assert.deepEqual(registry.runtimeFromDefaultsForProvider('antigravity'), {
    effort: registry.DEFAULT_ANTIGRAVITY_EFFORT, model: registry.DEFAULT_ANTIGRAVITY_MODEL, provider: 'antigravity',
  });
  assert.equal(registry.runtimeFromDefaultsForProvider('codex').provider, 'codex');
  assert.equal(registry.runtimeFromUserDefaults({ antigravityAuthenticated: true }).provider, 'antigravity');
  assert.equal(registry.runtimeFromUserDefaults().provider, 'codex');
});

test('agent runtime equality and source selection compare every security-relevant field', () => {
  const base = { effort: 'medium', model: 'gpt-5.4', provider: 'codex' };
  assert.equal(registry.agentRuntimeEquals(null, base), false);
  assert.equal(registry.agentRuntimeEquals(base, null), false);
  assert.equal(registry.agentRuntimeEquals(base, { ...base, provider: 'claude' }), false);
  assert.equal(registry.agentRuntimeEquals(base, { ...base, model: 'other' }), false);
  assert.equal(registry.agentRuntimeEquals(base, { ...base, effort: 'high' }), false);
  assert.equal(registry.agentRuntimeEquals(base, { ...base, permissionMode: 'unsafe' }), false);
  assert.equal(registry.agentRuntimeEquals({ ...base, authProfileId: 'a' }, { ...base, authProfileId: 'b' }), false);
  assert.equal(registry.agentRuntimeEquals(base, { ...base, permissionMode: 'safe' }), true);
  assert.equal(registry.resolveRuntimeSource(null, base), 'override');
  assert.equal(registry.resolveRuntimeSource(base, null), 'manifest');
  assert.equal(registry.resolveRuntimeSource(null, null), 'global');
});
