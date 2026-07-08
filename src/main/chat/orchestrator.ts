import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ChatApplyResult,
  ChatApprovePermissionInput,
  ChatCancelRunInput,
  ChatCreatedAppRequest,
  ChatErrorCode,
  ChatGetRunInput,
  ChatQuestion,
  ChatQuestionRequest,
  ChatRun,
  ChatRunEvent,
  ChatRunStatus,
  ChatStartRunInput,
  ChatUndoInput,
  ChatUndoResult,
  AgentEffort,
  AgentProvider,
  AgentRuntime,
  AgentRuntimeRequest,
  ClaudeEffort,
  CodexReasoningEffort,
  PermissionRequest,
} from '../../shared/types';
import type { LlmProviderAuthProfileResolver } from '../llm-provider/types';
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
  type ForgerTaskType,
  type LlmMcpServerConfig,
  type LlmProviderRunResult,
  type LlmTokenUsage,
} from './orchestrator-helpers';
import {
  addPermissionActivityItem,
  addStatusActivityItem,
  appendProviderActivity,
  createAgentRunActivity,
  finalizeAgentRunActivity,
  normalizeActivityStatus,
  persistAgentRunActivity,
} from './agent-run-activity';
import {
  appendRunLog,
  buildChatRecoveryContext,
  getRunLogPath,
  isMissingProviderThreadError,
  mapFailureMessage,
  normalizeChatHistory,
  normalizeErrorCode,
  toProviderProgressMessages,
} from './progress-errors';
import { OperationHistoryStore } from './operation-history';
import {
  buildChatRunTracePayload,
  toPublicChatRun,
} from './run-serialization';

interface ChatOrchestratorOptions {
  forgerHomeRoot: string;
  privateAppsRoot: string;
  metadataRoot: string;
  legacyMetadataRoot?: string;
  codexHome: string;
  providerProfilesRoot?: string;
  resolveAuthProfile?: LlmProviderAuthProfileResolver;
  getAgentRuntime: (requested?: AgentRuntimeRequest) => Promise<AgentRuntime>;
  agentContractVersion: number;
  getCodexCliPath: () => Promise<string | null>;
  getClaudeCliPath: () => Promise<string | null>;
  getAntigravityCliPath?: () => Promise<string | null>;
  getCodexPathEntries: (appId?: string) => Promise<string[]>;
  getCodexEnvironment: (appId?: string) => Promise<Record<string, string>>;
  ensureGitAvailable?: () => Promise<void>;
  getChatNetworkAccessDefault?: () => Promise<boolean> | boolean;
  resolveChatAppRoot?: (appId: string, chatMode?: ChatStartRunInput['chatMode']) => Promise<string | null>;
  getCodexAuthenticated: () => Promise<boolean>;
  getClaudeAuthenticated: () => Promise<boolean>;
  getAntigravityAuthenticated?: () => Promise<boolean>;
  createForgerMcpSession?: (runId: string, appId: string, locale?: string) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext?: (appIds: string[]) => Promise<string>;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<LlmMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  onUpdateConflictResolved?: (appId: string) => Promise<void>;
  trace?: (event: string, payload?: Record<string, unknown>) => void | Promise<void>;
  onRunUpdated: (event: ChatRunEvent) => void;
}

interface InternalChatRun extends ChatRun {
  resumePrompt?: string;
  stagingDir: string;
  appRoot: string;
  baseHead: string | null;
  sharedRoots: string[];
  runLogPath: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  provider: AgentProvider;
  effort: AgentEffort;
  authProfileId?: string;
  networkAccess: boolean;
  taskType: ForgerTaskType;
  startedWithUpdateConflict: boolean;
  locale: Locale;
  conversationHistory: ChatHistoryMessage[];
  child?: ChildProcessWithoutNullStreams;
}

interface PendingPermission {
  runId: string;
  requestId: string;
  resolve: (decision: 'allow' | 'deny') => void;
}

interface AppThreadState {
  appId: string;
  threadId: string;
  contractVersion: number;
  usage: LlmTokenUsage;
  toolEvents: number;
  lastRunAt: string;
}

const hasUnmergedGitStatus = (status: string[]): boolean =>
  status.some((line) => /^(AA|DD|DU|UD|UA|AU|UU)\s/.test(line));

