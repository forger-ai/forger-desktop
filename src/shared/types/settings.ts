import type { AgentDefaults, AgentEffort, AgentPermissionMode, AgentProvider, CodexReasoningEffort } from './agent-runtime';

export interface Settings {
  userEmail: string;
  plan: string;
  safeMode: boolean;
  developerMode: DeveloperModeSettings;
  codexDefaults: {
    model: string;
    reasoningEffort: CodexReasoningEffort;
  };
  defaultAgentProvider: AgentProvider | 'auto';
  defaultChatPermissionMode: AgentPermissionMode;
  defaultChatNetworkAccess: boolean;
  llmProviderDefaults: AgentDefaults;
  /** @deprecated Use llmProviderDefaults. */
  agentDefaults: AgentDefaults;
  providerConnections: Partial<Record<AgentProvider, string>>;
}

export interface DeveloperModeSettings {
  enabled: boolean;
  pathEntries: string[];
}

export interface UpdateDeveloperModeInput {
  enabled?: boolean;
  pathEntries?: string[];
}

export interface UpdateAppDeveloperSettingsInput {
  appId: string;
  pathEntries: string[];
}

export interface DeveloperPathState {
  enabled: boolean;
  globalPathEntries: string[];
  appPathEntries: string[];
  runtimePathEntries: string[];
  systemPathEntries: string[];
  effectivePathEntries: string[];
}

export interface UpdateCodexDefaultsInput {
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

export interface UpdateAgentDefaultsInput {
  defaultProvider?: AgentProvider | 'auto';
  defaultChatPermissionMode?: AgentPermissionMode;
  defaultChatNetworkAccess?: boolean;
  provider?: AgentProvider;
  model?: string;
  effort?: AgentEffort;
}

export type MemoryScope = 'global' | 'app';
export type MemoryKind = 'preference' | 'profile' | 'workflow' | 'constraint' | 'fact';
export type MemorySource = 'user' | 'agent' | 'settings' | 'automation';
export type MemoryStatus = 'active' | 'candidate' | 'archived';

export interface MemoryEvidence {
  id: string;
  memoryId: string;
  source: MemorySource;
  excerpt: string;
  createdAt: string;
}

export interface MemoryUsageEvent {
  id: string;
  memoryId: string;
  caller: 'desktop-chat' | 'app-agent' | 'automation' | 'free-chat' | 'settings';
  appId?: string;
  runId?: string;
  reason?: string;
  createdAt: string;
}

export interface MemoryRevision {
  id: string;
  memoryId: string;
  title: string;
  body: string;
  readWhen: string;
  kind: MemoryKind;
  scope: MemoryScope;
  appId?: string;
  status: MemoryStatus;
  source: MemorySource;
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  appId?: string;
  kind: MemoryKind;
  title: string;
  body: string;
  readWhen: string;
  status: MemoryStatus;
  evidence?: MemoryEvidence[];
  usage?: MemoryUsageEvent[];
  revisions?: MemoryRevision[];
  /**
   * Backward-compatible alias for older callers. New code should use `body`.
   */
  text: string;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryListInput {
  scope?: MemoryScope;
  appId?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
}

export interface MemoryCreateInput {
  scope: MemoryScope;
  appId?: string;
  kind: MemoryKind;
  title?: string;
  body?: string;
  text?: string;
  readWhen?: string;
  read_when?: string;
  status?: MemoryStatus;
  evidence?: string;
  source?: MemorySource;
}

export interface MemoryUpdateInput {
  id: string;
  scope?: MemoryScope;
  appId?: string;
  kind?: MemoryKind;
  title?: string;
  body?: string;
  text?: string;
  readWhen?: string;
  read_when?: string;
  status?: MemoryStatus;
  evidence?: string;
}
