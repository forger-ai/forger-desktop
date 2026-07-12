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

const activity = (runId, surface, overrides = {}) => ({
  runId,
  surface,
  status: overrides.status ?? 'running',
  startedAt: overrides.startedAt ?? '2026-06-12T11:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-06-12T11:01:00.000Z',
  summary: overrides.summary ?? 'Used a tool.',
  items: overrides.items ?? [{
    id: `${runId}:item-1`,
    kind: 'mcp_call',
    summary: 'Used a tool.',
    createdAt: overrides.updatedAt ?? '2026-06-12T11:01:00.000Z',
  }],
  counts: overrides.counts ?? {
    total: 1,
    mcpCalls: 1,
    fileReads: 0,
    fileWrites: 0,
    commands: 0,
    connectedServices: 0,
    permissions: 0,
    notes: 0,
    errors: 0,
  },
  redactions: [],
  ...(overrides.sourceRef ? { sourceRef: overrides.sourceRef } : {}),
});

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

test('LLM runs store records desktop chat activity without double counting runs', () => {
  const { store } = createHarness();
  const runActivity = activity('chat-run-1', 'desktop_chat', {
    summary: 'Read a file.',
    sourceRef: { title: 'Forger chat' },
  });

  store.recordChatRunEvent({
    run: {
      runId: 'chat-run-1',
      appId: 'forger',
      prompt: 'hello',
      status: 'running',
      createdAt: '2026-06-12T11:00:00.000Z',
      updatedAt: '2026-06-12T11:01:00.000Z',
      progressLog: ['legacy progress'],
      activity: runActivity,
    },
  }, { appName: 'Forger' });
  store.recordChatRunEvent({
    run: {
      runId: 'chat-run-1',
      appId: 'forger',
      prompt: 'hello',
      status: 'preview_ready',
      createdAt: '2026-06-12T11:00:00.000Z',
      updatedAt: '2026-06-12T11:02:00.000Z',
      progressLog: ['legacy progress'],
      activity: { ...runActivity, status: 'completed', updatedAt: '2026-06-12T11:02:00.000Z' },
    },
  }, { appName: 'Forger' });

  const snapshot = store.snapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.activeCount, 0);
  assert.equal(snapshot.items[0].kind, 'desktop_chat');
  assert.equal(snapshot.items[0].status, 'completed');
  assert.equal(snapshot.items[0].progress, 'Read a file.');
  assert.equal(snapshot.items[0].activity.runId, 'chat-run-1');
});

test('LLM runs store ignores an older active event after a terminal event', () => {
  const { sends, store } = createHarness();
  const conversation = {
    id: 'conversation-monotonic',
    agentId: 'agent-1',
    title: 'Wake response',
    status: 'active',
    createdAt: '2026-06-12T11:00:00.000Z',
    updatedAt: '2026-06-12T11:02:00.000Z',
    messages: [],
  };

  store.recordPersonalAgentConversationEvent({
    type: 'run.completed',
    conversation,
    run: {
      id: 'run-monotonic',
      agentId: 'agent-1',
      conversationId: conversation.id,
      status: 'completed',
      progress: [],
      createdAt: '2026-06-12T11:00:00.000Z',
      updatedAt: '2026-06-12T11:02:00.000Z',
    },
  });
  const sendCountAfterCompletion = sends.length;

  const snapshot = store.recordPersonalAgentConversationEvent({
    type: 'run.started',
    conversation: { ...conversation, updatedAt: '2026-06-12T11:01:00.000Z' },
    run: {
      id: 'run-monotonic',
      agentId: 'agent-1',
      conversationId: conversation.id,
      status: 'running',
      progress: [],
      createdAt: '2026-06-12T11:00:00.000Z',
      updatedAt: '2026-06-12T11:01:00.000Z',
    },
  });

  assert.equal(snapshot.items[0].status, 'completed');
  assert.equal(snapshot.activeCount, 0);
  assert.equal(sends.length, sendCountAfterCompletion);
});

test('LLM runs store keeps a terminal state when timestamps tie', () => {
  const { store } = createHarness();
  const eventFor = (status) => ({
    run: {
      runId: 'chat-run-terminal-tie',
      appId: 'forger',
      prompt: 'hello',
      status,
      createdAt: '2026-06-12T11:00:00.000Z',
      updatedAt: '2026-06-12T11:02:00.000Z',
      progressLog: [],
    },
  });

  store.recordChatRunEvent(eventFor('preview_ready'));
  store.recordChatRunEvent(eventFor('running'));

  assert.equal(store.snapshot().items[0].status, 'completed');
  assert.equal(store.snapshot().activeCount, 0);
});

test('LLM runs store records workflow node activity', () => {
  const { store } = createHarness();
  const nodeActivity = activity('workflow-run-1:node-1', 'workflow_node', {
    status: 'completed',
    summary: 'Ran a command.',
    sourceRef: {
      workflowId: 'workflow-1',
      workflowName: 'Daily review',
      nodeId: 'node-1',
      nodeName: 'Summarize',
      appId: 'forger',
    },
  });

  const snapshot = store.recordWorkflowNodeActivity(nodeActivity, { appName: 'Forger' });

  assert.equal(snapshot.items.length, 1);
  assert.deepEqual(snapshot.items[0], {
    id: 'workflow-node:workflow-run-1:node-1',
    kind: 'workflow_node',
    sourceId: 'workflow-run-1:node-1',
    appId: 'forger',
    appName: 'Forger',
    title: 'Summarize',
    status: 'completed',
    progress: 'Ran a command.',
    activity: nodeActivity,
    startedAt: '2026-06-12T11:00:00.000Z',
    updatedAt: '2026-06-12T11:01:00.000Z',
  });
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
