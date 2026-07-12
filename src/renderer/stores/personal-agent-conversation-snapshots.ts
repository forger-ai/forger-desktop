import type { PersonalAgentConversation, PersonalAgentRunStatus } from '@shared/types';

const isTerminalRunStatus = (status: PersonalAgentRunStatus | undefined): boolean =>
  status === 'completed' || status === 'failed' || status === 'canceled';

const conversationFreshness = (conversation: PersonalAgentConversation): string => {
  const runUpdatedAt = conversation.activeRun?.updatedAt ?? '';
  const messageCreatedAt = conversation.messages.at(-1)?.createdAt ?? '';
  return [conversation.updatedAt, runUpdatedAt, messageCreatedAt].sort().at(-1) ?? '';
};

export const newerConversation = (
  current: PersonalAgentConversation,
  incoming: PersonalAgentConversation,
): PersonalAgentConversation => {
  const comparison = conversationFreshness(incoming).localeCompare(conversationFreshness(current));
  if (comparison !== 0) return comparison > 0 ? incoming : current;
  const currentRunTerminal = isTerminalRunStatus(current.activeRun?.status);
  const incomingRunTerminal = isTerminalRunStatus(incoming.activeRun?.status);
  if (currentRunTerminal !== incomingRunTerminal) return incomingRunTerminal ? incoming : current;
  if (incoming.messages.length !== current.messages.length) {
    return incoming.messages.length > current.messages.length ? incoming : current;
  }
  return incoming;
};

export const mergeConversationSnapshots = (
  current: PersonalAgentConversation[],
  incoming: PersonalAgentConversation[],
): PersonalAgentConversation[] => {
  const byId = new Map(current.map((conversation) => [conversation.id, conversation]));
  for (const conversation of incoming) {
    const existing = byId.get(conversation.id);
    byId.set(conversation.id, existing ? newerConversation(existing, conversation) : conversation);
  }
  return [...byId.values()].sort((left, right) => conversationFreshness(right).localeCompare(conversationFreshness(left)));
};