export const CHAT_PROVIDER_TOTAL_TIMEOUT_MS = 60 * 60 * 1000;
export const CHAT_PROVIDER_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export class ChatOrchestrator {
  private readonly runs = new Map<string, InternalChatRun>();
  private readonly activeRunIdsByConversation = new Map<string, string>();
  private readonly activeRunIdsByApp = new Map<string, string>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly completedPermissions = new Map<string, 'allow' | 'deny'>();
  private readonly activeQuestionRequestsByChat = new Map<string, ChatQuestionRequest>();
  private readonly threadsByApp = new Map<string, AppThreadState>();
  private readonly auditLogger: AuditLogger;
  private readonly pluginRuntime: PluginRuntime;
  private readonly sandboxRunner: SandboxRunner;
  private readonly operationHistory: OperationHistoryStore;

  public constructor(private readonly options: ChatOrchestratorOptions) {
    this.auditLogger = new AuditLogger(options.privateAppsRoot);
    this.pluginRuntime = new PluginRuntime();
    this.sandboxRunner = new SandboxRunner({
      codexHome: options.codexHome,
      providerProfilesRoot: options.providerProfilesRoot,
      resolveAuthProfile: options.resolveAuthProfile,
    });
    this.operationHistory = new OperationHistoryStore(options.metadataRoot, options.legacyMetadataRoot);
    void this.loadThreadState();
  }

  public async startRun(input: ChatStartRunInput): Promise<{ runId: string; status: ChatRunStatus }> {
    if (!input.prompt.trim()) {
      throw new Error('invalid_chat_start_input');
    }

    const appId = input.appId?.trim() || 'forger';
    const isFreeChat = appId === 'forger';
    const conversationId = typeof input.conversationId === 'string' && input.conversationId.trim().length > 0
      ? input.conversationId.trim()
      : undefined;
    this.clearActiveQuestionFromPrompt(conversationId, input.prompt);
    const conversationLockKey = conversationId ? this.conversationLockKey(appId, conversationId) : null;
    if (conversationLockKey && this.activeRunIdsByConversation.has(conversationLockKey)) {
      const error = new Error('conversation_run_in_progress');
      (error as Error & { chatCode?: ChatErrorCode }).chatCode = 'conflict';
      throw error;
    }
    if (!isFreeChat && this.activeRunIdsByApp.has(appId)) {
      const error = new Error('app_run_in_progress');
      (error as Error & { chatCode?: ChatErrorCode }).chatCode = 'conflict';
      throw error;
    }

    const resolvedAppRoot = isFreeChat ? null : await (this.options.resolveChatAppRoot?.(appId, input.chatMode) ?? Promise.resolve(null));
    const appRoot = isFreeChat ? this.options.forgerHomeRoot : resolvedAppRoot ?? path.join(this.options.privateAppsRoot, appId);
    const stagingDir = path.join(this.options.metadataRoot, 'staging', randomUUID());
    const runId = randomUUID();
    const now = new Date().toISOString();

    const sharedRoots = await this.resolveSharedRoots(input.sharedFiles ?? []);
    const taskType: ForgerTaskType = 'chat';
    const baseHead = null;
    const locale = normalizeLocale(input.userLanguage);
    const networkAccess = typeof input.networkAccess === 'boolean'
      ? input.networkAccess
      : await (this.options.getChatNetworkAccessDefault?.() ?? Promise.resolve(true));
    const runtime = await this.options.getAgentRuntime({
      provider: input.provider,
      model: input.model,
      authProfileId: input.authProfileId,
      effort: input.effort ?? input.reasoningEffort,
      permissionMode: input.permissionMode,
    });

    const run: InternalChatRun = {
      runId,
      appId,
      prompt: input.prompt,
      resumePrompt: input.resumePrompt,
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
      permissionMode: runtime.permissionMode ?? 'safe',
      stagingDir,
      appRoot,
      baseHead,
      sharedRoots,
      runLogPath: getRunLogPath(this.options.metadataRoot, runId),
      progressLog: [],
      activity: createAgentRunActivity({
        runId,
        surface: 'desktop_chat',
        status: 'queued',
        startedAt: now,
        updatedAt: now,
        sourceRef: {
          appId,
          conversationId,
          title: input.chatMode ?? 'Desktop chat',
        },
      }),
      model: runtime.model,
      reasoningEffort: runtime.provider === 'codex' ? runtime.effort as CodexReasoningEffort : 'medium',
      provider: runtime.provider,
      effort: runtime.effort,
      authProfileId: runtime.authProfileId,
      networkAccess,
      taskType,
      startedWithUpdateConflict: false,
      locale,
      conversationId,
      conversationHistory: normalizeChatHistory(input.conversationHistory),
    };

    this.runs.set(runId, run);
    if (conversationLockKey) {
      this.activeRunIdsByConversation.set(conversationLockKey, runId);
    }
    if (!isFreeChat) {
      this.activeRunIdsByApp.set(appId, runId);
    }
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
    run.permissionRequest = undefined;
    run.updatedAt = new Date().toISOString();
    this.emitRun(run);

    for (const pending of this.pendingPermissions.values()) {
      if (pending.runId === run.runId) {
        pending.resolve('deny');
        this.pendingPermissions.delete(pending.requestId);
      }
    }

    this.releaseRunLocks(run);
    return { success: true };
  }

  public recordCreatedAppFromMcp(runId: string, createdApp: ChatCreatedAppRequest): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.createdApp = createdApp;
    run.updatedAt = new Date().toISOString();
    this.emitRun(run);
  }

  public async registerQuestionFromMcp(
    runId: string,
    input: { questions: ChatQuestion[] },
  ): Promise<ChatQuestionRequest> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error('chat_run_not_found');
    }
    const chatId = run.conversationId?.trim();
    if (!chatId) {
      throw new Error('question_chat_unavailable');
    }
    if (this.activeQuestionRequestsByChat.has(chatId)) {
      throw new Error('active_question_exists');
    }
    const questionRequest: ChatQuestionRequest = {
      requestId: randomUUID(),
      chatId,
      questions: input.questions,
      createdAt: new Date().toISOString(),
    };
    this.activeQuestionRequestsByChat.set(chatId, questionRequest);
    run.questionRequest = questionRequest;
    run.updatedAt = new Date().toISOString();
    this.emitRun(run);
    return questionRequest;
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
      await this.operationHistory.append(run.appId, {
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

    const history = await this.operationHistory.read(input.appId);
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
      await this.operationHistory.write(input.appId, history);

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
    run.activity = addStatusActivityItem(run.activity ?? createAgentRunActivity({
      runId,
      surface: 'desktop_chat',
      status: normalizeActivityStatus(run.status),
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
      sourceRef: { appId: run.appId, conversationId: run.conversationId },
    }), trimmed);
    run.updatedAt = new Date().toISOString();
    run.activity = { ...run.activity, status: normalizeActivityStatus(run.status), updatedAt: run.updatedAt };
    void persistAgentRunActivity(this.options.metadataRoot, run.activity);
    this.emitRun(run);
  }

  private async executeRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    let forgerMcpSession: { url: string; token: string } | null = null;
    let appMcpServers: LlmMcpServerConfig[] = [];
    let gitPrepared = false;
    const ensureGitReady = async (): Promise<void> => {
      if (gitPrepared) {
        return;
      }
      gitPrepared = true;
      await this.options.ensureGitAvailable?.();
    };

    try {
      if (!(await existsDirectory(run.appRoot))) {
        throw createChatError('app_not_installed', 'Target app is not installed');
      }

      if (run.provider === 'antigravity') {
        if (!(await (this.options.getAntigravityAuthenticated?.() ?? Promise.resolve(false)))) {
          throw createChatError('auth_missing', 'Google Antigravity authentication missing');
        }
      } else if (run.provider === 'claude') {
        if (!(await this.options.getClaudeAuthenticated())) {
          throw createChatError('auth_missing', 'Claude Code authentication missing');
        }
      } else if (!(await this.options.getCodexAuthenticated())) {
        throw createChatError('auth_missing', 'Codex authentication missing');
      }
      if (run.provider === 'codex') {
        await ensureGitReady();
      }

      const codexCliPath = run.provider === 'codex' ? await this.options.getCodexCliPath() : null;
      const claudeCliPath = run.provider === 'claude' ? await this.options.getClaudeCliPath() : null;
      const antigravityCliPath = run.provider === 'antigravity' ? await (this.options.getAntigravityCliPath?.() ?? Promise.resolve(null)) : null;
      if (run.provider === 'codex' && !codexCliPath) {
        throw createChatError('capability_unavailable', 'Codex CLI not installed');
      }
      if (run.provider === 'claude' && !claudeCliPath) {
        throw createChatError('capability_unavailable', 'Claude Code CLI not installed');
      }
      if (run.provider === 'antigravity' && !antigravityCliPath) {
        throw createChatError('capability_unavailable', 'Google Antigravity CLI not installed');
      }
      const codexPathEntries = await this.options.getCodexPathEntries(run.appId);
      const codexEnvironment = await this.options.getCodexEnvironment(run.appId);
      const networkAccess = run.networkAccess;
      if (run.appId !== 'forger') {
        await ensureGitReady();
        await ensureGitRepository(run.appRoot);
        const statusBeforeRun = await getGitStatus(run.appRoot);
        run.startedWithUpdateConflict = hasUnmergedGitStatus(statusBeforeRun);
        if (!run.startedWithUpdateConflict) {
          await ensureUserModifiedBranch(run.appRoot);
          run.baseHead = await getGitHead(run.appRoot);
        }
      }

      if (run.status === 'canceled') {
        return;
      }

      run.updatedAt = new Date().toISOString();
      run.status = 'running';
      run.userMessage = undefined;
      run.activity = {
        ...(run.activity ?? createAgentRunActivity({
          runId: run.runId,
          surface: 'desktop_chat',
          startedAt: run.createdAt,
          updatedAt: run.updatedAt,
          sourceRef: { appId: run.appId, conversationId: run.conversationId },
        })),
        status: 'running',
        updatedAt: run.updatedAt,
      };
      this.emitRun(run);
      await fs.mkdir(path.dirname(run.runLogPath), { recursive: true });
      await fs.writeFile(
        run.runLogPath,
        `[${new Date().toISOString()}] Run ${run.runId} app=${run.appId} cwd=${this.options.forgerHomeRoot}\n`,
        'utf8',
      );
      forgerMcpSession = this.options.createForgerMcpSession?.(run.runId, run.appId, run.locale) ?? null;
      appMcpServers = await (this.options.listenAppMcps?.(run.appId === 'forger' ? [] : [run.appId], run.runId) ?? Promise.resolve([]));
      const mcpServers: LlmMcpServerConfig[] = [
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
        const memoryContext = await (this.options.buildMemoryContext?.([run.appId]) ?? Promise.resolve(''));
        const recoveryContext = includeRecoveryContext ? buildChatRecoveryContext(run.conversationHistory) : '';
        const turnPrompt = resolvedThreadId ? (run.resumePrompt ?? run.prompt) : run.prompt;
        return [memoryContext, recoveryContext, turnPrompt].filter(Boolean).join('\n\n');
      };
      const persistentCodexHome = run.provider === 'codex'
        ? await preparePersistentIsolatedCodexHome(
            this.options.codexHome,
            this.conversationCodexHome(run.appId, run.conversationId ?? run.runId),
            {
              trustedRoots: [this.options.forgerHomeRoot, ...run.sharedRoots],
              networkAccess,
            },
          )
        : undefined;

      const commonRunOptionsBase = {
        pathEntries: codexPathEntries,
        environment: codexEnvironment,
        mcpServers,
        workingDir: this.options.forgerHomeRoot,
        sharedRoots: run.sharedRoots,
        model: run.model,
        networkAccess,
        timeoutMs: CHAT_PROVIDER_TOTAL_TIMEOUT_MS,
        inactivityTimeoutMs: CHAT_PROVIDER_INACTIVITY_TIMEOUT_MS,
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
          const activityItemCount = run.activity?.counts.total ?? 0;
          run.activity = appendProviderActivity({
            activity: run.activity ?? createAgentRunActivity({
              runId: run.runId,
              surface: 'desktop_chat',
              status: normalizeActivityStatus(run.status),
              startedAt: run.createdAt,
              updatedAt: run.updatedAt,
              sourceRef: { appId: run.appId, conversationId: run.conversationId },
            }),
            provider: run.provider,
            stream,
            text,
          });
          const activityChanged = (run.activity?.counts.total ?? 0) !== activityItemCount;
          const steps = toProviderProgressMessages(run.provider, stream, text, run.locale);
          if (steps.length > 0 || activityChanged) {
            run.progressLog = [...(run.progressLog ?? []), ...steps].slice(-40);
            run.updatedAt = new Date().toISOString();
            run.activity = { ...run.activity, status: normalizeActivityStatus(run.status), updatedAt: run.updatedAt };
            void persistAgentRunActivity(this.options.metadataRoot, run.activity);
            this.emitRun(run);
          }
        },
      };

      const runProvider = async (includeRecoveryContext: boolean): Promise<LlmProviderRunResult> => {
        const commonRunOptions = {
          ...commonRunOptionsBase,
          prompt: await buildPrompt(includeRecoveryContext),
          threadId: resolvedThreadId,
        };
        if (run.provider === 'antigravity') {
          return await this.sandboxRunner.runAntigravity({
            ...commonRunOptions,
            antigravityCliPath: antigravityCliPath as string,
            effort: run.effort,
            authProfileId: run.authProfileId,
            permissionMode: run.permissionMode,
          });
        }
        return run.provider === 'claude'
          ? await this.sandboxRunner.runClaude({
              ...commonRunOptions,
              claudeCliPath: claudeCliPath as string,
              effort: run.effort as ClaudeEffort,
              authProfileId: run.authProfileId,
              permissionMode: run.permissionMode,
            })
          : await this.sandboxRunner.runCodex({
              ...commonRunOptions,
              codexCliPath: codexCliPath as string,
              reasoningEffort: run.reasoningEffort,
              authProfileId: run.authProfileId,
              permissionMode: run.permissionMode,
              codexHome: persistentCodexHome,
            });
      };

      let assistantReply: LlmProviderRunResult;
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
        run.activity = addStatusActivityItem(
          run.activity ?? this.createActivityForRun(run),
          `Provider thread ${lostThreadId} is unavailable. Starting a fresh provider thread for this Chat conversation.`,
        );
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
      let auditType = 'chat_reply';
      let createdAppAutoApplied = false;
      try {
        createdAppAutoApplied =
          run.appId === 'forger' && run.createdApp
            ? await this.finalizeCreatedAppUpdate(run, assistantReply.assistantText)
            : false;
      } catch (error) {
        if (error && typeof error === 'object') {
          (error as Error & { saveVersionFailed?: boolean }).saveVersionFailed = true;
        }
        throw error;
      }
      const finalStatus = run.appId === 'forger' ? [] : await getGitStatus(run.appRoot);
      const hasUnmergedFiles = hasUnmergedGitStatus(finalStatus);
      if (createdAppAutoApplied) {
        auditType = 'created_app_update_auto_applied';
      } else if (run.startedWithUpdateConflict || hasUnmergedFiles) {
        await this.finalizeUpdateConflictResolution(run, assistantReply.assistantText);
        auditType = 'update_conflict_resolved';
      } else if (finalStatus.length > 0) {
        await this.finalizeAutoAppliedUpdate(run, assistantReply.assistantText);
        auditType = 'chat_update_auto_applied';
      } else {
        run.status = 'preview_ready';
        run.updatedAt = new Date().toISOString();
        run.userMessage = assistantReply.assistantText;
        this.emitRun(run);
      }

      await this.auditLogger.log({
        type: auditType,
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
      if (run.status === 'canceled') {
        run.updatedAt = new Date().toISOString();
        run.errorCode = 'canceled';
        run.userMessage = undefined;
        this.emitRun(run);
        await appendRunLog(run.runLogPath, 'meta', 'Run canceled by user.');

        await this.auditLogger.log({
          type: 'run_canceled',
          runId: run.runId,
          appId: run.appId,
          runLogPath: run.runLogPath,
          threadId: this.threadsByApp.get(run.appId)?.threadId ?? null,
        });
        return;
      }

      const detail = normalizeErrorCode(error);
      const saveVersionFailed = Boolean(
        error && typeof error === 'object' && (error as { saveVersionFailed?: boolean }).saveVersionFailed,
      );
      run.status = 'failed';
      run.updatedAt = new Date().toISOString();
      run.errorCode = detail.code;
      run.userMessage = saveVersionFailed
        ? getSharedCopy(run.locale).chat.saveVersionFailed
        : mapFailureMessage(detail.code, detail.message, run.runLogPath, run.locale, run.provider);
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
      this.releaseRunLocks(run);
    }
  }

  private async finalizeCreatedAppUpdate(run: InternalChatRun, assistantText: string): Promise<boolean> {
    if (!run.createdApp?.appId) {
      return false;
    }

    await this.options.ensureGitAvailable?.();
    const createdAppId = run.createdApp.appId;
    const resolvedAppRoot =
      (await (this.options.resolveChatAppRoot?.(createdAppId, 'edit_app') ?? Promise.resolve(null))) ??
      path.join(this.options.privateAppsRoot, sanitizeId(createdAppId));
    if (!(await existsDirectory(resolvedAppRoot))) {
      throw createChatError('app_not_installed', 'Created app is not installed');
    }

    await ensureUserModifiedBranch(resolvedAppRoot);
    const status = await getGitStatus(resolvedAppRoot);
    const hasUnmerged = hasUnmergedGitStatus(status);
    if (hasUnmerged) {
      throw createChatError('conflict', 'created_app_merge_conflicts_remain');
    }
    if (status.length === 0) {
      return false;
    }

    const commitSha = await gitCommit(resolvedAppRoot, `forger(create): ${run.createdApp.name}`);
    const operationId = randomUUID();
    await this.operationHistory.append(createdAppId, {
      operationId,
      appId: createdAppId,
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
      type: 'created_app_auto_apply',
      runId: run.runId,
      appId: createdAppId,
      operationId,
      commitSha,
      changedFiles: status.length,
    });

    return true;
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
    await this.operationHistory.append(run.appId, {
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

  private clearActiveQuestionFromPrompt(conversationId: string | undefined, prompt: string): void {
    if (!conversationId || !this.activeQuestionRequestsByChat.has(conversationId)) {
      return;
    }
    if (!/\bFORGER_QUESTION_RESPONSE\b/.test(prompt)) {
      return;
    }
    this.activeQuestionRequestsByChat.delete(conversationId);
  }

  private async finalizeUpdateConflictResolution(run: InternalChatRun, assistantText: string): Promise<void> {
    const status = await getGitStatus(run.appRoot);
    const hasUnmerged = hasUnmergedGitStatus(status);
    if (hasUnmerged) {
      throw createChatError('conflict', 'merge_conflicts_remain');
    }

    const commitSha = await gitCommit(run.appRoot, `forger(update): resolve ${run.appId} conflict`);
    const operationId = randomUUID();
    await this.operationHistory.append(run.appId, {
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
    run.activity = addPermissionActivityItem(
      run.activity ?? this.createActivityForRun(run),
      request.reason || `Permission requested for ${request.resource}.`,
      `${request.permission}:${request.resource}`,
    );
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
    run.activity = this.activityForEmit(run);
    void persistAgentRunActivity(this.options.metadataRoot, run.activity);
    const publicRun = toPublicChatRun(run);
    void this.options.trace?.('chat_run_emit', buildChatRunTracePayload(publicRun));
    this.options.onRunUpdated({ run: publicRun });
  }

  private createActivityForRun(run: InternalChatRun) {
    return createAgentRunActivity({
      runId: run.runId,
      surface: 'desktop_chat',
      status: normalizeActivityStatus(run.status),
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
      sourceRef: {
        appId: run.appId,
        conversationId: run.conversationId,
        title: run.appId === 'forger' ? 'Forger chat' : 'App chat',
      },
    });
  }

  private activityForEmit(run: InternalChatRun) {
    const activity = run.activity ?? this.createActivityForRun(run);
    const status = normalizeActivityStatus(run.status);
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      return finalizeAgentRunActivity(
        activity,
        status,
        run.updatedAt,
        status === 'failed' ? run.userMessage ?? run.errorCode : undefined,
      );
    }
    return {
      ...activity,
      status,
      updatedAt: run.updatedAt,
    };
  }

  private conversationLockKey(appId: string, conversationId: string): string {
    return `${appId}:${conversationId}`;
  }

  private releaseRunLocks(run: InternalChatRun): void {
    if (run.conversationId) {
      const key = this.conversationLockKey(run.appId, run.conversationId);
      if (this.activeRunIdsByConversation.get(key) === run.runId) {
        this.activeRunIdsByConversation.delete(key);
      }
    }
    if (run.appId !== 'forger' && this.activeRunIdsByApp.get(run.appId) === run.runId) {
      this.activeRunIdsByApp.delete(run.appId);
    }
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
    usageDelta: Partial<LlmTokenUsage> | undefined,
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
