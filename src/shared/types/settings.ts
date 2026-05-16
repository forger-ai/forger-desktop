import type { AgentDefaults, AgentEffort, AgentProvider, CodexReasoningEffort } from './agent-runtime';

export interface Settings {
  userEmail: string;
  plan: string;
  safeMode: boolean;
  codexDefaults: {
    model: string;
    reasoningEffort: CodexReasoningEffort;
  };
  defaultAgentProvider: AgentProvider | 'auto';
  agentDefaults: AgentDefaults;
  providerConnections: Partial<Record<AgentProvider, string>>;
}

export interface UpdateCodexDefaultsInput {
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

export interface UpdateAgentDefaultsInput {
  defaultProvider?: AgentProvider | 'auto';
  provider?: AgentProvider;
  model?: string;
  effort?: AgentEffort;
}

export type MemoryScope = 'global' | 'app';
export type MemoryKind = 'preference' | 'profile' | 'workflow' | 'constraint' | 'fact';
export type MemorySource = 'user' | 'agent' | 'settings' | 'automation';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  appId?: string;
  kind: MemoryKind;
  text: string;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryListInput {
  scope?: MemoryScope;
  appId?: string;
  kind?: MemoryKind;
}

export interface MemoryCreateInput {
  scope: MemoryScope;
  appId?: string;
  kind: MemoryKind;
  text: string;
  source?: MemorySource;
}

export interface MemoryUpdateInput {
  id: string;
  scope?: MemoryScope;
  appId?: string;
  kind?: MemoryKind;
  text?: string;
}
