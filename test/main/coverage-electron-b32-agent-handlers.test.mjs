import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createIpcMainRecorder, createTrustedMainWindow } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerAgentIpcHandlers } = require('../../dist-electron/main/ipc/agent-handlers.js');
const { createTrustedIpcMain } = require('../../dist-electron/main/ipc/trusted-ipc.js');

const desktopWindow = createTrustedMainWindow({ id: 9320 });
const desktopIpcEvent = desktopWindow.trustedIpcEvent;
const appIpcEvent = { sender: { id: 9321 } };

const createDeps = (overrides = {}) => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const desktopIpcMain = createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => desktopWindow.mainWindow,
  });
  const deps = {
    BUILT_IN_CLAUDE_EFFORT: 'medium',
    BUILT_IN_CODEX_REASONING: 'medium',
    BetterSqlite3: null,
    IPC_CHANNELS,
    appAgentConversationManager: null,
    appAgentTaskManager: null,
    automationManager: null,
    workflowManager: null,
    desktopErrorReporter: null,
    desktopIpcMain,
    ipcMain,
    normalizeAgentProvider: (value) => value,
    normalizeClaudeEffort: (value, fallback) => value ?? fallback,
    normalizeCodexReasoningEffort: (value, fallback) => value ?? fallback,
    registry: { apps: {} },
    renderManifestAgentPrompt: ({ kind, agent }) => `${kind}:${agent.id}`,
    resolveAppDbPath: async () => null,
    resolveAppIdForWebContents: () => null,
    resolveInstalledAgents: async () => [],
    ...overrides,
  };
  registerAgentIpcHandlers(deps);
  return handlers;
};

test('Given the legacy workflow dependency, requests resolve it lazily and expose unavailable failures safely', async () => {
  const calls = [];
  const workflowManager = {
    list: () => [{ id: 'workflow-1' }],
    approveNode: async (input) => {
      calls.push(input);
      return { success: true };
    },
  };
  const available = createDeps({ workflowManager });

  assert.deepEqual(await available.get(IPC_CHANNELS.workflowsList)(desktopIpcEvent), [{ id: 'workflow-1' }]);
  assert.deepEqual(await available.get(IPC_CHANNELS.workflowsApproveNode)(desktopIpcEvent, {
    runId: 'run-1', nodeId: 'node-1', approved: false,
  }), {
    success: true,
  });
  assert.deepEqual(calls, [{ runId: 'run-1', nodeId: 'node-1', approved: false }]);

  const unavailable = createDeps();
  await assert.rejects(
    unavailable.get(IPC_CHANNELS.workflowsList)(desktopIpcEvent),
    /workflow_manager_unavailable/,
  );
  assert.deepEqual(await unavailable.get(IPC_CHANNELS.workflowsDelete)(desktopIpcEvent, 'workflow-1'), {
    success: false,
    technicalCode: 'workflow_manager_unavailable',
  });
});

test('Given a Codex manifest runtime, start normalizes auth, reasoning, and unsafe permission fields', async () => {
  const calls = [];
  const handlers = createDeps({
    appAgentConversationManager: {
      create: async (appId, input) => {
        calls.push(['create', appId, input]);
        return { conversationId: 'thread-1', title: 'Advisor', messages: [] };
      },
      sendMessage: async (appId, input) => {
        calls.push(['sendMessage', appId, input]);
        return {
          conversationId: 'thread-1',
          title: 'Advisor',
          messages: [],
          activeRun: { runId: 'run-1', status: 'queued' },
        };
      },
    },
    normalizeCodexReasoningEffort: (value) => `codex:${value}`,
    registry: { apps: { 'finance-os': { installDir: '/private/finance-os' } } },
    resolveAppIdForWebContents: () => 'finance-os',
    resolveInstalledAgents: async () => [{ id: 'advisor', title: 'Advisor' }],
  });

  const result = await handlers.get(IPC_CHANNELS.appManifestAgentStart)(appIpcEvent, {
    agentId: 'advisor',
    runtime: {
      provider: 'codex',
      authProfileId: ' work-profile ',
      modelParams: { reasoningEffort: 'high' },
      effort: 'default',
      permissionMode: 'unsafe',
    },
  });

  assert.equal(result.manifest_agent_id, 'advisor');
  assert.deepEqual(calls[1], ['sendMessage', 'finance-os', {
    conversationId: 'thread-1',
    message: 'initial:advisor',
    workspacePath: undefined,
    provider: 'codex',
    authProfileId: 'work-profile',
    effort: 'codex:high',
    permissionMode: 'unsafe',
  }]);
});

