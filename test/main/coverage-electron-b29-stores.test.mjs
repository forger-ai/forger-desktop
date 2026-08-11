import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const {
  PromptOverridesStore,
  agentBase,
  agentPromptBase,
  buildPromptBases,
} = await import('../../dist-electron/main/prompt-overrides.js');
const { RemoteActivityStore } = await import('../../dist-electron/main/remote-activity-store.js');

const createPromptStore = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-b29-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storePath = join(root, 'prompt-overrides.json');
  return { storePath, store: new PromptOverridesStore(storePath) };
};

const defaults = {
  model: 'gpt-default',
  reasoningEffort: 'medium',
  runtime: { provider: 'codex', model: 'gpt-default', effort: 'medium' },
};

test('prompt updates retain an existing runtime only when the next edit omits runtime fields', async (t) => {
  const { store } = await createPromptStore(t);
  const agent = { id: 'writer', title: 'Writer', initialPrompt: 'Write {{topic}}.' };
  const bases = buildPromptBases([], [agent], defaults);

  const first = await store.update('notes', bases, {
    appId: 'notes',
    kind: 'agent',
    id: 'writer',
    prompt: 'Write {{topic}} carefully.',
    runtime: { provider: 'claude', model: 'sonnet', effort: 'high' },
    model: 'legacy-model',
    reasoningEffort: 'xhigh',
  });
  assert.equal(first.runtime.provider, 'claude');

  const retained = await store.update('notes', bases, {
    appId: 'notes',
    kind: 'agent',
    id: 'writer',
    prompt: 'Write {{topic}} concisely.',
  });
  assert.deepEqual(retained.overrideRuntime, { provider: 'claude', model: 'sonnet', effort: 'high' });
  assert.equal(retained.overrideModel, 'legacy-model');
  assert.equal(retained.overrideReasoningEffort, 'xhigh');

  const restoredMissing = await store.restore('unknown', bases, {
    appId: 'unknown',
    kind: 'agent',
    id: 'writer',
  });
  assert.equal(restoredMissing.edited, false);

  const providerRuntime = await store.update('notes', bases, {
    appId: 'notes',
    kind: 'agent',
    id: 'writer',
    prompt: 'Write {{topic}} with Claude.',
    provider: 'claude',
    model: 'haiku',
    effort: 'low',
  });
  assert.deepEqual(providerRuntime.overrideRuntime, { provider: 'claude', model: 'haiku', effort: 'low' });

  const providerReasoningFallback = await store.update('notes', bases, {
    appId: 'notes',
    kind: 'agent',
    id: 'writer',
    prompt: 'Write {{topic}} with Codex.',
    provider: 'codex',
    model: 'gpt-provider',
    reasoningEffort: 'high',
  });
  assert.deepEqual(providerReasoningFallback.overrideRuntime, { provider: 'codex', model: 'gpt-provider', effort: 'high' });
});

