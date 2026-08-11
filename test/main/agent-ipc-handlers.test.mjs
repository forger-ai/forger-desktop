import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createIpcMainRecorder, createTrustedMainWindow } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerAgentIpcHandlers } = require('../../dist-electron/main/ipc/agent-handlers.js');
const { createTrustedIpcMain } = require('../../dist-electron/main/ipc/trusted-ipc.js');
const desktopWindow = createTrustedMainWindow({ id: 9001 });

const createDeps = (overrides = {}) => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const desktopIpcMain = createTrustedIpcMain({
    ipcMain,
    getMainWindow: () => desktopWindow.mainWindow,
    getAdditionalTrustedWindows: overrides.getFriendChatWindows ?? (() => []),
  });
  const deps = {
    BUILT_IN_CLAUDE_EFFORT: 'medium',
    BUILT_IN_CODEX_REASONING: 'medium',
    BetterSqlite3: null,
    IPC_CHANNELS,
    appAgentConversationManager: null,
    appAgentTaskManager: null,
    automationManager: null,
    desktopErrorReporter: null,
    desktopIpcMain,
    ipcMain,
    normalizeAgentProvider: (value) => value,
    normalizeClaudeEffort: (value, fallback) => value ?? fallback,
    normalizeCodexReasoningEffort: (value, fallback) => value ?? fallback,
    registry: { apps: {} },
    renderManifestAgentPrompt: () => 'rendered prompt',
    resolveAppDbPath: async () => null,
    resolveAppIdForWebContents: () => null,
    resolveInstalledAgents: async () => [],
    ...overrides,
  };
  registerAgentIpcHandlers(deps);
  return { deps, handlers };
};

const eventForWebContents = (id) => ({ sender: { id } });
const desktopIpcEvent = desktopWindow.trustedIpcEvent;

test('agent IPC registers current and legacy task/conversation aliases to the same handlers', () => {
  const { handlers } = createDeps();

  assert.ok(handlers.size >= 43, 'expected app-agent IPC registration to include agent, database, and automation handlers');
  assert.equal(handlers.get(IPC_CHANNELS.appAgentTaskStart), handlers.get(IPC_CHANNELS.appCodexTaskStart));
  assert.equal(handlers.get(IPC_CHANNELS.appAgentTaskGet), handlers.get(IPC_CHANNELS.appCodexTaskGet));
  assert.equal(handlers.get(IPC_CHANNELS.appAgentTaskCancel), handlers.get(IPC_CHANNELS.appCodexTaskCancel));
  assert.equal(
    handlers.get(IPC_CHANNELS.appAgentTaskApprovePermission),
    handlers.get(IPC_CHANNELS.appCodexTaskApprovePermission),
  );
  assert.equal(
    handlers.get(IPC_CHANNELS.appAgentConversationCreate),
    handlers.get(IPC_CHANNELS.appCodexConversationCreate),
  );
  assert.equal(
    handlers.get(IPC_CHANNELS.appAgentConversationSendMessage),
    handlers.get(IPC_CHANNELS.appCodexConversationSendMessage),
  );
  assert.equal(handlers.get(IPC_CHANNELS.appAgentConversationGet), handlers.get(IPC_CHANNELS.appCodexConversationGet));
  assert.equal(handlers.get(IPC_CHANNELS.appAgentConversationList), handlers.get(IPC_CHANNELS.appCodexConversationList));
  assert.equal(
    handlers.get(IPC_CHANNELS.appAgentConversationDelete),
    handlers.get(IPC_CHANNELS.appCodexConversationDelete),
  );
  assert.equal(
    handlers.get(IPC_CHANNELS.appAgentConversationCancelRun),
    handlers.get(IPC_CHANNELS.appCodexConversationCancelRun),
  );
  assert.equal(
    handlers.get(IPC_CHANNELS.appAgentConversationApprovePermission),
    handlers.get(IPC_CHANNELS.appCodexConversationApprovePermission),
  );
});

test('app-agent task start enforces app-window authorization and manager availability', async () => {
  const { handlers } = createDeps();

  await assert.rejects(
    handlers.get(IPC_CHANNELS.appAgentTaskStart)(eventForWebContents(10), { prompt: 'go' }),
    /app_window_not_authorized/,
  );

  const authorized = createDeps({ resolveAppIdForWebContents: () => 'finance-os' });
  await assert.rejects(
    authorized.handlers.get(IPC_CHANNELS.appAgentTaskStart)(eventForWebContents(10), { prompt: 'go' }),
    /app_codex_task_manager_unavailable/,
  );
});

test('app-agent task start reports manager start failures and rethrows the original error', async () => {
  const startError = new Error('runner_failed');
  const reports = [];
  const { handlers } = createDeps({
    appAgentTaskManager: {
      start: async () => {
        throw startError;
      },
    },
    desktopErrorReporter: {
      reportAppCodexStartFailure: (input) => reports.push(input),
    },
    resolveAppIdForWebContents: () => 'finance-os',
  });

  await assert.rejects(
    handlers.get(IPC_CHANNELS.appCodexTaskStart)(eventForWebContents(10), { prompt: 'go' }),
    startError,
  );
  assert.deepEqual(reports, [
    {
      appId: 'finance-os',
      operation: 'app.codex-task.start',
      error: startError,
    },
  ]);
});

