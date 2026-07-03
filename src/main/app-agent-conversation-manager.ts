import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppCodexConversation,
  AppCodexConversationCreateInput,
  AppCodexConversationEvent,
  AppCodexConversationMessage,
  AppCodexConversationRun,
  AppCodexConversationSendMessageInput,
  AppAgent,
  AppAgentThreadSteerResult,
  AgentRuntime,
  AgentRuntimeRecommendations,
  AgentRuntimeRequest,
  AppAgentWorkspaceInput,
  ClaudeEffort,
  CodexReasoningEffort,
  PermissionRequest,
} from '../shared/types';
import { getSharedCopy, normalizeLocale, type Locale } from '../shared/i18n';
import {
  assertAllowedMcpServers,
  preparePersistentIsolatedCodexHome,
} from './codex-run-isolation';
import {
  buildConversationRecoveryContext,
  buildManifestAgentRecoveryPrompt,
  extensionForMimeType,
  isMissingProviderThread,
  isTerminalRunStatus,
  normalizeMetadata,
  progressFromCodexOutput,
  sanitizeId,
  sanitizeTitle,
  toConversation,
  toRun,
} from './app-agent/conversation-helpers';
import {
  existsDirectory,
  killProcessTree,
  runCommandCapture,
} from './app-agent/process';
import { buildProviderRunFailureError } from './app-agent/provider-failures';
import type { LlmAppMcpServerConfig } from './app-agent/types';
import type { AppFolderGrantPublic } from './app-folder-grants';
import { appendRunLog, getRunLogPath, mapFailureMessage, normalizeProviderErrorCode, toProviderProgressMessages } from './chat/progress-errors';
import { antigravityCliAdapter } from './llm-provider/adapters/antigravity-cli-adapter';
import { claudeCliAdapter } from './llm-provider/adapters/claude-cli-adapter';
import { codexCliAdapter } from './llm-provider/adapters/codex-cli-adapter';

interface AppAgentConversationManagerOptions {
  privateAppsRoot: string;
  metadataRoot: string;
  codexHome: string;
  getAgentRuntime: (requested?: AgentRuntimeRequest) => Promise<AgentRuntime>;
  appAllowsAgentRuntimeControl?: (appId: string) => Promise<boolean>;
  getCodexCliPath: () => Promise<string | null>;
  getClaudeCliPath: () => Promise<string | null>;
  getAntigravityCliPath?: () => Promise<string | null>;
  getCodexPathEntries: (appId?: string) => Promise<string[]>;
  getCodexEnvironment: (appId?: string) => Promise<Record<string, string>>;
  ensureGitAvailable?: () => Promise<void>;
  getAgentNetworkAccess?: (appId: string) => Promise<boolean>;
  getCodexAuthenticated: () => Promise<boolean>;
  getClaudeAuthenticated: () => Promise<boolean>;
  getAntigravityAuthenticated?: () => Promise<boolean>;
  hasCodexConversation: (appId: string) => Promise<boolean>;
  resolveAgents: (appId: string) => Promise<AppAgent[]>;
  createForgerMcpSession?: (runId: string, appId: string, locale?: string) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext?: (appId: string) => Promise<string>;
  buildForgerToolsContext?: (appId: string) => Promise<string>;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<LlmAppMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  resolveFolderGrant?: (appId: string, grantId: string) => Promise<AppFolderGrantPublic>;
  canRequestPermission?: (appId: string) => boolean;
  onConversationEvent: (event: AppCodexConversationEvent) => void;
}

interface InternalConversation extends AppCodexConversation {
  threadId?: string | null;
  runtime?: AgentRuntime;
  metadata?: Record<string, string | number | boolean | null>;
}

interface InternalRun extends AppCodexConversationRun {
  appId: string;
  conversationId: string;
  locale: Locale;
  provider?: AgentRuntime['provider'];
  child?: ChildProcessWithoutNullStreams;
  attachmentPaths?: string[];
  runLogPath?: string;
}

interface PendingPermission {
  runId: string;
  requestId: string;
  resolve: (decision: 'allow' | 'deny') => void;
}

interface ResolvedRunWorkspace {
  runRoot: string;
  additionalRoots: string[];
}

const DEFAULT_MODEL = 'gpt-5.2';
const DEFAULT_REASONING: CodexReasoningEffort = 'medium';
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const CODEX_CONVERSATION_RUN_TIMEOUT_MS = 600_000;

const hasRunRuntimeInput = (
  input: Pick<AppCodexConversationSendMessageInput, 'provider' | 'model' | 'effort' | 'reasoningEffort'>,
): boolean => Boolean(input.provider || input.model || input.effort || input.reasoningEffort);

