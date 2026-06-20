import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { IpcMain } from 'electron';
import { buildCodexPromptForFreeChat } from '../prompt-builder/user-message';
import type { ChatOrchestrator } from '../chat/orchestrator';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type {
  ChatApplyRunInput,
  ChatApprovePermissionInput,
  ChatCancelRunInput,
  ChatGetRunInput,
  ChatStartRunInput,
  ChatUndoInput,
  RendererChatTraceEvent,
  SharedFileRef,
} from '../../shared/types';
import { RENDERER_CHAT_TRACE_EVENTS } from './renderer-chat-trace-events';

interface ChatIpcHandlersDeps {
  IPC_CHANNELS: typeof IpcChannels;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  buildCodexPromptWithAppContext: (params: Parameters<typeof import('../prompt-builder/user-message').buildCodexPromptWithAppContext>[0]) => string;
  buildForgerToolsContextForApp: (appId: string) => Promise<string>;
  buildForgerToolsContextForFreeChat: () => Promise<string>;
  chatOrchestrator: ChatOrchestrator | null;
  defaultChatNetworkAccess: boolean | undefined;
  ensurePathInside: (rootPath: string, targetPath: string) => boolean;
  fs: typeof fs;
  getPrivateDataRoot: () => string;
  installedAppPromptContext: (appId: string, input?: Pick<ChatStartRunInput, 'provider' | 'model' | 'reasoningEffort' | 'effort'>) => Promise<Record<string, unknown>>;
  getSocialAppReviewPromptContext?: (appId: string) => Promise<Record<string, unknown> | null>;
  ipcMain: IpcMain;
  path: typeof path;
  resolveSelectedAppDisplayName: (appId: string) => string;
  sanitizeRendererChatTrace: (input: RendererChatTraceEvent) => Record<string, unknown>;
}

export const registerChatIpcHandlers = (deps: ChatIpcHandlersDeps): void => {
  const {
    IPC_CHANNELS,
    appendInstallLog,
    buildCodexPromptWithAppContext,
    buildForgerToolsContextForApp,
    buildForgerToolsContextForFreeChat,
    chatOrchestrator,
    defaultChatNetworkAccess,
    ensurePathInside,
    fs,
    getPrivateDataRoot,
    installedAppPromptContext,
    getSocialAppReviewPromptContext,
    ipcMain,
    path,
    resolveSelectedAppDisplayName,
    sanitizeRendererChatTrace,
  } = deps;
  const toPosixRelativePath = (value: string): string => value.replace(/\\/g, '/');

  ipcMain.handle(IPC_CHANNELS.chatStartRun, async (_event, input: ChatStartRunInput) => {
    if (!chatOrchestrator) {
      return { runId: '', status: 'failed' };
    }
    const dataRootReal = await fs.realpath(getPrivateDataRoot()).catch(async () => {
      await fs.mkdir(getPrivateDataRoot(), { recursive: true });
      return fs.realpath(getPrivateDataRoot());
    });
    const sharedFiles: SharedFileRef[] = [];
    for (const fileRef of input.sharedFiles ?? []) {
      const candidatePath = path.isAbsolute(fileRef.path) ? fileRef.path : path.join(getPrivateDataRoot(), fileRef.path);
      const realPath = await fs.realpath(candidatePath).catch(() => null);
      if (!realPath || !ensurePathInside(dataRootReal, realPath)) {
        continue;
      }
      sharedFiles.push({ ...fileRef, path: realPath });
    }
    const sharedPromptFiles = sharedFiles.map((fileRef) => ({
      name: fileRef.name ?? path.basename(fileRef.path),
      relativePath: toPosixRelativePath(fileRef.relativePath ?? path.relative(getPrivateDataRoot(), fileRef.path)),
      sizeBytes: fileRef.sizeBytes ?? 0,
      modifiedAt: fileRef.modifiedAt ?? '',
      source: fileRef.source ?? 'mentioned',
    }));
    const networkAccess = (input.networkAccess ?? defaultChatNetworkAccess) !== false;
    const promptContext = input.appId
      ? input.chatMode === 'social_app_review'
        ? await getSocialAppReviewPromptContext?.(input.appId) ?? await installedAppPromptContext(input.appId, input)
        : await installedAppPromptContext(input.appId, input)
      : null;
    const enrichedPrompt = input.appId
      ? buildCodexPromptWithAppContext({
          turnKind: 'start',
          appId: input.appId,
          displayName: resolveSelectedAppDisplayName(input.appId),
          ...promptContext,
          userPrompt: input.prompt,
          chatMode: input.chatMode,
          userLanguage: input.userLanguage,
          officialToolsContext: await buildForgerToolsContextForApp(input.appId),
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        })
      : buildCodexPromptForFreeChat({
          turnKind: 'start',
          userPrompt: input.prompt,
          chatMode: input.chatMode,
          userLanguage: input.userLanguage,
          officialToolsContext: await buildForgerToolsContextForFreeChat(),
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        });
    const resumePrompt = input.appId
      ? buildCodexPromptWithAppContext({
          turnKind: 'resume',
          appId: input.appId,
          displayName: resolveSelectedAppDisplayName(input.appId),
          ...(promptContext ?? {}),
          userPrompt: input.prompt,
          chatMode: input.chatMode,
          userLanguage: input.userLanguage,
          officialToolsContext: '',
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        })
      : buildCodexPromptForFreeChat({
          turnKind: 'resume',
          userPrompt: input.prompt,
          chatMode: input.chatMode,
          userLanguage: input.userLanguage,
          officialToolsContext: '',
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        });
    return await chatOrchestrator.startRun({
      ...input,
      appId: input.appId ?? null,
      prompt: enrichedPrompt,
      resumePrompt,
      networkAccess,
      sharedFiles,
    });
  });
  ipcMain.handle(IPC_CHANNELS.chatGetRun, async (_event, input: ChatGetRunInput) => {
    if (!chatOrchestrator) {
      return null;
    }
    return chatOrchestrator.getRun(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatCancelRun, async (_event, input: ChatCancelRunInput) => {
    if (!chatOrchestrator) {
      return { success: false };
    }
    return chatOrchestrator.cancelRun(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatApprovePermission, async (_event, input: ChatApprovePermissionInput) => {
    if (!chatOrchestrator) {
      return { success: false };
    }
    return chatOrchestrator.approvePermission(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatApplyRun, async (_event, input: ChatApplyRunInput) => {
    if (!chatOrchestrator) {
      return { success: false, technicalCode: 'chat_orchestrator_unavailable' };
    }
    return await chatOrchestrator.applyRun(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatUndo, async (_event, input: ChatUndoInput) => {
    if (!chatOrchestrator) {
      return { success: false, technicalCode: 'chat_orchestrator_unavailable' };
    }
    return await chatOrchestrator.undo(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatTrace, async (_event, input: RendererChatTraceEvent) => {
    if (!input || !RENDERER_CHAT_TRACE_EVENTS.has(input.event)) {
      return { success: false };
    }
    await appendInstallLog('chat_renderer_trace', sanitizeRendererChatTrace(input));
    return { success: true };
  });
};
