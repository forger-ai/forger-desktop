import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildPersonalAgentInitialWakePrompt } = require('../../dist-electron/main/prompt-builder/personal-agents.js');

const buildAgent = (canSpawnAgents) => ({
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
  peerAgentGrants: [],
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
});

test('personal-agent prompt explains the spawn MCP only as an active, explicit permission', () => {
  const enabled = buildPersonalAgentInitialWakePrompt({
    agent: buildAgent(true),
    memoryRegister: '- No memories.',
  });
  const disabled = buildPersonalAgentInitialWakePrompt({
    agent: buildAgent(false),
    memoryRegister: '- No memories.',
  });

  assert.match(enabled, /Agent creation: enabled/);
  assert.match(enabled, /`forger_create_personal_agent` is available/);
  assert.match(enabled, /explicitly asks or authorizes/);
  assert.match(enabled, /safe permissions, no internet, no apps, no tools, no connections/);
  assert.match(enabled, /creator can contact the created agent/);
  assert.match(enabled, /inherits the creator's group/);

  assert.match(disabled, /Agent creation: disabled/);
  assert.match(disabled, /`forger_create_personal_agent` is not available/);
  assert.match(disabled, /Do not claim that you can create agents/);
  assert.doesNotMatch(disabled, /`forger_create_personal_agent` is available/);
});
