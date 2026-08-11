import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');

const createHarness = async (label) => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), `forger-b16-${label}-meta-`));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), `forger-b16-${label}-home-`));
  return {
    metadataRoot,
    forgerHomeRoot,
    store: new AgentStore({ metadataRoot, forgerHomeRoot }),
  };
};

test('BDD: invalid agent input and explicit permission changes fail safely or persist their normalized state', async () => {
  const { store } = await createHarness('agents');
  await assert.rejects(store.createAgent({ name: '   ' }), /personal_agent_name_required/);

  const group = await store.createGroup({ name: 'Reviewers' });
  const agent = await store.createAgent({ name: 'Reviewer', networkAccess: true, canSpawnAgents: true });
  const grouped = await store.updateAgentPermissions({
    agentId: agent.id,
    groupId: group.id,
    networkAccess: false,
    canSpawnAgents: false,
    runtime: null,
  });
  assert.equal(grouped.groupId, group.id);
  assert.equal(grouped.networkAccess, false);
  assert.equal(grouped.canSpawnAgents, false);
  assert.equal(grouped.runtime, undefined);
  assert.equal((await store.updateAgentPermissions({ agentId: agent.id, networkAccess: true })).networkAccess, true);
  const ungrouped = await store.updateAgentPermissions({ agentId: agent.id, groupId: null });
  assert.equal(ungrouped.groupId, undefined);
  assert.equal(await store.getPeerGrant(agent.id, 'not a valid id'), null);

  const now = new Date().toISOString();
  store.db.prepare(`
    INSERT INTO personal_agents (id, name, description, purpose, instructions, permission_mode, network_access, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('bad id', 'Ignored', 'Ignored invalid identifier', '', '', 'safe', 0, now, now);
  store.db.prepare(`
    INSERT INTO personal_agents (id, name, description, purpose, instructions, permission_mode, network_access, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('fallback-name', '', '', '', '', 'safe', 0, now, now);
  const heartbeat = await store.getHeartbeatSummary();
  assert.equal(heartbeat.ids.includes('bad id'), false);
  assert.deepEqual(heartbeat.agents.find((item) => item.id === 'fallback-name'), { id: 'fallback-name', name: 'fallback-name' });
});

test('BDD: peer thread validation, lookup, nesting, status, and concurrent disappearance stay bounded', async () => {
  const { store } = await createHarness('peers');
  const caller = await store.createAgent({ name: 'Caller' });
  const target = await store.createAgent({ name: 'Target' });
  const outsider = await store.createAgent({ name: 'Outsider' });
  const callerConversation = await store.createConversation({ agentId: caller.id, title: 'Caller thread' });
  const targetConversation = await store.createConversation({ agentId: target.id, title: 'Target thread' });
  const outsiderConversation = await store.createConversation({ agentId: outsider.id, title: 'Outsider thread' });

  await assert.rejects(store.createPeerThread({
    callerAgentId: caller.id,
    targetAgentId: caller.id,
    sourceConversationId: callerConversation.id,
    targetConversationId: callerConversation.id,
  }), /personal_agent_peer_self_call_blocked/);
  await assert.rejects(store.createPeerThread({
    callerAgentId: caller.id,
    targetAgentId: target.id,
    sourceConversationId: targetConversation.id,
    targetConversationId: targetConversation.id,
  }), /personal_agent_peer_source_conversation_mismatch/);
  await assert.rejects(store.createPeerThread({
    callerAgentId: caller.id,
    targetAgentId: target.id,
    sourceConversationId: callerConversation.id,
    targetConversationId: outsiderConversation.id,
  }), /personal_agent_peer_target_conversation_mismatch/);
  await assert.rejects(store.createPeerThread({
    callerAgentId: caller.id,
    targetAgentId: target.id,
    sourceConversationId: callerConversation.id,
    targetConversationId: targetConversation.id,
    parentThreadId: 'missing-parent',
  }), /personal_agent_peer_parent_thread_not_found/);

  const thread = await store.createPeerThread({
    callerAgentId: caller.id,
    targetAgentId: target.id,
    sourceConversationId: callerConversation.id,
    targetConversationId: targetConversation.id,
    createdByRunId: 'not a run id',
    title: ' ',
  });
  assert.equal(thread.title, 'Caller -> Target');
  assert.equal(thread.createdByRunId, null);
  assert.equal((await store.getPeerThreadByTargetConversation(targetConversation.id)).id, thread.id);
  assert.equal(await store.getPeerThreadByTargetConversation('missing-conversation'), null);
  assert.equal(await store.getPeerThread('not a valid id'), null);
  assert.equal(await store.getPeerThread('missing-thread'), null);
  assert.equal((await store.updatePeerThreadStatus({ threadId: thread.id, status: 'completed' })).status, 'completed');
  await assert.rejects(
    store.updatePeerThreadStatus({ threadId: 'missing-thread', status: 'failed' }),
    /personal_agent_peer_thread_not_found/,
  );
  await assert.rejects(
    store.listPeerThreadsForConversation({ agentId: outsider.id, conversationId: callerConversation.id }),
    /personal_agent_conversation_mismatch/,
  );
  await assert.rejects(
    store.requirePeerThreadAccess({ agentId: caller.id, threadId: 'missing-thread' }),
    /personal_agent_peer_thread_not_found/,
  );

  const originalLookup = store.peerThreadRowById.bind(store);
  store.peerThreadRowById = () => null;
  const concurrentTarget = await store.createConversation({ agentId: target.id, title: 'Concurrent target' });
  await assert.rejects(store.createPeerThread({
    callerAgentId: caller.id,
    targetAgentId: target.id,
    sourceConversationId: callerConversation.id,
    targetConversationId: concurrentTarget.id,
  }), /personal_agent_peer_thread_not_found/);
  store.peerThreadRowById = originalLookup;

  let statusLookupCount = 0;
  store.peerThreadRowById = (threadId) => {
    statusLookupCount += 1;
    return statusLookupCount === 1 ? originalLookup(threadId) : null;
  };
  await assert.rejects(
    store.updatePeerThreadStatus({ threadId: thread.id, status: 'active' }),
    /personal_agent_peer_thread_not_found/,
  );
  store.peerThreadRowById = originalLookup;

  store.db.prepare('UPDATE personal_agent_conversations SET initiator_agent_id = NULL, peer_thread_id = NULL WHERE id = ?').run(targetConversation.id);
  const recovered = await store.requireConversation(targetConversation.id);
  assert.equal(recovered.initiatorAgentId, caller.id);
  assert.equal(recovered.peerThreadId, thread.id);

  store.db.prepare('UPDATE personal_agents SET name = ?, description = ? WHERE id = ?').run('', '', target.id);
  await store.updateAgentPermissions({
    agentId: caller.id,
    peerAgentGrants: [{ agentId: target.id, criteria: 'Delegate exact target work.' }],
  });
  assert.deepEqual(await store.listPeerGrants(caller.id), [{
    agentId: target.id,
    criteria: 'Delegate exact target work.',
    createdAt: (await store.listPeerGrants(caller.id))[0].createdAt,
    updatedAt: (await store.listPeerGrants(caller.id))[0].updatedAt,
  }]);
  store.db.prepare('UPDATE personal_agents SET name = ? WHERE id = ?').run('', caller.id);
  const unnamedThread = await store.getPeerThread(thread.id);
  assert.equal(unnamedThread.callerAgentName, undefined);
  assert.equal(unnamedThread.targetAgentName, undefined);

  store.db.exec('PRAGMA foreign_keys = OFF');
  store.db.prepare('UPDATE personal_agent_conversations SET initiator_agent_id = ? WHERE id = ?').run('missing-agent', targetConversation.id);
  store.db.exec('PRAGMA foreign_keys = ON');
  const missingInitiatorName = await store.requireConversation(targetConversation.id);
  assert.equal(missingInitiatorName.initiatorAgentId, 'missing-agent');
  assert.equal(missingInitiatorName.initiatorAgentName, undefined);
});

test('BDD: conversation, routine, message, run, memory, and journal boundaries expose safe errors', async () => {
  const { store } = await createHarness('records');
  const agent = await store.createAgent({ name: 'Records' });
  const other = await store.createAgent({ name: 'Other' });
  const conversation = await store.createConversation({ agentId: agent.id, title: 'Record thread' });
  const otherConversation = await store.createConversation({ agentId: other.id, title: 'Other thread' });

  await assert.rejects(
    store.createConversation({ agentId: agent.id, origin: 'sidekick', sidekickId: ' ' }),
    /personal_agent_sidekick_id_required/,
  );
  await assert.rejects(
    store.updateConversationTitle({ conversationId: conversation.id, title: ' ' }),
    /personal_agent_conversation_title_required/,
  );
  assert.equal((await store.updateConversationTitle({ conversationId: conversation.id, title: 'Renamed' })).title, 'Renamed');
  assert.equal((await store.updateConversationProviderThread({ conversationId: conversation.id, providerThreadId: 'provider-1' })).providerThreadId, 'provider-1');
  assert.equal((await store.updateConversationProviderThread({ conversationId: conversation.id, providerThreadId: null })).providerThreadId, undefined);
  assert.equal(await store.getConversation('missing-conversation'), null);
  assert.equal(await store.findLatestSidekickConversation({ sidekickId: 'bad id', agentId: agent.id }), null);
  assert.equal(await store.findLatestSidekickConversation({ sidekickId: 'desk', agentId: other.id }), null);
  await assert.rejects(store.requireConversation('missing-conversation'), /personal_agent_conversation_not_found/);

  await assert.rejects(store.addMessage({
    agentId: agent.id, conversationId: conversation.id, role: 'user', content: ' ',
  }), /personal_agent_message_required/);
  await assert.rejects(store.addMessage({
    agentId: other.id, conversationId: conversation.id, role: 'user', content: 'Mismatch',
  }), /personal_agent_conversation_mismatch/);
  const withFallbackFile = await store.addMessage({
    agentId: agent.id,
    conversationId: conversation.id,
    role: 'user',
    content: 'Attached',
    files: [{ path: '/tmp/example.txt', name: ' ', relativePath: ' ', sizeBytes: Number.NaN }],
  });
  assert.deepEqual(withFallbackFile.files.map((file) => ({
    name: file.name,
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    source: file.source,
  })), [{ name: 'example.txt', relativePath: 'example.txt', sizeBytes: undefined, source: undefined }]);
  const loadedWithFallbackFile = await store.requireConversation(conversation.id);
  assert.equal('sizeBytes' in loadedWithFallbackFile.messages.at(-1).files[0], false);
  assert.equal('source' in loadedWithFallbackFile.messages.at(-1).files[0], false);

  const run = await store.createRun({ agentId: agent.id, conversationId: conversation.id });
  assert.equal(await store.deleteDuplicateRunProgress({ runId: run.id, finalContent: ' ' }), 0);
  await assert.rejects(
    store.createRun({ agentId: other.id, conversationId: conversation.id }),
    /personal_agent_conversation_mismatch/,
  );
  await assert.rejects(
    store.createRun({ agentId: agent.id, conversationId: conversation.id }),
    /personal_agent_run_active/,
  );
  await assert.rejects(store.addRunProgress({ runId: run.id, message: ' ' }), /personal_agent_run_progress_required/);
  await assert.rejects(store.updateRunStatus({ runId: 'missing-run', status: 'failed' }), /personal_agent_run_not_found/);
  assert.equal(await store.getRun('missing-run'), null);
  assert.equal((await store.updateRunStatus({ runId: run.id, status: 'failed', error: 'runner failed' })).error, 'runner failed');

  await assert.rejects(store.createMemory({ agentId: agent.id, content: ' ' }), /personal_agent_memory_required/);
  assert.equal((await store.createMemory({ agentId: agent.id, title: ' ', content: 'Remember the decision.' })).title, 'Remember the decision.');
  await assert.rejects(store.createJournalEntry({
    agentId: agent.id, conversationId: otherConversation.id, body: 'Mismatch',
  }), /personal_agent_conversation_mismatch/);
  await assert.rejects(store.createJournalEntry({ agentId: agent.id, body: ' ' }), /personal_agent_journal_entry_required/);
  const journal = await store.createJournalEntry({ agentId: agent.id, body: 'Standalone entry.' });
  assert.equal(journal.conversationId, undefined);

  const routine = await store.createRoutine({
    agentId: agent.id,
    name: 'Daily record',
    prompt: 'Review records.',
    frequency: { type: 'daily', hour: 9, minute: 0 },
    missedRunPolicy: 'skip',
    enabled: false,
    nextRunAt: null,
    authorizationText: 'Approved by the person.',
  });
  assert.equal((await store.updateRoutine({
    routineId: routine.id,
    name: 'Updated record',
    prompt: 'Review updated records.',
    frequency: { type: 'hourly' },
    missedRunPolicy: 'always',
    enabled: true,
    nextRunAt: new Date().toISOString(),
    authorizationText: 'Still approved.',
  })).name, 'Updated record');
  assert.deepEqual(await store.deleteRoutine(routine.id), { success: true });
});

test('BDD: workspace reads and writes reject directories, oversized files, escaped symlinks, and missing roots', async () => {
  const { store, forgerHomeRoot } = await createHarness('workspace');
  const agent = await store.createAgent({ name: 'Workspace guard' });
  const workspaceRoot = path.join(forgerHomeRoot, 'agents', agent.id, 'workspace');
  const directoryPath = path.join(workspaceRoot, 'folder');
  await mkdir(directoryPath);
  assert.equal((await store.listWorkspace(agent.id)).some((entry) => entry.name === 'folder'), true);
  await assert.rejects(
    store.readWorkspaceTextFile({ agentId: agent.id, relativePath: 'folder' }),
    /personal_agent_workspace_file_required/,
  );
  await assert.rejects(
    store.writeWorkspaceTextFile({ agentId: agent.id, relativePath: 'folder', content: 'content' }),
    /personal_agent_workspace_file_required/,
  );

  const oversized = 'x'.repeat(256 * 1024 + 1);
  await writeFile(path.join(workspaceRoot, 'large.txt'), oversized, 'utf8');
  await assert.rejects(
    store.readWorkspaceTextFile({ agentId: agent.id, relativePath: 'large.txt' }),
    /personal_agent_workspace_file_too_large/,
  );
  await assert.rejects(
    store.writeWorkspaceTextFile({ agentId: agent.id, relativePath: 'WHO.md', content: oversized }),
    /personal_agent_workspace_file_too_large/,
  );

  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'forger-b16-outside-'));
  await writeFile(path.join(outsideRoot, 'secret.txt'), 'outside', 'utf8');
  await symlink(path.join(outsideRoot, 'secret.txt'), path.join(workspaceRoot, 'escape.txt'));
  await assert.rejects(
    store.readWorkspaceTextFile({ agentId: agent.id, relativePath: 'escape.txt' }),
    /personal_agent_workspace_path_outside_root/,
  );

  const originalEnsureWorkspace = store.ensureWorkspace.bind(store);
  store.ensureWorkspace = async () => undefined;
  await rm(workspaceRoot, { recursive: true });
  await assert.rejects(store.workspaceRootForAgent(agent.id), /personal_agent_workspace_missing/);
  store.ensureWorkspace = originalEnsureWorkspace;
});

