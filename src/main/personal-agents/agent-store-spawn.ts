import type { PersonalAgent, PersonalAgentCreateInput, PersonalAgentGroup } from '../../shared/types';
import { sanitizeAgentId } from './agent-store-normalizers';

export interface CreatePersonalAgentFromAgentInput {
  creatorAgentId: string;
  name: string;
  description?: string;
  purpose?: string;
  instructions?: string;
  groupId?: string;
}

interface SpawnAgentStoreOperations {
  requireAgent: (agentId: string) => Promise<PersonalAgent>;
  requireGroup: (groupId: string) => PersonalAgentGroup;
  createAgent: (input: PersonalAgentCreateInput, createdByAgentId: string) => Promise<PersonalAgent>;
  grantPeer: (agentId: string, peerAgentId: string, criteria: string) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<{ success: boolean }>;
}

export const createPersonalAgentFromAgent = async (
  input: CreatePersonalAgentFromAgentInput,
  store: SpawnAgentStoreOperations,
): Promise<PersonalAgent> => {
  const creator = await store.requireAgent(input.creatorAgentId);
  if (!creator.canSpawnAgents) throw new Error('personal_agent_spawn_permission_required');
  const groupId = sanitizeAgentId(input.groupId) ?? creator.groupId;
  if (groupId) store.requireGroup(groupId);
  const child = await store.createAgent({
    name: input.name,
    description: input.description,
    purpose: input.purpose,
    instructions: input.instructions,
    permissionMode: 'safe',
    networkAccess: false,
    canSpawnAgents: false,
    groupId: groupId ?? null,
    ...(creator.runtime ? { runtime: creator.runtime } : {}),
    appIds: [],
    toolIds: [],
    connectionGrants: [],
    peerAgentGrants: [],
  }, creator.id);
  try {
    await store.grantPeer(creator.id, child.id, '');
    return await store.requireAgent(child.id);
  } catch (error) {
    await store.deleteAgent(child.id).catch(() => undefined);
    throw error;
  }
};