test('app-agent task and conversation handlers return safe fallbacks when context is unavailable', async () => {
  const { handlers } = createDeps();

  assert.equal(await handlers.get(IPC_CHANNELS.appAgentTaskGet)(eventForWebContents(1), 'run-1'), null);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appAgentTaskCancel)(eventForWebContents(1), 'run-1'), { success: false });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentTaskApprovePermission)(eventForWebContents(1), 'run-1', 'req-1', 'allow'),
    { success: false },
  );
  assert.equal(await handlers.get(IPC_CHANNELS.appAgentConversationGet)(eventForWebContents(1), 'thread-1'), null);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appAgentConversationList)(eventForWebContents(1)), []);
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentConversationDelete)(eventForWebContents(1), 'thread-1'),
    { success: false },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentConversationCancelRun)(eventForWebContents(1), 'thread-1', 'run-1'),
    { success: false },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentConversationApprovePermission)(
      eventForWebContents(1),
      'thread-1',
      'run-1',
      'req-1',
      'deny',
    ),
    { success: false },
  );
});

test('legacy agent thread IPC rejects removed freeform prompt operations', async () => {
  await assert.rejects(
    createDeps().handlers.get(IPC_CHANNELS.appAgentThreadCreate)(eventForWebContents(1), { initialPrompt: 'hello' }),
    /forgerApp bridge has been removed/,
  );
  await assert.rejects(
    createDeps().handlers.get(IPC_CHANNELS.appAgentThreadRunStart)(eventForWebContents(1), {
      desktopThreadId: 'thread-1',
      message: 'hello',
    }),
    /forgerApp bridge has been removed/,
  );
  await assert.rejects(
    createDeps().handlers.get(IPC_CHANNELS.appAgentThreadRunSteer)(eventForWebContents(1), {
      desktopThreadId: 'thread-1',
      desktopRunId: 'run-1',
      message: 'steer',
    }),
    /forgerApp bridge has been removed/,
  );
});

test('agent thread IPC returns safe unavailable fallbacks for read and cancel operations', async () => {
  const unavailable = createDeps();

  assert.equal(await unavailable.handlers.get(IPC_CHANNELS.appAgentThreadGet)(eventForWebContents(1), 'thread-1'), null);
  assert.equal(
    await unavailable.handlers.get(IPC_CHANNELS.appAgentThreadRunGet)(eventForWebContents(1), 'thread-1', 'run-1'),
    null,
  );
  assert.deepEqual(
    await unavailable.handlers.get(IPC_CHANNELS.appAgentThreadRunCancel)(eventForWebContents(1), {
      desktopThreadId: 'thread-1',
      desktopRunId: 'run-1',
    }),
    { success: false },
  );
  await assert.rejects(
    unavailable.handlers.get(IPC_CHANNELS.appManifestAgentStart)(eventForWebContents(1), { agentId: 'advisor' }),
    /app_agent_thread_unavailable/,
  );

  const manager = {
    cancel: async () => ({ success: true }),
    get: async (_appId, threadId) => threadId === 'thread-with-run'
      ? {
          conversationId: 'thread-with-run',
          title: 'Running',
          messages: [],
          activeRun: { runId: 'run-1', status: 'running', error: 'provider_error' },
        }
      : threadId === 'thread-completed'
        ? {
            conversationId: 'thread-completed',
            title: 'Completed',
            messages: [
              { messageId: 'msg-user', role: 'user', text: 'question', runId: 'run-2', createdAt: '2026-01-01T00:00:00.000Z' },
              { messageId: 'msg-other', role: 'assistant', text: 'ignore', runId: 'other-run', createdAt: '2026-01-01T00:00:01.000Z' },
              { messageId: 'msg-answer', role: 'assistant', text: 'completed answer', runId: 'run-2', createdAt: '2026-01-01T00:00:02.000Z' },
            ],
            activeRun: { runId: 'run-2', status: 'completed' },
          }
      : null,
  };
  const available = createDeps({
    appAgentConversationManager: manager,
    resolveAppIdForWebContents: () => 'finance-os',
  });

  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.appAgentThreadGet)(eventForWebContents(1), 'thread-with-run'), {
    desktop_thread_id: 'thread-with-run',
    title: 'Running',
    status: 'running',
    active_run: {
      desktop_thread_id: 'thread-with-run',
      desktop_run_id: 'run-1',
      status: 'running',
      error: 'provider_error',
    },
    messages: [],
  });
  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.appAgentThreadGet)(eventForWebContents(1), 'thread-completed'), {
    desktop_thread_id: 'thread-completed',
    title: 'Completed',
    status: 'completed',
    active_run: {
      desktop_thread_id: 'thread-completed',
      desktop_run_id: 'run-2',
      status: 'completed',
      resultText: 'completed answer',
    },
    messages: [
      { id: 'msg-user', role: 'user', content: 'question', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'msg-other', role: 'assistant', content: 'ignore', created_at: '2026-01-01T00:00:01.000Z' },
      { id: 'msg-answer', role: 'assistant', content: 'completed answer', created_at: '2026-01-01T00:00:02.000Z' },
    ],
  });
  assert.equal(await available.handlers.get(IPC_CHANNELS.appAgentThreadGet)(eventForWebContents(1), 'missing'), null);
});

