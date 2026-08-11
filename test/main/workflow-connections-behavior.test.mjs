import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  sanitizeWorkflowNode,
} = require('../../dist-electron/main/workflow/sanitize.js');
const {
  WorkflowManager,
} = require('../../dist-electron/main/workflow-manager.js');

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await wait(25);
  }
  throw new Error('waitFor_timeout');
};

const createManager = async (overrides = {}) => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-workflow-connections-'));
  const forgerToolCalls = [];
  const connectionCalls = [];
  const manager = new WorkflowManager({
    forgerHomeRoot: metadataRoot,
    metadataRoot,
    codexHome: join(metadataRoot, 'codex'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => null,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => false,
    getClaudeAuthenticated: async () => false,
    callForgerToolAction: overrides.callForgerToolAction ?? (async (input) => {
      forgerToolCalls.push(input);
      return { success: true, data: { echoed: input.input, toolId: input.toolId, actionId: input.actionId } };
    }),
    callConnectionAction: overrides.callConnectionAction ?? (async (input) => {
      connectionCalls.push(input);
      return { success: true, data: { echoed: input.input, type: input.type, actionId: input.actionId, connectionId: input.connectionId } };
    }),
    getPersonalAgent: async () => null,
    onWorkflowUpdated: () => undefined,
    ...overrides.options,
  });
  await manager.initialize();
  return {
    manager,
    forgerToolCalls,
    connectionCalls,
    cleanup: async () => {
      await manager.dispose();
      await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

test('workflow sanitizer accepts forger_tool and connection nodes and migrates legacy connector nodes', () => {
  const forgerTool = sanitizeWorkflowNode({
    id: 'tool1',
    name: 'Refresh',
    type: 'forger_tool',
    toolId: 'forger_refresh_app_view',
    input: { appId: 'finance-os' },
  }, new Set(['forger_refresh_app_view']));
  assert.equal(forgerTool.type, 'forger_tool');
  assert.equal(forgerTool.toolId, 'forger_refresh_app_view');

  const connection = sanitizeWorkflowNode({
    id: 'calendar1',
    name: 'List Calendar',
    type: 'connection',
    connectionType: 'calendar',
    connectionId: 'conn-1',
    actionId: 'calendar.list_events',
    input: { calendarId: 'primary' },
  });
  assert.equal(connection.type, 'connection');
  assert.equal(connection.connectionType, 'calendar');
  assert.equal(connection.connectionId, 'conn-1');

  const migrated = sanitizeWorkflowNode({
    id: 'legacy',
    name: 'Legacy Gmail',
    type: 'connector',
    toolId: 'gmail',
    actionId: 'gmail.search_messages',
    input: { query: 'invoice' },
  });
  assert.equal(migrated.type, 'connection');
  assert.equal(migrated.connectionType, 'gmail');
  assert.equal(migrated.actionId, 'gmail.search_messages');
});

test('workflow manager runs connection and forger_tool nodes with structured output mapping', async () => {
  const harness = await createManager();
  try {
    const workflow = await harness.manager.upsert({
      name: 'Connection workflow',
      trigger: { type: 'manual' },
      nodes: [
        {
          id: 'gmail',
          name: 'Gmail status',
          type: 'connection',
          connectionType: 'gmail',
          actionId: 'gmail.connection.status',
          input: {},
        },
        {
          id: 'tool',
          name: 'Refresh app',
          type: 'forger_tool',
          toolId: 'forger_refresh_app_view',
          input: { appId: '{{nodes.gmail.output.type}}' },
        },
      ],
      edges: [{ from: 'gmail', to: 'tool', condition: 'success' }],
    });

    const run = await harness.manager.runNow(workflow.id);
    const finished = await waitFor(async () => {
      const current = await harness.manager.getRun(run.id);
      return current && ['succeeded', 'failed'].includes(current.status) ? current : null;
    });
    assert.equal(finished.status, 'succeeded');
    assert.equal(harness.connectionCalls[0].type, 'gmail');
    assert.equal(harness.connectionCalls[0].actionId, 'gmail.connection.status');
    assert.equal(harness.forgerToolCalls[0].toolId, 'forger_refresh_app_view');
    assert.equal(harness.forgerToolCalls[0].input.appId, 'gmail');
    const nodeRuns = Object.fromEntries(finished.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
    assert.deepEqual(nodeRuns.gmail.input, {
      type: 'gmail',
      actionId: 'gmail.connection.status',
      input: {},
    });
    assert.deepEqual(nodeRuns.tool.input, {
      toolId: 'forger_refresh_app_view',
      actionId: 'forger_refresh_app_view',
      input: { appId: 'gmail' },
    });
  } finally {
    await harness.cleanup();
  }
});

test('high-risk connection node pauses before execution when approval is required', async () => {
  const harness = await createManager();
  try {
    const workflow = await harness.manager.upsert({
      name: 'Needs approval',
      trigger: { type: 'manual' },
      nodes: [
        {
          id: 'send',
          name: 'Send Slack',
          type: 'connection',
          connectionType: 'slack',
          actionId: 'slack.send_message',
          input: { channelId: 'C1', text: 'hello' },
          requiresApproval: true,
        },
      ],
      edges: [],
    });
    const run = await harness.manager.runNow(workflow.id);
    const waiting = await waitFor(async () => {
      const current = await harness.manager.getRun(run.id);
      return current?.status === 'waiting_approval' ? current : null;
    });
    assert.equal(waiting.pendingApprovalNodeId, 'send');
    const sendNodeRun = waiting.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'send');
    assert.deepEqual(sendNodeRun.input, {
      type: 'slack',
      actionId: 'slack.send_message',
      input: { channelId: 'C1', text: 'hello' },
    });
    assert.equal(harness.connectionCalls.length, 0);
  } finally {
    await harness.cleanup();
  }
});
