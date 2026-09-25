import type { AgentToolDefinition } from '../../shared/types';
import type { AgentMcpSession } from '../forger-mcp-server';
import { getMcpToolAnnotations, getMcpToolInputSchema, type McpToolAnnotations } from './tool-metadata';
import {
  PERSONAL_AGENT_PEER_TOOL_IDS,
  PERSONAL_AGENT_ROUTINE_TOOL_IDS,
  WORKFLOW_MANAGEMENT_TOOL_IDS,
  SIDEKICK_VOICE_TOOL_IDS,
  WORKFLOW_NODE_TOOL_IDS,
} from './internal-tools';
import { canUsePersonalAgentSpawnTool } from './personal-agent-spawn-tool';
import { isConnectionAction, isOfficialTool } from '../forger-mcp-server-helpers';
import { WHATSAPP_CHANNEL_HISTORY_MCP_TOOL } from './whatsapp-channel-history';

export interface ForgerMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

export const buildVisibleMcpTools = (input: {
  session: AgentMcpSession;
  definitions: AgentToolDefinition[];
  allowedOfficialActions: Set<string> | null;
  allowedConnectionActions: Set<string>;
  hasWhatsAppHistory: boolean;
}): ForgerMcpTool[] => {
  const { session, definitions, allowedOfficialActions, allowedConnectionActions } = input;
  const tools: ForgerMcpTool[] = definitions.filter((tool) => {
    if (session.whatsappChannel && !session.whatsappChannel.allowAgentCapabilities) return false;
    if (tool.id === 'forger_add_app_to_personal_agent' && session.caller !== 'personal-agent') return false;
    if (tool.id === 'forger_create_personal_agent' && !canUsePersonalAgentSpawnTool(session)) return false;
    if (PERSONAL_AGENT_PEER_TOOL_IDS.has(tool.id) && (session.caller !== 'personal-agent' || !session.personalAgentId || !session.personalAgentConversationId)) return false;
    if (PERSONAL_AGENT_ROUTINE_TOOL_IDS.has(tool.id) && (session.caller !== 'personal-agent' || !session.personalAgentId || !session.personalAgentConversationId)) return false;
    if (WORKFLOW_NODE_TOOL_IDS.has(tool.id) && session.caller !== 'workflow') return false;
    if (SIDEKICK_VOICE_TOOL_IDS.has(tool.id) && (session.caller !== 'personal-agent' || !session.sidekick || !session.personalAgentConversationId)) return false;
    if (WORKFLOW_MANAGEMENT_TOOL_IDS.has(tool.id) && (session.caller === 'workflow' || session.caller === 'app-agent')) return false;
    if (isConnectionAction(tool.id)) {
      if (session.whatsappChannel && tool.id.startsWith('whatsapp.') && !session.whatsappChannelAllowedConnectionActionIds?.includes(tool.id)) return false;
      return allowedConnectionActions.has(tool.id);
    }
    if (!isOfficialTool(tool.id)) return true;
    return allowedOfficialActions ? allowedOfficialActions.has(tool.id) : true;
  }).map((tool) => ({
    name: tool.id,
    description: tool.description,
    inputSchema: getMcpToolInputSchema(tool.id),
    annotations: getMcpToolAnnotations(tool),
  }));
  if (
    input.hasWhatsAppHistory && session.caller === 'personal-agent' &&
    session.personalAgentId && session.personalAgentConversationId && session.whatsappChannel
  ) tools.push(WHATSAPP_CHANNEL_HISTORY_MCP_TOOL);
  return tools;
};
