import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PromptOverridesStore,
  buildPromptBases,
} = require('../../dist-electron/main/prompt-overrides.js');

const createStore = async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-prompt-overrides-'));
  return {
    root,
    store: new PromptOverridesStore(join(root, 'prompt-overrides.json')),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};

const promptAgent = {
  id: 'advisor',
  title: 'Advisor',
  initialPrompt: 'Legacy prompt',
  prompts: {
    initial: {
      body: 'Review {{item}}.',
      variables: {
        item: { type: 'text', required: true },
      },
    },
  },
};

test('agentPrompt overrides can carry Claude runtime overrides', async () => {
  const harness = await createStore();
  try {
    const legacyCodexAgent = { ...promptAgent, model: 'gpt-5.4', reasoningEffort: 'medium' };
    const bases = buildPromptBases([], [legacyCodexAgent], {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
    });

    const updated = await harness.store.update('finance-os', bases, {
      appId: 'finance-os',
      kind: 'agentPrompt',
      id: 'advisor:initial',
      prompt: 'Carefully review {{item}}.',
      runtime: { provider: 'claude', model: 'sonnet', effort: 'high' },
    });

    assert.equal(updated.kind, 'agentPrompt');
    assert.deepEqual(updated.runtime, { provider: 'claude', model: 'sonnet', effort: 'high' });
    assert.equal(updated.runtimeSource, 'override');
    assert.deepEqual(updated.overrideRuntime, { provider: 'claude', model: 'sonnet', effort: 'high' });

    const [agent] = await harness.store.applyToAgents('finance-os', [legacyCodexAgent]);
    assert.equal(agent.prompts.initial.body, 'Carefully review {{item}}.');
    assert.deepEqual(agent.runtime, { provider: 'claude', model: 'sonnet', effort: 'high' });
    assert.equal(agent.model, undefined);
    assert.equal(agent.reasoningEffort, undefined);
  } finally {
    await harness.cleanup();
  }
});

test('legacy model and reasoningEffort inputs still create Codex runtime overrides', async () => {
  const harness = await createStore();
  try {
    const bases = buildPromptBases([], [promptAgent], {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
    });

    await harness.store.update('finance-os', bases, {
      appId: 'finance-os',
      kind: 'agentPrompt',
      id: 'advisor:initial',
      prompt: 'Review {{item}} in detail.',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    });

    const [agent] = await harness.store.applyToAgents('finance-os', [promptAgent]);
    assert.equal(agent.prompts.initial.body, 'Review {{item}} in detail.');
    assert.equal(agent.model, 'gpt-5.5');
    assert.equal(agent.reasoningEffort, 'high');
    assert.deepEqual(agent.runtime, { provider: 'codex', model: 'gpt-5.5', effort: 'high' });
  } finally {
    await harness.cleanup();
  }
});
