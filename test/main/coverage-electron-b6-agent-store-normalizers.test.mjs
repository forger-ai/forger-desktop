import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const normalizers = require('../../dist-electron/main/personal-agents/agent-store-normalizers.js');

test('personal-agent persistence normalizers reject malformed grants and merge only valid bounded authority', () => {
  assert.equal(normalizers.sanitizeText(7, 10), '');
  assert.equal(normalizers.sanitizeText('  abcdef  ', 3), 'abc');
  assert.equal(normalizers.sanitizeAgentId('valid_agent-1'), 'valid_agent-1');
  assert.equal(normalizers.sanitizeAgentId('not valid'), null);
  assert.equal(normalizers.sanitizeGrantTarget(' app.read '), 'app.read');
  assert.equal(normalizers.sanitizeGrantTarget([]), null);
  assert.deepEqual(normalizers.normalizeGrantTargets(null), []);
  assert.deepEqual(normalizers.normalizeGrantTargets(['read', 'read', 'bad target', 7]), ['read']);

  assert.deepEqual(normalizers.normalizeConnectionGrants(null), []);
  assert.deepEqual(normalizers.normalizeConnectionGrants([
    null,
    [],
    { type: '', actions: ['read'] },
    { type: 'gmail', actions: [] },
    { type: 'gmail', actions: ['read'], multiple: false },
    { type: 'gmail', actions: ['write'], multiple: true },
    { type: 'gmail', actions: ['read'], connectionIds: ['account-1'] },
    { type: 'gmail', actions: ['write'], connectionIds: ['account-1'] },
    { type: 'gmail', actions: ['write'], connectionIds: ['account-1', 'account-2'] },
  ]), [
    { type: 'gmail', actions: ['read', 'write'], multiple: true },
    {
      type: 'gmail', actions: ['read', 'write'], multiple: false,
      connectionIds: ['account-1'],
    },
    {
      type: 'gmail', actions: ['write'], multiple: false,
      connectionIds: ['account-1', 'account-2'],
    },
  ]);

  assert.deepEqual(normalizers.normalizePeerGrants(null), []);
  assert.deepEqual(normalizers.normalizePeerGrants([
    null,
    [],
    { agentId: 'bad id' },
    { agentId: 'peer-1', criteria: ' first ' },
    { agentId: 'peer-1', criteria: ' latest ' },
  ]), [{ agentId: 'peer-1', criteria: 'latest' }]);

  const encoded = normalizers.encodeConnectionGrant({ type: 'gmail', actions: ['read'], multiple: false });
  assert.deepEqual(normalizers.decodeConnectionGrant(encoded), { type: 'gmail', actions: ['read'], multiple: false });
  assert.equal(normalizers.decodeConnectionGrant(null), null);
  assert.equal(normalizers.decodeConnectionGrant('  '), null);
  assert.equal(normalizers.decodeConnectionGrant('{bad'), null);
});

