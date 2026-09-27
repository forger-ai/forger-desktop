/** Public collaboration DTOs deliberately exclude local filesystem paths. */
export interface RepositoryCollaborationGroup {
  id: string;
  connectionId: string;
  chatId: string;
  title: string;
  enabled: boolean;
  activatedAt: number | null;
}
export interface RepositoryCollaborationRepository {
  id: string;
  groupId: string;
  name: string;
}
export interface RepositoryCollaborationParticipant {
  groupId: string;
  participantId: string;
  displayName: string;
}
export interface RepositoryCollaborationGrant {
  groupId: string;
  participantId: string;
  repositoryId: string;
}
export type RepositoryCollaborationTaskStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'needs_attention';
export interface RepositoryCollaborationTask {
  id: string;
  groupId: string;
  repositoryIds: string[];
  participantId: string;
  participantName: string;
  prompt: string;
  status: RepositoryCollaborationTaskStatus;
  createdAt: number;
  updatedAt: number;
  sourceMessageId: string;
  parentTaskId: string | null;
  conversationId: string | null;
  result: string | null;
  errorCode?:
    | 'runtime_unavailable'
    | 'authentication_required'
    | 'repository_unavailable'
    | 'execution_failed'
    | 'interrupted';
}
export interface RepositoryCollaborationOutbox {
  id: string;
  groupId: string;
  taskId: string | null;
  status: 'pending' | 'sent' | 'suppressed';
  attempts: number;
  text: string;
  messageId: string | null;
}
export interface RepositoryCollaborationSnapshot {
  groups: RepositoryCollaborationGroup[];
  repositories: RepositoryCollaborationRepository[];
  participants: RepositoryCollaborationParticipant[];
  grants: RepositoryCollaborationGrant[];
  tasks: RepositoryCollaborationTask[];
  outbox: RepositoryCollaborationOutbox[];
}
export interface RepositoryCollaborationChat {
  chatId: string;
  title: string;
}
export interface RepositoryCollaborationChatParticipant {
  participantId: string;
  displayName: string;
  isSelf?: boolean;
}
export interface ConfigureRepositoryCollaborationGroupInput {
  connectionId: string;
  chatId: string;
  title: string;
  enabled: boolean;
}
export interface SetRepositoryCollaborationAccessInput {
  groupId: string;
  participantId: string;
  displayName: string;
  repositoryIds: string[];
}
export interface RepositoryCollaborationApi {
  snapshot(connectionId: string): Promise<RepositoryCollaborationSnapshot>;
  listGroups(connectionId: string): Promise<RepositoryCollaborationChat[]>;
  listParticipants(
    connectionId: string,
    chatId: string,
  ): Promise<RepositoryCollaborationChatParticipant[]>;
  configureGroup(
    input: ConfigureRepositoryCollaborationGroupInput,
  ): Promise<RepositoryCollaborationGroup>;
  addRepository(input: {
    groupId: string;
    name: string;
  }): Promise<RepositoryCollaborationRepository | null>;
  removeRepository(input: {
    groupId: string;
    repositoryId: string;
  }): Promise<void>;
  setAccess(input: SetRepositoryCollaborationAccessInput): Promise<void>;
  cancelTask(input: { taskId: string }): Promise<void>;
  retryTask(input: { taskId: string }): Promise<void>;
}
