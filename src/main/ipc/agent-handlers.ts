import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { AppAgentConversationManager } from '../app-agent-conversation-manager';
import type { AppAgentTaskManager } from '../app-agent-task-manager';
import type { AutomationManager } from '../automation-manager';
import type { DesktopErrorReporter } from '../error-reporting';
import type { ManifestAgentPromptKind } from '../manifest-agent-prompts';
import type {
  AgentRuntime,
  AppAgent,
  AppAgentRuntimeInput,
  AppAgentThreadCreateInput,
  AppAgentThreadRunControlInput,
  AppAgentThreadRunStartInput,
  AppAgentThreadRunSteerInput,
  AppCodexConversationCreateInput,
  AppCodexConversationSendMessageInput,
  AppCodexTaskStartInput,
  AppManifestAgentResumeInput,
  AppManifestAgentStartInput,
  AppManifestAgentSteerInput,
  AppManifestAgentStopInput,
  AutomationUpsertInput,
  ClaudeEffort,
  CodexReasoningEffort,
} from '../../shared/types';
import type { AppRegistry } from '../core/main-process-types';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import {
  buildManifestAgentResumePrompt,
  buildManifestAgentStartPrompt,
  buildManifestAgentSteerPrompt,
  toAppAgentRunSummary,
  toAppAgentRunSummaryForId,
  toAppAgentThreadSummary,
} from '../app-agent/conversation-helpers';

export const REMOVED_FORGER_APP_BRIDGE_MESSAGE =
  'The in-app forgerApp bridge has been removed. Use the signed Desktop HTTP runtime bridge from your backend instead.';

export interface AgentIpcDeps {
  BUILT_IN_CLAUDE_EFFORT: ClaudeEffort;
  BUILT_IN_CODEX_REASONING: CodexReasoningEffort;
  BetterSqlite3: typeof import('better-sqlite3') | null;
  IPC_CHANNELS: typeof IpcChannels;
  appAgentConversationManager: AppAgentConversationManager | null;
  appAgentTaskManager: AppAgentTaskManager | null;
  automationManager: AutomationManager | null;
  desktopErrorReporter: DesktopErrorReporter | null;
  ipcMain: IpcMain;
  normalizeAgentProvider: (value: unknown) => AgentRuntime['provider'] | undefined;
  normalizeClaudeEffort: (value: unknown, fallback: ClaudeEffort) => ClaudeEffort;
  normalizeCodexReasoningEffort: (value: unknown, fallback: CodexReasoningEffort) => CodexReasoningEffort;
  registry: AppRegistry;
  renderManifestAgentPrompt: (input: {
    agent: AppAgent;
    kind: ManifestAgentPromptKind;
    variables?: Record<string, unknown>;
    appRoot: string;
  }) => string;
  resolveAppDbPath: (appId: string) => Promise<string | null>;
  resolveAppIdForWebContents: (webContentsId: number) => string | null;
  resolveInstalledAgents: (appId: string) => Promise<AppAgent[]>;
}

