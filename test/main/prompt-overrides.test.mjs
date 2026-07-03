import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PromptOverridesStore,
  agentPromptBase,
  buildPromptBases,
  promptOverrideErrorResult,
  validatePromptEdit,
} = require('../../dist-electron/main/prompt-overrides.js');

const createStore = async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-prompt-overrides-'));
  const storePath = join(root, 'prompt-overrides.json');
  return {
    root,
    storePath,
    store: new PromptOverridesStore(storePath),
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

test('promptTemplate overrides validate variables, apply runtime fields, and restore cleanly', async () => {
  const harness = await createStore();
  try {
    const template = {
      id: 'monthly-review',
      title: 'Monthly Review',
      description: 'Reviews a month',
      prompt: 'Review {{month}} for {{account}}.',
      arguments: [{ name: 'month' }, { name: 'account' }],
      runtime: { provider: 'codex', model: 'gpt-5.4', effort: 'medium' },
    };
    const bases = buildPromptBases([template], [], {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
    });

    const invalid = await harness.store.validate('finance-os', bases, {
      appId: 'finance-os',
      kind: 'promptTemplate',
      id: 'monthly-review',
      prompt: 'Review {{month}} for {{newAccount}}.',
    });
    assert.equal(invalid.valid, false);
    assert.deepEqual(invalid.missingVariables, ['account']);
    assert.deepEqual(invalid.extraVariables, ['newAccount']);
    assert.match(invalid.errors.join('\n'), /Faltan argumentos usados por la app: account/);

    await assert.rejects(
      () => harness.store.update('other-app', bases, {
        appId: 'finance-os',
        kind: 'promptTemplate',
        id: 'monthly-review',
        prompt: 'Review {{month}} for {{account}}.',
      }),
      /app_prompt_scope_mismatch/,
    );
    await assert.rejects(
      () => harness.store.update('finance-os', bases, {
        appId: 'finance-os',
        kind: 'promptTemplate',
        id: 'missing',
        prompt: 'Review {{month}} for {{account}}.',
      }),
      /app_prompt_not_found/,
    );

    const updated = await harness.store.update('finance-os', bases, {
      appId: 'finance-os',
      kind: 'promptTemplate',
      id: 'monthly-review',
      prompt: 'Review {{month}} for {{account}} carefully.\r\nReturn a summary.',
      runtime: { provider: 'claude', model: 'sonnet', effort: 'medium' },
      model: ' ignored legacy model ',
      reasoningEffort: 'high',
    });

    assert.equal(updated.prompt, 'Review {{month}} for {{account}} carefully.\nReturn a summary.');
    assert.equal(updated.modelSource, 'override');
    assert.equal(updated.reasoningEffortSource, 'override');
    assert.deepEqual(updated.runtime, { provider: 'claude', model: 'sonnet', effort: 'medium' });
    assert.equal(updated.model, 'ignored legacy model');
    assert.equal(updated.reasoningEffort, 'high');

    const [applied] = await harness.store.applyToPromptTemplates('finance-os', [template]);
    assert.equal(applied.prompt, 'Review {{month}} for {{account}} carefully.\nReturn a summary.');
    assert.deepEqual(applied.runtime, { provider: 'claude', model: 'sonnet', effort: 'medium' });
    assert.equal(applied.model, undefined);
    assert.equal(applied.reasoningEffort, undefined);

    const restored = await harness.store.restore('finance-os', bases, {
      appId: 'finance-os',
      kind: 'promptTemplate',
      id: 'monthly-review',
    });
    assert.equal(restored.edited, false);
    assert.equal(restored.prompt, template.prompt);
    assert.deepEqual(await harness.store.applyToPromptTemplates('finance-os', [template]), [template]);
  } finally {
    await harness.cleanup();
  }
});

test('prompt overrides preserve stale invalid overrides for review without applying broken prompt text', async () => {
  const harness = await createStore();
  try {
    const agent = {
      id: 'legacy',
      title: 'Legacy',
      description: 'Legacy prompt agent',
      initialPrompt: 'Use {{topic}}.',
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
    };
    const bases = buildPromptBases([], [agent], {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
    });

    await writeFile(
      harness.storePath,
      JSON.stringify({
        version: 1,
        apps: {
          'finance-os': {
            stale: {
              kind: 'agent',
              id: 'legacy',
              prompt: 'Use stale instructions without the required variable.',
              runtime: { provider: 'claude', model: 'sonnet', effort: 'low' },
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      }),
      'utf8',
    );

    const [item] = await harness.store.list('finance-os', bases);
    assert.equal(item.edited, true);
    assert.equal(item.overrideInvalid, true);
    assert.equal(item.prompt, agent.initialPrompt);
    assert.equal(item.overridePrompt, 'Use stale instructions without the required variable.');
    assert.equal(item.runtimeSource, 'override');

    const [applied] = await harness.store.applyToAgents('finance-os', [agent]);
    assert.equal(applied.initialPrompt, agent.initialPrompt);
    assert.deepEqual(applied.runtime, { provider: 'claude', model: 'sonnet', effort: 'low' });
    assert.equal(applied.model, undefined);
    assert.equal(applied.reasoningEffort, undefined);
  } finally {
    await harness.cleanup();
  }
});

test('prompt override store normalizes legacy files and drops unusable entries', async () => {
  const harness = await createStore();
  try {
    const agent = {
      id: 'advisor',
      title: 'Advisor',
      initialPrompt: 'Review {{item}}.',
    };
    const bases = buildPromptBases([], [agent], {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
    });

    await writeFile(
      harness.storePath,
      JSON.stringify({
        version: 99,
        apps: {
          '': { ignored: { kind: 'agent', id: 'empty-app', prompt: 'ignored' } },
          'finance-os': {
            nullEntry: null,
            badKind: { kind: 'other', id: 'advisor', prompt: 'ignored' },
            emptyPrompt: { kind: 'agent', id: 'advisor', prompt: '' },
            valid: {
              kind: 'agent',
              id: 'advisor',
              prompt: 'Review {{item}} with care.\rReturn notes.',
              model: ' gpt-5.5 ',
              reasoningEffort: 'xhigh',
              updatedAt: '',
            },
          },
        },
      }),
      'utf8',
    );

    const [item] = await harness.store.list('finance-os', bases);
    assert.equal(item.overridePrompt, 'Review {{item}} with care.\nReturn notes.');
    assert.equal(item.overrideModel, 'gpt-5.5');
    assert.equal(item.overrideReasoningEffort, 'xhigh');
    assert.equal(item.modelSource, 'override');
    assert.equal(item.reasoningEffortSource, 'override');

    await harness.store.restore('finance-os', bases, {
      appId: 'finance-os',
      kind: 'agent',
      id: 'advisor',
    });
    const saved = JSON.parse(await readFile(harness.storePath, 'utf8'));
    assert.deepEqual(saved, { version: 1, apps: {} });
  } finally {
    await harness.cleanup();
  }
});

test('prompt overrides cover null runtime resets, partial restores, and legacy agent fields', async () => {
  const harness = await createStore();
  try {
    const legacyAgent = {
      id: 'legacy',
      title: 'Legacy',
      initialPrompt: 'Use {{topic}}.',
      model: 'gpt-original',
      reasoningEffort: 'low',
    };
    const template = {
      id: 'brief',
      title: 'Brief',
      prompt: 'Brief {{topic}}.',
      model: 'gpt-template',
      reasoningEffort: 'medium',
    };
    const bases = buildPromptBases([template], [legacyAgent], {
      model: 'gpt-default',
      reasoningEffort: 'medium',
    });

    await harness.store.update('finance-os', bases, {
      appId: 'finance-os',
      kind: 'agent',
      id: 'legacy',
      prompt: 'Use {{topic}} with legacy settings.',
      runtime: null,
      model: 'ignored',
      reasoningEffort: 'high',
    });
    await harness.store.update('finance-os', bases, {
      appId: 'finance-os',
      kind: 'promptTemplate',
      id: 'brief',
      prompt: 'Brief {{topic}} carefully.',
      model: 'gpt-brief',
      reasoningEffort: 'xhigh',
    });

    const [appliedAgent] = await harness.store.applyToAgents('finance-os', [legacyAgent]);
    assert.equal(appliedAgent.initialPrompt, 'Use {{topic}} with legacy settings.');
    assert.equal(appliedAgent.model, 'gpt-original');
    assert.equal(appliedAgent.reasoningEffort, 'low');
    assert.equal(appliedAgent.runtime, undefined);

    const restoredAgent = await harness.store.restore('finance-os', bases, {
      appId: 'finance-os',
      kind: 'agent',
      id: 'legacy',
    });
    assert.equal(restoredAgent.edited, false);
    const saved = JSON.parse(await readFile(harness.storePath, 'utf8'));
    assert.ok(saved.apps['finance-os']['promptTemplate:brief']);
    assert.equal(saved.apps['finance-os']['agent:legacy'], undefined);

    const invalidResult = await harness.store.update('finance-os', bases, {
      appId: 'finance-os',
      kind: 'promptTemplate',
      id: 'brief',
      prompt: 'No topic variable.',
    }).then(
      () => {
        throw new Error('expected invalid prompt');
      },
      (error) => promptOverrideErrorResult(error),
    );
    assert.deepEqual(invalidResult, {
      success: false,
      userMessage: 'Faltan variables del prompt original: topic.',
      technicalCode: 'app_prompt_invalid',
    });
  } finally {
    await harness.cleanup();
  }
});

test('prompt overrides preserve multi-prompt agents and drop malformed persisted app buckets', async () => {
  const harness = await createStore();
  try {
    const multiAgent = {
      id: 'advisor',
      title: 'Advisor',
      description: 'Uses multiple prompt stages',
      model: 'gpt-agent',
      reasoningEffort: 'medium',
      prompts: {
        initial: { body: 'Start with {{topic}}.', variables: { topic: { type: 'text' } } },
        resume: { body: 'Resume {{topic}}.', variables: { topic: { type: 'text' } } },
        steer: { body: 'Steer {{topic}}.', variables: { topic: { type: 'text' } } },
      },
    };
    const legacyAgent = {
      id: 'legacy',
      title: 'Legacy',
      initialPrompt: 'Use {{topic}}.',
    };
    const bases = buildPromptBases([], [multiAgent, legacyAgent], {
      model: 'gpt-default',
      reasoningEffort: 'medium',
    });

    await writeFile(
      harness.storePath,
      JSON.stringify({
        version: 1,
        apps: {
          'finance-os': null,
          recipes: {
            badEntry: 42,
          },
        },
      }),
      'utf8',
    );
    assert.equal((await harness.store.list('finance-os', bases)).some((item) => item.edited), false);

    await harness.store.update('finance-os', bases, {
      appId: 'finance-os',
      kind: 'agentPrompt',
      id: 'advisor:resume',
      prompt: 'Resume {{topic}} with user-visible context.',
      runtime: { provider: 'claude', model: 'sonnet', effort: 'high' },
    });
    await harness.store.update('finance-os', bases, {
      appId: 'finance-os',
      kind: 'agent',
      id: 'legacy',
      prompt: 'Use {{topic}} with a legacy override.',
      model: 'gpt-legacy',
      reasoningEffort: 'high',
    });

    const [appliedMulti, appliedLegacy] = await harness.store.applyToAgents('finance-os', [multiAgent, legacyAgent]);
    assert.equal(appliedMulti.prompts.initial.body, 'Start with {{topic}}.');
    assert.equal(appliedMulti.prompts.resume.body, 'Resume {{topic}} with user-visible context.');
    assert.equal(appliedMulti.prompts.steer.body, 'Steer {{topic}}.');
    assert.deepEqual(appliedMulti.runtime, { provider: 'claude', model: 'sonnet', effort: 'high' });
    assert.equal(appliedLegacy.initialPrompt, 'Use {{topic}} with a legacy override.');
    assert.deepEqual(appliedLegacy.runtime, { provider: 'codex', model: 'gpt-legacy', effort: 'high' });

    assert.throws(
      () => agentPromptBase({ id: 'advisor', title: 'Advisor', prompts: {} }, 'resume', {
        model: 'gpt-default',
        reasoningEffort: 'medium',
      }),
      /app_prompt_not_found/,
    );

    const noOverrideAgent = {
      id: 'plain',
      title: 'Plain',
      initialPrompt: 'Keep {{topic}}.',
    };
    assert.deepEqual(await harness.store.applyToAgents('finance-os', [noOverrideAgent]), [noOverrideAgent]);

    const fallbackRuntimeBase = buildPromptBases([{
      id: 'fallback',
      title: 'Fallback',
      prompt: 'Use {{topic}}.',
    }], [], {
      model: '',
      reasoningEffort: 'bad',
    })[0];
    const fallbackItem = await harness.store.list('empty-defaults', [fallbackRuntimeBase]);
    assert.deepEqual(fallbackItem[0].runtime, { provider: 'codex', model: '', effort: 'medium' });
  } finally {
    await harness.cleanup();
  }
});

test('prompt override update reports verification failures after storage races', async () => {
  const harness = await createStore();
  try {
    const agent = {
      id: 'advisor',
      title: 'Advisor',
      initialPrompt: 'Review {{item}}.',
    };
    const bases = buildPromptBases([], [agent], {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
    });
    let reads = 0;
    const originalReadStore = harness.store.readStore.bind(harness.store);
    harness.store.readStore = async () => {
      reads += 1;
      if (reads === 2) {
        return { version: 1, apps: {} };
      }
      return await originalReadStore();
    };

    await assert.rejects(
      () => harness.store.update('finance-os', bases, {
        appId: 'finance-os',
        kind: 'agent',
        id: 'advisor',
        prompt: 'Review {{item}} carefully.',
      }),
      /app_prompt_store_failed/,
    );
  } finally {
    await harness.cleanup();
  }
});

test('prompt validation covers empty, oversized, undeclared, and helper error paths', async () => {
  const base = buildPromptBases([], [promptAgent], {
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
  })[0];

  const empty = validatePromptEdit(base, '   ');
  assert.equal(empty.valid, false);
  assert.match(empty.errors.join('\n'), /no puede estar vacio/);

  const oversized = validatePromptEdit(base, `${'x'.repeat(50_001)} {{item}}`);
  assert.equal(oversized.valid, false);
  assert.match(oversized.errors.join('\n'), /50,000/);

  const undeclared = validatePromptEdit(base, 'Review {{item}} and {{missing}}.');
  assert.equal(undeclared.valid, false);
  assert.deepEqual(undeclared.extraVariables, ['missing']);
  assert.match(undeclared.errors.join('\n'), /variables no declaradas por el manifest: missing/);

  assert.deepEqual(promptOverrideErrorResult(new Error('disk failed')), {
    success: false,
    userMessage: 'No se pudo actualizar el prompt.',
    technicalCode: 'disk failed',
  });
  assert.deepEqual(promptOverrideErrorResult('unknown'), {
    success: false,
    userMessage: 'No se pudo actualizar el prompt.',
    technicalCode: 'app_prompt_error',
  });
});
