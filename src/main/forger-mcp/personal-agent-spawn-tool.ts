import type { PersonalAgent } from '../../shared/types';
import type { AgentMcpSession } from '../forger-mcp-server';
import { cleanString } from '../forger-mcp-server-helpers';

export interface PersonalAgentSpawnToolOptions {
  createPersonalAgentFromAgent?: (input: {
    creatorAgentId: string;
    name: string;
    description?: string;
    purpose?: string;
    instructions?: string;
    groupId?: string;
  }) => Promise<PersonalAgent>;
}

export const canUsePersonalAgentSpawnTool = (session: AgentMcpSession): boolean =>
  session.caller === 'personal-agent' && Boolean(session.personalAgentId && session.personalAgentCanSpawnAgents);

export const executePersonalAgentSpawnTool = async (
  session: AgentMcpSession,
  args: Record<string, unknown>,
  options: PersonalAgentSpawnToolOptions,
): Promise<Record<string, unknown>> => {
  const english = session.locale?.toLowerCase().startsWith('en') === true;
  if (!canUsePersonalAgentSpawnTool(session) || !options.createPersonalAgentFromAgent) {
    return {
      success: false,
      userMessage: english
        ? 'This agent does not have permission to create other agents.'
        : 'Este agente no tiene permiso para crear otros agentes.',
      technicalCode: 'personal_agent_spawn_permission_required',
    };
  }
  const name = cleanString(args.name);
  if (!name) {
    return {
      success: false,
      userMessage: english ? 'Give the new agent a name.' : 'Indica un nombre para el nuevo agente.',
      technicalCode: 'personal_agent_name_required',
    };
  }
  const created = await options.createPersonalAgentFromAgent({
    creatorAgentId: session.personalAgentId as string,
    name,
    ...(cleanString(args.description) ? { description: cleanString(args.description) } : {}),
    ...(cleanString(args.purpose) ? { purpose: cleanString(args.purpose) } : {}),
    ...(cleanString(args.instructions) ? { instructions: cleanString(args.instructions) } : {}),
    ...(cleanString(args.groupId) ? { groupId: cleanString(args.groupId) } : {}),
  });
  return {
    success: true,
    agent: created,
    userMessage: english
      ? `${created.name} was created and added to your available agents.`
      : `${created.name} fue creado y agregado a tus agentes disponibles.`,
  };
};
