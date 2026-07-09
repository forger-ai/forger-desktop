import type {
  AgentToolId,
  CallConnectionActionInput,
  CallConnectionActionResult,
  ConnectionRequirementState,
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
  requestPermission: (
    runId: string,
    request: {
      pluginId: string;
      permission: string;
      reason: string;
      risk: 'low' | 'medium' | 'high';
      resource: string;
    },
  ) => Promise<boolean | null> | null;
  setAppConnectionGrant?: (input: {
    appId: string;
    type: string;
    granted: boolean;
    connectionIds?: string[];
  }) => Promise<ConnectionRequirementState | null>;
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

export const executeConnectionGrantRequest = async (
  session: AgentMcpSession,
  args: Record<string, unknown>,
  options: ConnectionMcpToolOptions,
): Promise<unknown> => {
  const appId = cleanString(args.appId) || session.appId;
  const type = cleanString(args.type);
  if (!appId || !type) {
    return { success: false, appId, userMessage: 'Choose the app and connection type.', technicalCode: 'connection_grant_input_invalid' };
  }
  if (!options.setAppConnectionGrant) {
    return { success: false, appId, userMessage: 'Connection grants are not available yet.', technicalCode: 'connection_grant_unavailable' };
  }
  if (session.caller === 'personal-agent' && !session.appIds.includes(appId)) {
    return { success: false, appId, userMessage: getSharedCopy(session.locale).tools.unavailable, technicalCode: 'personal_agent_app_not_granted' };
  }
  const requestPermission = options.requestPermission(session.runId, {
    pluginId: 'forger-app-connections',
    permission: `optional_connection:${appId}:${type}`,
    reason: cleanString(args.reason) || `Allow this app to use ${type}.`,
    risk: 'medium',
    resource: `Connection ${type}`,
  });
  if (!requestPermission) {
    return { success: false, appId, userMessage: 'Could not show the connection approval prompt.', technicalCode: 'permission_unavailable' };
  }
  const approved = await requestPermission;
  if (!approved) {
    return { success: false, appId, userMessage: 'The connection was not allowed for this app.', technicalCode: approved === null ? 'permission_unavailable' : 'connection_grant_rejected' };
  }
  const connectionIds = Array.isArray(args.connectionIds)
    ? args.connectionIds.map(cleanString).filter(Boolean)
    : undefined;
  const requirement = await options.setAppConnectionGrant({
    appId,
    type,
    granted: true,
    ...(connectionIds?.length ? { connectionIds } : {}),
  });
  return requirement
    ? { success: true, appId, requirement, userMessage: 'The connection is allowed for this app.' }
    : { success: false, appId, userMessage: 'This app did not declare that connection.', technicalCode: 'app_connection_not_declared' };
};
