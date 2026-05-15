import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatOrchestrator } = require('../../dist-electron/main/chat/orchestrator.js');

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
console.log(JSON.stringify({ type: 'thread.started', thread_id: nextThreadId }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: mode + ' reply for ' + nextThreadId } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`, 'utf8');
  await chmod(cliPath, 0o755);
  return cliPath;
};

const createHarness = async () => {
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
  });
  return {
    root,
    forgerHomeRoot,
    metadataRoot,
    events,
    orchestrator,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
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
      prompt: 'hello',
      threadId: null,
      conversationId,
      conversationHistory: [{ role: 'user', content: 'hello' }],
    });
    const firstRun = await waitForRun(harness.events, first.runId);
    assert.equal(firstRun.status, 'preview_ready');
    assert.equal(firstRun.threadId, 'thread-1');
    await waitForRunCleanup();

    const second = await harness.orchestrator.startRun({
      prompt: 'continue',
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
    assert.equal(calls[0].codexHome, calls[1].codexHome);
    assert.equal(calls[0].allowedRoots, harness.forgerHomeRoot);
    assert.equal(calls[0].leakedSecret, false);
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
      threadId: null,
      conversationId,
      conversationHistory: [{ role: 'user', content: 'hello' }],
    });
    const firstRun = await waitForRun(harness.events, first.runId);
    assert.equal(firstRun.threadId, 'thread-1');
    await waitForRunCleanup();

    const second = await harness.orchestrator.startRun({
      prompt: 'force stale provider thread',
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
    assert.equal(new Set(calls.map((call) => call.codexHome)).size, 1);
  } finally {
    await harness.cleanup();
  }
});