test('BDD: workspace synchronization handles absent, blank, legacy-empty, and unreadable managed files', async () => {
  const { store, forgerHomeRoot } = await createHarness('workspace-sync');
  const agent = await store.createAgent({ name: 'Workspace sync' });
  const workspaceRoot = path.join(forgerHomeRoot, 'agents', agent.id, 'workspace');
  const othersPath = path.join(workspaceRoot, 'OTHERS.md');

  await rm(othersPath);
  await store.updateAgentPermissions({ agentId: agent.id, canSpawnAgents: true });
  assert.match(await readFile(othersPath, 'utf8'), /Create other agents: enabled/);

  await writeFile(othersPath, '   ', 'utf8');
  await store.updateAgentPermissions({ agentId: agent.id, canSpawnAgents: false });
  assert.match(await readFile(othersPath, 'utf8'), /Create other agents: disabled/);

  await writeFile(othersPath, `This file defines how \`Workspace sync\` collaborates.\n\n## Source Of Truth\n\n## What To Record Here\n\nRecord only reusable collaboration rules that help future runs, such as:\n`, 'utf8');
  await store.updateAgentPermissions({ agentId: agent.id, canSpawnAgents: true });
  assert.match(await readFile(othersPath, 'utf8'), /Forger-Managed Agent Tools Configuration/);

  const whyPath = path.join(workspaceRoot, 'WHY.md');
  await rm(whyPath);
  await mkdir(whyPath);
  await assert.rejects(store.workspaceRootForAgent(agent.id), /EISDIR|illegal operation on a directory/i);
  await rm(whyPath, { recursive: true });
  await writeFile(whyPath, 'Restored.', 'utf8');

  await rm(othersPath);
  await mkdir(othersPath);
  await assert.rejects(
    store.updateAgentPermissions({ agentId: agent.id, canSpawnAgents: false }),
    /EISDIR|illegal operation on a directory/i,
  );
});

