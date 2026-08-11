import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatOrchestrator } = require('../../dist-electron/main/chat/orchestrator.js');
const helpers = require('../../dist-electron/main/chat/orchestrator-helpers.js');
const activityModule = require('../../dist-electron/main/chat/agent-run-activity.js');
const { getRunLogPath } = require('../../dist-electron/main/chat/progress-errors.js');

const now = '2026-01-01T00:00:00.000Z';

const createHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-chat-b19-'));
  const forgerHomeRoot = path.join(root, 'forger-home');
  const privateAppsRoot = path.join(root, 'apps');
  const metadataRoot = path.join(root, 'metadata');
  await Promise.all([
    fs.mkdir(forgerHomeRoot, { recursive: true }),
    fs.mkdir(privateAppsRoot, { recursive: true }),
    fs.mkdir(metadataRoot, { recursive: true }),
  ]);
  const events = [];
  const options = {
    forgerHomeRoot,
    privateAppsRoot,
    metadataRoot,
    codexHome: path.join(root, 'codex-home'),
    agentContractVersion: 1,
    getAgentRuntime: async (input) => ({
      provider: input?.provider ?? overrides.provider ?? 'codex',
      model: 'test-model',
      effort: 'medium',
      permissionMode: 'safe',
    }),
    getCodexCliPath: async () => process.execPath,
    getClaudeCliPath: async () => process.execPath,
    getCodexPathEntries: async () => [],
    getCodexEnvironment: async () => ({}),
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => true,
    onRunUpdated: ({ run }) => events.push(run),
    ...overrides.options,
  };
  const orchestrator = new ChatOrchestrator(options);
  return {
    root,
    forgerHomeRoot,
    privateAppsRoot,
    metadataRoot,
    events,
    options,
    orchestrator,
    cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
  };
};

const internalRun = (harness, overrides = {}) => {
  const runId = overrides.runId ?? `run-${Math.random().toString(36).slice(2)}`;
  return {
    runId,
    appId: overrides.appId ?? 'forger',
    prompt: overrides.prompt ?? 'Inspect the visible workflow',
    resumePrompt: overrides.resumePrompt,
    threadId: overrides.threadId,
    status: overrides.status ?? 'queued',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dangerMode: false,
    permissionMode: 'safe',
    stagingDir: path.join(harness.root, `staging-${runId}`),
    appRoot: overrides.appRoot ?? harness.forgerHomeRoot,
    baseHead: null,
    sharedRoots: [],
    runLogPath: getRunLogPath(harness.metadataRoot, runId),
    progressLog: overrides.progressLog ?? [],
    activity: overrides.activity,
    model: 'test-model',
    reasoningEffort: 'medium',
    provider: overrides.provider ?? 'codex',
    effort: 'medium',
    networkAccess: true,
    taskType: 'chat',
    startedWithUpdateConflict: overrides.startedWithUpdateConflict ?? false,
    locale: 'en',
    conversationId: overrides.conversationId,
    conversationHistory: [],
    ...overrides,
  };
};