test('agent thread IPC delegates read and cancel lifecycle with public summaries', async () => {
  const calls = [];
  const conversation = {
    conversationId: 'thread-1',
    title: 'Desk review',
    messages: [
      { messageId: 'msg-1', role: 'user', text: 'hello', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
  const runningConversation = {
    ...conversation,
    messages: [
      ...conversation.messages,
      {
        messageId: 'msg-old-user',
        role: 'user',
        text: 'old request',
        runId: 'run-old',
        createdAt: '2026-01-01T00:00:03.000Z',
      },
      {
        messageId: 'msg-old',
        role: 'assistant',
        text: 'old result',
        runId: 'run-old',
        createdAt: '2026-01-01T00:00:04.000Z',
      },
    ],
    activeRun: {
      runId: 'run-1',
      status: 'running',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
      progressLog: ['working'],
    },
  };
  const manager = {
    get: async (appId, threadId) => {
      calls.push(['get', appId, threadId]);
      return threadId === 'thread-1' ? runningConversation : null;
    },
    cancel: async (appId, threadId, runId) => {
      calls.push(['cancel', appId, threadId, runId]);
      return { success: true };
    },
  };
  const { handlers } = createDeps({
    appAgentConversationManager: manager,
    normalizeCodexReasoningEffort: (value) => `codex:${value}`,
    resolveAppIdForWebContents: () => 'finance-os',
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentThreadRunGet)(eventForWebContents(7), 'thread-1', 'run-1'),
    {
      desktop_thread_id: 'thread-1',
      desktop_run_id: 'run-1',
      status: 'running',
      progressLog: ['working'],
    },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentThreadRunGet)(eventForWebContents(7), 'thread-1', 'run-old'),
    {
      desktop_thread_id: 'thread-1',
      desktop_run_id: 'run-old',
      status: 'completed',
      resultText: 'old result',
    },
  );
  assert.equal(
    await handlers.get(IPC_CHANNELS.appAgentThreadRunGet)(eventForWebContents(7), 'thread-1', 'missing-run'),
    null,
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentThreadRunCancel)(eventForWebContents(7), {
      desktopThreadId: 'thread-1',
      desktopRunId: 'run-1',
    }),
    { success: true },
  );
});

test('manifest-agent IPC renders declared prompts, resumes by stored agent metadata, and stops active runs', async () => {
  const calls = [];
  const renderCalls = [];
  const manager = {
    create: async (appId, input) => {
      calls.push(['create', appId, input]);
      return {
        conversationId: 'thread-1',
        title: input.title ?? 'Manifest agent',
        messages: [],
      };
    },
    sendMessage: async (appId, input) => {
      calls.push(['sendMessage', appId, input]);
      return {
        conversationId: input.conversationId,
        title: 'Manifest agent',
        messages: [{ messageId: 'msg-1', role: 'user', text: input.message, createdAt: 'now' }],
        activeRun: { runId: 'run-1', status: 'queued', createdAt: 'now', updatedAt: 'now' },
      };
    },
    getMetadata: async (_appId, threadId) => threadId === 'thread-1' ? { manifestAgentId: 'advisor' } : undefined,
    get: async (_appId, threadId) => threadId === 'thread-1'
      ? {
          conversationId: 'thread-1',
          title: 'Manifest agent',
          messages: [],
          activeRun: { runId: 'run-1', status: 'running', createdAt: 'now', updatedAt: 'now' },
        }
      : null,
    cancel: async (appId, threadId, runId) => {
      calls.push(['cancel', appId, threadId, runId]);
      return { success: true };
    },
    steerRun: async (appId, threadId, runId, input) => {
      calls.push(['steerRun', appId, threadId, runId, input]);
      return { accepted: true, mode: 'queued_for_next_run' };
    },
  };
  const { handlers } = createDeps({
    appAgentConversationManager: manager,
    registry: { apps: { 'finance-os': { installDir: '/tmp/finance-os' } } },
    renderManifestAgentPrompt: (input) => {
      renderCalls.push(input);
      return `${input.kind}:${input.agent.id}:${input.variables?.topic ?? 'none'}`;
    },
    resolveAppIdForWebContents: () => 'finance-os',
    resolveInstalledAgents: async () => [{ id: 'advisor', title: 'Advisor' }],
  });

  const started = await handlers.get(IPC_CHANNELS.appManifestAgentStart)(eventForWebContents(2), {
    agentId: ' advisor ',
    title: 'Agent run',
    variables: { topic: 'cash' },
    metadata: { source: 'button' },
    runtime: { provider: 'claude', model: 'claude-test', effort: 'high' },
  });
  assert.equal(started.manifest_agent_id, 'advisor');
  assert.equal(started.desktop_thread_id, 'thread-1');
  assert.deepEqual(calls[0], ['create', 'finance-os', {
    title: 'Agent run',
    agentId: 'advisor',
    metadata: {
      source: 'button',
      agentId: 'advisor',
      manifestAgentId: 'advisor',
      promptApi: 'manifest',
      initialPromptApplied: true,
    },
  }]);
  assert.deepEqual(calls[1][2], {
    conversationId: 'thread-1',
    message: 'initial:advisor:cash',
    workspacePath: undefined,
    provider: 'claude',
    model: 'claude-test',
    effort: 'high',
  });
  assert.equal(renderCalls[0].kind, 'initial');
  assert.equal(renderCalls[0].appRoot, '/tmp/finance-os');

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appManifestAgentResume)(eventForWebContents(2), {
      threadId: ' thread-1 ',
      variables: { topic: 'resume' },
      workspacePath: '/tmp/finance-os',
    }),
    {
      desktop_thread_id: 'thread-1',
      desktop_run_id: 'run-1',
      status: 'queued',
    },
  );
  assert.equal(calls.at(-1)[2].message, 'resume:advisor:resume');

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appManifestAgentSteer)(eventForWebContents(2), {
      threadId: 'thread-1',
      runId: 'run-1',
      variables: { topic: 'steer' },
    }),
    { accepted: true, mode: 'queued_for_next_run' },
  );
  assert.equal(calls.at(-1)[4].message, 'steer:advisor:steer');

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appManifestAgentStop)(eventForWebContents(2), {
      threadId: 'thread-1',
    }),
    { success: true },
  );
  assert.deepEqual(calls.at(-1), ['cancel', 'finance-os', 'thread-1', 'run-1']);

  await assert.rejects(
    handlers.get(IPC_CHANNELS.appManifestAgentResume)(eventForWebContents(2), { threadId: 'missing' }),
    /manifest_agent_thread_agent_missing/,
  );
});

