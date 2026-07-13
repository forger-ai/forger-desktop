import assert from 'node:assert/strict';
import test from 'node:test';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');
const { AgentRoutineManager } = require('../../dist-electron/main/personal-agents/agent-routine-manager.js');
const { openPersonalAgentSqliteDatabase } = require('../../dist-electron/main/personal-agents/sqlite.js');

const sortConnectionGrants = (grants) => [...grants].sort((left, right) => left.type.localeCompare(right.type));

test('personal agent store creates SQLite-backed agents with safe defaults and private workspace docs', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });

  const agent = await store.createAgent({
    name: 'Research partner',
    description: 'Helps review source material',
    purpose: 'Keep research threads organized.',
  });

  assert.equal(agent.name, 'Research partner');
  assert.equal(agent.permissionMode, 'safe');
  assert.equal(agent.networkAccess, false);
  assert.deepEqual(agent.appIds, []);
  assert.deepEqual(agent.toolIds, []);
  assert.deepEqual(agent.connectionGrants, []);
  assert.equal(Object.prototype.hasOwnProperty.call(agent, 'workspacePath'), false);
  assert.deepEqual(await store.getHeartbeatSummary(), {
    supported: true,
    count: 1,
    ids: [agent.id],
    agents: [{ id: agent.id, name: 'Research partner', description: 'Helps review source material' }],
  });

  const permissions = await store.listPermissions(agent.id);
  assert.deepEqual(
    permissions.map((permission) => [permission.permission, permission.granted, permission.mode]),
    [['network_access', false, 'safe']],
  );

  const workspaceRoot = path.join(forgerHomeRoot, 'agents', agent.id, 'workspace');
  const workspaceFiles = await readdir(workspaceRoot);
  assert.deepEqual(workspaceFiles.sort(), ['.agents', '.claude', 'AGENTS.md', 'HOW.md', 'HUMAN.md', 'OTHERS.md', 'WHO.md', 'WHY.md']);
  const agentSkillDirs = (await readdir(path.join(workspaceRoot, '.agents', 'skills'))).sort();
  const claudeSkillDirs = (await readdir(path.join(workspaceRoot, '.claude', 'skills'))).sort();
  assert.ok(agentSkillDirs.includes('forger-context'));
  assert.ok(agentSkillDirs.includes('forger-installed-app-change'));
  assert.ok(agentSkillDirs.includes('forger-manifest-authoring'));
  assert.ok(agentSkillDirs.includes('forger-memory'));
  assert.ok(agentSkillDirs.includes('forger-personal-agent-tools'));
  assert.ok(agentSkillDirs.includes('forger-speech-to-text'));
  assert.ok(agentSkillDirs.includes('ui-ux-pro-max'));
  assert.deepEqual(claudeSkillDirs, agentSkillDirs);
  assert.equal(agentSkillDirs.includes('forger-app-official-tools'), false);
  assert.equal(agentSkillDirs.includes('load-movements'), false);
  await access(path.join(workspaceRoot, '.agents', 'skills', 'ui-ux-pro-max', 'scripts', 'search.py'));
  await access(path.join(workspaceRoot, '.claude', 'skills', 'ui-ux-pro-max', 'data', 'products.csv'));
  const agentsMd = await readFile(path.join(workspaceRoot, 'AGENTS.md'), 'utf8');
  const whoMd = await readFile(path.join(workspaceRoot, 'WHO.md'), 'utf8');
  const whyMd = await readFile(path.join(workspaceRoot, 'WHY.md'), 'utf8');
  const howMd = await readFile(path.join(workspaceRoot, 'HOW.md'), 'utf8');
  const humanMd = await readFile(path.join(workspaceRoot, 'HUMAN.md'), 'utf8');
  const othersMd = await readFile(path.join(workspaceRoot, 'OTHERS.md'), 'utf8');
  assert.match(agentsMd, /FORGER_PERSONAL_AGENT_PROMPT_VERSION: 1/);
  assert.match(agentsMd, /WHO\.md/);
  assert.match(agentsMd, /WHY\.md/);
  assert.match(agentsMd, /HOW\.md/);
  assert.match(agentsMd, /HUMAN\.md/);
  assert.match(agentsMd, /OTHERS\.md/);
  assert.match(agentsMd, /The companion files are not templates to preserve/);
  assert.match(agentsMd, /replace bootstrap placeholders, empty defaults, examples, and instructional filler with concise notes/);
  assert.match(agentsMd, /Remove template\/example sections once they have served their purpose and real content exists/);
  assert.match(whoMd, /Research partner/);
  assert.match(whyMd, /Keep research threads organized/);
  assert.match(whoMd, /not a preserved template/);
  assert.match(whyMd, /remove bootstrap questions and example scaffolding/);
  assert.match(howMd, /does not grant tools/);
  assert.match(howMd, /Remove example scaffolding once real procedures or solved-error notes exist/);
  assert.match(humanMd, /not a private dossier/);
  assert.match(humanMd, /remove placeholder text and keep only concise notes/);
  assert.match(othersMd, /Editing the manual part of this file never grants/);
  assert.match(othersMd, /Forger-managed configuration block/);
  assert.match(othersMd, /Durable Collaboration Criteria/);
  assert.match(othersMd, /Create other agents: disabled/);
  assert.match(othersMd, /Contact other agents: disabled/);
  await writeFile(path.join(workspaceRoot, 'notes.txt'), 'Visible note.', 'utf8');
  const workspaceTree = await store.listWorkspace(agent.id);
  assert.deepEqual(
    workspaceTree.map((entry) => [entry.name, entry.relativePath, entry.kind]),
    [
      ['AGENTS.md', 'AGENTS.md', 'file'],
      ['HOW.md', 'HOW.md', 'file'],
      ['HUMAN.md', 'HUMAN.md', 'file'],
      ['notes.txt', 'notes.txt', 'file'],
      ['OTHERS.md', 'OTHERS.md', 'file'],
      ['WHO.md', 'WHO.md', 'file'],
      ['WHY.md', 'WHY.md', 'file'],
    ],
  );
  const note = await store.readWorkspaceTextFile({ agentId: agent.id, relativePath: 'notes.txt' });
  assert.equal(note.content, 'Visible note.');
  const savedNote = await store.writeWorkspaceTextFile({
    agentId: agent.id,
    relativePath: 'notes.txt',
    content: 'Updated note.',
  });
  assert.equal(savedNote.content, 'Updated note.');
  await assert.rejects(
    store.readWorkspaceTextFile({ agentId: agent.id, relativePath: '../outside.txt' }),
    /personal_agent_workspace_path_outside_root/,
  );

  const reloaded = new AgentStore({ metadataRoot, forgerHomeRoot });
  assert.deepEqual((await reloaded.listAgents()).map((item) => item.id), [agent.id]);
  assert.deepEqual(await reloaded.deleteAgent(agent.id), { success: true });
  assert.deepEqual(await reloaded.listAgents(), []);
  await assert.rejects(access(path.join(forgerHomeRoot, 'agents', agent.id)), /ENOENT/);
});