const waitForPendingPermission = async (orchestrator, run) => {
  for (let index = 0; index < 1_000; index += 1) {
    if (run.permissionRequest && orchestrator.pendingPermissions.has(run.permissionRequest.requestId)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('pending_permission_not_observed');
};

test('given missing runs and question state, MCP updates reject duplicates and clear only explicit answers', async () => {
  const harness = await createHarness();
  try {
    harness.orchestrator.recordCreatedAppFromMcp('missing-run', { appId: 'created', name: 'Created' });
    await assert.rejects(
      () => harness.orchestrator.registerQuestionFromMcp('missing-run', { questions: [] }),
      /chat_run_not_found/,
    );

    const run = internalRun(harness, { runId: 'question-run', conversationId: 'chat-questions' });
    harness.orchestrator.runs.set(run.runId, run);
    const request = await harness.orchestrator.registerQuestionFromMcp(run.runId, {
      questions: [{ id: 'scope', question: 'Which scope?', options: [] }],
    });
    await assert.rejects(
      () => harness.orchestrator.registerQuestionFromMcp(run.runId, { questions: [] }),
      /active_question_exists/,
    );
    harness.orchestrator.clearActiveQuestionFromPrompt('chat-questions', 'A normal follow-up');
    assert.equal(harness.orchestrator.activeQuestionRequestsByChat.get('chat-questions'), request);
    harness.orchestrator.clearActiveQuestionFromPrompt('chat-questions', 'FORGER_QUESTION_RESPONSE selected');
    assert.equal(harness.orchestrator.activeQuestionRequestsByChat.has('chat-questions'), false);

    const missingRun = harness.orchestrator.approvePermission({
      runId: 'missing', requestId: 'missing', decision: 'allow',
    });
    assert.equal(missingRun.success, false);
    run.permissionRequest = { requestId: 'active-request', permission: 'read', resource: 'file', risk: 'low' };
    assert.equal(harness.orchestrator.approvePermission({
      runId: run.runId, requestId: 'different-request', decision: 'deny',
    }).success, false);
  } finally {
    await harness.cleanup();
  }
});

test('given stale completion events, only the run that owns each lock may release it', async () => {
  const harness = await createHarness();
  try {
    const stale = internalRun(harness, {
      runId: 'stale-run', appId: 'finance-os', conversationId: 'chat-lock', status: 'failed',
    });
    const current = internalRun(harness, {
      runId: 'current-run', appId: 'finance-os', conversationId: 'chat-lock', status: 'running',
    });
    const key = harness.orchestrator.conversationLockKey('finance-os', 'chat-lock');
    harness.orchestrator.activeRunIdsByConversation.set(key, current.runId);
    harness.orchestrator.activeRunIdsByApp.set('finance-os', current.runId);

    harness.orchestrator.releaseRunLocks(stale);
    assert.equal(harness.orchestrator.activeRunIdsByConversation.get(key), current.runId);
    assert.equal(harness.orchestrator.activeRunIdsByApp.get('finance-os'), current.runId);
    harness.orchestrator.releaseRunLocks(current);
    assert.equal(harness.orchestrator.activeRunIdsByConversation.has(key), false);
    assert.equal(harness.orchestrator.activeRunIdsByApp.has('finance-os'), false);
  } finally {
    await harness.cleanup();
  }
});

test('given legacy progress and permissions, missing activity is rebuilt and fallback copy stays observable', async () => {
  const harness = await createHarness();
  try {
    const run = internalRun(harness, {
      runId: 'legacy-progress', status: 'running', progressLog: undefined, activity: undefined, conversationId: 'chat-legacy',
    });
    harness.orchestrator.runs.set(run.runId, run);
    assert.equal(await harness.orchestrator.requestExternalPermission('missing-run', {
      permission: 'read', resource: 'missing', risk: 'low',
    }), false);
    harness.orchestrator.appendExternalProgress(run.runId, ' Legacy progress ');
    assert.deepEqual(run.progressLog, ['Legacy progress']);
    assert.equal(run.activity.sourceRef.conversationId, 'chat-legacy');

    run.activity = undefined;
    const decision = harness.orchestrator.requestExternalPermission(run.runId, {
      permission: 'read', resource: 'shared-folder', risk: 'low',
    });
    await waitForPendingPermission(harness.orchestrator, run);
    assert.match(run.activity.summary, /Permission requested for shared-folder/);
    assert.equal(harness.orchestrator.approvePermission({
      runId: run.runId,
      requestId: run.permissionRequest.requestId,
      decision: 'deny',
    }).success, true);
    assert.equal(await decision, false);

    const failed = internalRun(harness, {
      runId: 'legacy-failed', status: 'failed', activity: undefined, userMessage: undefined, errorCode: 'provider_failed',
    });
    const failedActivity = harness.orchestrator.activityForEmit(failed);
    assert.equal(failedActivity.status, 'failed');
    assert.equal(failedActivity.items.at(-1).summary, 'provider_failed');
  } finally {
    await harness.cleanup();
  }
});

test('given preview summaries and rollback results, apply and undo preserve every fallback diagnostic', async () => {
  const harness = await createHarness();
  const originals = {
    existsDirectory: helpers.existsDirectory,
    ensureGitRepository: helpers.ensureGitRepository,
    applyPreviewChanges: helpers.applyPreviewChanges,
    gitCommit: helpers.gitCommit,
    getGitHead: helpers.getGitHead,
    runCommandCapture: helpers.runCommandCapture,
  };
  helpers.existsDirectory = async () => true;
  helpers.ensureGitRepository = async () => undefined;
  helpers.applyPreviewChanges = async () => undefined;
  helpers.gitCommit = async (_root, message) => `commit-${message.length}`;
  try {
    for (const [runId, summary, impact] of [
      ['impact-summary', '', 'Visible impact'],
      ['default-summary', '', ''],
    ]) {
      const run = internalRun(harness, {
        runId,
        appId: 'finance-os',
        status: 'preview_ready',
        preview: { summary, impact, riskLevel: 'low', filesChanged: 0, diffFiles: [], checks: [] },
      });
      harness.orchestrator.runs.set(runId, run);
      assert.equal((await harness.orchestrator.applyRun({ runId })).success, true);
      const history = await harness.orchestrator.operationHistory.read('finance-os');
      assert.equal(history.find((entry) => entry.runId === runId).summary, impact || 'Cambio aplicado en la app.');
    }

    const appRoot = path.join(harness.privateAppsRoot, 'rollback-app');
    await fs.mkdir(appRoot, { recursive: true });
    for (const [operationId, result] of [
      ['stdout-failure', { code: 1, stdout: 'stdout failed', stderr: '' }],
      ['fallback-failure', { code: 1, stdout: '', stderr: '' }],
    ]) {
      await harness.orchestrator.operationHistory.append('rollback-app', {
        operationId, appId: 'rollback-app', runId: operationId, commitSha: 'commit', createdAt: now,
      });
      helpers.runCommandCapture = async () => result;
      const undone = await harness.orchestrator.undo({ appId: 'rollback-app', operationId });
      assert.equal(undone.success, false);
      assert.equal(undone.technicalCode, 'conflict');
    }

    await harness.orchestrator.operationHistory.append('rollback-app', {
      operationId: 'null-head', appId: 'rollback-app', runId: 'null-head', commitSha: 'commit', createdAt: now,
    });
    helpers.runCommandCapture = async () => ({ code: 0, stdout: '', stderr: '' });
    helpers.getGitHead = async () => null;
    const success = await harness.orchestrator.undo({ appId: 'rollback-app', operationId: 'null-head' });
    assert.equal(success.success, true);
    assert.equal(success.revertedCommitSha, undefined);
  } finally {
    Object.assign(helpers, originals);
    await harness.cleanup();
  }
});

test('given Antigravity setup states, missing authentication and CLI fail before execution', async () => {
  const missingAuth = await createHarness({
    provider: 'antigravity',
    options: { getAntigravityAuthenticated: undefined, getAntigravityCliPath: async () => process.execPath },
  });
  try {
    const run = internalRun(missingAuth, { runId: 'antigravity-auth', provider: 'antigravity' });
    missingAuth.orchestrator.runs.set(run.runId, run);
    await missingAuth.orchestrator.executeRun(run.runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.errorCode, 'auth_missing');
  } finally {
    await missingAuth.cleanup();
  }

  const missingCli = await createHarness({
    provider: 'antigravity',
    options: { getAntigravityAuthenticated: async () => true, getAntigravityCliPath: undefined },
  });
  try {
    const run = internalRun(missingCli, { runId: 'antigravity-cli', provider: 'antigravity' });
    missingCli.orchestrator.runs.set(run.runId, run);
    await missingCli.orchestrator.executeRun(run.runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.errorCode, 'capability_unavailable');
  } finally {
    await missingCli.cleanup();
  }
});

test('given provider streaming and empty thread ids, execution uses recovery fallbacks without stale state', async () => {
  const listenedAppIds = [];
  const harness = await createHarness({
    options: {
      buildMemoryContext: undefined,
      getProviderInactivityTimeoutMs: async () => 'invalid-timeout',
      listenAppMcps: async (appIds) => {
        listenedAppIds.push(appIds);
        return [];
      },
    },
  });
  const originalAppend = activityModule.appendProviderActivity;
  try {
    const run = internalRun(harness, {
      runId: 'stream-run', threadId: 'existing-thread', resumePrompt: undefined, activity: undefined, progressLog: undefined,
    });
    harness.orchestrator.runs.set(run.runId, run);
    let providerOptions;
    harness.orchestrator.sandboxRunner = {
      runCodex: async (options) => {
        providerOptions = options;
        run.activity = undefined;
        run.progressLog = undefined;
        activityModule.appendProviderActivity = () => null;
        options.onOutput('meta', '');
        const validActivity = harness.orchestrator.createActivityForRun(run);
        activityModule.appendProviderActivity = () => ({
          ...validActivity,
          counts: { ...validActivity.counts, total: 1 },
        });
        options.onOutput('meta', '');
        return { assistantText: 'Provider completed', threadId: undefined, usageDelta: undefined, toolEvents: undefined };
      },
    };
    await harness.orchestrator.executeRun(run.runId);
    assert.equal(providerOptions.prompt, run.prompt);
    assert.equal(providerOptions.threadId, 'existing-thread');
    assert.equal(run.threadId, 'existing-thread');
    assert.equal(run.status, 'preview_ready');
    assert.deepEqual(run.progressLog, []);
    assert.deepEqual(listenedAppIds[0], []);

    const noThread = internalRun(harness, { runId: 'no-thread', threadId: undefined });
    harness.orchestrator.runs.set(noThread.runId, noThread);
    harness.orchestrator.sandboxRunner = {
      runCodex: async () => ({ assistantText: 'No thread returned', threadId: undefined, toolEvents: 0 }),
    };
    await harness.orchestrator.executeRun(noThread.runId);
    assert.equal(noThread.threadId, null);

    harness.orchestrator.threadsByApp.set('forger', {
      appId: 'forger', threadId: 'stored-thread', contractVersion: 1,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, turns: 0 },
      toolEvents: 0, lastRunAt: now,
    });
    const stored = internalRun(harness, { runId: 'stored-thread-run', threadId: undefined });
    harness.orchestrator.runs.set(stored.runId, stored);
    harness.orchestrator.sandboxRunner = {
      runCodex: async () => ({ assistantText: 'Stored thread reused', threadId: undefined, toolEvents: 0 }),
    };
    await harness.orchestrator.executeRun(stored.runId);
    assert.equal(stored.threadId, 'stored-thread');
  } finally {
    activityModule.appendProviderActivity = originalAppend;
    await harness.cleanup();
  }
});

test('given a stale provider thread with legacy fields, recovery rebuilds progress and activity before retrying', async () => {
  const harness = await createHarness();
  try {
    const run = internalRun(harness, {
      runId: 'stale-provider-run', threadId: 'stale-thread', progressLog: [], activity: undefined,
    });
    harness.orchestrator.runs.set(run.runId, run);
    let attempts = 0;
    harness.orchestrator.sandboxRunner = {
      runCodex: async () => {
        attempts += 1;
        if (attempts === 1) {
          run.progressLog = undefined;
          run.activity = undefined;
          throw new Error('thread/resume failed: no rollout found for thread id stale-thread');
        }
        return { assistantText: 'Recovered locally', threadId: undefined, toolEvents: 0 };
      },
    };
    await harness.orchestrator.executeRun(run.runId);
    assert.equal(attempts, 2);
    assert.equal(run.status, 'preview_ready');
    assert.match(run.progressLog[0], /stale-thread|Provider thread/);
    assert.ok(run.activity.counts.total > 0);
  } finally {
    await harness.cleanup();
  }
});

test('given stored thread state, canceled and failed executions retain audit correlation while releasing work', async () => {
  const harness = await createHarness();
  try {
    harness.orchestrator.threadsByApp.set('forger', {
      appId: 'forger', threadId: 'audit-thread', contractVersion: 1,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, turns: 0 },
      toolEvents: 0, lastRunAt: now,
    });
    const canceled = internalRun(harness, { runId: 'canceled-with-thread' });
    harness.orchestrator.runs.set(canceled.runId, canceled);
    harness.orchestrator.sandboxRunner = {
      runCodex: async () => {
        canceled.status = 'canceled';
        throw new Error('provider stopped');
      },
    };
    await harness.orchestrator.executeRun(canceled.runId);
    assert.equal(canceled.errorCode, 'canceled');

    const failed = internalRun(harness, { runId: 'failed-with-thread' });
    harness.orchestrator.runs.set(failed.runId, failed);
    harness.orchestrator.sandboxRunner = { runCodex: async () => { throw new Error('provider failed'); } };
    await harness.orchestrator.executeRun(failed.runId);
    assert.equal(failed.status, 'failed');
  } finally {
    await harness.cleanup();
  }
});