test('manifest-agent IPC rejects missing identifiers, missing installs, and undeclared agents', async () => {
  const manager = {
    create: async () => ({ conversationId: 'thread-1', title: 'Manifest agent', messages: [] }),
    get: async (_appId, threadId) => threadId === 'idle-thread'
      ? { conversationId: 'idle-thread', title: 'Idle', messages: [] }
      : null,
    getMetadata: async (_appId, threadId) => threadId === 'thread-1'
      ? { manifestAgentId: 'advisor' }
      : undefined,
    sendMessage: async () => ({ conversationId: 'thread-1', title: 'Manifest agent', messages: [] }),
    steerRun: async () => ({ accepted: true }),
  };
  const base = {
    appAgentConversationManager: manager,
    resolveAppIdForWebContents: () => 'finance-os',
  };

  await assert.rejects(
    createDeps(base).handlers.get(IPC_CHANNELS.appManifestAgentStart)(eventForWebContents(1), { agentId: '   ' }),
    /manifest_agent_required/,
  );

  await assert.rejects(
    createDeps(base).handlers.get(IPC_CHANNELS.appManifestAgentStart)(eventForWebContents(1), { agentId: 'advisor' }),
    /app_not_installed/,
  );

  await assert.rejects(
    createDeps({
      ...base,
      registry: { apps: { 'finance-os': { installDir: '/tmp/finance-os' } } },
      resolveInstalledAgents: async () => [],
    }).handlers.get(IPC_CHANNELS.appManifestAgentStart)(eventForWebContents(1), { agentId: 'advisor' }),
    /manifest_agent_not_found/,
  );

  const installed = createDeps({
    ...base,
    registry: { apps: { 'finance-os': { installDir: '/tmp/finance-os' } } },
    resolveInstalledAgents: async () => [{ id: 'advisor', title: 'Advisor' }],
  });
  await assert.rejects(
    installed.handlers.get(IPC_CHANNELS.appManifestAgentResume)(eventForWebContents(1), { threadId: '   ' }),
    /manifest_agent_thread_required/,
  );
  await assert.rejects(
    installed.handlers.get(IPC_CHANNELS.appManifestAgentSteer)(eventForWebContents(1), { threadId: 'thread-1' }),
    /manifest_agent_thread_run_required/,
  );
  assert.deepEqual(
    await installed.handlers.get(IPC_CHANNELS.appManifestAgentStop)(eventForWebContents(1), { threadId: '   ' }),
    { success: false },
  );
  assert.deepEqual(
    await installed.handlers.get(IPC_CHANNELS.appManifestAgentStop)(eventForWebContents(1), { threadId: 'idle-thread' }),
    { success: true },
  );
});

test('database IPC handlers return explicit errors when sqlite or app database paths are unavailable', async () => {
  const withoutSqlite = createDeps();

  assert.deepEqual(await withoutSqlite.handlers.get(IPC_CHANNELS.dbListTables)(desktopIpcEvent, 'finance-os'), {
    error: 'db_module_unavailable',
  });
  assert.deepEqual(
    await withoutSqlite.handlers.get(IPC_CHANNELS.dbQueryTable)(desktopIpcEvent, 'finance-os', 'accounts'),
    { error: 'db_module_unavailable' },
  );

  const withoutDbPath = createDeps({
    BetterSqlite3: function BetterSqlite3() {},
    resolveAppDbPath: async () => null,
  });
  assert.deepEqual(await withoutDbPath.handlers.get(IPC_CHANNELS.dbListTables)(desktopIpcEvent, 'finance-os'), {
    error: 'db_file_not_found',
  });
  assert.deepEqual(
    await withoutDbPath.handlers.get(IPC_CHANNELS.dbQueryTable)(desktopIpcEvent, 'finance-os', 'accounts'),
    { error: 'db_file_not_found' },
  );
});

