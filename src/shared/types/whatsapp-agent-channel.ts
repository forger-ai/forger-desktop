import type { PersonalAgent, PersonalAgentConnectionGrant, PersonalAgentMemory } from './personal-agents';
import type { AgentToolId } from './tools';
import type { SharedFileRef } from './chat';

/** Explicit channel grants, always intersected with the agent's current grants. */
export interface PersonalAgentWhatsAppChannelPolicy {
  appIds: string[];
  toolIds: AgentToolId[];
  connectionGrants: PersonalAgentConnectionGrant[];
  peerAgentIds: string[];
  networkAccess: boolean;
  sharedMemoryIds: string[];
  sharedFiles?: SharedFileRef[];
}

export interface WhatsAppAgentPolicyOptions {
  agent: PersonalAgent;
  memories: PersonalAgentMemory[];
}

export interface WhatsAppAgentBindingKey {
  connectionId: string;
  chatId: string;
  agentId: string;
}

export type WhatsAppParticipantAccess = 'owner' | 'selected' | 'all';

export interface WhatsAppAgentBinding extends WhatsAppAgentBindingKey {
  alias: string;
  ownerId: string;
  enabled: boolean;
  purpose: string;
  scope: string;
  participantAccess?: WhatsAppParticipantAccess;
  participantsAllowed: string[];
  allowAgentCapabilities: boolean;
  conversationId: string | null;
  revision: number;
  activeTurnId: string | null;
  configurationVersion?: number;
  generation?: number;
  policy?: PersonalAgentWhatsAppChannelPolicy;
}

export type WhatsAppAgentBindingPutInput = WhatsAppAgentBindingKey & Pick<WhatsAppAgentBinding,
  'alias' | 'enabled' | 'purpose' | 'scope' | 'participantsAllowed' | 'allowAgentCapabilities'> & {
    participantAccess?: WhatsAppParticipantAccess;
    expectedRevision?: number;
    expectedConfigurationVersion?: number;
    policy?: PersonalAgentWhatsAppChannelPolicy;
  };

export interface WhatsAppAgentActivityItem {
  requestId: string;
  runId: string | null;
  requestText: string;
  responseText: string | null;
  authorId: string | null;
  isFromMe: boolean;
  createdAt: string;
  updatedAt: string;
  status: 'queued' | 'active' | 'waiting_approval' | 'completed' | 'failed' | 'canceled' | 'interrupted' | 'dismissed';
  deliveryState: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | null;
  reason: string | null;
  conversationId: string | null;
  canRetryDelivery?: boolean;
}

export type WhatsAppAgentRequestActionInput = WhatsAppAgentBindingKey & { requestId: string };
export type WhatsAppAgentBindingSetEnabledInput = WhatsAppAgentBindingKey & {
  enabled: boolean;
  expectedConfigurationVersion?: number;
};
export interface WhatsAppAgentAliasUpdateInput {
  connectionId: string;
  agentId: string;
  alias: string;
}

export interface WhatsAppAgentUnsettledMessage {
  connectionId: string;
  chatId: string;
  stableMessageRef: string;
  state: 'pending' | 'admitting';
  agentId: string | null;
  turnId: string | null;
  revision: number | null;
}

export interface WhatsAppAgentDeliveryStatus {
  turnId: string;
  revision: number;
  state: 'sent' | 'failed' | 'unknown';
  stableMessageRef: string | null;
}
