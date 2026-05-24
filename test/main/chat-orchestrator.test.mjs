/* eslint-disable max-lines */
import assert from 'node:assert/strict';
import test from 'node:test';
import fsPromises, { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatOrchestrator } = require('../../dist-electron/main/chat/orchestrator.js');
const {
  buildAutoAppliedUserMessage,
  buildFunctionalOperationSummary,
  ensureGitRepository,
  ensureUserModifiedBranch,
  applyPreviewChanges,
  existsDirectory,
  getGitHead,
  getGitStatus,
  gitCommit,
  AuditLogger,
  PermissionBroker,
  PluginRuntime,
  runCommandCapture,
  sanitizeId,
  SandboxRunner,
  summarizeOperationTitle,
} = require('../../dist-electron/main/chat/orchestrator-helpers.js');
const {
  appendRunLog,
  buildChatRecoveryContext,
  getRunLogPath,
  isMissingProviderThreadError,
  mapFailureMessage,
  normalizeChatHistory,
  normalizeErrorCode,
  toProgressMessages,
} = require('../../dist-electron/main/chat/progress-errors.js');
const {
  buildChatRunTracePayload,
  toPublicChatRun,
} = require('../../dist-electron/main/chat/run-serialization.js');
const {
  OperationHistoryStore,
} = require('../../dist-electron/main/chat/operation-history.js');

const terminalStatuses = new Set(['preview_ready', 'applied', 'undone', 'failed', 'canceled']);

