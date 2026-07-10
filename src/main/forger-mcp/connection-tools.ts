import type {
  AgentToolId,
  CallConnectionActionInput,
  CallConnectionActionResult,
  ConnectionSessionGrant,
  ConnectionsState,
} from '../../shared/types';
import { getSharedCopy } from '../../shared/i18n';
import type { AgentMcpSession } from '../forger-mcp-server';
import { cleanString, dedupeConnectionGrants } from '../forger-mcp-server-helpers';

interface ConnectionMcpToolOptions {
  callConnectionFromSession: (
    input: CallConnectionActionInput,
    grants: ConnectionSessionGrant[],
    access: { caller: AgentMcpSession['caller']; appId: string; locale?: string },
  ) => Promise<CallConnectionActionResult>;
  listConnectionGrantsForApp: (appId: string) => Promise<ConnectionSessionGrant[]>;
  listConnectionsForSession: (grants: ConnectionSessionGrant[]) => Promise<ConnectionsState & { grants: ConnectionSessionGrant[] }>;
}

export const getEffectiveConnectionGrants = async (
  session: AgentMcpSession,
  options: ConnectionMcpToolOptions,
): Promise<ConnectionSessionGrant[]> => {
  if (session.caller === 'app-agent') {
    return await options.listConnectionGrantsForApp(session.appId);
  }
  return dedupeConnectionGrants(session.connectionGrants);
};

export const executeConnectionManagementTool = async (
  session: AgentMcpSession,
  toolId: AgentToolId,
  args: Record<string, unknown>,
  options: ConnectionMcpToolOptions,
): Promise<unknown> => {
  const grants = await getEffectiveConnectionGrants(session, options);
  if (toolId === 'forger_connection_list') {
    const state = await options.listConnectionsForSession(grants);
    const type = cleanString(args.type);
    if (!type) {
      return { success: true, ...state };
    }
    return {
      success: true,
      types: state.types.filter((definition) => definition.type === type),
      instances: state.instances.filter((instance) => instance.type === type),
      grants: state.grants.filter((grant) => grant.type === type),
    };
  }
  if (toolId === 'forger_connection_status') {
    const type = cleanString(args.type);
    if (!type) {
      return { success: false, userMessage: 'Connection type is required.', technicalCode: 'connection_type_required' };
    }
    return await options.callConnectionFromSession(
      {
        type,
        actionId: `${type}.connection.status`,
        input: {},
        ...(cleanString(args.connectionId) ? { connectionId: cleanString(args.connectionId) } : {}),
      },
      grants,
      { caller: session.caller, appId: session.appId, locale: session.locale },
    );
  }
  return { success: false, userMessage: getSharedCopy(session.locale).tools.unavailable, technicalCode: 'tool_not_found' };
};
