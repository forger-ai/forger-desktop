import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const runServiceModule = require('../../dist-electron/main/llm-provider/run-service.js');
const helperPath = require.resolve('../../dist-electron/main/chat/orchestrator-helpers.js');

const originalCreateRunService = runServiceModule.createLlmProviderRunService;
const providerResults = [];
const capturedRuns = [];
const createFakeRunService = () => ({
  resolveCommand: async () => ({ command: 'resolved', prefixArgs: [], pathEntries: [] }),
  run: async (input) => {
    capturedRuns.push(input);
    return providerResults.shift();
  },
});
runServiceModule.createLlmProviderRunService = createFakeRunService;
delete require.cache[helperPath];
const helpers = require(helperPath);
runServiceModule.createLlmProviderRunService = originalCreateRunService;

const {
  SandboxRunner,
  ensureUserModifiedBranch,
  getGitStatus,
  gitCommit,
  stripInternalVersioningClaims,
} = helpers;

const antigravityParams = (overrides = {}) => ({
  antigravityCliPath: '/opt/antigravity',
  pathEntries: ['/opt/bin'],
  environment: { FORGER_TEST: 'yes' },
  mcpServers: [{ name: 'forger', transport: 'http', url: 'http://127.0.0.1:1234' }],
  workingDir: '/workspace',
  sharedRoots: ['/shared'],
  prompt: 'Inspect the app',
  model: 'gemini-test',
  authProfileId: 'profile-1',
  permissionMode: 'approve',
  timeoutMs: 0,
  inactivityTimeoutMs: 5_000,
  onChild: () => undefined,
  onOutput: () => undefined,
  ...overrides,
});

test('SandboxRunner delegates Antigravity chat runs and preserves thread, usage, and default effort semantics', async () => {
  runServiceModule.createLlmProviderRunService = createFakeRunService;
  const runner = new SandboxRunner({ providerProfilesRoot: '/profiles' });
  runServiceModule.createLlmProviderRunService = originalCreateRunService;
  try {
    providerResults.push(
      { assistantText: 'direct thread', threadId: 'thread-1', conversationId: 'conversation-1', usageDelta: { inputTokens: 10 }, toolEvents: 2 },
      { assistantText: 'conversation thread', conversationId: 'conversation-2', toolEvents: 1 },
      { assistantText: 'no thread', toolEvents: 0 },
    );

    assert.deepEqual(await runner.runAntigravity(antigravityParams({ effort: 'high', threadId: 'resume-1' })), {
      assistantText: 'direct thread',
      threadId: 'thread-1',
      usageDelta: { inputTokens: 10 },
      toolEvents: 2,
    });
    assert.deepEqual(await runner.runAntigravity(antigravityParams()), {
      assistantText: 'conversation thread',
      threadId: 'conversation-2',
      toolEvents: 1,
    });
    assert.deepEqual(await runner.runAntigravity(antigravityParams()), {
      assistantText: 'no thread',
      threadId: undefined,
      toolEvents: 0,
    });

    assert.equal(capturedRuns[0].surface, 'desktop_chat');
    assert.equal(capturedRuns[0].runtime.provider, 'antigravity');
    assert.equal(capturedRuns[0].runtime.effort, 'high');
    assert.equal(capturedRuns[0].conversationId, 'resume-1');
    assert.equal(capturedRuns[0].timeoutMode, 'inactivity');
    assert.equal(capturedRuns[0].checkReady, false);
    assert.equal(capturedRuns[0].setupErrorMode, 'chat');
    assert.equal(typeof capturedRuns[0].runCommandCapture, 'function');
    assert.equal(capturedRuns[1].runtime.effort, 'medium');
    assert.equal(capturedRuns[1].effort, undefined);
  } finally {
    runServiceModule.createLlmProviderRunService = originalCreateRunService;
  }
});

test('git helper failures preserve stderr, stdout, and stable fallback diagnostics', async () => {
  const originalRunCommandCapture = helpers.runCommandCapture;
  const originalGetGitHead = helpers.getGitHead;
  try {
    const results = [];
    helpers.runCommandCapture = async (_command, args) => {
      if (args[0] === 'checkout' && args[1] === 'user-modified') {
        return { code: 1, stdout: '', stderr: '' };
      }
      return results.shift();
    };
    results.push({ code: 1, stdout: 'branch stdout', stderr: '' });
    await assert.rejects(() => ensureUserModifiedBranch('/workspace'), /branch stdout/);
    results.push({ code: 1, stdout: '', stderr: '' });
    await assert.rejects(() => ensureUserModifiedBranch('/workspace'), /user_modified_branch_failed/);

    helpers.runCommandCapture = async () => ({ code: 1, stdout: 'status stdout', stderr: '' });
    await assert.rejects(() => getGitStatus('/workspace'), /status stdout/);
    helpers.runCommandCapture = async () => ({ code: 1, stdout: '', stderr: '' });
    await assert.rejects(() => getGitStatus('/workspace'), /git_status_failed/);

    let commitCall = 0;
    helpers.runCommandCapture = async () => {
      commitCall += 1;
      return commitCall % 2 === 1
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
    };
    await assert.rejects(() => gitCommit('/workspace', 'save'), /git_commit_failed/);

    helpers.runCommandCapture = async () => ({ code: 0, stdout: '', stderr: '' });
    helpers.getGitHead = async () => 'head-sha';
    assert.equal(await gitCommit('/workspace', 'save'), 'head-sha');
  } finally {
    helpers.runCommandCapture = originalRunCommandCapture;
    helpers.getGitHead = originalGetGitHead;
  }
});

test('internal versioning failures are removed even without a save claim', () => {
  assert.equal(stripInternalVersioningClaims([
    'The app behavior is ready for review.',
    'Git failed because permission was blocked.',
  ].join('\n\n')), 'The app behavior is ready for review.');
});
