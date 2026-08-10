import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { LlmRunsStore } = require('../../dist-electron/main/llm-runs-store.js');

const baseRun = (overrides = {}) => ({
  id: 'run', runId: 'run', appId: 'app', status: 'running', progress: [], progressLog: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
});

test('LLM run receipts normalize missing contexts, fallbacks, unknown statuses, and window lifecycles', () => {
  const store = new LlmRunsStore({ getMainWindow: () => null });
  assert.equal(store.recordPersonalAgentConversationEvent({ conversation: { activeRun: undefined } }), null);
  assert.equal(store.recordAppAgentConversationEvent({ conversation: { activeRun: undefined } }), null);

  const personalConversation = { title: ' ', activeRun: baseRun({ progress: [{ message: ' last personal ' }] }) };
  store.recordPersonalAgentConversationEvent({ conversation: personalConversation, progress: { message: ' event personal ' } });
  store.recordPersonalAgentConversationEvent({
    conversation: personalConversation,
    run: baseRun({ id: 'personal-error', status: 'failed', error: ' failed ', activity: { summary: ' activity ', status: 'failed' } }),
  }, { agentName: ' ' });

  const appConversation = { appId: 'app', title: ' ', activeRun: baseRun({ runId: 'active-app', progressLog: [' active progress '] }) };
  store.recordAppAgentConversationEvent({ conversation: appConversation });
  store.recordAppAgentConversationEvent({
    conversation: { ...appConversation, activeRun: baseRun({ runId: 'no-progress', progressLog: [] }) },
  });
  store.recordAppAgentConversationEvent({
    conversation: appConversation,
    run: baseRun({ runId: 'event-app', status: 'applied', error: ' app failed ', activity: { summary: ' app activity ' } }),
    progress: ' event progress ',
  });

  store.recordAppPromptTaskEvent({ task: {
    runId: 'task', appId: 'app', templateId: ' ', status: 'undone', createdAt: 'a', updatedAt: 'b', progressLog: [], error: ' ',
  } });
  store.recordAppPromptTaskEvent({ task: {
    runId: 'task-activity', appId: 'app', templateId: 'template', status: 'failed', createdAt: 'a', updatedAt: 'c',
    activity: { summary: ' task activity ' }, error: ' task error ',
  } }, { appName: 'App name' });

  store.recordChatRunEvent({ run: baseRun({ runId: 'chat-app', appId: 'other', status: 'mystery', userMessage: 'hidden unless failed' }) });
  store.recordChatRunEvent({ run: baseRun({ runId: 'chat-failed', appId: 'forger', status: 'failed', userMessage: ' visible ', activity: { sourceRef: {} } }) });

  store.recordWorkflowNodeActivity({
    runId: 'workflow-empty', status: 'running', summary: '', startedAt: 'a', updatedAt: 'd', sourceRef: {},
  });
  store.recordWorkflowNodeActivity({
    runId: 'workflow-failed', status: 'failed', summary: ' failed summary ', startedAt: 'a', updatedAt: 'e',
    sourceRef: { appId: 'app', workflowName: 'Workflow', appName: 'Source app', title: 'Title' },
  });
  const snapshot = store.snapshot();
  assert.ok(snapshot.items.some((item) => item.status === 'running'));
  assert.ok(snapshot.items.some((item) => item.status === 'completed'));
  assert.ok(snapshot.errorCount >= 3);

  const destroyedWindow = { isDestroyed: () => true, webContents: { send: () => assert.fail('must not send') } };
  const destroyed = new LlmRunsStore({ getMainWindow: () => destroyedWindow });
  destroyed.recordChatRunEvent({ run: baseRun() });
  assert.match(destroyed.snapshot().updatedAt, /^\d{4}-/);

  const tied = new LlmRunsStore({ getMainWindow: () => null, now: () => new Date('2026-01-01') });
  tied.recordChatRunEvent({ run: baseRun({ status: 'running' }) });
  tied.recordChatRunEvent({ run: baseRun({ status: 'needs_permission' }) });
  assert.equal(tied.snapshot().items[0].status, 'needs_permission');
});
