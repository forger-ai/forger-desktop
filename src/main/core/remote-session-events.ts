export type RemoteTunnelCloseEvent = { type: 'remote_tunnel_close'; session_id: string };
export type RemoteAgentSessionCloseEvent = { type: string; agent_id?: string; agentId?: string; session_id?: string; sessionId?: string };

export const isRemoteTunnelCloseEvent = (event: unknown): event is RemoteTunnelCloseEvent =>
  Boolean(
    event
      && typeof event === 'object'
      && (event as { type?: unknown }).type === 'remote_tunnel_close'
      && typeof (event as { session_id?: unknown }).session_id === 'string',
  );

export const isRemoteAgentSessionCloseEvent = (event: unknown): event is RemoteAgentSessionCloseEvent =>
  Boolean(
    event
      && typeof event === 'object'
      && ['agent_access_disconnect_requested', 'remote_agent_session_close', 'personal_agent_session_close'].includes(String((event as { type?: unknown }).type))
      && (
        typeof (event as { agent_id?: unknown }).agent_id === 'string'
        || typeof (event as { agentId?: unknown }).agentId === 'string'
        || typeof (event as { session_id?: unknown }).session_id === 'string'
        || typeof (event as { sessionId?: unknown }).sessionId === 'string'
      ),
  );
