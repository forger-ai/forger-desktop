import type { AppMcpManager } from '../app-mcp-manager';
import type { ForgerMcpServer } from '../forger-mcp-server';
import type { AgentConversationManager } from '../personal-agents/agent-conversation-manager';
import type { AppRegistry } from './main-process-types';
import { createChannelAppMcpProxy } from '../forger-mcp/channel-app-proxy';
import type { WhatsAppChannelAgentReader } from '../forger-mcp/whatsapp-channel-access';
import type { FileLibrary } from '../file-library';

type PersonalAgentMcpBindings = Required<Pick<
  ConstructorParameters<typeof AgentConversationManager>[0],
  'createForgerMcpSession' | 'releaseForgerMcpSession' | 'listenAppMcps' | 'resolveAppTrustedRoots' | 'releaseAppMcps' | 'resolveWhatsAppSharedFiles'
>>;

export const createPersonalAgentMcpBindings = (deps: {
  getForgerMcpServer: () => ForgerMcpServer | null;
  getAppMcpManager: () => AppMcpManager | null;
  getRegistry: () => AppRegistry;
  getWhatsAppChannelAgent?: WhatsAppChannelAgentReader;
  getFileLibrary?: () => Pick<FileLibrary, 'getFilesByIds'>;
}): PersonalAgentMcpBindings => {
  const proxies = new Map<string, Array<() => void>>();
  return {
    resolveWhatsAppSharedFiles: async references => {
      const ids = references.map(reference => {
        if (!reference.id) throw new Error('whatsapp_channel_shared_file_unavailable');
        return reference.id;
      });
      if (!deps.getFileLibrary) throw new Error('whatsapp_channel_shared_file_unavailable');
      const files = await deps.getFileLibrary().getFilesByIds(ids, 'attached');
      if (files.length !== new Set(ids).size) throw new Error('whatsapp_channel_shared_file_unavailable');
      return files.map(file => ({ id: file.id, absolutePath: file.absolutePath, name: file.name }));
    },
    createForgerMcpSession: (runId, agent, context) =>
      deps.getForgerMcpServer()?.createSession(runId, 'forger', {
        caller: 'personal-agent',
        personalAgentId: agent.id,
        personalAgentConversationId: context.conversationId,
        personalAgentPeerThreadId: context.peerThreadId,
        personalAgentCallStackIds: context.callStackAgentIds,
        personalAgentCanSpawnAgents: agent.canSpawnAgents,
        whatsappChannel: context.channel,
        ...(context.channelWorkspaceRoot ? { whatsappChannelWorkspaceRoot: context.channelWorkspaceRoot } : {}),
        sidekick: context.sidekick ? { sidekickId: context.sidekick.sidekickId } : undefined,
        appIds: agent.appIds,
        officialToolActionIds: agent.toolIds,
        forgerToolActionIds: agent.toolIds,
        connectionGrants: agent.connectionGrants,
      }) ?? null,
    releaseForgerMcpSession: (token) => deps.getForgerMcpServer()?.releaseSession(token),
    listenAppMcps: async (appIds, runId, context, agentId) => {
      const installedAppIds = appIds.filter((appId) => Boolean(deps.getRegistry().apps[appId]));
      const manager = deps.getAppMcpManager();
      if (!manager) return [];
      if (!context?.channel) return await manager.listenMcps(installedAppIds, runId);
      const channel = context.channel;
      const configs = [];
      const cleanup: Array<() => void> = [];
      proxies.set(runId, cleanup);
      try {
        for (const appId of installedAppIds) {
          const authorize = async (): Promise<boolean> => {
            if (!agentId || !deps.getWhatsAppChannelAgent) return false;
            const current = await deps.getWhatsAppChannelAgent({ channel, agentId, runId, conversationId: context.conversationId });
            return Boolean(current?.appIds.includes(appId));
          };
          if (!await authorize()) continue;
          for (const upstream of await manager.listenMcps([appId], runId)) {
            const proxy = await createChannelAppMcpProxy(upstream, authorize);
            cleanup.push(proxy.close);
            configs.push(proxy.config);
          }
        }
        return configs;
      } catch (error) {
        cleanup.forEach(close => close());
        proxies.delete(runId);
        manager.releaseMcps(runId);
        throw error;
      }
    },
    resolveAppTrustedRoots: async (appIds) =>
      appIds
        .map((appId) => deps.getRegistry().apps[appId]?.installDir)
        .filter((installDir): installDir is string => Boolean(installDir)),
    releaseAppMcps: (runId) => {
      proxies.get(runId)?.forEach(close => close());
      proxies.delete(runId);
      deps.getAppMcpManager()?.releaseMcps(runId);
    },
  };
};
