import type { AgentRuntime } from './agent-runtime';

export type AutomationFrequencyType = 'interval' | 'hourly' | 'daily' | 'weekly';
export type AutomationMissedRunPolicy = 'skip' | 'always' | 'within_window';

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 24 * 60;
export const DEFAULT_INTERVAL_MINUTES = 15;

export interface AutomationFrequency {
  type: AutomationFrequencyType;
  timeOfDay?: string;
  weeklyDay?: number;
  intervalMinutes?: number;
}

export type AutomationRunTrigger = 'manual' | 'scheduled';
export type AutomationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface AutomationRunSummary {
  id: string;
  automationId: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  userMessage?: string;
  userMessages?: string[];
  transcriptPreview?: string;
}

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  frequency: AutomationFrequency;
  runtime?: AgentRuntime;
  missedRunPolicy: AutomationMissedRunPolicy;
  missedRunWindowMinutes?: number;
  selectedAppIds: string[];
  enabled: boolean;
  running: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun?: AutomationRunSummary;
}

export interface AutomationRun extends AutomationRunSummary {
  transcript: string;
}

export interface AutomationUpsertInput {
  id?: string;
  name: string;
  prompt: string;
  frequency: AutomationFrequency;
  runtime?: AgentRuntime;
  missedRunPolicy?: AutomationMissedRunPolicy;
  missedRunWindowMinutes?: number;
  selectedAppIds: string[];
  enabled?: boolean;
}

export interface WindowControlState {
  isMaximized: boolean;
  isFullScreen: boolean;
  usesCustomFrame: boolean;
}