test('database IPC handlers list and query sqlite tables with escaped table names', async () => {
  const preparedSql = [];
  const dbInstances = [];
  class FakeSqlite {
    constructor(dbPath, options) {
      this.dbPath = dbPath;
      this.options = options;
      this.closed = false;
      dbInstances.push(this);
    }

    prepare(sql) {
      preparedSql.push(sql);
      if (sql.includes('sqlite_master')) {
        return { all: () => [{ name: 'accounts' }, { name: 'weird"name' }] };
      }
      if (sql.startsWith('SELECT *')) {
        return {
          all: (limit) => {
            assert.equal(limit, 5);
            return [{ id: 1, name: 'cash' }];
          },
          columns: () => [{ name: 'id' }, { name: 'name' }],
        };
      }
      if (sql.startsWith('SELECT COUNT')) {
        return { get: () => ({ total: 1 }) };
      }
      throw new Error(`unexpected_sql:${sql}`);
    }

    close() {
      this.closed = true;
    }
  }

  const { handlers } = createDeps({
    BetterSqlite3: FakeSqlite,
    resolveAppDbPath: async () => '/tmp/finance.sqlite',
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.dbListTables)(desktopIpcEvent, 'finance-os'), {
    tables: ['accounts', 'weird"name'],
    dbPath: '/tmp/finance.sqlite',
  });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.dbQueryTable)(desktopIpcEvent, 'finance-os', 'weird"name', 5),
    { columns: ['id', 'name'], rows: [[1, 'cash']], total: 1 },
  );
  assert.equal(dbInstances.every((db) => db.options.readonly && db.closed), true);
  assert.equal(preparedSql.includes('SELECT * FROM "weird""name" LIMIT ?'), true);

  const failing = createDeps({
    BetterSqlite3: class FailingSqlite {
      prepare() {
        throw new Error('sqlite_locked');
      }
    },
    resolveAppDbPath: async () => '/tmp/finance.sqlite',
  });
  assert.deepEqual(await failing.handlers.get(IPC_CHANNELS.dbListTables)(desktopIpcEvent, 'finance-os'), {
    error: 'sqlite_locked',
  });
  assert.deepEqual(
    await failing.handlers.get(IPC_CHANNELS.dbQueryTable)(desktopIpcEvent, 'finance-os', 'accounts'),
    { error: 'sqlite_locked' },
  );
});

test('conversation start handlers report manager failures and delegate authorized lifecycle branches', async () => {
  const reports = [];
  const calls = [];
  const createError = new Error('create_failed');
  const sendError = new Error('send_failed');
  const manager = {
    create: async () => {
      throw createError;
    },
    sendMessage: async () => {
      throw sendError;
    },
  };
  const failing = createDeps({
    appAgentConversationManager: manager,
    desktopErrorReporter: {
      reportAppCodexStartFailure: (input) => reports.push(input),
    },
    resolveAppIdForWebContents: () => 'finance-os',
  });

  await assert.rejects(
    failing.handlers.get(IPC_CHANNELS.appAgentConversationCreate)(eventForWebContents(1), { title: 'New' }),
    createError,
  );
  await assert.rejects(
    failing.handlers.get(IPC_CHANNELS.appAgentConversationSendMessage)(eventForWebContents(1), {
      conversationId: 'thread-1',
      message: 'hello',
    }),
    sendError,
  );
  assert.deepEqual(reports, [
    {
      appId: 'finance-os',
      operation: 'app.codex-conversation.create',
      error: createError,
    },
    {
      appId: 'finance-os',
      operation: 'app.codex-conversation.send-message',
      error: sendError,
    },
  ]);

  const { handlers } = createDeps({
    appAgentConversationManager: {
      approvePermission: async (...args) => {
        calls.push(['approvePermission', ...args]);
        return { success: true };
      },
      cancel: async (...args) => {
        calls.push(['cancel', ...args]);
        return { success: true };
      },
      delete: async (...args) => {
        calls.push(['delete', ...args]);
        return { success: true };
      },
      get: async (...args) => {
        calls.push(['get', ...args]);
        return { conversationId: args[1] };
      },
      list: async (appId) => {
        calls.push(['list', appId]);
        return [{ conversationId: 'thread-1' }];
      },
    },
    resolveAppIdForWebContents: () => 'finance-os',
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.appAgentConversationList)(eventForWebContents(1)), [
    { conversationId: 'thread-1' },
  ]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appAgentConversationGet)(eventForWebContents(1), 'thread-1'), {
    conversationId: 'thread-1',
  });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentConversationDelete)(eventForWebContents(1), 'thread-1'),
    { success: true },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentConversationCancelRun)(eventForWebContents(1), 'thread-1', 'run-1'),
    { success: true },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentConversationApprovePermission)(
      eventForWebContents(1),
      'thread-1',
      'run-1',
      'req-1',
      'allow',
    ),
    { success: true },
  );
  assert.deepEqual(calls, [
    ['list', 'finance-os'],
    ['get', 'finance-os', 'thread-1'],
    ['delete', 'finance-os', 'thread-1'],
    ['cancel', 'finance-os', 'thread-1', 'run-1'],
    ['approvePermission', 'finance-os', 'thread-1', 'run-1', 'req-1', 'allow'],
  ]);
});

