import type { AppMcpManager } from '../app-mcp-manager';
import type { ForgerMcpServer } from '../forger-mcp-server';
import type { AgentConversationManager } from '../personal-agents/agent-conversation-manager';
import type { AppRegistry } from './main-process-types';

type PersonalAgentMcpBindings = Required<Pick<
  ConstructorParameters<typeof AgentConversationManager>[0],
  'createForgerMcpSession' | 'releaseForgerMcpSession' | 'listenAppMcps' | 'resolveAppTrustedRoots' | 'releaseAppMcps'
>>;

export const createPersonalAgentMcpBindings = (deps: {
  getForgerMcpServer: () => ForgerMcpServer | null;
  getAppMcpManager: () => AppMcpManager | null;
  getRegistry: () => AppRegistry;
}): PersonalAgentMcpBindings => ({
  createForgerMcpSession: (runId, agent, context) =>
    deps.getForgerMcpServer()?.createSession(runId, 'forger', {
      caller: 'personal-agent',
      personalAgentId: agent.id,
      personalAgentConversationId: context.conversationId,
      personalAgentPeerThreadId: context.peerThreadId,
      personalAgentCallStackIds: context.callStackAgentIds,
      personalAgentCanSpawnAgents: agent.canSpawnAgents,
      whatsappChannel: context.channel,
      sidekick: context.sidekick ? { sidekickId: context.sidekick.sidekickId } : undefined,
      appIds: agent.appIds,
      officialToolActionIds: agent.toolIds,
      forgerToolActionIds: agent.toolIds,
      connectionGrants: agent.connectionGrants,
    }) ?? null,
  releaseForgerMcpSession: (token) => deps.getForgerMcpServer()?.releaseSession(token),
  listenAppMcps: async (appIds, runId) => {
    const installedAppIds = appIds.filter((appId) => Boolean(deps.getRegistry().apps[appId]));
    return await (deps.getAppMcpManager()?.listenMcps(installedAppIds, runId) ?? Promise.resolve([]));
  },
  resolveAppTrustedRoots: async (appIds) =>
    appIds
      .map((appId) => deps.getRegistry().apps[appId]?.installDir)
      .filter((installDir): installDir is string => Boolean(installDir)),
  releaseAppMcps: (runId) => {
    deps.getAppMcpManager()?.releaseMcps(runId);
  },
});
