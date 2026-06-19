/* eslint-disable max-lines */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

const distRequire = (relativePath) => {
  const resolved = require.resolve(`../../dist-electron/${relativePath}`);
  delete require.cache[resolved];
  return require(resolved);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, label) => {
  for (let index = 0; index < 400; index += 1) {
    const value = predicate();
    if (value) {
      return value;
    }
    await sleep(25);
  }
  throw new Error(`timed_out_waiting_for:${label}`);
};

const createTempDesktopRoots = async (prefix) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    root,
    appsRoot: path.join(root, 'apps'),
    metadataRoot: path.join(root, 'metadata'),
    codexHome: path.join(root, 'codex-home'),
    cleanup: async () => await rm(root, { recursive: true, force: true }),
  };
};

const createFakeAgentCli = async (root, filename = 'fake-agent.cjs') => {
  const cliPath = path.join(root, filename);
  await writeFile(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(path.join(root, 'agent-calls.ndjson'))}, JSON.stringify({
    args,
    stdin,
    cwd: process.cwd(),
    allowedRoots: process.env.FORGER_ALLOWED_ROOTS || '',
    hasForgerToken: Boolean(process.env.FORGER_MCP_TOKEN),
    hasAppToken: Boolean(process.env.APP_MCP_TOKEN),
    codexHome: process.env.CODEX_HOME || '',
  }) + '\\n');
  if (args.includes('--output-format')) {
    console.log(JSON.stringify({ session_id: 'claude-session-task', result: 'claude completed task' }));
    return;
  }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex completed task' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }));
});
`, 'utf8');
  await chmod(cliPath, 0o755);
  return cliPath;
};

const readAgentCalls = async (root) => {
  const raw = await readFile(path.join(root, 'agent-calls.ndjson'), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line));
};

test('conversation manager persists lifecycle state and cancels pending permission requests', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-manager-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });
    let resolveAuth;
    const authGate = new Promise((resolve) => {
      resolveAuth = resolve;
    });
    const events = [];
    const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
    const manager = new AppAgentConversationManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.4', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(process.execPath)],
      getCodexEnvironment: async () => ({ FORGER_TEST_ENV: '1' }),
      getCodexAuthenticated: async () => await authGate,
      getClaudeAuthenticated: async () => false,
      hasCodexConversation: async (appId) => appId === 'finance-os',
      resolveAgents: async () => [{
        id: 'advisor',
        title: 'Advisor',
        initialPrompt: 'Use the app data carefully.',
        runtime: { provider: 'codex', model: 'gpt-5.4-mini', effort: 'high' },
      }],
      onConversationEvent: (event) => events.push(event),
    });

    const conversation = await manager.create('finance-os', {
      title: '  Monthly close  ',
      agentId: 'advisor',
      locale: 'es-CL',
      metadata: { keep: true, drop: { unsafe: true } },
    });
    assert.equal(conversation.title, 'Monthly close');
    assert.deepEqual(await manager.getMetadata('finance-os', conversation.conversationId), {
      keep: true,
      agentId: 'advisor',
      locale: 'es',
    });

    const withMessage = await manager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: ' Review the imported statement ',
    });
    const runId = withMessage.activeRun.runId;
    assert.equal(withMessage.messages.at(-1).text, 'Review the imported statement');
    assert.equal((await manager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: 'second',
    }).then(() => 'ok', (error) => error.message)), 'codex_conversation_run_active');

    const permissionPromise = manager.requestPermission(runId, {
      title: 'Run app tool',
      body: 'The assistant wants to use an internal app tool.',
      action: 'tool',
    });
    const needsPermission = await waitFor(
      () => events.find((event) => event.type === 'run.needs_permission'),
      'conversation_permission_event',
    );
    const requestId = needsPermission.run.permissionRequest.requestId;
    assert.equal(manager.approvePermission('wrong-app', conversation.conversationId, runId, requestId, 'allow').success, false);

    assert.deepEqual(await manager.cancel('finance-os', conversation.conversationId, runId), { success: true });
    assert.equal(await permissionPromise, false);
    const canceled = await waitFor(
      () => events.find((event) => event.type === 'run.canceled'),
      'conversation_canceled_event',
    );
    assert.equal(canceled.run.status, 'canceled');
    assert.equal(canceled.run.permissionRequest, undefined);

    resolveAuth(false);
    await sleep(25);
    const stored = JSON.parse(await readFile(
      path.join(roots.metadataRoot, 'app-codex-conversations', 'finance-os.json'),
      'utf8',
    ));
    assert.equal(stored.conversations[0].activeRun.status, 'canceled');
    assert.equal((await manager.delete('finance-os', conversation.conversationId)).success, true);
    assert.equal(await manager.get('finance-os', conversation.conversationId), null);
  } finally {
    await roots.cleanup();
  }
});

test('task manager handles template validation, pending permissions, cancellation, and persisted state', async () => {
  const roots = await createTempDesktopRoots('forger-task-manager-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });
    let resolveAuth;
    const authGate = new Promise((resolve) => {
      resolveAuth = resolve;
    });
    const events = [];
    const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
    const manager = new AppAgentTaskManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.4', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(process.execPath)],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => await authGate,
      getClaudeAuthenticated: async () => false,
      resolvePromptTemplates: async () => [{
        id: 'review',
        title: 'Review',
        prompt: 'Review {{topic}}',
        arguments: [{ name: 'topic', type: 'string', required: true }],
      }],
            onTaskUpdated: (event) => events.push(event),
          });

    assert.equal(await manager.start('finance-os', { templateId: 'missing' }).then(() => 'ok', (error) => error.message), 'app_prompt_template_not_declared');

    const task = await manager.start('finance-os', {
      templateId: ' review ',
      arguments: { topic: 'cash flow' },
    });
    assert.equal(task.status, 'queued');
    assert.equal(manager.get('finance-os', task.runId).status, 'queued');

    const permissionPromise = manager.requestPermission(task.runId, {
      title: 'Use app data',
      body: 'The assistant wants to continue.',
      action: 'tool',
    });
    await waitFor(
      () => events.find((event) => event.task.runId === task.runId && event.task.status === 'needs_permission'),
      'task_permission_event',
    );
    assert.equal(manager.approvePermission('finance-os', task.runId, 'missing-request', 'allow').success, false);
    assert.equal(manager.cancel('finance-os', task.runId).success, true);
    assert.equal(await permissionPromise, false);
    const canceled = await waitFor(
      () => events.find((event) => event.task.runId === task.runId && event.task.status === 'canceled'),
      'task_canceled_event',
    );
    assert.equal(canceled.task.error, 'canceled');
    assert.equal(canceled.task.permissionRequest, undefined);

    resolveAuth(false);
    await sleep(25);
    const stored = JSON.parse(await readFile(
      path.join(roots.metadataRoot, 'app-codex-runs', 'finance-os', task.runId, 'run.json'),
      'utf8',
    ));
    assert.equal(stored.status, 'canceled');
    assert.equal(manager.cancel('other-app', task.runId).success, false);
  } finally {
    await roots.cleanup();
  }
});

test('app-agent managers reject pending permissions for an app without canceling the active work', async () => {
  const roots = await createTempDesktopRoots('forger-agent-permission-reject-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });
    const authGate = new Promise(() => {});
    const conversationEvents = [];
    const taskEvents = [];
    const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
    const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
    const sharedOptions = {
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(process.execPath)],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => await authGate,
      getClaudeAuthenticated: async () => false,
    };
    const conversationManager = new AppAgentConversationManager({
      ...sharedOptions,
      hasCodexConversation: async () => true,
      resolveAgents: async () => [],
      onConversationEvent: (event) => conversationEvents.push(event),
    });
    const taskManager = new AppAgentTaskManager({
      ...sharedOptions,
      resolvePromptTemplates: async () => [{
        id: 'review',
        title: 'Review',
        prompt: 'Review {{topic}}',
        arguments: [{ name: 'topic', type: 'string', required: true }],
      }],
      onTaskUpdated: (event) => taskEvents.push(event),
    });

    const conversation = await conversationManager.create('finance-os', { title: 'Permission thread' });
    const withRun = await conversationManager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: 'Review the file',
    });
    const conversationRunId = withRun.activeRun.runId;
    const conversationPermission = conversationManager.requestPermission(conversationRunId, {
      title: 'Use app tool',
      body: 'The assistant wants to use an app tool.',
      action: 'tool',
    });
    await waitFor(
      () => conversationEvents.find((event) => event.type === 'run.needs_permission'),
      'conversation_permission_reject_event',
    );
    conversationManager.rejectPendingPermissionsForApp('finance-os');
    assert.equal(await conversationPermission, false);
    const conversationProgress = await waitFor(
      () => conversationEvents.find((event) => event.type === 'run.progress' && event.run.runId === conversationRunId),
      'conversation_permission_rejected_progress',
    );
    assert.equal(conversationProgress.run.status, 'running');
    assert.equal(conversationProgress.run.permissionRequest, undefined);

    const task = await taskManager.start('finance-os', {
      templateId: 'review',
      arguments: { topic: 'cash flow' },
    });
    const taskPermission = taskManager.requestPermission(task.runId, {
      title: 'Use task tool',
      body: 'The assistant wants to continue.',
      action: 'tool',
    });
    await waitFor(
      () => taskEvents.find((event) => event.task.runId === task.runId && event.task.status === 'needs_permission'),
      'task_permission_reject_event',
    );
    taskManager.rejectPendingPermissionsForApp('finance-os');
    assert.equal(await taskPermission, false);
    const taskProgress = await waitFor(
      () => taskEvents.find((event) => event.task.runId === task.runId && event.task.status === 'running'),
      'task_permission_rejected_progress',
    );
    assert.equal(taskProgress.task.permissionRequest, undefined);
    assert.equal(taskManager.get('finance-os', task.runId).status, 'running');
  } finally {
    await roots.cleanup();
  }
});

test('app-agent managers approve pending permissions and resume active work', async () => {
  const roots = await createTempDesktopRoots('forger-agent-permission-approve-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });
    const authGate = new Promise(() => {});
    const conversationEvents = [];
    const taskEvents = [];
    const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
    const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
    const sharedOptions = {
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(process.execPath)],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => await authGate,
      getClaudeAuthenticated: async () => false,
    };
    const conversationManager = new AppAgentConversationManager({
      ...sharedOptions,
      hasCodexConversation: async () => true,
      resolveAgents: async () => [],
      onConversationEvent: (event) => conversationEvents.push(event),
    });
    const taskManager = new AppAgentTaskManager({
      ...sharedOptions,
      resolvePromptTemplates: async () => [{
        id: 'review',
        title: 'Review',
        prompt: 'Review {{topic}}',
        arguments: [{ name: 'topic', type: 'string', required: true }],
      }],
      onTaskUpdated: (event) => taskEvents.push(event),
    });

    assert.equal(await conversationManager.requestPermission('missing-run', {
      title: 'Missing',
      body: 'Missing run.',
      action: 'tool',
    }), null);
    assert.equal(await taskManager.requestPermission('missing-run', {
      title: 'Missing',
      body: 'Missing run.',
      action: 'tool',
    }), null);

    const conversation = await conversationManager.create('finance-os', { title: 'Approve thread' });
    const withRun = await conversationManager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: 'Review the file',
    });
    const conversationRunId = withRun.activeRun.runId;
    const conversationPermission = conversationManager.requestPermission(conversationRunId, {
      title: 'Use app tool',
      body: 'The assistant wants to use an app tool.',
      action: 'tool',
    });
    const conversationPrompt = await waitFor(
      () => conversationEvents.find((event) => event.type === 'run.needs_permission'),
      'conversation_permission_approve_event',
    );
    assert.equal(conversationManager.approvePermission(
      'finance-os',
      conversation.conversationId,
      conversationRunId,
      conversationPrompt.run.permissionRequest.requestId,
      'allow',
    ).success, true);
    assert.equal(await conversationPermission, true);
    const conversationProgress = await waitFor(
      () => conversationEvents.find((event) => event.type === 'run.progress' && event.run.runId === conversationRunId),
      'conversation_permission_approved_progress',
    );
    assert.equal(conversationProgress.run.status, 'running');
    assert.equal(conversationProgress.run.permissionRequest, undefined);

    const task = await taskManager.start('finance-os', {
      templateId: 'review',
      arguments: { topic: 'cash flow' },
    });
    const taskPermission = taskManager.requestPermission(task.runId, {
      title: 'Use task tool',
      body: 'The assistant wants to continue.',
      action: 'tool',
    });
    const taskPrompt = await waitFor(
      () => taskEvents.find((event) => event.task.runId === task.runId && event.task.status === 'needs_permission'),
      'task_permission_approve_event',
    );
    assert.equal(taskManager.approvePermission(
      'finance-os',
      task.runId,
      taskPrompt.task.permissionRequest.requestId,
      'allow',
    ).success, true);
    assert.equal(await taskPermission, true);
    const taskProgress = await waitFor(
      () => taskEvents.find((event) => event.task.runId === task.runId && event.task.status === 'running'),
      'task_permission_approved_progress',
    );
    assert.equal(taskProgress.task.permissionRequest, undefined);
  } finally {
    await roots.cleanup();
  }
});

test('conversation manager covers validation, disabled apps, terminal cancellation, and active delete cleanup', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-validation-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });
    const authGate = new Promise(() => {});
    const events = [];
    const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
    const manager = new AppAgentConversationManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(process.execPath)],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => await authGate,
      getClaudeAuthenticated: async () => false,
      hasCodexConversation: async (appId) => appId === 'finance-os',
      resolveAgents: async () => [],
      canRequestPermission: () => false,
      onConversationEvent: (event) => events.push(event),
    });

    await assert.rejects(() => manager.create('disabled-app'), /app_codex_conversation_not_declared/);
    assert.deepEqual(await manager.list('finance-os'), []);
    assert.equal(await manager.get('finance-os', 'missing'), null);
    assert.equal(await manager.getMetadata('finance-os', 'missing'), undefined);
    assert.deepEqual(await manager.delete('finance-os', 'missing'), { success: false });
    await assert.doesNotReject(() => manager.execute('missing-conversation', 'missing-run', { message: 'ignored' }));
    manager.runs.set('other-run', {
      runId: 'other-run',
      appId: 'recipes',
      conversationId: 'other-conversation',
      status: 'needs_permission',
    });
    manager.rejectPendingPermissionsForApp('finance-os');
    assert.equal(manager.runs.get('other-run').status, 'needs_permission');

    const conversation = await manager.create('finance-os', { title: 'Validation' });
    await assert.rejects(() => manager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: '   ',
    }), /codex_conversation_empty_message/);
    await assert.rejects(() => manager.sendMessage('finance-os', {
      conversationId: 'missing',
      message: 'hello',
    }), /codex_conversation_not_found/);

    const withRun = await manager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: 'hold this run',
    });
    const runId = withRun.activeRun.runId;
    assert.equal(await manager.requestPermission(runId, {
      title: 'Denied by policy',
      body: 'Cannot ask.',
      action: 'tool',
    }), null);
    assert.deepEqual(await manager.cancel('finance-os', conversation.conversationId, runId), { success: true });
    assert.deepEqual(await manager.cancel('finance-os', conversation.conversationId, runId), { success: true });
    assert.deepEqual(await manager.cancel('finance-os', conversation.conversationId, 'missing-run'), { success: false });

    const activeConversation = await manager.create('finance-os', { title: 'Delete active' });
    const active = await manager.sendMessage('finance-os', {
      conversationId: activeConversation.conversationId,
      message: 'delete while active',
    });
    assert.deepEqual(await manager.delete('finance-os', activeConversation.conversationId), { success: true });
    assert.equal(manager.approvePermission('finance-os', activeConversation.conversationId, active.activeRun.runId, 'missing', 'allow').success, false);
    assert.equal(events.some((event) => event.type === 'conversation.deleted'), true);
  } finally {
    await roots.cleanup();
  }
});

test('conversation manager loads persisted conversations, skips corrupt files, and migrates legacy runtime', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-load-');
  try {
    const storageRoot = path.join(roots.metadataRoot, 'app-codex-conversations');
    await mkdir(storageRoot, { recursive: true });
    await writeFile(path.join(storageRoot, 'ignore.txt'), 'not json', 'utf8');
    await writeFile(path.join(storageRoot, 'broken.json'), '{bad json', 'utf8');
    await writeFile(path.join(storageRoot, 'finance-os.json'), JSON.stringify({
      conversations: [
        {
          conversationId: 'legacy-thread',
          appId: 'finance-os',
          title: 'Legacy thread',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messages: [{ role: 'user', text: 'hello', runId: 'old-run', createdAt: 'a' }],
          threadId: 'thread-old',
          activeRun: { runId: 'old-run', status: 'running', createdAt: 'a', updatedAt: 'b' },
        },
        {
          conversationId: 'terminal-thread',
          appId: 'finance-os',
          title: 'Terminal thread',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          messages: [],
          activeRun: { runId: 'terminal-run', status: 'completed', createdAt: 'a', updatedAt: 'b' },
          runtime: { provider: 'codex', model: 'custom', effort: 'high' },
        },
        { conversationId: '', appId: 'finance-os' },
      ],
    }), 'utf8');

    const events = [];
    const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
    const manager = new AppAgentConversationManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => true,
      getClaudeAuthenticated: async () => false,
      hasCodexConversation: async () => true,
      resolveAgents: async () => [],
      onConversationEvent: (event) => events.push(event),
    });

    const conversations = await manager.list('finance-os');
    assert.deepEqual(conversations.map((conversation) => conversation.conversationId), ['terminal-thread', 'legacy-thread']);
    assert.equal(conversations.find((conversation) => conversation.conversationId === 'legacy-thread').activeRun, undefined);
    assert.equal(conversations.find((conversation) => conversation.conversationId === 'terminal-thread').activeRun.status, 'completed');

    const stored = JSON.parse(await readFile(path.join(storageRoot, 'finance-os.json'), 'utf8'));
    const migrated = stored.conversations.find((conversation) => conversation.conversationId === 'legacy-thread');
    assert.deepEqual(migrated.runtime, { provider: 'codex', model: 'gpt-5.4', effort: 'medium' });
  } finally {
    await roots.cleanup();
  }
});

test('task manager covers validation, policy-denied permissions, terminal cancel, and async argument failures', async () => {
  const roots = await createTempDesktopRoots('forger-task-validation-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });
    const authGate = new Promise(() => {});
    const events = [];
    const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
    const templates = [{
      id: 'review',
      title: 'Review',
      prompt: 'Review {{topic}} {{document}}',
      arguments: [
        { name: 'topic', type: 'string', required: true, maxLength: 20 },
        { name: 'document', type: 'file', required: false, acceptedFileTypes: ['.txt'] },
      ],
    }];
    const manager = new AppAgentTaskManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(process.execPath)],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => await authGate,
      getClaudeAuthenticated: async () => false,
      resolvePromptTemplates: async () => templates,
      canRequestPermission: () => false,
      onTaskUpdated: (event) => events.push(event),
    });

    assert.equal(manager.get('finance-os', 'missing'), null);
    await assert.rejects(() => manager.start('missing-app', {
      templateId: 'review',
      arguments: { topic: 'cash flow' },
    }), /app_not_installed/);

    const task = await manager.start('finance-os', {
      templateId: 'review',
      arguments: { topic: 'cash flow' },
    });
    assert.equal(await manager.requestPermission(task.runId, {
      title: 'Denied by policy',
      body: 'Cannot ask.',
      action: 'tool',
    }), null);
    assert.equal(manager.cancel('finance-os', task.runId).success, true);
    assert.equal(manager.cancel('finance-os', task.runId).success, true);
    assert.equal(manager.cancel('other-app', task.runId).success, false);

    const validationEvents = [];
    const validationManager = new AppAgentTaskManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(process.execPath)],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => true,
      getClaudeAuthenticated: async () => false,
      resolvePromptTemplates: async () => templates,
      onTaskUpdated: (event) => validationEvents.push(event),
    });
    const invalid = await validationManager.start('finance-os', {
      templateId: 'review',
      arguments: { extra: 'not declared', topic: 'cash flow' },
    });
    const failed = await waitFor(
      () => validationEvents.find((event) => event.task.runId === invalid.runId && event.task.status === 'failed'),
      'task_invalid_argument_failed',
    );
    assert.equal(failed.task.error, 'app_prompt_argument_not_declared:extra');

    const optionalMissing = await validationManager.start('finance-os', {
      templateId: 'review',
      arguments: { topic: 'cash flow' },
    });
    const optionalFailed = await waitFor(
      () => validationEvents.find((event) => event.task.runId === optionalMissing.runId && event.task.status === 'failed'),
      'task_optional_file_missing_failed_later',
    );
    assert.notEqual(optionalFailed.task.error, 'app_prompt_argument_required:document');

    const tooLong = await validationManager.start('finance-os', {
      templateId: 'review',
      arguments: { topic: 'this text is longer than twenty characters' },
    });
    const stringFailed = await waitFor(
      () => validationEvents.find((event) => event.task.runId === tooLong.runId && event.task.status === 'failed'),
      'task_string_too_long_failed',
    );
    assert.match(stringFailed.task.error, /demasiado largo/);
    assert.deepEqual(stringFailed.task.errorDetails, {
      technicalCode: 'app_prompt_string_too_long',
      argumentName: 'topic',
      maxLength: 20,
      actualLength: 42,
    });

    templates[0].arguments[1].maxBytes = 1;
    const tooLarge = await validationManager.start('finance-os', {
      templateId: 'review',
      arguments: {
        topic: 'cash flow',
        document: { type: 'file', name: 'doc.txt', mimeType: 'text/plain', dataBase64: Buffer.from('too large').toString('base64') },
      },
    });
    const fileFailed = await waitFor(
      () => validationEvents.find((event) => event.task.runId === tooLarge.runId && event.task.status === 'failed'),
      'task_file_too_large_failed',
    );
    assert.equal(fileFailed.task.error, 'app_prompt_file_too_large:document');

    const legacyEvents = [];
    const legacyManager = new AppAgentTaskManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(process.execPath)],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => true,
      getClaudeAuthenticated: async () => false,
      resolvePromptTemplates: async () => [{
        id: 'legacy',
        title: 'Legacy',
        prompt: 'Review {{attachments}}',
        acceptedFileTypes: ['.txt'],
      }],
      onTaskUpdated: (event) => legacyEvents.push(event),
    });
    const legacyOversized = await legacyManager.start('finance-os', {
      templateId: 'legacy',
      attachments: [{
        name: 'big.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.alloc((20 * 1024 * 1024) + 1).toString('base64'),
      }],
    });
    const legacyFailed = await waitFor(
      () => legacyEvents.find((event) => event.task.runId === legacyOversized.runId && event.task.status === 'failed'),
      'task_legacy_attachment_too_large_failed',
    );
    assert.equal(legacyFailed.task.error, 'attachment_too_large');
  } finally {
    await roots.cleanup();
  }
});

test('task manager retries stale Codex thread failures with a clean temporary home', async () => {
  const roots = await createTempDesktopRoots('forger-task-stale-retry-');
  const fakeCodex = path.join(roots.root, 'stale-codex.cjs');
  const callsPath = path.join(roots.root, 'stale-calls.json');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });
    await mkdir(roots.codexHome, { recursive: true });
    await writeFile(path.join(roots.codexHome, 'auth.json'), '{"token":"test"}', 'utf8');
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const callsPath = ${JSON.stringify(callsPath)};
let calls = [];
try { calls = JSON.parse(fs.readFileSync(callsPath, 'utf8')); } catch {}
let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  calls.push({ args: process.argv.slice(2), stdin, codexHome: process.env.CODEX_HOME || '' });
  fs.writeFileSync(callsPath, JSON.stringify(calls, null, 2));
  if (calls.length === 1) {
    console.error('failed to record rollout items: thread stale-thread not found');
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Recovered task result.' } }));
});
`, 'utf8');
    await chmod(fakeCodex, 0o755);

    const events = [];
    const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
    const manager = new AppAgentTaskManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => fakeCodex,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [],
      getCodexEnvironment: async () => ({}),
      getAgentNetworkAccess: async () => false,
      getCodexAuthenticated: async () => true,
      getClaudeAuthenticated: async () => false,
      resolvePromptTemplates: async () => [{
        id: 'review',
        title: 'Review',
        prompt: 'Review {{topic}}',
        arguments: [{ name: 'topic', type: 'string', required: true }],
      }],
      onTaskUpdated: (event) => events.push(event),
    });

    const task = await manager.start('finance-os', {
      templateId: 'review',
      locale: 'en',
      arguments: { topic: 'cash flow' },
    });
    const completed = await waitFor(
      () => events.find((event) => event.task.runId === task.runId && event.task.status === 'completed'),
      'task_stale_retry_completed',
    );
    const calls = JSON.parse(await readFile(callsPath, 'utf8'));

    assert.equal(completed.task.resultText, 'Recovered task result.');
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].codexHome, calls[1].codexHome);
    assert.ok(completed.task.progressLog.includes('The assistant found a technical limitation and is trying another approach.'));
    assert.equal(manager.get('finance-os', task.runId).status, 'completed');
  } finally {
    await roots.cleanup();
  }
});

