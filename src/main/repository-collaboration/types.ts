import type {
  RepositoryCollaborationChat,
  RepositoryCollaborationChatParticipant,
  RepositoryCollaborationRepository,
  RepositoryCollaborationTask,
} from '../../shared/types/repository-collaboration';
export interface LocalRepository extends RepositoryCollaborationRepository {
  root: string;
}
export interface RepositoryCollaborationMessage {
  connectionId: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  live: boolean;
  identityVerified: boolean;
  automated?: boolean;
  fromMe?: boolean;
  replyToMessageId?: string;
}
export interface RepositoryExecutor {
  run(input: {
    task: RepositoryCollaborationTask;
    prompt: string;
    repositories: LocalRepository[];
    conversationId?: string;
    signal: AbortSignal;
    onProgress?: (text: string) => void;
  }): Promise<{
    text: string;
    conversationId?: string;
  }>;
}
export interface RepositoryCollaborationTransport {
  listGroups(connectionId: string): Promise<RepositoryCollaborationChat[]>;
  listParticipants(
    connectionId: string,
    chatId: string,
  ): Promise<RepositoryCollaborationChatParticipant[]>;
  sendMessage(input: {
    connectionId: string;
    chatId: string;
    text: string;
    replyToMessageId?: string;
    canSend?: () => Promise<boolean>;
  }): Promise<{
    messageId: string;
  }>;
}