test('Given malformed optional IPC inputs, handlers reject or default them without crossing app boundaries', async () => {
  const calls = [];
  const handlers = createDeps({
    appAgentConversationManager: {
      cancel: async (...args) => {
        calls.push(['cancel', ...args]);
        return { success: true };
      },
      create: async (...args) => {
        calls.push(['create', ...args]);
        return { conversationId: 'thread-1' };
      },
    },
    resolveAppIdForWebContents: () => 'finance-os',
  });

  await assert.rejects(
    handlers.get(IPC_CHANNELS.appManifestAgentStart)(appIpcEvent, undefined),
    /manifest_agent_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.appManifestAgentResume)(appIpcEvent, undefined),
    /manifest_agent_thread_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.appManifestAgentSteer)(appIpcEvent, undefined),
    /manifest_agent_thread_run_required/,
  );
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appManifestAgentStop)(appIpcEvent, undefined), {
    success: false,
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appManifestAgentStop)(appIpcEvent, {
    threadId: ' thread-1 ',
    runId: ' run-direct ',
  }), { success: true });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appAgentConversationCreate)(appIpcEvent, undefined), {
    conversationId: 'thread-1',
  });
  assert.deepEqual(calls, [
    ['cancel', 'finance-os', 'thread-1', 'run-direct'],
    ['create', 'finance-os', {}],
  ]);
});

test('Given sparse database results, query preserves schema, null cells, counts, and non-Error failures', async () => {
  class SparseSqlite {
    prepare(sql) {
      if (sql.startsWith('SELECT * FROM "empty"')) {
        return { all: () => [], columns: () => [{ name: 'id' }] };
      }
      if (sql.startsWith('SELECT * FROM "nullable"')) {
        return { all: () => [{ value: undefined }], columns: () => [{ name: 'unused' }] };
      }
      if (sql.startsWith('SELECT COUNT')) {
        return { get: () => undefined };
      }
      return { all: () => [] };
    }

    close() {}
  }
  const sparse = createDeps({
    BetterSqlite3: SparseSqlite,
    resolveAppDbPath: async () => '/private/finance.sqlite',
  });

  assert.deepEqual(await sparse.get(IPC_CHANNELS.dbQueryTable)(desktopIpcEvent, 'finance-os', 'empty'), {
    columns: ['id'],
    rows: [],
    total: 0,
  });
  assert.deepEqual(await sparse.get(IPC_CHANNELS.dbQueryTable)(desktopIpcEvent, 'finance-os', 'nullable'), {
    columns: ['value'],
    rows: [[null]],
    total: 1,
  });

  class NonErrorSqlite {
    prepare() {
      return (function* raiseFailure() {})().throw('sqlite_non_error');
    }
  }
  const failing = createDeps({
    BetterSqlite3: NonErrorSqlite,
    resolveAppDbPath: async () => '/private/finance.sqlite',
  });
  assert.deepEqual(await failing.get(IPC_CHANNELS.dbListTables)(desktopIpcEvent, 'finance-os'), {
    error: 'db_list_tables_failed',
  });
  assert.deepEqual(await failing.get(IPC_CHANNELS.dbQueryTable)(desktopIpcEvent, 'finance-os', 'accounts'), {
    error: 'db_query_failed',
  });
});

test('Given malformed workflow mutations, IPC validation rejects before manager calls and app actions normalize ids', async () => {
  const handlers = createDeps({
    workflowManager: {
      list: () => [],
      listRevisions: async () => [],
      restoreRevision: async () => ({ ok: true }),
      apply: async () => ({ ok: true }),
      approveNode: async () => ({ ok: true }),
    },
    getWorkflowAppActionRuntime: () => ({ listAppActions: async (appId) => [{ appId }] }),
  });
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsApply)(desktopIpcEvent, 'wf', undefined),
    /workflow_apply_input_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsApply)(desktopIpcEvent, 'wf', { definitionHash: 123, expectedRevision: 1 }),
    /workflow_definition_hash_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsApply)(desktopIpcEvent, 'wf', { definitionHash: '', expectedRevision: 1 }),
    /workflow_definition_hash_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsApply)(desktopIpcEvent, 'wf', { definitionHash: 'hash', expectedRevision: 0 }),
    /workflow_expected_revision_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsReview)(desktopIpcEvent, 'x'.repeat(161)),
    /workflow_id_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsReview)(desktopIpcEvent, null),
    /workflow_id_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsRestoreRevision)(desktopIpcEvent, 'wf', undefined),
    /workflow_restore_input_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsRestoreRevision)(desktopIpcEvent, 'wf', { revisionId: 123, expectedRevision: 1 }),
    /workflow_revision_id_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsRestoreRevision)(desktopIpcEvent, 'wf', { revisionId: '', expectedRevision: 1 }),
    /workflow_revision_id_required/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsApproveNode)(desktopIpcEvent, undefined),
    /workflow_approval_input_invalid/,
  );
  assert.deepEqual(await handlers.get(IPC_CHANNELS.workflowsListAppActions)(desktopIpcEvent, ' app '), [{ appId: 'app' }]);
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsListAppActions)(desktopIpcEvent, ' '),
    /workflow_app_id_required/,
  );
  const unavailable = createDeps({ workflowManager: { list: () => [] } });
  await assert.rejects(
    unavailable.get(IPC_CHANNELS.workflowsListAppActions)(desktopIpcEvent, 'app'),
    /workflow_app_actions_unavailable/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsListAppActions)(desktopIpcEvent, null),
    /workflow_app_id_required/,
  );
});