test('app-agent managers complete Codex runs with context, attachments, MCP sessions, and cleanup', async () => {
  const roots = await createTempDesktopRoots('forger-agent-codex-complete-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const fakeCli = await createFakeAgentCli(roots.root, 'fake-codex.cjs');
    const releasedTokens = [];
    const releasedRunIds = [];
    const conversationEvents = [];
    const taskEvents = [];
    const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
    const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
    const sharedOptions = {
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async (request) => ({
        provider: request?.provider ?? 'codex',
        model: request?.model ?? 'gpt-test',
        effort: request?.effort ?? 'medium',
      }),
      getCodexCliPath: async () => fakeCli,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(fakeCli)],
      getCodexEnvironment: async () => ({ FORGER_TEST_ENV: '1' }),
      getAgentNetworkAccess: async () => true,
      getCodexAuthenticated: async () => true,
      getClaudeAuthenticated: async () => false,
      createForgerMcpSession: (runId, appId, locale) => ({
        url: `http://127.0.0.1:7/${appId}/${runId}/${locale ?? 'none'}`,
        token: `forger-${runId}`,
      }),
      releaseForgerMcpSession: (token) => releasedTokens.push(token),
      buildMemoryContext: async () => 'Memory context.',
      buildForgerToolsContext: async () => 'Tool context.',
      listenAppMcps: async (appIds, runId) => appIds.map((appId) => ({
        name: appId,
        url: `http://127.0.0.1:8/${appId}/${runId}`,
        token: `app-${runId}`,
        tokenEnvVar: 'APP_MCP_TOKEN',
        toolTimeoutSec: 9,
      })),
      releaseAppMcps: (runId) => releasedRunIds.push(runId),
    };

    const conversationManager = new AppAgentConversationManager({
      ...sharedOptions,
      hasCodexConversation: async () => true,
      resolveAgents: async () => [{
        id: 'advisor',
        title: 'Advisor',
        initialPrompt: 'Agent initial prompt.',
        runtime: { provider: 'codex', model: 'agent-model', effort: 'high' },
      }],
      onConversationEvent: (event) => conversationEvents.push(event),
    });
    const taskManager = new AppAgentTaskManager({
      ...sharedOptions,
      resolvePromptTemplates: async () => [{
        id: 'review',
        title: 'Review',
        prompt: 'Review {{topic}} {{document}}',
        arguments: [
          { name: 'topic', type: 'string', required: true },
          { name: 'document', type: 'file', required: true, acceptedFileTypes: ['image/*'], maxBytes: 1024 },
        ],
        runtime: { provider: 'codex', model: 'task-model', effort: 'low' },
      }],
      onTaskUpdated: (event) => taskEvents.push(event),
    });

    const conversation = await conversationManager.create('finance-os', {
      title: 'Codex complete',
      agentId: 'advisor',
      locale: 'en-US',
    });
    const withRun = await conversationManager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: 'Summarize this screenshot',
      attachments: [
        { name: 'screen.png', mimeType: 'image/png', dataBase64: Buffer.from('png').toString('base64') },
        { name: 'notes.txt', mimeType: 'text/plain', dataBase64: Buffer.from('ignored').toString('base64') },
      ],
      workspacePath: path.join(appRoot, '.'),
    });
    const completedConversation = await waitFor(
      () => conversationEvents.find((event) => event.type === 'run.completed' && event.run.runId === withRun.activeRun.runId),
      'conversation_codex_completed',
    );
    assert.equal(completedConversation.run.status, 'completed');
    assert.equal((await conversationManager.get('finance-os', conversation.conversationId)).messages.at(-1).text, 'codex completed task');
    assert.equal((await conversationManager.getMetadata('finance-os', conversation.conversationId)).initialPromptApplied, undefined);

    const task = await taskManager.start('finance-os', {
      templateId: 'review',
      locale: 'en-US',
      arguments: {
        topic: 'cash flow',
        document: { type: 'file', name: 'screen.png', mimeType: 'image/png', dataBase64: Buffer.from('png').toString('base64') },
      },
    });
    const completedTask = await waitFor(
      () => taskEvents.find((event) => event.task.runId === task.runId && event.task.status === 'completed'),
      'task_codex_completed',
    );
    assert.equal(completedTask.task.resultText, 'codex completed task');
    assert.equal(completedTask.task.progressLog.includes('The assistant finished the task.'), true);

    await waitFor(() => releasedRunIds.length >= 2, 'agent_mcp_releases');
    assert.equal(releasedTokens.length, 2);
    assert.deepEqual(releasedRunIds.sort(), [task.runId, withRun.activeRun.runId].sort());

    const calls = await readAgentCalls(roots.root);
    assert.equal(calls.length, 2);
    assert.ok(calls.some((call) => call.stdin.includes('Summarize this screenshot') && call.args.includes('--image')));
    assert.ok(calls.some((call) => call.stdin.includes('Review cash flow') && call.hasForgerToken && call.hasAppToken));
    await assert.rejects(() => readFile(path.join(appRoot, '.forger', 'tmp', 'codex-task-inputs', task.runId, 'screen.png'), 'utf8'), /ENOENT/);
  } finally {
    await roots.cleanup();
  }
});

