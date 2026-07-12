import type { PersonalAgent } from '../../shared/types';
import { renderPromptFile } from './index';
import { isForgerConnectionActionId } from './official-tools';

export const PERSONAL_AGENT_WORKSPACE_FILES = ['AGENTS.md', 'WHO.md', 'WHY.md', 'HOW.md', 'HUMAN.md', 'OTHERS.md'] as const;
export type PersonalAgentWorkspaceFileName = (typeof PERSONAL_AGENT_WORKSPACE_FILES)[number];

export const PERSONAL_AGENT_PROMPT_MARKER = 'FORGER_PERSONAL_AGENT_PROMPT_VERSION: 1';

const formatActionIds = (actions: string[]): string =>
  actions.length > 0 ? actions.map((action) => `\`${action}\``).join(', ') : 'none';

const buildPersonalAgentForgerToolsContext = (agent: PersonalAgent): string => {
  const forgerToolActions = agent.toolIds.filter((toolId) => !isForgerConnectionActionId(toolId));
  if (forgerToolActions.length === 0) {
    return '- No Forger Tool actions are granted to this personal agent.';
  }
  return [
    '- Granted Forger Tool actions:',
    ...forgerToolActions.map((action) => `  - ${action}`),
  ].join('\n');
};

const buildPersonalAgentConnectionsContext = (agent: PersonalAgent): string => {
  const grantLines = agent.connectionGrants.map((grant) => {
    const binding = (grant.connectionIds?.length ?? 0) > 0
      ? 'specific account/session binding is present'
      : 'no specific account/session binding is embedded';
    return `  - ${grant.type}: actions ${formatActionIds(grant.actions)}; multiple allowed: ${grant.multiple ? 'yes' : 'no'}; ${binding}.`;
  });
  if (grantLines.length === 0) {
    return '- No Connections are granted to this personal agent.';
  }
  return [
    '- Granted Connections:',
    ...grantLines,
    '- Check the matching `*.connection.status` action before external account work when state is unclear.',
    '- If multiple accounts or sessions are possible and the intended account is ambiguous, ask the person which account/session to use.',
    '- Sensitive sends, creates, attachment reads, and external writes still require visible Forger approval when Forger asks.',
  ].join('\n');
};

const buildPersonalAgentSpawnContext = (agent: PersonalAgent): string => {
  if (!agent.canSpawnAgents) {
    return '- Agent creation: disabled. `forger_create_personal_agent` is not available in this run. Do not claim that you can create agents or attempt to bypass this permission.';
  }
  return [
    '- Agent creation: enabled. `forger_create_personal_agent` is available in this run.',
    '- Use it only when the human explicitly asks or authorizes you to create a personal agent. Do not create agents speculatively or only to delegate ordinary work.',
    '- A created agent starts with safe permissions, no internet, no apps, no tools, no connections, and no permission to create more agents.',
    "- The created agent inherits the creator's runtime and, unless another valid group is selected, inherits the creator's group.",
    '- The creator can contact the created agent automatically. The created agent does not receive reciprocal contact permission automatically.',
  ].join('\n');
};

const agentPromptVariables = (agent: PersonalAgent) => ({
  promptMarker: PERSONAL_AGENT_PROMPT_MARKER,
  agentName: agent.name,
  agentDescription: agent.description || 'No description has been written yet.',
  agentPurpose: agent.purpose || 'The user has not refined this agent purpose yet.',
  agentInstructions: agent.instructions || 'No extra user instructions have been written yet.',
  permissionMode: agent.permissionMode,
  networkAccess: agent.networkAccess ? 'enabled' : 'disabled',
  spawnAgentsContext: buildPersonalAgentSpawnContext(agent),
  grantedForgerToolsContext: buildPersonalAgentForgerToolsContext(agent),
  grantedConnectionsContext: buildPersonalAgentConnectionsContext(agent),
});

export const buildPersonalAgentWorkspaceDocuments = (agent: PersonalAgent): Record<PersonalAgentWorkspaceFileName, string> => ({
  'AGENTS.md': renderPromptFile('personal-agents/workspace/AGENTS.md', agentPromptVariables(agent)),
  'WHO.md': renderPromptFile('personal-agents/workspace/WHO.md', agentPromptVariables(agent)),
  'WHY.md': renderPromptFile('personal-agents/workspace/WHY.md', agentPromptVariables(agent)),
  'HOW.md': renderPromptFile('personal-agents/workspace/HOW.md', agentPromptVariables(agent)),
  'HUMAN.md': renderPromptFile('personal-agents/workspace/HUMAN.md', agentPromptVariables(agent)),
  'OTHERS.md': renderPromptFile('personal-agents/workspace/OTHERS.md', agentPromptVariables(agent)),
});

export const buildPersonalAgentInitialWakePrompt = (params: {
  agent: PersonalAgent;
  memoryRegister: string;
}): string =>
  renderPromptFile('personal-agents/initial-wake.md', {
    ...agentPromptVariables(params.agent),
    memoryRegister: params.memoryRegister,
  });