const createFakeCodexCli = async (root) => {
  const cliPath = join(root, 'fake-codex.cjs');
  await writeFile(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME;
const statePath = path.join(codexHome, 'fake-state.json');
const callsPath = path.join(codexHome, 'fake-calls.ndjson');
const mode = args.includes('resume') ? 'resume' : 'new';
const prompt = args[args.length - 1] || '';
const threadId = mode === 'resume' ? args[args.length - 2] : '';
let state = { next: 1, threads: [] };
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
} catch {}
fs.appendFileSync(callsPath, JSON.stringify({
  mode,
  threadId,
  codexHome,
  args,
  prompt,
  allowedRoots: process.env.FORGER_ALLOWED_ROOTS || '',
  leakedSecret: Boolean(process.env.FORGER_MCP_TOKEN),
}) + '\\n');

if (mode === 'resume' && prompt.includes('force stale provider thread')) {
  console.error('thread/resume failed: no rollout found for thread id ' + threadId);
  process.exit(1);
}

if (mode === 'resume' && !state.threads.includes(threadId)) {
  console.error('thread/resume failed: no rollout found for thread id ' + threadId);
  process.exit(1);
}

const nextThreadId = mode === 'resume' ? threadId : 'thread-' + state.next++;
if (!state.threads.includes(nextThreadId)) {
  state.threads.push(nextThreadId);
}
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const emitReply = () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: nextThreadId }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: mode + ' reply for ' + nextThreadId } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
};
if (prompt.includes('slow cancel')) {
  setTimeout(emitReply, 5000);
} else {
  emitReply();
}
`, 'utf8');
  await chmod(cliPath, 0o755);
  return cliPath;
};

const createHarness = async (overrides = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-test-'));
  const forgerHomeRoot = join(root, 'forger-home');
  const privateAppsRoot = join(root, 'private-apps');
  const metadataRoot = join(root, 'metadata');
  const codexHome = join(root, 'codex-home');
  await mkdir(forgerHomeRoot, { recursive: true });
  await mkdir(privateAppsRoot, { recursive: true });
  await mkdir(metadataRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const fakeCodexCli = await createFakeCodexCli(root);
  const events = [];
  const orchestrator = new ChatOrchestrator({
    forgerHomeRoot,
    privateAppsRoot,
    metadataRoot,
    codexHome,
    agentContractVersion: 1,
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
    getCodexCliPath: async () => fakeCodexCli,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexEnvironment: async () => ({ SECRET_TOKEN_FOR_TEST: 'do-not-log' }),
    getCodexAuthenticated: async () => true,
    getClaudeAuthenticated: async () => false,
    buildMemoryContext: async () => 'Memory context.',
    onRunUpdated: (event) => events.push(event.run),
    ...overrides,
  });
  return {
    root,
    forgerHomeRoot,
    privateAppsRoot,
    metadataRoot,
    events,
    orchestrator,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
};

const waitForRun = async (events, runId) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = [...events].reverse().find((entry) => entry.runId === runId && terminalStatuses.has(entry.status));
    if (run) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for run ' + runId);
};

const waitForRunCleanup = async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
};

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for ' + label);
};

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

const withEnv = async (updates, operation) => {
  const previous = new Map();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    if (updates[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = updates[key];
    }
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const assertPublicSerializableRun = (run) => {
  assert.doesNotThrow(() => structuredClone(run));
  for (const internalField of [
    'child',
    'stagingDir',
    'appRoot',
    'baseHead',
    'sharedRoots',
    'runLogPath',
    'model',
    'provider',
    'reasoningEffort',
    'effort',
    'taskType',
    'startedWithUpdateConflict',
    'locale',
    'conversationHistory',
  ]) {
    assert.equal(Object.hasOwn(run, internalField), false, internalField + ' should not be exposed');
  }
};

const readFakeCalls = async (metadataRoot, appId, conversationId) => {
  const callsPath = join(
    metadataRoot,
    'chat-conversations-runtime',
    appId,
    conversationId,
    'codex-home',
    'fake-calls.ndjson',
  );
  const raw = await readFile(callsPath, 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line));
};

test('chat uses a persistent Codex home so the second message can resume', async () => {
  const harness = await createHarness();
  try {
    const conversationId = 'conversation-1';
    const first = await harness.orchestrator.startRun({
      prompt: 'START hello',
      resumePrompt: 'RESUME hello',
      threadId: null,
      conversationId,
      conversationHistory: [{ role: 'user', content: 'hello' }],
    });
    const firstRun = await waitForRun(harness.events, first.runId);
    assert.equal(firstRun.status, 'preview_ready');
    assert.equal(firstRun.threadId, 'thread-1');
    await waitForRunCleanup();

    const second = await harness.orchestrator.startRun({
      prompt: 'START continue',
      resumePrompt: 'RESUME continue',
      threadId: firstRun.threadId,
      conversationId,
      conversationHistory: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: firstRun.userMessage ?? '' },
        { role: 'user', content: 'continue' },
      ],
    });
    const secondRun = await waitForRun(harness.events, second.runId);
    assert.equal(secondRun.status, 'preview_ready');
    assert.equal(secondRun.threadId, 'thread-1');
    assert.match(secondRun.userMessage ?? '', /resume reply for thread-1/);

    const calls = await readFakeCalls(harness.metadataRoot, 'forger', conversationId);
    assert.deepEqual(calls.map((call) => call.mode), ['new', 'resume']);
    assert.match(calls[0].prompt, /START hello/);
    assert.doesNotMatch(calls[0].prompt, /RESUME hello/);
    assert.match(calls[1].prompt, /RESUME continue/);
    assert.doesNotMatch(calls[1].prompt, /START continue/);
    assert.equal(calls[0].codexHome, calls[1].codexHome);
    assert.equal(calls[0].allowedRoots, harness.forgerHomeRoot);
    assert.equal(calls[0].leakedSecret, false);
  } finally {
    await harness.cleanup();
  }
});

test('chat run sandbox includes only existing shared file roots', async () => {
  const harness = await createHarness();
  const sharedDir = join(harness.root, 'shared-inputs');
  const sharedFile = join(sharedDir, 'statement.csv');
  const missingFile = join(sharedDir, 'missing.csv');
  await mkdir(sharedDir, { recursive: true });
  await writeFile(sharedFile, 'date,amount\n2026-01-01,12\n', 'utf8');
  try {
    const conversationId = 'conversation-shared-files';
    const started = await harness.orchestrator.startRun({
      prompt: 'load shared file',
      threadId: null,
      conversationId,
      conversationHistory: [{ role: 'user', content: 'load shared file' }],
      sharedFiles: [
        { path: sharedFile, name: 'statement.csv', mimeType: 'text/csv', size: 28 },
        { path: missingFile, name: 'missing.csv', mimeType: 'text/csv', size: 0 },
        { path: '', name: 'empty.csv', mimeType: 'text/csv', size: 0 },
      ],
    });
    const finalRun = await waitForRun(harness.events, started.runId);
    assert.equal(finalRun.status, 'preview_ready');

    const [call] = await readFakeCalls(harness.metadataRoot, 'forger', conversationId);
    const allowedRoots = call.allowedRoots.split(delimiter);
    assert.deepEqual(allowedRoots, [harness.forgerHomeRoot, await realpath(sharedFile)]);
    assert.equal(allowedRoots.includes(missingFile), false);
  } finally {
    await harness.cleanup();
  }
});

test('chat recovers from a stale provider thread by starting a fresh thread with local history', async () => {
  const harness = await createHarness();
  try {
    const conversationId = 'conversation-stale';
    const first = await harness.orchestrator.startRun({
      prompt: 'hello',
      resumePrompt: 'resume hello',
      threadId: null,
      conversationId,
      conversationHistory: [{ role: 'user', content: 'hello' }],
    });
    const firstRun = await waitForRun(harness.events, first.runId);
    assert.equal(firstRun.threadId, 'thread-1');
    await waitForRunCleanup();

    const second = await harness.orchestrator.startRun({
      prompt: 'START after stale recovery',
      resumePrompt: 'RESUME force stale provider thread',
      threadId: firstRun.threadId,
      conversationId,
      conversationHistory: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: firstRun.userMessage ?? '' },
        { role: 'user', content: 'force stale provider thread' },
      ],
    });
    const secondRun = await waitForRun(harness.events, second.runId);
    assert.equal(secondRun.status, 'preview_ready');
    assert.equal(secondRun.threadId, 'thread-2');
    assert.match(secondRun.userMessage ?? '', /new reply for thread-2/);

    const calls = await readFakeCalls(harness.metadataRoot, 'forger', conversationId);
    assert.deepEqual(calls.map((call) => call.mode), ['new', 'resume', 'resume', 'resume', 'resume', 'new']);
    assert.match(calls[1].prompt, /RESUME force stale provider thread/);
    assert.match(calls.at(-1).prompt, /START after stale recovery/);
    assert.doesNotMatch(calls.at(-1).prompt, /RESUME force stale provider thread/);
    assert.equal(new Set(calls.map((call) => call.codexHome)).size, 1);
  } finally {
    await harness.cleanup();
  }
});

test('chat run updates and getRun expose only serializable public run state', async () => {
  const harness = await createHarness();
  try {
    const started = await harness.orchestrator.startRun({
      prompt: 'hello',
      threadId: null,
      conversationId: 'conversation-serializable',
      conversationHistory: [{ role: 'user', content: 'hello' }],
    });
    const finalRun = await waitForRun(harness.events, started.runId);
    assert.equal(finalRun.status, 'preview_ready');

    const runEvents = harness.events.filter((entry) => entry.runId === started.runId);
    assert.ok(runEvents.length >= 2);
    for (const eventRun of runEvents) {
      assertPublicSerializableRun(eventRun);
    }

    const storedRun = harness.orchestrator.getRun({ runId: started.runId });
    assert.ok(storedRun);
    assertPublicSerializableRun(storedRun);
  } finally {
    await harness.cleanup();
  }
});

test('canceling a chat run kills the provider process and keeps the run canceled', async () => {
  const harness = await createHarness();
  try {
    const started = await harness.orchestrator.startRun({
      prompt: 'slow cancel',
      threadId: null,
      conversationId: 'conversation-cancel',
      conversationHistory: [{ role: 'user', content: 'slow cancel' }],
    });

    assert.deepEqual(harness.orchestrator.cancelRun({ runId: started.runId }), { success: true });
    const canceledRun = await waitForRun(harness.events, started.runId);
    assert.equal(canceledRun.status, 'canceled');

    await new Promise((resolve) => setTimeout(resolve, 300));
    const statuses = harness.events
      .filter((entry) => entry.runId === started.runId)
      .map((entry) => entry.status);
    assert.equal(statuses.includes('preview_ready'), false);
    assert.equal(harness.orchestrator.getRun({ runId: started.runId })?.status, 'canceled');
  } finally {
    await harness.cleanup();
  }
});

test('chat helper functions normalize history, progress, stale errors, and public run payloads', () => {
  const history = normalizeChatHistory([
    { role: 'system', content: 'drop' },
    { role: 'user', content: '  hello  ' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'reply' },
  ]);
  assert.deepEqual(history, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'reply' },
  ]);
  assert.match(buildChatRecoveryContext(history), /user: hello\n\nassistant: reply/);
  assert.equal(isMissingProviderThreadError(new Error('Thread/resume failed: cannot resume')), true);
  assert.equal(sanitizeId('bad id / value!'), 'bad-id-value-');

  const progress = toProgressMessages('stdout', [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '  First   response  ' } }),
    'not json',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Second'.repeat(60) } }),
  ].join('\n'));
  assert.equal(progress[0], 'First response');
  assert.match(progress[1], /^Second/);
  assert.ok(progress[1].endsWith('...'));
  assert.deepEqual(toProgressMessages('meta', progress[0]), []);
  assert.deepEqual(toProgressMessages('stdout', JSON.stringify({
    type: 'item.started',
    item: { type: 'command_execution', command: 'mkdir -p frontend/src/features/chessos' },
  }), 'es'), ['Codex está editando archivos de la app.']);
  assert.deepEqual(toProgressMessages('stdout', JSON.stringify({
    type: 'item.started',
    item: { type: 'command_execution', command: 'cat frontend/src/App.tsx' },
  }), 'en'), []);
  assert.deepEqual(toProgressMessages('stdout', JSON.stringify({
    type: 'item.started',
    item: { type: 'command_execution', command: "python - <<'PY'\nfrom pathlib import Path\nPath('x').write_text('y')\nPY" },
  }), 'en'), ['Codex is editing app files.']);

  const internalRun = {
    runId: 'run-1',
    appId: 'forger',
    prompt: 'hello',
    threadId: 'thread-1',
    status: 'preview_ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    conversationId: 'conversation-1',
    child: { pid: 123 },
    model: 'gpt-test',
    progressLog: ['done'],
    userMessage: 'answer',
  };
  assert.deepEqual(toPublicChatRun(internalRun), {
    runId: 'run-1',
    appId: 'forger',
    prompt: 'hello',
    threadId: 'thread-1',
    status: 'preview_ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    dangerMode: undefined,
    permissionRequest: undefined,
    preview: undefined,
    errorCode: undefined,
    userMessage: 'answer',
    progressLog: ['done'],
    operationId: undefined,
    commitSha: undefined,
    conversationId: 'conversation-1',
  });
  assert.deepEqual(buildChatRunTracePayload(internalRun), {
    runId: 'run-1',
    appId: 'forger',
    conversationId: 'conversation-1',
    threadId: 'thread-1',
    status: 'preview_ready',
    hasUserMessage: true,
    userMessageLength: 6,
    progressCount: 1,
    hasPermissionRequest: false,
    hasPreview: false,
  });
  assert.deepEqual(buildChatRunTracePayload({
    runId: 'run-empty',
    appId: 'forger',
    prompt: 'hello',
    status: 'queued',
    createdAt: 'a',
    updatedAt: 'b',
    userMessage: '   ',
    permissionRequest: { requestId: 'request-1' },
    preview: { filesChanged: 0 },
  }), {
    runId: 'run-empty',
    appId: 'forger',
    conversationId: null,
    threadId: null,
    status: 'queued',
    hasUserMessage: false,
    userMessageLength: 3,
    progressCount: 0,
    hasPermissionRequest: true,
    hasPreview: true,
  });
  assert.deepEqual(normalizeChatHistory(null), []);
  assert.equal(buildChatRecoveryContext([]), '');
  assert.equal(isMissingProviderThreadError(null), false);
  assert.deepEqual(toProgressMessages('stdout', [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'same' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'same' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '' } }),
    JSON.stringify({ type: 'item.started', item: { type: 'tool_call' } }),
  ].join('\n')), ['same']);
  assert.deepEqual(toProgressMessages('stdout', '   '), []);
});

test('chat run logs use the private app run directory and preserve existing newlines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-run-log-'));
  const originalMkdir = fsPromises.mkdir;
  const originalAppendFile = fsPromises.appendFile;
  try {
    const runLogPath = getRunLogPath(root, 'run-1');
    assert.equal(runLogPath, join(root, '.forger', 'runs', 'run-1.log'));

    await appendRunLog(runLogPath, 'meta', 'first line\n');
    await appendRunLog(runLogPath, 'stdout', 'second line');
    const log = await readFile(runLogPath, 'utf8');
    assert.match(log, /\[meta\] first line\n/);
    assert.match(log, /\[stdout\] second line\n$/);

    fsPromises.mkdir = async () => {
      const error = new Error('run log root removed');
      error.code = 'ENOENT';
      throw error;
    };
    await assert.doesNotReject(() => appendRunLog(runLogPath, 'meta', 'cleanup race'));

    fsPromises.mkdir = originalMkdir;
    fsPromises.appendFile = async () => {
      const error = new Error('run log denied');
      error.code = 'EACCES';
      throw error;
    };
    await assert.rejects(() => appendRunLog(runLogPath, 'meta', 'real failure'), /run log denied/);
  } finally {
    fsPromises.mkdir = originalMkdir;
    fsPromises.appendFile = originalAppendFile;
    await rm(root, { recursive: true, force: true });
  }
});

test('chat audit logging tolerates workspace cleanup races without hiding other filesystem failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-audit-'));
  const originalAppendFile = fsPromises.appendFile;
  const logger = new AuditLogger(root);
  try {
    await logger.log({ type: 'permission_response_received', runId: 'run-ok' });
    assert.match(
      await readFile(join(root, '.forger', 'audit', new Date().toISOString().slice(0, 10) + '.log'), 'utf8'),
      /permission_response_received/,
    );

    fsPromises.appendFile = async () => {
      const error = new Error('workspace removed');
      error.code = 'ENOENT';
      throw error;
    };
    await assert.doesNotReject(() => logger.log({ type: 'permission_response_rejected' }));

    fsPromises.appendFile = async () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    };
    await assert.rejects(() => logger.log({ type: 'permission_response_rejected' }), /permission denied/);
  } finally {
    fsPromises.appendFile = originalAppendFile;
    await rm(root, { recursive: true, force: true });
  }
});

test('chat permission and plugin helpers enforce app roots and safe commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-permission-'));
  const appRoot = join(root, 'app');
  const sharedRoot = join(root, 'shared');
  const outsideRoot = join(root, 'outside');
  await mkdir(appRoot, { recursive: true });
  await mkdir(join(appRoot, '...'), { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  try {
    const broker = new PermissionBroker(appRoot, [await realpath(sharedRoot)]);
    await assert.doesNotReject(() => broker.assertAllowedPath(join(appRoot, 'new-file.txt')));
    await assert.doesNotReject(() => broker.assertAllowedPath(join(appRoot, '...', 'draft.txt')));
    await assert.doesNotReject(() => broker.assertAllowedPath(join(sharedRoot, 'new-file.txt')));
    await assert.rejects(() => broker.assertAllowedPath(join(outsideRoot, 'secret.txt')), (error) =>
      error.chatCode === 'sandbox_violation'
        && /Path outside allowed roots/.test(error.message),
    );

    const plugins = new PluginRuntime();
    assert.equal(plugins.listActive().length, 1);
    assert.doesNotThrow(() => plugins.ensureSafeCommand('npm run test -- --watch=false'));
    assert.throws(() => plugins.ensureSafeCommand('rm -rf app'), (error) =>
      error.chatCode === 'permission_denied'
        && /Unsafe command blocked/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat preview file helpers copy, delete, and reject paths outside the app root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-preview-files-'));
  const appRoot = join(root, 'app');
  const stagingDir = join(root, 'staging');
  await mkdir(join(appRoot, 'nested'), { recursive: true });
  await mkdir(join(stagingDir, 'nested'), { recursive: true });
  await writeFile(join(appRoot, 'remove.txt'), 'remove me\n', 'utf8');
  await writeFile(join(stagingDir, 'nested', 'copy.txt'), 'copied\n', 'utf8');
  try {
    assert.equal(await existsDirectory(appRoot), true);
    assert.equal(await existsDirectory(join(root, 'missing')), false);

    await applyPreviewChanges(appRoot, stagingDir, [
      { path: 'remove.txt', changeType: 'deleted', diff: '-remove me\n' },
      { path: 'nested/copy.txt', changeType: 'modified', diff: '+copied\n' },
    ]);
    await assert.rejects(() => readFile(join(appRoot, 'remove.txt'), 'utf8'), /ENOENT/);
    assert.equal(await readFile(join(appRoot, 'nested', 'copy.txt'), 'utf8'), 'copied\n');

    await assert.rejects(() => applyPreviewChanges(appRoot, stagingDir, [
      { path: '../outside.txt', changeType: 'modified', diff: '+outside\n' },
    ]), (error) => error.chatCode === 'sandbox_violation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat command runner reports output, process errors, and timeouts behaviorally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-command-runner-'));
  const outputScript = join(root, 'output.cjs');
  const slowScript = join(root, 'slow.cjs');
  await writeFile(outputScript, `