test('personal-agent runtime, message and file normalization keeps public state canonical', () => {
  assert.equal(normalizers.normalizeMessageText('  multiple\n spaces  '), 'multiple spaces');
  assert.equal(normalizers.isDuplicateFinalProgress('Done', null), false);
  assert.equal(normalizers.isDuplicateFinalProgress('Done', ' Done '), true);
  const prefix = 'x'.repeat(80);
  assert.equal(normalizers.isDuplicateFinalProgress(`${prefix} complete`, `${prefix}...`), true);
  assert.equal(normalizers.isDuplicateFinalProgress('short final', 'short...'), false);
  assert.equal(normalizers.statementChanges(null), 0);
  assert.equal(normalizers.statementChanges({ changes: '1' }), 0);
  assert.equal(normalizers.statementChanges({ changes: 2 }), 2);

  assert.equal(normalizers.normalizePermissionMode('unsafe'), 'unsafe');
  assert.equal(normalizers.normalizePermissionMode('other'), 'safe');
  for (const provider of ['codex', 'claude', 'antigravity']) {
    assert.equal(normalizers.normalizeAgentProvider(provider), provider);
  }
  assert.equal(normalizers.normalizeAgentProvider('other'), null);
  assert.equal(normalizers.normalizeAgentRuntime(null), undefined);
  assert.equal(normalizers.normalizeAgentRuntime({ provider: 'codex', model: '', effort: 'high' }), undefined);
  assert.deepEqual(normalizers.normalizeAgentRuntime({ provider: 'codex', model: ' gpt ', effort: ' high ' }), {
    provider: 'codex', model: 'gpt', effort: 'high',
  });
  assert.deepEqual(normalizers.normalizeAgentRuntime({
    provider: 'claude', model: 'sonnet', effort: 'medium', permissionMode: 'unsafe',
  }), { provider: 'claude', model: 'sonnet', effort: 'medium', permissionMode: 'unsafe' });

  assert.equal(normalizers.normalizeMessageRole('assistant'), 'assistant');
  assert.equal(normalizers.normalizeMessageRole('system'), 'system');
  assert.equal(normalizers.normalizeMessageRole('other'), 'user');
  assert.equal(normalizers.normalizeMessageKind('intermediate'), 'intermediate');
  assert.equal(normalizers.normalizeMessageKind('spoken'), 'spoken');
  assert.equal(normalizers.normalizeMessageKind('other'), 'message');
  assert.equal(normalizers.normalizeMessageAuthorType('agent'), 'agent');
  assert.equal(normalizers.normalizeMessageAuthorType('system'), 'system');
  assert.equal(normalizers.normalizeMessageAuthorType('other', 'system'), 'system');
  assert.equal(normalizers.normalizeMessageAuthorType('other', 'assistant'), 'agent');
  assert.equal(normalizers.normalizeMessageAuthorType('other', 'user'), 'human');
  assert.equal(normalizers.normalizeSharedFileSource('attached'), 'attached');
  assert.equal(normalizers.normalizeSharedFileSource('mentioned'), 'mentioned');
  assert.equal(normalizers.normalizeSharedFileSource('other'), undefined);

  assert.deepEqual(normalizers.normalizeSharedFileRefs(null), []);
  assert.deepEqual(normalizers.normalizeSharedFileRefs([
    null,
    [],
    { path: '   ' },
    { path: ' /shared/minimal.txt ' },
    {
      path: '/shared/full.txt', id: ' file-1 ', name: ' Full ', relativePath: ' docs/full.txt ',
      sizeBytes: -1.2, modifiedAt: ' 2026-01-01 ', source: 'mentioned',
    },
    { path: '/shared/invalid.txt', sizeBytes: Number.NaN, source: 'invalid' },
  ]), [
    { path: '/shared/minimal.txt' },
    {
      path: '/shared/full.txt', id: 'file-1', name: 'Full', relativePath: 'docs/full.txt',
      sizeBytes: 0, modifiedAt: '2026-01-01', source: 'mentioned',
    },
    { path: '/shared/invalid.txt' },
  ]);
});