test('task manager completes Claude runs and reports provider setup failures behaviorally', async () => {
  const roots = await createTempDesktopRoots('forger-task-claude-complete-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });
    const fakeClaude = await createFakeAgentCli(roots.root, 'fake-claude.cjs');
    const templates = [{
      id: 'review',
      title: 'Review',
      prompt: 'Review {{topic}}',
      arguments: [{ name: 'topic', type: 'string', required: true }],
      runtime: { provider: 'claude', model: 'claude-test', effort: 'high' },
    }];
    const events = [];
    const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
    const manager = new AppAgentTaskManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async (request) => ({ provider: request?.provider ?? 'claude', model: request?.model ?? 'claude-test', effort: request?.effort ?? 'high' }),
      getCodexCliPath: async () => null,
      getClaudeCliPath: async () => fakeClaude,
      getCodexPathEntries: async () => [path.dirname(fakeClaude)],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => false,
      getClaudeAuthenticated: async () => true,
      resolvePromptTemplates: async () => templates,
      onTaskUpdated: (event) => events.push(event),
    });

    const task = await manager.start('finance-os', {
      templateId: 'review',
      arguments: { topic: 'budget' },
    });
    const completed = await waitFor(
      () => events.find((event) => event.task.runId === task.runId && event.task.status === 'completed'),
      'task_claude_completed',
    );
    assert.equal(completed.task.resultText, 'claude completed task');

    const failureEvents = [];
    const missingAuth = new AppAgentTaskManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'claude', model: 'claude-test', effort: 'medium' }),
      getCodexCliPath: async () => null,
      getClaudeCliPath: async () => fakeClaude,
      getCodexPathEntries: async () => [],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => false,
      getClaudeAuthenticated: async () => false,
      resolvePromptTemplates: async () => templates,
      onTaskUpdated: (event) => failureEvents.push(event),
    });
    const failedAuth = await missingAuth.start('finance-os', {
      templateId: 'review',
      arguments: { topic: 'budget' },
    });
    const authFailure = await waitFor(
      () => failureEvents.find((event) => event.task.runId === failedAuth.runId && event.task.status === 'failed'),
      'task_claude_auth_failed',
    );
    assert.equal(authFailure.task.error, 'claude_auth_missing');

    const missingCli = new AppAgentTaskManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'claude', model: 'claude-test', effort: 'medium' }),
      getCodexCliPath: async () => null,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => false,
      getClaudeAuthenticated: async () => true,
      resolvePromptTemplates: async () => templates,
      onTaskUpdated: (event) => failureEvents.push(event),
    });
    const failedCli = await missingCli.start('finance-os', {
      templateId: 'review',
      arguments: { topic: 'budget' },
    });
    const cliFailure = await waitFor(
      () => failureEvents.find((event) => event.task.runId === failedCli.runId && event.task.status === 'failed'),
      'task_claude_cli_failed',
    );
    assert.equal(cliFailure.task.error, 'claude_cli_missing');
  } finally {
    await roots.cleanup();
  }
});

const withMockedModuleLoad = async (mockForRequest, callback) => {
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    const mocked = mockForRequest(request);
    if (mocked) {
      return mocked;
    }
    if (request === 'cross-spawn') {
      const childProcessMock = mockForRequest('node:child_process') ?? mockForRequest('child_process');
      if (childProcessMock?.spawn) {
        return childProcessMock.spawn;
      }
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  try {
    delete require.cache[require.resolve('../../dist-electron/main/runtime/process-spawn.js')];
    return await callback();
  } finally {
    Module._load = originalLoad;
  }
};

const createFakeChildProcess = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  return child;
};

test('app MCP manager starts one server per app, reuses listeners, releases it, and reports start failures', async () => {
  const roots = await createTempDesktopRoots('forger-mcp-manager-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os', 'backend'), { recursive: true });
      const children = [];
      const logs = [];
      const terminations = [];
      const startFailures = [];
      let holdTermination = false;
      let resolveTermination;
      const childProcessMock = {
        spawn(command, args, options) {
          const child = createFakeChildProcess();
          children.push({ child, command, args, options });
        return child;
      },
    };

    await withMockedModuleLoad(
      (request) => request === 'node:child_process' ? childProcessMock : null,
      async () => {
        const { AppMcpManager, findManifestMcp } = distRequire('main/app-mcp-manager.js');
        assert.equal(findManifestMcp({ mcp: { type: 'stdio', command: 'python server.py' } }), null);
        assert.deepEqual(findManifestMcp({ mcp: { command: 'python server.py' } }), { command: 'python server.py' });

        let failRuntime = false;
        const manifest = {
          mcp: {
            command: 'python -m app.mcp',
            healthcheck: 'ready',
            environment: { PYTHONPATH: 'src' },
            toolTimeoutSec: 42,
          },
        };
        const manager = new AppMcpManager({
          getInstalledApp: (appId) => appId === 'finance-os'
            ? { appId, installDir: path.join(roots.appsRoot, appId), requiredPythonVersion: '3.12' }
            : null,
          resolveInstalledManifest: async () => manifest,
          ensureRuntimeInstalled: async () => {
            if (failRuntime) {
              throw new Error('runtime unavailable');
            }
            return { rootDir: path.join(roots.root, 'runtime'), python: '/runtime/python' };
          },
          ensureBackendPythonEnvironment: async () => undefined,
          getVenvExecutables: (backendDir) => ({ python: path.join(backendDir, '.venv', 'bin', 'python'), pip: 'pip' }),
          getFreePort: async () => 31234,
          splitManifestCommand: (command) => command.split(/\s+/).filter(Boolean),
          ensurePathInside: (rootPath, targetPath) => path.relative(rootPath, targetPath) === '' || !path.relative(rootPath, targetPath).startsWith('..'),
          translateManifestEnvironment: (environment) => ({ ...environment }),
          ensureSqliteDatabaseParent: async () => undefined,
          getDesktopRuntimeEnvironment: () => ({ DESKTOP_FLAG: 'yes' }),
          getRuntimePathEntries: () => ['/runtime/bin'],
            waitForHttpOk: async () => undefined,
            terminateProcess: async (child) => {
              terminations.push(child);
              if (holdTermination) {
                await new Promise((resolve) => {
                  resolveTermination = resolve;
                });
              }
            },
          appendInstallLog: async (event, payload) => {
            logs.push({ event, payload });
          },
          truncateForInstallLog: (value) => value.slice(0, 20),
          serializeErrorForInstallLog: (error) => ({ message: error.message }),
          onMcpStartFailed: (input) => startFailures.push(input),
        });

        assert.deepEqual(await manager.listenMcps(['missing'], 'run-missing'), []);
        const configs = await manager.listenMcps(['finance-os', 'finance-os'], 'run-1');
        assert.equal(configs.length, 1);
        assert.equal(configs[0].name, 'app_finance-os');
        assert.equal(configs[0].url, 'http://127.0.0.1:31234/mcp');
        assert.equal(configs[0].tokenEnvVar, 'FORGER_APP_MCP_TOKEN_FINANCE_OS');
        assert.equal(configs[0].toolTimeoutSec, 42);
        assert.equal(children.length, 1);
        assert.equal(children[0].command, path.join(roots.appsRoot, 'finance-os', 'backend', '.venv', 'bin', 'python'));
        assert.deepEqual(children[0].args, ['-m', 'app.mcp']);
        assert.equal(children[0].options.cwd, path.join(roots.appsRoot, 'finance-os', 'backend'));
        assert.equal(children[0].options.env.HOST, '127.0.0.1');
        assert.equal(children[0].options.env.DESKTOP_FLAG, 'yes');
        assert.equal(children[0].options.env.PYTHONPATH, path.join(roots.appsRoot, 'finance-os', 'backend', 'src'));
        assert.equal(logs.some((entry) => entry.event === 'app_mcp:ready'), true);

        const reused = await manager.listenMcps(['finance-os'], 'run-2');
        assert.equal(reused[0].token, configs[0].token);
          assert.equal(children.length, 1);
          manager.releaseMcps('run-1');
          await sleep(1_100);
          assert.equal(terminations.length, 0);

          holdTermination = true;
          manager.releaseMcps('run-2');
          await waitFor(() => terminations.length === 1, 'mcp_termination');
          const relistened = manager.listenMcps(['finance-os'], 'run-3');
          await sleep(10);
          resolveTermination();
          const restarted = await relistened;
          holdTermination = false;
          assert.equal(restarted.length, 1);
          assert.equal(children.length, 2);
          assert.notEqual(restarted[0].token, configs[0].token);
          assert.equal(logs.some((entry) => entry.event === 'app_mcp:stop'), true);
          manager.releaseMcps('run-3');
          await waitFor(() => terminations.length === 2, 'mcp_restarted_termination');

          manifest.mcp.command = 'uv run python -m app.mcp_server';
          const uvConfig = await manager.listenMcps(['finance-os'], 'run-uv');
          assert.equal(uvConfig.length, 1);
          assert.equal(children.at(-1).command, '/runtime/python');
          assert.deepEqual(children.at(-1).args, ['-m', 'uv', 'run', 'python', '-m', 'app.mcp_server']);
          assert.equal(children.at(-1).options.env.UV_PROJECT_ENVIRONMENT, path.join(roots.appsRoot, 'finance-os', 'backend', '.venv'));
          assert.equal(children.at(-1).options.env.UV_PYTHON, '/runtime/python');
          manager.releaseMcps('run-uv');
          await waitFor(() => terminations.length === 3, 'mcp_uv_termination');

          failRuntime = true;
          assert.deepEqual(await manager.listenMcps(['finance-os'], 'run-fail'), []);
        assert.equal(startFailures.length, 1);
        assert.equal(logs.some((entry) => entry.event === 'app_mcp:start_failed'), true);
        manager.dispose();
        },
      );
    } finally {
      await roots.cleanup();
    }
  });

