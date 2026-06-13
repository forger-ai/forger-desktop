import type { PersonalAgentHeartbeatSummary } from '../shared/types';

export const isSafeRemoteAppId = (appId: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(appId) && !appId.includes('..') && !appId.startsWith('__forger_');

export const isSafeRemoteSessionId = (sessionId: string): boolean =>
  /^[a-zA-Z0-9_-]{1,128}$/.test(sessionId);

export const normalizeAgentAccessRequestIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((requestId): requestId is string => typeof requestId === 'string' && /^\d+$/.test(requestId))
    .filter((requestId, index, requestIds) => requestIds.indexOf(requestId) === index)
    .slice(0, 200);
};

export const normalizePersonalAgentHeartbeat = (summary: PersonalAgentHeartbeatSummary): PersonalAgentHeartbeatSummary => {
  const ids = Array.isArray(summary.ids)
    ? summary.ids.filter((id) => typeof id === 'string' && isSafeRemoteAppId(id))
    : [];
  const agents = Array.isArray(summary.agents)
    ? summary.agents
      .map((agent) => {
        if (!agent || typeof agent !== 'object') return null;
        const record = agent as { id?: unknown; name?: unknown; description?: unknown };
        const id = typeof record.id === 'string' && isSafeRemoteAppId(record.id) ? record.id : '';
        const name = typeof record.name === 'string' ? record.name.trim().slice(0, 100) : '';
        const description = typeof record.description === 'string' ? record.description.trim().slice(0, 500) : '';
        return id && name ? { id, name, ...(description ? { description } : {}) } : null;
      })
      .filter((agent): agent is { id: string; name: string; description?: string } => Boolean(agent))
    : ids.map((id) => ({ id, name: id }));
  const normalizedIds = ids.length ? ids : agents.map((agent) => agent.id);
  return {
    supported: summary.supported === true,
    count: Math.min(Number.isFinite(summary.count) ? summary.count : normalizedIds.length, normalizedIds.length),
    ids: normalizedIds,
    agents: agents.filter((agent) => normalizedIds.includes(agent.id)),
    activeSessionRequestIds: normalizeAgentAccessRequestIds(summary.activeSessionRequestIds),
  };
};