test('given created-app and conflict finalization states, missing roots and unmerged files never report success', async () => {
  const harness = await createHarness();
  const originals = {
    existsDirectory: helpers.existsDirectory,
    ensureUserModifiedBranch: helpers.ensureUserModifiedBranch,
    getGitStatus: helpers.getGitStatus,
    gitCommit: helpers.gitCommit,
  };
  try {
    assert.equal(await harness.orchestrator.finalizeCreatedAppUpdate(internalRun(harness), 'No app'), false);
    const missing = internalRun(harness, {
      runId: 'missing-created', createdApp: { appId: 'missing-created-app', name: 'Missing' },
    });
    await assert.rejects(
      () => harness.orchestrator.finalizeCreatedAppUpdate(missing, 'Created it'),
      (error) => error.chatCode === 'app_not_installed',
    );

    let ensureGitCalls = 0;
    harness.orchestrator.options.ensureGitAvailable = async () => { ensureGitCalls += 1; };
    harness.orchestrator.options.resolveChatAppRoot = async () => path.join(harness.privateAppsRoot, 'resolved-created-app');
    helpers.existsDirectory = async () => true;
    helpers.ensureUserModifiedBranch = async () => undefined;
    helpers.getGitStatus = async () => ['UU conflicted.txt'];
    const unmerged = internalRun(harness, {
      runId: 'unmerged-created', createdApp: { appId: 'created-app', name: 'Created' },
    });
    await assert.rejects(
      () => harness.orchestrator.finalizeCreatedAppUpdate(unmerged, 'Created it'),
      (error) => error.chatCode === 'conflict' && /created_app_merge_conflicts_remain/.test(error.message),
    );
    assert.equal(ensureGitCalls, 1);

    helpers.getGitStatus = async () => [];
    helpers.gitCommit = async () => 'conflict-resolution-commit';
    const resolved = internalRun(harness, {
      runId: 'resolved-conflict', appId: 'finance-os', startedWithUpdateConflict: true,
    });
    await harness.orchestrator.finalizeUpdateConflictResolution(resolved, 'Conflict resolved visibly');
    assert.equal(resolved.status, 'applied');
  } finally {
    Object.assign(helpers, originals);
    await harness.cleanup();
  }
});