test('conversation manager executes a codex run with scoped workspace, MCP sessions, attachments, and progress', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-exec-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    const workspacePath = path.join(appRoot, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    const commandCalls = [];
    const releasedForgerSessions = [];
    const releasedAppMcps = [];
    const isolationCalls = [];
    const events = [];

    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot || targetPath === workspacePath,
            killProcessTree: () => undefined,
            resolveCodexCommand: async (cliPath, pathEntries) => ({
              command: cliPath,
              prefixArgs: ['--profile', 'forger'],
              pathEntries,
            }),
            runCommandCapture: async (command, args, options) => {
              commandCalls.push({ command, args, options });
              options.onChild({ pid: 101 });
              options.onStdout('{"type":"turn.started"}\n');
              options.onStdout('{"type":"item.completed","item":{"type":"command_execution","command":"list_categories.py"}}\n');
              return {
                code: 0,
                stdout: [
                  '{"type":"thread.started","thread_id":"thread-123"}',
                  '{"type":"item.completed","item":{"type":"agent_message","text":"Reviewed the shared screenshot."}}',
                ].join('\n'),
                stderr: '',
              };
            },
          };
        }
        if (request === './codex-run-isolation') {
          return {
            assertAllowedMcpServers: (stdout, stderr, allowed) => {
              isolationCalls.push({ stdout, stderr, allowed: [...allowed] });
            },
            codexWorkspaceNetworkConfigArgs: (enabled) => enabled ? ['--config', 'sandbox_network_access=true'] : [],
            preparePersistentIsolatedCodexHome: async (sourceHome, targetHome, options) => {
              isolationCalls.push({ sourceHome, targetHome, options });
              return targetHome;
            },
          };
        }
        return null;
      },
      async () => {
        const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
        const manager = new AppAgentConversationManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async (request) => ({
            provider: request?.provider ?? 'codex',
            model: request?.model ?? 'gpt-test',
            effort: request?.effort ?? 'medium',
          }),
          getCodexCliPath: async () => '/usr/local/bin/codex',
          getClaudeCliPath: async () => null,
          getCodexPathEntries: async () => ['/runtime/bin'],
          getCodexEnvironment: async () => ({ FORGER_ENV: 'test' }),
          getAgentNetworkAccess: async () => true,
          getCodexAuthenticated: async () => true,
          getClaudeAuthenticated: async () => false,
          hasCodexConversation: async () => true,
          resolveAgents: async () => [{
            id: 'advisor',
            title: 'Advisor',
            initialPrompt: 'Use only app-local data.',
            runtime: { provider: 'codex', model: 'gpt-agent', effort: 'high' },
          }],
          createForgerMcpSession: () => ({ url: 'http://127.0.0.1:9999/mcp', token: 'forger-token' }),
          releaseForgerMcpSession: (token) => releasedForgerSessions.push(token),
          buildMemoryContext: async () => 'Memory: keep it local.',
          buildForgerToolsContext: async () => 'Tools: use app MCP first.',
          listenAppMcps: async () => [{
            name: 'app_finance-os',
            url: 'http://127.0.0.1:9998/mcp',
            token: 'app-token',
            tokenEnvVar: 'FORGER_APP_MCP_TOKEN_FINANCE_OS',
            toolTimeoutSec: 30,
          }],
          releaseAppMcps: (runId) => releasedAppMcps.push(runId),
          onConversationEvent: (event) => events.push(event),
        });

        const conversation = await manager.create('finance-os', {
          title: 'Execution',
          agentId: 'advisor',
          metadata: { initialPromptApplied: false },
        });
        const started = await manager.sendMessage('finance-os', {
          conversationId: conversation.conversationId,
          message: 'Review this image',
          workspacePath,
            attachments: [
              null,
              {
                name: 'missing-data.png',
                mimeType: 'image/png',
              },
              {
                name: 'screen shot.png',
                mimeType: 'image/png',
              dataBase64: Buffer.from('fake-image').toString('base64'),
            },
            {
              name: 'notes.txt',
              mimeType: 'text/plain',
              dataBase64: Buffer.from('ignore me').toString('base64'),
            },
          ],
        });

        const completed = await waitFor(
          () => events.find((event) => event.type === 'run.completed' && event.run.runId === started.activeRun.runId),
          'conversation_exec_completed',
        );

        assert.equal(completed.run.status, 'completed');
        assert.equal((await manager.get('finance-os', conversation.conversationId)).messages.at(-1).text, 'Reviewed the shared screenshot.');
        assert.equal(events.some((event) => event.type === 'run.progress' && event.progress), true);
        assert.equal(commandCalls.length, 1);
        assert.equal(commandCalls[0].command, '/usr/local/bin/codex');
        assert.equal(commandCalls[0].options.cwd, workspacePath);
        assert.equal(commandCalls[0].options.env.FORGER_MCP_TOKEN, 'forger-token');
        assert.equal(commandCalls[0].options.env.FORGER_APP_MCP_TOKEN_FINANCE_OS, 'app-token');
        assert.equal(commandCalls[0].args.includes('--image'), true);
        assert.equal(commandCalls[0].options.stdinText, 'Review this image');
        assert.deepEqual(releasedForgerSessions, ['forger-token']);
        assert.deepEqual(releasedAppMcps, [started.activeRun.runId]);
        assert.equal(isolationCalls.some((call) => call.allowed?.includes('app_finance-os')), true);

        const attachmentRoot = path.join(
          roots.metadataRoot,
          'app-codex-conversation-inputs',
          'finance-os',
          started.activeRun.runId,
        );
        assert.equal(await readFile(path.join(attachmentRoot, '1-screen-shot.png.png'), 'utf8').then(() => 'exists', () => 'removed'), 'removed');

        const failingConversation = await manager.create('finance-os', { title: 'Outside workspace' });
        const failed = await manager.sendMessage('finance-os', {
          conversationId: failingConversation.conversationId,
          message: 'Try outside',
          workspacePath: path.join(roots.root, 'outside'),
        });
        const failedEvent = await waitFor(
          () => events.find((event) => event.type === 'run.failed' && event.run.runId === failed.activeRun.runId),
          'conversation_outside_workspace_failed',
        );
        assert.equal(failedEvent.run.error, 'agent_run_workspace_outside_app');

        const outsideRoot = path.join(roots.root, 'outside-realpath');
        const symlinkWorkspace = path.join(appRoot, 'linked-outside');
        await mkdir(outsideRoot, { recursive: true });
        await symlink(outsideRoot, symlinkWorkspace);
        const symlinkConversation = await manager.create('finance-os', { title: 'Symlink escape' });
        const symlinkRun = await manager.sendMessage('finance-os', {
          conversationId: symlinkConversation.conversationId,
          message: 'Try symlink',
          workspacePath: symlinkWorkspace,
        });
        const symlinkFailed = await waitFor(
          () => events.find((event) => event.type === 'run.failed' && event.run.runId === symlinkRun.activeRun.runId),
          'conversation_symlink_workspace_failed',
        );
        assert.equal(symlinkFailed.run.error, 'agent_run_workspace_outside_app');

        const missingWorkspaceConversation = await manager.create('finance-os', { title: 'Missing workspace' });
        const missingWorkspace = await manager.sendMessage('finance-os', {
          conversationId: missingWorkspaceConversation.conversationId,
          message: 'Try missing workspace',
          workspacePath: path.join(appRoot, 'missing-workspace'),
        });
        const missingWorkspaceFailed = await waitFor(
          () => events.find((event) => event.type === 'run.failed' && event.run.runId === missingWorkspace.activeRun.runId),
          'conversation_missing_workspace_failed',
        );
        assert.equal(missingWorkspaceFailed.run.error, 'agent_run_workspace_missing');

          const oversizedConversation = await manager.create('finance-os', { title: 'Oversized attachment' });
          const oversized = await manager.sendMessage('finance-os', {
            conversationId: oversizedConversation.conversationId,
            message: 'Try a huge image',
            attachments: [{
              name: 'huge.png',
              mimeType: 'image/png',
              dataBase64: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64'),
            }],
          });
          const oversizedFailed = await waitFor(
            () => events.find((event) => event.type === 'run.failed' && event.run.runId === oversized.activeRun.runId),
            'conversation_oversized_attachment_failed',
          );
          assert.equal(oversizedFailed.run.error, 'codex_conversation_attachment_too_large');
        },
      );
  } finally {
    await roots.cleanup();
  }
});

test('task manager executes a codex task with typed file arguments, progress, cleanup, and transcript output', async () => {
  const roots = await createTempDesktopRoots('forger-task-exec-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const commandCalls = [];
    const removedHomes = [];
    const releasedSessions = [];
    const releasedMcps = [];
    const events = [];

    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot,
            isPathInside: (targetPath, rootPath) => {
              const relative = path.relative(rootPath, targetPath);
              return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
            },
            killProcessTree: () => undefined,
            resolveCodexCommand: async (cliPath, pathEntries) => ({
              command: cliPath,
              prefixArgs: [],
              pathEntries,
            }),
            runCommandCapture: async (command, args, options) => {
                commandCalls.push({ command, args, options });
                options.onStdout('{"type":"turn.started"}\n');
                options.onStdout('{"type":"turn.started"}\n');
                options.onStdout('{"type":"item.completed","item":{"type":"command_execution","command":"import_movements.py"}}\n');
                return {
                code: 0,
                stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Imported and checked the file."}}\n',
                stderr: '',
              };
            },
          };
        }
        if (request === './codex-run-isolation') {
          return {
            assertAllowedMcpServers: () => undefined,
            codexWorkspaceNetworkConfigArgs: (enabled) => enabled ? ['--config', 'sandbox_network_access=true'] : [],
            createIsolatedCodexHome: async (_codexHome, options) => path.join(roots.root, options.prefix),
            removeIsolatedCodexHome: async (targetPath) => removedHomes.push(targetPath),
          };
        }
        return null;
      },
      async () => {
        const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
        const manager = new AppAgentTaskManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-task', effort: 'medium' }),
          getCodexCliPath: async () => '/usr/local/bin/codex',
          getClaudeCliPath: async () => null,
          getCodexPathEntries: async () => ['/runtime/bin'],
          getCodexEnvironment: async () => ({ FORGER_TASK_ENV: '1' }),
          getAgentNetworkAccess: async () => true,
          getCodexAuthenticated: async () => true,
          getClaudeAuthenticated: async () => false,
          resolvePromptTemplates: async () => [{
            id: 'import',
            title: 'Import',
            prompt: 'Import {{statement}} for {{account}}',
            arguments: [
              { name: 'account', type: 'string', required: true, maxLength: 40 },
              { name: 'statement', type: 'file', required: true, acceptedFileTypes: ['image/*'], multiple: true },
            ],
          }],
          createForgerMcpSession: () => ({ url: 'http://127.0.0.1:7777/mcp', token: 'session-token' }),
          releaseForgerMcpSession: (token) => releasedSessions.push(token),
          buildMemoryContext: async () => 'Memory context',
          buildForgerToolsContext: async () => 'Tools context',
          listenAppMcps: async () => [{
            name: 'app_finance-os',
            url: 'http://127.0.0.1:7778/mcp',
            token: 'app-token',
            tokenEnvVar: 'FORGER_APP_MCP_TOKEN_FINANCE_OS',
          }],
          releaseAppMcps: (runId) => releasedMcps.push(runId),
          onTaskUpdated: (event) => events.push(event),
          });

        const task = await manager.start('finance-os', {
          templateId: 'import',
          locale: 'en-US',
          arguments: {
            account: { type: 'string', value: 'Checking' },
            statement: [
              {
                type: 'file',
                name: 'statement.png',
                mimeType: 'image/png',
                dataBase64: Buffer.from('image-a').toString('base64'),
              },
              {
                type: 'file',
                name: 'statement.png',
                mimeType: 'image/png',
                dataBase64: Buffer.from('image-b').toString('base64'),
              },
            ],
          },
        });

        const completed = await waitFor(
          () => events.find((event) => event.task.runId === task.runId && event.task.status === 'completed'),
          'task_exec_completed',
        );

        assert.equal(completed.task.resultText, 'Imported and checked the file.');
        assert.equal(completed.task.progressLog.some((entry) => /assistant is working/i.test(entry)), true);
        assert.equal(completed.task.progressLog.some((entry) => /Loading movements/i.test(entry)), true);
        assert.equal(commandCalls.length, 1);
        assert.equal(commandCalls[0].command, '/usr/local/bin/codex');
        assert.match(commandCalls[0].options.stdinText, /Memory context/);
        assert.match(commandCalls[0].options.stdinText, /statement-2\.png/);
        assert.equal(commandCalls[0].args.filter((arg) => arg === '--image').length, 2);
        assert.equal(commandCalls[0].options.env.CODEX_HOME, path.join(roots.root, 'forger-task-codex-home'));
        assert.deepEqual(releasedSessions, ['session-token']);
        assert.deepEqual(releasedMcps, [task.runId]);
        assert.deepEqual(removedHomes, [path.join(roots.root, 'forger-task-codex-home')]);

        const transcript = await readFile(
          path.join(roots.metadataRoot, 'app-codex-runs', 'finance-os', task.runId, 'transcript.log'),
          'utf8',
        );
        assert.match(transcript, /codex \/usr\/local\/bin\/codex/);
        assert.equal(
          await readFile(path.join(appRoot, '.forger', 'tmp', 'codex-task-inputs', task.runId, 'statement.png'), 'utf8')
            .then(() => 'exists', () => 'removed'),
          'removed',
        );
      },
    );
    } finally {
      await roots.cleanup();
    }
  });