test('agent IPC covers authorized task operations, conversation unavailable branches, and queued fallbacks', async () => {
  const taskCalls = [];
  const taskManager = {
    approvePermission: async (...args) => {
      taskCalls.push(['approvePermission', ...args]);
      return { success: true };
    },
    cancel: async (...args) => {
      taskCalls.push(['cancel', ...args]);
      return { success: true };
    },
    get: (...args) => {
      taskCalls.push(['get', ...args]);
      return { runId: 'run-1' };
    },
    start: async (...args) => {
      taskCalls.push(['start', ...args]);
      return { runId: 'run-started' };
    },
  };
  const { handlers } = createDeps({
    appAgentTaskManager: taskManager,
    resolveAppIdForWebContents: () => 'finance-os',
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.appAgentTaskStart)(eventForWebContents(1), { prompt: 'go' }), {
    runId: 'run-started',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appAgentTaskGet)(eventForWebContents(1), 'run-1'), {
    runId: 'run-1',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.appAgentTaskCancel)(eventForWebContents(1), 'run-1'), {
    success: true,
  });
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentTaskApprovePermission)(eventForWebContents(1), 'run-1', 'req-1', 'allow'),
    { success: true },
  );
  assert.deepEqual(taskCalls.map((entry) => entry[0]), ['start', 'get', 'cancel', 'approvePermission']);

  const noManager = createDeps({ resolveAppIdForWebContents: () => 'finance-os' });
  await assert.rejects(
    noManager.handlers.get(IPC_CHANNELS.appAgentConversationCreate)(eventForWebContents(1), { title: 'New' }),
    /app_codex_conversation_manager_unavailable/,
  );
  await assert.rejects(
    noManager.handlers.get(IPC_CHANNELS.appAgentConversationSendMessage)(eventForWebContents(1), { message: 'hello' }),
    /app_codex_conversation_manager_unavailable/,
  );
  await assert.rejects(
    noManager.handlers.get(IPC_CHANNELS.appManifestAgentResume)(eventForWebContents(1), { threadId: 'thread-1' }),
    /app_agent_thread_unavailable/,
  );
  await assert.rejects(
    noManager.handlers.get(IPC_CHANNELS.appManifestAgentSteer)(eventForWebContents(1), {
      threadId: 'thread-1',
      runId: 'run-1',
    }),
    /app_agent_thread_unavailable/,
  );
  await assert.rejects(
    createDeps().handlers.get(IPC_CHANNELS.appAgentConversationCreate)(eventForWebContents(1), { title: 'New' }),
    /app_window_not_authorized/,
  );
  await assert.rejects(
    createDeps().handlers.get(IPC_CHANNELS.appAgentConversationSendMessage)(eventForWebContents(1), { message: 'hello' }),
    /app_window_not_authorized/,
  );
  assert.deepEqual(await createDeps().handlers.get(IPC_CHANNELS.appManifestAgentStop)(eventForWebContents(1), {
    threadId: 'thread-1',
  }), { success: false });

  const queued = createDeps({
    appAgentConversationManager: {
      getMetadata: async () => ({ agentId: 'advisor' }),
      sendMessage: async () => ({ conversationId: 'thread-1', title: 'No active run', messages: [] }),
    },
    registry: { apps: { 'finance-os': { installDir: '/tmp/finance-os' } } },
    resolveAppIdForWebContents: () => 'finance-os',
    resolveInstalledAgents: async () => [{ id: 'advisor', title: 'Advisor', initialPrompt: 'Help' }],
  });
  assert.deepEqual(
    await queued.handlers.get(IPC_CHANNELS.appManifestAgentResume)(eventForWebContents(1), { threadId: 'thread-1' }),
    { desktop_thread_id: 'thread-1', desktop_run_id: '', status: 'queued' },
  );

  const nullStarted = createDeps({
    appAgentConversationManager: {
      create: async () => ({ conversationId: 'thread-1', title: 'Manifest agent', messages: [] }),
      sendMessage: async () => null,
    },
    registry: { apps: { 'finance-os': { installDir: '/tmp/finance-os' } } },
    resolveAppIdForWebContents: () => 'finance-os',
    resolveInstalledAgents: async () => [{ id: 'advisor', title: 'Advisor', initialPrompt: 'Help' }],
  });
  await assert.rejects(
    nullStarted.handlers.get(IPC_CHANNELS.appManifestAgentStart)(eventForWebContents(1), { agentId: 'advisor' }),
    /manifest_agent_thread_start_failed/,
  );
});