test('personal agent store migrates a v1 OTHERS workspace without losing durable user criteria', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-others-v1-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-others-v1-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const agent = await store.createAgent({ name: 'Migration keeper', canSpawnAgents: true });
  const workspaceRoot = path.join(forgerHomeRoot, 'agents', agent.id, 'workspace');
  const othersPath = path.join(workspaceRoot, 'OTHERS.md');

  await writeFile(othersPath, `<!-- FORGER_PERSONAL_AGENT_PROMPT_VERSION: 1 -->
# OTHERS

This file defines how \`Migration keeper\` decides when to communicate with other agents, installed apps, Forger Tools, Connections, external accounts, or people outside the current conversation.

## Current Permission Context

- Permission mode: \`safe\`
- Network access: \`disabled\`

## Source Of Truth

Use this order when deciding whether you may contact or coordinate with another agent, app, tool, service, account, or person:

1. Current explicit human instruction and visible approval.
2. Current Forger allowlist, app grants, tool grants, Connection grants, and runtime approval state.

## Inter-Agent Communication Criteria

Communicate with another agent only when the human explicitly asks or the agent owns required information.

## Approval Boundaries

Ask for explicit confirmation before sending or publishing outside the private workspace.

## What To Record Here

Record only reusable collaboration rules that help future runs, such as:

- Which agents or apps should be consulted for specific recurring topics.
- When a handoff is appropriate or inappropriate.

- Ask the Finance reviewer before approving purchases above USD 500.
- Never share customer transcripts with peer agents.

Do not store secrets, raw sensitive content, private message bodies, account identifiers that are not necessary, or one-off transcript details. Replace stale collaboration rules when the human corrects them.

<!-- FORGER_MANAGED_PEER_AGENTS_BEGIN -->
## Forger-Managed Agent Peers

- No peer agents are currently allowed.
<!-- FORGER_MANAGED_PEER_AGENTS_END -->
`, 'utf8');

  await store.workspaceRootForAgent(agent.id);

  const migrated = await readFile(othersPath, 'utf8');
  assert.match(migrated, /This file keeps the current collaboration configuration/);
  assert.match(migrated, /## Durable Collaboration Criteria/);
  assert.match(migrated, /Ask the Finance reviewer before approving purchases above USD 500/);
  assert.match(migrated, /Never share customer transcripts with peer agents/);
  assert.match(migrated, /Create other agents: enabled/);
  assert.match(migrated, /Contact other agents: disabled/);
  assert.doesNotMatch(migrated, /## Source Of Truth/);
  assert.doesNotMatch(migrated, /## Inter-Agent Communication Criteria/);
  assert.doesNotMatch(migrated, /## Approval Boundaries/);
  assert.equal((migrated.match(/FORGER_MANAGED_PEER_AGENTS_BEGIN/g) ?? []).length, 1);
});

test('personal agent grants persist as explicit app and tool permissions', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-grants-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-grants-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });

  const agent = await store.createAgent({
    name: 'Ops agent',
    networkAccess: true,
    appIds: ['finance-os', 'finance-os', '../bad'],
    toolIds: ['forger_chrome_extension.navigate', '../bad'],
    connectionGrants: [
      { type: 'gmail', actions: ['gmail.search_messages', 'gmail.search_messages'], multiple: true, connectionIds: ['gmail-1', 'gmail-2'] },
      { type: 'slack', actions: ['slack.send_message'], multiple: false, connectionIds: ['slack-1'] },
    ],
  });

  assert.equal(agent.networkAccess, true);
  assert.deepEqual(agent.appIds, ['finance-os']);
  assert.deepEqual([...agent.toolIds].sort(), ['forger_chrome_extension.navigate']);
  assert.deepEqual(sortConnectionGrants(agent.connectionGrants), [
    { type: 'gmail', actions: ['gmail.search_messages'], multiple: true, connectionIds: ['gmail-1', 'gmail-2'] },
    { type: 'slack', actions: ['slack.send_message'], multiple: false, connectionIds: ['slack-1'] },
  ]);

  const updated = await store.updateAgentPermissions({
    agentId: agent.id,
    permissionMode: 'unsafe',
    networkAccess: false,
    appIds: ['focus'],
    toolIds: ['memory_list', 'forger_chrome_extension.get_html'],
    connectionGrants: [
      { type: 'whatsapp', actions: ['whatsapp.read_messages'], multiple: true },
      { type: 'trello', actions: ['trello.create_card'], multiple: false, connectionIds: ['trello-1'] },
    ],
  });
  assert.equal(updated.permissionMode, 'unsafe');
  assert.equal(updated.networkAccess, false);
  assert.deepEqual(updated.appIds, ['focus']);
  assert.deepEqual([...updated.toolIds].sort(), ['forger_chrome_extension.get_html', 'memory_list']);
  assert.deepEqual(sortConnectionGrants(updated.connectionGrants), [
    { type: 'trello', actions: ['trello.create_card'], multiple: false, connectionIds: ['trello-1'] },
    { type: 'whatsapp', actions: ['whatsapp.read_messages'], multiple: true },
  ]);

  const permissions = await store.listPermissions(agent.id);
  assert.deepEqual(
    permissions
      .filter((permission) => permission.kind !== 'legacy')
      .map((permission) => [permission.kind, permission.targetId, permission.granted])
      .sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`)),
    [
      ['app', 'focus', true],
      ['connection', '{"type":"trello","actions":["trello.create_card"],"multiple":false,"connectionIds":["trello-1"]}', true],
      ['connection', '{"type":"whatsapp","actions":["whatsapp.read_messages"],"multiple":true}', true],
      ['tool', 'forger_chrome_extension.get_html', true],
      ['tool', 'memory_list', true],
    ],
  );

  const reloaded = new AgentStore({ metadataRoot, forgerHomeRoot });
  const [persisted] = await reloaded.listAgents();
  assert.deepEqual(persisted.appIds, ['focus']);
  assert.deepEqual([...persisted.toolIds].sort(), ['forger_chrome_extension.get_html', 'memory_list']);
  assert.deepEqual(sortConnectionGrants(persisted.connectionGrants), sortConnectionGrants(updated.connectionGrants));
  assert.deepEqual(await reloaded.deleteAgent(agent.id), { success: true });
  assert.deepEqual(await reloaded.listPermissions(agent.id), []);
});

test('personal agent peer grants, peer threads, message provenance, and attachments persist relationally', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-peer-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-peer-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });

  const planner = await store.createAgent({
    name: 'Planner',
    description: 'Coordinates work.',
  });
  const budget = await store.createAgent({
    name: 'Budget',
    description: 'Reviews numbers.',
  });
  const legal = await store.createAgent({
    name: 'Legal',
    description: 'Checks constraints.',
  });

  const plannerWorkspace = path.join(forgerHomeRoot, 'agents', planner.id, 'workspace');
  const othersPath = path.join(plannerWorkspace, 'OTHERS.md');
  await writeFile(
    othersPath,
    `${await readFile(othersPath, 'utf8')}\n# Manual peer notes\nKeep escalation notes outside the managed block.\n`,
    'utf8',
  );

  const updatedPlanner = await store.updateAgentPermissions({
    agentId: planner.id,
    peerAgentGrants: [
      { agentId: budget.id, criteria: 'Ask for budget forecasts and cost tradeoffs.' },
      { agentId: planner.id, criteria: 'Self grants are ignored.' },
      { agentId: 'missing-agent', criteria: 'Missing agents are ignored.' },
    ],
  });
  await store.updateAgentPermissions({
    agentId: budget.id,
    peerAgentGrants: [
      { agentId: legal.id, criteria: 'Ask about policy or legal constraints.' },
    ],
  });

  assert.deepEqual(
    updatedPlanner.peerAgentGrants.map((grant) => [grant.agentId, grant.name, grant.criteria]),
    [[budget.id, 'Budget', 'Ask for budget forecasts and cost tradeoffs.']],
  );
  assert.deepEqual(
    (await store.listPeerGrants(planner.id)).map((grant) => [grant.agentId, grant.name, grant.description, grant.criteria]),
    [[budget.id, 'Budget', 'Reviews numbers.', 'Ask for budget forecasts and cost tradeoffs.']],
  );
  const othersMd = await readFile(othersPath, 'utf8');
  assert.match(othersMd, /<!-- FORGER_MANAGED_PEER_AGENTS_BEGIN -->/);
  assert.match(othersMd, /Budget/);
  assert.match(othersMd, /Ask for budget forecasts and cost tradeoffs/);
  assert.match(othersMd, /# Manual peer notes/);
  assert.match(othersMd, /Keep escalation notes outside the managed block/);

  const plannerConversation = await store.createConversation({
    agentId: planner.id,
    title: 'Launch plan',
  });
  const budgetConversation = await store.createConversation({
    agentId: budget.id,
    title: 'Budget review',
    origin: 'agent',
    readOnly: true,
    initiatorAgentId: planner.id,
  });
  const plannerRun = await store.createRun({
    agentId: planner.id,
    conversationId: plannerConversation.id,
  });
  const budgetThread = await store.createPeerThread({
    callerAgentId: planner.id,
    targetAgentId: budget.id,
    sourceConversationId: plannerConversation.id,
    targetConversationId: budgetConversation.id,
    createdByRunId: plannerRun.id,
    title: 'Budget review',
  });
  const sharedFilePath = path.join(forgerHomeRoot, 'private-data', 'imports', 'budget.pdf');
  await store.addMessage({
    agentId: budget.id,
    conversationId: budgetConversation.id,
    role: 'user',
    authorType: 'agent',
    authorAgentId: planner.id,
    content: 'Can you review this budget before launch?',
    files: [{
      path: sharedFilePath,
      relativePath: 'imports/budget.pdf',
      name: 'budget.pdf',
      sizeBytes: 2048,
      source: 'attached',
    }],
  });
  await store.addMessage({
    agentId: budget.id,
    conversationId: budgetConversation.id,
    role: 'assistant',
    content: 'Budget looks acceptable if legal confirms the vendor clause.',
  });

  const legalConversation = await store.createConversation({
    agentId: legal.id,
    title: 'Vendor clause',
    origin: 'agent',
    readOnly: true,
    initiatorAgentId: budget.id,
  });
  const budgetRun = await store.createRun({
    agentId: budget.id,
    conversationId: budgetConversation.id,
  });
  const legalThread = await store.createPeerThread({
    callerAgentId: budget.id,
    targetAgentId: legal.id,
    sourceConversationId: budgetConversation.id,
    targetConversationId: legalConversation.id,
    parentThreadId: budgetThread.id,
    createdByRunId: budgetRun.id,
    title: 'Vendor clause',
  });
  await store.addMessage({
    agentId: legal.id,
    conversationId: legalConversation.id,
    role: 'user',
    authorType: 'agent',
    authorAgentId: budget.id,
    content: 'Please check the vendor clause.',
  });

  const persistedBudgetConversation = await store.requireConversation(budgetConversation.id);
  assert.equal(persistedBudgetConversation.origin, 'agent');
  assert.equal(persistedBudgetConversation.readOnly, true);
  assert.equal(persistedBudgetConversation.initiatorAgentId, planner.id);
  assert.equal(persistedBudgetConversation.initiatorAgentName, 'Planner');
  assert.equal(persistedBudgetConversation.peerThreadId, budgetThread.id);

  const persistedThread = await store.getPeerThread(budgetThread.id);
  assert.equal(persistedThread.id, budgetThread.id);
  assert.equal(persistedThread.callerAgentName, 'Planner');
  assert.equal(persistedThread.targetAgentName, 'Budget');
  assert.equal(persistedThread.messages.length, 2);
  assert.equal(persistedThread.messages[0].authorType, 'agent');
  assert.equal(persistedThread.messages[0].authorAgentId, planner.id);
  assert.equal(persistedThread.messages[0].authorAgentName, 'Planner');
  assert.deepEqual(
    persistedThread.messages[0].files.map((file) => [file.name, file.path, file.relativePath, file.sizeBytes, file.source]),
    [['budget.pdf', sharedFilePath, 'imports/budget.pdf', 2048, 'attached']],
  );
  assert.equal(persistedThread.messages[1].authorType, 'agent');
  assert.equal(persistedThread.messages[1].authorAgentId, budget.id);
  assert.equal(persistedThread.children.length, 1);
  assert.equal(persistedThread.children[0].id, legalThread.id);
  assert.equal(persistedThread.children[0].targetAgentName, 'Legal');
  assert.equal(persistedThread.children[0].messages[0].authorAgentId, budget.id);

  assert.deepEqual(
    (await store.listPeerThreadsForConversation({ agentId: planner.id, conversationId: plannerConversation.id }))
      .map((thread) => [thread.id, thread.children[0]?.id]),
    [[budgetThread.id, legalThread.id]],
  );
  assert.deepEqual(
    (await store.listPeerThreadsForConversation({ agentId: budget.id, conversationId: budgetConversation.id }))
      .map((thread) => thread.id),
    [legalThread.id],
  );
  assert.deepEqual(
    (await store.listRecentPeerThreadsForAgent(planner.id)).map((thread) => [thread.id, thread.children[0]?.id]),
    [[budgetThread.id, legalThread.id]],
  );
  assert.deepEqual(
    (await store.listRecentPeerThreadsForAgent(budget.id)).map((thread) => thread.id).sort(),
    [budgetThread.id, legalThread.id].sort(),
  );
  assert.equal((await store.requirePeerThreadAccess({ agentId: planner.id, threadId: budgetThread.id })).id, budgetThread.id);
  assert.equal((await store.requirePeerThreadAccess({ agentId: budget.id, threadId: budgetThread.id })).id, budgetThread.id);
  await assert.rejects(
    store.requirePeerThreadAccess({ agentId: legal.id, threadId: budgetThread.id }),
    /personal_agent_peer_thread_not_allowed/,
  );
});

test('personal agent runtime persists and conversations are bound to provider continuity', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-runtime-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-runtime-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const runtimeRequests = [];
  const runnerInputs = [];
  const manager = new AgentConversationManager({
    store,
    metadataRoot,
    codexHome: path.join(metadataRoot, 'codex-home'),
    getAgentRuntime: async (request) => {
      runtimeRequests.push(request);
      return {
        provider: request?.provider ?? 'codex',
        model: request?.model ?? 'gpt-5.2',
        effort: request?.effort ?? 'medium',
        permissionMode: request?.permissionMode ?? 'safe',
      };
    },
    runner: async (input) => {
      runnerInputs.push({ runtime: input.runtime, provider: input.conversation.provider });
      return { assistantText: `Ran ${input.runtime.provider}` };
    },
  });

  const agent = await store.createAgent({
    name: 'Runtime agent',
    runtime: { provider: 'codex', model: 'gpt-5.4', effort: 'high' },
  });
  assert.deepEqual(agent.runtime, { provider: 'codex', model: 'gpt-5.4', effort: 'high' });

  const reloaded = new AgentStore({ metadataRoot, forgerHomeRoot });
  assert.deepEqual((await reloaded.requireAgent(agent.id)).runtime, agent.runtime);

  const conversation = await manager.startConversation({
    agentId: agent.id,
    title: 'Runtime thread',
    initialMessage: 'Start.',
  });
  const completed = await waitForConversation(manager, conversation.id, (item) => item.activeRun?.status === 'completed');
  assert.equal(completed.provider, 'codex');
  assert.equal(runnerInputs[0].provider, 'codex');
  assert.deepEqual(runnerInputs[0].runtime, { provider: 'codex', model: 'gpt-5.4', effort: 'high', permissionMode: 'safe' });
  assert.deepEqual(runtimeRequests[0], { provider: 'codex', model: 'gpt-5.4', effort: 'high', permissionMode: 'safe', strict: true });

  await store.updateAgentPermissions({
    agentId: agent.id,
    runtime: { provider: 'codex', model: 'gpt-5.2', effort: 'medium' },
  });
  await manager.sendMessage({ conversationId: conversation.id, content: 'Continue with another model.' });
  const continued = await waitForConversation(manager, conversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.at(-1)?.content === 'Ran codex' && item.messages.length >= 4);
  assert.equal(continued.provider, 'codex');

  await store.updateAgentPermissions({
    agentId: agent.id,
    runtime: { provider: 'claude', model: 'claude-sonnet-4-6', effort: 'medium' },
  });
  await assert.rejects(
    manager.sendMessage({ conversationId: conversation.id, content: 'Continue on Claude.' }),
    /personal_agent_provider_changed_new_conversation_required/,
  );
});

