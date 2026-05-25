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
  normalizePersistedActiveChatRuns,
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

test('active chat run list persistence accepts arrays and dedupes by conversation', () => {
  assert.deepEqual(normalizePersistedActiveChatRuns([
    { runId: ' run-1 ', conversationId: ' conv-1 ', appId: ' app-1 ' },
    { runId: 'run-2', conversationId: 'conv-1', appId: 'app-1' },
    { runId: 'run-3', conversationId: 'conv-3', appId: 'app-3' },
    { runId: 'missing-conversation', appId: 'app-4' },
  ]), [
    { runId: 'run-1', conversationId: 'conv-1', appId: 'app-1' },
    { runId: 'run-3', conversationId: 'conv-3', appId: 'app-3' },
  ]);

  assert.deepEqual(normalizePersistedActiveChatRuns(null), []);
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

  assert.match(source, /activeRuns:\s*Object\.values\(activeChatRunsByConversation\)/);
  assert.match(source, /for \(const activeRunToHydrate of persistedChatState\.activeRuns\)/);
  assert.match(source, /desktopApi\.chatGetRun\(\{\s*runId:\s*activeRunToHydrate\.runId\s*\}\)/);
  assert.match(source, /desktopApi\.onChatRunUpdated\(\(\{\s*run\s*\}\)\s*=>\s*\{\s*applyChatRunUpdate\(run\);/);
  assert.match(source, /\.then\(\(run\)\s*=>\s*\{\s*if\s*\(run\)\s*\{\s*applyChatRunUpdate\(run\);/);
  assert.doesNotMatch(source, /setPersistedActiveChatRun/);
  assert.match(source, /setActiveConversationRuns\(\(current\)\s*=>\s*\(\{\s*\.\.\.current,/);
  assert.doesNotMatch(source, /\|\|\s*chatRunActive\s*\|\|/);
  assert.match(source, /clearActiveRunState\(runId\)/);
  assert.match(source, /clearActiveRunState\(undefined,\s*conversationId\)/);

  const viewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  assert.match(viewSource, /isSending=\{activeConversationRunActive\}/);
});