test('given an app run that began in conflict, successful provider output completes the conflict resolution branch', async () => {
  const harness = await createHarness();
  const appRoot = path.join(harness.privateAppsRoot, 'conflict-app');
  await fs.mkdir(appRoot, { recursive: true });
  const originals = {
    ensureGitRepository: helpers.ensureGitRepository,
    getGitStatus: helpers.getGitStatus,
    gitCommit: helpers.gitCommit,
  };
  let statusCalls = 0;
  helpers.ensureGitRepository = async () => undefined;
  helpers.getGitStatus = async () => {
    statusCalls += 1;
    return statusCalls === 1 ? ['UU conflicted.txt'] : [];
  };
  helpers.gitCommit = async () => 'resolved-conflict-commit';
  const run = internalRun(harness, { runId: 'conflict-execution', appId: 'conflict-app', appRoot });
  harness.orchestrator.runs.set(run.runId, run);
  harness.orchestrator.sandboxRunner = {
    runCodex: async () => ({ assistantText: 'Resolved the visible conflict', threadId: null, toolEvents: 0 }),
  };
  try {
    await harness.orchestrator.executeRun(run.runId);
    assert.equal(run.status, 'applied');
    assert.equal(run.commitSha, 'resolved-conflict-commit');
    assert.equal(run.startedWithUpdateConflict, true);
  } finally {
    Object.assign(helpers, originals);
    await harness.cleanup();
  }
});

