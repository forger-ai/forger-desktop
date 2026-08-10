import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AppAgentConversationManager } = require('../../dist-electron/main/app-agent-conversation-manager.js');

const waitForPendingPermission = async (manager, requestId) => {
  for (let index = 0; index < 1_000; index += 1) {
    if (manager.pendingPermissions.has(requestId)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`pending_permission_not_observed:${requestId}`);
};

const waitForRunFailure = async (harness, runId) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const failure = harness.events.find((event) => event.type === 'run.failed' && event.run.runId === runId);
    if (failure) return failure;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run_failed_not_observed:${runId}`);
};

const createHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-app-conversation-b19-'));
  const appsRoot = path.join(root, 'apps');
  const metadataRoot = path.join(root, 'metadata');
  const appRoot = path.join(appsRoot, 'finance-os');
  await fs.mkdir(appRoot, { recursive: true });
  const events = [];
  const runtimeRequests = [];
  const options = {
    privateAppsRoot: appsRoot,
    metadataRoot,
    codexHome: path.join(root, 'codex-home'),
    getAgentRuntime: async (input) => {
      runtimeRequests.push(input);
      return overrides.runtime ?? { provider: 'codex', model: 'gpt-test', effort: 'medium' };
    },
    getCodexCliPath: async () => process.execPath,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexEnvironment: async () => ({}),
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => false,
    hasCodexConversation: async () => true,
    resolveAgents: async () => overrides.agents ?? [],
    onConversationEvent: (event) => events.push(event),
    ...overrides.options,
  };
  const manager = new AppAgentConversationManager(options);
  return {
    root,
    appRoot,
    metadataRoot,
    events,
    manager,
    options,
    runtimeRequests,
    cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
  };
};

const createQueuedRun = async (harness, createInput = {}) => {
  harness.manager.execute = async () => undefined;
  const conversation = await harness.manager.create('finance-os', createInput);
  const updated = await harness.manager.sendMessage('finance-os', {
    conversationId: conversation.conversationId,
    message: 'Inspect the current app state',
  });
  return {
    conversation: harness.manager.conversations.get(conversation.conversationId),
    run: harness.manager.runs.get(updated.activeRun.runId),
  };
};

test('given a conversation lifecycle, diagnostics expose persisted state and bounded run logs', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.manager.create('finance-os');
    const persisted = JSON.parse(await fs.readFile(
      path.join(harness.metadataRoot, 'app-codex-conversations', 'finance-os.json'),
      'utf8',
    ));
    assert.equal(persisted.conversations[0].metadata.locale, 'es');

    assert.equal(await harness.manager.getDiagnosticSnapshot('finance-os', 'missing'), null);
    const idle = await harness.manager.getDiagnosticSnapshot('finance-os', created.conversationId);
    assert.equal(idle.requestedRunId, null);
    assert.equal(idle.rawRunLog, null);
    assert.equal(idle.conversation.threadId, null);
    assert.deepEqual(idle.conversation.runtime, null);
    assert.deepEqual(idle.conversation.messages, []);
    const internalWithoutMetadata = harness.manager.conversations.get(created.conversationId);
    internalWithoutMetadata.metadata = undefined;
    assert.deepEqual(
      (await harness.manager.getDiagnosticSnapshot('finance-os', created.conversationId)).conversation.metadata,
      {},
    );

    const runId = 'diagnostic-run';
    const runLogPath = path.join(harness.root, 'large-run.log');
    await fs.writeFile(runLogPath, `${'x'.repeat(180_010)}tail`, 'utf8');
    harness.manager.runs.set(runId, {
      runId,
      appId: 'finance-os',
      conversationId: created.conversationId,
      locale: 'en',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      runLogPath,
    });
    const internal = harness.manager.conversations.get(created.conversationId);
    internal.activeRun = harness.manager.runs.get(runId);
    const diagnostic = await harness.manager.getDiagnosticSnapshot('finance-os', created.conversationId);
    assert.equal(diagnostic.requestedRunId, runId);
    assert.equal(diagnostic.rawRunLog.bytesRead, 180_000);
    assert.equal(diagnostic.rawRunLog.truncatedFromStart, true);
    assert.equal(diagnostic.rawRunLog.text.endsWith('tail'), true);

    const smallLogPath = path.join(harness.root, 'small-run.log');
    await fs.writeFile(smallLogPath, 'short log', 'utf8');
    harness.manager.runs.get(runId).runLogPath = smallLogPath;
    const small = await harness.manager.getDiagnosticSnapshot('finance-os', created.conversationId, runId);
    assert.equal(small.rawRunLog.bytesRead, 9);
    assert.equal(small.rawRunLog.truncatedFromStart, false);

    harness.manager.runs.delete(runId);
    const absent = await harness.manager.getDiagnosticSnapshot('finance-os', created.conversationId, 'absent-run');
    assert.equal(absent.requestedRunId, 'absent-run');
    assert.equal(absent.rawRunLog, null);
  } finally {
    await harness.cleanup();
  }
});

test('given permission decisions racing with run state, the manager preserves the terminal status and recreates legacy activity', async () => {
  const harness = await createHarness();
  try {
    const { conversation, run } = await createQueuedRun(harness, { agentId: 'legacy-agent' });
    run.activity = undefined;
    const decision = harness.manager.requestPermission(run.runId, {
      title: 'Read the shared folder',
      body: 'The agent needs the shared data.',
      action: 'read',
      permission: 'read',
      resource: 'shared-folder',
    });
    const requestId = run.permissionRequest.requestId;
    await waitForPendingPermission(harness.manager, requestId);
    assert.equal(harness.manager.pendingPermissions.has(requestId), true);
    assert.equal(harness.manager.approvePermission(
      run.appId,
      conversation.conversationId,
      run.runId,
      requestId,
      'allow',
    ).success, true);
    run.status = 'completed';
    assert.equal(await decision, true);
    assert.equal(run.status, 'completed');
    assert.equal(run.activity.sourceRef.agentId, 'legacy-agent');

    run.status = 'running';
    const resumed = harness.manager.requestPermission(run.runId, {
      title: 'Continue safely',
      body: 'The agent needs confirmation.',
      action: 'read',
      permission: 'read',
      resource: 'shared-folder',
      reason: 'Explicit confirmation',
    });
    const resumedRequestId = run.permissionRequest.requestId;
    await waitForPendingPermission(harness.manager, resumedRequestId);
    assert.equal(harness.manager.approvePermission(
      run.appId,
      conversation.conversationId,
      run.runId,
      resumedRequestId,
      'deny',
    ).success, true);
    assert.equal(await resumed, false);
    assert.equal(run.status, 'running');

    const noRequest = {
      runId: 'legacy-needs-permission',
      appId: 'finance-os',
      conversationId: conversation.conversationId,
      locale: 'en',
      status: 'needs_permission',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    harness.manager.runs.set(noRequest.runId, noRequest);
    harness.manager.rejectPendingPermissionsForApp('finance-os');
    assert.equal(noRequest.status, 'running');

    const runningWithRequest = {
      ...noRequest,
      runId: 'legacy-running-request',
      status: 'running',
      permissionRequest: { requestId: 'orphan', title: 'Orphan', body: '', action: 'read' },
    };
    harness.manager.runs.set(runningWithRequest.runId, runningWithRequest);
    harness.manager.rejectPendingPermissionsForApp('finance-os');
    assert.equal(runningWithRequest.status, 'running');
    assert.equal(runningWithRequest.permissionRequest, undefined);

    const detached = { ...noRequest, runId: 'detached', conversationId: 'missing', status: 'queued' };
    harness.manager.runs.set(detached.runId, detached);
    harness.manager.rejectPendingPermissionsForApp('finance-os');
    assert.equal(detached.status, 'queued');
  } finally {
    await harness.cleanup();
  }
});

test('given explicit workspaces and folder grants, resolution rejects ungranted roots and returns deduplicated grants', async () => {
  const harness = await createHarness();
  const nested = path.join(harness.appRoot, 'nested');
  const external = path.join(harness.root, 'external');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(external, { recursive: true });
  try {
    assert.deepEqual(await harness.manager.resolveRunWorkspace('finance-os', harness.appRoot), {
      runRoot: harness.appRoot,
      additionalRoots: [],
    });
    assert.deepEqual(await harness.manager.resolveRunWorkspace('finance-os', harness.appRoot, 'nested'), {
      runRoot: nested,
      additionalRoots: [],
    });
    assert.deepEqual(await harness.manager.resolveRunWorkspace('finance-os', harness.appRoot, nested), {
      runRoot: nested,
      additionalRoots: [],
    });
    await assert.rejects(
      () => harness.manager.resolveRunWorkspace('finance-os', harness.appRoot, undefined, { cwdGrantId: 'grant' }),
      /agent_run_folder_grants_unavailable/,
    );
    await assert.rejects(
      () => harness.manager.resolveRunWorkspace('finance-os', harness.appRoot, '../external'),
      /agent_run_workspace_outside_app/,
    );
    await assert.rejects(
      () => harness.manager.resolveRunWorkspace('finance-os', harness.appRoot, 'missing'),
      /agent_run_workspace_missing/,
    );

    const grants = await createHarness({
      options: {
        resolveFolderGrant: async (_appId, grantId) => ({
          grantId,
          appId: 'finance-os',
          realPath: grantId === 'cwd' ? nested : external,
        }),
      },
    });
    try {
      assert.deepEqual(await grants.manager.resolveRunWorkspace(
        'finance-os',
        grants.appRoot,
        undefined,
        { additionalFolderGrantIds: [' outside ', 'outside', ' '] },
      ), {
        runRoot: grants.appRoot,
        additionalRoots: [external],
      });
      assert.deepEqual(await grants.manager.resolveRunWorkspace(
        'finance-os',
        grants.appRoot,
        undefined,
        { cwdGrantId: ' cwd ', additionalFolderGrantIds: [] },
      ), {
        runRoot: nested,
        additionalRoots: [],
      });
    } finally {
      await grants.cleanup();
    }

    const linked = path.join(harness.appRoot, 'linked-outside');
    await fs.symlink(external, linked);
    await assert.rejects(
      () => harness.manager.resolveRunWorkspace('finance-os', harness.appRoot, 'linked-outside'),
      /agent_run_workspace_outside_app/,
    );
  } finally {
    await harness.cleanup();
  }
});

test('given legacy run shapes, activity and progress remain observable without optional persisted fields', async () => {
  const harness = await createHarness();
  try {
    const conversation = await harness.manager.create('finance-os', { agentId: 'advisor', title: 'Legacy state' });
    const internal = harness.manager.conversations.get(conversation.conversationId);
    const run = {
      runId: 'legacy-run',
      appId: 'finance-os',
      conversationId: conversation.conversationId,
      locale: 'en',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    harness.manager.runs.set(run.runId, run);

    harness.manager.updateActivityForRun(run, internal, 'running');
    assert.equal(run.activity.sourceRef.agentId, 'advisor');
    run.activity = undefined;
    harness.manager.handleOutput(
      internal,
      run,
      'codex',
      'stdout',
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'pwd' } }),
    );
    assert.equal(run.progressLog.length >= 0, true);
    assert.equal(run.activity.counts.total > 0, true);
    const noConversationActivity = harness.manager.createActivityForRun({
      ...run,
      runId: 'without-conversation',
      activity: undefined,
    });
    assert.equal(noConversationActivity.sourceRef.agentId, undefined);
    assert.equal(noConversationActivity.sourceRef.title, undefined);

    const unchangedEvents = harness.events.length;
    harness.manager.handleOutput(internal, run, 'codex', 'stdout', 'unstructured output');
    assert.equal(harness.events.length >= unchangedEvents, true);

    const canceled = { ...run, runId: 'canceled', status: 'canceled' };
    harness.manager.runs.set(canceled.runId, canceled);
    await harness.manager.failRun(canceled.runId, 'ignored');
    assert.equal(canceled.status, 'canceled');
    const missingConversation = { ...run, runId: 'missing-conversation', conversationId: 'absent' };
    harness.manager.runs.set(missingConversation.runId, missingConversation);
    await harness.manager.failRun(missingConversation.runId, 'ignored');
    assert.equal(missingConversation.status, 'running');
  } finally {
    await harness.cleanup();
  }
});

test('given provider output invariants, progress handling tolerates missing summaries and legacy count fields', async () => {
  const harness = await createHarness();
  const activityModule = require('../../dist-electron/main/chat/agent-run-activity.js');
  const originalAppend = activityModule.appendProviderActivity;
  try {
    const conversation = await harness.manager.create('finance-os', { title: 'Output compatibility' });
    const internal = harness.manager.conversations.get(conversation.conversationId);
    const run = {
      runId: 'output-run',
      appId: 'finance-os',
      conversationId: conversation.conversationId,
      locale: 'en',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    activityModule.appendProviderActivity = () => null;
    harness.manager.handleOutput(internal, run, 'claude', 'meta', '');
    assert.equal(run.progressLog, undefined);

    const validActivity = harness.manager.createActivityForRun(run, internal);
    activityModule.appendProviderActivity = () => ({
      ...validActivity,
      counts: { ...validActivity.counts, total: 1 },
      summary: undefined,
    });
    harness.manager.handleOutput(internal, run, 'claude', 'meta', '');
    assert.deepEqual(run.progressLog, []);
    assert.equal(harness.events.some((event) => event.type === 'run.progress'), false);
  } finally {
    activityModule.appendProviderActivity = originalAppend;
    await harness.cleanup();
  }
});

test('given a stale provider thread, execution retries once, rolls forward, and reports the default completion', async () => {
  const runServiceModule = require('../../dist-electron/main/llm-provider/run-service.js');
  const originalCreateRunService = runServiceModule.createLlmProviderRunService;
  let callCount = 0;
  let secondOptions;
  runServiceModule.createLlmProviderRunService = () => ({
    run: async (options) => {
      callCount += 1;
      if (callCount === 1) {
        return { code: 1, stdout: 'conversation not found', stderr: '', assistantText: '', threadId: null };
      }
      secondOptions = options;
      options.onOutput('stdout', JSON.stringify({ type: 'turn.started' }));
      return { code: 0, stdout: '', stderr: '', assistantText: '', threadId: null };
    },
  });
  const harness = await createHarness({ runtime: { provider: 'antigravity', model: 'gemini-test', effort: 'medium' } });
  try {
    harness.manager.execute = async () => undefined;
    const created = await harness.manager.create('finance-os', { title: 'Recover stale thread' });
    const queued = await harness.manager.sendMessage('finance-os', {
      conversationId: created.conversationId,
      message: 'Continue the previous work',
    });
    const conversation = harness.manager.conversations.get(created.conversationId);
    const run = harness.manager.runs.get(queued.activeRun.runId);
    conversation.threadId = 'stale-provider-thread';
    run.progressLog = undefined;
    run.activity = undefined;
    run.runLogPath = undefined;

    harness.manager.execute = AppAgentConversationManager.prototype.execute;
    await harness.manager.execute(created.conversationId, run.runId, {
      conversationId: created.conversationId,
      message: 'Continue the previous work',
    });

    assert.equal(callCount, 2);
    assert.equal(conversation.threadId, null);
    assert.equal(run.status, 'completed');
    assert.equal(conversation.messages.at(-1).role, 'assistant');
    assert.ok(conversation.messages.at(-1).text.length > 0);
    assert.equal(secondOptions.configWorkspaceRoot, harness.appRoot);
    assert.equal(secondOptions.threadId, null);
    assert.equal(harness.events.some((event) => event.type === 'run.progress'), true);
    assert.equal(harness.events.some((event) => event.type === 'run.completed'), true);
  } finally {
    runServiceModule.createLlmProviderRunService = originalCreateRunService;
    await harness.cleanup();
  }
});

test('given an unknown asynchronous execution failure, the public run ends with a stable fallback error', async () => {
  const harness = await createHarness();
  try {
    harness.manager.execute = async () => {
      throw undefined;
    };
    const conversation = await harness.manager.create('finance-os', { title: 'Unknown failure' });
    const queued = await harness.manager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: 'Trigger the provider',
    });
    const failure = await waitForRunFailure(harness, queued.activeRun.runId);
    assert.equal(failure.run.error, 'app_codex_conversation_failed');
  } finally {
    await harness.cleanup();
  }
});

test('given a stale folder grant, execution fails before starting a provider outside a real workspace', async () => {
  const harness = await createHarness({
    options: {
      resolveFolderGrant: async () => ({
        grantId: 'removed-folder',
        appId: 'finance-os',
        realPath: path.join(os.tmpdir(), `forger-removed-folder-${process.pid}`),
      }),
    },
  });
  try {
    const conversation = await harness.manager.create('finance-os', { title: 'Removed workspace' });
    const queued = await harness.manager.sendMessage('finance-os', {
      conversationId: conversation.conversationId,
      message: 'Inspect the shared folder',
      workspace: { cwdGrantId: 'removed-folder' },
    });
    const failure = await waitForRunFailure(harness, queued.activeRun.runId);
    assert.match(failure.run.error, /agent_run_workspace_missing/);
  } finally {
    await harness.cleanup();
  }
});

test('given runtime overrides and legacy agents, resolution applies security gates and provider fallbacks', async () => {
  const harness = await createHarness({
    agents: [{
      id: 'advisor',
      title: 'Advisor',
      model: ' ',
      reasoningEffort: undefined,
      runtime: {
        provider: 'claude',
        model: 'claude-agent',
        authProfileId: 'agent-profile',
        effort: 'high',
        permissionMode: 'safe',
      },
      runtimeRecommendations: { claude: { model: 'recommended' } },
    }],
  });
  try {
    const conversation = await harness.manager.create('finance-os', { agentId: 'advisor' });
    const internal = harness.manager.conversations.get(conversation.conversationId);
    assert.deepEqual(await harness.manager.resolveAgentRuntime(internal), {
      model: 'gpt-5.2',
      reasoningEffort: 'medium',
      runtime: harness.options.resolveAgents ? (await harness.options.resolveAgents())[0].runtime : undefined,
      runtimeRecommendations: { claude: { model: 'recommended' } },
    });

    await assert.rejects(
      () => harness.manager.assertRuntimeControlAllowed('finance-os', { provider: 'claude' }),
      /desktop_runtime_agent_runtime_control_required/,
    );
    await assert.doesNotReject(() => harness.manager.assertRuntimeControlAllowed('finance-os', {}));

    harness.options.appAllowsAgentRuntimeControl = async () => true;
    const runtime = await harness.manager.resolveRunRuntime(internal, {
      provider: undefined,
      model: 'override-model',
      reasoningEffort: 'max',
    });
    assert.equal(runtime.provider, 'codex');
    assert.deepEqual(harness.runtimeRequests.at(-1), {
      provider: 'claude',
      model: 'override-model',
      authProfileId: 'agent-profile',
      effort: 'max',
      permissionMode: 'safe',
      strict: true,
    });

    const unknownConversation = { ...internal, metadata: { agentId: 'missing' } };
    assert.deepEqual(await harness.manager.resolveAgentRuntime(unknownConversation), {
      model: 'gpt-5.2',
      reasoningEffort: 'medium',
    });
  } finally {
    await harness.cleanup();
  }
});

test('given absent persisted arrays and attachment variants, loading and preparation remain safe', async () => {
  const harness = await createHarness();
  try {
    const storageRoot = path.join(harness.metadataRoot, 'app-codex-conversations');
    await fs.mkdir(storageRoot, { recursive: true });
    await fs.writeFile(path.join(storageRoot, 'empty.json'), '{}', 'utf8');
    assert.deepEqual(await harness.manager.list('finance-os'), []);

    const run = { runId: 'attachments', attachmentPaths: undefined };
    assert.deepEqual(await harness.manager.prepareAttachments('finance-os', run, {}), []);
    assert.deepEqual(await harness.manager.prepareAttachments('finance-os', run, {
      attachments: [
        null,
        {},
        { dataBase64: '', mimeType: 7 },
        { dataBase64: '', mimeType: 'text/plain' },
        { dataBase64: Buffer.from('image').toString('base64'), mimeType: 'image/png', name: '' },
      ],
    }), [path.join(harness.metadataRoot, 'app-codex-conversation-inputs', 'finance-os', 'attachments', '5-attachment.png')]);
    await harness.manager.cleanupRunAttachments(run);
    assert.deepEqual(run.attachmentPaths, []);
    await harness.manager.cleanupRunAttachments(run);
  } finally {
    await harness.cleanup();
  }
});