export class AppAgentConversationManager {
  private readonly conversations = new Map<string, InternalConversation>();
  private readonly runs = new Map<string, InternalRun>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private loadPromise: Promise<void> | null = null;

  public constructor(private readonly options: AppAgentConversationManagerOptions) {}

  public async create(appId: string, input: AppCodexConversationCreateInput = {}): Promise<AppCodexConversation> {
    await this.assertEnabled(appId);
    await this.load();
    const now = new Date().toISOString();
    const metadata = normalizeMetadata(input.metadata) ?? {};
    const agentId = typeof input.agentId === 'string' ? input.agentId.trim() : '';
    if (agentId) {
      metadata.agentId = agentId;
    }
    const locale = normalizeLocale(input.locale);
    metadata.locale = locale;
    const conversation: InternalConversation = {
      conversationId: randomUUID(),
      appId,
      title: sanitizeTitle(input.title) || getSharedCopy(locale).appConversation.defaultTitle,
      createdAt: now,
      updatedAt: now,
      messages: [],
      threadId: null,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
    this.conversations.set(conversation.conversationId, conversation);
    await this.persistApp(appId);
    const summary = toConversation(conversation);
    this.options.onConversationEvent({ type: 'conversation.created', conversation: summary });
    return summary;
  }

  public async list(appId: string): Promise<AppCodexConversation[]> {
    await this.assertEnabled(appId);
    await this.load();
    return [...this.conversations.values()]
      .filter((conversation) => conversation.appId === appId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(toConversation);
  }

  public async get(appId: string, conversationId: string): Promise<AppCodexConversation | null> {
    await this.assertEnabled(appId);
    await this.load();
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.appId !== appId) {
      return null;
    }
    return toConversation(conversation);
  }

  public async getMetadata(appId: string, conversationId: string): Promise<Record<string, string | number | boolean | null> | undefined> {
    await this.assertEnabled(appId);
    await this.load();
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.appId !== appId) {
      return undefined;
    }
    return normalizeMetadata(conversation.metadata);
  }

