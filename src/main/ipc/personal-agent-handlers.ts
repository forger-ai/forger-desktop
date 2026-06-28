import type { IpcMain } from 'electron';
import type { AgentConversationManager } from '../personal-agents/agent-conversation-manager';
import type { AgentStore } from '../personal-agents/agent-store';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type {
  AgentToolId,
  AppSummary,
  OfficialToolsState,
  PersonalAgentConversationsListInput,
  PersonalAgentConversationGetInput,
  PersonalAgentConversationStartInput,
  PersonalAgentCreateInput,
  PersonalAgentDeleteInput,
  PersonalAgentGrantOptions,
  PersonalAgentMessageSendInput,
  PersonalAgentUpdatePermissionsInput,
  PersonalAgentWorkspaceFileReadInput,
  PersonalAgentWorkspaceFileWriteInput,
  PersonalAgentWorkspaceListInput,
  AgentProvider,
} from '../../shared/types';

interface PersonalAgentIpcHandlersDeps {
  IPC_CHANNELS: typeof IpcChannels;
  ipcMain: IpcMain;
  getPersonalAgentStore: () => AgentStore;
  getPersonalAgentConversationManager: () => AgentConversationManager;
  listInstalledApps: () => AppSummary[];
  listOfficialTools: () => Promise<OfficialToolsState>;
  isAgentProviderConnected: (provider: AgentProvider) => Promise<boolean>;
}

export const registerPersonalAgentIpcHandlers = ({
  IPC_CHANNELS,
  ipcMain,
  getPersonalAgentStore,
  getPersonalAgentConversationManager,
  listInstalledApps,
  listOfficialTools,
  isAgentProviderConnected,
}: PersonalAgentIpcHandlersDeps): void => {
  ipcMain.handle(IPC_CHANNELS.personalAgentsList, async () => {
    return await getPersonalAgentStore().listAgents();
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentsCreate, async (_event, input: PersonalAgentCreateInput) => {
    await validateRuntimeInput(input, isAgentProviderConnected);
    const sanitized = await sanitizePermissionInput(input, listInstalledApps, listOfficialTools);
    return await getPersonalAgentStore().createAgent(sanitized);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentGrantOptionsList, async (): Promise<PersonalAgentGrantOptions> => {
    const [apps, officialTools] = await Promise.all([
      Promise.resolve(listInstalledApps()),
      listOfficialTools(),
    ]);
    return {
      apps: apps.map((app) => ({
        appId: app.id,
        name: app.name ?? app.id,
        description: app.description,
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
    };
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentUpdatePermissions, async (_event, input: PersonalAgentUpdatePermissionsInput) => {
    await validateRuntimeInput(input, isAgentProviderConnected);
    const sanitized = await sanitizePermissionInput(input, listInstalledApps, listOfficialTools);
    return await getPersonalAgentStore().updateAgentPermissions(sanitized);
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
    return await getPersonalAgentConversationManager().sendMessage(input);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentGetConversation, async (_event, input: PersonalAgentConversationGetInput) => {
    return await getPersonalAgentConversationManager().getConversation(input);
  });
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
): Promise<T> => {
  const installedAppIds = new Set(listInstalledApps().map((app) => app.id));
  const officialTools = await listOfficialTools();
  const officialActionIds = new Set(
    officialTools.tools.flatMap((tool) => tool.actions.map((action) => action.id)),
  );
  return {
    ...input,
    ...(input.appIds ? { appIds: input.appIds.filter((appId) => installedAppIds.has(appId)) } : {}),
    ...(input.toolIds ? { toolIds: input.toolIds.filter((toolId) => officialActionIds.has(toolId)) } : {}),
  };
};