test('given incomplete legacy thread counters, updates use empty thread and zero-event fallbacks safely', async () => {
  const harness = await createHarness();
  try {
    harness.orchestrator.threadsByApp.set('legacy-empty', {
      appId: 'legacy-empty', threadId: undefined, contractVersion: 1,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, turns: 0 },
      toolEvents: 0, lastRunAt: now,
    });
    harness.orchestrator.updateThreadState('legacy-empty', undefined, undefined, undefined);
    assert.equal(harness.orchestrator.threadsByApp.get('legacy-empty').threadId, undefined);

    harness.orchestrator.threadsByApp.set('legacy-valid', {
      appId: 'legacy-valid', threadId: 'thread-valid', contractVersion: 1,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, turns: 0 },
      toolEvents: 3, lastRunAt: now,
    });
    harness.orchestrator.updateThreadState('legacy-valid', undefined, undefined, undefined);
    assert.equal(harness.orchestrator.threadsByApp.get('legacy-valid').toolEvents, 3);
  } finally {
    await harness.cleanup();
  }
});

test('given a created app save failure, execution marks the failure as version-specific and releases locks', async () => {
  const harness = await createHarness();
  const run = internalRun(harness, {
    runId: 'created-app-save-failure',
    createdApp: { appId: 'created-app', name: 'Created' },
    conversationId: 'created-app-chat',
  });
  harness.orchestrator.runs.set(run.runId, run);
  harness.orchestrator.activeRunIdsByConversation.set(
    harness.orchestrator.conversationLockKey(run.appId, run.conversationId),
    run.runId,
  );
  harness.orchestrator.sandboxRunner = {
    runCodex: async () => ({ assistantText: 'Created app response', threadId: null, toolEvents: 0 }),
  };
  harness.orchestrator.finalizeCreatedAppUpdate = async () => {
    throw new Error('save_created_app_failed');
  };
  try {
    await harness.orchestrator.executeRun(run.runId);
    assert.equal(run.status, 'failed');
    assert.match(run.userMessage, /save|guardar|version/i);
    assert.equal(harness.orchestrator.activeRunIdsByConversation.size, 0);
  } finally {
    await harness.cleanup();
  }
});

test('given app-root resolution and omitted thread input, startRun uses the public resolver and leaves provider thread unset', async () => {
  const harness = await createHarness({
    options: {
      resolveChatAppRoot: async (appId, mode) => path.join(os.tmpdir(), `${appId}-${mode}`),
    },
  });
  try {
    harness.orchestrator.executeRun = async () => undefined;
    const started = await harness.orchestrator.startRun({
      appId: 'finance-os', chatMode: 'edit_app', prompt: 'Prepare the app change',
    });
    const run = harness.orchestrator.runs.get(started.runId);
    assert.equal(run.appRoot, path.join(os.tmpdir(), 'finance-os-edit_app'));
    assert.equal(run.threadId, undefined);
  } finally {
    await harness.cleanup();
  }
});
