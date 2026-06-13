import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LlmRunsStore } = require('../../dist-electron/main/llm-runs-store.js');

const createHarness = () => {
  const sends = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (...args) => sends.push(args),
    },
  };
  const store = new LlmRunsStore({
    getMainWindow: () => window,
    now: () => new Date('2026-06-12T12:00:00.000Z'),
  });
  return { sends, store };
};

test('LLM runs store records personal agent conversation activity', () => {
  const { sends, store } = createHarness();

  const snapshot = store.recordPersonalAgentConversationEvent({
    type: 'run.progress',
    conversation: {
      id: 'conversation-1',
      agentId: 'agent-1',
      title: 'Plan reports',
      status: 'active',
      createdAt: '2026-06-12T11:00:00.000Z',
      updatedAt: '2026-06-12T11:05:00.000Z',
      messages: [],
      activeRun: {
        id: 'run-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        status: 'running',
        progress: [{ id: 'progress-1', agentId: 'agent-1', conversationId: 'conversation-1', runId: 'run-1', message: 'Reading notes', createdAt: '2026-06-12T11:04:00.000Z' }],
        createdAt: '2026-06-12T11:01:00.000Z',
        updatedAt: '2026-06-12T11:05:00.000Z',
      },
    },
  }, { agentName: 'Ops agent' });

  assert.equal(snapshot.activeCount, 1);
  assert.deepEqual(snapshot.items[0], {
    id: 'personal-agent:run-1',
    kind: 'personal_agent_conversation',
    sourceId: 'run-1',
    appName: 'Ops agent',
    title: 'Plan reports',
    status: 'running',
    progress: 'Reading notes',
    startedAt: '2026-06-12T11:01:00.000Z',
    updatedAt: '2026-06-12T11:05:00.000Z',
  });
  assert.equal(sends.at(-1)[0], 'forger:llm-runs:snapshot:changed');
});

test('LLM runs store records app agent threads and app prompt tasks', () => {
  const { store } = createHarness();

  store.recordAppAgentConversationEvent({
    type: 'run.started',
    conversation: {
      conversationId: 'thread-1',
      appId: 'finance-os',
      title: 'Review cashflow',
      createdAt: '2026-06-12T10:00:00.000Z',
      updatedAt: '2026-06-12T10:01:00.000Z',
      messages: [],
    },
    run: {
      runId: 'run-2',
      status: 'needs_permission',
      createdAt: '2026-06-12T10:00:00.000Z',
      updatedAt: '2026-06-12T10:01:00.000Z',
      progressLog: ['Waiting for approval'],
    },
  }, { appName: 'Finance OS' });
  store.recordAppPromptTaskEvent({
    task: {
      runId: 'task-1',
      appId: 'focus',
      templateId: 'gmail_import',
      status: 'completed',
      createdAt: '2026-06-12T09:00:00.000Z',
      updatedAt: '2026-06-12T09:03:00.000Z',
      progressLog: ['Imported 12 emails'],
    },
  }, { appName: 'Focus' });

  const snapshot = store.snapshot();
  assert.equal(snapshot.activeCount, 1);
  assert.equal(snapshot.errorCount, 0);
  assert.deepEqual(snapshot.items.map((item) => [item.kind, item.appName, item.status, item.progress]), [
    ['app_agent_thread', 'Finance OS', 'needs_permission', 'Waiting for approval'],
    ['app_prompt_task', 'Focus', 'completed', 'Imported 12 emails'],
  ]);
});
