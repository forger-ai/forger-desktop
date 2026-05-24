import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const repoRoot = new URL('../..', import.meta.url);
const require = createRequire(import.meta.url);
const {
  activeRunFromChatRun,
  isMessageTerminalChatRunStatus,
  isTerminalChatRunStatus,
  normalizePersistedActiveChatRun,
} = require('../../dist-electron/shared/chat-run-state.js');

const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('active chat run persistence accepts only complete trimmed identities', () => {
  assert.deepEqual(normalizePersistedActiveChatRun({
    runId: ' run-1 ',
    conversationId: ' conv-1 ',
    appId: ' app-1 ',
  }), {
    runId: 'run-1',
    conversationId: 'conv-1',
    appId: 'app-1',
  });

  assert.equal(normalizePersistedActiveChatRun(null), null);
  assert.equal(normalizePersistedActiveChatRun({ runId: 'run-1', conversationId: 'conv-1' }), null);
  assert.equal(normalizePersistedActiveChatRun({ runId: 'run-1', conversationId: '', appId: 'app-1' }), null);
});

test('active run snapshot is saved only for non-terminal runs with a conversation', () => {
  assert.deepEqual(activeRunFromChatRun({
    runId: 'run-1',
    appId: 'finance-os',
    conversationId: 'conv-1',
    status: 'running',
  }), {
    runId: 'run-1',
    appId: 'finance-os',
    conversationId: 'conv-1',
  });

  assert.equal(activeRunFromChatRun({
    runId: 'run-1',
    appId: 'finance-os',
    conversationId: 'conv-1',
    status: 'preview_ready',
  }), null);
  assert.equal(activeRunFromChatRun({
    runId: 'run-1',
    appId: 'finance-os',
    conversationId: null,
    status: 'running',
  }), null);
});

test('terminal chat run status helpers cover final result statuses', () => {
  for (const status of ['preview_ready', 'failed', 'canceled', 'applied', 'undone']) {
    assert.equal(isTerminalChatRunStatus(status), true);
    assert.equal(isMessageTerminalChatRunStatus(status), true);
  }

  for (const status of ['queued', 'running', 'needs_permission', 'applying', 'undoing']) {
    assert.equal(isTerminalChatRunStatus(status), false);
    assert.equal(isMessageTerminalChatRunStatus(status), false);
  }
});

test('renderer persists and hydrates active chat runs through one update path', async () => {
  const source = await readSource('src/renderer/app/RendererAppController.tsx');

  assert.match(source, /activeRun:\s*persistedActiveChatRun/);
  assert.match(source, /desktopApi\.chatGetRun\(\{\s*runId:\s*activeRunToHydrate\.runId\s*\}\)/);
  assert.match(source, /desktopApi\.onChatRunUpdated\(\(\{\s*run\s*\}\)\s*=>\s*\{\s*applyChatRunUpdate\(run\);/);
  assert.match(source, /\.then\(\(run\)\s*=>\s*\{\s*if\s*\(run\)\s*\{\s*applyChatRunUpdate\(run\);/);
  assert.match(source, /setPersistedActiveChatRun\(\{\s*runId:\s*startResult\.runId,\s*conversationId:\s*targetConversationId,\s*appId:\s*chatScopeId\s*\}\)/);
  assert.match(source, /clearActiveRunState\(runId\)/);
  assert.match(source, /clearActiveRunState\(\)/);
});