test('agent registrations keep app-agent calls app-scoped and Desktop mutations Desktop-scoped', async () => {
  const appEvent = eventForWebContents(77);
  const friendWindow = createTrustedMainWindow({ id: 78 });
  const calls = [];
  const { handlers } = createDeps({
    appAgentTaskManager: {
      start: async (appId, input) => {
        calls.push(['task', appId, input]);
        return { runId: 'run-1' };
      },
    },
    automationManager: {
      create: async (input) => {
        calls.push(['automation', input]);
        return { id: 'auto-1' };
      },
    },
    getFriendChatWindows: () => [friendWindow.mainWindow],
    resolveAppIdForWebContents: (id) => id === 77 ? 'finance-os' : null,
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.appAgentTaskStart)(appEvent, { prompt: 'go' }),
    { runId: 'run-1' },
  );
  for (const event of [desktopIpcEvent, friendWindow.trustedIpcEvent]) {
    await assert.rejects(
      handlers.get(IPC_CHANNELS.appAgentTaskStart)(event, { prompt: 'impersonate' }),
      /app_window_not_authorized/,
    );
  }
  await assert.rejects(
    handlers.get(IPC_CHANNELS.automationsCreate)(appEvent, { title: 'raw mutation' }),
    /ipc_sender_not_authorized/,
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.automationsCreate)(friendWindow.trustedIpcEvent, { title: 'Daily' }),
    { id: 'auto-1' },
  );
  assert.deepEqual(calls, [
    ['task', 'finance-os', { prompt: 'go' }],
    ['automation', { title: 'Daily' }],
  ]);
});

test('automation IPC handlers expose safe missing-manager fallbacks and delegate when available', async () => {
  const missing = createDeps();

  assert.deepEqual(await missing.handlers.get(IPC_CHANNELS.automationsList)(desktopIpcEvent), []);
  await assert.rejects(
    missing.handlers.get(IPC_CHANNELS.automationsCreate)(desktopIpcEvent, { title: 'Daily' }),
    /automation_manager_unavailable/,
  );
  await assert.rejects(
    missing.handlers.get(IPC_CHANNELS.automationsUpdate)(desktopIpcEvent, { id: 'auto-1' }),
    /automation_manager_unavailable/,
  );
  assert.deepEqual(await missing.handlers.get(IPC_CHANNELS.automationsDelete)(desktopIpcEvent, 'auto-1'), {
    success: false,
    technicalCode: 'automation_manager_unavailable',
  });
  await assert.rejects(missing.handlers.get(IPC_CHANNELS.automationsPause)(desktopIpcEvent, 'auto-1'), /automation_manager_unavailable/);
  await assert.rejects(missing.handlers.get(IPC_CHANNELS.automationsResume)(desktopIpcEvent, 'auto-1'), /automation_manager_unavailable/);
  await assert.rejects(missing.handlers.get(IPC_CHANNELS.automationsRunNow)(desktopIpcEvent, 'auto-1'), /automation_manager_unavailable/);
  assert.deepEqual(await missing.handlers.get(IPC_CHANNELS.automationsListRuns)(desktopIpcEvent, 'auto-1'), []);
  assert.equal(await missing.handlers.get(IPC_CHANNELS.automationsGetRunTranscript)(desktopIpcEvent, 'run-1'), null);

  const calls = [];
  const manager = {
    create: async (input) => {
      calls.push(['create', input]);
      return { id: 'auto-created' };
    },
    delete: async (id) => {
      calls.push(['delete', id]);
      return { success: true };
    },
    getRunTranscript: async (runId) => {
      calls.push(['getRunTranscript', runId]);
      return [{ role: 'assistant', content: 'done' }];
    },
    list: async () => {
      calls.push(['list']);
      return [{ id: 'auto-1' }];
    },
    listRuns: async (automationId) => {
      calls.push(['listRuns', automationId]);
      return [{ id: 'run-1' }];
    },
    pause: async (id) => {
      calls.push(['pause', id]);
      return { success: true, paused: true };
    },
    resume: async (id) => {
      calls.push(['resume', id]);
      return { success: true, paused: false };
    },
    runNow: async (id) => {
      calls.push(['runNow', id]);
      return { id: 'run-now' };
    },
    update: async (input) => {
      calls.push(['update', input]);
      return { id: input.id, updated: true };
    },
  };
  const available = createDeps({ automationManager: manager });

  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.automationsList)(desktopIpcEvent), [{ id: 'auto-1' }]);
  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.automationsCreate)(desktopIpcEvent, { title: 'Daily' }), {
    id: 'auto-created',
  });
  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.automationsUpdate)(desktopIpcEvent, { id: 'auto-1' }), {
    id: 'auto-1',
    updated: true,
  });
  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.automationsDelete)(desktopIpcEvent, 'auto-1'), { success: true });
  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.automationsPause)(desktopIpcEvent, 'auto-1'), {
    success: true,
    paused: true,
  });
  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.automationsResume)(desktopIpcEvent, 'auto-1'), {
    success: true,
    paused: false,
  });
  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.automationsRunNow)(desktopIpcEvent, 'auto-1'), { id: 'run-now' });
  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.automationsListRuns)(desktopIpcEvent, 'auto-1'), [{ id: 'run-1' }]);
  assert.deepEqual(await available.handlers.get(IPC_CHANNELS.automationsGetRunTranscript)(desktopIpcEvent, 'run-1'), [
    { role: 'assistant', content: 'done' },
  ]);
  assert.deepEqual(calls.map((entry) => entry[0]), [
    'list',
    'create',
    'update',
    'delete',
    'pause',
    'resume',
    'runNow',
    'listRuns',
    'getRunTranscript',
  ]);
});

