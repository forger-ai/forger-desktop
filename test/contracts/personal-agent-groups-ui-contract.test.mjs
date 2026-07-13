import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const agentsViewPath = new URL('../../src/renderer/views/AgentsView.tsx', import.meta.url);
const accessControlsPath = new URL('../../src/renderer/views/AgentAccessControls.tsx', import.meta.url);
const helpersPath = new URL('../../src/renderer/views/AgentsView.helpers.tsx', import.meta.url);
const groupCopyPath = new URL('../../src/renderer/i18n/locales/agentGroups.ts', import.meta.url);

test('Agents view presents optional groups, a localized ungrouped section, and created-by provenance', async () => {
  const source = await readFile(agentsViewPath, 'utf8');

  assert.match(source, /groupAgentsForDisplay\(agents, agentGroups\)/);
  assert.match(source, /t\.agents\.ungrouped/);
  assert.match(source, /agent\.createdByAgentId/);
  assert.match(source, /t\.agents\.createdBy\(/);
  assert.match(source, /t\.agents\.manageGroups/);
  assert.match(source, /personalAgentGroupsList\(\)/);
  assert.match(source, /personalAgentGroupsCreate\(/);
  assert.match(source, /personalAgentGroupsUpdate\(/);
  assert.match(source, /personalAgentGroupsDelete\(/);
  assert.match(source, /personalAgentUpdateGroup\(/);
});

test('agent display grouping is deterministic and preserves an explicit final bucket for ungrouped or orphaned agents', async () => {
  const source = await readFile(helpersPath, 'utf8');

  assert.match(source, /export const groupAgentsForDisplay/);
  assert.match(source, /localeCompare/);
  assert.match(source, /groupId:\s*null/);
  assert.match(source, /!agent\.groupId/);
  assert.match(source, /agent\.groupId === group\.id/);
});

test('spawn permission is opt-in in both create and settings access drafts', async () => {
  const [helpers, controls, view] = await Promise.all([
    readFile(helpersPath, 'utf8'),
    readFile(accessControlsPath, 'utf8'),
    readFile(agentsViewPath, 'utf8'),
  ]);

  assert.match(helpers, /canSpawnAgents:\s*false/);
  assert.match(helpers, /canSpawnAgents:\s*agent\.canSpawnAgents/);
  assert.match(controls, /checked=\{draft\.canSpawnAgents\}/);
  assert.match(controls, /t\.agents\.canSpawnAgents/);
  assert.match(controls, /t\.agents\.canSpawnAgentsHint/);
  assert.match(view, /canSpawnAgents:\s*createAccessDraft\.canSpawnAgents/);
  assert.match(view, /canSpawnAgents:\s*settingsAccessDraft\.canSpawnAgents/);
});

test('agent spawning and group management copy is complete and localized in English and Spanish', async () => {
  const source = await readFile(groupCopyPath, 'utf8');
  const englishStart = source.indexOf('export const enAgentGroups');
  const spanishStart = source.indexOf('export const esAgentGroups');
  assert.ok(englishStart >= 0 && spanishStart > englishStart);
  const english = source.slice(englishStart, spanishStart);
  const spanish = source.slice(spanishStart);

  for (const key of [
    'manageGroups',
    'groupsTitle',
    'groupsSubtitle',
    'group',
    'noGroup',
    'ungrouped',
    'createGroup',
    'groupName',
    'renameGroup',
    'saveGroup',
    'deleteGroup',
    'deleteGroupConfirm',
    'groupsEmpty',
    'groupSaveError',
    'groupDeleteError',
    'createdBy',
    'canSpawnAgents',
    'canSpawnAgentsHint',
  ]) {
    assert.match(english, new RegExp(`${key}:`));
    assert.match(spanish, new RegExp(`${key}:`));
  }

  assert.match(english, /This agent can spawn other agents/);
  assert.match(spanish, /Este agente puede crear otros agentes/);
  assert.match(english, /Created by \$\{name\}/);
  assert.match(spanish, /Creado por \$\{name\}/);
  assert.match(english, /Agents can also remain without a group/);
  assert.match(spanish, /Los agentes también pueden quedar sin grupo/);
});