  public async getDiagnosticSnapshot(appId: string, conversationId: string, runId?: string): Promise<Record<string, unknown> | null> {
    await this.assertEnabled(appId);
    await this.load();
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.appId !== appId) {
      return null;
    }
    const targetRunId = runId || conversation.activeRun?.runId;
    const run = targetRunId ? this.runs.get(targetRunId) : undefined;
    const rawRunLog = targetRunId ? await readTail(run?.runLogPath ?? getRunLogPath(this.options.metadataRoot, targetRunId)) : null;
    return {
      conversation: {
        conversationId: conversation.conversationId,
        appId: conversation.appId,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        threadId: conversation.threadId ?? null,
        runtime: conversation.runtime ?? null,
        metadata: conversation.metadata ?? {},
        messages: conversation.messages,
        activeRun: conversation.activeRun ?? null,
      },
      requestedRunId: targetRunId ?? null,
      rawRunLog,
    };
  }

  public async sendMessage(
    appId: string,
    input: AppCodexConversationSendMessageInput,
  ): Promise<AppCodexConversation> {
    await this.assertEnabled(appId);
    await this.load();
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation || conversation.appId !== appId) {
      throw new Error('codex_conversation_not_found');
    }
    if (conversation.activeRun && !isTerminalRunStatus(conversation.activeRun.status)) {
      throw new Error('codex_conversation_run_active');
    }
    const message = input.message.trim();
    if (!message) {
      throw new Error('codex_conversation_empty_message');
    }
    await this.assertRuntimeControlAllowed(appId, input);
    if (hasRunRuntimeInput(input)) {
      await this.resolveRunRuntime(conversation, input);
    }

    const now = new Date().toISOString();
    const runId = randomUUID();
    const userMessage: AppCodexConversationMessage = {
      messageId: randomUUID(),
      role: 'user',
      text: message,
      runId,
      createdAt: now,
    };
    const run: InternalRun = {
      runId,
      appId,
      conversationId: conversation.conversationId,
      locale: normalizeLocale(input.locale ?? (typeof conversation.metadata?.locale === 'string' ? conversation.metadata.locale : undefined)),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      progressLog: [],
      runLogPath: getRunLogPath(this.options.metadataRoot, runId),
    };
    conversation.messages.push(userMessage);
    conversation.activeRun = run;
    conversation.updatedAt = now;
    this.runs.set(runId, run);
    await this.persistApp(appId);
    this.options.onConversationEvent({
      type: 'message.created',
      conversation: toConversation(conversation),
      message: userMessage,
      run: toRun(run),
    });

    void this.execute(conversation.conversationId, runId, input).catch((error) => {
      const failedRun = this.runs.get(runId);
      const providerDetail = normalizeProviderErrorCode(error);
      const message = providerDetail
        ? mapFailureMessage(providerDetail.code, providerDetail.message, undefined, input.locale, failedRun?.provider)
        : error instanceof Error ? error.message : String(error ?? 'app_codex_conversation_failed');
      void this.failRun(runId, message, providerDetail ? { technicalCode: providerDetail.code } : undefined);
    });

    return toConversation(conversation);
  }

  public async cancel(appId: string, conversationId: string, runId: string): Promise<{ success: boolean }> {
    await this.assertEnabled(appId);
    await this.load();
    const conversation = this.conversations.get(conversationId);
    const run = this.runs.get(runId);
    if (!conversation || conversation.appId !== appId || !run || run.conversationId !== conversationId) {
      return { success: false };
    }
    if (isTerminalRunStatus(run.status)) {
      return { success: true };
    }
    killProcessTree(run.child);
    this.resolvePendingPermission(runId, 'deny');
    run.permissionRequest = undefined;
    run.status = 'canceled';
    run.updatedAt = new Date().toISOString();
    conversation.activeRun = toRun(run);
    conversation.updatedAt = run.updatedAt;
    await this.persistApp(appId);
    this.options.onConversationEvent({
      type: 'run.canceled',
      conversation: toConversation(conversation),
      run: toRun(run),
    });
    return { success: true };
  }

  public async steerRun(
    appId: string,
    conversationId: string,
    runId: string,
    input: Pick<AppCodexConversationSendMessageInput, 'message' | 'context' | 'workspacePath' | 'workspace' | 'provider' | 'model' | 'effort' | 'reasoningEffort'>,
  ): Promise<AppAgentThreadSteerResult> {
    await this.assertEnabled(appId);
    await this.load();
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.appId !== appId) {
      throw new Error('codex_conversation_not_found');
    }
    const activeRun = conversation.activeRun;
    const hasActiveRun = activeRun && !isTerminalRunStatus(activeRun.status);
    if (hasActiveRun && activeRun.runId !== runId) {
      throw new Error('codex_conversation_run_mismatch');
    }
    if (hasActiveRun) {
      this.options.onConversationEvent({
        type: 'run.steering.accepted',
        conversation: toConversation(conversation),
        run: activeRun,
      });
      await this.cancel(appId, conversationId, runId);
    }
    await this.sendMessage(appId, {
      conversationId,
      message: input.message,
      context: input.context,
      workspacePath: input.workspacePath,
      workspace: input.workspace,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      reasoningEffort: input.reasoningEffort,
    });
    return {
      accepted: true,
      mode: 'queued_for_next_run',
    };
  }

  public async requestPermission(
    runId: string,
    input: Omit<PermissionRequest, 'requestId'>,
  ): Promise<boolean | null> {
    const run = this.runs.get(runId);
    const conversation = run ? this.conversations.get(run.conversationId) : null;
    if (!run || !conversation || run.status === 'canceled' || run.status === 'failed') {
      return null;
    }
    if (this.options.canRequestPermission && !this.options.canRequestPermission(run.appId)) {
      return null;
    }

    const request: PermissionRequest = { requestId: randomUUID(), ...input };
    run.permissionRequest = request;
    run.status = 'needs_permission';
    run.updatedAt = new Date().toISOString();
    conversation.activeRun = toRun(run);
    conversation.updatedAt = run.updatedAt;
    await this.persistApp(run.appId);
    this.options.onConversationEvent({
      type: 'run.needs_permission',
      conversation: toConversation(conversation),
      run: toRun(run),
    });

    const decision = await new Promise<'allow' | 'deny'>((resolve) => {
      this.pendingPermissions.set(request.requestId, { runId, requestId: request.requestId, resolve });
    });

    if (this.runs.get(runId)?.permissionRequest?.requestId === request.requestId) {
      run.permissionRequest = undefined;
      run.status = run.status === 'needs_permission' ? 'running' : run.status;
      run.updatedAt = new Date().toISOString();
      conversation.activeRun = toRun(run);
      conversation.updatedAt = run.updatedAt;
      await this.persistApp(run.appId);
      this.options.onConversationEvent({
        type: 'run.progress',
        conversation: toConversation(conversation),
        run: toRun(run),
      });
    }

    return decision === 'allow';
  }

  public approvePermission(
    appId: string,
    conversationId: string,
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): { success: boolean } {
    const run = this.runs.get(runId);
    const pending = this.pendingPermissions.get(requestId);
    if (!run || run.appId !== appId || run.conversationId !== conversationId || !pending || pending.runId !== runId) {
      return { success: false };
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve(decision);
    return { success: true };
  }

  public rejectPendingPermissionsForApp(appId: string): void {
    for (const run of this.runs.values()) {
      if (run.appId !== appId) {
        continue;
      }
      const conversation = this.conversations.get(run.conversationId);
      this.resolvePendingPermission(run.runId, 'deny');
      run.permissionRequest = undefined;
      if (conversation && run.status === 'needs_permission') {
        run.status = 'running';
        run.updatedAt = new Date().toISOString();
        conversation.activeRun = toRun(run);
        conversation.updatedAt = run.updatedAt;
        void this.persistApp(appId);
        this.options.onConversationEvent({
          type: 'run.progress',
          conversation: toConversation(conversation),
          run: toRun(run),
        });
      }
    }
  }

  public async delete(appId: string, conversationId: string): Promise<{ success: boolean }> {
    await this.assertEnabled(appId);
    await this.load();
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.appId !== appId) {
      return { success: false };
    }
    const activeRun = conversation.activeRun;
    if (activeRun && !isTerminalRunStatus(activeRun.status)) {
      const run = this.runs.get(activeRun.runId);
      killProcessTree(run?.child);
      this.resolvePendingPermission(activeRun.runId, 'deny');
      if (run) {
        run.permissionRequest = undefined;
      }
      this.runs.delete(activeRun.runId);
    }
    this.conversations.delete(conversationId);
    await this.removeConversationRuntime(appId, conversationId);
    await this.persistApp(appId);
    this.options.onConversationEvent({
      type: 'conversation.deleted',
      conversation: toConversation(conversation),
    });
    return { success: true };
  }

  private async execute(
    conversationId: string,
    runId: string,
    input: AppCodexConversationSendMessageInput,
    allowResumeRecovery = true,
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    const run = this.runs.get(runId);
    if (!conversation || !run) {
      return;
    }
    const appRoot = path.join(this.options.privateAppsRoot, conversation.appId);
    if (!(await existsDirectory(appRoot))) {
      throw new Error('app_not_installed');
    }
    const runtime = await this.resolveRunRuntime(conversation, input);
    run.provider = runtime.provider;
    if (runtime.provider === 'antigravity') {
      if (!(await (this.options.getAntigravityAuthenticated?.() ?? Promise.resolve(false)))) {
        throw new Error('antigravity_auth_missing');
      }
    } else if (runtime.provider === 'claude') {
      if (!(await this.options.getClaudeAuthenticated())) {
        throw new Error('claude_auth_missing');
      }
    } else if (!(await this.options.getCodexAuthenticated())) {
      throw new Error('codex_auth_missing');
    }
    if (runtime.provider === 'codex') {
      await this.options.ensureGitAvailable?.();
    }
    const codexCliPath = runtime.provider === 'codex' ? await this.options.getCodexCliPath() : null;
    const claudeCliPath = runtime.provider === 'claude' ? await this.options.getClaudeCliPath() : null;
    const antigravityCliPath = runtime.provider === 'antigravity' ? await (this.options.getAntigravityCliPath?.() ?? Promise.resolve(null)) : null;
    if (runtime.provider === 'codex' && !codexCliPath) {
      throw new Error('codex_cli_missing');
    }
    if (runtime.provider === 'claude' && !claudeCliPath) {
      throw new Error('claude_cli_missing');
    }
    if (runtime.provider === 'antigravity' && !antigravityCliPath) {
      throw new Error('antigravity_cli_missing');
    }

    run.status = 'running';
    run.updatedAt = new Date().toISOString();
    conversation.activeRun = toRun(run);
    conversation.updatedAt = run.updatedAt;
    await this.persistApp(conversation.appId);
    this.options.onConversationEvent({
      type: 'run.started',
      conversation: toConversation(conversation),
      run: toRun(run),
    });

    let mcpServers: LlmAppMcpServerConfig[] = [];
    let forgerMcpSession: { url: string; token: string } | null = null;
    try {
      const pathEntries = await this.options.getCodexPathEntries(conversation.appId);
      const environment = await this.options.getCodexEnvironment(conversation.appId);
      const networkAccess = await (this.options.getAgentNetworkAccess?.(conversation.appId) ?? Promise.resolve(false));
      const appMcpServers = await (this.options.listenAppMcps?.([conversation.appId], run.runId) ?? Promise.resolve([]));
      forgerMcpSession = this.options.createForgerMcpSession?.(run.runId, conversation.appId, run.locale) ?? null;
      mcpServers = [
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
      const model = runtime.model;
      const reasoningEffort = runtime.provider === 'codex' ? runtime.effort as CodexReasoningEffort : DEFAULT_REASONING;
      const recoveryContext = !conversation.threadId && conversation.messages.length > 1
        ? buildConversationRecoveryContext(conversation, run.runId)
        : '';
      const prompt = recoveryContext
        ? buildManifestAgentRecoveryPrompt(input.message, recoveryContext)
        : input.message.trim();
      const attachmentPaths = await this.prepareAttachments(conversation.appId, run, input);
      const resolvedWorkspace = await this.resolveRunWorkspace(conversation.appId, appRoot, input.workspacePath, input.workspace);
      const runRoot = resolvedWorkspace.runRoot;
      const realAppRoot = await fs.realpath(appRoot);
      const additionalRoots = Array.from(new Set([realAppRoot, ...resolvedWorkspace.additionalRoots].filter((root) => root !== runRoot)));
      if (!(await existsDirectory(runRoot))) {
        throw new Error('agent_run_workspace_missing');
      }
      const antigravityRunRoot = runRoot;
      const antigravityAdditionalRoots = additionalRoots;
      const codexHome = runtime.provider === 'codex'
        ? await preparePersistentIsolatedCodexHome(
            this.options.codexHome,
            this.conversationCodexHome(conversation.appId, conversation.conversationId),
            {
              trustedRoots: Array.from(new Set([runRoot, ...additionalRoots])),
              networkAccess,
            },
          )
        : '';
      const onOutput = (stream: 'stdout' | 'stderr' | 'meta', text: string): void => {
        void appendRunLog(run.runLogPath ?? getRunLogPath(this.options.metadataRoot, run.runId), stream, text);
        this.handleOutput(conversation, run, runtime.provider, stream, text);
      };
      const antigravityResult = runtime.provider === 'antigravity'
        ? await antigravityCliAdapter.run({
            runId: run.runId,
            cliPath: antigravityCliPath as string,
            pathEntries: [path.dirname(antigravityCliPath as string), ...pathEntries],
            environment,
            mcpServers,
            workingDir: antigravityRunRoot,
            configWorkspaceRoot: appRoot,
            sharedRoots: additionalRoots,
            prompt,
            model,
            effort: runtime.effort,
            conversationId: conversation.threadId,
            addDirs: antigravityAdditionalRoots,
            permissionMode: runtime.permissionMode,
            timeoutMs: CODEX_CONVERSATION_RUN_TIMEOUT_MS,
            timeoutMode: 'absolute',
            onChild: (child) => {
              run.child = child;
            },
            onOutput,
            runCommandCapture,
          })
        : null;
      const claudeResult = runtime.provider === 'claude'
        ? await claudeCliAdapter.run({
            cliPath: claudeCliPath as string,
            pathEntries,
            environment,
            mcpServers,
            workingDir: runRoot,
            sharedRoots: additionalRoots,
            addDirs: additionalRoots,
            prompt,
            model,
            effort: runtime.effort as ClaudeEffort,
            permissionMode: runtime.permissionMode,
            timeoutMs: CODEX_CONVERSATION_RUN_TIMEOUT_MS,
            threadId: conversation.threadId,
            imagePaths: attachmentPaths,
            throwOnNonZero: false,
            onChild: (child) => {
              run.child = child;
            },
            onOutput,
            runCommandCapture,
          })
        : null;
      const codexResult = runtime.provider === 'codex'
        ? await codexCliAdapter.runConversation({
            cliPath: codexCliPath as string,
            pathEntries,
            environment,
            mcpServers,
            workingDir: runRoot,
            sharedRoots: additionalRoots,
            addDirs: additionalRoots,
            prompt,
            model,
            reasoningEffort,
            permissionMode: runtime.permissionMode,
            networkAccess,
            timeoutMs: CODEX_CONVERSATION_RUN_TIMEOUT_MS,
            codexHome,
            threadId: conversation.threadId,
            imagePaths: attachmentPaths,
            onChild: (child) => {
              run.child = child;
            },
            onOutput,
            runCommandCapture,
          })
        : null;
      const result = runtime.provider === 'antigravity'
        ? { code: 0, stdout: antigravityResult?.stdout ?? '', stderr: antigravityResult?.stderr ?? '', assistantText: antigravityResult?.assistantText ?? '', threadId: antigravityResult?.conversationId ?? undefined }
        : runtime.provider === 'claude'
          ? { code: 0, stdout: claudeResult?.stdout ?? '', stderr: claudeResult?.stderr ?? '', assistantText: claudeResult?.assistantText ?? '', threadId: claudeResult?.threadId }
          : { code: codexResult?.code ?? 1, stdout: codexResult?.stdout ?? '', stderr: codexResult?.stderr ?? '', assistantText: codexResult?.assistantText ?? '', threadId: codexResult?.threadId };
      assertAllowedMcpServers(result.stdout, result.stderr, new Set(mcpServers.map((server) => server.name)));

      if (this.runs.get(run.runId)?.status === 'canceled') {
        return;
      }
      if (result.code !== 0) {
        if (allowResumeRecovery && conversation.threadId && isMissingProviderThread(result.stdout, result.stderr)) {
          const lostThreadId = conversation.threadId;
          conversation.threadId = null;
          run.progressLog = [
            ...(run.progressLog ?? []),
            `Provider thread ${lostThreadId} is unavailable. Starting a fresh provider thread for this Vibe conversation.`,
          ].slice(-40);
          run.updatedAt = new Date().toISOString();
          conversation.activeRun = toRun(run);
          conversation.updatedAt = run.updatedAt;
          await this.persistApp(conversation.appId);
          this.options.onConversationEvent({
            type: 'run.progress',
            conversation: toConversation(conversation),
            run: toRun(run),
          });
          if (forgerMcpSession) {
            this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
            forgerMcpSession = null;
          }
          this.options.releaseAppMcps?.(run.runId);
          await this.execute(conversationId, runId, input, false);
          return;
        }
        throw buildProviderRunFailureError(
          runtime.provider,
          result.stdout,
          result.stderr,
          `${runtime.provider}_conversation_exec_failed`,
        );
      }

      if (result.threadId) {
        conversation.threadId = result.threadId;
      }
      const assistantText = result.assistantText || getSharedCopy(run.locale).appConversation.done;
      const assistantMessage: AppCodexConversationMessage = {
        messageId: randomUUID(),
        role: 'assistant',
        text: assistantText,
        runId: run.runId,
        createdAt: new Date().toISOString(),
      };
      conversation.messages.push(assistantMessage);
      run.status = 'completed';
      run.updatedAt = assistantMessage.createdAt;
      conversation.activeRun = toRun(run);
      conversation.updatedAt = assistantMessage.createdAt;
      await this.persistApp(conversation.appId);
      this.options.onConversationEvent({
        type: 'run.message.completed',
        conversation: toConversation(conversation),
        run: toRun(run),
        message: assistantMessage,
      });
      this.options.onConversationEvent({
        type: 'run.completed',
        conversation: toConversation(conversation),
        run: toRun(run),
      });
    } finally {
      if (forgerMcpSession) {
        this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
      }
      this.options.releaseAppMcps?.(run.runId);
      await this.cleanupRunAttachments(run).catch(() => undefined);
    }
  }

  private async prepareAttachments(
    appId: string,
    run: InternalRun,
    input: AppCodexConversationSendMessageInput,
  ): Promise<string[]> {
    const attachments = input.attachments ?? [];
    const output: string[] = [];
    if (attachments.length === 0) {
      return output;
    }
    const directory = path.join(this.options.metadataRoot, 'app-codex-conversation-inputs', appId, run.runId);
    await fs.mkdir(directory, { recursive: true });
    for (const [index, attachment] of attachments.entries()) {
      if (!attachment || typeof attachment.dataBase64 !== 'string') {
        continue;
      }
      const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType : 'application/octet-stream';
      if (!mimeType.toLowerCase().startsWith('image/')) {
        continue;
      }
      const buffer = Buffer.from(attachment.dataBase64, 'base64');
      if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error('codex_conversation_attachment_too_large');
      }
      const extension = extensionForMimeType(mimeType);
      const filename = `${index + 1}-${sanitizeId(attachment.name || 'attachment')}.${extension}`;
      const filePath = path.join(directory, filename);
      await fs.writeFile(filePath, buffer);
      output.push(filePath);
    }
    run.attachmentPaths = output;
    return output;
  }

  private async cleanupRunAttachments(run: InternalRun): Promise<void> {
    if (!run.attachmentPaths || run.attachmentPaths.length === 0) {
      return;
    }
    const parent = path.dirname(run.attachmentPaths[0]);
    await fs.rm(parent, { recursive: true, force: true });
    run.attachmentPaths = [];
  }

  private async resolveRunWorkspace(
    appId: string,
    appRoot: string,
    workspacePath: string | undefined,
    workspace: AppAgentWorkspaceInput | undefined,
  ): Promise<ResolvedRunWorkspace> {
    const cwdGrantId = workspace?.cwdGrantId?.trim();
    const additionalGrantIds = [...new Set((workspace?.additionalFolderGrantIds ?? []).map((entry) => entry.trim()).filter(Boolean))];
    if (!cwdGrantId && additionalGrantIds.length === 0) {
      return { runRoot: await this.resolveRunRoot(appRoot, workspacePath), additionalRoots: [] };
    }
    if (!this.options.resolveFolderGrant) {
      throw new Error('agent_run_folder_grants_unavailable');
    }
    const cwdGrant = cwdGrantId ? await this.options.resolveFolderGrant(appId, cwdGrantId) : null;
    const additionalRoots: string[] = [];
    for (const grantId of additionalGrantIds) {
      const grant = await this.options.resolveFolderGrant(appId, grantId);
      additionalRoots.push(grant.realPath);
    }
    return {
      runRoot: cwdGrant?.realPath ?? await this.resolveRunRoot(appRoot, workspacePath),
      additionalRoots,
    };
  }

  private async resolveRunRoot(appRoot: string, workspacePath: string | undefined): Promise<string> {
    const realAppRoot = await fs.realpath(appRoot);
    const requested = typeof workspacePath === 'string' ? workspacePath.trim() : '';
    if (!requested) {
      return appRoot;
    }
    const resolved = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(appRoot, requested);
    const requestedRelative = path.relative(appRoot, resolved);
    if (requestedRelative !== '' && (requestedRelative.startsWith('..') || path.isAbsolute(requestedRelative))) {
      throw new Error('agent_run_workspace_outside_app');
    }
    const realResolved = await fs.realpath(resolved).catch(() => null);
    if (!realResolved) {
      throw new Error('agent_run_workspace_missing');
    }
    const relative = path.relative(realAppRoot, realResolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return resolved;
    }
    throw new Error('agent_run_workspace_outside_app');
  }

  private handleOutput(
    conversation: InternalConversation,
    run: InternalRun,
    provider: AgentRuntime['provider'],
    stream: 'stdout' | 'stderr' | 'meta',
    text: string,
  ): void {
    const progressMessages = provider === 'antigravity'
      ? toProviderProgressMessages(provider, stream, text, run.locale)
      : [progressFromCodexOutput(text, run.locale)].filter((progress): progress is string => Boolean(progress));
    if (progressMessages.length === 0) {
      return;
    }
    run.progressLog = [...(run.progressLog ?? []), ...progressMessages].slice(-40);
    run.updatedAt = new Date().toISOString();
    conversation.activeRun = toRun(run);
    conversation.updatedAt = run.updatedAt;
    void this.persistApp(conversation.appId);
    for (const progress of progressMessages) {
      this.options.onConversationEvent({
        type: 'run.progress',
        conversation: toConversation(conversation),
        run: toRun(run),
        progress,
      });
    }
  }

  private async failRun(
    runId: string,
    message: string,
    errorDetails?: AppCodexConversationRun['errorDetails'],
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status === 'canceled') {
      return;
    }
    const conversation = this.conversations.get(run.conversationId);
    if (!conversation) {
      return;
    }
    this.resolvePendingPermission(runId, 'deny');
    run.permissionRequest = undefined;
    run.status = 'failed';
    run.error = message;
    run.errorDetails = errorDetails;
    run.updatedAt = new Date().toISOString();
    conversation.activeRun = toRun(run);
    conversation.updatedAt = run.updatedAt;
    await this.persistApp(run.appId);
    this.options.onConversationEvent({
      type: 'run.failed',
      conversation: toConversation(conversation),
      run: toRun(run),
    });
  }

  private resolvePendingPermission(runId: string, decision: 'allow' | 'deny'): void {
    for (const [requestId, pending] of this.pendingPermissions.entries()) {
      if (pending.runId === runId) {
        this.pendingPermissions.delete(requestId);
        pending.resolve(decision);
      }
    }
  }

  private async assertEnabled(appId: string): Promise<void> {
    if (!(await this.options.hasCodexConversation(appId))) {
      throw new Error('app_codex_conversation_not_declared');
    }
  }

  private async resolveAgentRuntime(conversation: InternalConversation): Promise<{
    model: string;
    reasoningEffort: CodexReasoningEffort;
    runtime?: AgentRuntime;
    runtimeRecommendations?: AgentRuntimeRecommendations;
  }> {
    const metadata = normalizeMetadata(conversation.metadata);
    const agentId = typeof metadata?.agentId === 'string' ? metadata.agentId.trim() : '';
    if (!agentId) {
      return { model: DEFAULT_MODEL, reasoningEffort: DEFAULT_REASONING };
    }
    const agent = (await this.options.resolveAgents(conversation.appId)).find((entry) => entry.id === agentId);
    return {
      model: agent?.model?.trim() || DEFAULT_MODEL,
      reasoningEffort: agent?.reasoningEffort ?? DEFAULT_REASONING,
      ...(agent?.runtime ? { runtime: agent.runtime } : {}),
      ...(agent?.runtimeRecommendations ? { runtimeRecommendations: agent.runtimeRecommendations } : {}),
    };
  }

  private async assertRuntimeControlAllowed(
    appId: string,
    input: Pick<AppCodexConversationSendMessageInput, 'provider' | 'model' | 'effort' | 'reasoningEffort'>,
  ): Promise<void> {
    if (!hasRunRuntimeInput(input)) {
      return;
    }
    if (!(await (this.options.appAllowsAgentRuntimeControl?.(appId) ?? Promise.resolve(false)))) {
      throw new Error('desktop_runtime_agent_runtime_control_required');
    }
  }

  private async resolveRunRuntime(
    conversation: InternalConversation,
    input: Pick<AppCodexConversationSendMessageInput, 'provider' | 'model' | 'effort' | 'reasoningEffort'>,
  ): Promise<AgentRuntime> {
    const agentRuntime = await this.resolveAgentRuntime(conversation);
    if (hasRunRuntimeInput(input)) {
      return await this.options.getAgentRuntime({
        provider: input.provider ?? agentRuntime.runtime?.provider,
        model: input.model ?? agentRuntime.runtime?.model,
        effort: input.effort ?? input.reasoningEffort ?? agentRuntime.runtime?.effort,
        permissionMode: agentRuntime.runtime?.permissionMode,
        strict: true,
      });
    }
    return await this.options.getAgentRuntime(agentRuntime.runtime ?? {
      recommendations: agentRuntime.runtimeRecommendations,
      model: agentRuntime.model,
      effort: agentRuntime.reasoningEffort,
    });
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadAll();
    }
    await this.loadPromise;
  }

  private async loadAll(): Promise<void> {
    const root = this.conversationsRoot();
    await fs.mkdir(root, { recursive: true });
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await fs.readFile(path.join(root, entry.name), 'utf8');
        const parsed = JSON.parse(raw) as { conversations?: InternalConversation[] };
        let migrated = false;
        for (const conversation of parsed.conversations ?? []) {
          if (conversation?.conversationId && conversation.appId) {
            const normalizedConversation = this.migrateLegacyRuntime(conversation);
            migrated = migrated || normalizedConversation !== conversation;
            this.conversations.set(conversation.conversationId, {
              ...normalizedConversation,
              activeRun: normalizedConversation.activeRun && isTerminalRunStatus(normalizedConversation.activeRun.status)
                ? normalizedConversation.activeRun
                : undefined,
            });
          }
        }
        if (migrated) {
          const appId = path.basename(entry.name, '.json');
          await this.persistApp(appId);
        }
      } catch {
        continue;
      }
    }
  }

  private migrateLegacyRuntime(conversation: InternalConversation): InternalConversation {
    if (conversation.runtime || (!conversation.threadId && conversation.messages.length === 0)) {
      return conversation;
    }
    return {
      ...conversation,
      runtime: {
        provider: 'codex',
        model: DEFAULT_MODEL,
        effort: DEFAULT_REASONING,
      },
    };
  }

  private async persistApp(appId: string): Promise<void> {
    const root = this.conversationsRoot();
    await fs.mkdir(root, { recursive: true });
    const conversations = [...this.conversations.values()].filter((conversation) => conversation.appId === appId);
    await fs.writeFile(
      path.join(root, `${sanitizeId(appId)}.json`),
      JSON.stringify({ conversations }, null, 2),
      'utf8',
    );
  }

  private conversationsRoot(): string {
    return path.join(this.options.metadataRoot, 'app-codex-conversations');
  }

  private conversationRuntimeRoot(appId: string, conversationId: string): string {
    return path.join(
      this.options.metadataRoot,
      'app-agent-conversations-runtime',
      sanitizeId(appId),
      sanitizeId(conversationId),
    );
  }

  private conversationCodexHome(appId: string, conversationId: string): string {
    return path.join(this.conversationRuntimeRoot(appId, conversationId), 'codex-home');
  }

  private async removeConversationRuntime(appId: string, conversationId: string): Promise<void> {
    await fs.rm(this.conversationRuntimeRoot(appId, conversationId), { recursive: true, force: true }).catch(() => undefined);
  }
}

const readTail = async (filePath: string, maxBytes = 180_000): Promise<Record<string, unknown> | null> => {
  const handle = await fs.open(filePath, 'r').catch(() => null);
  if (!handle) {
    return null;
  }
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return {
      path: filePath,
      bytesRead: buffer.length,
      truncatedFromStart: start > 0,
      text: buffer.toString('utf8'),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
};