test('invalid stored template and agent-prompt edits keep manifest text while preserving safe runtime fields', async (t) => {
  const { storePath, store } = await createPromptStore(t);
  const template = {
    id: 'summary',
    title: 'Summary',
    prompt: 'Summarize {{document}}.',
  };
  const agent = {
    id: 'reviewer',
    title: 'Reviewer',
    initialPrompt: 'Legacy',
    prompts: {
      initial: { body: 'Review {{document}}.' },
      resume: { body: 'Resume {{document}}.', runtime: { provider: 'claude', model: 'haiku', effort: 'low' } },
      steer: { body: 'Steer {{document}}.' },
    },
    runtime: { provider: 'claude', model: 'sonnet', effort: 'medium' },
  };
  await writeFile(storePath, JSON.stringify({
    version: 1,
    apps: {
      docs: {
        template: {
          kind: 'promptTemplate',
          id: 'summary',
          prompt: 'Broken template',
          updatedAt: '2026-08-10T00:00:00.000Z',
        },
        initial: {
          kind: 'agentPrompt',
          id: 'reviewer:initial',
          prompt: 'Broken agent prompt',
          updatedAt: '2026-08-10T00:00:00.000Z',
        },
      },
    },
  }));

  const [appliedTemplate] = await store.applyToPromptTemplates('docs', [template]);
  assert.equal(appliedTemplate.prompt, template.prompt);
  assert.equal(appliedTemplate.model, undefined);
  assert.equal(appliedTemplate.reasoningEffort, undefined);

  const [appliedAgent] = await store.applyToAgents('docs', [agent]);
  assert.equal(appliedAgent.prompts.initial.body, agent.prompts.initial.body);
  assert.equal(appliedAgent.prompts.initial.runtime, undefined);

  assert.deepEqual(agentPromptBase(agent, 'resume', defaults).runtime, agent.prompts.resume.runtime);
  assert.deepEqual(agentPromptBase(agent, 'steer', defaults).runtime, agent.runtime);
  assert.equal(agentBase({ id: 'plain', title: 'Plain', initialPrompt: 'Prompt' }, defaults).runtime, undefined);
});

test('prompt review defaults work for non-Codex manifests and malformed persisted entries', async (t) => {
  const { storePath, store } = await createPromptStore(t);
  const claudeAgent = {
    id: 'claude',
    title: 'Claude',
    initialPrompt: 'Help.',
    runtime: { provider: 'claude', model: 'sonnet', effort: 'medium' },
  };
  const globalAgent = { id: 'global', title: 'Global', initialPrompt: 'Help globally.' };
  const bases = buildPromptBases([], [claudeAgent, globalAgent, {
    id: 'resume-only',
    title: 'Resume only',
    initialPrompt: 'Legacy',
    prompts: { resume: { body: 'Resume.' } },
  }, {
    id: 'steer-only',
    title: 'Steer only',
    initialPrompt: 'Legacy',
    prompts: { steer: { body: 'Steer.' } },
  }], defaults);
  const items = await store.list('assistants', bases);
  assert.equal(items.find(({ id }) => id === 'claude').model, 'gpt-default');
  assert.equal(items.find(({ id }) => id === 'claude').reasoningEffort, 'medium');
  assert.equal(items.find(({ id }) => id === 'global').model, 'gpt-default');
  assert.equal(items.some(({ id }) => id === 'resume-only:resume'), true);
  assert.equal(items.some(({ id }) => id === 'steer-only:steer'), true);
  assert.deepEqual(await store.applyToAgents('missing', [globalAgent]), [globalAgent]);

  await writeFile(storePath, JSON.stringify({ apps: {
    '': { ignored: null },
    malformed: null,
    assistants: {
      numberId: { kind: 'agent', id: 7, prompt: 'Prompt' },
      numberPrompt: { kind: 'agent', id: 'global', prompt: 7 },
      blankModel: { kind: 'agent', id: 'global', prompt: 'Help globally.', model: ' ', updatedAt: 'now' },
    },
  } }));
  const [globalReview] = await store.list('assistants', [agentBase(globalAgent, defaults)]);
  assert.equal(globalReview.edited, true);
  assert.equal(globalReview.overrideModel, undefined);

  await writeFile(storePath, JSON.stringify({ apps: { assistants: {
    reasoningOnly: {
      kind: 'agent',
      id: 'global',
      prompt: 'Help globally.',
      reasoningEffort: 'high',
      updatedAt: 'now',
    },
  } } }));
  const [reasoningOnly] = await store.applyToAgents('assistants', [globalAgent]);
  assert.equal(reasoningOnly.runtime, undefined);
  assert.equal(reasoningOnly.model, undefined);
  assert.equal(reasoningOnly.reasoningEffort, 'high');

  await writeFile(storePath, JSON.stringify([]));
  assert.equal((await store.list('assistants', [agentBase(globalAgent, defaults)]))[0].edited, false);
  assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')), []);
});