test('legacy personal agent databases migrate runtime and provider columns without breaking reads', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-runtime-migrate-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-runtime-migrate-home-'));
  const sqlitePath = path.join(metadataRoot, 'personal-agents.sqlite');
  const db = openPersonalAgentSqliteDatabase(sqlitePath);
  db.exec(`
    CREATE TABLE personal_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      permission_mode TEXT NOT NULL DEFAULT 'safe',
      network_access INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE personal_agent_permissions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'safe',
      granted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE personal_agent_conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE personal_agent_messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE personal_agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE personal_agent_run_progress (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE personal_agent_memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      remember_when TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE personal_agent_journal_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO personal_agents (id, name, description, purpose, instructions, permission_mode, network_access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'agent-legacy',
    'Legacy agent',
    '',
    '',
    '',
    'safe',
    0,
    now,
    now,
  );
  db.close?.();

  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const agent = await store.requireAgent('agent-legacy');
  assert.equal(agent.name, 'Legacy agent');
  assert.equal(agent.runtime, undefined);
  const migratedDb = openPersonalAgentSqliteDatabase(sqlitePath);
  const messageColumns = migratedDb.prepare('PRAGMA table_info(personal_agent_messages)').all();
  assert.ok(messageColumns.some((column) => column.name === 'reasoning'));
  migratedDb.close?.();
  const updated = await store.updateAgentPermissions({
    agentId: agent.id,
    runtime: { provider: 'antigravity', model: 'gemini-3-pro', effort: 'medium' },
  });
  assert.deepEqual(updated.runtime, { provider: 'antigravity', model: 'gemini-3-pro', effort: 'medium' });
});

test('personal agent store migrates legacy permission rows before querying grant columns', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-legacy-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-legacy-home-'));
  const sqlitePath = path.join(metadataRoot, 'personal-agents.sqlite');
  const db = openPersonalAgentSqliteDatabase(sqlitePath);
  db.exec(`
    CREATE TABLE personal_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      permission_mode TEXT NOT NULL DEFAULT 'safe',
      network_access INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE personal_agent_permissions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES personal_agents(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'safe',
      granted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, permission)
    );
  `);
  db.prepare('INSERT INTO personal_agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'agent-legacy',
    'Legacy agent',
    '2026-06-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO personal_agent_permissions (id, agent_id, permission, mode, granted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'permission-legacy',
    'agent-legacy',
    'network_access',
    'safe',
    1,
    '2026-06-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
  );

  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const agents = await store.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'agent-legacy');
  assert.deepEqual(agents[0].appIds, []);
  assert.deepEqual(agents[0].toolIds, []);
  const permissions = await store.listPermissions('agent-legacy');
  assert.deepEqual(permissions.map((permission) => [permission.kind, permission.targetId]), [['legacy', 'network_access']]);
});

test('personal agent workspace bootstrap happens on create and requireAgent does not rewrite existing files', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-migrate-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-migrate-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const agent = await store.createAgent({ name: 'Migrator', purpose: 'Keep notes current.' });
  const workspaceRoot = path.join(forgerHomeRoot, 'agents', agent.id, 'workspace');

  await writeFile(
    path.join(workspaceRoot, 'AGENTS.md'),
    '# Migrator\n\nThis is the private workspace for this personal Forger agent.\n',
    'utf8',
  );
  await writeFile(path.join(workspaceRoot, 'HUMAN.md'), '# HUMAN\n\nThe human prefers terse review notes.\n', 'utf8');

  const reloadedStore = new AgentStore({ metadataRoot, forgerHomeRoot });
  await reloadedStore.requireAgent(agent.id);

  assert.equal(
    await readFile(path.join(workspaceRoot, 'AGENTS.md'), 'utf8'),
    '# Migrator\n\nThis is the private workspace for this personal Forger agent.\n',
  );
  assert.equal(await readFile(path.join(workspaceRoot, 'HUMAN.md'), 'utf8'), '# HUMAN\n\nThe human prefers terse review notes.\n');
});

test('personal agent wake starts with localized message and later new conversations stay blank', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-auth-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-auth-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const manager = new AgentConversationManager({
    store,
    metadataRoot,
    codexHome: path.join(metadataRoot, 'codex-home'),
    runner: async () => ({ assistantText: 'Estoy despierto.' }),
  });
  const agent = await store.createAgent({ name: 'Auth agent', purpose: 'Test auth handling.' });
  const workspaceRoot = path.join(forgerHomeRoot, 'agents', agent.id, 'workspace');
  const agentsMdBefore = await readFile(path.join(workspaceRoot, 'AGENTS.md'), 'utf8');

  const wakeConversation = await manager.startConversation({
    agentId: agent.id,
    title: 'Auth chat',
    initialMessage: 'Hola, despierta',
  });

  assert.equal(wakeConversation.messages.length, 1);
  assert.equal(wakeConversation.messages[0].role, 'user');
  assert.equal(wakeConversation.messages[0].content, 'Hola, despierta');
  assert.equal(wakeConversation.activeRun.status, 'queued');
  const completedWake = await waitForConversation(manager, wakeConversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.content === 'Estoy despierto.'));
  assert.deepEqual(
    completedWake.messages.map((message) => [message.role, message.content]),
    [
      ['user', 'Hola, despierta'],
      ['assistant', 'Estoy despierto.'],
    ],
  );

  const blankConversation = await manager.startConversation({
    agentId: agent.id,
    title: 'Auth chat',
  });

  assert.equal(blankConversation.messages.length, 0);
  assert.equal(blankConversation.activeRun, undefined);
  const persistedBlank = await manager.getConversation(blankConversation.id);
  assert.equal(persistedBlank.messages.length, 0);
  assert.equal(persistedBlank.activeRun, undefined);
  assert.equal(await readFile(path.join(workspaceRoot, 'AGENTS.md'), 'utf8'), agentsMdBefore);
});

test('personal agent Codex runs prepare Git and write logs under metadata root', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-git-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-git-home-'));
  const fakeCodexCli = path.join(metadataRoot, 'fake-codex.cjs');
  const connectedAppRoot = path.join(forgerHomeRoot, 'apps', 'finance-os');
  const invocationCapturePath = path.join(metadataRoot, 'codex-invocation.json');
  await mkdir(connectedAppRoot, { recursive: true });
  await writeFile(fakeCodexCli, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'fs.writeFileSync(process.env.FORGER_CAPTURE_PATH, JSON.stringify({',
    '  argv: process.argv.slice(2),',
    '  cwd: process.cwd(),',
    '  allowedRoots: process.env.FORGER_ALLOWED_ROOTS,',
    '  codexHome: process.env.CODEX_HOME,',
    '}, null, 2));',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "personal-thread" }));',
    'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Prepared Git." } }));',
  ].join('\n'), 'utf8');
  await chmod(fakeCodexCli, 0o755);

  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  let ensureGitCalls = 0;
  const manager = new AgentConversationManager({
    store,
    metadataRoot,
    codexHome: path.join(metadataRoot, 'codex-home'),
    getAgentRuntime: async () => ({
      provider: 'codex',
      model: 'gpt-5.4',
      effort: 'medium',
      permissionMode: 'safe',
      networkAccess: false,
    }),
    getCodexCliPath: async () => fakeCodexCli,
    getCodexPathEntries: async () => [],
    getCodexEnvironment: async () => ({ FORGER_CAPTURE_PATH: invocationCapturePath }),
    getCodexAuthenticated: async () => true,
    resolveAppTrustedRoots: async (appIds) => appIds.includes('finance-os') ? [connectedAppRoot] : [],
    ensureGitAvailable: async () => {
      ensureGitCalls += 1;
    },
  });
  const agent = await store.createAgent({ name: 'Git agent', purpose: 'Test Git preparation.', appIds: ['finance-os'] });
  const conversation = await manager.startConversation({
    agentId: agent.id,
    title: 'Git prep',
    initialMessage: 'Run Codex.',
  });
  const completed = await waitForConversation(manager, conversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.content === 'Prepared Git.'));

  assert.equal(ensureGitCalls, 1);
  const invocation = JSON.parse(await readFile(invocationCapturePath, 'utf8'));
  assert.equal(invocation.cwd, await realpath(path.join(forgerHomeRoot, 'agents', agent.id, 'workspace')));
  assert.ok(invocation.argv.includes('--add-dir'));
  assert.equal(invocation.argv[invocation.argv.indexOf('--add-dir') + 1], connectedAppRoot);
  assert.ok(invocation.allowedRoots.split(path.delimiter).includes(connectedAppRoot));
  const isolatedConfig = await readFile(path.join(invocation.codexHome, 'config.toml'), 'utf8');
  assert.match(isolatedConfig, new RegExp(`\\[projects\\.${JSON.stringify(path.resolve(connectedAppRoot)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
  const runLog = await readFile(path.join(metadataRoot, 'personal-agents', 'runs', `${completed.activeRun.id}.log`), 'utf8');
  assert.match(runLog, /Prepared Git/);
  await assert.rejects(
    access(path.join(metadataRoot, 'personal-agents', '.forger', 'runs', `${completed.activeRun.id}.log`)),
    /ENOENT/,
  );

  // Follow-up messages resume the recorded thread. `--add-dir` is only valid on a
  // fresh `codex exec`; `codex exec resume` rejects it, so the resume invocation
  // must omit it while still keeping the shared roots trusted via the env.
  const messageCountAfterFirst = completed.messages.length;
  await manager.sendMessage({ conversationId: conversation.id, content: 'Keep going.' });
  await waitForConversation(manager, conversation.id, (item) =>
    item.messages.length >= messageCountAfterFirst + 2 && item.activeRun?.status === 'completed');
  const resumeInvocation = JSON.parse(await readFile(invocationCapturePath, 'utf8'));
  assert.ok(resumeInvocation.argv.includes('resume'), 'follow-up should resume via codex exec resume');
  assert.equal(resumeInvocation.argv.includes('--add-dir'), false, 'resume must not pass --add-dir');
  assert.ok(resumeInvocation.allowedRoots.split(path.delimiter).includes(connectedAppRoot));
});

test('Sidekick conversations persist their device relation, stay read-only, and carry locale only through the internal voice path', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-sidekick-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-sidekick-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  let capturedPrompt = '';
  const manager = new AgentConversationManager({
    store,
    runner: async ({ prompt }) => {
      capturedPrompt = prompt;
      return { assistantText: 'Listo, te respondo en español.' };
    },
  });
  const agent = await store.createAgent({ name: 'Home helper' });
  const conversation = await manager.createSidekickConversation({
    agentId: agent.id,
    sidekickId: 'sidekick-desk',
    title: 'Sidekick · Escritorio',
  });

  assert.equal(conversation.origin, 'sidekick');
  assert.equal(conversation.sidekickId, 'sidekick-desk');
  assert.equal(conversation.readOnly, true);
  await assert.rejects(
    manager.sendMessage({ conversationId: conversation.id, content: 'This renderer path must stay blocked.' }),
    /personal_agent_conversation_read_only/,
  );

  await store.addMessage({
    agentId: agent.id,
    conversationId: conversation.id,
    role: 'assistant',
    kind: 'spoken',
    source: 'sidekick',
    content: 'Este recibo hablado no debe volver al contexto del agente.',
  });

  await manager.sendSidekickMessage({
    conversationId: conversation.id,
    sidekickId: 'sidekick-desk',
    content: '¿Qué hora es?',
    locale: 'es-CL',
  });
  const completed = await waitForConversation(manager, conversation.id, (item) => item.activeRun?.status === 'completed');
  assert.deepEqual(completed.messages.map((message) => [message.role, message.source, message.locale, message.kind]), [
    ['assistant', 'sidekick', undefined, 'spoken'],
    ['user', 'sidekick', 'es-CL', 'message'],
    ['assistant', 'sidekick', undefined, 'message'],
  ]);
  assert.match(capturedPrompt, /es-CL/);
  assert.match(capturedPrompt, /brief.*natural.*spoken/i);
  assert.match(capturedPrompt, /respond_and_end|respond_and_wait/i);
  assert.match(capturedPrompt, /respond_and_\* only declares text and mode/i);
  assert.match(capturedPrompt, /Mandatory Sidekick final action/i);
  assert.match(capturedPrompt, /respond_and_wait when the spoken text asks a question/i);
  assert.match(capturedPrompt, /plain assistant text.*final question mark waits/i);
  assert.doesNotMatch(capturedPrompt, /do not call.*sidekick audio/i);
  assert.doesNotMatch(capturedPrompt, /recibo hablado no debe volver/i);
  assert.doesNotMatch(capturedPrompt, /only text/i);
  assert.match(capturedPrompt, /Desktop.*synthesi[sz]es.*cancel/i);
  assert.doesNotMatch(completed.messages[1].content, /brief|locale|spoken/i);

  const reloaded = new AgentStore({ metadataRoot, forgerHomeRoot });
  const latest = await reloaded.findLatestSidekickConversation({ sidekickId: 'sidekick-desk', agentId: agent.id });
  assert.equal(latest.id, conversation.id);
  assert.equal(latest.sidekickId, 'sidekick-desk');
});

test('personal agent messages persist reasoning and the spoken kind across reloads', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-spoken-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-spoken-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const agent = await store.createAgent({ name: 'Speaker' });
  const conversation = await store.createConversation({ agentId: agent.id, title: 'Voz', origin: 'sidekick', sidekickId: 'sidekick-desk' });

  const withReasoning = await store.addMessage({
    agentId: agent.id,
    conversationId: conversation.id,
    role: 'assistant',
    source: 'sidekick',
    content: 'La respuesta final.',
    reasoning: 'Primero revisé la agenda.\n\nDespués confirmé la hora.',
  });
  assert.equal(withReasoning.kind, 'message');
  assert.equal(withReasoning.reasoning, 'Primero revisé la agenda.\n\nDespués confirmé la hora.');

  const spoken = await store.addMessage({
    agentId: agent.id,
    conversationId: conversation.id,
    role: 'assistant',
    kind: 'spoken',
    source: 'sidekick',
    content: 'Hola, tu reunión es a las tres.',
  });
  assert.equal(spoken.kind, 'spoken');

  const reloadedStore = new AgentStore({ metadataRoot, forgerHomeRoot });
  const persisted = await reloadedStore.requireConversation(conversation.id);
  assert.deepEqual(
    persisted.messages.map((message) => [message.kind, message.reasoning ?? null]),
    [
      ['message', 'Primero revisé la agenda.\n\nDespués confirmé la hora.'],
      ['spoken', null],
    ],
  );

  // Messages created within the same clock tick keep insertion order. This
  // makes the written response and the subsequent spoken receipt deterministic.
  const sameTimestamp = '2026-07-12T12:00:00.000Z';
  const orderingDb = openPersonalAgentSqliteDatabase(path.join(metadataRoot, 'personal-agents.sqlite'));
  orderingDb.prepare('UPDATE personal_agent_messages SET created_at = ? WHERE conversation_id = ?').run(sameTimestamp, conversation.id);
  orderingDb.close();
  const ordered = await new AgentStore({ metadataRoot, forgerHomeRoot }).requireConversation(conversation.id);
  assert.deepEqual(ordered.messages.map((message) => message.id), [withReasoning.id, spoken.id]);

  // Unknown kinds stored by future/older versions must coerce to 'message'.
  const db = openPersonalAgentSqliteDatabase(path.join(metadataRoot, 'personal-agents.sqlite'));
  assert.ok(db);
  db.prepare("UPDATE personal_agent_messages SET kind = 'mystery' WHERE id = ?").run(spoken.id);
  db.close();
  const coerced = await new AgentStore({ metadataRoot, forgerHomeRoot }).requireConversation(conversation.id);
  assert.equal(coerced.messages[1].kind, 'message');
});

