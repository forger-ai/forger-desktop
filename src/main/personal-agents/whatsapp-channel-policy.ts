import type { PersonalAgent, PersonalAgentConnectionGrant, PersonalAgentWhatsAppChannelPolicy } from '../../shared/types';

/** A saved selection can narrow current grants, never restore a revoked grant. */
export const effectiveAgentForWhatsAppChannel = (
  agent: PersonalAgent,
  policy?: PersonalAgentWhatsAppChannelPolicy,
): PersonalAgent => ({
  ...agent,
  permissionMode: 'safe',
  runtime: agent.runtime ? { ...agent.runtime, permissionMode: 'safe' } : undefined,
  networkAccess: agent.networkAccess && policy?.networkAccess === true,
  canSpawnAgents: false,
  appIds: agent.appIds.filter(id => policy?.appIds.includes(id)),
  toolIds: agent.toolIds.filter(id => policy?.toolIds.includes(id)),
  connectionGrants: intersectConnectionGrants(agent.connectionGrants, policy?.connectionGrants ?? []),
  peerAgentGrants: agent.peerAgentGrants.filter(grant => policy?.peerAgentIds.includes(grant.agentId)),
});

export const intersectConnectionGrants = (
  current: PersonalAgentConnectionGrant[],
  selected: PersonalAgentConnectionGrant[],
): PersonalAgentConnectionGrant[] => current.flatMap(grant => {
  const choice = selected.find(item => item.type === grant.type);
  if (!choice) return [];
  const actions = grant.actions.filter(action => choice.actions.includes(action));
  if (!actions.length) return [];
  // An explicit empty selection grants no accounts; missing ids preserves the
  // existing default-account resolution, without widening an explicit scope.
  const ids = grant.connectionIds && choice.connectionIds
    ? grant.connectionIds.filter(id => choice.connectionIds!.includes(id))
    : grant.connectionIds ?? choice.connectionIds;
  if (ids && !ids.length) return [];
  return [{ type: grant.type, actions, multiple: grant.multiple && choice.multiple, ...(ids ? { connectionIds: [...ids] } : {}) }];
});