export const registerAgentIpcHandlers = (deps: AgentIpcDeps): void => {
  const { BUILT_IN_CLAUDE_EFFORT, BUILT_IN_CODEX_REASONING, BetterSqlite3, IPC_CHANNELS, appAgentConversationManager, appAgentTaskManager, automationManager, desktopErrorReporter, ipcMain, normalizeAgentProvider, normalizeClaudeEffort, normalizeCodexReasoningEffort, registry, renderManifestAgentPrompt, resolveAppDbPath, resolveAppIdForWebContents, resolveInstalledAgents } = deps;
  const handleAppAgentTaskStart = async (event: IpcMainInvokeEvent, input: AppCodexTaskStartInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    if (!appAgentTaskManager) {
      throw new Error('app_codex_task_manager_unavailable');
    }
    try {
      return await appAgentTaskManager.start(appId, input);
    } catch (error) {
      desktopErrorReporter?.reportAppCodexStartFailure({
        appId,
        operation: 'app.codex-task.start',
        error,
      });
      throw error;
    }
  };
  ipcMain.handle(IPC_CHANNELS.appAgentTaskStart, handleAppAgentTaskStart);
  ipcMain.handle(IPC_CHANNELS.appCodexTaskStart, handleAppAgentTaskStart);

  const handleAppAgentTaskGet = async (event: IpcMainInvokeEvent, runId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentTaskManager) {
      return null;
    }
    return appAgentTaskManager.get(appId, runId);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentTaskGet, handleAppAgentTaskGet);
  ipcMain.handle(IPC_CHANNELS.appCodexTaskGet, handleAppAgentTaskGet);

  const handleAppAgentTaskCancel = async (event: IpcMainInvokeEvent, runId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentTaskManager) return { success: false };
    return appAgentTaskManager.cancel(appId, runId);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentTaskCancel, handleAppAgentTaskCancel);
  ipcMain.handle(IPC_CHANNELS.appCodexTaskCancel, handleAppAgentTaskCancel);

  const handleAppAgentTaskApprovePermission = async (
    event: IpcMainInvokeEvent,
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentTaskManager) {
      return { success: false };
    }
    return appAgentTaskManager.approvePermission(appId, runId, requestId, decision);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentTaskApprovePermission, handleAppAgentTaskApprovePermission);
  ipcMain.handle(IPC_CHANNELS.appCodexTaskApprovePermission, handleAppAgentTaskApprovePermission);

  const normalizeAppAgentRuntime = (runtime?: AppAgentRuntimeInput): Partial<AgentRuntime> => {
    const provider = normalizeAgentProvider(runtime?.provider);
    const rawModel = typeof runtime?.model === 'string' ? runtime.model.trim() : '';
    const model = provider && rawModel && rawModel !== 'auto' ? rawModel : undefined;
    const params = runtime?.modelParams && typeof runtime.modelParams === 'object' ? runtime.modelParams : {};
    const rawEffort = runtime?.effort === 'default' ? undefined : runtime?.effort;
    const effort = rawEffort ?? params.effort ?? params.reasoningEffort;
    const normalizedEffort = provider && effort !== undefined
      ? provider === 'claude'
        ? normalizeClaudeEffort(effort, BUILT_IN_CLAUDE_EFFORT)
        : normalizeCodexReasoningEffort(effort, BUILT_IN_CODEX_REASONING)
      : undefined;
    return {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(normalizedEffort ? { effort: normalizedEffort } : {}),
      ...(runtime?.permissionMode === 'unsafe' ? { permissionMode: 'unsafe' as const } : {}),
    };
  };

  const resolveManifestAgentPromptRun = async (
    appId: string,
    agentId: string,
    kind: ManifestAgentPromptKind,
    variables?: Record<string, unknown>,
  ): Promise<{ agent: AppAgent; prompt: string; appRoot: string }> => {
    const record = registry.apps[appId];
    if (!record?.installDir) {
      throw new Error('app_not_installed');
    }
    const agent = (await resolveInstalledAgents(appId)).find((item) => item.id === agentId);
    if (!agent) {
      throw new Error('manifest_agent_not_found');
    }
    return {
      agent,
      appRoot: record.installDir,
      prompt: renderManifestAgentPrompt({
        agent,
        kind,
        variables,
        appRoot: record.installDir,
      }),
    };
  };

  const manifestAgentIdForThread = async (appId: string, threadId: string): Promise<string> => {
    const metadata = await appAgentConversationManager!.getMetadata(appId, threadId);
    const agentId = typeof metadata?.manifestAgentId === 'string' && metadata.manifestAgentId.trim()
      ? metadata.manifestAgentId.trim()
      : typeof metadata?.agentId === 'string' && metadata.agentId.trim()
        ? metadata.agentId.trim()
        : '';
    if (!agentId) {
      throw new Error('manifest_agent_thread_agent_missing');
    }
    return agentId;
  };

  const handleAppAgentThreadCreate = async (_event: IpcMainInvokeEvent, _input: AppAgentThreadCreateInput) => {
    throw new Error(REMOVED_FORGER_APP_BRIDGE_MESSAGE);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentThreadCreate, handleAppAgentThreadCreate);

  const handleAppAgentThreadRunStart = async (_event: IpcMainInvokeEvent, _input: AppAgentThreadRunStartInput) => {
    throw new Error(REMOVED_FORGER_APP_BRIDGE_MESSAGE);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentThreadRunStart, handleAppAgentThreadRunStart);

  const handleAppAgentThreadGet = async (event: IpcMainInvokeEvent, desktopThreadId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      return null;
    }
    return toAppAgentThreadSummary(await appAgentConversationManager.get(appId, desktopThreadId));
  };
  ipcMain.handle(IPC_CHANNELS.appAgentThreadGet, handleAppAgentThreadGet);

  const handleAppAgentThreadRunGet = async (
    event: IpcMainInvokeEvent,
    desktopThreadId: string,
    desktopRunId: string,
  ) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      return null;
    }
    const conversation = await appAgentConversationManager.get(appId, desktopThreadId);
    return toAppAgentRunSummaryForId(conversation, desktopThreadId, desktopRunId);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentThreadRunGet, handleAppAgentThreadRunGet);

  const handleAppAgentThreadRunCancel = async (event: IpcMainInvokeEvent, input: AppAgentThreadRunControlInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      return { success: false };
    }
    return await appAgentConversationManager.cancel(appId, input.desktopThreadId, input.desktopRunId);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentThreadRunCancel, handleAppAgentThreadRunCancel);

  const handleAppAgentThreadRunSteer = async (_event: IpcMainInvokeEvent, _input: AppAgentThreadRunSteerInput) => {
    throw new Error(REMOVED_FORGER_APP_BRIDGE_MESSAGE);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentThreadRunSteer, handleAppAgentThreadRunSteer);

  const handleAppManifestAgentStart = async (event: IpcMainInvokeEvent, input: AppManifestAgentStartInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      throw new Error('app_agent_thread_unavailable');
    }
    const agentId = typeof input?.agentId === 'string' ? input.agentId.trim() : '';
    if (!agentId) {
      throw new Error('manifest_agent_required');
    }
    const { prompt } = await resolveManifestAgentPromptRun(appId, agentId, 'initial', input.variables);
    const conversation = await appAgentConversationManager.create(appId, {
      title: input.title,
      agentId,
      metadata: {
        ...(input.metadata ?? {}),
        agentId,
        manifestAgentId: agentId,
        promptApi: 'manifest',
        initialPromptApplied: true,
      },
    });
    const started = await appAgentConversationManager.sendMessage(appId, {
      conversationId: conversation.conversationId,
      message: buildManifestAgentStartPrompt(prompt),
      workspacePath: input.workspacePath,
      ...normalizeAppAgentRuntime(input.runtime),
    });
    const summary = toAppAgentThreadSummary(started);
    if (!summary) {
      throw new Error('manifest_agent_thread_start_failed');
    }
    return {
      ...summary,
      manifest_agent_id: agentId,
    };
  };
  ipcMain.handle(IPC_CHANNELS.appManifestAgentStart, handleAppManifestAgentStart);

  const handleAppManifestAgentResume = async (event: IpcMainInvokeEvent, input: AppManifestAgentResumeInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      throw new Error('app_agent_thread_unavailable');
    }
    const threadId = typeof input?.threadId === 'string' ? input.threadId.trim() : '';
    if (!threadId) {
      throw new Error('manifest_agent_thread_required');
    }
    const agentId = await manifestAgentIdForThread(appId, threadId);
    const { prompt } = await resolveManifestAgentPromptRun(appId, agentId, 'resume', input.variables);
    const conversation = await appAgentConversationManager.sendMessage(appId, {
      conversationId: threadId,
      message: buildManifestAgentResumePrompt(prompt),
      workspacePath: input.workspacePath,
      ...normalizeAppAgentRuntime(input.runtime),
    });
    return toAppAgentRunSummary(threadId, conversation.activeRun, conversation.messages) ?? {
      desktop_thread_id: threadId,
      desktop_run_id: '',
      status: 'queued',
    };
  };
  ipcMain.handle(IPC_CHANNELS.appManifestAgentResume, handleAppManifestAgentResume);

  const handleAppManifestAgentSteer = async (event: IpcMainInvokeEvent, input: AppManifestAgentSteerInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      throw new Error('app_agent_thread_unavailable');
    }
    const threadId = typeof input?.threadId === 'string' ? input.threadId.trim() : '';
    const runId = typeof input?.runId === 'string' ? input.runId.trim() : '';
    if (!threadId || !runId) {
      throw new Error('manifest_agent_thread_run_required');
    }
    const agentId = await manifestAgentIdForThread(appId, threadId);
    const { prompt } = await resolveManifestAgentPromptRun(appId, agentId, 'steer', input.variables);
    return await appAgentConversationManager.steerRun(appId, threadId, runId, {
      message: buildManifestAgentSteerPrompt(prompt),
      workspacePath: input.workspacePath,
      ...normalizeAppAgentRuntime(input.runtime),
    });
  };
  ipcMain.handle(IPC_CHANNELS.appManifestAgentSteer, handleAppManifestAgentSteer);

  const handleAppManifestAgentStop = async (event: IpcMainInvokeEvent, input: AppManifestAgentStopInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      return { success: false };
    }
    const threadId = typeof input?.threadId === 'string' ? input.threadId.trim() : '';
    if (!threadId) {
      return { success: false };
    }
    const runId = typeof input?.runId === 'string' && input.runId.trim()
      ? input.runId.trim()
      : (await appAgentConversationManager.get(appId, threadId))?.activeRun?.runId ?? '';
    if (!runId) {
      return { success: true };
    }
    return await appAgentConversationManager.cancel(appId, threadId, runId);
  };
  ipcMain.handle(IPC_CHANNELS.appManifestAgentStop, handleAppManifestAgentStop);

  const handleAppAgentConversationCreate = async (event: IpcMainInvokeEvent, input: AppCodexConversationCreateInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    if (!appAgentConversationManager) {
      throw new Error('app_codex_conversation_manager_unavailable');
    }
    try {
      return await appAgentConversationManager.create(appId, input ?? {});
    } catch (error) {
      desktopErrorReporter?.reportAppCodexStartFailure({
        appId,
        operation: 'app.codex-conversation.create',
        error,
      });
      throw error;
    }
  };
  ipcMain.handle(IPC_CHANNELS.appAgentConversationCreate, handleAppAgentConversationCreate);
  ipcMain.handle(IPC_CHANNELS.appCodexConversationCreate, handleAppAgentConversationCreate);

  const handleAppAgentConversationSendMessage = async (
    event: IpcMainInvokeEvent,
    input: AppCodexConversationSendMessageInput,
  ) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    if (!appAgentConversationManager) {
      throw new Error('app_codex_conversation_manager_unavailable');
    }
    try {
      return await appAgentConversationManager.sendMessage(appId, input);
    } catch (error) {
      desktopErrorReporter?.reportAppCodexStartFailure({
        appId,
        operation: 'app.codex-conversation.send-message',
        error,
      });
      throw error;
    }
  };
  ipcMain.handle(IPC_CHANNELS.appAgentConversationSendMessage, handleAppAgentConversationSendMessage);
  ipcMain.handle(IPC_CHANNELS.appCodexConversationSendMessage, handleAppAgentConversationSendMessage);

  const handleAppAgentConversationGet = async (event: IpcMainInvokeEvent, conversationId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      return null;
    }
    return await appAgentConversationManager.get(appId, conversationId);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentConversationGet, handleAppAgentConversationGet);
  ipcMain.handle(IPC_CHANNELS.appCodexConversationGet, handleAppAgentConversationGet);

  const handleAppAgentConversationList = async (event: IpcMainInvokeEvent) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      return [];
    }
    return await appAgentConversationManager.list(appId);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentConversationList, handleAppAgentConversationList);
  ipcMain.handle(IPC_CHANNELS.appCodexConversationList, handleAppAgentConversationList);

  const handleAppAgentConversationDelete = async (event: IpcMainInvokeEvent, conversationId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      return { success: false };
    }
    return await appAgentConversationManager.delete(appId, conversationId);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentConversationDelete, handleAppAgentConversationDelete);
  ipcMain.handle(IPC_CHANNELS.appCodexConversationDelete, handleAppAgentConversationDelete);

  const handleAppAgentConversationCancelRun = async (
    event: IpcMainInvokeEvent,
    conversationId: string,
    runId: string,
  ) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      return { success: false };
    }
    return await appAgentConversationManager.cancel(appId, conversationId, runId);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentConversationCancelRun, handleAppAgentConversationCancelRun);
  ipcMain.handle(IPC_CHANNELS.appCodexConversationCancelRun, handleAppAgentConversationCancelRun);

  const handleAppAgentConversationApprovePermission = async (
    event: IpcMainInvokeEvent,
    conversationId: string,
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appAgentConversationManager) {
      return { success: false };
    }
    return appAgentConversationManager.approvePermission(appId, conversationId, runId, requestId, decision);
  };
  ipcMain.handle(IPC_CHANNELS.appAgentConversationApprovePermission, handleAppAgentConversationApprovePermission);
  ipcMain.handle(IPC_CHANNELS.appCodexConversationApprovePermission, handleAppAgentConversationApprovePermission);

  ipcMain.handle(IPC_CHANNELS.dbListTables, async (_event, appId: string) => {
    if (!BetterSqlite3) {
      return { error: 'db_module_unavailable' };
    }
    const dbPath = await resolveAppDbPath(appId);
    if (!dbPath) {
      return { error: 'db_file_not_found' };
    }
    try {
      const db = new BetterSqlite3(dbPath, { readonly: true });
      type SqliteMasterRow = { name: string };
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as SqliteMasterRow[];
      db.close();
      return { tables: rows.map((row) => row.name), dbPath };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'db_list_tables_failed';
      return { error: detail };
    }
  });

  ipcMain.handle(IPC_CHANNELS.dbQueryTable, async (_event, appId: string, tableName: string, limit = 1000) => {
    if (!BetterSqlite3) {
      return { error: 'db_module_unavailable' };
    }
    const dbPath = await resolveAppDbPath(appId);
    if (!dbPath) {
      return { error: 'db_file_not_found' };
    }
    try {
      const db = new BetterSqlite3(dbPath, { readonly: true });
      const safeName = tableName.replace(/"/g, '""');
      const stmt = db.prepare(`SELECT * FROM "${safeName}" LIMIT ?`);
      const rawRows = stmt.all(limit) as Record<string, unknown>[];
      const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : (stmt.columns().map((col) => col.name));
      const rows = rawRows.map((row) => columns.map((col) => row[col] ?? null));
      type CountRow = { total: number };
      const countRow = db.prepare(`SELECT COUNT(*) as total FROM "${safeName}"`).get() as CountRow;
      db.close();
      return { columns, rows, total: countRow?.total ?? rows.length };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'db_query_failed';
      return { error: detail };
    }
  });

  ipcMain.handle(IPC_CHANNELS.automationsList, async () => {
    if (!automationManager) {
      return [];
    }
    return automationManager.list();
  });
  ipcMain.handle(IPC_CHANNELS.automationsCreate, async (_event, input: AutomationUpsertInput) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.create(input);
  });
  ipcMain.handle(IPC_CHANNELS.automationsUpdate, async (_event, input: AutomationUpsertInput & { id: string }) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.update(input);
  });
  ipcMain.handle(IPC_CHANNELS.automationsDelete, async (_event, id: string) => {
    if (!automationManager) {
      return { success: false, technicalCode: 'automation_manager_unavailable' };
    }
    return await automationManager.delete(id);
  });
  ipcMain.handle(IPC_CHANNELS.automationsPause, async (_event, id: string) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.pause(id);
  });
  ipcMain.handle(IPC_CHANNELS.automationsResume, async (_event, id: string) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.resume(id);
  });
  ipcMain.handle(IPC_CHANNELS.automationsRunNow, async (_event, id: string) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.runNow(id);
  });
  ipcMain.handle(IPC_CHANNELS.automationsListRuns, async (_event, automationId: string) => {
    if (!automationManager) {
      return [];
    }
    return await automationManager.listRuns(automationId);
  });
  ipcMain.handle(IPC_CHANNELS.automationsGetRunTranscript, async (_event, runId: string) => {
    if (!automationManager) {
      return null;
    }
    return await automationManager.getRunTranscript(runId);
  });

};
