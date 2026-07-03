import type { AgentEffort, AgentProvider } from './agent-runtime';
import type { BasicActionResult } from './base';

export type LlmProviderAuthMode = 'cli' | 'api_key' | 'oauth';
export type LlmProviderRuntimeAuthMode = 'materialized' | 'externalActiveOnly';
export type LlmProviderProfileStatus = 'connected' | 'missing' | 'expired' | 'unsupported';
export type LlmProviderInstallSource = 'managed' | 'system' | 'local_cli' | 'unknown';

export interface LlmProviderProfileMetadata {
  id: string;
  provider: AgentProvider;
  label: string;
  authMode: LlmProviderAuthMode;
  runtimeAuthMode: LlmProviderRuntimeAuthMode;
  installSource?: LlmProviderInstallSource;
  accountHint?: string;
  status?: LlmProviderProfileStatus;
  source?: 'desktop' | 'local_cli' | 'legacy_provider_connections';
  defaultModel?: string;
  defaultEffort?: AgentEffort;
  isDefault?: boolean;
  connectedAt?: string;
  lastCheckedAt?: string;
  lastUsedAt?: string;
  unavailableReason?: string;
}

export interface LlmProviderProfileSummary extends LlmProviderProfileMetadata {
  active: boolean;
  connected: boolean;
}

export interface LlmProviderProfilesState {
  providers: Partial<Record<AgentProvider, LlmProviderProfileSummary[]>>;
  activeProfileIds: Partial<Record<AgentProvider, string>>;
  checkedAt: string;
}

export interface SetActiveLlmProviderProfileInput {
  provider: AgentProvider;
  profileId: string;
}

export interface SetActiveLlmProviderProfileResult extends BasicActionResult {
  state?: LlmProviderProfilesState;
}

export interface UpdateLlmProviderProfileDefaultsInput {
  provider: AgentProvider;
  profileId: string;
  model?: string;
  effort?: AgentEffort;
}

export interface LlmProviderProfileMutationResult extends BasicActionResult {
  state?: LlmProviderProfilesState;
}
