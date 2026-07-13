import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { openPersonalAgentSqliteDatabase } = require('../../dist-electron/main/personal-agents/sqlite.js');

const createStore = async (prefix) => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), `${prefix}-meta-`));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), `${prefix}-home-`));
  return {
    metadataRoot,
    forgerHomeRoot,
    store: new AgentStore({ metadataRoot, forgerHomeRoot }),
  };
};

test('new and ungrouped personal agents cannot spawn agents unless the person explicitly enables it', async () => {
  const { metadataRoot, forgerHomeRoot, store } = await createStore('forger-agent-spawn-default');

  const ungrouped = await store.createAgent({ name: 'Independent agent' });
  const optedIn = await store.createAgent({ name: 'Team lead', canSpawnAgents: true });

  assert.equal(ungrouped.canSpawnAgents, false);
  assert.equal(ungrouped.groupId, undefined);
  assert.equal(ungrouped.createdByAgentId, undefined);
  assert.equal(optedIn.canSpawnAgents, true);

  const reloaded = new AgentStore({ metadataRoot, forgerHomeRoot });
  const persisted = await reloaded.listAgents();
  assert.equal(persisted.find((agent) => agent.id === ungrouped.id)?.canSpawnAgents, false);
  assert.equal(persisted.find((agent) => agent.id === optedIn.id)?.canSpawnAgents, true);
});

test('agent groups are optional persisted records and agents can move into and out of them', async () => {
  const { metadataRoot, forgerHomeRoot, store } = await createStore('forger-agent-groups');
  const research = await store.createGroup({ name: 'Research' });
  const grouped = await store.createAgent({ name: 'Reader', groupId: research.id });
  const ungrouped = await store.createAgent({ name: 'General helper' });

  assert.equal(grouped.groupId, research.id);
  assert.equal(ungrouped.groupId, undefined);
  assert.deepEqual((await store.listGroups()).map((group) => group.name), ['Research']);

  const renamed = await store.updateGroup({ groupId: research.id, name: 'Product research' });
  assert.equal(renamed.name, 'Product research');

  const movedOut = await store.updateAgentGroup({ agentId: grouped.id, groupId: null });
  assert.equal(movedOut.groupId, undefined);

  const reloaded = new AgentStore({ metadataRoot, forgerHomeRoot });
  assert.equal((await reloaded.listGroups())[0].name, 'Product research');
  assert.equal((await reloaded.requireAgent(grouped.id)).groupId, undefined);
  assert.equal((await reloaded.requireAgent(ungrouped.id)).groupId, undefined);
});

test('OTHERS.md keeps current spawn and peer configuration outside repeated turn prompts', async () => {
  const { store } = await createStore('forger-agent-tools-configuration');
  const creator = await store.createAgent({ name: 'Coordinator', canSpawnAgents: true });
  const specialist = await store.createAgent({ name: 'Specialist' });
  await store.updateAgentPermissions({
    agentId: creator.id,
    peerAgentGrants: [{ agentId: specialist.id, criteria: 'Use for specialist reviews.' }],
  });

  const workspaceRoot = await store.workspaceRootForAgent(creator.id);
  const enabled = await readFile(path.join(workspaceRoot, 'OTHERS.md'), 'utf8');
  assert.match(enabled, /Create other agents: enabled/);
  assert.match(enabled, /Contact other agents: enabled for 1 allowed agent/);
  assert.match(enabled, /Specialist/);
  assert.match(enabled, /Use for specialist reviews/);

  await store.updateAgentPermissions({ agentId: creator.id, canSpawnAgents: false });
  const disabled = await readFile(path.join(workspaceRoot, 'OTHERS.md'), 'utf8');
  assert.match(disabled, /Create other agents: disabled/);
  assert.match(disabled, /Contact other agents: enabled for 1 allowed agent/);
});