test('personal agent conversation manager starts a real run, persists progress, and blocks overlapping sends', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-conversations-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-conversations-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const events = [];
  let runnerCallCount = 0;
  const manager = new AgentConversationManager({
    store,
    runner: async ({ prompt, workspaceRoot, onProgress }) => {
      if (runnerCallCount === 0) {
        assert.match(prompt, /Bootstrap Ritual/);
        assert.match(prompt, /Memory Register/);
      } else {
        assert.doesNotMatch(prompt, /Bootstrap Ritual|Memory Register/);
      }
      runnerCallCount += 1;
      assert.match(workspaceRoot, /workspace$/);
      onProgress('Reading workspace');
      return { assistantText: 'Ready to plan.' };
    },
    onConversationEvent: (event) => events.push(event.type),
  });
  const agent = await store.createAgent({
    name: 'Planning agent',
    description: 'Helps plan work',
    instructions: 'Ask concise questions.',
  });

  const blankConversation = await manager.startConversation({
    agentId: agent.id,
    title: 'Blank thread',
  });
  assert.equal(blankConversation.messages.length, 0);
  assert.equal(blankConversation.activeRun, undefined);

  const conversation = await manager.startConversation({
    agentId: agent.id,
    title: 'Launch plan',
    initialMessage: 'Start with a launch plan.',
  });
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0].role, 'user');
  assert.equal(conversation.activeRun.status, 'queued');
  await assert.rejects(
    manager.sendMessage({ conversationId: conversation.id, content: 'Too soon.' }),
    /personal_agent_run_active/,
  );
  const completedFirstRun = await waitForConversation(manager, conversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.role === 'assistant'));
  assert.deepEqual(
    completedFirstRun.messages.map((message) => [message.role, message.kind]),
    [['user', 'message'], ['assistant', 'intermediate'], ['assistant', 'message']],
  );
  assert.equal(completedFirstRun.activeRun.progress.at(-1).message, 'Reading workspace');
  assert.equal(completedFirstRun.messages[1].content, 'Reading workspace');
  assert.match(completedFirstRun.messages[2].content, /Ready to plan/);

  const updated = await manager.sendMessage({
    conversationId: conversation.id,
    content: 'Draft a first pass.',
  });
  assert.equal(updated.messages.length, 4);
  assert.equal(updated.activeRun.status, 'queued');
  const completedSecondRun = await waitForConversation(manager, conversation.id, (item) => item.messages.length === 6);
  assert.equal(completedSecondRun.messages[4].kind, 'intermediate');
  assert.equal(completedSecondRun.messages[5].content, 'Ready to plan.');
  assert.deepEqual((await store.listConversations(agent.id)).map((item) => item.id), [conversation.id, blankConversation.id]);

  const memory = await store.createMemory({
    agentId: agent.id,
    rememberWhen: 'Before planning work.',
    title: 'Working style',
    content: 'Prefer concise status updates.',
  });
  const journalEntry = await store.createJournalEntry({
    agentId: agent.id,
    conversationId: conversation.id,
    body: 'Started the launch planning thread.',
  });

  assert.equal(memory.agentId, agent.id);
  assert.equal(memory.rememberWhen, 'Before planning work.');
  assert.equal(memory.content, 'Prefer concise status updates.');
  assert.equal(journalEntry.conversationId, conversation.id);

  const reloadedManager = new AgentConversationManager({
    store: new AgentStore({ metadataRoot, forgerHomeRoot }),
  });
  const reloaded = await reloadedManager.getConversation(conversation.id);
  assert.equal(reloaded.messages.length, 6);
  assert.equal(reloaded.activeRun.status, 'completed');
  assert.equal(reloaded.activeRun.progress.length, 1);
  assert.equal(reloaded.messages.filter((message) => message.kind === 'intermediate').length, 2);
  assert.equal((await store.listMemories(agent.id)).length, 1);
  assert.equal((await store.listJournalEntries(agent.id)).length, 1);
  assert.ok(events.includes('run.started'));
  assert.ok(events.includes('run.progress'));
  assert.ok(events.includes('run.completed'));
});