test('personal-agent row conversion preserves stable enums and safely migrates legacy permissions', () => {
  for (const value of ['agent', 'routine', 'sidekick']) assert.equal(normalizers.normalizeConversationOrigin(value), value);
  assert.equal(normalizers.normalizeConversationOrigin('other'), 'user');
  assert.equal(normalizers.normalizeConversationStatus('archived'), 'archived');
  assert.equal(normalizers.normalizeConversationStatus('other'), 'active');
  for (const value of ['routine', 'scheduled_wakeup', 'sidekick']) assert.equal(normalizers.normalizeMessageSource(value), value);
  assert.equal(normalizers.normalizeMessageSource('other'), 'human');
  for (const value of ['failed', 'completed']) assert.equal(normalizers.normalizePeerThreadStatus(value), value);
  assert.equal(normalizers.normalizePeerThreadStatus('other'), 'active');
  for (const value of ['running', 'needs_permission', 'completed', 'failed', 'canceled']) {
    assert.equal(normalizers.normalizeRunStatus(value), value);
  }
  assert.equal(normalizers.normalizeRunStatus('other'), 'queued');
  for (const value of ['running', 'succeeded', 'failed', 'skipped']) assert.equal(normalizers.normalizeRoutineRunStatus(value), value);
  assert.equal(normalizers.normalizeRoutineRunStatus('other'), 'queued');
  assert.equal(normalizers.normalizeWakeupStatus('fired'), 'fired');
  assert.equal(normalizers.normalizeWakeupStatus('canceled'), 'canceled');
  assert.equal(normalizers.normalizeWakeupStatus('other'), 'scheduled');
  assert.equal(normalizers.isTerminalRunStatus('completed'), true);
  assert.equal(normalizers.isTerminalRunStatus('failed'), true);
  assert.equal(normalizers.isTerminalRunStatus('canceled'), true);
  assert.equal(normalizers.isTerminalRunStatus('running'), false);
  assert.equal(normalizers.deriveTitle('one two three four five six seven eight nine'), 'one two three four five six seven eight');

  assert.equal(normalizers.isLegacyWorkspacePrompt('This is the private workspace for this personal Forger agent.'), true);
  assert.equal(normalizers.isLegacyWorkspacePrompt('# Who\nShort legacy prompt'), true);
  assert.equal(normalizers.isLegacyWorkspacePrompt('Modern prompt'), false);

  assert.deepEqual(normalizers.parsePermissionGrant({ kind: 'app', target_id: 'finance-os', permission: 'old' }), {
    kind: 'app', targetId: 'finance-os', permission: 'app:finance-os',
  });
  assert.deepEqual(normalizers.parsePermissionGrant({ kind: 'connection', target_id: ' gmail:* ', permission: 'old' }), {
    kind: 'connection', targetId: ' gmail:* ', permission: 'connection: gmail:* ',
  });
  assert.deepEqual(normalizers.parsePermissionGrant({ permission: 'app:finance-os' }), {
    kind: 'app', targetId: 'finance-os', permission: 'app:finance-os',
  });
  assert.deepEqual(normalizers.parsePermissionGrant({ permission: 'app:' }), {
    kind: 'legacy', targetId: 'app:', permission: 'app:',
  });
  assert.deepEqual(normalizers.parsePermissionGrant({ permission: 'tool:browser.open' }), {
    kind: 'tool', targetId: 'browser.open', permission: 'tool:browser.open',
  });
  assert.deepEqual(normalizers.parsePermissionGrant({ permission: 'tool:' }), {
    kind: 'legacy', targetId: 'tool:', permission: 'tool:',
  });
  assert.deepEqual(normalizers.parsePermissionGrant({ permission: 'bad permission' }), {
    kind: 'legacy', targetId: 'unknown', permission: 'unknown',
  });

  const row = {
    id: 'permission-1', agent_id: 'agent-1', permission: 'app:finance-os', mode: 'unsafe', granted: 0,
    created_at: 'created', updated_at: 'updated',
  };
  assert.deepEqual(normalizers.permissionFromRow(row), {
    id: 'permission-1', agentId: 'agent-1', kind: 'app', targetId: 'finance-os',
    permission: 'app:finance-os', mode: 'unsafe', granted: false, createdAt: 'created', updatedAt: 'updated',
  });
  assert.deepEqual(normalizers.runProgressFromRow({
    id: 'progress-1', agent_id: 'agent-1', conversation_id: 'conversation-1', run_id: 'run-1',
    message: 'Working', created_at: 'created',
  }), {
    id: 'progress-1', agentId: 'agent-1', conversationId: 'conversation-1', runId: 'run-1',
    message: 'Working', createdAt: 'created',
  });
  assert.deepEqual(normalizers.memoryFromRow({
    id: 'memory-1', agent_id: 'agent-1', remember_when: 'when useful', title: 'Preference',
    content: 'Concise', created_at: 'created', updated_at: 'updated',
  }), {
    id: 'memory-1', agentId: 'agent-1', rememberWhen: 'when useful', title: 'Preference',
    content: 'Concise', createdAt: 'created', updatedAt: 'updated',
  });
  assert.deepEqual(normalizers.journalEntryFromRow({
    id: 'journal-1', agent_id: 'agent-1', conversation_id: null, body: 'Note', created_at: 'created',
  }), { id: 'journal-1', agentId: 'agent-1', body: 'Note', createdAt: 'created' });
});
