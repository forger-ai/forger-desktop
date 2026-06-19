import type { AgentEffort, AgentProvider } from '@shared/types';

export interface RuntimeModelControlOption {
  displayModelName: string;
  realModelName: string;
  defaultEffort: AgentEffort;
}

export interface RuntimeEffortControlOption {
  label: string;
  value: AgentEffort;
}

export interface RuntimeProviderControl {
  modelOptions: RuntimeModelControlOption[];
  selectedModel: string;
  onSelectModel: (model: string) => void;
  effortOptions: RuntimeEffortControlOption[];
  selectedEffort: AgentEffort;
  onSelectEffort: (effort: AgentEffort) => void;
}

export type RuntimeProviderControls = Record<AgentProvider, RuntimeProviderControl>;
