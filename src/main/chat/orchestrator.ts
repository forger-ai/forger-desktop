import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ChatApplyResult,
  ChatApprovePermissionInput,
  ChatCancelRunInput,
  ChatErrorCode,
  ChatGetRunInput,
  ChatRun,
  ChatRunEvent,
  ChatRunStatus,
  ChatStartRunInput,
  ChatUndoInput,
  ChatUndoResult,
  AgentEffort,
  AgentProvider,
  AgentRuntime,
  ClaudeEffort,
  CodexReasoningEffort,
  PermissionRequest,
} from '../../shared/types';
import { buildFailureDiagnostic } from '../../shared/error-diagnostics';
import { getSharedCopy, normalizeLocale, type Locale } from '../../shared/i18n';
import {
  preparePersistentIsolatedCodexHome,
} from '../codex-run-isolation';
import { killProcessTree } from '../app-agent/process';
import {
  AuditLogger,
  PluginRuntime,
  SandboxRunner,
  applyPreviewChanges,
  buildAutoAppliedUserMessage,
  buildFunctionalOperationSummary,
  classifyForgerTask,
  createChatError,
  ensureGitRepository,
  ensureUserModifiedBranch,
  existsDirectory,
  getGitHead,
  getGitStatus,
  gitCommit,
  runCommandCapture,
  sanitizeId,
  summarizeOperationTitle,
  type ChatHistoryMessage,
  type CodexMcpServerConfig,
  type CodexRunResult,
  type CodexUsage,
  type ForgerTaskType,
} from './orchestrator-helpers';
import {
  appendRunLog,
  buildChatRecoveryContext,
  getRunLogPath,
  isMissingProviderThreadError,
  mapFailureMessage,
  normalizeChatHistory,
  normalizeErrorCode,
  toProgressMessages,
} from './progress-errors';

interface ChatOrchestratorOptions {
  forgerHomeRoot: string;
  privateAppsRoot: string;
  metadataRoot: string;
  legacyMetadataRoot?: string;
  codexHome: string;
  getAgentRuntime: (requested?: Partial<AgentRuntime>) => Promise<AgentRuntime>;
  agentContractVersion: number;
  getCodexCliPath: () => Promise<string | null>;
  getClaudeCliPath: () => Promise<string | null>;
  getCodexPathEntries: (appId?: string) => Promise<string[]>;
  getCodexEnvironment: (appId?: string) => Promise<Record<string, string>>;
  getAgentNetworkAccess?: (appId: string) => Promise<boolean>;
  getCodexAuthenticated: () => Promise<boolean>;
  getClaudeAuthenticated: () => Promise<boolean>;
  createForgerMcpSession?: (runId: string, appId: string, locale?: string) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext?: (appIds: string[]) => Promise<string>;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<CodexMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  onUpdateConflictResolved?: (appId: string) => Promise<void>;
  trace?: (event: string, payload?: Record<string, unknown>) => void | Promise<void>;
  onRunUpdated: (event: ChatRunEvent) => void;
}

interface OperationEntry {
  operationId: string;
  runId: string;
  appId: string;
  commitSha: string;
  createdAt: string;
  title?: string;
  summary?: string;
  revertedAt?: string;
}

interface InternalChatRun extends ChatRun {
  stagingDir: string;
  appRoot: string;
  baseHead: string | null;
  sharedRoots: string[];
  runLogPath: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  provider: AgentProvider;
  effort: AgentEffort;
  taskType: ForgerTaskType;
  locale: Locale;
  conversationHistory: ChatHistoryMessage[];
  child?: ChildProcessWithoutNullStreams;
}

interface PendingPermission {
  runId: string;
  requestId: string;
  resolve: (decision: 'allow' | 'deny') => void;
}