console.log('stdout line');
console.error('stderr line');
process.exit(7);
`, 'utf8');
  await writeFile(slowScript, `setTimeout(() => {}, 5000);\n`, 'utf8');
  try {
	    const seen = [];
	    let completedChild;
	    const result = await runCommandCapture(process.execPath, [outputScript], {
	      cwd: root,
	      timeoutMs: 5_000,
	      onChild: (child) => {
	        completedChild = child;
	      },
	      onStdout: (text) => seen.push(['stdout', text.trim()]),
	      onStderr: (text) => seen.push(['stderr', text.trim()]),
	    });
	    completedChild.emit('exit', 0);
	    completedChild.emit('error', new Error('late_error_after_exit'));
	    assert.equal(result.code, 7);
    assert.match(result.stdout, /stdout line/);
    assert.match(result.stderr, /stderr line/);
    assert.deepEqual(seen, [
      ['stdout', 'stdout line'],
      ['stderr', 'stderr line'],
    ]);

    await assert.rejects(() => runCommandCapture(join(root, 'missing-bin'), [], {
      cwd: root,
      timeoutMs: 5_000,
    }), /ENOENT/);
    await assert.rejects(() => runCommandCapture(process.execPath, [slowScript], {
      cwd: root,
      timeoutMs: 25,
    }), (error) => error.chatCode === 'timeout' && /timed out after 25ms/.test(error.message));
    await assert.rejects(() => runCommandCapture(process.execPath, [slowScript], {
      cwd: root,
      inactivityTimeoutMs: 25,
    }), (error) => error.chatCode === 'timeout' && /timed out due to inactivity/.test(error.message));
    await assert.rejects(() => withPlatform('win32', async () => await runCommandCapture(process.execPath, [slowScript], {
      cwd: root,
      timeoutMs: 25,
    })), (error) => error.chatCode === 'timeout' && /timed out after 25ms/.test(error.message));

    const originalProcessKill = process.kill;
    try {
      process.kill = () => {
        throw new Error('process group kill failed');
      };
      await assert.rejects(() => runCommandCapture(process.execPath, [slowScript], {
        cwd: root,
        timeoutMs: 25,
        onChild: (child) => {
          const originalChildKill = child.kill.bind(child);
          child.kill = (signal) => {
            originalChildKill(signal);
            throw new Error('child kill failed after signal');
          };
        },
      }), (error) => error.chatCode === 'timeout' && /timed out after 25ms/.test(error.message));
    } finally {
      process.kill = originalProcessKill;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat sandbox runner covers Windows shims and empty Claude replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-sandbox-runner-'));
  try {
    const binDir = join(root, 'bin');
    const codexBinDir = join(root, 'node_modules', '.bin');
    const codexEntrypointDir = join(root, 'node_modules', '@openai', 'codex', 'bin');
    const nodePath = join(binDir, 'node.exe');
    const codexCmd = join(codexBinDir, 'codex.cmd');
    const codexEntrypoint = join(codexEntrypointDir, 'codex.js');
    await mkdir(binDir, { recursive: true });
    await mkdir(codexBinDir, { recursive: true });
    await mkdir(codexEntrypointDir, { recursive: true });
    await writeFile(nodePath, '', 'utf8');
    await writeFile(codexCmd, '', 'utf8');
    await writeFile(codexEntrypoint, '', 'utf8');

    const runner = new SandboxRunner(join(root, 'codex-home'));
    const resolved = await withPlatform('win32', async () => await runner.resolveCodexCommand({
      codexCliPath: codexCmd,
      pathEntries: [binDir],
    }));
    assert.deepEqual(resolved, {
      command: nodePath,
      prefixArgs: [codexEntrypoint],
      pathEntries: [binDir, codexBinDir, binDir],
    });

    const missingEntrypointCmdDir = join(root, 'missing-entrypoint', '.bin');
    const missingEntrypointCmd = join(missingEntrypointCmdDir, 'codex.cmd');
    await mkdir(missingEntrypointCmdDir, { recursive: true });
    await writeFile(missingEntrypointCmd, '', 'utf8');
    await assert.rejects(() => withPlatform('win32', async () => await runner.resolveCodexCommand({
      codexCliPath: missingEntrypointCmd,
      pathEntries: [binDir],
    })), /codex_js_entrypoint_missing/);
    await assert.rejects(() => withPlatform('win32', async () => await runner.resolveCodexCommand({
      codexCliPath: missingEntrypointCmd,
      pathEntries: [join(root, 'missing-node-bin')],
    })), /codex_js_entrypoint_missing/);

    const emptyClaude = join(root, 'empty-claude.cjs');
    await writeFile(emptyClaude, '#!/usr/bin/env node\n', 'utf8');
    await chmod(emptyClaude, 0o755);
    const emptyResult = await runner.runClaude({
      claudeCliPath: emptyClaude,
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'Resume',
      model: 'claude-test',
      effort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
    });
    assert.deepEqual(emptyResult, {
      assistantText: 'Listo. ¿Qué te gustaría hacer ahora en esta app?',
      threadId: undefined,
      toolEvents: 0,
    });

    const structuredClaude = join(root, 'structured-claude.cjs');
    await writeFile(structuredClaude, [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ session_id: "claude-thread", type: "tool_result" }));',
      'console.log(JSON.stringify({ message: { content: "Nested content reply" } }));',
      'console.log(JSON.stringify({ text: "Text field reply" }));',
    ].join('\n'), 'utf8');
    await chmod(structuredClaude, 0o755);
    const structuredResult = await runner.runClaude({
      claudeCliPath: structuredClaude,
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'Resume',
      model: 'claude-test',
      effort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
    });
    assert.equal(structuredResult.assistantText, 'Text field reply');
    assert.equal(structuredResult.threadId, 'claude-thread');
    assert.equal(structuredResult.toolEvents, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat error helpers normalize codes and localized failure messages', () => {
  const error = new Error('no access');
  error.chatCode = 'permission_denied';
  assert.deepEqual(normalizeErrorCode(error), { code: 'permission_denied', message: 'no access' });
  const defaultCodeError = new Error('default code');
  defaultCodeError.chatCode = undefined;
  assert.deepEqual(normalizeErrorCode(defaultCodeError), { code: 'capability_unavailable', message: 'default code' });
  assert.deepEqual(normalizeErrorCode(new Error('plain error')), { code: 'capability_unavailable', message: 'plain error' });
  assert.deepEqual(normalizeErrorCode('bad'), { code: 'capability_unavailable', message: 'unknown_error' });
  assert.match(mapFailureMessage('app_not_installed', undefined, undefined, 'en'), /install|installed/i);
  assert.match(mapFailureMessage('auth_missing', undefined, undefined, 'en'), /connect Codex/i);
  assert.match(mapFailureMessage('permission_denied', undefined, undefined, 'en'), /permission/i);
  assert.match(mapFailureMessage('timeout', undefined, undefined, 'en'), /too long|long/i);
  assert.match(mapFailureMessage('sandbox_violation', undefined, undefined, 'en'), /workspace|access|files/i);
  assert.match(mapFailureMessage('dirty_worktree', undefined, undefined, 'en'), /saved|changes|clean/i);
  assert.match(mapFailureMessage('conflict', undefined, undefined, 'en'), /conflict|changed/i);
  assert.match(mapFailureMessage('canceled', undefined, '/tmp/run.log', 'en'), /\/tmp\/run\.log/);
  assert.match(mapFailureMessage('capability_unavailable', 'command not found', '/tmp/run.log', 'en'), /command not found/);
  assert.match(mapFailureMessage('capability_unavailable', 'provider failed without command keyword', '/tmp/run.log', 'en'), /provider failed/i);
});

test('chat helper text summaries stay functional and app chat prompt hides internal routing labels', async () => {
  const appChatPrompt = await readFile(join(process.cwd(), 'src/main/prompt-builder/prompts/chat/app-chat-start.md'), 'utf8');
  for (const internalLabel of [
    'resolver_dudas',
    'trabajar_datos',
    'interactuar_con_aplicacion',
    'actualizar_aplicacion',
    'resolver_conflicto_actualizacion',
  ]) {
    assert.equal(appChatPrompt.includes(internalLabel), false, internalLabel);
  }
  assert.match(appChatPrompt, /Do not mention internal request types/);
  assert.equal(buildFunctionalOperationSummary(''), 'Se guardo una nueva version de la app.');
  assert.equal(buildFunctionalOperationSummary('Short summary'), 'Short summary');
  assert.equal(buildFunctionalOperationSummary('A'.repeat(200)).length, 180);
  assert.equal(sanitizeId(''), 'item');
  assert.equal(summarizeOperationTitle(''), 'Cambio aplicado');
  assert.equal(summarizeOperationTitle('USER MESSAGE: Short title'), 'Short title');
  assert.equal(summarizeOperationTitle('A'.repeat(100)).length, 64);
  assert.match(buildAutoAppliedUserMessage('Listo.'), /Listo\.\n\nVersion guardada/);
  assert.match(buildAutoAppliedUserMessage(''), /^Version guardada/);
});

test('chat git helpers handle existing branches, dirty status, commits, and failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-git-'));
  const appRoot = join(root, 'app');
  const emptyRoot = join(root, 'empty');
  await mkdir(appRoot, { recursive: true });
  await mkdir(emptyRoot, { recursive: true });
  try {
    await ensureGitRepository(appRoot);
    const mainHead = await getGitHead(appRoot);
    assert.equal(typeof mainHead, 'string');

    await ensureGitRepository(appRoot);
    await ensureUserModifiedBranch(appRoot);
    await ensureUserModifiedBranch(appRoot);

    await writeFile(join(appRoot, 'notes.txt'), 'changed\n', 'utf8');
    const dirty = await getGitStatus(appRoot);
    assert.ok(dirty.some((line) => line.includes('notes.txt')));

    const commitSha = await gitCommit(appRoot, 'forger(test): save notes');
    assert.match(commitSha, /^[0-9a-f]{40}$/);
    assert.equal(await getGitHead(appRoot), commitSha);
    assert.deepEqual(await getGitStatus(appRoot), []);

    await assert.rejects(() => getGitStatus(emptyRoot), (error) =>
      error.chatCode === 'conflict' && /git_status_failed|not a git repository/i.test(error.message),
    );
    await assert.rejects(() => ensureUserModifiedBranch(emptyRoot), (error) =>
      error.chatCode === 'conflict' && /user_modified_branch_failed|not a git repository/i.test(error.message),
    );
    await assert.rejects(() => gitCommit(appRoot, 'forger(test): no changes'), (error) =>
      error.chatCode === 'conflict' && /nothing to commit|git_commit_failed/i.test(error.message),
    );
    assert.equal(await getGitHead(emptyRoot), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat git helpers cover init fallback and missing-head commit failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-fake-git-'));
  const fakeBin = join(root, 'bin');
  const fakeGit = join(fakeBin, 'git');
  const gitLog = join(root, 'git-calls.ndjson');
  const appRoot = join(root, 'app');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeFile(fakeGit, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + '\\n');
const command = args.join(' ');
if (process.env.FAKE_GIT_MODE === 'fallback-init') {
  if (command === 'rev-parse --is-inside-work-tree') process.exit(1);
  if (command === 'init -b main') process.exit(129);
  if (command === 'init') process.exit(0);
  if (command === 'checkout main') process.exit(1);
  if (command === 'checkout -B main') process.exit(0);
  process.exit(0);
}
if (process.env.FAKE_GIT_MODE === 'missing-head') {
  if (command === 'add -A') process.exit(0);
  if (args[0] === 'commit') process.exit(0);
  if (command === 'rev-parse HEAD') {
    console.log('   ');
    process.exit(0);
  }
}
process.exit(0);
`, 'utf8');
  await chmod(fakeGit, 0o755);
  try {
    await withEnv({
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: gitLog,
      FAKE_GIT_MODE: 'fallback-init',
    }, async () => {
      await ensureGitRepository(appRoot);
    });
    const fallbackCalls = (await readFile(gitLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(fallbackCalls.some((args) => args.join(' ') === 'init -b main'));
    assert.ok(fallbackCalls.some((args) => args.join(' ') === 'init'));
    assert.ok(fallbackCalls.some((args) => args.join(' ') === 'checkout -B main'));

    await withEnv({
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: gitLog,
      FAKE_GIT_MODE: 'missing-head',
    }, async () => {
      await assert.rejects(() => gitCommit(appRoot, 'forger(test): fake commit'), (error) =>
        error.chatCode === 'conflict' && /missing_git_head_after_commit/.test(error.message),
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat orchestrator rejects invalid starts, serializes the workspace lock, and handles missing runs', async () => {
  const harness = await createHarness();
  try {
    await assert.rejects(() => harness.orchestrator.startRun({
      prompt: '   ',
      threadId: null,
      conversationId: 'conversation-invalid',
    }), /invalid_chat_start_input/);
    assert.equal(harness.orchestrator.getRun({ runId: 'missing' }), null);
    assert.deepEqual(harness.orchestrator.cancelRun({ runId: 'missing' }), { success: false });
    assert.equal(harness.orchestrator.approvePermission({
      runId: 'missing',
      requestId: 'request-missing',
      decision: 'allow',
    }).success, false);

    const first = await harness.orchestrator.startRun({
      prompt: 'slow cancel',
      threadId: null,
      conversationId: 'conversation-lock',
      conversationHistory: [{ role: 'user', content: 'slow cancel' }],
    });
    await assert.rejects(() => harness.orchestrator.startRun({
      prompt: 'second while locked',
      threadId: null,
      conversationId: 'conversation-lock-2',
    }), (error) => error.chatCode === 'conflict' && /another_run_in_progress/.test(error.message));
    harness.orchestrator.appendExternalProgress(first.runId, '  Manual progress  ');
    harness.orchestrator.appendExternalProgress(first.runId, '   ');
    harness.orchestrator.appendExternalProgress('missing-run', 'ignored');
    assert.equal(harness.orchestrator.getRun({ runId: first.runId }).progressLog.at(-1), 'Manual progress');
    assert.equal(harness.orchestrator.cancelRun({ runId: first.runId }).success, true);
    harness.orchestrator.appendExternalProgress(first.runId, 'after cancel ignored');
    assert.equal(harness.orchestrator.getRun({ runId: first.runId }).progressLog.includes('after cancel ignored'), false);
    const failedRun = {
      ...harness.orchestrator.getRun({ runId: first.runId }),
      runId: 'failed-progress-run',
      status: 'failed',
      runLogPath: getRunLogPath(harness.metadataRoot, 'failed-progress-run'),
      locale: 'en',
    };
    harness.orchestrator.runs.set(failedRun.runId, failedRun);
    harness.orchestrator.appendExternalProgress(failedRun.runId, 'after failure ignored');
    assert.equal(harness.orchestrator.getRun({ runId: failedRun.runId }).progressLog.includes('after failure ignored'), false);
  } finally {
    await harness.cleanup();
  }
});

test('chat orchestrator persists, updates, and clears provider thread state defensively', async () => {
  const harness = await createHarness();
  try {
    await assert.doesNotReject(() => harness.orchestrator.executeRun('missing-run'));
    harness.orchestrator.updateThreadState('finance-os', undefined, undefined, 0);
    harness.orchestrator.updateThreadState('finance-os', null, { inputTokens: 1 }, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await assert.rejects(() => readFile(join(harness.metadataRoot, 'threads.json'), 'utf8'), /ENOENT/);

    harness.orchestrator.updateThreadState('finance-os', 'thread-a', {
      inputTokens: 2,
      outputTokens: 3,
      turns: 1,
    }, 1);
    await waitFor(async () => {
      const raw = await readFile(join(harness.metadataRoot, 'threads.json'), 'utf8').catch(() => '');
      return raw && JSON.parse(raw)['finance-os'];
    }, 'thread_state_saved');

    harness.orchestrator.updateThreadState('finance-os', undefined, {
      cachedInputTokens: 5,
      reasoningOutputTokens: 7,
      turns: 1,
    }, 2);
    const updated = await waitFor(async () => {
      const raw = await readFile(join(harness.metadataRoot, 'threads.json'), 'utf8').catch(() => '');
      if (!raw) {
        return null;
      }
      const state = JSON.parse(raw)['finance-os'];
      return state?.toolEvents === 3 ? state : null;
    }, 'thread_state_updated');
    assert.equal(updated.threadId, 'thread-a');
    assert.deepEqual(updated.usage, {
      inputTokens: 2,
      cachedInputTokens: 5,
      outputTokens: 3,
      reasoningOutputTokens: 7,
      turns: 2,
    });

    harness.orchestrator.threadsByApp.set('empty-thread-app', {
      appId: 'empty-thread-app',
      threadId: '',
      contractVersion: 1,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, turns: 0 },
      toolEvents: 0,
      lastRunAt: new Date().toISOString(),
    });
    harness.orchestrator.updateThreadState('empty-thread-app', undefined, undefined, 0);
    assert.equal(harness.orchestrator.threadsByApp.get('empty-thread-app').threadId, '');

    harness.orchestrator.clearThreadState('missing-app');
    harness.orchestrator.clearThreadState('finance-os');
    await waitFor(async () => {
      const raw = await readFile(join(harness.metadataRoot, 'threads.json'), 'utf8').catch(() => '');
      return raw && !JSON.parse(raw)['finance-os'];
    }, 'thread_state_cleared');
  } finally {
    await harness.cleanup();
  }
});

test('chat orchestrator loads valid legacy thread state and ignores invalid state files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-thread-load-'));
  const forgerHomeRoot = join(root, 'forger-home');
  const privateAppsRoot = join(root, 'private-apps');
  const metadataRoot = join(root, 'metadata');
  const legacyMetadataRoot = join(root, 'legacy-metadata');
  const codexHome = join(root, 'codex-home');
  await mkdir(forgerHomeRoot, { recursive: true });
  await mkdir(privateAppsRoot, { recursive: true });
  await mkdir(metadataRoot, { recursive: true });
  await mkdir(legacyMetadataRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(legacyMetadataRoot, 'threads.json'), JSON.stringify({
    'finance-os': {
      appId: 'finance-os',
      threadId: 'legacy-thread',
      contractVersion: 1,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 4,
        turns: 5,
      },
      toolEvents: 6,
      lastRunAt: '2026-01-01T00:00:00.000Z',
    },
    stale: {
      appId: 'stale',
      threadId: 'stale-thread',
      contractVersion: 0,
    },
    malformed: {
      appId: 'malformed',
      contractVersion: 1,
    },
  }), 'utf8');
  try {
    const baseOptions = {
      forgerHomeRoot,
      privateAppsRoot,
      metadataRoot,
      codexHome,
      agentContractVersion: 1,
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
      getCodexCliPath: async () => null,
      getClaudeCliPath: async () => null,
      getCodexPathEntries: async () => [],
      getCodexEnvironment: async () => ({}),
      getCodexAuthenticated: async () => false,
      getClaudeAuthenticated: async () => false,
      onRunUpdated: () => undefined,
    };
    const legacyOrchestrator = new ChatOrchestrator({
      ...baseOptions,
      legacyMetadataRoot,
    });
    const loaded = await waitFor(() => legacyOrchestrator.threadsByApp.get('finance-os'), 'legacy thread load');
    assert.equal(loaded.threadId, 'legacy-thread');
    assert.equal(legacyOrchestrator.threadsByApp.has('stale'), false);
    assert.equal(legacyOrchestrator.threadsByApp.has('malformed'), false);

    await writeFile(join(metadataRoot, 'threads.json'), '{bad json', 'utf8');
    const invalidOrchestrator = new ChatOrchestrator(baseOptions);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(invalidOrchestrator.threadsByApp.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat SandboxRunner parses Claude output, tool events, and temporary MCP config cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-claude-'));
  const fakeClaude = join(root, 'claude.cjs');
  const seenConfigPath = join(root, 'seen-config.txt');
  await writeFile(fakeClaude, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const configIndex = args.indexOf('--mcp-config');
if (configIndex >= 0) {
  fs.writeFileSync(${JSON.stringify(seenConfigPath)}, args[configIndex + 1]);
}
console.log('plain preface');
console.log(JSON.stringify({ session_id: 'claude-session-1', type: 'tool_use' }));
console.log(JSON.stringify({ message: { content: [null, { text: 'draft' }, { type: 'tool_use' }] } }));
console.log(JSON.stringify({ result: 'final claude answer' }));
`, 'utf8');
  await chmod(fakeClaude, 0o755);
  try {
    const runner = new SandboxRunner(join(root, 'codex-home'));
    const result = await runner.runClaude({
      claudeCliPath: fakeClaude,
      pathEntries: [],
      environment: {},
      mcpServers: [
        { name: 'forger', url: 'http://127.0.0.1:1/mcp', token: 'secret', tokenEnvVar: 'FORGER_MCP_TOKEN' },
      ],
      workingDir: root,
      prompt: 'hello',
      model: 'claude-test',
      effort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
    });
    assert.deepEqual(result, {
      assistantText: 'final claude answer',
      threadId: 'claude-session-1',
      toolEvents: 1,
    });
    const mcpConfigPath = (await readFile(seenConfigPath, 'utf8')).trim();
    await assert.rejects(() => readFile(mcpConfigPath, 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat SandboxRunner handles Claude fallback replies, resume ids, and failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-claude-fallbacks-'));
  const fakeClaude = join(root, 'claude.cjs');
  await writeFile(fakeClaude, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('fail claude')) {
  console.error('claude failed');
  process.exit(4);
}
if (args.includes('plain claude')) {
  console.log('plain line');
  process.exit(0);
}
process.exit(0);
`, 'utf8');
  await chmod(fakeClaude, 0o755);
  try {
    const runner = new SandboxRunner(join(root, 'codex-home'));
    const empty = await runner.runClaude({
      claudeCliPath: fakeClaude,
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'empty claude',
      model: 'claude-test',
      effort: 'medium',
      timeoutMs: 5_000,
      threadId: 'resume-thread',
      onChild: () => undefined,
    });
    assert.match(empty.assistantText, /Listo/);
    assert.equal(empty.threadId, 'resume-thread');
    assert.equal(empty.toolEvents, 0);

    const plain = await runner.runClaude({
      claudeCliPath: fakeClaude,
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'plain claude',
      model: 'claude-test',
      effort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
    });
    assert.equal(plain.assistantText, 'plain line');

    await assert.rejects(() => runner.runClaude({
      claudeCliPath: fakeClaude,
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'fail claude',
      model: 'claude-test',
      effort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
    }), /claude failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat SandboxRunner parses Codex fallback output and failed run diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-codex-runner-'));
  const codexHome = join(root, 'codex-home');
  const fakeCodex = join(root, 'codex.cjs');
  await mkdir(codexHome, { recursive: true });
await writeFile(fakeCodex, `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
if (prompt.includes('empty success')) {
  process.exit(0);
}
if (prompt.includes('plain success')) {
  console.log('first plain line');
  console.log('second plain line');
  process.exit(0);
}
if (prompt.includes('tool lifecycle success')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tool-thread' }));
  console.log(JSON.stringify({ type: 'tool.started' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 4 } }));
  process.exit(0);
}
if (prompt.includes('disallowed mcp')) {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'gmail' } }));
  process.exit(0);
}
if (prompt.includes('timeout failure')) {
  console.error('/tmp/codex timed out due to inactivity after 75000ms');
  process.exit(1);
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'partial-thread' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'tool_call' } }));
console.error('401 Unauthorized Failed to refresh token');
process.exit(2);
`, 'utf8');
  await chmod(fakeCodex, 0o755);
  try {
    const runner = new SandboxRunner(codexHome);
    const plain = await runner.runCodex({
      codexCliPath: fakeCodex,
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'plain success',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
    });
    assert.deepEqual(plain, {
      assistantText: 'first plain line\nsecond plain line',
      threadId: undefined,
      usageDelta: undefined,
      toolEvents: 0,
    });

    const empty = await runner.runCodex({
      codexCliPath: fakeCodex,
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'empty success',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
    });
    assert.match(empty.assistantText, /Listo/);

    const toolLifecycle = await runner.runCodex({
      codexCliPath: fakeCodex,
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'tool lifecycle success',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
    });
    assert.equal(toolLifecycle.threadId, 'tool-thread');
    assert.equal(toolLifecycle.toolEvents, 1);
    assert.deepEqual(toolLifecycle.usageDelta, {
      inputTokens: 2,
      cachedInputTokens: 1,
      outputTokens: 3,
      reasoningOutputTokens: 4,
      turns: 1,
    });

    await assert.rejects(() => runner.runCodex({
      codexCliPath: fakeCodex,
      pathEntries: [],
      environment: {},
      mcpServers: [
        { name: 'finance-os', url: 'http://127.0.0.1:9/mcp', token: 'app-secret', tokenEnvVar: 'APP_TOKEN' },
      ],
      workingDir: root,
      prompt: 'disallowed mcp',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
    }), /disallowed_mcp_server:gmail/);

    const outputEvents = [];
    await assert.rejects(() => runner.runCodex({
      codexCliPath: fakeCodex,
      pathEntries: [],
      environment: {},
      mcpServers: [
        { name: 'finance-os', url: 'http://127.0.0.1:9/mcp', token: 'app-secret', tokenEnvVar: 'APP_TOKEN' },
      ],
      workingDir: root,
      sharedRoots: [join(root, 'shared-file.csv')],
      prompt: 'failing auth',
      model: 'gpt-test',
      reasoningEffort: 'high',
      networkAccess: true,
      timeoutMs: 5_000,
      onChild: () => undefined,
      onOutput: (stream, text) => outputEvents.push([stream, text]),
    }), (error) => {
      assert.equal(error.chatCode, 'auth_missing');
      assert.equal(error.parsedRun.threadId, 'partial-thread');
      assert.equal(error.parsedRun.toolEvents, 1);
      return true;
    });
    assert.ok(outputEvents.some(([stream, text]) => stream === 'meta' && /Intento 5\/5/.test(text)));

    await assert.rejects(() => runner.runCodex({
      codexCliPath: fakeCodex,
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'timeout failure',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
      codexHome,
    }), (error) => {
      assert.equal(error.chatCode, 'timeout');
      assert.match(error.message, /timed out due to inactivity/);
      return true;
    });

    const missingEvents = [];
    await assert.rejects(() => runner.runCodex({
      codexCliPath: join(root, 'missing-codex'),
      pathEntries: [],
      environment: {},
      workingDir: root,
      prompt: 'spawn failure',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      timeoutMs: 5_000,
      onChild: () => undefined,
      onOutput: (stream, text) => missingEvents.push([stream, text]),
      codexHome,
    }), (error) => {
      assert.equal(error.chatCode, 'capability_unavailable');
      assert.match(error.message, /ENOENT|spawn/);
      return true;
    });
    assert.ok(missingEvents.some(([stream, text]) => stream === 'meta' && /falló/.test(text)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chat external permissions resolve, audit duplicates, and cancellation clears pending requests', async () => {
  const harness = await createHarness();
  try {
    const started = await harness.orchestrator.startRun({
      prompt: 'slow cancel',
      threadId: null,
      conversationId: 'conversation-permission',
      conversationHistory: [{ role: 'user', content: 'slow cancel' }],
    });

    const allowPromise = harness.orchestrator.requestExternalPermission(started.runId, {
      permission: 'official_tool',
      resource: 'Finance OS tool',
      risk: 'low',
      reason: 'Needs a local app tool.',
    });
    const needsPermission = await waitForRunStatus(harness.events, started.runId, 'needs_permission');
    const requestId = needsPermission.permissionRequest.requestId;
    assert.equal(harness.orchestrator.approvePermission({
      runId: started.runId,
      requestId,
      decision: 'allow',
    }).success, true);
    assert.equal(await allowPromise, true);
    assert.equal(harness.orchestrator.approvePermission({
      runId: started.runId,
      requestId,
      decision: 'deny',
    }).success, true);

    const denyPromise = harness.orchestrator.requestExternalPermission(started.runId, {
      permission: 'official_tool',
      resource: 'Second tool',
      risk: 'medium',
      reason: 'Second local action.',
    });
    const secondRequest = await waitForPermissionRequest(harness.events, started.runId, requestId);
    assert.notEqual(secondRequest.permissionRequest.requestId, requestId);
    assert.deepEqual(harness.orchestrator.cancelRun({ runId: started.runId }), { success: true });
    assert.equal(await denyPromise, false);
    assert.equal(harness.orchestrator.getRun({ runId: started.runId })?.permissionRequest, undefined);
    assert.equal(await harness.orchestrator.requestExternalPermission(started.runId, {
      permission: 'official_tool',
      resource: 'After cancel',
      risk: 'low',
      reason: 'Should be rejected.',
    }), false);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    await harness.cleanup();
  }
});

test('chat permission approval handles orphaned requests and trims duplicate audit cache', async () => {
  const harness = await createHarness();
  try {
    const now = new Date().toISOString();
    const orphanRun = {
      runId: 'run-orphan-permission',
      appId: 'forger',
      prompt: 'needs permission',
      status: 'needs_permission',
      createdAt: now,
      updatedAt: now,
      locale: 'en',
      runLogPath: getRunLogPath(harness.metadataRoot, 'run-orphan-permission'),
      permissionRequest: {
        requestId: 'request-orphan',
        permission: 'official_tool',
        resource: 'Tool without pending promise',
        risk: 'low',
        reason: 'Covers rejected approval.',
      },
      progressLog: [],
    };
    harness.orchestrator.runs.set(orphanRun.runId, orphanRun);
    assert.deepEqual(harness.orchestrator.approvePermission({
      runId: orphanRun.runId,
      requestId: 'request-orphan',
      decision: 'allow',
    }), { success: false });

    let resolvedDecision = null;
    const requestId = 'request-trim';
    const trimRun = {
      ...orphanRun,
      runId: 'run-trim-permission',
      runLogPath: getRunLogPath(harness.metadataRoot, 'run-trim-permission'),
      permissionRequest: {
        ...orphanRun.permissionRequest,
        requestId,
      },
    };
    harness.orchestrator.runs.set(trimRun.runId, trimRun);
    for (let index = 0; index < 201; index += 1) {
      harness.orchestrator.completedPermissions.set(`old-${index}`, 'allow');
    }
    harness.orchestrator.pendingPermissions.set(requestId, {
      runId: trimRun.runId,
      requestId,
      resolve: (decision) => {
        resolvedDecision = decision;
      },
    });
    assert.deepEqual(harness.orchestrator.approvePermission({
      runId: trimRun.runId,
      requestId,
      decision: 'deny',
    }), { success: true });
    assert.equal(resolvedDecision, 'deny');
    assert.equal(harness.orchestrator.completedPermissions.size, 201);
    assert.equal(harness.orchestrator.completedPermissions.has('old-0'), false);
    assert.equal(trimRun.status, 'failed');
    assert.equal(trimRun.errorCode, 'permission_denied');
  } finally {
    await harness.cleanup();
  }
});

test('chat failure releases workspace lock so the next run can start', async () => {
  const harness = await createHarness();
  try {
    await rm(harness.forgerHomeRoot, { recursive: true, force: true });
    const failed = await harness.orchestrator.startRun({
      prompt: 'hello',
      threadId: null,
      conversationId: 'conversation-failure',
      conversationHistory: [{ role: 'user', content: 'hello' }],
    });
    const failedRun = await waitForRun(harness.events, failed.runId);
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.errorCode, 'app_not_installed');

    await mkdir(harness.forgerHomeRoot, { recursive: true });
    const next = await harness.orchestrator.startRun({
      prompt: 'hello again',
      threadId: null,
      conversationId: 'conversation-after-failure',
      conversationHistory: [{ role: 'user', content: 'hello again' }],
    });
    const nextRun = await waitForRun(harness.events, next.runId);
    assert.equal(nextRun.status, 'preview_ready');
  } finally {
    await harness.cleanup();
  }
});

test('chat runs wire MCP sessions, app MCPs, network access, and release callbacks', async () => {
  const releasedTokens = [];
  const releasedRunIds = [];
  const traces = [];
  const harness = await createHarness({
    createForgerMcpSession: (runId, appId, locale) => ({
      url: `http://127.0.0.1:7/${runId}/${appId}/${locale}`,
      token: 'forger-token',
    }),
    releaseForgerMcpSession: (token) => releasedTokens.push(token),
    listenAppMcps: async (appIds, runId) => appIds.map((appId) => ({
      name: appId,
      url: `http://127.0.0.1:8/${runId}/${appId}`,
      token: 'app-token',
      tokenEnvVar: 'APP_MCP_TOKEN',
      toolTimeoutSec: 12,
    })),
    releaseAppMcps: (runId) => releasedRunIds.push(runId),
    getAgentNetworkAccess: async () => true,
    trace: async (event, payload) => traces.push([event, payload]),
  });
  const appId = 'finance-os';
  await mkdir(join(harness.privateAppsRoot, appId), { recursive: true });
  try {
    const started = await harness.orchestrator.startRun({
      appId,
      prompt: 'Que hace esta app?',
      threadId: null,
      conversationId: 'conversation-mcp',
      userLanguage: 'en-US',
      conversationHistory: [{ role: 'user', content: 'Que hace esta app?' }],
    });
    const finalRun = await waitForRun(harness.events, started.runId);
    assert.equal(finalRun.status, 'preview_ready');
    await waitFor(() => releasedRunIds.includes(started.runId), 'mcp release');
    assert.deepEqual(releasedTokens, ['forger-token']);
    assert.deepEqual(releasedRunIds, [started.runId]);
    assert.ok(traces.some(([event, payload]) =>
      event === 'chat_run_emit'
        && payload.runId === started.runId
        && payload.hasUserMessage === true,
    ));

    const [call] = await readFakeCalls(harness.metadataRoot, appId, 'conversation-mcp');
    assert.equal(call.leakedSecret, true);
    assert.ok(call.args.includes('--ask-for-approval'));
    assert.ok(call.args.includes('mcp_servers.forger.default_tools_approval_mode="auto"'));
    assert.ok(call.args.includes('mcp_servers.finance-os.default_tools_approval_mode="approve"'));
    assert.ok(call.args.includes('mcp_servers.finance-os.tool_timeout_sec=12'));
  } finally {
    await harness.cleanup();
  }
});

test('chat orchestrator handles Claude runtime success and missing CLI failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-chat-claude-runtime-'));
  const fakeClaude = join(root, 'claude.cjs');
  await writeFile(fakeClaude, `#!/usr/bin/env node
console.log(JSON.stringify({ session_id: 'claude-thread-1', result: 'claude orchestrator reply' }));
`, 'utf8');
  await chmod(fakeClaude, 0o755);

  const successHarness = await createHarness({
    getAgentRuntime: async () => ({ provider: 'claude', model: 'claude-test', effort: 'high' }),
    getClaudeCliPath: async () => fakeClaude,
    getClaudeAuthenticated: async () => true,
  });
  try {
    const started = await successHarness.orchestrator.startRun({
      prompt: 'ask claude',
      threadId: null,
      conversationId: 'conversation-claude',
      conversationHistory: [{ role: 'user', content: 'ask claude' }],
    });
    const finalRun = await waitForRun(successHarness.events, started.runId);
    assert.equal(finalRun.status, 'preview_ready');
    assert.equal(finalRun.userMessage, 'claude orchestrator reply');
    assert.equal(finalRun.threadId, 'claude-thread-1');
  } finally {
    await successHarness.cleanup();
  }

  const missingCliHarness = await createHarness({
    getAgentRuntime: async () => ({ provider: 'claude', model: 'claude-test', effort: 'medium' }),
    getClaudeAuthenticated: async () => true,
  });
  try {
    const started = await missingCliHarness.orchestrator.startRun({
      prompt: 'ask missing claude',
      threadId: null,
      conversationId: 'conversation-missing-claude',
    });
    const finalRun = await waitForRun(missingCliHarness.events, started.runId);
    assert.equal(finalRun.status, 'failed');
    assert.equal(finalRun.errorCode, 'capability_unavailable');
    assert.match(finalRun.userMessage, /Claude Code CLI not installed|Claude/i);
  } finally {
    await missingCliHarness.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('chat orchestrator reports Codex auth and CLI setup failures before provider execution', async () => {
  const missingAuthHarness = await createHarness({
    getCodexAuthenticated: async () => false,
  });
  try {
    const started = await missingAuthHarness.orchestrator.startRun({
      prompt: 'hello without auth',
      threadId: null,
      conversationId: 'conversation-codex-auth-missing',
    });
    const finalRun = await waitForRun(missingAuthHarness.events, started.runId);
    assert.equal(finalRun.status, 'failed');
    assert.equal(finalRun.errorCode, 'auth_missing');
    assert.match(finalRun.userMessage, /connect Codex|conecta Codex|session/i);
  } finally {
    await missingAuthHarness.cleanup();
  }

  const missingCliHarness = await createHarness({
    getCodexCliPath: async () => null,
  });
  try {
    const started = await missingCliHarness.orchestrator.startRun({
      prompt: 'hello without cli',
      threadId: null,
      conversationId: 'conversation-codex-cli-missing',
    });
    const finalRun = await waitForRun(missingCliHarness.events, started.runId);
    assert.equal(finalRun.status, 'failed');
    assert.equal(finalRun.errorCode, 'capability_unavailable');
    assert.match(finalRun.userMessage, /Codex CLI not installed|Codex/i);
  } finally {
    await missingCliHarness.cleanup();
  }

  const missingClaudeAuthHarness = await createHarness({
    getAgentRuntime: async () => ({ provider: 'claude', model: 'claude-test', effort: 'medium' }),
    getClaudeCliPath: async () => process.execPath,
    getClaudeAuthenticated: async () => false,
  });
  try {
    const started = await missingClaudeAuthHarness.orchestrator.startRun({
      prompt: 'hello without claude auth',
      threadId: null,
      conversationId: 'conversation-claude-auth-missing',
    });
    const finalRun = await waitForRun(missingClaudeAuthHarness.events, started.runId);
    assert.equal(finalRun.status, 'failed');
    assert.equal(finalRun.errorCode, 'auth_missing');
  } finally {
    await missingClaudeAuthHarness.cleanup();
  }
});

test('chat orchestrator saves app versions only when provider runs change files', async () => {
  const harness = await createHarness();
  const appId = 'finance-os';
  const appRoot = join(harness.privateAppsRoot, appId);
  await mkdir(appRoot, { recursive: true });
  await writeFile(join(appRoot, 'app.txt'), 'before\n', 'utf8');
  await ensureGitRepository(appRoot);
  try {
    const update = await harness.orchestrator.startRun({
      appId,
      prompt: 'Please improve the dashboard layout',
      threadId: null,
      conversationId: 'conversation-auto-update-dispatch',
      conversationHistory: [{ role: 'user', content: 'Please improve the dashboard layout' }],
    });
    const updateRun = await waitForRun(harness.events, update.runId);
    assert.equal(updateRun.status, 'preview_ready');

    harness.orchestrator.sandboxRunner = {
      async runCodex() {
        await writeFile(join(appRoot, 'app.txt'), 'after\n', 'utf8');
        return { assistantText: 'Changed the visible dashboard.', threadId: 'changed-thread', toolEvents: 0 };
      },
      async runClaude() {
        throw new Error('not_used');
      },
    };
    const changed = await harness.orchestrator.startRun({
      appId,
      prompt: 'Please improve the dashboard layout',
      threadId: null,
      conversationId: 'conversation-auto-update-changed-files',
      conversationHistory: [{ role: 'user', content: 'Please improve the dashboard layout' }],
    });
    const changedRun = await waitForRun(harness.events, changed.runId);
    assert.equal(changedRun.status, 'applied');
    assert.match(changedRun.userMessage, /Version guardada/);
  } finally {
    await harness.cleanup();
  }
});

test('chat orchestrator handles late cancellation after provider completion', async () => {
  const harness = await createHarness();
  try {
    harness.orchestrator.sandboxRunner = {
      async runCodex() {
        const [runId] = harness.orchestrator.runs.keys();
        await harness.orchestrator.cancelRun({ runId });
        return { assistantText: 'late answer', threadId: 'late-thread', toolEvents: 0 };
      },
      async runClaude() {
        throw new Error('not_used');
      },
    };

    const started = await harness.orchestrator.startRun({
      prompt: 'late cancel',
      threadId: null,
      conversationId: 'conversation-late-cancel',
      conversationHistory: [{ role: 'user', content: 'late cancel' }],
    });
    const finalRun = await waitForRun(harness.events, started.runId);
    assert.equal(finalRun.status, 'canceled');
    assert.equal(harness.orchestrator.getRun({ runId: started.runId })?.status, 'canceled');

    harness.orchestrator.updateThreadState('no-thread-app', undefined, undefined, 0);
    assert.equal(harness.orchestrator.threadsByApp.has('no-thread-app'), false);
  } finally {
    await harness.cleanup();
  }
});

test('chat apply and undo save a preview operation and revert it', async () => {
  const harness = await createHarness();
  const appId = 'finance-os';
  const appRoot = join(harness.privateAppsRoot, appId);
  const targetFile = join(appRoot, 'notes.txt');
  const stagingDir = join(harness.root, 'preview-staging');
  await mkdir(appRoot, { recursive: true });
  await mkdir(stagingDir, { recursive: true });
  await writeFile(targetFile, 'original\n', 'utf8');
  await ensureGitRepository(appRoot);
  const baseHead = await getGitHead(appRoot);
  await writeFile(join(stagingDir, 'notes.txt'), 'changed\n', 'utf8');
  try {
    const started = await harness.orchestrator.startRun({
      prompt: 'hello before apply',
      threadId: null,
      conversationId: 'conversation-apply',
      conversationHistory: [{ role: 'user', content: 'hello before apply' }],
    });
    const finalRun = await waitForRun(harness.events, started.runId);
    assert.equal(finalRun.status, 'preview_ready');

    const internalRun = harness.orchestrator.runs.get(started.runId);
    Object.assign(internalRun, {
      appId,
      appRoot,
      stagingDir,
      baseHead,
      status: 'preview_ready',
      preview: {
        summary: 'Updated notes.',
        impact: 'The note changes.',
        riskLevel: 'low',
        filesChanged: 1,
        diffFiles: [
          {
            path: 'notes.txt',
            changeType: 'modified',
            diff: '-original\n+changed\n',
          },
        ],
        checks: [],
      },
    });

    const applied = await harness.orchestrator.applyRun({ runId: started.runId });
    assert.equal(applied.success, true, JSON.stringify(applied));
    assert.ok(applied.operationId);
    assert.equal(await readFile(targetFile, 'utf8'), 'changed\n');
    assert.equal(harness.orchestrator.getRun({ runId: started.runId })?.status, 'applied');

    const undone = await harness.orchestrator.undo({ appId, operationId: applied.operationId });
    assert.equal(undone.success, true);
    assert.equal(await readFile(targetFile, 'utf8'), 'original\n');
  } finally {
    await harness.cleanup();
  }
});

test('chat apply and undo return focused diagnostics for missing state', async () => {
  const harness = await createHarness();
  try {
    assert.deepEqual(await harness.orchestrator.applyRun({ runId: 'missing-run' }), {
      success: false,
      technicalCode: 'run_not_found',
    });

    const started = await harness.orchestrator.startRun({
      prompt: 'hello not preview',
      threadId: null,
      conversationId: 'conversation-not-preview',
      conversationHistory: [{ role: 'user', content: 'hello not preview' }],
    });
    const internalRun = harness.orchestrator.runs.get(started.runId);
    internalRun.status = 'running';
    assert.deepEqual(await harness.orchestrator.applyRun({ runId: started.runId }), {
      success: false,
      technicalCode: 'run_not_preview_ready',
    });
    await waitForRun(harness.events, started.runId);

    assert.deepEqual(await harness.orchestrator.undo({ appId: 'missing-app' }), {
      success: false,
      technicalCode: 'app_not_installed',
    });

    const now = new Date().toISOString();
    harness.orchestrator.runs.set('run-missing-app-root', {
      runId: 'run-missing-app-root',
      appId: 'finance-os',
      prompt: 'Cambia el texto',
      status: 'preview_ready',
      createdAt: now,
      updatedAt: now,
      locale: 'en',
      appRoot: join(harness.privateAppsRoot, 'missing-app-root'),
      stagingDir: join(harness.root, 'missing-staging'),
      baseHead: null,
      preview: {
        summary: '',
        impact: '',
        riskLevel: 'low',
        filesChanged: 0,
        diffFiles: [],
        checks: [],
      },
      progressLog: [],
    });
    const missingAppApply = await harness.orchestrator.applyRun({ runId: 'run-missing-app-root' });
    assert.equal(missingAppApply.success, false);
    assert.equal(missingAppApply.technicalCode, 'app_not_installed');

    const appId = 'finance-os-conflict';
    const appRoot = join(harness.privateAppsRoot, appId);
    const stagingDir = join(harness.root, 'conflict-staging');
    await mkdir(appRoot, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(appRoot, 'note.txt'), 'base\n', 'utf8');
    await ensureGitRepository(appRoot);
    const baseHead = await getGitHead(appRoot);
    await writeFile(join(appRoot, 'note.txt'), 'new head\n', 'utf8');
    await gitCommit(appRoot, 'forger(test): advance base');
    await writeFile(join(stagingDir, 'note.txt'), 'preview\n', 'utf8');
    harness.orchestrator.runs.set('run-base-conflict', {
      runId: 'run-base-conflict',
      appId,
      prompt: 'Cambia el texto',
      status: 'preview_ready',
      createdAt: now,
      updatedAt: now,
      locale: 'en',
      appRoot,
      stagingDir,
      baseHead,
      preview: {
        summary: '',
        impact: 'Preview conflict',
        riskLevel: 'low',
        filesChanged: 1,
        diffFiles: [{ path: 'note.txt', changeType: 'modified', diff: '-base\n+preview\n' }],
        checks: [],
      },
      progressLog: [],
    });
    const conflictApply = await harness.orchestrator.applyRun({ runId: 'run-base-conflict' });
    assert.equal(conflictApply.success, false);
    assert.equal(conflictApply.technicalCode, 'conflict');
  } finally {
    await harness.cleanup();
  }
});

test('chat undo reports missing operations and failed git reverts', async () => {
  const harness = await createHarness();
  const appId = 'finance-os-undo-failure';
  const appRoot = join(harness.privateAppsRoot, appId);
  await mkdir(appRoot, { recursive: true });
  await writeFile(join(appRoot, 'note.txt'), 'base\n', 'utf8');
  await ensureGitRepository(appRoot);
  try {
    assert.deepEqual(await harness.orchestrator.undo({ appId }), {
      success: false,
      technicalCode: 'operation_not_found',
      userMessage: 'No hay cambios para deshacer.',
    });

    await harness.orchestrator.operationHistory.append(appId, {
      operationId: 'bad-operation',
      appId,
      runId: 'run-bad-operation',
      commitSha: '0000000000000000000000000000000000000000',
      createdAt: new Date().toISOString(),
    });
    const failedUndo = await harness.orchestrator.undo({ appId, operationId: 'bad-operation' });
    assert.equal(failedUndo.success, false);
    assert.equal(failedUndo.technicalCode, 'conflict');
    assert.match(failedUndo.userMessage, /could not undo|deshacer/i);
  } finally {
    await harness.cleanup();
  }
});

test('chat auto-update finalizers save changed app versions and handle no-op updates', async () => {
  const harness = await createHarness();
  const appId = 'finance-os';
  const appRoot = join(harness.privateAppsRoot, appId);
  const targetFile = join(appRoot, 'view.txt');
  const resolvedApps = [];
  harness.orchestrator.options.onUpdateConflictResolved = async (resolvedAppId) => {
    resolvedApps.push(resolvedAppId);
  };
  await mkdir(appRoot, { recursive: true });
  await writeFile(targetFile, 'original\n', 'utf8');
  await ensureGitRepository(appRoot);
  try {
    const noopRun = {
      runId: 'run-noop',
      appId,
      appRoot,
      prompt: 'Cambia nada',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      locale: 'en',
      progressLog: [],
    };
    await harness.orchestrator.finalizeAutoAppliedUpdate(noopRun, '');
    assert.equal(noopRun.status, 'applied');
    assert.match(noopRun.userMessage, /did not find changes/i);

    await writeFile(targetFile, 'changed\n', 'utf8');
    const changedRun = {
      runId: 'run-changed',
      appId,
      appRoot,
      prompt: 'MENSAJE USUARIO: Cambia el titulo principal para que explique la app con mucho detalle',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      locale: 'en',
      progressLog: [],
    };
    await harness.orchestrator.finalizeAutoAppliedUpdate(
      changedRun,
      'Updated the visible title.\n\nNo pude guardar el punto de retorno interno porque Git no pudo crear index.lock.',
    );
    assert.equal(changedRun.status, 'applied');
    assert.ok(changedRun.operationId);
    assert.ok(changedRun.commitSha);
    assert.doesNotMatch(changedRun.userMessage, /No pude guardar|index\.lock/);
    assert.match(changedRun.userMessage, /Version guardada/);

    await writeFile(targetFile, 'resolved conflict\n', 'utf8');
    const conflictRun = {
      runId: 'run-conflict',
      appId,
      appRoot,
      prompt: 'resolver conflicto',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      locale: 'en',
      progressLog: [],
    };
    await harness.orchestrator.finalizeUpdateConflictResolution(conflictRun, 'Resolved the update conflict.');
    assert.equal(conflictRun.status, 'applied');
    assert.deepEqual(resolvedApps, [appId]);
  } finally {
    await harness.cleanup();
  }
});

test('chat conflict finalizer rejects unresolved merge markers before saving an operation', async () => {
  const harness = await createHarness();
  const appId = 'finance-os-conflict-finalizer';
  const appRoot = join(harness.privateAppsRoot, appId);
  await mkdir(appRoot, { recursive: true });
  await writeFile(join(appRoot, 'conflicted.txt'), 'base\n', 'utf8');
  await ensureGitRepository(appRoot);
  try {
    const run = {
      runId: 'run-unmerged',
      appId,
      appRoot,
      prompt: 'resolver conflicto',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      locale: 'en',
      progressLog: [],
    };
    await runCommandCapture('git', ['checkout', '-b', 'theirs'], { cwd: appRoot, timeoutMs: 10_000 });
    await writeFile(join(appRoot, 'conflicted.txt'), 'theirs\n', 'utf8');
    await gitCommit(appRoot, 'forger(test): theirs');
    await runCommandCapture('git', ['checkout', 'main'], { cwd: appRoot, timeoutMs: 10_000 });
    await writeFile(join(appRoot, 'conflicted.txt'), 'ours\n', 'utf8');
    await gitCommit(appRoot, 'forger(test): ours');
    const merge = await runCommandCapture('git', ['merge', 'theirs'], { cwd: appRoot, timeoutMs: 10_000 });
    assert.notEqual(merge.code, 0);
    const status = await getGitStatus(appRoot);
    assert.ok(status.some((line) => /^(AA|DD|DU|UD|UA|AU|UU)\s/.test(line)));
    await assert.rejects(() => harness.orchestrator.finalizeUpdateConflictResolution(run, 'still conflicted'), (error) =>
      error.chatCode === 'conflict' && /merge_conflicts_remain/.test(error.message),
    );
  } finally {
    await harness.cleanup();
  }
});

test('operation history reads legacy records, ignores corrupt payloads, and appends newest first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-operation-history-'));
  const metadataRoot = join(root, 'metadata');
  const legacyMetadataRoot = join(root, 'legacy');
  try {
    await mkdir(join(legacyMetadataRoot, 'operations'), { recursive: true });
    await writeFile(join(legacyMetadataRoot, 'operations', 'finance-os.json'), JSON.stringify([
      {
        operationId: 'old',
        appId: 'finance-os',
        runId: 'run-old',
        commitSha: 'abc',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]), 'utf8');

    const store = new OperationHistoryStore(metadataRoot, legacyMetadataRoot);
    assert.deepEqual((await store.read('finance-os')).map((entry) => entry.operationId), ['old']);

    await store.append('finance-os', {
      operationId: 'new',
      appId: 'finance-os',
      runId: 'run-new',
      commitSha: 'def',
      createdAt: '2026-01-02T00:00:00.000Z',
      title: 'New change',
      summary: 'Saved change',
    });
    assert.deepEqual((await store.read('finance-os')).map((entry) => entry.operationId), ['new', 'old']);

    await writeFile(join(metadataRoot, 'operations', 'broken.json'), '{bad json', 'utf8');
    assert.deepEqual(await store.read('broken'), []);
    await writeFile(join(metadataRoot, 'operations', 'not-array.json'), '{"operationId":"x"}', 'utf8');
    assert.deepEqual(await store.read('not-array'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const waitForRunStatus = async (events, runId, status) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = [...events].reverse().find((entry) => entry.runId === runId && entry.status === status);
    if (run) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for run ' + runId + ' status ' + status);
};

const waitForPermissionRequest = async (events, runId, previousRequestId) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = [...events].reverse().find((entry) =>
      entry.runId === runId
        && entry.status === 'needs_permission'
        && entry.permissionRequest?.requestId
        && entry.permissionRequest.requestId !== previousRequestId,
    );
    if (run) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for new permission request for run ' + runId);
};