test('an enabled creator atomically spawns a safe child, inherits its group, and receives a peer write grant', async () => {
  const { store } = await createStore('forger-agent-spawn-enabled');
  const group = await store.createGroup({ name: 'Launch team' });
  const creator = await store.createAgent({
    name: 'Coordinator',
    groupId: group.id,
    canSpawnAgents: true,
    networkAccess: true,
    permissionMode: 'unsafe',
    appIds: ['finance-os'],
  });

  const child = await store.createAgentFromAgent({
    creatorAgentId: creator.id,
    name: 'Budget reviewer',
    description: 'Checks launch costs.',
    purpose: 'Review the budget before launch.',
  });

  assert.equal(child.createdByAgentId, creator.id);
  assert.equal(child.groupId, group.id);
  assert.equal(child.canSpawnAgents, false);
  assert.equal(child.permissionMode, 'safe');
  assert.equal(child.networkAccess, false);
  assert.deepEqual(child.appIds, []);
  assert.deepEqual(child.toolIds, []);
  assert.deepEqual(child.connectionGrants, []);
  assert.deepEqual(child.peerAgentGrants, []);

  const creatorGrants = await store.listPeerGrants(creator.id);
  assert.equal(creatorGrants.some((grant) => grant.agentId === child.id), true);
  assert.equal((await store.getPeerGrant(child.id, creator.id)), null);

  const otherGroup = await store.createGroup({ name: 'Specialists' });
  const explicitlyGroupedChild = await store.createAgentFromAgent({
    creatorAgentId: creator.id,
    name: 'Legal reviewer',
    groupId: otherGroup.id,
  });
  assert.equal(explicitlyGroupedChild.groupId, otherGroup.id);
  assert.equal(explicitlyGroupedChild.createdByAgentId, creator.id);
});

test('an agent without spawn permission cannot create a child or leave a partial relationship behind', async () => {
  const { store } = await createStore('forger-agent-spawn-denied');
  const creator = await store.createAgent({ name: 'Regular agent' });

  await assert.rejects(
    store.createAgentFromAgent({ creatorAgentId: creator.id, name: 'Forbidden child' }),
    /personal_agent_spawn_permission_required/,
  );

  assert.deepEqual((await store.listAgents()).map((agent) => agent.name), ['Regular agent']);
  assert.deepEqual(await store.listPeerGrants(creator.id), []);
});

test('deleting a creator or group preserves children and clears only optional relationships', async () => {
  const { store } = await createStore('forger-agent-spawn-delete');
  const group = await store.createGroup({ name: 'Temporary team' });
  const creator = await store.createAgent({ name: 'Lead', groupId: group.id, canSpawnAgents: true });
  const child = await store.createAgentFromAgent({ creatorAgentId: creator.id, name: 'Durable child' });

  await store.deleteAgent(creator.id);
  const childAfterCreatorDelete = await store.requireAgent(child.id);
  assert.equal(childAfterCreatorDelete.createdByAgentId, undefined);
  assert.equal(childAfterCreatorDelete.groupId, group.id);

  await store.deleteGroup(group.id);
  const childAfterGroupDelete = await store.requireAgent(child.id);
  assert.equal(childAfterGroupDelete.groupId, undefined);
  assert.equal(childAfterGroupDelete.name, 'Durable child');
});

test('legacy personal-agent databases migrate spawn/group fields with backwards-compatible defaults', async () => {
  const { metadataRoot, forgerHomeRoot } = await createStore('forger-agent-spawn-migrate');
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
  `);
  db.prepare('INSERT INTO personal_agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'legacy-agent',
    'Legacy agent',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
  db.close?.();

  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const legacy = await store.requireAgent('legacy-agent');
  assert.equal(legacy.canSpawnAgents, false);
  assert.equal(legacy.groupId, undefined);
  assert.equal(legacy.createdByAgentId, undefined);
  assert.deepEqual(await store.listGroups(), []);

  const migratedDb = openPersonalAgentSqliteDatabase(sqlitePath);
  const columns = migratedDb.prepare('PRAGMA table_info(personal_agents)').all().map((column) => column.name);
  assert.ok(columns.includes('can_spawn_agents'));
  assert.ok(columns.includes('group_id'));
  assert.ok(columns.includes('created_by_agent_id'));
  const groupTable = migratedDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_agent_groups'").get();
  assert.equal(groupTable?.name, 'personal_agent_groups');
  migratedDb.close?.();
});