test('personal agent conversation manager does not persist progress that duplicates the final message', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-dedupe-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-dedupe-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const manager = new AgentConversationManager({
    store,
    runner: async ({ onProgress }) => {
      onProgress('¿De qué ciudad o comuna quieres el clima? Si quieres, te lo doy con temperatura actual y pronóstico de hoy.');
      onProgress('La herramienta de clima no resolvió Providencia bien; voy a usar una fuente directa.');
      onProgress('En Providencia, Santiago, ahora está en **17 °C**, se siente como **17 °C**, con **nubosidad parcial**, humedad de **42%** y viento suave del **SE**. Para **hoy...');
      return {
        assistantText: 'En Providencia, Santiago, ahora está en **17 °C**, se siente como **17 °C**, con **nubosidad parcial**, humedad de **42%** y viento suave del **SE**.\n\nPara **hoy, 12 de junio de 2026**, se ve:\n\n- mínima cerca de **10-11 °C**\n- máxima cerca de **18 °C**\n- **sin lluvia** en el pronóstico de hoy',
      };
    },
  });
  const agent = await store.createAgent({ name: 'Weather agent', purpose: 'Answers weather questions.' });

  const conversation = await manager.startConversation({
    agentId: agent.id,
    title: 'Weather',
    initialMessage: 'a ver cual es el clima',
  });
  const completed = await waitForConversation(manager, conversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.role === 'assistant'));

  assert.deepEqual(
    completed.messages.map((message) => [message.role, message.kind, message.content]),
    [
      ['user', 'message', 'a ver cual es el clima'],
      ['assistant', 'intermediate', '¿De qué ciudad o comuna quieres el clima? Si quieres, te lo doy con temperatura actual y pronóstico de hoy.'],
      ['assistant', 'intermediate', 'La herramienta de clima no resolvió Providencia bien; voy a usar una fuente directa.'],
      ['assistant', 'message', 'En Providencia, Santiago, ahora está en **17 °C**, se siente como **17 °C**, con **nubosidad parcial**, humedad de **42%** y viento suave del **SE**.\n\nPara **hoy, 12 de junio de 2026**, se ve:\n\n- mínima cerca de **10-11 °C**\n- máxima cerca de **18 °C**\n- **sin lluvia** en el pronóstico de hoy'],
    ],
  );
  assert.equal(completed.activeRun.progress.length, 2);
  assert.equal(completed.activeRun.progress[0].message, '¿De qué ciudad o comuna quieres el clima? Si quieres, te lo doy con temperatura actual y pronóstico de hoy.');
  assert.equal(completed.activeRun.progress[1].message, 'La herramienta de clima no resolvió Providencia bien; voy a usar una fuente directa.');
  assert.equal(completed.messages.at(-1).reasoning, [
    '¿De qué ciudad o comuna quieres el clima? Si quieres, te lo doy con temperatura actual y pronóstico de hoy.',
    'La herramienta de clima no resolvió Providencia bien; voy a usar una fuente directa.',
  ].join('\n\n'));
});

