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
  effortOptionsForModel: (model: string) => RuntimeEffortControlOption[];
  normalizeEffortForModel: (model: string, effort: AgentEffort) => AgentEffort;
}

export type RuntimeProviderControls = Record<AgentProvider, RuntimeProviderControl>;