test('app-agent manager guard helpers keep no-op edge cases safe', async () => {
  const roots = await createTempDesktopRoots('forger-agent-guard-helpers-');
  try {
    const events = [];
    const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
    const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
    const { AppMcpManager } = distRequire('main/app-mcp-manager.js');
    const conversationManager = new AppAgentConversationManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => true,
      getClaudeAuthenticated: async () => false,
      hasCodexConversation: async () => true,
      resolveAgents: async () => [{ id: 'advisor', title: 'Advisor', initialPrompt: '' }],
      onConversationEvent: (event) => events.push(event),
    });
    const now = new Date().toISOString();
    conversationManager.runs.set('orphan-run', {
      runId: 'orphan-run',
      appId: 'finance-os',
      conversationId: 'missing-conversation',
      locale: 'en',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      progressLog: [],
    });
    await conversationManager.failRun('orphan-run', 'boom');
    assert.equal(events.some((event) => event.type === 'run.failed'), false);

    const taskManager = new AppAgentTaskManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => true,
      getClaudeAuthenticated: async () => false,
      resolvePromptTemplates: async () => [],
      onTaskUpdated: () => undefined,
    });
    assert.throws(() => taskManager.taskRunDir('finance-os', '../outside'), /app_codex_task_path_outside_storage/);
    assert.throws(() => taskManager.taskInputDir({
      appRoot: roots.root,
      runId: '../outside',
    }), /app_codex_task_path_outside_tmp/);

    const mcpManager = new AppMcpManager({
      getInstalledApp: () => null,
      resolveInstalledManifest: async () => null,
      ensureRuntimeInstalled: async () => ({ rootDir: roots.root, python: process.execPath }),
      ensureBackendPythonEnvironment: async () => undefined,
      getVenvExecutables: () => ({ python: process.execPath, pip: 'pip' }),
      getFreePort: async () => 1,
      splitManifestCommand: () => [],
      ensurePathInside: () => true,
      translateManifestEnvironment: () => ({}),
      ensureSqliteDatabaseParent: async () => undefined,
      getRuntimePathEntries: () => [],
      waitForHttpOk: async () => undefined,
      terminateProcess: async () => undefined,
      appendInstallLog: async () => undefined,
      truncateForInstallLog: (value) => value,
      serializeErrorForInstallLog: (error) => ({ message: String(error) }),
    });
    assert.equal(mcpManager.toConfig({
      appId: 'finance-os',
      status: 'up',
      listeners: new Set(),
      generation: 0,
    }), null);
    await mcpManager.stopOne({
      appId: 'finance-os',
      status: 'up',
      listeners: new Set(['run-1']),
      generation: 0,
    });
    let resolveStart;
    const startingState = {
      appId: 'finance-os',
      status: 'starting',
      listeners: new Set(),
      generation: 0,
      startPromise: new Promise((resolve) => {
        resolveStart = resolve;
      }),
    };
    const stoppedStarting = mcpManager.stopOne(startingState);
    startingState.listeners.add('run-2');
    resolveStart(null);
    await stoppedStarting;
  } finally {
    await roots.cleanup();
  }
});

test('conversation manager steers active runs by canceling current work and queuing the next message', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-steer-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });
    const authGate = new Promise(() => {});
    const events = [];
    const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
    const manager = new AppAgentConversationManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => process.execPath,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(process.execPath)],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => await authGate,
      getClaudeAuthenticated: async () => false,
      hasCodexConversation: async () => true,
      resolveAgents: async () => [],
      onConversationEvent: (event) => events.push(event),
    });

    await assert.rejects(() => manager.steerRun('finance-os', 'missing', 'run-1', {
      message: 'new instruction',
    }), /codex_conversation_not_found/);

    const conversation = await manager.create('finance-os', { title: 'Steering' });
    const started = await manager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: 'first instruction',
    });
    const activeRunId = started.activeRun.runId;
    await assert.rejects(() => manager.steerRun('finance-os', conversation.conversationId, 'wrong-run', {
      message: 'new instruction',
    }), /codex_conversation_run_mismatch/);

    const result = await manager.steerRun('finance-os', conversation.conversationId, activeRunId, {
      message: 'updated instruction',
      provider: 'codex',
      model: 'gpt-override',
      effort: 'high',
    });
    assert.deepEqual(result, { accepted: true, mode: 'queued_for_next_run' });
    const updated = await manager.get('finance-os', conversation.conversationId);
    assert.equal(updated.messages.at(-1).text, 'updated instruction');
    assert.notEqual(updated.activeRun.runId, activeRunId);
    assert.equal(events.some((event) => event.type === 'run.steering.accepted'), true);
    assert.equal(events.some((event) => event.type === 'run.canceled' && event.run.runId === activeRunId), true);
  } finally {
    await roots.cleanup();
  }
});

test('conversation manager executes a claude run with resume state and cleans MCP config', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-claude-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const storageRoot = path.join(roots.metadataRoot, 'app-codex-conversations');
    await mkdir(storageRoot, { recursive: true });
    await writeFile(path.join(storageRoot, 'finance-os.json'), JSON.stringify({
      conversations: [{
        conversationId: 'claude-thread',
        appId: 'finance-os',
        title: 'Claude thread',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [],
        threadId: 'claude-session-old',
        metadata: { initialPrompt: 'Use the Claude-only instructions.', locale: 'en' },
      }],
    }), 'utf8');
    const commandCalls = [];
    const releasedSessions = [];
    const releasedMcps = [];
    const events = [];

    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot,
            killProcessTree: () => undefined,
            resolveCodexCommand: async () => {
              throw new Error('codex_should_not_be_used');
            },
            runCommandCapture: async (command, args, options) => {
              commandCalls.push({ command, args, options });
              options.onStdout('{"type":"assistant","message":{"content":[{"text":"Working in Claude."}]}}\n');
              return {
                code: 0,
                stdout: '{"session_id":"claude-session-new","result":"Claude finished the review."}\n',
                stderr: '',
              };
            },
          };
        }
        return null;
      },
      async () => {
        const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
        const manager = new AppAgentConversationManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async (request) => ({
            provider: request?.provider ?? 'claude',
            model: request?.model ?? 'claude-sonnet-test',
            effort: request?.effort ?? 'medium',
          }),
          getCodexCliPath: async () => null,
          getClaudeCliPath: async () => '/usr/local/bin/claude',
          getCodexPathEntries: async () => ['/claude/bin'],
          getCodexEnvironment: async () => ({ FORGER_CLAUDE_ENV: '1' }),
          getCodexAuthenticated: async () => false,
          getClaudeAuthenticated: async () => true,
          hasCodexConversation: async () => true,
          resolveAgents: async () => [],
          createForgerMcpSession: () => ({ url: 'http://127.0.0.1:6060/mcp', token: 'claude-token' }),
          releaseForgerMcpSession: (token) => releasedSessions.push(token),
          listenAppMcps: async () => [],
          releaseAppMcps: (runId) => releasedMcps.push(runId),
          onConversationEvent: (event) => events.push(event),
        });

        const started = await manager.sendMessage('finance-os', {
          conversationId: 'claude-thread',
          message: 'continue with Claude',
          provider: 'claude',
          model: 'claude-opus-test',
          effort: 'high',
        });
        const completed = await waitFor(
          () => events.find((event) => event.type === 'run.completed' && event.run.runId === started.activeRun.runId),
          'conversation_claude_completed',
        );

        assert.equal(completed.run.status, 'completed');
        assert.equal((await manager.get('finance-os', 'claude-thread')).messages.at(-1).text, 'Claude finished the review.');
        assert.equal(commandCalls.length, 1);
        assert.equal(commandCalls[0].command, '/usr/local/bin/claude');
        assert.equal(commandCalls[0].options.stdinText, undefined);
        assert.equal(commandCalls[0].options.env.CODEX_HOME, undefined);
        assert.equal(commandCalls[0].options.env.FORGER_MCP_TOKEN, 'claude-token');
        assert.equal(commandCalls[0].args.includes('--resume'), true);
        assert.equal(commandCalls[0].args.includes('claude-session-old'), true);
        assert.equal(commandCalls[0].args[1], 'continue with Claude');
        const mcpConfigIndex = commandCalls[0].args.indexOf('--mcp-config');
        assert.notEqual(mcpConfigIndex, -1);
        assert.equal(await readFile(commandCalls[0].args[mcpConfigIndex + 1], 'utf8').then(() => 'exists', () => 'removed'), 'removed');
        assert.deepEqual(releasedSessions, ['claude-token']);
        assert.deepEqual(releasedMcps, [started.activeRun.runId]);
      },
    );
  } finally {
    await roots.cleanup();
  }
});

test('conversation manager resolves workspace folder grants into provider cwd and shared roots', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-folder-grants-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    const grantedCwd = path.join(roots.root, 'external-cwd');
    const additionalRoot = path.join(roots.root, 'extra-folder');
    await mkdir(appRoot, { recursive: true });
    await mkdir(grantedCwd, { recursive: true });
    await mkdir(additionalRoot, { recursive: true });
    const realAppRoot = await realpath(appRoot);
    const realGrantedCwd = await realpath(grantedCwd);
    const realAdditionalRoot = await realpath(additionalRoot);
    const fakeCli = await createFakeAgentCli(roots.root);
    const events = [];
    const grants = {
      cwd: {
        grantId: 'cwd',
        path: grantedCwd,
        realPath: realGrantedCwd,
        name: 'external-cwd',
        access: 'readWrite',
        createdAt: '2026-05-17T00:00:00.000Z',
      },
      extra: {
        grantId: 'extra',
        path: additionalRoot,
        realPath: realAdditionalRoot,
        name: 'extra-folder',
        access: 'readWrite',
        createdAt: '2026-05-17T00:00:00.000Z',
      },
    };
    const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
    const manager = new AppAgentConversationManager({
      privateAppsRoot: roots.appsRoot,
      metadataRoot: roots.metadataRoot,
      codexHome: roots.codexHome,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => fakeCli,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [path.dirname(fakeCli)],
      getCodexEnvironment: async () => ({}),
      getAgentNetworkAccess: async () => false,
      getCodexAuthenticated: async () => true,
      getClaudeAuthenticated: async () => false,
      hasCodexConversation: async () => true,
      resolveAgents: async () => [{ id: 'advisor', title: 'Advisor', initialPrompt: 'Help.' }],
      resolveFolderGrant: async (_appId, grantId) => {
        if (!grants[grantId]) throw new Error('folder_grant_not_found');
        return grants[grantId];
      },
      onConversationEvent: (event) => events.push(event),
    });

    const conversation = await manager.create('finance-os', { agentId: 'advisor' });
    const withRun = await manager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: 'Use the granted workspace',
      workspace: {
        cwdGrantId: 'cwd',
        additionalFolderGrantIds: ['extra', 'extra'],
      },
    });
    await waitFor(
      () => events.find((event) => event.type === 'run.completed' && event.run.runId === withRun.activeRun.runId),
      'conversation_folder_grant_completed',
    );

    const [call] = await readAgentCalls(roots.root);
    assert.equal(call.cwd, realGrantedCwd);
    const allowedRoots = call.allowedRoots.split(path.delimiter);
    assert.deepEqual(new Set(allowedRoots), new Set([realGrantedCwd, realAppRoot, realAdditionalRoot]));
    assert.equal(call.args.includes('--add-dir'), true);
    assert.equal(call.args.includes(realAppRoot), true);
    assert.equal(call.args.includes(realAdditionalRoot), true);
  } finally {
    await roots.cleanup();
  }
});