test('workflow IPC keeps mutations and runs behind the disabled feature gate', async () => {
  const managerCalls = [];
  const unavailableManager = new Proxy({}, {
    get: (_target, method) => (...args) => {
      managerCalls.push([method, ...args]);
      throw new Error('disabled_manager_must_not_be_called');
    },
  });
  const workflowFeatureController = {
    requireManager: () => {
      throw new Error('workflow_feature_disabled');
    },
  };
  const { handlers } = createDeps({
    workflowManager: unavailableManager,
    getWorkflowManager: () => workflowFeatureController.requireManager(),
    workflowFeatureController,
  });

  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsUpsert)(desktopIpcEvent, { name: 'Daily summary' }),
    /workflow_feature_disabled/,
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.workflowsDelete)(desktopIpcEvent, 'workflow-1'),
    { success: false, technicalCode: 'workflow_feature_disabled' },
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsSetEnabled)(desktopIpcEvent, 'workflow-1', true),
    /workflow_feature_disabled/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsRunNow)(desktopIpcEvent, 'workflow-1'),
    /workflow_feature_disabled/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.workflowsRunNode)(desktopIpcEvent, 'workflow-1', 'node-1'),
    /workflow_feature_disabled/,
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.workflowsCancelRun)(desktopIpcEvent, 'run-1'),
    { success: false, technicalCode: 'workflow_feature_disabled' },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.workflowsApproveNode)(desktopIpcEvent, {
      runId: 'run-1',
      nodeId: 'node-1',
      approved: true,
    }),
    { success: false, technicalCode: 'workflow_feature_disabled' },
  );
  assert.deepEqual(managerCalls, []);
});

test('workflow IPC resolves the current enabled manager for every request', async () => {
  const callsAtRegistration = [];
  const currentCalls = [];
  const createManager = (calls) => ({
    list: () => (calls.push(['list']), []),
    upsert: async (input) => (calls.push(['upsert', input]), { id: 'workflow-1' }),
    delete: async (id) => (calls.push(['delete', id]), { success: true }),
    setEnabled: async (id, enabled) => (calls.push(['setEnabled', id, enabled]), { id, enabled }),
    runNow: async (id) => (calls.push(['runNow', id]), { id: 'run-1' }),
    runNode: async (workflowId, nodeId) => (calls.push(['runNode', workflowId, nodeId]), { id: 'run-2' }),
    cancelRun: async (runId) => (calls.push(['cancelRun', runId]), { success: true }),
    approveNode: async (input) => (calls.push(['approveNode', input]), { success: true }),
    listRuns: async (workflowId) => (calls.push(['listRuns', workflowId]), []),
    getRun: async (runId) => (calls.push(['getRun', runId]), { id: runId }),
  });
  const managerAtRegistration = createManager(callsAtRegistration);
  let currentManager = managerAtRegistration;
  const workflowFeatureController = {
    requireManager: () => currentManager,
  };
  const { handlers } = createDeps({
    workflowManager: managerAtRegistration,
    getWorkflowManager: () => workflowFeatureController.requireManager(),
    workflowFeatureController,
  });
  currentManager = createManager(currentCalls);

  await handlers.get(IPC_CHANNELS.workflowsList)(desktopIpcEvent);
  await handlers.get(IPC_CHANNELS.workflowsUpsert)(desktopIpcEvent, { name: 'Daily summary' });
  await handlers.get(IPC_CHANNELS.workflowsDelete)(desktopIpcEvent, 'workflow-1');
  await handlers.get(IPC_CHANNELS.workflowsSetEnabled)(desktopIpcEvent, 'workflow-1', true);
  await handlers.get(IPC_CHANNELS.workflowsRunNow)(desktopIpcEvent, 'workflow-1');
  await handlers.get(IPC_CHANNELS.workflowsRunNode)(desktopIpcEvent, 'workflow-1', 'node-1');
  await handlers.get(IPC_CHANNELS.workflowsCancelRun)(desktopIpcEvent, 'run-1');
  await handlers.get(IPC_CHANNELS.workflowsApproveNode)(desktopIpcEvent, {
    runId: 'run-1',
    nodeId: 'node-1',
    approved: true,
  });
  await handlers.get(IPC_CHANNELS.workflowsListRuns)(desktopIpcEvent, 'workflow-1');
  await handlers.get(IPC_CHANNELS.workflowsGetRun)(desktopIpcEvent, 'run-1');

  assert.deepEqual(callsAtRegistration, []);
  assert.deepEqual(currentCalls, [
    ['list'],
    ['upsert', { name: 'Daily summary' }],
    ['delete', 'workflow-1'],
    ['setEnabled', 'workflow-1', true],
    ['runNow', 'workflow-1'],
    ['runNode', 'workflow-1', 'node-1'],
    ['cancelRun', 'run-1'],
    ['approveNode', { runId: 'run-1', nodeId: 'node-1', approved: true }],
    ['listRuns', 'workflow-1'],
    ['getRun', 'run-1'],
  ]);
});
