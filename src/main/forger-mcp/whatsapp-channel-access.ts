import { isWhatsAppChannelToolSupported } from '../../shared/whatsapp-channel-tool-support';
import { getToolAppId, isAppScopedTool } from '../forger-mcp-server-helpers';
import type { AgentToolId, AppSummary, PersonalAgent, PersonalAgentPeerThread } from '../../shared/types';
import type { PersonalAgentWhatsAppChannel } from '../personal-agents/agent-conversation-manager';
import type { AgentMcpSession } from '../forger-mcp-server';

export interface WhatsAppChannelAccessInput {
  channel: PersonalAgentWhatsAppChannel;
  runId: string;
  agentId: string;
  conversationId: string;
}
export type WhatsAppChannelAgentReader = (input: WhatsAppChannelAccessInput) => Promise<PersonalAgent | null>;

export const refreshWhatsAppChannelAccess = async (session: AgentMcpSession, read?: WhatsAppChannelAgentReader): Promise<boolean> => {
  if (!session.whatsappChannel) return true;
  let agent: PersonalAgent | null = null;
  try {
    agent = session.personalAgentId && session.personalAgentConversationId && read
      ? await read({ channel: session.whatsappChannel, runId: session.runId, agentId: session.personalAgentId, conversationId: session.personalAgentConversationId })
      : null;
  } catch {
    // An unavailable authority cannot extend cached grants or disclose its error.
  }
  session.appIds = agent?.appIds ?? [];
  session.forgerToolActionIds = agent?.toolIds ?? [];
  session.officialToolActionIds = agent?.toolIds ?? [];
  session.connectionGrants = agent?.connectionGrants ?? [];
  session.whatsappChannelAllowedConnectionActionIds = session.connectionGrants.flatMap(grant => grant.actions.filter(action => action.startsWith('whatsapp.')));
  session.whatsappChannelPeerAgentIds = agent?.peerAgentGrants.map(grant => grant.agentId) ?? [];
  return Boolean(agent);
};

/** Private platform state and configuration tools are never inherited by a chat. */
export const whatsAppChannelToolAllowed = (session: AgentMcpSession, tool: string, args?: Record<string, unknown>): boolean => {
  if (!session.whatsappChannel) return true;
  if (!isWhatsAppChannelToolSupported(tool)) return false;
  if (isAppScopedTool(tool as AgentToolId) && (!session.appIds.length || (args && !session.appIds.includes(getToolAppId(session, args))))) return false;
  if (tool === 'forger_list_agent_peers' || tool === 'forger_read_agent_thread') return Boolean(session.whatsappChannelPeerAgentIds?.length);
  if (tool === 'forger_ask_agent') {
    if (!args) return Boolean(session.whatsappChannelPeerAgentIds?.length);
    // Continuing a thread resolves and checks its target and source conversation
    // in the dispatch handler before asking the peer.
    return typeof args.targetAgentId === 'string'
      ? Boolean(session.whatsappChannelPeerAgentIds?.includes(args.targetAgentId))
      : Boolean(typeof args.threadId === 'string' && args.threadId.trim() && session.whatsappChannelPeerAgentIds?.length);
  }
  if (tool === 'forger_connection_list' || tool === 'forger_connection_status') return session.connectionGrants.length > 0;
  return session.forgerToolActionIds.includes(tool) || session.connectionGrants.some(grant => grant.actions.includes(tool));
};

export const whatsAppChannelThreadAllowed = (session: AgentMcpSession, thread?: PersonalAgentPeerThread | null): boolean =>
  !session.whatsappChannel || Boolean(thread && thread.sourceConversationId === session.personalAgentConversationId && session.whatsappChannelPeerAgentIds?.includes(thread.targetAgentId));

/** A chat discovers only selected apps and never receives private installation paths. */
export const whatsAppChannelVisibleApps = (
  session: AgentMcpSession,
  apps: Array<AppSummary & { path?: string }>,
): Array<AppSummary & { path?: string }> => !session.whatsappChannel ? apps :
  apps.filter(app => session.appIds.includes(app.id)).map(app => {
    const visible = { ...app };
    delete visible.path;
    return visible;
  });