test('personal agent visible activity stored with the final message redacts secrets', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-activity-redaction-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-activity-redaction-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const manager = new AgentConversationManager({
    store,
    runner: async ({ onProgress }) => {
      onProgress('Consultando servicio con token=ghp_12345678901234567890');
      return { assistantText: 'Listo.' };
    },
  });
  const agent = await store.createAgent({ name: 'Safe activity agent' });
  const conversation = await manager.startConversation({ agentId: agent.id, initialMessage: 'Hazlo.' });
  const completed = await waitForConversation(manager, conversation.id, (item) => item.activeRun?.status === 'completed');
  const final = completed.messages.find((message) => message.role === 'assistant' && message.kind === 'message');
  assert.match(final.reasoning, /hidden sensitive value/i);
  assert.doesNotMatch(final.reasoning, /ghp_12345678901234567890/);
});

test('personal agent conversation manager persists full long progress messages', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-long-progress-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-long-progress-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const longProgress = Array.from({ length: 70 }, (_value, index) =>
    `nota-${index.toString().padStart(2, '0')} conserva el texto intermedio completo`)
    .join(' ');
  const manager = new AgentConversationManager({
    store,
    runner: async ({ onProgress }) => {
      onProgress(longProgress);
      return { assistantText: 'Respuesta final completa.' };
    },
  });
  const agent = await store.createAgent({ name: 'Long progress agent', purpose: 'Reports long intermediate notes.' });

  const conversation = await manager.startConversation({
    agentId: agent.id,
    title: 'Long progress',
    initialMessage: 'Trabaja con detalle.',
  });
  const completed = await waitForConversation(manager, conversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.role === 'assistant'));

  assert.equal(longProgress.length > 1000, true);
  assert.equal(completed.activeRun.progress[0].message, longProgress);
  assert.equal(completed.messages.find((message) => message.kind === 'intermediate')?.content, longProgress);
});

