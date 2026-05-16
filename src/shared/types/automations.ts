export type AutomationFrequencyType = 'hourly' | 'daily' | 'weekly';

export interface AutomationFrequency {
  type: AutomationFrequencyType;
  timeOfDay?: string;
  weeklyDay?: number;
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
  selectedAppIds: string[];
  enabled?: boolean;
}

export interface WindowControlState {
  isMaximized: boolean;
  isFullScreen: boolean;
  usesCustomFrame: boolean;
}
