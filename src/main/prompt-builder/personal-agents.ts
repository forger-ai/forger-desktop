import type { PersonalAgent } from '../../shared/types';
import { renderPromptFile } from './index';

export const PERSONAL_AGENT_WORKSPACE_FILES = ['AGENTS.md', 'WHO.md', 'WHY.md', 'HOW.md', 'HUMAN.md'] as const;
export type PersonalAgentWorkspaceFileName = (typeof PERSONAL_AGENT_WORKSPACE_FILES)[number];

export const PERSONAL_AGENT_PROMPT_MARKER = 'FORGER_PERSONAL_AGENT_PROMPT_VERSION: 1';

const agentPromptVariables = (agent: PersonalAgent) => ({
  promptMarker: PERSONAL_AGENT_PROMPT_MARKER,
  agentName: agent.name,
  agentDescription: agent.description || 'No description has been written yet.',
  agentPurpose: agent.purpose || 'The user has not refined this agent purpose yet.',
  agentInstructions: agent.instructions || 'No extra user instructions have been written yet.',
  permissionMode: agent.permissionMode,
  networkAccess: agent.networkAccess ? 'enabled' : 'disabled',
});

export const buildPersonalAgentWorkspaceDocuments = (agent: PersonalAgent): Record<PersonalAgentWorkspaceFileName, string> => ({
  'AGENTS.md': renderPromptFile('personal-agents/workspace/AGENTS.md', agentPromptVariables(agent)),
  'WHO.md': renderPromptFile('personal-agents/workspace/WHO.md', agentPromptVariables(agent)),
  'WHY.md': renderPromptFile('personal-agents/workspace/WHY.md', agentPromptVariables(agent)),
  'HOW.md': renderPromptFile('personal-agents/workspace/HOW.md', agentPromptVariables(agent)),
  'HUMAN.md': renderPromptFile('personal-agents/workspace/HUMAN.md', agentPromptVariables(agent)),
});

export const buildPersonalAgentInitialWakePrompt = (params: {
  agent: PersonalAgent;
  memoryRegister: string;
}): string =>
  renderPromptFile('personal-agents/initial-wake.md', {
    ...agentPromptVariables(params.agent),
    memoryRegister: params.memoryRegister,
  });
