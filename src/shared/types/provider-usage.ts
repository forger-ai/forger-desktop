import type { AgentProvider } from './agent-runtime';
import type { FailureDiagnosticFields } from './base';

export type AgentProviderUsageWindowKind = 'five_hour' | 'weekly';

export type AgentProviderUsageSource =
  | 'codex_rate_limits'
  | 'claude_api'
  | 'claude_audit'
  | 'provider_unavailable';

export interface AgentProviderUsageWindow {
  kind: AgentProviderUsageWindowKind;
  label: string;
  source: AgentProviderUsageSource;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: number;
}

export interface AgentProviderUsageEntry {
  provider: AgentProvider;
  label: string;
  connected: boolean;
  checkedAt: string;
  windows: AgentProviderUsageWindow[];
  externalUrl?: string;
  unavailableReason?: 'not_connected' | 'not_available' | 'read_failed' | 'no_recent_usage';
}

export interface AgentProviderUsageResult extends FailureDiagnosticFields {
  success: boolean;
  checkedAt: string;
  providers: AgentProviderUsageEntry[];
  userMessage?: string;
}
