import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { IpcMain } from 'electron';
import type { AgentConversationManager } from '../personal-agents/agent-conversation-manager';
import type { AgentRoutineManager } from '../personal-agents/agent-routine-manager';
import type { AgentStore } from '../personal-agents/agent-store';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type {
  AgentToolId,
  AppSummary,
  ConnectionsState,
  OfficialToolsState,
  PersonalAgentConversationsListInput,
  PersonalAgentConversationGetInput,
  PersonalAgentConversationDraftUpdateInput,
  PersonalAgentConversationStartInput,
  PersonalAgentCreateInput,
  PersonalAgentDeleteInput,
  PersonalAgent,
  PersonalAgentGrantOptions,
  PersonalAgentGroupCreateInput,
  PersonalAgentGroupDeleteInput,
  PersonalAgentGroupUpdateInput,
  PersonalAgentConnectionGrant,
  PersonalAgentMessageSendInput,
  PersonalAgentPeerGrant,
  PersonalAgentPeerThreadGetInput,
  PersonalAgentPeerThreadsListInput,
  PersonalAgentRoutineDeleteInput,
  PersonalAgentRoutineListInput,
  PersonalAgentRoutineRunNowInput,
  PersonalAgentRoutineSetEnabledInput,
  PersonalAgentRoutineUpsertInput,
  PersonalAgentUpdatePermissionsInput,
  PersonalAgentUpdateGroupInput,
  PersonalAgentWakeupCancelInput,
  PersonalAgentWorkspaceFileReadInput,
  PersonalAgentWorkspaceFileWriteInput,
  PersonalAgentWorkspaceListInput,
  AgentProvider,
  SharedFileRef,
} from '../../shared/types';

interface PersonalAgentIpcHandlersDeps {
  IPC_CHANNELS: typeof IpcChannels;
  fs: typeof fs;
  path: typeof path;
  ipcMain: IpcMain;
  ensurePathInside: (rootPath: string, targetPath: string) => boolean;
  getPrivateDataRoot: () => string;
  getPersonalAgentStore: () => AgentStore;
  getPersonalAgentConversationManager: () => AgentConversationManager;
  getPersonalAgentRoutineManager: () => AgentRoutineManager;
  listInstalledApps: () => AppSummary[];
  listOfficialTools: () => Promise<OfficialToolsState>;
  listConnections: () => Promise<ConnectionsState>;
  isAgentProviderConnected: (provider: AgentProvider) => Promise<boolean>;
}

const isConnectedConnectionInstance = (instance: ConnectionsState['instances'][number]): boolean =>
  instance.status === 'connected';

const connectedInstancesForType = (connections: ConnectionsState, type: string): ConnectionsState['instances'] =>
  connections.instances.filter((instance) => instance.type === type && isConnectedConnectionInstance(instance));

const trimmedTextOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const appGrantOptionName = (app: AppSummary): string => trimmedTextOrUndefined(app.name) ?? app.id;