test('conversation manager recovers a missing provider thread with a fresh codex run', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-recovery-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const storageRoot = path.join(roots.metadataRoot, 'app-codex-conversations');
    await mkdir(storageRoot, { recursive: true });
    await writeFile(path.join(storageRoot, 'finance-os.json'), JSON.stringify({
      conversations: [{
        conversationId: 'codex-thread',
        appId: 'finance-os',
        title: 'Codex thread',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [{ messageId: 'm1', role: 'assistant', text: 'Earlier answer', createdAt: 'a' }],
        threadId: 'missing-thread',
        metadata: { initialPromptApplied: true },
        runtime: { provider: 'codex', model: 'gpt-5.4', effort: 'medium' },
      }],
    }), 'utf8');
    const commandCalls = [];
    const releasedSessions = [];
    const releasedMcps = [];
    const events = [];

    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot,
            killProcessTree: () => undefined,
            resolveCodexCommand: async (cliPath, pathEntries) => ({ command: cliPath, prefixArgs: ['--profile', 'forger'], pathEntries }),
            runCommandCapture: async (command, args, options) => {
              commandCalls.push({ command, args, options });
              if (commandCalls.length === 1) {
                return {
                  code: 1,
                  stdout: '',
                  stderr: 'session not found: missing-thread',
                };
              }
              return {
                code: 0,
                stdout: [
                  '{"type":"thread.started","thread_id":"fresh-thread"}',
                  '{"type":"item.completed","item":{"type":"agent_message","text":"Recovered on a fresh thread."}}',
                ].join('\n'),
                stderr: '',
              };
            },
          };
        }
        if (request === './codex-run-isolation') {
          return {
            assertAllowedMcpServers: () => undefined,
            codexWorkspaceNetworkConfigArgs: () => [],
            preparePersistentIsolatedCodexHome: async (_sourceHome, targetHome) => targetHome,
          };
        }
        return null;
      },
      async () => {
        const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
        const manager = new AppAgentConversationManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
          getCodexCliPath: async () => '/usr/local/bin/codex',
          getClaudeCliPath: async () => null,
          getCodexPathEntries: async () => ['/runtime/bin'],
          getCodexEnvironment: async () => ({}),
          getCodexAuthenticated: async () => true,
          getClaudeAuthenticated: async () => false,
          hasCodexConversation: async () => true,
          resolveAgents: async () => [],
          createForgerMcpSession: () => ({
            url: 'http://127.0.0.1:5050/mcp',
            token: `session-token-${releasedSessions.length + 1}`,
          }),
          releaseForgerMcpSession: (token) => releasedSessions.push(token),
          releaseAppMcps: (runId) => releasedMcps.push(runId),
          onConversationEvent: (event) => events.push(event),
        });

        const started = await manager.sendMessage('finance-os', {
          conversationId: 'codex-thread',
          message: 'recover the thread',
        });
        const completed = await waitFor(
          () => events.find((event) => event.type === 'run.completed' && event.run.runId === started.activeRun.runId),
          'conversation_recovery_completed',
        );

        assert.equal(commandCalls.length, 2);
        assert.equal(commandCalls[0].args.includes('resume'), true);
        assert.equal(commandCalls[1].args.includes('resume'), false);
        assert.equal(completed.run.status, 'completed');
        assert.equal((await manager.get('finance-os', 'codex-thread')).messages.at(-1).text, 'Recovered on a fresh thread.');
        assert.equal(events.some((event) => event.type === 'run.progress' && /missing-thread/.test(event.run.progressLog.at(-1))), true);
        assert.deepEqual(releasedSessions, ['session-token-1', 'session-token-2']);
        assert.deepEqual(releasedMcps, [
          started.activeRun.runId,
          started.activeRun.runId,
          started.activeRun.runId,
        ]);
      },
    );
  } finally {
    await roots.cleanup();
  }
});

test('task manager executes a claude task through legacy attachments without codex isolation', async () => {
  const roots = await createTempDesktopRoots('forger-task-claude-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const commandCalls = [];
    const removedHomes = [];
    const events = [];

    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot,
            isPathInside: (targetPath, rootPath) => {
              const relative = path.relative(rootPath, targetPath);
              return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
            },
            killProcessTree: () => undefined,
            resolveCodexCommand: async () => {
              throw new Error('codex_should_not_be_used');
            },
            runCommandCapture: async (command, args, options) => {
              commandCalls.push({ command, args, options });
              options.onStderr('{"type":"assistant","text":"Claude is reading."}\n');
              return {
                code: 0,
                stdout: '{"session_id":"task-session","message":{"content":[{"text":"Claude summarized the attachment."}]}}\n',
                stderr: '',
              };
            },
          };
        }
        if (request === './codex-run-isolation') {
          return {
            assertAllowedMcpServers: () => undefined,
            codexWorkspaceNetworkConfigArgs: () => [],
            createIsolatedCodexHome: async () => {
              throw new Error('codex_home_should_not_be_created');
            },
            removeIsolatedCodexHome: async (targetPath) => removedHomes.push(targetPath),
          };
        }
        return null;
      },
      async () => {
        const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
        const manager = new AppAgentTaskManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async () => ({ provider: 'claude', model: 'claude-task-test', effort: 'high' }),
          getCodexCliPath: async () => null,
          getClaudeCliPath: async () => '/usr/local/bin/claude',
          getCodexPathEntries: async () => ['/claude/bin'],
          getCodexEnvironment: async () => ({ FORGER_TASK_ENV: 'claude' }),
          getCodexAuthenticated: async () => false,
          getClaudeAuthenticated: async () => true,
          resolvePromptTemplates: async () => [{
            id: 'legacy',
            title: 'Legacy',
            prompt: 'Summarize {{filename}} for {{account}}',
            acceptedFileTypes: ['.txt'],
          }],
          onTaskUpdated: (event) => events.push(event),
        });

        const task = await manager.start('finance-os', {
          templateId: 'legacy',
          locale: 'en-US',
          variables: { account: 'Checking' },
          attachments: [{
            name: 'notes.txt',
            mimeType: 'text/plain',
            dataBase64: Buffer.from('hello').toString('base64'),
          }],
        });
        const completed = await waitFor(
          () => events.find((event) => event.task.runId === task.runId && event.task.status === 'completed'),
          'task_claude_completed',
        );

        assert.equal(completed.task.resultText, 'Claude summarized the attachment.');
        assert.equal(commandCalls.length, 1);
        assert.equal(commandCalls[0].command, '/usr/local/bin/claude');
        assert.equal(commandCalls[0].options.stdinText, undefined);
        assert.equal(commandCalls[0].options.env.CODEX_HOME, undefined);
        const mcpConfigIndex = commandCalls[0].args.indexOf('--mcp-config');
        assert.notEqual(mcpConfigIndex, -1);
        assert.equal(await readFile(commandCalls[0].args[mcpConfigIndex + 1], 'utf8').then(() => 'exists', () => 'removed'), 'removed');
        assert.match(commandCalls[0].args[1], /notes\.txt/);
        assert.deepEqual(removedHomes, []);
      },
    );
  } finally {
    await roots.cleanup();
  }
});

test('task manager retries stale codex thread errors with a clean temporary home', async () => {
  const roots = await createTempDesktopRoots('forger-task-stale-thread-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const commandCalls = [];
    const createdHomes = [];
    const removedHomes = [];
    const events = [];

    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot,
            isPathInside: (targetPath, rootPath) => {
              const relative = path.relative(rootPath, targetPath);
              return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
            },
            killProcessTree: () => undefined,
            resolveCodexCommand: async (cliPath, pathEntries) => ({ command: cliPath, prefixArgs: [], pathEntries }),
            runCommandCapture: async (command, args, options) => {
              commandCalls.push({ command, args, options });
              if (commandCalls.length === 1) {
                return {
                  code: 1,
                  stdout: '',
                  stderr: 'failed to record rollout items: thread stale-thread not found',
                };
              }
              return {
                code: 0,
                stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Retried with a clean home."}}\n',
                stderr: '',
              };
            },
          };
        }
        if (request === './codex-run-isolation') {
          return {
            assertAllowedMcpServers: () => undefined,
            codexWorkspaceNetworkConfigArgs: () => [],
            createIsolatedCodexHome: async (_codexHome, options) => {
              const home = path.join(roots.root, `${options.prefix}-${createdHomes.length + 1}`);
              createdHomes.push(home);
              return home;
            },
            removeIsolatedCodexHome: async (targetPath) => removedHomes.push(targetPath),
          };
        }
        return null;
      },
      async () => {
        const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
        const manager = new AppAgentTaskManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-task', effort: 'medium' }),
          getCodexCliPath: async () => '/usr/local/bin/codex',
          getClaudeCliPath: async () => null,
          getCodexPathEntries: async () => ['/runtime/bin'],
          getCodexEnvironment: async () => ({}),
          getCodexAuthenticated: async () => true,
          getClaudeAuthenticated: async () => false,
          resolvePromptTemplates: async () => [{
            id: 'review',
            title: 'Review',
            prompt: 'Review {{topic}}',
            arguments: [{ name: 'topic', type: 'string', required: true }],
          }],
          onTaskUpdated: (event) => events.push(event),
        });

        const task = await manager.start('finance-os', {
          templateId: 'review',
          locale: 'en-US',
          arguments: { topic: 'cash flow' },
        });
        const completed = await waitFor(
          () => events.find((event) => event.task.runId === task.runId && event.task.status === 'completed'),
          'task_stale_retry_completed',
        );

        assert.equal(completed.task.resultText, 'Retried with a clean home.');
        assert.equal(commandCalls.length, 2);
        assert.equal(completed.task.progressLog.some((entry) => /technical limitation/i.test(entry)), true);
        assert.deepEqual(removedHomes, createdHomes);
        const transcript = await readFile(
          path.join(roots.metadataRoot, 'app-codex-runs', 'finance-os', task.runId, 'transcript.log'),
          'utf8',
        );
        assert.match(transcript, /Retrying Codex task with a clean temporary Codex home/);
      },
    );
  } finally {
    await roots.cleanup();
  }
});

test('app MCP manager covers invalid manifests, command validation, stream logging, and in-flight release', async () => {
  const roots = await createTempDesktopRoots('forger-mcp-manager-edges-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance.os!', 'backend'), { recursive: true });
    await mkdir(path.join(roots.appsRoot, 'recipes', 'backend'), { recursive: true });
    const children = [];
    const logs = [];
    const terminations = [];
    const startFailures = [];
    let manifest = null;
    let waitForHealth = async () => undefined;
    const childProcessMock = {
      spawn(command, args, options) {
        const child = createFakeChildProcess();
        children.push({ child, command, args, options });
        return child;
      },
    };

    await withMockedModuleLoad(
      (request) => request === 'node:child_process' ? childProcessMock : null,
      async () => {
        const { AppMcpManager, findManifestMcp } = distRequire('main/app-mcp-manager.js');
        assert.equal(findManifestMcp(null), null);
        assert.equal(findManifestMcp({ mcp: 'invalid' }), null);
        assert.equal(findManifestMcp({ mcp: { type: 'stdio', command: 'python -m app.mcp' } }), null);
        assert.equal(findManifestMcp({ mcp: { type: 'http' } }), null);

        const manager = new AppMcpManager({
          getInstalledApp: (appId) => appId === 'finance.os!' || appId === 'recipes'
            ? { appId, installDir: path.join(roots.appsRoot, appId), requiredPythonVersion: '3.12' }
            : null,
          resolveInstalledManifest: async () => manifest,
          ensureRuntimeInstalled: async () => ({ rootDir: path.join(roots.root, 'runtime'), python: '/runtime/python' }),
          ensureBackendPythonEnvironment: async () => undefined,
          getVenvExecutables: (backendDir) => ({ python: path.join(backendDir, '.venv', 'bin', 'python'), pip: 'pip' }),
          getFreePort: async () => 45678,
          splitManifestCommand: (command) => (command ?? '').split(/\s+/).filter(Boolean),
          ensurePathInside: (rootPath, targetPath) => {
            const relative = path.relative(rootPath, targetPath);
            return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
          },
          translateManifestEnvironment: (environment) => ({ ...environment }),
          ensureSqliteDatabaseParent: async () => undefined,
          getRuntimePathEntries: () => [],
          waitForHttpOk: async (url, timeoutMs) => await waitForHealth(url, timeoutMs),
          terminateProcess: async (child) => {
            terminations.push(child);
          },
          appendInstallLog: async (event, payload) => {
            logs.push({ event, payload });
          },
          truncateForInstallLog: (value) => value.slice(0, 12),
          serializeErrorForInstallLog: (error) => ({ message: error.message }),
          onMcpStartFailed: (input) => startFailures.push(input),
        });

        manager.releaseMcps('missing-run');
        manifest = { mcp: { command: '   ' } };
        assert.deepEqual(await manager.listenMcps(['finance.os!'], 'run-empty-command'), []);
        manifest = { mcp: { command: 'python -m app.mcp', context: '../outside' } };
        assert.deepEqual(await manager.listenMcps(['finance.os!'], 'run-outside-context'), []);
        assert.equal(startFailures.length, 2);

        manifest = {
          mcp: {
            command: 'node server.js',
            context: 'backend',
            healthcheck: 'status',
            environment: { PYTHONPATH: 'src:lib' },
            toolTimeoutSec: 0,
          },
        };
        const config = (await manager.listenMcps(['finance.os!'], 'run-streams'))[0];
        assert.equal(config.name, 'app_finance_os_');
        assert.equal(config.tokenEnvVar, 'FORGER_APP_MCP_TOKEN_FINANCE_OS_');
        assert.equal(config.toolTimeoutSec, 1);
        assert.equal(children.at(-1).command, 'node');
        assert.deepEqual(children.at(-1).args, ['server.js']);
        assert.equal(children.at(-1).options.env.PYTHONPATH, [
          path.join(roots.appsRoot, 'finance.os!', 'backend', 'src'),
          path.join(roots.appsRoot, 'finance.os!', 'backend', 'lib'),
        ].join(path.delimiter));
        assert.equal(logs.some((entry) => entry.event === 'app_mcp:start' && entry.payload.healthUrl.endsWith('/status')), true);
        children.at(-1).child.stdout.emit('data', Buffer.from('stdout from server'));
        children.at(-1).child.stderr.emit('data', Buffer.from('stderr from server'));
        children.at(-1).child.emit('exit', 7, null);
        await waitFor(() => logs.some((entry) => entry.event === 'app_mcp:exit'), 'mcp_exit_log');
        assert.equal(logs.some((entry) => entry.event === 'app_mcp:stdout' && entry.payload.text === 'stdout from '), true);
        assert.equal(logs.some((entry) => entry.event === 'app_mcp:stderr' && entry.payload.text === 'stderr from '), true);
        manager.releaseMcps('run-streams');

        let resolveHealth;
        waitForHealth = async () => await new Promise((resolve) => {
          resolveHealth = resolve;
        });
        const pending = manager.listenMcps(['recipes'], 'run-pending');
        await waitFor(() => children.length >= 2, 'mcp_pending_child');
        const sharedPending = manager.listenMcps(['recipes'], 'run-pending-2');
        await sleep(5);
        manager.releaseMcps('run-pending');
        manager.releaseMcps('run-pending-2');
        resolveHealth();
        assert.deepEqual(await pending, []);
        assert.deepEqual(await sharedPending, []);
        assert.equal(terminations.includes(children.at(-1).child), true);
        manager.dispose();
      },
    );
  } finally {
    await roots.cleanup();
  }
});

