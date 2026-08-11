import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { AgentGroupStore } = require('../../dist-electron/main/personal-agents/agent-store-groups.js');
const { createPersonalAgentFromAgent } = require('../../dist-electron/main/personal-agents/agent-store-spawn.js');
const { extractLegacyOthersDurableCriteria } = require('../../dist-electron/main/personal-agents/agent-store-others-migration.js');
const { readPersonalAgentWorkspaceEntries } = require('../../dist-electron/main/personal-agents/agent-store-workspace.js');

const agent = (overrides = {}) => ({
  id: 'creator', name: 'Creator', permissionMode: 'safe', networkAccess: false, canSpawnAgents: true,
  appIds: [], toolIds: [], connectionGrants: [], peerAgentGrants: [], createdAt: 'now', updatedAt: 'now', ...overrides,
});

test('BDD: group CRUD exposes invalid, missing, and valid membership boundaries', async () => {
  let changes = 0;
  let groupRow;
  const updatedAgents = [];
  const db = {
    prepare(sql) {
      return {
        all: () => groupRow ? [groupRow] : [],
        get: () => groupRow,
        run: (...args) => {
          if (sql.startsWith('INSERT')) groupRow = { id: args[0], name: args[1], created_at: args[2], updated_at: args[3] };
          if (sql.startsWith('UPDATE personal_agent_groups') && changes) groupRow = { ...groupRow, name: args[0], updated_at: args[1] };
          if (sql.startsWith('DELETE') && changes) groupRow = undefined;
          if (sql.startsWith('UPDATE personal_agents')) updatedAgents.push(args);
          return { changes };
        },
      };
    },
  };
  const store = new AgentGroupStore({ load: async () => {}, requireDb: () => db, requireAgent: async (id) => agent({ id }) });
  await assert.rejects(store.create({ name: ' ' }), /personal_agent_group_name_required/);
  await assert.rejects(store.update({ groupId: 'bad id', name: 'Name' }), /personal_agent_group_input_invalid/);
  await assert.rejects(store.update({ groupId: 'valid', name: 'Name' }), /personal_agent_group_not_found/);
  await assert.rejects(store.delete('bad id'), /personal_agent_group_not_found/);
  await assert.rejects(store.delete('valid'), /personal_agent_group_not_found/);
  assert.throws(() => store.require('missing'), /personal_agent_group_not_found/);

  changes = 1;
  const created = await store.create({ name: ' Helpers ' });
  assert.equal(created.name, 'Helpers');
  assert.equal((await store.update({ groupId: created.id, name: 'Reviewers' })).name, 'Reviewers');
  assert.equal((await store.updateAgent({ agentId: 'agent', groupId: created.id })).groupId, undefined);
  assert.equal(updatedAgents.length, 1);
  assert.deepEqual(await store.delete(created.id), { success: true });
});

test('BDD: spawned agents inherit a group but not an absent runtime', async () => {
  const createdInputs = [];
  const child = agent({ id: 'child', name: 'Child', canSpawnAgents: false });
  const result = await createPersonalAgentFromAgent({ creatorAgentId: 'creator', name: 'Child' }, {
    requireAgent: async (id) => id === 'creator' ? agent({ groupId: 'team' }) : child,
    requireGroup: (id) => ({ id, name: 'Team', createdAt: 'now', updatedAt: 'now' }),
    createAgent: async (input) => { createdInputs.push(input); return child; },
    grantPeer: async () => {}, deleteAgent: async () => ({ success: true }),
  });
  assert.equal(result.id, 'child');
  assert.equal(createdInputs[0].groupId, 'team');
  assert.equal('runtime' in createdInputs[0], false);

  await createPersonalAgentFromAgent({ creatorAgentId: 'creator', name: 'Runtime child' }, {
    requireAgent: async (id) => id === 'creator' ? agent({ runtime: { provider: 'codex', model: 'gpt-test' } }) : child,
    requireGroup: () => assert.fail('no group expected'),
    createAgent: async (input) => { createdInputs.push(input); return child; },
    grantPeer: async () => {}, deleteAgent: async () => ({ success: true }),
  });
  assert.deepEqual(createdInputs[1].runtime, { provider: 'codex', model: 'gpt-test' });
});

test('BDD: legacy OTHERS content without a durable heading is left untouched', () => {
  const content = 'This file defines how `Helper` collaborates.\n\n## Source Of Truth\n\nNo durable section.';
  assert.equal(extractLegacyOthersDurableCriteria(content), null);
});

test('BDD: workspace traversal sorts directories first and enforces depth and entry limits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-b31-workspace-'));
  let deep = path.join(root, 'folder');
  await mkdir(deep);
  for (let index = 0; index < 6; index += 1) {
    deep = path.join(deep, `nested-${index}`);
    await mkdir(deep);
  }
  await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(path.join(root, `file-${String(index).padStart(3, '0')}.txt`), 'x')));
  const entries = await readPersonalAgentWorkspaceEntries({ workspaceRoot: root, ensureContained: async (_root, candidate) => candidate });
  assert.equal(entries[0].kind, 'directory');
  const countEntries = (items) => items.reduce((total, item) => total + 1 + (item.children ? countEntries(item.children) : 0), 0);
  assert.equal(countEntries(entries), 200);
  let cursor = entries[0];
  while (cursor.children.length > 0) cursor = cursor.children[0];
  assert.deepEqual(cursor.children, []);
  const orderingRoot = await mkdtemp(path.join(tmpdir(), 'forger-b31-workspace-order-'));
  await mkdir(path.join(orderingRoot, 'a-directory'));
  await writeFile(path.join(orderingRoot, 'z-file.txt'), 'x');
  assert.deepEqual((await readPersonalAgentWorkspaceEntries({
    workspaceRoot: orderingRoot, ensureContained: async (_root, candidate) => candidate,
  })).map((entry) => entry.kind), ['directory', 'file']);
  assert.deepEqual(require('../../dist-electron/main/personal-agents/agent-store-rows.js'), {});
  await rm(orderingRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});
