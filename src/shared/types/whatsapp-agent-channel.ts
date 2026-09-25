export interface WhatsAppAgentBindingKey {
  connectionId: string;
  chatId: string;
  agentId: string;
}

export interface WhatsAppAgentBinding extends WhatsAppAgentBindingKey {
  alias: string;
  ownerId: string;
  enabled: boolean;
  purpose: string;
  scope: string;
  participantsAllowed: string[];
  allowAgentCapabilities: boolean;
  conversationId: string | null;
  revision: number;
  activeTurnId: string | null;
}

export type WhatsAppAgentBindingPutInput = WhatsAppAgentBindingKey & Pick<WhatsAppAgentBinding,
  'alias' | 'enabled' | 'purpose' | 'scope' | 'participantsAllowed' | 'allowAgentCapabilities'> & {
    expectedRevision?: number;
  };

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
