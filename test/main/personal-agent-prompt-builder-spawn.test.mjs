import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildPersonalAgentInitialWakePrompt } = require('../../dist-electron/main/prompt-builder/personal-agents.js');
const { buildPersonalAgentSkillTemplates } = require('../../dist-electron/main/prompt-builder/official-tools.js');

const buildAgent = (canSpawnAgents, peerAgentGrants = []) => ({
  id: 'agent-lead',
  name: 'Team lead',
  description: 'Coordinates specialists.',
  purpose: 'Coordinate a group of personal agents.',
  instructions: '',
  permissionMode: 'safe',
  networkAccess: false,
  canSpawnAgents,
  appIds: [],
  toolIds: [],
  connectionGrants: [],
  peerAgentGrants,
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
});

test('personal-agent prompt does not repeat agent-tool configuration or instructions', () => {
  const enabled = buildPersonalAgentInitialWakePrompt({
    agent: buildAgent(true, [{ agentId: 'budget', name: 'Budget reviewer', criteria: 'Use for budget checks.' }]),
    memoryRegister: '- No memories.',
  });
  const disabled = buildPersonalAgentInitialWakePrompt({
    agent: buildAgent(false),
    memoryRegister: '- No memories.',
  });

  assert.doesNotMatch(enabled, /Create other agents:/);
  assert.doesNotMatch(enabled, /Contact other agents:/);
  assert.doesNotMatch(enabled, /Budget reviewer/);
  assert.doesNotMatch(enabled, /Use for budget checks/);
  assert.doesNotMatch(enabled, /forger_create_personal_agent/);
  assert.doesNotMatch(enabled, /forger_ask_agent/);
  assert.doesNotMatch(enabled, /explicitly asks or authorizes/);

  assert.doesNotMatch(disabled, /Create other agents:/);
  assert.doesNotMatch(disabled, /Contact other agents:/);
  assert.doesNotMatch(disabled, /forger_create_personal_agent/);
  assert.doesNotMatch(disabled, /forger_list_agent_peers/);
});

test('personal-agent-tools skill owns spawn and peer communication instructions', () => {
  const skill = buildPersonalAgentSkillTemplates().find((template) => template.id === 'forger-personal-agent-tools');
  assert.ok(skill);
  assert.match(skill.description, /create or communicate with other personal agents/i);
  assert.match(skill.body, /forger_create_personal_agent/);
  assert.match(skill.body, /forger_list_agent_peers/);
  assert.match(skill.body, /forger_ask_agent/);
  assert.match(skill.body, /forger_read_agent_thread/);
  assert.match(skill.body, /explicit request or authorization/);
  assert.match(skill.body, /safe permissions, no internet, no apps, no tools, no connections/);
  assert.match(skill.body, /threadId/);
  assert.match(skill.body, /does not automatically receive reciprocal access/);
});