export const registerPersonalAgentIpcHandlers = ({
  IPC_CHANNELS,
  fs,
  path,
  ipcMain,
  ensurePathInside,
  getPrivateDataRoot,
  getPersonalAgentStore,
  getPersonalAgentConversationManager,
  getPersonalAgentRoutineManager,
  listInstalledApps,
  listOfficialTools,
  listConnections,
  isAgentProviderConnected,
}: PersonalAgentIpcHandlersDeps): void => {
  ipcMain.handle(IPC_CHANNELS.personalAgentsList, async () => {
    return await getPersonalAgentStore().listAgents();
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentsCreate, async (_event, input: PersonalAgentCreateInput) => {
    await validateRuntimeInput(input, isAgentProviderConnected);
    const sanitized = await sanitizePermissionInput(input, listInstalledApps, listOfficialTools, listConnections, () => getPersonalAgentStore().listAgents());
    return await getPersonalAgentStore().createAgent(sanitized);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentGroupsList, async () => {
    return await getPersonalAgentStore().listGroups();
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentGroupsCreate, async (_event, input: PersonalAgentGroupCreateInput) => {
    return await getPersonalAgentStore().createGroup(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentGroupsUpdate, async (_event, input: PersonalAgentGroupUpdateInput) => {
    return await getPersonalAgentStore().updateGroup(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentGroupsDelete, async (_event, input: PersonalAgentGroupDeleteInput) => {
    return await getPersonalAgentStore().deleteGroup(input.groupId);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentUpdateGroup, async (_event, input: PersonalAgentUpdateGroupInput) => {
    return await getPersonalAgentStore().updateAgentGroup(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentGrantOptionsList, async (): Promise<PersonalAgentGrantOptions> => {
    const [apps, officialTools, connections, agents] = await Promise.all([
      Promise.resolve(listInstalledApps()),
      listOfficialTools(),
      listConnections(),
      getPersonalAgentStore().listAgents(),
    ]);
    return {
      apps: apps.map((app) => ({
        appId: app.id,
        name: appGrantOptionName(app),
        description: trimmedTextOrUndefined(app.description) ?? trimmedTextOrUndefined(app.shortDescription),
        status: app.status,
      })),
      tools: officialTools.tools
        .filter((tool) => tool.actions.length > 0)
        .map((tool) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          configured: tool.configured,
          status: tool.status,
          actions: tool.actions.map((action) => ({
            id: action.id as AgentToolId,
            toolId: tool.id,
            name: action.name,
            description: action.description,
            risk: action.risk,
          })),
        })),
      connections: connections.types
        .map((definition) => {
          const instances = connectedInstancesForType(connections, definition.type);
          return {
            type: definition.type,
            displayName: definition.displayName,
            description: definition.description,
            configured: instances.length > 0,
            supportsMultiple: definition.supportsMultiple,
            definition,
            instances,
            actions: definition.actions,
          };
        })
        .filter((connection) => connection.configured && connection.actions.length > 0),
      peerAgents: agents.map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        description: agent.description,
      })),
    };
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentUpdatePermissions, async (_event, input: PersonalAgentUpdatePermissionsInput) => {
    await validateRuntimeInput(input, isAgentProviderConnected);
    const store = getPersonalAgentStore();
    const existingAgent = await store.requireAgent(input.agentId);
    const sanitized = await sanitizePermissionInput(input, listInstalledApps, listOfficialTools, listConnections, () => store.listAgents(), existingAgent);
    return await store.updateAgentPermissions(sanitized);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentsDelete, async (_event, input: PersonalAgentDeleteInput) => {
    return await getPersonalAgentStore().deleteAgent(input.agentId);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentConversationsList, async (_event, input: PersonalAgentConversationsListInput) => {
    return await getPersonalAgentStore().listConversations(input.agentId);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentWorkspaceList, async (_event, input: PersonalAgentWorkspaceListInput) => {
    return await getPersonalAgentStore().listWorkspace(input.agentId);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentWorkspaceFileRead, async (_event, input: PersonalAgentWorkspaceFileReadInput) => {
    return await getPersonalAgentStore().readWorkspaceTextFile(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentWorkspaceFileWrite, async (_event, input: PersonalAgentWorkspaceFileWriteInput) => {
    return await getPersonalAgentStore().writeWorkspaceTextFile(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentStartConversation, async (_event, input: PersonalAgentConversationStartInput) => {
    return await getPersonalAgentConversationManager().startConversation(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentSendMessage, async (_event, input: PersonalAgentMessageSendInput) => {
    const sharedFiles = await sanitizeSharedFiles(input.sharedFiles, { fs, path, getPrivateDataRoot, ensurePathInside });
    return await getPersonalAgentConversationManager().sendMessage(sharedFiles.length > 0
      ? { ...input, sharedFiles }
      : input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentGetConversation, async (_event, input: PersonalAgentConversationGetInput) => {
    return await getPersonalAgentConversationManager().getConversation(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentConversationDraftUpdate, async (_event, input: PersonalAgentConversationDraftUpdateInput) => {
    return await getPersonalAgentRoutineManager().updateDraft(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentWakeupCancel, async (_event, input: PersonalAgentWakeupCancelInput) => {
    return await getPersonalAgentRoutineManager().cancelWakeup(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentRoutinesList, async (_event, input: PersonalAgentRoutineListInput) => {
    return await getPersonalAgentRoutineManager().list(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentRoutinesCreate, async (_event, input: PersonalAgentRoutineUpsertInput & { agentId: string }) => {
    return await getPersonalAgentRoutineManager().create(input.agentId, input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentRoutinesUpdate, async (_event, input: PersonalAgentRoutineUpsertInput & { routineId: string }) => {
    return await getPersonalAgentRoutineManager().update(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentRoutinesSetEnabled, async (_event, input: PersonalAgentRoutineSetEnabledInput) => {
    return await getPersonalAgentRoutineManager().setEnabled(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentRoutinesDelete, async (_event, input: PersonalAgentRoutineDeleteInput) => {
    return await getPersonalAgentRoutineManager().delete(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentRoutinesRunNow, async (_event, input: PersonalAgentRoutineRunNowInput) => {
    return await getPersonalAgentRoutineManager().runNow(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentPeerThreadsList, async (_event, input: PersonalAgentPeerThreadsListInput) => {
    if (!input.conversationId) {
      return [];
    }
    return await getPersonalAgentStore().listPeerThreadsForConversation({
      agentId: input.agentId,
      conversationId: input.conversationId,
    });
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentPeerThreadGet, async (_event, input: PersonalAgentPeerThreadGetInput) => {
    return await getPersonalAgentStore().getPeerThread(input.threadId);
  });
};

const sanitizeSharedFiles = async (
  input: SharedFileRef[] | undefined,
  deps: {
    fs: typeof fs;
    path: typeof path;
    getPrivateDataRoot: () => string;
    ensurePathInside: (rootPath: string, targetPath: string) => boolean;
  },
): Promise<SharedFileRef[]> => {
  if (!input?.length) {
    return [];
  }
  const sharedFiles: SharedFileRef[] = [];
  const privateDataRoot = deps.getPrivateDataRoot();
  const dataRootReal = await deps.fs.realpath(privateDataRoot).catch(async () => {
    await deps.fs.mkdir(privateDataRoot, { recursive: true });
    return deps.fs.realpath(privateDataRoot);
  });
  for (const fileRef of input) {
    const candidatePath = deps.path.isAbsolute(fileRef.path) ? fileRef.path : deps.path.join(privateDataRoot, fileRef.path);
    const realPath = await deps.fs.realpath(candidatePath).catch(() => null);
    if (!realPath || !deps.ensurePathInside(dataRootReal, realPath)) {
      continue;
    }
    sharedFiles.push({
      ...fileRef,
      path: realPath,
      relativePath: fileRef.relativePath ?? deps.path.relative(dataRootReal, realPath).replace(/\\/g, '/'),
      name: fileRef.name ?? deps.path.basename(realPath),
    });
  }
  return sharedFiles;
};

const validateRuntimeInput = async (
  input: PersonalAgentCreateInput | PersonalAgentUpdatePermissionsInput,
  isAgentProviderConnected: (provider: AgentProvider) => Promise<boolean>,
): Promise<void> => {
  const provider = input.runtime?.provider;
  if (!provider) {
    return;
  }
  if (!(await isAgentProviderConnected(provider))) {
    throw new Error('personal_agent_runtime_provider_not_connected');
  }
};

const sanitizePermissionInput = async <T extends PersonalAgentCreateInput | PersonalAgentUpdatePermissionsInput>(
  input: T,
  listInstalledApps: () => AppSummary[],
  listOfficialTools: () => Promise<OfficialToolsState>,
  listConnections: () => Promise<ConnectionsState>,
  listPersonalAgents: () => Promise<Array<{ id: string }>>,
  existingAgent?: PersonalAgent,
): Promise<T> => {
  const installedAppIds = new Set(listInstalledApps().map((app) => app.id));
  const [officialTools, connections, personalAgents] = await Promise.all([
    listOfficialTools(),
    listConnections(),
    input.peerAgentGrants ? listPersonalAgents() : Promise.resolve([]),
  ]);
  const personalAgentIds = new Set(personalAgents.map((agent) => agent.id));
  const connectedInstanceIdsByType = new Map<string, Set<string>>();
  for (const instance of connections.instances) {
    if (!isConnectedConnectionInstance(instance)) {
      continue;
    }
    const current = connectedInstanceIdsByType.get(instance.type) ?? new Set<string>();
    current.add(instance.id);
    connectedInstanceIdsByType.set(instance.type, current);
  }
  const officialActionIds = new Set(
    officialTools.tools
      .flatMap((tool) => tool.actions.map((action) => action.id)),
  );
  const existingAppIds = new Set(existingAgent?.appIds ?? []);
  const existingToolIds = new Set(existingAgent?.toolIds ?? []);
  const existingConnectionGrants = new Map((existingAgent?.connectionGrants ?? []).map((grant) => [grant.type, grant]));
  const declaredConnectionGrants = (input.connectionGrants ?? [])
    .map((grant) => sanitizeConnectionGrant(grant, connections, connectedInstanceIdsByType, existingConnectionGrants.get(grant.type)))
    .filter((grant): grant is PersonalAgentConnectionGrant => Boolean(grant));
  const declaredPeerGrants = (input.peerAgentGrants ?? [])
    .map((grant) => {
      if (!personalAgentIds.has(grant.agentId) || ('agentId' in input && input.agentId === grant.agentId)) return null;
      return {
        agentId: grant.agentId,
        criteria: typeof grant.criteria === 'string' ? grant.criteria.slice(0, 2_000).trim() : '',
      };
    })
    .filter((grant): grant is PersonalAgentPeerGrant => Boolean(grant));
  return {
    ...input,
    ...(input.appIds ? { appIds: input.appIds.filter((appId) => installedAppIds.has(appId) || existingAppIds.has(appId)) } : {}),
    ...(input.toolIds ? { toolIds: input.toolIds.filter((toolId) => officialActionIds.has(toolId) || existingToolIds.has(toolId)) } : {}),
    ...(input.connectionGrants
      ? { connectionGrants: declaredConnectionGrants }
      : {}),
    ...(input.peerAgentGrants
      ? { peerAgentGrants: declaredPeerGrants }
      : {}),
  };
};

const cloneConnectionGrant = (grant: PersonalAgentConnectionGrant): PersonalAgentConnectionGrant => ({
  type: grant.type,
  actions: [...grant.actions],
  multiple: grant.multiple,
  ...(grant.connectionIds ? { connectionIds: [...grant.connectionIds] } : {}),
});

const sanitizeConnectionGrant = (
  grant: PersonalAgentConnectionGrant,
  connections: ConnectionsState,
  connectedInstanceIdsByType: Map<string, Set<string>>,
  existingGrant?: PersonalAgentConnectionGrant,
): PersonalAgentConnectionGrant | null => {
  const definition = connections.types.find((candidate) => candidate.type === grant.type);
  if (!definition) {
    return existingGrant ? cloneConnectionGrant(existingGrant) : null;
  }
  const validActions = new Set(definition.actions.map((action) => action.id));
  const actions = [...new Set(grant.actions.filter((action) => validActions.has(action)))];
  if (actions.length === 0) {
    return existingGrant ? cloneConnectionGrant(existingGrant) : null;
  }
  const validInstanceIds = connectedInstanceIdsByType.get(grant.type) ?? new Set<string>();
  const existingConnectionIds = new Set(existingGrant?.connectionIds ?? []);
  if (validInstanceIds.size === 0 && existingGrant) {
    return cloneConnectionGrant(existingGrant);
  }
  const hasExplicitConnectionIds = Array.isArray(grant.connectionIds) && grant.connectionIds.length > 0;
  const connectionIds = grant.connectionIds?.filter((connectionId) =>
    validInstanceIds.has(connectionId) || existingConnectionIds.has(connectionId)) ?? [];
  if (hasExplicitConnectionIds && connectionIds.length === 0) {
    return existingGrant ? cloneConnectionGrant(existingGrant) : null;
  }
  return {
    type: grant.type,
    actions,
    multiple: grant.multiple === true,
    ...(connectionIds.length ? { connectionIds } : {}),
  };
};