test('remote activity preserves requester and redacted failures across transitions, then removes closed work', () => {
  const sent = [];
  const moments = [
    '2026-08-10T00:00:00.000Z',
    '2026-08-10T00:00:01.000Z',
    '2026-08-10T00:00:02.000Z',
    '2026-08-10T00:00:03.000Z',
    '2026-08-10T00:00:04.000Z',
    '2026-08-10T00:00:05.000Z',
    '2026-08-10T00:00:06.000Z',
    '2026-08-10T00:00:07.000Z',
    '2026-08-10T00:00:08.000Z',
    '2026-08-10T00:00:09.000Z',
    '2026-08-10T00:00:10.000Z',
    '2026-08-10T00:00:11.000Z',
  ];
  const store = new RemoteActivityStore({
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }),
    now: () => new Date(moments.shift()),
  });
  const requester = { id: 8, name: 'Phone', platform: 'ios' };
  const started = store.recordRequest({
    id: 'request-1',
    kind: 'app',
    targetId: 'finance',
    targetName: '  Finance   App  ',
    state: 'preparing',
    requesterMobileDevice: requester,
    lastError: `https://private.test/${'a'.repeat(40)}`,
  });
  assert.equal(started.preparingCount, 1);
  assert.equal(started.activities[0].targetName, 'Finance App');
  assert.equal(started.activities[0].lastError.includes('private.test'), false);

  const active = store.recordAppStatus({
    id: 'request-1',
    appId: 'finance',
    appName: '',
    status: { state: 'active', active: true },
  });
  assert.equal(active.activeCount, 1);
  assert.deepEqual(active.activities[0].requesterMobileDevice, requester);
  assert.equal(active.activities[0].startedAt, started.activities[0].startedAt);
  assert.equal(active.activities[0].lastErrorAt, started.activities[0].lastErrorAt);

  const errored = store.recordAgentStatus({
    id: 'agent-custom',
    agentId: 'assistant',
    agentName: 'Agent',
    status: { state: 'error', active: false, technicalCode: 'agent_failed' },
    requesterMobileDevice: requester,
    lastError: 'explicit failure',
  });
  assert.equal(errored.errorCount, 1);

  assert.equal(store.recordAppStatus({ appId: 'finance', appName: 'Finance', status: { state: 'inactive', active: true } }).activities.length, 2);
  assert.equal(store.recordAgentStatus({ agentId: 'assistant', agentName: 'Agent', status: { state: 'closed', active: true } }).activities.length, 2);
  assert.equal(store.clear('agent-custom').errorCount, 0);
  assert.equal(sent.length > 0, true);
});

test('remote activity safely resolves mobile requesters and does not emit into unavailable windows', () => {
  const destroyed = new RemoteActivityStore({
    getMainWindow: () => ({ isDestroyed: () => true, webContents: { send: () => assert.fail('destroyed window emitted') } }),
  });
  const devices = [
    { id: 1, kind: 'desktop', name: 'Desktop' },
    { id: 2, kind: 'mobile', name: '   ', platform: '' },
  ];
  assert.equal(destroyed.requesterFromDeviceId(undefined, devices), undefined);
  assert.equal(destroyed.requesterFromDeviceId(1, devices), undefined);
  assert.deepEqual(destroyed.requesterFromDeviceId(2, devices), { id: 2, name: 'Mobile device' });
  assert.equal(destroyed.recordAgentStatus({
    agentId: 'agent',
    agentName: 'Agent',
    status: { state: 'preparing', active: false },
    lastError: '   ',
  }).preparingCount, 1);

  const absent = new RemoteActivityStore({ getMainWindow: () => null });
  assert.equal(absent.recordAppStatus({
    appId: 'app',
    appName: 'App',
    status: { state: 'error', active: true, technicalCode: 'failed' },
  }).errorCount, 1);
  assert.equal(absent.recordAgentStatus({
    agentId: 'agent',
    agentName: 'Agent',
    status: { state: 'active', active: true },
  }).activeCount, 1);
});
