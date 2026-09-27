import type {
  WhatsAppAgentBinding as SharedWhatsAppAgentBinding,
  WhatsAppAgentBindingKey,
  WhatsAppAgentActivityItem,
} from '../../../shared/types/whatsapp-agent-channel';
export type {
  WhatsAppAgentBindingKey,
  WhatsAppAgentUnsettledMessage,
} from '../../../shared/types/whatsapp-agent-channel';

export interface WhatsAppAgentBinding extends SharedWhatsAppAgentBinding {
  configurationVersion: number;
  generation: number;
}

export type WhatsAppAgentBindingInput = Omit<
  WhatsAppAgentBinding,
  'revision' | 'activeTurnId' | 'conversationId' | 'allowAgentCapabilities' | 'configurationVersion' | 'generation'
> & {
  conversationId?: string | null;
  expectedRevision?: number;
  expectedConfigurationVersion?: number;
  allowAgentCapabilities?: boolean;
};

export interface WhatsAppAgentInbound {
  connectionId: string;
  chatId: string;
  stableMessageRef: string;
  authorId?: string;
  /** Trusted transport identities, never accepted from a participant message body. */
  chatIdentityIds?: string[];
  equivalentStableMessageRefs?: string[];
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
  runId: string;
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
  reason: 'off' | 'reconfigured' | 'canceled' | 'corrected';
}

export interface WhatsAppAgentReplyInput {
  binding: WhatsAppAgentBinding;
  turnId: string;
  revision: number;
  text: string;
}

export type WhatsAppAgentRunAdmission =
  | { status?: 'accepted'; runId: string }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; runId: string };

export interface WhatsAppAgentChannelPorts {
  resolveIdentityIds?: (connectionId: string, id: string) => Promise<string[]>;
  readContext?: (binding: WhatsAppAgentBinding, limit: number) => Promise<WhatsAppAgentContextMessage[]>;
  // Start and steer launch the run, then return. Completion calls deliverCandidate separately.
  startRun: (input: WhatsAppAgentRunInput) => Promise<WhatsAppAgentRunAdmission>;
  steerRun?: (input: WhatsAppAgentSteerInput) => Promise<{ runId: string }>;
  cancelRun: (input: WhatsAppAgentCancelInput) => Promise<void>;
  sendReply: (input: WhatsAppAgentReplyInput) => Promise<{
    sent: boolean;
    stableMessageRef?: string;
    definiteFailure?: boolean;
    retryable?: boolean;
    reason?: string;
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
  status: 'active' | 'sent' | 'failed' | 'canceled' | 'unknown' | 'interrupted';
}

export type WhatsAppAgentDeliveryResult = 'pending' | 'sent' | 'stale' | 'duplicate' | 'failed' | 'unknown';

export interface WhatsAppAgentInboundResult {
  status:
    | 'ignored'
    | 'duplicate'
    | 'unauthorized'
    | 'inactive'
    | 'purpose_required'
    | 'reconciliation_required'
    | 'enabled'
    | 'disabled'
    | 'started'
    | 'queued'
    | 'steered'
    | 'failed';
  agentId?: string;
  turnId?: string;
  revision?: number;
}

export interface WhatsAppAgentActivity extends WhatsAppAgentActivityItem, WhatsAppAgentBindingKey {
  runId: string;
  status: 'queued' | 'active' | 'completed' | 'failed' | 'canceled' | 'interrupted' | 'dismissed';
  stableMessageRef: string;
  revision: number;
  retryAt: number;
}
