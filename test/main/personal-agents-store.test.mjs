import assert from 'node:assert/strict';
import test from 'node:test';
import { access, chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');
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
  assert.deepEqual(workspaceFiles.sort(), ['.agents', '.claude', 'AGENTS.md', 'HOW.md', 'HUMAN.md', 'WHO.md', 'WHY.md']);
  const agentSkillDirs = (await readdir(path.join(workspaceRoot, '.agents', 'skills'))).sort();
  const claudeSkillDirs = (await readdir(path.join(workspaceRoot, '.claude', 'skills'))).sort();
  assert.ok(agentSkillDirs.includes('forger-context'));
  assert.ok(agentSkillDirs.includes('forger-installed-app-change'));
  assert.ok(agentSkillDirs.includes('forger-manifest-authoring'));
  assert.ok(agentSkillDirs.includes('forger-speech-to-text'));
  assert.deepEqual(claudeSkillDirs, agentSkillDirs);
  assert.equal(agentSkillDirs.includes('forger-app-official-tools'), false);
  assert.equal(agentSkillDirs.includes('load-movements'), false);
  const agentsMd = await readFile(path.join(workspaceRoot, 'AGENTS.md'), 'utf8');
  const whoMd = await readFile(path.join(workspaceRoot, 'WHO.md'), 'utf8');
  const whyMd = await readFile(path.join(workspaceRoot, 'WHY.md'), 'utf8');
  const howMd = await readFile(path.join(workspaceRoot, 'HOW.md'), 'utf8');
  const humanMd = await readFile(path.join(workspaceRoot, 'HUMAN.md'), 'utf8');
  assert.match(agentsMd, /FORGER_PERSONAL_AGENT_PROMPT_VERSION: 1/);
  assert.match(agentsMd, /WHO\.md/);
  assert.match(agentsMd, /WHY\.md/);
  assert.match(agentsMd, /HOW\.md/);
  assert.match(agentsMd, /HUMAN\.md/);
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
  await writeFile(path.join(workspaceRoot, 'notes.txt'), 'Visible note.', 'utf8');
  const workspaceTree = await store.listWorkspace(agent.id);
  assert.deepEqual(
    workspaceTree.map((entry) => [entry.name, entry.relativePath, entry.kind]),
    [
      ['AGENTS.md', 'AGENTS.md', 'file'],
      ['HOW.md', 'HOW.md', 'file'],
      ['HUMAN.md', 'HUMAN.md', 'file'],
      ['notes.txt', 'notes.txt', 'file'],
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
  await writeFile(fakeCodexCli, [
    '#!/usr/bin/env node',
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
    getCodexEnvironment: async () => ({}),
    getCodexAuthenticated: async () => true,
    ensureGitAvailable: async () => {
      ensureGitCalls += 1;
    },
  });
  const agent = await store.createAgent({ name: 'Git agent', purpose: 'Test Git preparation.' });
  const conversation = await manager.startConversation({
    agentId: agent.id,
    title: 'Git prep',
    initialMessage: 'Run Codex.',
  });
  const completed = await waitForConversation(manager, conversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.content === 'Prepared Git.'));

  assert.equal(ensureGitCalls, 1);
  const runLog = await readFile(path.join(metadataRoot, 'personal-agents', 'runs', `${completed.activeRun.id}.log`), 'utf8');
  assert.match(runLog, /Prepared Git/);
  await assert.rejects(
    access(path.join(metadataRoot, 'personal-agents', '.forger', 'runs', `${completed.activeRun.id}.log`)),
    /ENOENT/,
  );
});

test('personal agent conversation manager starts a real run, persists progress, and blocks overlapping sends', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-conversations-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-conversations-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const events = [];
  const manager = new AgentConversationManager({
    store,
    runner: async ({ prompt, workspaceRoot, onProgress }) => {
      assert.match(prompt, /Bootstrap Ritual/);
      assert.match(prompt, /Memory Register/);
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
});

const waitForConversation = async (manager, conversationId, predicate) => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const conversation = await manager.getConversation(conversationId);
    if (conversation && predicate(conversation)) {
      return conversation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('conversation_wait_timeout');
};
