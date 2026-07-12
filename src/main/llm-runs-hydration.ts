import type { LlmRunsStore } from './llm-runs-store';
import type { AgentStore } from './personal-agents/agent-store';

export const hydratePersistedPersonalAgentRuns = async (input: {
  agentStore: AgentStore;
  llmRunsStore: LlmRunsStore;
  limit?: number;
}): Promise<void> => {
  const agents = await input.agentStore.listAgents();
  const conversations = (await Promise.all(agents.map(async (agent) => (
    (await input.agentStore.listConversations(agent.id)).map((conversation) => ({ agent, conversation }))
  ))))
    .flat()
    .filter(({ conversation }) => Boolean(conversation.activeRun))
    .sort((left, right) => right.conversation.updatedAt.localeCompare(left.conversation.updatedAt))
    .slice(0, input.limit ?? 100);
  for (const { agent, conversation } of conversations) {
    input.llmRunsStore.recordPersonalAgentConversationEvent(
      { type: 'conversation.updated', conversation },
      { agentName: agent.name },
    );
  }
};