const toPublicChatRun = (run: InternalChatRun): ChatRun => ({
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

const buildChatRunTracePayload = (run: ChatRun): Record<string, unknown> => ({
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

interface AppThreadState {
  appId: string;
  threadId: string;
  contractVersion: number;
  usage: CodexUsage;
  toolEvents: number;
  lastRunAt: string;
}

export class ChatOrchestrator {
  private readonly runs = new Map<string, InternalChatRun>();
  private workspaceLockRunId: string | null = null;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly completedPermissions = new Map<string, 'allow' | 'deny'>();
  private readonly threadsByApp = new Map<string, AppThreadState>();
  private readonly auditLogger: AuditLogger;
  private readonly pluginRuntime: PluginRuntime;
  private readonly sandboxRunner: SandboxRunner;

  public constructor(private readonly options: ChatOrchestratorOptions) {
    this.auditLogger = new AuditLogger(options.privateAppsRoot);
    this.pluginRuntime = new PluginRuntime();
    this.sandboxRunner = new SandboxRunner(options.codexHome);
    void this.loadThreadState();
  }

  public async startRun(input: ChatStartRunInput): Promise<{ runId: string; status: ChatRunStatus }> {
    if (!input.prompt.trim()) {
      throw new Error('invalid_chat_start_input');
    }

    if (this.workspaceLockRunId) {
      const error = new Error('another_run_in_progress');
      (error as Error & { chatCode?: ChatErrorCode }).chatCode = 'conflict';
      throw error;
    }

    const appId = input.appId?.trim() || 'forger';
    const isFreeChat = appId === 'forger';
    const appRoot = isFreeChat ? this.options.forgerHomeRoot : path.join(this.options.privateAppsRoot, appId);
    const stagingDir = path.join(this.options.metadataRoot, 'staging', randomUUID());
    const runId = randomUUID();
    const now = new Date().toISOString();

    const sharedRoots = await this.resolveSharedRoots(input.sharedFiles ?? []);
    const taskType = isFreeChat ? 'resolver_dudas' : classifyForgerTask(input.prompt);
    const baseHead = taskType === 'actualizar_aplicacion' ? await getGitHead(appRoot) : null;
    const locale = normalizeLocale(input.userLanguage);
    const runtime = await this.options.getAgentRuntime({
      provider: input.provider,
      model: input.model,
      effort: input.effort ?? input.reasoningEffort,
    });

    const run: InternalChatRun = {
      runId,
      appId,
      prompt: input.prompt,
      threadId:
        input.threadId === null
          ? null
          : typeof input.threadId === 'string' && input.threadId.trim().length > 0
            ? input.threadId.trim()
            : undefined,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      dangerMode: Boolean(input.dangerMode),
      stagingDir,
      appRoot,
      baseHead,
      sharedRoots,
      runLogPath: getRunLogPath(this.options.metadataRoot, runId),
      progressLog: [],
      model: runtime.model,
      reasoningEffort: runtime.provider === 'codex' ? runtime.effort as CodexReasoningEffort : 'medium',
      provider: runtime.provider,
      effort: runtime.effort,
      taskType,
      locale,
      conversationId: typeof input.conversationId === 'string' ? input.conversationId : undefined,
      conversationHistory: normalizeChatHistory(input.conversationHistory),
    };

    this.runs.set(runId, run);
    this.workspaceLockRunId = runId;
    this.emitRun(run);

    void this.executeRun(runId);

    return {
      runId,
      status: 'queued',
    };
  }

  public getRun(input: ChatGetRunInput): ChatRun | null {
    const run = this.runs.get(input.runId);
    return run ? toPublicChatRun(run) : null;
  }

  public cancelRun(input: ChatCancelRunInput): { success: boolean } {
    const run = this.runs.get(input.runId);
    if (!run) {
      return { success: false };
    }

    killProcessTree(run.child);
    run.status = 'canceled';
    run.updatedAt = new Date().toISOString();
    this.emitRun(run);

    for (const pending of this.pendingPermissions.values()) {
      if (pending.runId === run.runId) {
        pending.resolve('deny');
        this.pendingPermissions.delete(pending.requestId);
      }
    }

    if (this.workspaceLockRunId === run.runId) {
      this.workspaceLockRunId = null;
    }
    return { success: true };
  }

  public approvePermission(input: ChatApprovePermissionInput): { success: boolean } {
    const run = this.runs.get(input.runId);
    if (!run || !run.permissionRequest || run.permissionRequest.requestId !== input.requestId) {
      if (this.completedPermissions.has(input.requestId)) {
        void this.auditLogger.log({
          type: 'permission_response_ignored_duplicate',
          runId: input.runId,
          requestId: input.requestId,
          decision: input.decision,
          originalDecision: this.completedPermissions.get(input.requestId),
        });
        return { success: true };
      }
      void this.auditLogger.log({
        type: 'permission_response_rejected',
        runId: input.runId,
        requestId: input.requestId,
        decision: input.decision,
        reason: 'run_or_request_not_found',
        runStatus: run?.status ?? null,
        activeRequestId: run?.permissionRequest?.requestId ?? null,
      });
      return { success: false };
    }

    const pending = this.pendingPermissions.get(input.requestId);
    if (!pending) {
      void this.auditLogger.log({
        type: 'permission_response_rejected',
        runId: input.runId,
        requestId: input.requestId,
        decision: input.decision,
        reason: 'pending_permission_not_found',
        runStatus: run.status,
      });
      return { success: false };
    }

    void appendRunLog(
      run.runLogPath,
      'meta',
      `Permission response received requestId=${input.requestId} decision=${input.decision}`,
    );
    void this.auditLogger.log({
      type: 'permission_response_received',
      runId: input.runId,
      appId: run.appId,
      requestId: input.requestId,
      decision: input.decision,
      permission: run.permissionRequest.permission,
      resource: run.permissionRequest.resource,
      runLogPath: run.runLogPath,
    });

    pending.resolve(input.decision);
    this.pendingPermissions.delete(input.requestId);
    this.completedPermissions.set(input.requestId, input.decision);
    if (this.completedPermissions.size > 200) {
      const oldest = this.completedPermissions.keys().next().value;
      if (oldest) {
        this.completedPermissions.delete(oldest);
      }
    }
    run.permissionRequest = undefined;
    run.updatedAt = new Date().toISOString();
    run.status = input.decision === 'allow' ? 'running' : 'failed';
    run.errorCode = input.decision === 'allow' ? undefined : 'permission_denied';
    run.userMessage =
      input.decision === 'allow' ? undefined : getSharedCopy(run.locale).chat.permissionDeniedRun;
    this.emitRun(run);

    return { success: true };
  }

  public async applyRun(input: { runId: string }): Promise<ChatApplyResult> {
    const run = this.runs.get(input.runId);
    if (!run) {
      return { success: false, technicalCode: 'run_not_found' };
    }

    if (run.status !== 'preview_ready' || !run.preview) {
      return { success: false, technicalCode: 'run_not_preview_ready' };
    }

    run.status = 'applying';
    run.updatedAt = new Date().toISOString();
    this.emitRun(run);

    try {
      if (!(await existsDirectory(run.appRoot))) {
        throw createChatError('app_not_installed', 'App not installed');
      }

      if (run.baseHead) {
        const currentHead = await getGitHead(run.appRoot);
        if (currentHead && currentHead !== run.baseHead) {
          throw createChatError('conflict', 'App base changed since preview');
        }
      }

      await ensureGitRepository(run.appRoot);
      await applyPreviewChanges(run.appRoot, run.stagingDir, run.preview.diffFiles);
      const commitSha = await gitCommit(run.appRoot, `forger(apply): run ${run.runId}`);
      const operationId = randomUUID();
      await this.appendOperationHistory(run.appId, {
        operationId,
        appId: run.appId,
        runId: run.runId,
        commitSha,
        createdAt: new Date().toISOString(),
        title: summarizeOperationTitle(run.prompt),
        summary: run.preview.summary || run.preview.impact || 'Cambio aplicado en la app.',
      });

      run.status = 'applied';
      run.updatedAt = new Date().toISOString();
      run.operationId = operationId;
      run.commitSha = commitSha;
      run.userMessage = getSharedCopy(run.locale).chat.saveVersionSuccess;
      this.emitRun(run);

      await this.auditLogger.log({
        type: 'apply',
        runId: run.runId,
        appId: run.appId,
        operationId,
        commitSha,
      });

      return {
        success: true,
        operationId,
        commitSha,
        userMessage: run.userMessage,
      };
    } catch (error) {
      const detail = normalizeErrorCode(error);
      run.status = 'failed';
      run.errorCode = detail.code;
      run.updatedAt = new Date().toISOString();
      run.userMessage = getSharedCopy(run.locale).chat.saveVersionFailed;
      this.emitRun(run);
      return {
        success: false,
        ...buildFailureDiagnostic({ fallbackCode: detail.code, rawError: detail.message }),
        userMessage: run.userMessage,
      };
    }
  }

  public async undo(input: ChatUndoInput): Promise<ChatUndoResult> {
    const appRoot = path.join(this.options.privateAppsRoot, input.appId);
    if (!(await existsDirectory(appRoot))) {
      return { success: false, technicalCode: 'app_not_installed' };
    }

    const history = await this.readOperationHistory(input.appId);
    const target = input.operationId
      ? history.find((entry) => entry.operationId === input.operationId)
      : history.find((entry) => !entry.revertedAt);

    if (!target) {
      return { success: false, technicalCode: 'operation_not_found', userMessage: 'No hay cambios para deshacer.' };
    }

    try {
      const result = await runCommandCapture('git', ['revert', '--no-edit', target.commitSha], {
        cwd: appRoot,
        timeoutMs: 30_000,
      });

      if (result.code !== 0) {
        throw createChatError('conflict', result.stderr || result.stdout || 'git_revert_failed');
      }

      const revertedCommitSha = await getGitHead(appRoot);
      target.revertedAt = new Date().toISOString();
      await this.writeOperationHistory(input.appId, history);

      await this.auditLogger.log({
        type: 'undo',
        appId: input.appId,
        operationId: target.operationId,
        commitSha: target.commitSha,
      });

      return {
        success: true,
        revertedCommitSha: revertedCommitSha ?? undefined,
        userMessage: getSharedCopy().chat.undoSuccess,
      };
    } catch (error) {
      const detail = normalizeErrorCode(error);
      return {
        success: false,
        ...buildFailureDiagnostic({ fallbackCode: detail.code, rawError: detail.message }),
        userMessage: getSharedCopy().chat.undoFailed,
      };
    }
  }

  public async requestExternalPermission(
    runId: string,
    input: Omit<PermissionRequest, 'requestId'>,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.status === 'canceled' || run.status === 'failed') {
      await this.auditLogger.log({
        type: 'permission_request_rejected_missing_run',
        runId,
        requestedPermission: input.permission,
        resource: input.resource,
        runStatus: run?.status ?? null,
      });
      return false;
    }
    return await this.requestPermission(run, input);
  }

  public appendExternalProgress(runId: string, message: string): void {
    const run = this.runs.get(runId);
    const trimmed = message.trim();
    if (!run || !trimmed || run.status === 'canceled' || run.status === 'failed') {
      return;
    }
    run.progressLog = [...(run.progressLog ?? []), trimmed].slice(-40);
    run.updatedAt = new Date().toISOString();
    this.emitRun(run);
  }

  private async executeRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    let forgerMcpSession: { url: string; token: string } | null = null;
    let appMcpServers: CodexMcpServerConfig[] = [];

    try {
      if (!(await existsDirectory(run.appRoot))) {
        throw createChatError('app_not_installed', 'Target app is not installed');
      }

      if (run.provider === 'claude') {
        if (!(await this.options.getClaudeAuthenticated())) {
          throw createChatError('auth_missing', 'Claude Code authentication missing');
        }
      } else if (!(await this.options.getCodexAuthenticated())) {
        throw createChatError('auth_missing', 'Codex authentication missing');
      }

      const codexCliPath = run.provider === 'codex' ? await this.options.getCodexCliPath() : null;
      const claudeCliPath = run.provider === 'claude' ? await this.options.getClaudeCliPath() : null;
      if (run.provider === 'codex' && !codexCliPath) {
        throw createChatError('capability_unavailable', 'Codex CLI not installed');
      }
      if (run.provider === 'claude' && !claudeCliPath) {
        throw createChatError('capability_unavailable', 'Claude Code CLI not installed');
      }
      const codexPathEntries = await this.options.getCodexPathEntries(run.appId);
      const codexEnvironment = await this.options.getCodexEnvironment(run.appId);
      const networkAccess = await (this.options.getAgentNetworkAccess?.(run.appId) ?? Promise.resolve(false));

      if (run.taskType === 'actualizar_aplicacion') {
        await ensureGitRepository(run.appRoot);
        await ensureUserModifiedBranch(run.appRoot);
        run.baseHead = await getGitHead(run.appRoot);
      } else if (run.taskType === 'resolver_conflicto_actualizacion') {
        await ensureGitRepository(run.appRoot);
      }

      if (run.status === 'canceled') {
        return;
      }

      run.updatedAt = new Date().toISOString();
      run.status = 'running';
      run.userMessage = undefined;
      this.emitRun(run);
      await fs.mkdir(path.dirname(run.runLogPath), { recursive: true });
      await fs.writeFile(
        run.runLogPath,
        `[${new Date().toISOString()}] Run ${run.runId} app=${run.appId} cwd=${this.options.forgerHomeRoot}\n`,
        'utf8',
      );
      forgerMcpSession = this.options.createForgerMcpSession?.(run.runId, run.appId, run.locale) ?? null;
      appMcpServers = await (this.options.listenAppMcps?.(run.appId === 'forger' ? [] : [run.appId], run.runId) ?? Promise.resolve([]));
      const mcpServers: CodexMcpServerConfig[] = [
        ...(forgerMcpSession
          ? [{
              name: 'forger',
              url: forgerMcpSession.url,
              token: forgerMcpSession.token,
              tokenEnvVar: 'FORGER_MCP_TOKEN',
              toolTimeoutSec: 600,
            }]
          : []),
        ...appMcpServers,
      ];

      let resolvedThreadId = run.threadId === null
        ? undefined
        : run.threadId ?? this.threadsByApp.get(run.appId)?.threadId;
      const buildPrompt = async (includeRecoveryContext: boolean): Promise<string> => {
        const memoryContext = !resolvedThreadId
          ? await (this.options.buildMemoryContext?.([run.appId]) ?? Promise.resolve(''))
          : '';
        const recoveryContext = includeRecoveryContext ? buildChatRecoveryContext(run.conversationHistory) : '';
        return [memoryContext, recoveryContext, run.prompt].filter(Boolean).join('\n\n');
      };
      const persistentCodexHome = run.provider === 'codex'
        ? await preparePersistentIsolatedCodexHome(
            this.options.codexHome,
            this.conversationCodexHome(run.appId, run.conversationId ?? run.runId),
            {
              trustedRoots: [this.options.forgerHomeRoot],
              networkAccess,
            },
          )
        : undefined;

      const commonRunOptionsBase = {
        pathEntries: codexPathEntries,
        environment: codexEnvironment,
        mcpServers,
        workingDir: this.options.forgerHomeRoot,
        model: run.model,
        networkAccess,
        timeoutMs: 300_000,
        onChild: (child: ChildProcessWithoutNullStreams) => {
          run.child = child;
          if (run.status === 'canceled') {
            killProcessTree(child);
          }
        },
        onOutput: (stream: 'stdout' | 'stderr' | 'meta', text: string) => {
          if (run.status === 'canceled') {
            return;
          }
          void appendRunLog(run.runLogPath, stream, text);
          const steps = toProgressMessages(stream, text);
          if (steps.length > 0) {
            run.progressLog = [...(run.progressLog ?? []), ...steps].slice(-40);
            run.updatedAt = new Date().toISOString();
            this.emitRun(run);
          }
        },
      };

      const runProvider = async (includeRecoveryContext: boolean): Promise<CodexRunResult> => {
        const commonRunOptions = {
          ...commonRunOptionsBase,
          prompt: await buildPrompt(includeRecoveryContext),
          threadId: resolvedThreadId,
        };
        return run.provider === 'claude'
          ? await this.sandboxRunner.runClaude({
              ...commonRunOptions,
              claudeCliPath: claudeCliPath as string,
              effort: run.effort as ClaudeEffort,
            })
          : await this.sandboxRunner.runCodex({
              ...commonRunOptions,
              codexCliPath: codexCliPath as string,
              reasoningEffort: run.reasoningEffort,
              codexHome: persistentCodexHome,
            });
      };

      let assistantReply: CodexRunResult;
      try {
        assistantReply = await runProvider(false);
      } catch (error) {
        const canRecoverMissingThread = Boolean(resolvedThreadId && isMissingProviderThreadError(error));
        if (!canRecoverMissingThread) {
          throw error;
        }
        const lostThreadId = resolvedThreadId;
        resolvedThreadId = undefined;
        run.threadId = null;
        this.clearThreadState(run.appId);
        run.progressLog = [
          ...(run.progressLog ?? []),
          `Provider thread ${lostThreadId} is unavailable. Starting a fresh provider thread for this Chat conversation.`,
        ].slice(-40);
        run.updatedAt = new Date().toISOString();
        this.emitRun(run);
        await appendRunLog(
          run.runLogPath,
          'meta',
          `Provider thread ${lostThreadId} is unavailable. Retrying with local conversation context.`,
        );
        assistantReply = await runProvider(true);
      }

      if (this.runs.get(run.runId)?.status === 'canceled') {
        return;
      }

      run.threadId = assistantReply.threadId ?? run.threadId ?? this.threadsByApp.get(run.appId)?.threadId ?? null;

      this.updateThreadState(
        run.appId,
        assistantReply.threadId,
        assistantReply.usageDelta,
        assistantReply.toolEvents,
      );

      if (run.taskType === 'resolver_conflicto_actualizacion') {
        await this.finalizeUpdateConflictResolution(run, assistantReply.assistantText);
      } else if (run.taskType === 'actualizar_aplicacion') {
        await this.finalizeAutoAppliedUpdate(run, assistantReply.assistantText);
      } else {
        run.status = 'preview_ready';
        run.updatedAt = new Date().toISOString();
        run.userMessage = assistantReply.assistantText;
        this.emitRun(run);
      }

      await this.auditLogger.log({
        type:
          run.taskType === 'resolver_conflicto_actualizacion'
            ? 'update_conflict_resolved'
            : run.taskType === 'actualizar_aplicacion'
              ? 'chat_update_auto_applied'
              : 'chat_reply',
        runId: run.runId,
        appId: run.appId,
        replyLength: assistantReply.assistantText.length,
        dangerMode: run.dangerMode,
        runLogPath: run.runLogPath,
        threadId: assistantReply.threadId ?? this.threadsByApp.get(run.appId)?.threadId ?? null,
        usageDelta: assistantReply.usageDelta ?? null,
        toolEvents: assistantReply.toolEvents,
      });
    } catch (error) {
      const detail = normalizeErrorCode(error);
      run.status = run.status === 'canceled' ? 'canceled' : 'failed';
      run.updatedAt = new Date().toISOString();
      run.errorCode = detail.code;
      run.userMessage = mapFailureMessage(detail.code, detail.message, run.runLogPath, run.locale);
      this.emitRun(run);
      await appendRunLog(run.runLogPath, 'meta', `Run failed: [${detail.code}] ${detail.message}`);

      await this.auditLogger.log({
        type: 'run_failed',
        runId: run.runId,
        appId: run.appId,
        code: detail.code,
        message: detail.message,
        runLogPath: run.runLogPath,
        threadId: this.threadsByApp.get(run.appId)?.threadId ?? null,
      });
    } finally {
      if (forgerMcpSession) {
        this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
      }
      this.options.releaseAppMcps?.(run.runId);
      if (this.workspaceLockRunId === run.runId) {
        this.workspaceLockRunId = null;
      }
    }
  }

  private async finalizeAutoAppliedUpdate(run: InternalChatRun, assistantText: string): Promise<void> {
    const status = await getGitStatus(run.appRoot);
    if (status.length === 0) {
      run.status = 'applied';
      run.updatedAt = new Date().toISOString();
      run.userMessage =
        assistantText.trim() ||
        getSharedCopy(run.locale).chat.autoUpdateNoChanges;
      this.emitRun(run);
      return;
    }

    const commitSha = await gitCommit(run.appRoot, `forger(update): ${summarizeOperationTitle(run.prompt)}`);
    const operationId = randomUUID();
    await this.appendOperationHistory(run.appId, {
      operationId,
      appId: run.appId,
      runId: run.runId,
      commitSha,
      createdAt: new Date().toISOString(),
      title: summarizeOperationTitle(run.prompt),
      summary: buildFunctionalOperationSummary(assistantText),
    });

    run.status = 'applied';
    run.updatedAt = new Date().toISOString();
    run.operationId = operationId;
    run.commitSha = commitSha;
    run.userMessage = buildAutoAppliedUserMessage(assistantText);
    this.emitRun(run);

    await this.auditLogger.log({
      type: 'auto_apply',
      runId: run.runId,
      appId: run.appId,
      operationId,
      commitSha,
      changedFiles: status.length,
    });
  }

  private async finalizeUpdateConflictResolution(run: InternalChatRun, assistantText: string): Promise<void> {
    const status = await getGitStatus(run.appRoot);
    const hasUnmerged = status.some((line) => /^(AA|DD|DU|UD|UA|AU|UU)\s/.test(line));
    if (hasUnmerged) {
      throw createChatError('conflict', 'merge_conflicts_remain');
    }

    const commitSha = await gitCommit(run.appRoot, `forger(update): resolve ${run.appId} conflict`);
    const operationId = randomUUID();
    await this.appendOperationHistory(run.appId, {
      operationId,
      appId: run.appId,
      runId: run.runId,
      commitSha,
      createdAt: new Date().toISOString(),
      title: getSharedCopy(run.locale).chat.updateConflictTitle,
      summary: buildFunctionalOperationSummary(assistantText),
    });

    await this.options.onUpdateConflictResolved?.(run.appId);

    run.status = 'applied';
    run.updatedAt = new Date().toISOString();
    run.operationId = operationId;
    run.commitSha = commitSha;
    run.userMessage = buildAutoAppliedUserMessage(assistantText);
    this.emitRun(run);

    await this.auditLogger.log({
      type: 'update_conflict_resolution_commit',
      runId: run.runId,
      appId: run.appId,
      operationId,
      commitSha,
      changedFiles: status.length,
    });
  }

  private async requestPermission(
    run: InternalChatRun,
    input: Omit<PermissionRequest, 'requestId'>,
  ): Promise<boolean> {
    const requestId = randomUUID();
    const request: PermissionRequest = { requestId, ...input };

    await appendRunLog(
      run.runLogPath,
      'meta',
      `Permission requested requestId=${requestId} permission=${request.permission} resource=${request.resource}`,
    );
    await this.auditLogger.log({
      type: 'permission_requested',
      runId: run.runId,
      appId: run.appId,
      requestId,
      permission: request.permission,
      resource: request.resource,
      risk: request.risk,
      reason: request.reason,
      runLogPath: run.runLogPath,
    });

    run.permissionRequest = request;
    run.status = 'needs_permission';
    run.updatedAt = new Date().toISOString();
    run.userMessage = undefined;
    this.emitRun(run);

    const decision = await new Promise<'allow' | 'deny'>((resolve) => {
      this.pendingPermissions.set(requestId, {
        runId: run.runId,
        requestId,
        resolve,
      });
    });

    await appendRunLog(
      run.runLogPath,
      'meta',
      `Permission resolved requestId=${requestId} decision=${decision}`,
    );
    await this.auditLogger.log({
      type: 'permission_resolved',
      runId: run.runId,
      appId: run.appId,
      requestId,
      permission: request.permission,
      resource: request.resource,
      decision,
      runLogPath: run.runLogPath,
    });

    return decision === 'allow';
  }

  private emitRun(run: InternalChatRun): void {
    const publicRun = toPublicChatRun(run);
    void this.options.trace?.('chat_run_emit', buildChatRunTracePayload(publicRun));
    this.options.onRunUpdated({ run: publicRun });
  }

  private async resolveSharedRoots(sharedFiles: Array<{ path: string }>): Promise<string[]> {
    const resolved: string[] = [];

    for (const fileRef of sharedFiles) {
      if (!fileRef.path) {
        continue;
      }
      const real = await fs.realpath(fileRef.path).catch(() => null);
      if (!real) {
        continue;
      }
      resolved.push(real);
    }

    return resolved;
  }

  private async operationsFile(appId: string): Promise<string> {
    const dir = path.join(this.options.metadataRoot, 'operations');
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, `${appId}.json`);
  }

  private legacyOperationsFile(appId: string): string | null {
    return this.options.legacyMetadataRoot ? path.join(this.options.legacyMetadataRoot, 'operations', `${appId}.json`) : null;
  }

  private async readOperationHistory(appId: string): Promise<OperationEntry[]> {
    const filePath = await this.operationsFile(appId);
    const raw = await fs.readFile(filePath, 'utf8').catch(async () => {
      const legacyPath = this.legacyOperationsFile(appId);
      return legacyPath ? await fs.readFile(legacyPath, 'utf8').catch(() => '[]') : '[]';
    });
    try {
      const parsed = JSON.parse(raw) as OperationEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeOperationHistory(appId: string, entries: OperationEntry[]): Promise<void> {
    const filePath = await this.operationsFile(appId);
    await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf8');
  }

  private async appendOperationHistory(appId: string, entry: OperationEntry): Promise<void> {
    const entries = await this.readOperationHistory(appId);
    entries.unshift(entry);
    await this.writeOperationHistory(appId, entries);
  }

  private getThreadsFilePath(): string {
    return path.join(this.options.metadataRoot, 'threads.json');
  }

  private getLegacyThreadsFilePath(): string | null {
    return this.options.legacyMetadataRoot ? path.join(this.options.legacyMetadataRoot, 'threads.json') : null;
  }

  private conversationRuntimeRoot(appId: string, conversationId: string): string {
    return path.join(
      this.options.metadataRoot,
      'chat-conversations-runtime',
      sanitizeId(appId),
      sanitizeId(conversationId),
    );
  }

  private conversationCodexHome(appId: string, conversationId: string): string {
    return path.join(this.conversationRuntimeRoot(appId, conversationId), 'codex-home');
  }

  private async loadThreadState(): Promise<void> {
    const filePath = this.getThreadsFilePath();
    const raw = await fs.readFile(filePath, 'utf8').catch(async () => {
      const legacyPath = this.getLegacyThreadsFilePath();
      return legacyPath ? await fs.readFile(legacyPath, 'utf8').catch(() => '') : '';
    });
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, AppThreadState>;
      for (const [appId, state] of Object.entries(parsed)) {
        if (
          state &&
          typeof state.threadId === 'string' &&
          state.threadId &&
          state.contractVersion === this.options.agentContractVersion
        ) {
          this.threadsByApp.set(appId, state);
        }
      }
    } catch {
      // ignore invalid file
    }
  }

  private async saveThreadState(): Promise<void> {
    const filePath = this.getThreadsFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload: Record<string, AppThreadState> = {};
    for (const [appId, state] of this.threadsByApp.entries()) {
      payload[appId] = state;
    }
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private updateThreadState(
    appId: string,
    threadId: string | undefined,
    usageDelta: Partial<CodexUsage> | undefined,
    toolEvents: number,
  ): void {
    if (!threadId && !this.threadsByApp.has(appId)) {
      return;
    }

    const existing = this.threadsByApp.get(appId);
    const next: AppThreadState = {
      appId,
      threadId: threadId ?? existing?.threadId ?? '',
      contractVersion: this.options.agentContractVersion,
      usage: {
        inputTokens: (existing?.usage.inputTokens ?? 0) + (usageDelta?.inputTokens ?? 0),
        cachedInputTokens: (existing?.usage.cachedInputTokens ?? 0) + (usageDelta?.cachedInputTokens ?? 0),
        outputTokens: (existing?.usage.outputTokens ?? 0) + (usageDelta?.outputTokens ?? 0),
        reasoningOutputTokens:
          (existing?.usage.reasoningOutputTokens ?? 0) + (usageDelta?.reasoningOutputTokens ?? 0),
        turns: (existing?.usage.turns ?? 0) + (usageDelta?.turns ?? 0),
      },
      toolEvents: (existing?.toolEvents ?? 0) + (toolEvents ?? 0),
      lastRunAt: new Date().toISOString(),
    };

    if (!next.threadId) {
      return;
    }
    this.threadsByApp.set(appId, next);
    void this.saveThreadState();
  }

  private clearThreadState(appId: string): void {
    if (!this.threadsByApp.delete(appId)) {
      return;
    }
    void this.saveThreadState();
  }
}