test('app MCP manager handles stale listeners, stop timers, shutdown reuse, and spawned start failures', async () => {
  const roots = await createTempDesktopRoots('forger-mcp-manager-state-edges-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os', 'backend'), { recursive: true });
    const children = [];
    const terminations = [];
    const startFailures = [];
    const logs = [];
    const childProcessMock = {
      spawn(command, args, options) {
        const child = createFakeChildProcess();
        children.push({ child, command, args, options });
        return child;
      },
    };

    await withMockedModuleLoad(
      (request) => request === 'node:child_process' ? childProcessMock : null,
      async () => {
        const { AppMcpManager } = distRequire('main/app-mcp-manager.js');
        const manager = new AppMcpManager({
          getInstalledApp: (appId) => appId === 'finance-os' || appId === 'no-mcp'
            ? { appId, installDir: path.join(roots.appsRoot, appId), requiredPythonVersion: '3.12' }
            : null,
          resolveInstalledManifest: async (installDir) => installDir.endsWith('no-mcp')
            ? null
            : { mcp: { command: 'python -m app.mcp', healthcheck: '/ready' } },
          ensureRuntimeInstalled: async () => ({ rootDir: path.join(roots.root, 'runtime'), python: '/runtime/python' }),
          ensureBackendPythonEnvironment: async () => undefined,
          getVenvExecutables: (backendDir) => ({ python: path.join(backendDir, '.venv', 'bin', 'python'), pip: 'pip' }),
          getFreePort: async () => 51234,
          splitManifestCommand: (command) => (command ?? '').split(/\s+/).filter(Boolean),
          ensurePathInside: () => true,
          translateManifestEnvironment: (environment) => ({ ...environment }),
          ensureSqliteDatabaseParent: async () => undefined,
          getRuntimePathEntries: () => [],
          waitForHttpOk: async () => {
            throw new Error('health timeout');
          },
          terminateProcess: async (child) => {
            terminations.push(child);
          },
          appendInstallLog: async (event, payload) => {
            logs.push({ event, payload });
          },
          truncateForInstallLog: (value) => value,
          serializeErrorForInstallLog: (error) => ({ message: error.message }),
          onMcpStartFailed: (input) => startFailures.push(input),
        });

        assert.deepEqual(await manager.listenMcps(['no-mcp'], 'run-no-mcp'), []);
        manager.runListeners.set('stale-run', new Set(['ghost-app']));
        manager.releaseMcps('stale-run');
        assert.equal(manager.runListeners.has('stale-run'), false);

        const downState = { appId: 'down-app', status: 'down', listeners: new Set(), generation: 0 };
        manager.scheduleStop(downState);
        assert.equal(downState.stopTimer, undefined);

        const state = manager.getState('finance-os');
        state.status = 'up';
        state.url = 'http://127.0.0.1:1234/mcp';
        state.token = 'existing-token';
        state.tokenEnvVar = 'FORGER_APP_MCP_TOKEN_FINANCE_OS';
        state.toolTimeoutSec = 99;
        state.stopTimer = setTimeout(() => {}, 10_000);
        const reused = await manager.listenMcps(['finance-os'], 'run-reuse');
        assert.equal(reused[0].token, 'existing-token');
        assert.equal(state.stopTimer, undefined);

        state.status = 'shutting_down';
        state.stopPromise = Promise.resolve().then(() => {
          state.status = 'up';
          state.url = 'http://127.0.0.1:1235/mcp';
          state.token = 'after-stop-token';
          state.tokenEnvVar = 'FORGER_APP_MCP_TOKEN_FINANCE_OS';
        });
        const afterShutdown = await manager.listenMcps(['finance-os'], 'run-after-shutdown');
        assert.equal(afterShutdown[0].token, 'after-stop-token');

        state.status = 'down';
        state.process = undefined;
        state.url = undefined;
        state.token = undefined;
        state.tokenEnvVar = undefined;
        assert.deepEqual(await manager.listenMcps(['finance-os'], 'run-health-fail'), []);
        assert.equal(children.length, 1);
        assert.deepEqual(terminations, [children[0].child]);
        assert.equal(startFailures.length, 1);
        assert.equal(logs.some((entry) => entry.event === 'app_mcp:start_failed'), true);

        manager.releaseMcps('run-health-fail');
        logs.length = 0;
        startFailures.length = 0;
        terminations.length = 0;
        let rejectHealth;
        manager.options.waitForHttpOk = async () => await new Promise((_, reject) => {
          rejectHealth = reject;
        });
        const spawnFailure = manager.listenMcps(['finance-os'], 'run-spawn-fail');
        await waitFor(() => children.length === 2, 'spawn_failure_child');
        const spawnError = Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' });
        children[1].child.emit('error', spawnError);
        assert.deepEqual(await spawnFailure, []);
        assert.equal(startFailures.length, 1);
        assert.equal(startFailures[0].error, spawnError);
        assert.equal(logs.some((entry) => entry.event === 'app_mcp:start_failed' && entry.payload.error.message === 'spawn uv ENOENT'), true);
        assert.deepEqual(terminations, []);
        rejectHealth(new Error('should not leak'));
        manager.dispose();
      },
    );
  } finally {
    await roots.cleanup();
  }
});

test('app MCP manager reuses an up server after an in-flight shutdown completes', async () => {
  const roots = await createTempDesktopRoots('forger-mcp-manager-shutdown-reuse-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const { AppMcpManager } = distRequire('main/app-mcp-manager.js');
    const manager = new AppMcpManager({
      getInstalledApp: () => ({ appId: 'finance-os', installDir: appRoot }),
      resolveInstalledManifest: async () => ({ mcp: { type: 'http', command: 'python -m app.mcp' } }),
      ensureRuntimeInstalled: async () => ({ python: process.execPath }),
      ensureBackendPythonEnvironment: async () => undefined,
      getVenvExecutables: () => ({ python: process.execPath }),
      getFreePort: async () => 5678,
      ensureSqliteDatabaseParent: async () => undefined,
      appendInstallLog: async () => undefined,
      truncateForInstallLog: (value) => value,
      serializeErrorForInstallLog: (error) => ({ message: String(error) }),
      waitForHealth: async () => undefined,
      terminateProcess: async () => undefined,
    });
    const state = manager.getState('finance-os');
    state.status = 'shutting_down';
    state.url = 'http://127.0.0.1:5678';
    state.token = 'token';
    state.tokenEnvVar = 'FINANCE_TOKEN';
    state.stopPromise = {
      catch: async () => {
        state.status = 'up';
      },
    };

    const config = await manager.listenOne('finance-os', 'run-1');
    assert.deepEqual(config, {
      name: 'app_finance-os',
      url: 'http://127.0.0.1:5678',
	      token: 'token',
	      tokenEnvVar: 'FINANCE_TOKEN',
	      toolTimeoutSec: undefined,
	    });
  } finally {
    await roots.cleanup();
  }
});

test('app MCP manager returns an existing up server without restarting it', async () => {
  const roots = await createTempDesktopRoots('forger-mcp-manager-up-reuse-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const { AppMcpManager } = distRequire('main/app-mcp-manager.js');
    const manager = new AppMcpManager({
      getInstalledApp: () => ({ appId: 'finance-os', installDir: appRoot }),
      resolveInstalledManifest: async () => ({ mcp: { type: 'http', command: 'python -m app.mcp' } }),
      ensureRuntimeInstalled: async () => {
        throw new Error('runtime_should_not_start');
      },
      ensureBackendPythonEnvironment: async () => undefined,
      getVenvExecutables: () => ({ python: process.execPath }),
      getFreePort: async () => 5678,
      ensureSqliteDatabaseParent: async () => undefined,
      appendInstallLog: async () => undefined,
      truncateForInstallLog: (value) => value,
      serializeErrorForInstallLog: (error) => ({ message: String(error) }),
      waitForHealth: async () => undefined,
      terminateProcess: async () => undefined,
    });
    const state = manager.getState('finance-os');
    state.status = 'up';
    state.url = 'http://127.0.0.1:5678';
    state.token = 'token';
    state.tokenEnvVar = 'FINANCE_TOKEN';

    assert.deepEqual(await manager.listenOne('finance-os', 'run-1'), {
      name: 'app_finance-os',
      url: 'http://127.0.0.1:5678',
      token: 'token',
      tokenEnvVar: 'FINANCE_TOKEN',
      toolTimeoutSec: undefined,
    });
  } finally {
    await roots.cleanup();
  }
});

test('conversation manager reports app, auth, and CLI preflight failures', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-preflight-');
  try {
    await mkdir(path.join(roots.appsRoot, 'finance-os'), { recursive: true });

    const startAndFail = async ({
      appId = 'finance-os',
      runtime,
      codexAuthenticated = true,
      claudeAuthenticated = true,
      codexCliPath = process.execPath,
      claudeCliPath = process.execPath,
    }) => {
      const events = [];
      const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
      const manager = new AppAgentConversationManager({
        privateAppsRoot: roots.appsRoot,
        metadataRoot: roots.metadataRoot,
        codexHome: roots.codexHome,
        getAgentRuntime: async () => runtime,
        getCodexCliPath: async () => codexCliPath,
        getClaudeCliPath: async () => claudeCliPath,
        getCodexPathEntries: async () => [],
        getCodexEnvironment: async () => ({}),
        getCodexAuthenticated: async () => codexAuthenticated,
        getClaudeAuthenticated: async () => claudeAuthenticated,
        hasCodexConversation: async () => true,
        resolveAgents: async () => [],
        onConversationEvent: (event) => events.push(event),
      });
      const conversation = await manager.create(appId, { title: 'Preflight' });
      const started = await manager.sendMessage(appId, {
        conversationId: conversation.conversationId,
        message: 'run preflight',
      });
      return await waitFor(
        () => events.find((event) => event.type === 'run.failed' && event.run.runId === started.activeRun.runId),
        `conversation_preflight_${appId}_${runtime.provider}`,
      );
    };

    assert.equal((await startAndFail({
      appId: 'missing-app',
      runtime: { provider: 'codex', model: 'gpt-test', effort: 'medium' },
    })).run.error, 'app_not_installed');
    assert.equal((await startAndFail({
      runtime: { provider: 'codex', model: 'gpt-test', effort: 'medium' },
      codexAuthenticated: false,
    })).run.error, 'codex_auth_missing');
    assert.equal((await startAndFail({
      runtime: { provider: 'codex', model: 'gpt-test', effort: 'medium' },
      codexCliPath: null,
    })).run.error, 'codex_cli_missing');
    assert.equal((await startAndFail({
      runtime: { provider: 'claude', model: 'claude-test', effort: 'medium' },
      claudeAuthenticated: false,
    })).run.error, 'claude_auth_missing');
    assert.equal((await startAndFail({
      runtime: { provider: 'claude', model: 'claude-test', effort: 'medium' },
      claudeCliPath: null,
    })).run.error, 'claude_cli_missing');
  } finally {
    await roots.cleanup();
  }
});

