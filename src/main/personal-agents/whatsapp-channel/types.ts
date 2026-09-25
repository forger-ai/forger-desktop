export interface WhatsAppAgentBindingKey {
  connectionId: string;
  chatId: string;
  agentId: string;
}

export interface WhatsAppAgentBinding extends WhatsAppAgentBindingKey {
  alias: string;
  ownerId: string;
  enabled: boolean;
  allowAgentCapabilities: boolean;
  purpose: string;
  scope: string;
  participantsAllowed: string[];
  conversationId: string | null;
  revision: number;
  activeTurnId: string | null;
}

export type WhatsAppAgentBindingInput = Omit<WhatsAppAgentBinding, 'revision' | 'activeTurnId' | 'conversationId' | 'allowAgentCapabilities'> & {
  conversationId?: string | null;
  expectedRevision?: number;
  allowAgentCapabilities?: boolean;
};

export interface WhatsAppAgentInbound {
  connectionId: string;
  chatId: string;
  stableMessageRef: string;
  authorId?: string;
  text?: string;
  isLive: boolean;
  isFromMe: boolean;
  isForwarded: boolean;
  isQuoted: boolean;
  isAgentEcho: boolean;
  hasAttachment?: boolean;
}

export interface WhatsAppAgentContextMessage {
  stableMessageRef: string;
  authorId: string;
  text: string;
}

export interface WhatsAppAgentRunInput {
  binding: WhatsAppAgentBinding;
  turnId: string;
  revision: number;
  text: string;
  context: WhatsAppAgentContextMessage[];
  stableMessageRef: string;
  authorId: string | null;
  isFromMe: boolean;
}

export interface WhatsAppAgentSteerInput extends WhatsAppAgentRunInput {
  previousTurnId: string;
}

export interface WhatsAppAgentCancelInput {
  binding: WhatsAppAgentBinding;
  turnId: string;
  reason: 'off' | 'reconfigured';
}

export interface WhatsAppAgentReplyInput {
  binding: WhatsAppAgentBinding;
  turnId: string;
  revision: number;
  text: string;
}

export interface WhatsAppAgentChannelPorts {
  readContext?: (binding: WhatsAppAgentBinding, limit: number) => Promise<WhatsAppAgentContextMessage[]>;
  // Start and steer launch the run, then return. Completion calls deliverCandidate separately.
  startRun: (input: WhatsAppAgentRunInput) => Promise<{ runId: string }>;
  steerRun: (input: WhatsAppAgentSteerInput) => Promise<{ runId: string }>;
  cancelRun: (input: WhatsAppAgentCancelInput) => Promise<void>;
  sendReply: (input: WhatsAppAgentReplyInput) => Promise<{
    sent: boolean;
    stableMessageRef?: string;
    definiteFailure?: boolean;
  }>;
}

export interface WhatsAppAgentReplyCandidate extends WhatsAppAgentBindingKey {
  turnId: string;
  revision: number;
  text: string;
}

export interface WhatsAppAgentTurn extends WhatsAppAgentBindingKey {
  turnId: string;
  revision: number;
  runId: string;
  status: 'active' | 'sent' | 'failed' | 'canceled' | 'unknown';
}

export type WhatsAppAgentDeliveryResult = 'sent' | 'stale' | 'duplicate' | 'failed' | 'unknown';

export interface WhatsAppAgentInboundResult {
  status: 'ignored' | 'duplicate' | 'unauthorized' | 'inactive' | 'purpose_required' | 'reconciliation_required' | 'enabled' | 'disabled' | 'started' | 'steered' | 'failed';
  agentId?: string;
  turnId?: string;
  revision?: number;
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
