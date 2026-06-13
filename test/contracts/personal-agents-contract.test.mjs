import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');

test('personal agents IPC channels keep stable public names', () => {
  assert.deepEqual(
    {
      personalAgentsList: IPC_CHANNELS.personalAgentsList,
      personalAgentsCreate: IPC_CHANNELS.personalAgentsCreate,
      personalAgentGrantOptionsList: IPC_CHANNELS.personalAgentGrantOptionsList,
      personalAgentUpdatePermissions: IPC_CHANNELS.personalAgentUpdatePermissions,
      personalAgentsDelete: IPC_CHANNELS.personalAgentsDelete,
      personalAgentConversationsList: IPC_CHANNELS.personalAgentConversationsList,
      personalAgentWorkspaceList: IPC_CHANNELS.personalAgentWorkspaceList,
      personalAgentWorkspaceFileRead: IPC_CHANNELS.personalAgentWorkspaceFileRead,
      personalAgentWorkspaceFileWrite: IPC_CHANNELS.personalAgentWorkspaceFileWrite,
      personalAgentStartConversation: IPC_CHANNELS.personalAgentStartConversation,
      personalAgentSendMessage: IPC_CHANNELS.personalAgentSendMessage,
      personalAgentGetConversation: IPC_CHANNELS.personalAgentGetConversation,
      personalAgentConversationEvent: IPC_CHANNELS.personalAgentConversationEvent,
    },
    {
      personalAgentsList: 'forger:personal-agents:list',
      personalAgentsCreate: 'forger:personal-agents:create',
      personalAgentGrantOptionsList: 'forger:personal-agents:grant-options:list',
      personalAgentUpdatePermissions: 'forger:personal-agents:permissions:update',
      personalAgentsDelete: 'forger:personal-agents:delete',
      personalAgentConversationsList: 'forger:personal-agents:conversations:list',
      personalAgentWorkspaceList: 'forger:personal-agents:workspace:list',
      personalAgentWorkspaceFileRead: 'forger:personal-agents:workspace:file:read',
      personalAgentWorkspaceFileWrite: 'forger:personal-agents:workspace:file:write',
      personalAgentStartConversation: 'forger:personal-agents:conversation:start',
      personalAgentSendMessage: 'forger:personal-agents:conversation:send',
      personalAgentGetConversation: 'forger:personal-agents:conversation:get',
      personalAgentConversationEvent: 'forger:personal-agents:conversation:event',
    },
  );
});

test('preload and desktop API expose typed personal agent commands without path access', async () => {
  const preloadSource = await readFile(new URL('../../src/preload/index.ts', import.meta.url), 'utf8');
  const apiSource = await readFile(new URL('../../src/shared/types/desktop-api.ts', import.meta.url), 'utf8');

  for (const method of [
    'personalAgentsList',
    'personalAgentsCreate',
    'personalAgentGrantOptionsList',
    'personalAgentUpdatePermissions',
    'personalAgentsDelete',
    'personalAgentConversationsList',
    'personalAgentWorkspaceList',
    'personalAgentWorkspaceFileRead',
    'personalAgentWorkspaceFileWrite',
    'personalAgentStartConversation',
    'personalAgentSendMessage',
    'personalAgentGetConversation',
    'onPersonalAgentConversationEvent',
  ]) {
    assert.match(preloadSource, new RegExp(`${method}:`), `${method} should be exposed by preload`);
    assert.match(apiSource, new RegExp(`${method}:`), `${method} should be typed on ForgerDesktopApi`);
  }

  assert.doesNotMatch(apiSource, /workspacePath/);
});

