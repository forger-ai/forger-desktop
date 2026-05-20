import type { ChatRun } from '../../shared/types';

export const toPublicChatRun = (run: ChatRun): ChatRun => ({
  runId: run.runId,
  appId: run.appId,
  prompt: run.prompt,
  threadId: run.threadId,
  status: run.status,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  dangerMode: run.dangerMode,
  permissionRequest: run.permissionRequest,
  preview: run.preview,
  errorCode: run.errorCode,
  userMessage: run.userMessage,
  progressLog: run.progressLog,
  operationId: run.operationId,
  commitSha: run.commitSha,
  conversationId: run.conversationId,
});

export const buildChatRunTracePayload = (run: ChatRun): Record<string, unknown> => ({
  runId: run.runId,
  appId: run.appId,
  conversationId: run.conversationId ?? null,
  threadId: run.threadId ?? null,
  status: run.status,
  hasUserMessage: typeof run.userMessage === 'string' && run.userMessage.trim().length > 0,
  userMessageLength: typeof run.userMessage === 'string' ? run.userMessage.length : 0,
  progressCount: run.progressLog?.length ?? 0,
  hasPermissionRequest: Boolean(run.permissionRequest),
  hasPreview: Boolean(run.preview),
});