test('personal agent cancellation marks the active run canceled and suppresses a late final message', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-cancel-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-cancel-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  let releaseRunner;
  const gate = new Promise((resolve) => { releaseRunner = resolve; });
  const manager = new AgentConversationManager({
    store,
    runner: async () => {
      await gate;
      return { assistantText: 'Esta respuesta llegó después de cancelar.' };
    },
  });
  const agent = await store.createAgent({ name: 'Cancelable agent' });
  const conversation = await manager.startConversation({ agentId: agent.id, initialMessage: 'Espera.' });
  const running = await waitForConversation(manager, conversation.id, (item) => item.activeRun?.status === 'running');

  assert.equal(await manager.cancelRun(running.activeRun.id), true);
  assert.equal(await manager.cancelRun(running.activeRun.id), false);
  releaseRunner();
  await new Promise((resolve) => setImmediate(resolve));
  const canceled = await store.requireConversation(conversation.id);
  assert.equal(canceled.activeRun.status, 'canceled');
  assert.equal(canceled.messages.some((message) => message.content.includes('después de cancelar')), false);
});

test('personal agent routines create a conversable thread, reuse it on each trigger, and skip while busy', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-routine-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-routine-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  let releaseRunner;
  const runnerGate = new Promise((resolve) => {
    releaseRunner = resolve;
  });
  let runnerCalls = 0;
  const conversationManager = new AgentConversationManager({
    store,
    runner: async () => {
      runnerCalls += 1;
      if (runnerCalls === 2) {
        await runnerGate;
      }
      return { assistantText: `Respuesta ${runnerCalls}.` };
    },
  });
  const routineManager = new AgentRoutineManager({ store, conversationManager });
  const agent = await store.createAgent({ name: 'Routine agent', purpose: 'Runs scheduled checks.' });

  const routine = await routineManager.create(agent.id, {
    name: 'Status check',
    prompt: 'Revisa estado.',
    frequency: { type: 'hourly' },
    missedRunPolicy: 'within_window',
    missedRunWindowMinutes: 30,
    enabled: false,
    authorizationText: 'User approved routine',
  });

  assert.equal(routine.agentId, agent.id);
  assert.equal(routine.enabled, false);
  const routineConversation = await store.requireConversation(routine.conversationId);
  assert.equal(routineConversation.origin, 'routine');
  assert.equal(routineConversation.routineId, routine.id);
  assert.equal(routineConversation.readOnly, false);

  const firstRun = await routineManager.runNow({ routineId: routine.id });
  assert.equal(firstRun.status, 'running');
  const firstCompleted = await waitForConversation(conversationManager, routine.conversationId, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.content === 'Respuesta 1.'));
  assert.deepEqual(
    firstCompleted.messages.map((message) => [message.role, message.source, message.content]),
    [
      ['user', 'routine', 'Revisa estado.'],
      ['assistant', 'human', 'Respuesta 1.'],
    ],
  );
  assert.equal((await store.requireRoutine(routine.id)).lastRun.status, 'succeeded');

  await routineManager.runNow({ routineId: routine.id });
  const runningConversation = await waitForConversation(conversationManager, routine.conversationId, (item) =>
    item.activeRun?.status === 'running');
  assert.equal(runningConversation.messages.at(-1).source, 'routine');
  const skipped = await routineManager.runNow({ routineId: routine.id });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.error, 'routine_thread_busy');
  releaseRunner();
  await waitForConversation(conversationManager, routine.conversationId, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.content === 'Respuesta 2.'));

  const userUpdated = await conversationManager.sendMessage({
    conversationId: routine.conversationId,
    content: 'Gracias, sigue desde aqui.',
  });
  assert.equal(userUpdated.messages.at(-1).role, 'user');
  assert.equal(userUpdated.messages.at(-1).source, 'human');
  const finalConversation = await waitForConversation(conversationManager, routine.conversationId, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.content === 'Respuesta 3.'));
  assert.equal(finalConversation.id, routine.conversationId);
  assert.equal(finalConversation.messages.filter((message) => message.source === 'routine').length, 2);
});

