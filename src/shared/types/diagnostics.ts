import type { AgentProvider } from './agent-runtime';

export type ConversationDiagnosticSource = 'desktop_chat' | 'app_agent_conversation';

export interface ConversationDiagnosticMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  runId?: string;
  createdAt?: string;
}

export interface PrepareConversationDiagnosticReportInput {
  source: ConversationDiagnosticSource;
  appId?: string;
  conversationId: string;
  runId?: string;
  title?: string;
  provider?: AgentProvider;
  technicalCode?: string;
  conversation?: {
    appId?: string;
    title?: string;
    threadId?: string | null;
    runtime?: Record<string, unknown>;
    messages?: ConversationDiagnosticMessage[];
  };
}

export interface ConversationDiagnosticReportPreview {
  source: ConversationDiagnosticSource;
  appId?: string;
  conversationId: string;
  runId?: string;
  title?: string;
  provider?: AgentProvider;
  technicalCode?: string;
  desktopVersion?: string;
  platform?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface SubmitConversationDiagnosticReportResult {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
}