test('renderer has an Agents view that can list, create, delete, inspect, start, and send through the desktop bridge', async () => {
  const sidebarSource = await readFile(new URL('../../src/renderer/components/Sidebar.tsx', import.meta.url), 'utf8');
  const appViewSource = await readFile(new URL('../../src/renderer/app/RendererAppView.tsx', import.meta.url), 'utf8');
  const agentsViewSource = await readFile(new URL('../../src/renderer/views/AgentsView.tsx', import.meta.url), 'utf8');

  assert.match(sidebarSource, /'agents'/);
  assert.match(appViewSource, /<AgentsView/);
  assert.match(appViewSource, /intelligenceProviderConfigured=\{intelligenceProviderConfigured\}/);
  assert.match(agentsViewSource, /personalAgentsList/);
  assert.match(agentsViewSource, /personalAgentsCreate/);
  assert.match(agentsViewSource, /personalAgentGrantOptionsList/);
  assert.match(agentsViewSource, /personalAgentUpdatePermissions/);
  assert.match(agentsViewSource, /personalAgentsDelete/);
  assert.match(agentsViewSource, /personalAgentConversationsList/);
  assert.match(agentsViewSource, /personalAgentWorkspaceList/);
  assert.match(agentsViewSource, /personalAgentWorkspaceFileRead/);
  assert.match(agentsViewSource, /personalAgentWorkspaceFileWrite/);
  assert.doesNotMatch(agentsViewSource, /hoverFilePanel|filePanelHoverable|filePanelHoverActive/);
  assert.match(agentsViewSource, /personalAgentStartConversation/);
  assert.match(agentsViewSource, /personalAgentSendMessage/);
  assert.match(agentsViewSource, /onPersonalAgentConversationEvent/);
  assert.match(agentsViewSource, /historyTab/);
  assert.match(agentsViewSource, /workspaceTab/);
  assert.match(agentsViewSource, /role !== 'system'/);
  assert.doesNotMatch(agentsViewSource, /kind !== 'intermediate'/);
  assert.match(agentsViewSource, /item\.kind === 'intermediate'/);
  assert.match(agentsViewSource, /justifyContent=\{isUser \? 'flex-end' : 'flex-start'\}/);
  assert.match(agentsViewSource, /bgcolor: isUser \? 'primary\.main' : 'transparent'/);
  assert.match(agentsViewSource, /MarkdownMessage content=\{item\.content\}/);
  assert.doesNotMatch(agentsViewSource, /chatActivity|latestProgress/);
  assert.doesNotMatch(agentsViewSource, /label=\{runStatusLabel\(activeRun\?\.status\)\}/);
  assert.match(agentsViewSource, /runErrorLlmAuth/);
  assert.match(agentsViewSource, /intelligenceProviderConfigured \? \(/);
  assert.match(agentsViewSource, /llmRequired/);
  assert.doesNotMatch(agentsViewSource, /workspaceTitle/);
  assert.doesNotMatch(agentsViewSource, /t\.agents\.person|t\.agents\.agent/);
  assert.match(agentsViewSource, /permissionLevel/);
  assert.match(agentsViewSource, /appsAccess/);
  assert.match(agentsViewSource, /toolsAccess/);
  assert.match(agentsViewSource, /editAccess/);
});

test('personal agent auth copy is provider-neutral in the Agents surface', async () => {
  const englishSource = await readFile(new URL('../../src/renderer/i18n/en.ts', import.meta.url), 'utf8');
  const spanishSource = await readFile(new URL('../../src/renderer/i18n/es.ts', import.meta.url), 'utf8');

  assert.match(englishSource, /runErrorLlmAuth: 'Connect an LLM to start this conversation\.'/);
  assert.match(spanishSource, /runErrorLlmAuth: 'Conecta un LLM para iniciar esta conversación\.'/);
  assert.doesNotMatch(englishSource, /runErrorCodexAuth|runErrorClaudeAuth/);
  assert.doesNotMatch(spanishSource, /runErrorCodexAuth|runErrorClaudeAuth/);
});

test('personal agent public types include run and event contracts', async () => {
  const typesSource = await readFile(new URL('../../src/shared/types/personal-agents.ts', import.meta.url), 'utf8');

  assert.match(typesSource, /PersonalAgentRunStatus/);
  assert.match(typesSource, /PersonalAgentUpdatePermissionsInput/);
  assert.match(typesSource, /PersonalAgentGrantOptions/);
  assert.match(typesSource, /appIds: string\[\]/);
  assert.match(typesSource, /toolIds: AgentToolId\[\]/);
  assert.match(typesSource, /PersonalAgentRunProgress/);
  assert.match(typesSource, /PersonalAgentConversationEvent/);
  assert.match(typesSource, /activeRun\?: PersonalAgentRun/);
  assert.match(typesSource, /runId\?: string/);
  assert.match(typesSource, /initialMessage\?: string/);
});

test('personal agent runtime wires Forger and granted app MCP access', async () => {
  const managerSource = await readFile(new URL('../../src/main/personal-agents/agent-conversation-manager.ts', import.meta.url), 'utf8');
  const mcpSource = await readFile(new URL('../../src/main/forger-mcp-server.ts', import.meta.url), 'utf8');
  const mainProcessSource = await readFile(new URL('../../src/main/core/main-process.ts', import.meta.url), 'utf8');

  assert.match(managerSource, /createForgerMcpSession/);
  assert.match(managerSource, /listenAppMcps\?\.\(input\.agent\.appIds, input\.run\.id\)/);
  assert.match(managerSource, /buildMcpArgs\(mcpServers\)/);
  assert.match(managerSource, /writeClaudeMcpConfig\(input\.workspaceRoot, mcpServers\)/);
  assert.match(managerSource, /assertAllowedMcpServers\(result\.stdout, result\.stderr/);
  assert.match(mainProcessSource, /caller: 'personal-agent'/);
  assert.match(mainProcessSource, /officialToolActionIds: agent\.toolIds/);
  assert.match(mcpSource, /personal-agent/);
  assert.match(mcpSource, /personal_agent_tool_not_granted/);
  assert.match(mcpSource, /personal_agent_app_not_granted/);
});