test('conversation manager treats a canceled provider result as canceled and cleans sessions', async () => {
  const roots = await createTempDesktopRoots('forger-conversation-canceled-result-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const events = [];
    const releasedSessions = [];
    const releasedMcps = [];
    let finishCommand;

    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot,
            killProcessTree: (child) => child?.kill?.('SIGKILL'),
            resolveCodexCommand: async (cliPath, pathEntries) => ({ command: cliPath, prefixArgs: [], pathEntries }),
            runCommandCapture: async (_command, _args, options) => {
              options.onChild({ killed: false, kill: () => undefined });
              options.onStderr(JSON.stringify({ type: 'turn.started' }));
              await new Promise((resolve) => {
                finishCommand = resolve;
              });
              return {
                code: 0,
                stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"This should not be appended."}}\n',
                stderr: '',
              };
            },
          };
        }
        if (request === './codex-run-isolation') {
          return {
            assertAllowedMcpServers: () => undefined,
            codexWorkspaceNetworkConfigArgs: () => [],
            preparePersistentIsolatedCodexHome: async (_sourceHome, targetHome) => targetHome,
          };
        }
        return null;
      },
      async () => {
        const { AppAgentConversationManager } = distRequire('main/app-agent-conversation-manager.js');
        const manager = new AppAgentConversationManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
          getCodexCliPath: async () => '/usr/local/bin/codex',
          getClaudeCliPath: async () => null,
          getCodexPathEntries: async () => [],
          getCodexEnvironment: async () => ({}),
          getCodexAuthenticated: async () => true,
          getClaudeAuthenticated: async () => false,
          hasCodexConversation: async () => true,
          resolveAgents: async () => [],
          createForgerMcpSession: () => ({ url: 'http://127.0.0.1:4040/mcp', token: 'session-token' }),
          releaseForgerMcpSession: (token) => releasedSessions.push(token),
          listenAppMcps: async () => [],
          releaseAppMcps: (runId) => releasedMcps.push(runId),
          onConversationEvent: (event) => events.push(event),
        });

        const conversation = await manager.create('finance-os', { title: 'Canceled result' });
        const started = await manager.sendMessage('finance-os', {
          conversationId: conversation.conversationId,
          message: 'start and cancel',
        });
        await waitFor(
          () => events.find((event) => event.type === 'run.progress' && event.run.runId === started.activeRun.runId),
          'conversation_cancel_provider_progress',
        );
        assert.deepEqual(await manager.cancel('finance-os', conversation.conversationId, started.activeRun.runId), { success: true });
        finishCommand();
        await sleep(25);
        const stored = await manager.get('finance-os', conversation.conversationId);
        assert.equal(stored.activeRun.status, 'canceled');
        assert.equal(stored.messages.some((message) => message.text === 'This should not be appended.'), false);
        assert.deepEqual(releasedSessions, ['session-token']);
        assert.deepEqual(releasedMcps, [started.activeRun.runId]);
      },
    );
  } finally {
    await roots.cleanup();
  }
});

test('task manager reports auth, CLI, required argument, and cancellation edge outcomes', async () => {
  const roots = await createTempDesktopRoots('forger-task-preflight-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const templates = [{
      id: 'review',
      title: 'Review',
      prompt: 'Review {{topic}} {{statement}}',
      arguments: [
        { name: 'topic', type: 'string', required: true },
        { name: 'statement', type: 'file', required: true, multiple: true, acceptedFileTypes: ['.csv'] },
      ],
    }];

    const startAndFail = async ({
      runtime,
      codexAuthenticated = true,
      claudeAuthenticated = true,
      codexCliPath = process.execPath,
      claudeCliPath = process.execPath,
      input = { templateId: 'review', arguments: { topic: 'cash flow', statement: [] } },
    }) => {
      const events = [];
      const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
      const manager = new AppAgentTaskManager({
        privateAppsRoot: roots.appsRoot,
        metadataRoot: roots.metadataRoot,
        codexHome: roots.codexHome,
        getAgentRuntime: async () => runtime,
        getCodexCliPath: async () => codexCliPath,
        getClaudeCliPath: async () => claudeCliPath,
        getCodexPathEntries: async () => [],
        getCodexEnvironment: async () => ({}),
        getCodexAuthenticated: async () => codexAuthenticated,
        getClaudeAuthenticated: async () => claudeAuthenticated,
        resolvePromptTemplates: async () => templates,
        onTaskUpdated: (event) => events.push(event),
      });
      const task = await manager.start('finance-os', input);
      return await waitFor(
        () => events.find((event) => event.task.runId === task.runId && event.task.status === 'failed'),
        `task_preflight_${runtime.provider}`,
      );
    };

    assert.equal((await startAndFail({
      runtime: { provider: 'codex', model: 'gpt-test', effort: 'medium' },
      codexAuthenticated: false,
    })).task.error, 'codex_auth_missing');
    assert.equal((await startAndFail({
      runtime: { provider: 'codex', model: 'gpt-test', effort: 'medium' },
      codexCliPath: null,
    })).task.error, 'codex_cli_missing');
    assert.equal((await startAndFail({
      runtime: { provider: 'claude', model: 'claude-test', effort: 'medium' },
      claudeAuthenticated: false,
    })).task.error, 'claude_auth_missing');
    assert.equal((await startAndFail({
      runtime: { provider: 'claude', model: 'claude-test', effort: 'medium' },
      claudeCliPath: null,
    })).task.error, 'claude_cli_missing');
    assert.equal((await startAndFail({
      runtime: { provider: 'codex', model: 'gpt-test', effort: 'medium' },
      input: { templateId: 'review', arguments: { statement: [] } },
    })).task.error, 'app_prompt_argument_required:topic');
    assert.equal((await startAndFail({
      runtime: { provider: 'codex', model: 'gpt-test', effort: 'medium' },
      input: { templateId: 'review', arguments: { topic: 'cash flow', statement: [] } },
    })).task.error, 'app_prompt_argument_required:statement');

    const events = [];
    let finishCommand;
    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot,
            isPathInside: (targetPath, rootPath) => {
              const relative = path.relative(rootPath, targetPath);
              return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
            },
            killProcessTree: (child) => child?.kill?.('SIGKILL'),
            resolveCodexCommand: async (cliPath, pathEntries) => ({ command: cliPath, prefixArgs: [], pathEntries }),
            runCommandCapture: async (_command, _args, options) => {
              options.onChild({ killed: false, kill: () => undefined });
              await new Promise((resolve) => {
                finishCommand = resolve;
              });
              return {
                code: 0,
                stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"This canceled result should not persist."}}\n',
                stderr: '',
              };
            },
          };
        }
        if (request === './codex-run-isolation') {
          return {
            assertAllowedMcpServers: () => undefined,
            codexWorkspaceNetworkConfigArgs: () => [],
            createIsolatedCodexHome: async (_codexHome, options) => path.join(roots.root, options.prefix),
            removeIsolatedCodexHome: async () => undefined,
          };
        }
        return null;
      },
      async () => {
        const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
        const manager = new AppAgentTaskManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
          getCodexCliPath: async () => '/usr/local/bin/codex',
          getClaudeCliPath: async () => null,
          getCodexPathEntries: async () => [],
          getCodexEnvironment: async () => ({}),
          getCodexAuthenticated: async () => true,
          getClaudeAuthenticated: async () => false,
          resolvePromptTemplates: async () => [{
            id: 'review',
            title: 'Review',
            prompt: 'Review {{topic}}',
            arguments: [{ name: 'topic', type: 'string', required: true }],
          }],
          onTaskUpdated: (event) => events.push(event),
        });

        const task = await manager.start('finance-os', {
          templateId: 'review',
          arguments: { topic: 'cash flow' },
        });
        await waitFor(
          () => finishCommand,
          'task_cancel_command_started',
        );
        assert.deepEqual(manager.cancel('finance-os', task.runId), { success: true });
        finishCommand();
        await sleep(25);
        assert.equal(manager.get('finance-os', task.runId).status, 'canceled');
        assert.equal(manager.get('finance-os', task.runId).resultText, undefined);
      },
    );
  } finally {
    await roots.cleanup();
  }
});

test('task manager accepts a recovered Codex stale-thread answer without retrying', async () => {
  const roots = await createTempDesktopRoots('forger-task-stale-recovered-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });
    const commandCalls = [];
    const events = [];

    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot,
            isPathInside: (targetPath, rootPath) => {
              const relative = path.relative(rootPath, targetPath);
              return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
            },
            killProcessTree: () => undefined,
            resolveCodexCommand: async (cliPath, pathEntries) => ({ command: cliPath, prefixArgs: [], pathEntries }),
            runCommandCapture: async (command, args, options) => {
              commandCalls.push({ command, args, options });
              options.onChild({ killed: false, kill: () => undefined });
              return {
                code: 1,
                stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Recovered answer from the stale thread response."}}\n',
                stderr: 'failed to record rollout items: thread stale-thread not found',
              };
            },
          };
        }
        if (request === './codex-run-isolation') {
          return {
            assertAllowedMcpServers: () => undefined,
            codexWorkspaceNetworkConfigArgs: () => [],
            createIsolatedCodexHome: async (_codexHome, options) => path.join(roots.root, options.prefix),
            removeIsolatedCodexHome: async () => undefined,
          };
        }
        return null;
      },
      async () => {
        const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
        const manager = new AppAgentTaskManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
          getCodexCliPath: async () => '/usr/local/bin/codex',
          getClaudeCliPath: async () => null,
          getCodexPathEntries: async () => [],
          getCodexEnvironment: async () => ({}),
          getCodexAuthenticated: async () => true,
          getClaudeAuthenticated: async () => false,
          resolvePromptTemplates: async () => [{
            id: 'review',
            title: 'Review',
            prompt: 'Review {{topic}}',
            arguments: [{ name: 'topic', type: 'string', required: true }],
          }],
          onTaskUpdated: (event) => events.push(event),
        });

        const task = await manager.start('finance-os', {
          templateId: 'review',
          arguments: { topic: 'cash flow' },
        });
        const completed = await waitFor(
          () => events.find((event) => event.task.runId === task.runId && event.task.status === 'completed'),
          'task_stale_recovered_completed',
        );
        assert.equal(completed.task.resultText, 'Recovered answer from the stale thread response.');
        assert.equal(commandCalls.length, 1);
      },
    );
  } finally {
    await roots.cleanup();
  }
});

test('task manager rejects generated input paths that fail task-directory containment checks', async () => {
  const roots = await createTempDesktopRoots('forger-task-input-containment-');
  try {
    const appRoot = path.join(roots.appsRoot, 'finance-os');
    await mkdir(appRoot, { recursive: true });

    await withMockedModuleLoad(
      (request) => {
        if (request === './app-agent/process') {
          return {
            existsDirectory: async (targetPath) => targetPath === appRoot,
            isPathInside: (targetPath) => !targetPath.endsWith('notes.txt') && !targetPath.endsWith('statement.txt'),
            killProcessTree: () => undefined,
            resolveCodexCommand: async (cliPath, pathEntries) => ({ command: cliPath, prefixArgs: [], pathEntries }),
            runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
          };
        }
        return null;
      },
      async () => {
        const { AppAgentTaskManager } = distRequire('main/app-agent-task-manager.js');
        const createManager = (templates) => new AppAgentTaskManager({
          privateAppsRoot: roots.appsRoot,
          metadataRoot: roots.metadataRoot,
          codexHome: roots.codexHome,
          getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
          getCodexCliPath: async () => process.execPath,
          getClaudeCliPath: async () => null,
          getCodexPathEntries: async () => [],
          getCodexEnvironment: async () => ({}),
          getCodexAuthenticated: async () => true,
          getClaudeAuthenticated: async () => false,
          resolvePromptTemplates: async () => templates,
          onTaskUpdated: () => undefined,
        });

        const legacyEvents = [];
        const legacyManager = createManager([{
          id: 'legacy',
          title: 'Legacy',
          prompt: 'Use attachment',
          acceptedFileTypes: ['.txt'],
        }]);
        legacyManager.options.onTaskUpdated = (event) => legacyEvents.push(event);
        const legacyTask = await legacyManager.start('finance-os', {
          templateId: 'legacy',
          attachments: [{ name: 'notes.txt', mimeType: 'text/plain', dataBase64: Buffer.from('notes').toString('base64') }],
        });
        const legacyFailure = await waitFor(
          () => legacyEvents.find((event) => event.task.runId === legacyTask.runId && event.task.status === 'failed'),
          'legacy_path_outside_failure',
        );
        assert.equal(legacyFailure.task.error, 'attachment_path_outside_task_inputs');

        const argumentEvents = [];
        const argumentManager = createManager([{
          id: 'argument',
          title: 'Argument',
          prompt: 'Use {{statement}}',
          arguments: [{ name: 'statement', type: 'file', required: true, acceptedFileTypes: ['.txt'] }],
        }]);
        argumentManager.options.onTaskUpdated = (event) => argumentEvents.push(event);
        const argumentTask = await argumentManager.start('finance-os', {
          templateId: 'argument',
          arguments: {
            statement: { type: 'file', name: 'statement.txt', mimeType: 'text/plain', dataBase64: Buffer.from('statement').toString('base64') },
          },
        });
        const argumentFailure = await waitFor(
          () => argumentEvents.find((event) => event.task.runId === argumentTask.runId && event.task.status === 'failed'),
          'argument_path_outside_failure',
        );
        assert.equal(argumentFailure.task.error, 'attachment_path_outside_task_inputs');
      },
    );
  } finally {
    await roots.cleanup();
  }
});