test('BDD: unavailable SQLite and an invalid loaded state surface stable store errors', async () => {
  const { metadataRoot, forgerHomeRoot } = await createHarness('sqlite-unavailable');
  await mkdir(path.join(metadataRoot, 'personal-agents.sqlite'));
  const unavailable = new AgentStore({ metadataRoot, forgerHomeRoot });
  await assert.rejects(unavailable.listAgents(), /personal_agent_sqlite_unavailable/);

  const corruptState = new AgentStore({ metadataRoot: path.join(metadataRoot, 'other'), forgerHomeRoot });
  corruptState.loadPromise = Promise.resolve();
  await assert.rejects(corruptState.listAgents(), /personal_agent_store_not_loaded/);
});

test('BDD: a failed peer grant rolls back the newly spawned agent', async () => {
  const { store } = await createHarness('spawn-rollback');
  const creator = await store.createAgent({ name: 'Creator', canSpawnAgents: true });
  store.grantPeer = async () => { throw new Error('peer-grant-failed'); };
  await assert.rejects(
    store.createAgentFromAgent({ creatorAgentId: creator.id, name: 'Rolled back child' }),
    /peer-grant-failed/,
  );
  assert.deepEqual((await store.listAgents()).map((agent) => agent.id), [creator.id]);
});