test('personal agent wakeup_in enforces minimum seconds, blocks sending, persists draft, cancels, and wakes in same thread', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-wakeup-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-wakeup-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const conversationManager = new AgentConversationManager({
    store,
    runner: async () => ({ assistantText: 'Despertado.' }),
  });
  const routineManager = new AgentRoutineManager({ store, conversationManager });
  const agent = await store.createAgent({ name: 'Wakeup agent', purpose: 'Waits and resumes.' });
  const conversation = await conversationManager.createConversation({ agentId: agent.id, title: 'Waiting' });

  await assert.rejects(
    routineManager.scheduleWakeup({
      agentId: agent.id,
      conversationId: conversation.id,
      seconds: 4,
      prompt: 'Muy pronto.',
    }),
    /personal_agent_wakeup_minimum_seconds/,
  );

  const wakeup = await routineManager.scheduleWakeup({
    agentId: agent.id,
    conversationId: conversation.id,
    seconds: 60,
    prompt: 'Revisa si ya esta listo.',
  });
  assert.equal(wakeup.status, 'scheduled');
  await assert.rejects(
    conversationManager.sendMessage({ conversationId: conversation.id, content: 'No deberia enviar.' }),
    /personal_agent_wakeup_active/,
  );
  const drafted = await routineManager.updateDraft({
    conversationId: conversation.id,
    draftMessage: 'Mensaje escrito mientras espera.',
  });
  assert.equal(drafted.draftMessage, 'Mensaje escrito mientras espera.');

  const canceled = await routineManager.cancelWakeup({ conversationId: conversation.id });
  assert.equal(canceled.status, 'canceled');
  const afterCancel = await conversationManager.sendMessage({
    conversationId: conversation.id,
    content: 'Ahora si envia.',
  });
  assert.equal(afterCancel.messages.at(-1).content, 'Ahora si envia.');
  await waitForConversation(conversationManager, conversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.content === 'Despertado.'));

  const secondConversation = await conversationManager.createConversation({ agentId: agent.id, title: 'Second wait' });
  const dueWakeup = await routineManager.scheduleWakeup({
    agentId: agent.id,
    conversationId: secondConversation.id,
    seconds: 5,
    prompt: 'Despierta ahora.',
  });
  await store.updateWakeupStatus({ wakeupId: dueWakeup.id, status: 'fired' });
  await store.scheduleWakeup({
    agentId: agent.id,
    conversationId: secondConversation.id,
    prompt: 'Despierta ahora.',
    dueAt: new Date(Date.now() - 1000).toISOString(),
  });
  await routineManager.initialize();
  const awakened = await waitForConversation(conversationManager, secondConversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.source === 'scheduled_wakeup'));
  assert.deepEqual(
    awakened.messages.map((message) => [message.role, message.source, message.content]),
    [
      ['user', 'scheduled_wakeup', 'Despierta ahora.'],
      ['assistant', 'human', 'Despertado.'],
    ],
  );
  assert.equal(awakened.scheduledWakeup, undefined);
  routineManager.dispose();
});

test('personal agent routines apply missedRunPolicy skip always and within_window without retries', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-routine-missed-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-routine-missed-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const conversationManager = new AgentConversationManager({
    store,
    runner: async () => ({ assistantText: 'Run completed once.' }),
  });
  const routineManager = new AgentRoutineManager({ store, conversationManager });
  const agent = await store.createAgent({ name: 'Policy agent', purpose: 'Checks missed schedules.' });
  const oldPast = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const skipRoutine = await routineManager.create(agent.id, {
    name: 'Skip old',
    prompt: 'Skip me.',
    frequency: { type: 'hourly' },
    missedRunPolicy: 'skip',
    enabled: false,
    authorizationText: 'User approved skip',
  });
  const alwaysRoutine = await routineManager.create(agent.id, {
    name: 'Always old',
    prompt: 'Run me.',
    frequency: { type: 'hourly' },
    missedRunPolicy: 'always',
    enabled: false,
    authorizationText: 'User approved always',
  });
  const windowRoutine = await routineManager.create(agent.id, {
    name: 'Window old',
    prompt: 'Window skip.',
    frequency: { type: 'hourly' },
    missedRunPolicy: 'within_window',
    missedRunWindowMinutes: 1,
    enabled: false,
    authorizationText: 'User approved window',
  });
  await store.setRoutineEnabled({ routineId: skipRoutine.id, enabled: true, nextRunAt: oldPast });
  await store.setRoutineEnabled({ routineId: alwaysRoutine.id, enabled: true, nextRunAt: oldPast });
  await store.setRoutineEnabled({ routineId: windowRoutine.id, enabled: true, nextRunAt: oldPast });

  await routineManager.initialize();
  const alwaysConversation = await waitForConversation(conversationManager, alwaysRoutine.conversationId, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.source === 'routine'));

  assert.equal(alwaysConversation.messages.filter((message) => message.source === 'routine').length, 1);
  assert.equal((await store.requireRoutine(alwaysRoutine.id)).lastRun.status, 'succeeded');
  const skippedOld = await store.requireRoutine(skipRoutine.id);
  assert.equal(skippedOld.lastRun.status, 'skipped');
  assert.equal(skippedOld.lastRun.error, 'routine_missed_schedule');
  const skippedWindow = await store.requireRoutine(windowRoutine.id);
  assert.equal(skippedWindow.lastRun.status, 'skipped');
  assert.equal(skippedWindow.lastRun.error, 'routine_missed_schedule');
  assert.equal((await store.requireConversation(skipRoutine.conversationId)).messages.length, 0);
  assert.equal((await store.requireConversation(windowRoutine.conversationId)).messages.length, 0);
  routineManager.dispose();
});

const waitForConversation = async (manager, conversationId, predicate) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const conversation = await manager.getConversation(conversationId);
    if (conversation && predicate(conversation)) {
      return conversation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('conversation_wait_timeout');
};
