import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../../dist-electron/main/app-agent-task-manager.js');

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed_out_waiting_for:${label}`);
};

const loadManager = ({ existsDirectory, runService } = {}) => {
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === './app-agent/process') {
      return {
        existsDirectory: existsDirectory ?? (async (target) => await fs.stat(target).then((entry) => entry.isDirectory(), () => false)),
        isPathInside: (target, root) => {
          const relative = path.relative(root, target);
          return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        },
        killProcessTree: (child) => child?.kill?.('SIGKILL'),
        runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
      };
    }
    if (request === './llm-provider/run-service') {
      return {
        createLlmProviderRunService: () => runService ?? {
          assertReady: async () => undefined,
          run: async () => ({ code: 0, stdout: '', stderr: '', assistantText: '' }),
        },
      };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  try {
    delete require.cache[modulePath];
    return require(modulePath).AppAgentTaskManager;
  } finally {
    Module._load = originalLoad;
  }
};

const fixture = async (t, name) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const appRoot = path.join(root, 'apps', 'finance-os');
  await fs.mkdir(appRoot, { recursive: true });
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    appRoot,
    appsRoot: path.join(root, 'apps'),
    metadataRoot: path.join(root, 'metadata'),
  };
};

const optionsFor = (roots, overrides = {}) => ({
  privateAppsRoot: roots.appsRoot,
  metadataRoot: roots.metadataRoot,
  codexHome: path.join(roots.root, 'codex-home'),
  getAgentRuntime: async (request = {}) => ({ provider: request.provider ?? 'codex', model: request.model ?? 'gpt-test', effort: request.effort ?? 'medium', permissionMode: request.permissionMode }),
  getCodexCliPath: async () => '/mock/codex',
  getClaudeCliPath: async () => '/mock/claude',
  getCodexPathEntries: async () => [],
  getCodexEnvironment: async () => ({}),
  getCodexAuthenticated: async () => true,
  getClaudeAuthenticated: async () => true,
  resolvePromptTemplates: async () => [{
    id: 'review',
    title: 'Review',
    prompt: 'Review {{topic}}',
    arguments: [{ name: 'topic', type: 'string', required: true }],
  }],
  onTaskUpdated: () => undefined,
  ...overrides,
});

const internalTask = (roots, overrides = {}) => ({
  runId: 'run-1',
  appId: 'finance-os',
  templateId: 'review',
  status: 'running',
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  appRoot: roots.appRoot,
  transcriptPath: path.join(roots.metadataRoot, 'transcript.log'),
  ...overrides,
});

test('task permissions preserve state across absent activity, fallback copy, denial, and unrelated runs', async (t) => {
  const roots = await fixture(t, 'forger-b21-task-permission');
  const AppAgentTaskManager = loadManager();
  const events = [];
  const manager = new AppAgentTaskManager(optionsFor(roots, { onTaskUpdated: (event) => events.push(event) }));
  const task = internalTask(roots, { activity: undefined, progressLog: undefined });
  const other = internalTask(roots, { runId: 'other-run', appId: 'other-app', status: 'needs_permission' });
  manager.tasks.set(task.runId, task);
  manager.tasks.set(other.runId, other);

  const permission = manager.requestPermission(task.runId, { permission: 'read', resource: 'camera', reason: '' });
  const request = await waitFor(() => manager.get('finance-os', task.runId)?.permissionRequest, 'permission');
  await waitFor(() => manager.pendingPermissions.has(request.requestId), 'pending-permission');
  task.status = 'queued';
  assert.deepEqual(manager.approvePermission('finance-os', task.runId, request.requestId, 'deny'), { success: true });
  assert.equal(await permission, false);
  assert.equal(manager.get('finance-os', task.runId).status, 'queued');
  assert.match(task.activity.summary, /Permission requested for camera/);

  manager.rejectPendingPermissionsForApp('finance-os');
  assert.equal(other.status, 'needs_permission');
  assert.ok(events.length >= 2);

  manager.addProgress(task, 'Working');
  manager.addProgress(task, 'Working');
  assert.deepEqual(task.progressLog, ['Working']);
  const freshTask = internalTask(roots, { runId: 'fresh-run', activity: undefined, progressLog: undefined });
  manager.addProgress(freshTask, 'Starting fresh');
  freshTask.activity = undefined;
  manager.updateActivityForTask(freshTask, 'running');
  task.activity = undefined;
  manager.updateProgressFromOutput(task, 'codex', 'stdout', 'unrecognized provider text', 'en');
  manager.updateProgressFromOutput(task, 'claude', 'meta', 'Claude is checking files.', 'en');
  assert.ok(task.activity);
});

test('task runtime selection exhausts explicit fields, provider fallback, authentication, and policy', async (t) => {
  const roots = await fixture(t, 'forger-b21-task-runtime');
  const AppAgentTaskManager = loadManager();
  const requests = [];
  const manager = new AppAgentTaskManager(optionsFor(roots, {
    getAgentRuntime: async (request = {}) => {
      requests.push(request);
      return { provider: request.provider ?? 'codex', model: request.model ?? 'default-model', effort: request.effort ?? 'medium' };
    },
    getCodexAuthenticated: async () => { throw new Error('auth unavailable'); },
    getClaudeAuthenticated: async () => { throw new Error('auth unavailable'); },
    getAntigravityAuthenticated: undefined,
  }));
  const template = {
    id: 'review',
    title: 'Review',
    prompt: 'Review',
    model: 'legacy-model',
    reasoningEffort: 'high',
    runtimeRecommendations: [{ provider: 'codex', model: 'recommended' }],
  };

  await manager.assertRuntimeControlAllowed('finance-os', {});
  await assert.rejects(manager.assertRuntimeControlAllowed('finance-os', { runtime: {} }), /desktop_runtime_agent_runtime_control_required/);
  manager.options.appAllowsAgentRuntimeControl = async () => true;
  await manager.assertRuntimeControlAllowed('finance-os', { runtime: {} });

  await assert.rejects(manager.resolveRuntime(template, { runtime: { provider: 'unknown' } }), /agent_runtime_provider_unsupported/);
  for (const runtime of [
    { provider: 'codex' },
    { model: 'manual-model' },
    { authProfileId: 'profile' },
    { effort: 'high' },
    { modelParams: { effort: 'low' } },
    { modelParams: { reasoningEffort: 'medium' } },
    { permissionMode: 'full-access' },
    { modelParams: 'invalid' },
    {},
  ]) {
    await manager.resolveRuntime(template, { runtime });
  }

  const templateRuntime = {
    ...template,
    runtime: { provider: 'claude', model: 'claude-template', effort: 'high', authProfileId: 'template-profile', permissionMode: 'read-only' },
  };
  await manager.resolveRuntime(templateRuntime, { runtime: { model: 'ignored', authProfileId: 'ignored', effort: 'default', modelParams: null } });
  manager.options.getClaudeAuthenticated = async () => true;
  await manager.resolveRuntime(templateRuntime, { runtime: { model: 'manual', authProfileId: ' manual-profile ', modelParams: { effort: 'low' } } });
  await manager.resolveRuntime(templateRuntime, { runtime: { provider: 'claude', model: 'auto', authProfileId: ' ', modelParams: { reasoningEffort: 'medium' } } });
  await manager.resolveRuntime(templateRuntime, { runtime: { provider: 'codex', model: 'codex-manual' } });
  await manager.resolveRuntime(templateRuntime, {});
  manager.options.getClaudeAuthenticated = async () => false;
  await manager.resolveRuntime(templateRuntime, {});
  await manager.resolveRuntime({ ...template, runtimeRecommendations: undefined }, {});

  assert.equal(await manager.isProviderAuthenticated('codex'), false);
  assert.equal(await manager.isProviderAuthenticated('claude'), false);
  assert.equal(await manager.isProviderAuthenticated('antigravity'), false);
  manager.options.getAntigravityAuthenticated = async () => { throw new Error('signed out'); };
  assert.equal(await manager.isProviderAuthenticated('antigravity'), false);
  manager.options.getAntigravityAuthenticated = async () => true;
  assert.equal(await manager.isProviderAuthenticated('antigravity'), true);
  assert.ok(requests.some((request) => request.strict === true));
  assert.ok(requests.some((request) => request.permissionMode === 'read-only'));
  assert.ok(requests.some((request) => request.model === 'legacy-model'));
});

test('task workspaces and generated inputs enforce grants, defaults, containment, and cleanup', async (t) => {
  const roots = await fixture(t, 'forger-b21-task-inputs');
  const AppAgentTaskManager = loadManager();
  const manager = new AppAgentTaskManager(optionsFor(roots));

  await assert.rejects(
    manager.resolveRunWorkspace('finance-os', roots.appRoot, undefined, { additionalFolderGrantIds: ['grant'] }),
    /agent_run_folder_grants_unavailable/,
  );
  const additional = path.join(roots.root, 'additional');
  await fs.mkdir(additional);
  manager.options.resolveFolderGrant = async (_appId, grantId) => ({ grantId, realPath: additional });
  assert.deepEqual(await manager.resolveRunWorkspace('finance-os', roots.appRoot, undefined, {
    cwdGrantId: ' ',
    additionalFolderGrantIds: [' grant ', '', 'grant'],
  }), { runRoot: roots.appRoot, additionalRoots: [additional] });
  assert.equal(await manager.resolveRunRoot(roots.appRoot, '.'), path.resolve(roots.appRoot));
  assert.equal(await manager.resolveRunRoot(roots.appRoot, roots.appRoot), path.resolve(roots.appRoot));

  const task = internalTask(roots);
  assert.deepEqual(await manager.preparePromptArguments(task, {}, {}), { variables: {}, files: [] });
  assert.deepEqual(await manager.preparePromptArguments(task, {
    arguments: [{ name: 'optional', type: 'string', required: false }],
  }, {}), { variables: { optional: '' }, files: [] });
  const legacy = await manager.writeLegacyAttachments(task, {}, [{
    name: '',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('legacy').toString('base64'),
  }]);
  assert.equal(legacy[0].name, 'attachment-1');
  const files = await manager.writeFileArgument(task, { name: 'document', type: 'file', maxBytes: 100 }, [{
    type: 'file',
    name: '',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('typed').toString('base64'),
  }]);
  assert.equal(files[0].name, 'document-1');
  await manager.cleanupTaskInputs(task);
  await assert.rejects(fs.access(manager.taskInputDir(task)));
});

test('task execution releases MCP resources on success, failure, missing workspaces, and second-run cancellation', async (t) => {
  const roots = await fixture(t, 'forger-b21-task-execute');
  const events = [];
  const releases = [];
  const runs = [];
  let manager;
  const runService = {
    assertReady: async () => undefined,
    run: async (input) => {
      runs.push(input);
      input.onChild({ kill: () => undefined });
      input.onOutput('stdout', '{"type":"turn.started"}\n');
      return { code: 0, stdout: '', stderr: '', assistantText: '' };
    },
  };
  const AppAgentTaskManager = loadManager({ runService });
  manager = new AppAgentTaskManager(optionsFor(roots, {
    getAgentNetworkAccess: async () => true,
    buildMemoryContext: async () => 'Remember this.',
    buildForgerToolsContext: async () => 'Use Forger tools.',
    listenAppMcps: async () => [{ name: 'app', command: 'app-mcp', args: [], env: {} }],
    createForgerMcpSession: () => ({ url: 'http://127.0.0.1/mcp', token: 'token' }),
    releaseForgerMcpSession: (token) => releases.push(['forger', token]),
    releaseAppMcps: (runId) => releases.push(['apps', runId]),
    onTaskUpdated: (event) => events.push(event),
  }));
  const started = await manager.start('finance-os', { templateId: 'review', arguments: { topic: 'cash flow' } });
  const completed = await waitFor(() => events.find((event) => event.task.runId === started.runId && event.task.status === 'completed'), 'completed');
  assert.match(completed.task.resultText, /complet/i);
  assert.deepEqual(releases.filter(([kind]) => kind === 'forger'), [['forger', 'token']]);
  assert.equal(runs[0].mcpServers.length, 2);

  const failedEvents = [];
  const failedReleases = [];
  const FailingManager = loadManager({ runService: {
    assertReady: async () => undefined,
    run: async () => { throw 'provider exploded'; },
  } });
  const failing = new FailingManager(optionsFor(roots, {
    createForgerMcpSession: () => ({ url: 'http://127.0.0.1/mcp', token: 'failure-token' }),
    releaseForgerMcpSession: (token) => failedReleases.push(token),
    releaseAppMcps: (runId) => failedReleases.push(runId),
    onTaskUpdated: (event) => failedEvents.push(event),
  }));
  const failedStart = await failing.start('finance-os', { templateId: 'review', arguments: { topic: 'failure' } });
  const failed = await waitFor(() => failedEvents.find((event) => event.task.runId === failedStart.runId && event.task.status === 'failed'), 'failed');
  assert.equal(failed.task.error, 'provider exploded');
  assert.deepEqual(failedReleases, ['failure-token', failedStart.runId]);

  const recoveredEvents = [];
  const RecoveredManager = loadManager({ runService: {
    assertReady: async () => undefined,
    run: async () => ({
      code: 1,
      stderr: '',
      stdout: '{"type":"error","message":"failed to record rollout items: thread stale-run not found"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Recovered from stdout."}}\n',
      assistantText: '',
    }),
  } });
  const recoveredManager = new RecoveredManager(optionsFor(roots, { onTaskUpdated: (event) => recoveredEvents.push(event) }));
  const recoveredStart = await recoveredManager.start('finance-os', { templateId: 'review', arguments: { topic: 'recover' } });
  const recovered = await waitFor(() => recoveredEvents.find((event) => event.task.runId === recoveredStart.runId && event.task.status === 'completed'), 'recovered');
  assert.match(recovered.task.resultText, /complet/i);

  const missingEvents = [];
  const missing = new AppAgentTaskManager(optionsFor(roots, {
    resolveFolderGrant: async () => ({ realPath: path.join(roots.root, 'missing-grant') }),
    onTaskUpdated: (event) => missingEvents.push(event),
  }));
  const missingStart = await missing.start('finance-os', {
    templateId: 'review',
    arguments: { topic: 'missing' },
    workspace: { cwdGrantId: 'missing' },
  });
  const missingFailure = await waitFor(() => missingEvents.find((event) => event.task.runId === missingStart.runId && event.task.status === 'failed'), 'missing');
  assert.equal(missingFailure.task.error, 'agent_run_workspace_missing');

  let retryManager;
  let retryCount = 0;
  const RetryManager = loadManager({ runService: {
    assertReady: async () => undefined,
    run: async (input) => {
      retryCount += 1;
      if (retryCount === 1) return { code: 1, stdout: '', stderr: 'failed to record rollout items: thread stale-run not found', assistantText: '' };
      retryManager.cancel('finance-os', input.runId);
      return { code: 0, stdout: '', stderr: '', assistantText: 'must not persist' };
    },
  } });
  const retryEvents = [];
  retryManager = new RetryManager(optionsFor(roots, { onTaskUpdated: (event) => retryEvents.push(event) }));
  const retry = await retryManager.start('finance-os', { templateId: 'review', arguments: { topic: 'retry' } });
  await waitFor(() => retryEvents.find((event) => event.task.runId === retry.runId && event.task.status === 'canceled'), 'retry-canceled');
  assert.equal(retryManager.get('finance-os', retry.runId).resultText, undefined);
});

test('task start sanitizes non-string ids and converts null execution failures to stable persisted errors', async (t) => {
  const roots = await fixture(t, 'forger-b21-task-failure');
  const AppAgentTaskManager = loadManager({ runService: {
    assertReady: async () => { throw null; },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  } });
  const events = [];
  const manager = new AppAgentTaskManager(optionsFor(roots, { onTaskUpdated: (event) => events.push(event) }));
  await assert.rejects(manager.start('finance-os', { templateId: 42 }), /app_prompt_template_not_declared/);
  const task = await manager.start('finance-os', { templateId: 'review', arguments: { topic: 'null failure' } });
  const failed = await waitFor(() => events.find((event) => event.task.runId === task.runId && event.task.status === 'failed'), 'null-failure');
  assert.equal(failed.task.error, 'app_codex_task_failed');
});
