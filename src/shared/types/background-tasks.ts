export type BackgroundTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'skipped';

export type BackgroundTaskSource = 'social-upload' | 'automation';

export interface BackgroundTaskStatusUpdate {
  message: string;
  status?: BackgroundTaskStatus;
  createdAt: string;
}

export interface BackgroundTaskResult {
  status: 'success' | 'error' | 'info';
  message: string;
  technicalCode?: string;
  details?: Record<string, unknown>;
}

export interface BackgroundTaskAppRef {
  id: string;
  name?: string;
}

export interface BackgroundTaskRelatedEntity {
  kind: 'social-upload' | 'automation-run';
  id: string;
  secondaryId?: string;
}

export interface BackgroundTask {
  id: string;
  source: BackgroundTaskSource;
  title: string;
  status: BackgroundTaskStatus;
  statusUpdates: BackgroundTaskStatusUpdate[];
  result?: BackgroundTaskResult;
  app?: BackgroundTaskAppRef;
  relatedEntity?: BackgroundTaskRelatedEntity;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type BackgroundTaskUpsertInput = Partial<Omit<BackgroundTask, 'id' | 'source'>> & {
  id: string;
  source: BackgroundTaskSource;
};

export interface BackgroundTaskEvent {
  task: BackgroundTask;
}
