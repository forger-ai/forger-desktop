import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
  CodexReasoningEffort,
  PermissionRequest,
  PreviewDiffFile,
} from '../../shared/types';
import { buildFailureDiagnostic } from '../../shared/error-diagnostics';
import {
  assertAllowedMcpServers,
  createIsolatedCodexHome,
  DisallowedMcpServerError,
  removeIsolatedCodexHome,
} from '../codex-run-isolation';

interface ChatOrchestratorOptions {
  forgerHomeRoot: string;
  privateAppsRoot: string;
  metadataRoot: string;
  legacyMetadataRoot?: string;
  codexHome: string;
  agentContractVersion: number;
  getCodexCliPath: () => Promise<string | null>;
  getCodexPathEntries: (appId?: string) => Promise<string[]>;
  getCodexEnvironment: (appId?: string) => Promise<Record<string, string>>;
  getCodexAuthenticated: () => Promise<boolean>;
  createForgerMcpSession?: (runId: string, appId: string) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext?: (appIds: string[]) => Promise<string>;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<CodexMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  onUpdateConflictResolved?: (appId: string) => Promise<void>;
  onRunUpdated: (event: ChatRunEvent) => void;
}

interface CodexMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

interface PluginManifestV1 {
  id: string;
  version: string;
  permissions: string[];
  safeCommands: string[];
  signature: string;
  sha256: string;
}

const requiresWindowsShell = (command: string): boolean => {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
};

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
  taskType: ForgerTaskType;
}

type ForgerTaskType =
  | 'resolver_dudas'
  | 'trabajar_datos'
  | 'interactuar_con_aplicacion'
  | 'actualizar_aplicacion'
  | 'resolver_conflicto_actualizacion';

interface PendingPermission {
  runId: string;
  requestId: string;
  resolve: (decision: 'allow' | 'deny') => void;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  turns: number;
}

interface AppThreadState {
  appId: string;
  threadId: string;
  contractVersion: number;
  usage: CodexUsage;
  toolEvents: number;
  lastRunAt: string;
}

interface CodexRunResult {
  assistantText: string;
  threadId?: string;
  usageDelta?: Partial<CodexUsage>;
  toolEvents: number;
}

class AuditLogger {
  public constructor(private readonly privateAppsRoot: string) {}

  public async log(event: Record<string, unknown>): Promise<void> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const dir = path.join(this.privateAppsRoot, '.forger', 'audit');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${day}.log`);
    await fs.appendFile(filePath, `${JSON.stringify({ ts: now.toISOString(), ...event })}\n`, 'utf8');
  }
}

class PermissionBroker {
  public constructor(
    private readonly appRoot: string,
    private readonly sharedRoots: string[],
  ) {}

  public async assertAllowedPath(targetPath: string): Promise<void> {
    const resolvedTarget = await this.safeRealPath(targetPath);
    const allowedRoots = [await this.safeRealPath(this.appRoot), ...this.sharedRoots];

    const allowed = allowedRoots.some((root) => this.isPathInside(resolvedTarget, root));
    if (!allowed) {
      throw this.createError('sandbox_violation', `Path outside allowed roots: ${targetPath}`);
    }
  }

  public isPathInside(target: string, root: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private async safeRealPath(input: string): Promise<string> {
    const normalized = path.normalize(input);
    const real = await fs.realpath(normalized).catch(async () => {
      const parent = path.dirname(normalized);
      const parentReal = await fs.realpath(parent);
      return path.join(parentReal, path.basename(normalized));
    });

    if (real.includes(`..${path.sep}`)) {
      throw this.createError('sandbox_violation', 'Path traversal blocked');
    }
    return real;
  }

  private createError(code: ChatErrorCode, message: string): Error {
    const error = new Error(message);
    (error as Error & { chatCode?: ChatErrorCode }).chatCode = code;
    return error;
  }
}

class PluginRuntime {
  private readonly manifests: PluginManifestV1[];

  public constructor() {
    const manifestBase = {
      id: 'forger-codex-editor',
      version: '1.0.0',
      permissions: ['app.fs.read', 'app.fs.write', 'preview.generate', 'process.exec.safe'],
      safeCommands: ['npm run test', 'npm run build', 'python -m pytest'],
      signature: 'forger-built-in',
    };

    const sha256 = createHash('sha256').update(JSON.stringify(manifestBase)).digest('hex');
    this.manifests = [{ ...manifestBase, sha256 }];
  }

  public listActive(): PluginManifestV1[] {
    return [...this.manifests];
  }

  public ensureSafeCommand(command: string): void {
    const safe = this.manifests.some((manifest) =>
      manifest.safeCommands.some((prefix) => command === prefix || command.startsWith(`${prefix} `)),
    );

    if (!safe) {
      const error = new Error(`Unsafe command blocked: ${command}`);
      (error as Error & { chatCode?: ChatErrorCode }).chatCode = 'permission_denied';
      throw error;
    }
  }
}

class SandboxRunner {
  public constructor(private readonly codexHome: string) {}

  private async resolveCodexCommand(params: {
    codexCliPath: string;
    pathEntries: string[];
  }): Promise<{ command: string; prefixArgs: string[]; pathEntries: string[] }> {
    if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(params.codexCliPath)) {
      return {
        command: params.codexCliPath,
        prefixArgs: [],
        pathEntries: [path.dirname(params.codexCliPath), ...params.pathEntries],
      };
    }

    const nodePath = await findExecutableInPathEntries(params.pathEntries, ['node.exe', 'node']);
    const nodeModulesRoot = path.resolve(path.dirname(params.codexCliPath), '..');
    const codexEntrypoint = path.join(nodeModulesRoot, '@openai', 'codex', 'bin', 'codex.js');

    if (!nodePath || !(await existsFile(codexEntrypoint))) {
      throw new Error('codex_js_entrypoint_missing');
    }

    return {
      command: nodePath,
      prefixArgs: [codexEntrypoint],
      pathEntries: [path.dirname(nodePath), path.dirname(params.codexCliPath), ...params.pathEntries],
    };
  }

  public async runCodex(params: {
    codexCliPath: string;
    pathEntries: string[];
    environment: Record<string, string>;
    mcpServers?: CodexMcpServerConfig[];
    workingDir: string;
    prompt: string;
    model: string;
    reasoningEffort: CodexReasoningEffort;
    timeoutMs: number;
    onChild: (child: ChildProcessWithoutNullStreams) => void;
    onOutput?: (stream: 'stdout' | 'stderr' | 'meta', text: string) => void;
    threadId?: string;
  }): Promise<CodexRunResult> {
    const allowedRoots = [params.workingDir].join(path.delimiter);

    const modelArgs = ['--model', params.model];
    const reasoningArgs = ['--config', `reasoning_effort="${params.reasoningEffort}"`];
    const mcpServers = params.mcpServers ?? [];
    const mcpArgs = mcpServers.flatMap((server) => [
          '--config',
          `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`,
          '--config',
          `mcp_servers.${server.name}.bearer_token_env_var=${JSON.stringify(server.tokenEnvVar)}`,
          '--config',
          `mcp_servers.${server.name}.enabled=true`,
          '--config',
          `mcp_servers.${server.name}.tool_timeout_sec=${server.toolTimeoutSec ?? 600}`,
          '--config',
          `mcp_servers.${server.name}.default_tools_approval_mode="${getMcpApprovalMode(server)}"`,
          ...(server.name === 'forger'
            ? [
          '--config',
          'apps.forger.enabled=true',
          '--config',
          'apps.forger.default_tools_enabled=true',
          '--config',
          'apps.forger.default_tools_approval_mode="auto"',
          '--config',
          'apps.forger.destructive_enabled=true',
          '--config',
          'apps.forger.open_world_enabled=true',
            ]
            : []),
        ]);
    const commonArgs = ['--skip-git-repo-check', '-C', params.workingDir];
    const topLevelArgs = mcpServers.length > 0 ? ['--ask-for-approval', 'never'] : [];

    const attempts: string[][] = params.threadId
      ? [
          [
            'exec',
            'resume',
            '--json',
            ...modelArgs,
            ...reasoningArgs,
            ...mcpArgs,
            '--full-auto',
            '--skip-git-repo-check',
            params.threadId,
            params.prompt,
          ],
          [
            'exec',
            'resume',
            '--json',
            ...modelArgs,
            ...reasoningArgs,
            ...mcpArgs,
            '--skip-git-repo-check',
            params.threadId,
            params.prompt,
          ],
          [
            'exec',
            'resume',
            '--json',
            ...modelArgs,
            ...mcpArgs,
            '--skip-git-repo-check',
            params.threadId,
            params.prompt,
          ],
          ['exec', 'resume', ...modelArgs, ...mcpArgs, '--skip-git-repo-check', params.threadId, params.prompt],
        ]
      : [
          ['exec', '--json', ...modelArgs, ...reasoningArgs, ...mcpArgs, '--full-auto', '--sandbox', 'workspace-write', ...commonArgs, params.prompt],
          ['exec', '--json', ...modelArgs, ...reasoningArgs, ...mcpArgs, '--sandbox', 'workspace-write', ...commonArgs, params.prompt],
          ['exec', '--json', ...modelArgs, ...mcpArgs, '--sandbox', 'workspace-write', ...commonArgs, params.prompt],
          ['exec', '--json', ...modelArgs, ...mcpArgs, ...commonArgs, params.prompt],
          ['exec', ...modelArgs, ...mcpArgs, ...commonArgs, params.prompt],
        ];

    const attemptInactivityTimeoutMs = Math.max(45_000, Math.floor(params.timeoutMs / attempts.length));
    let lastResult: CommandResult | null = null;
    let lastErrorMessage = '';
    const codexCommand = await this.resolveCodexCommand(params);
    const isolatedCodexHome = await createIsolatedCodexHome(this.codexHome, {
      prefix: 'forger-chat-codex-home',
      trustedRoots: [params.workingDir],
    });
    const allowedMcpServers = new Set(mcpServers.map((server) => server.name));
    try {
      params.onOutput?.(
        'meta',
        [
          `Codex isolated CODEX_HOME=${isolatedCodexHome}`,
          `workingDir=${params.workingDir}`,
          `allowedMcpServers=${mcpServers.map((server) => server.name).join(',') || '(none)'}`,
          'askForApproval=never',
          'mcpDefaultToolsApprovalMode=forger:auto app:approve',
        ].join(' '),
      );
      for (const [index, args] of attempts.entries()) {
        try {
          const mode = args.includes('resume') ? 'resume' : 'new';
          const json = args.includes('--json') ? 'json' : 'plain';
          params.onOutput?.(
            'meta',
            `Intento ${index + 1}/${attempts.length} (${mode}, ${json}, model=${params.model})`,
          );
          const result = await runCommandCapture(
            codexCommand.command,
            [...codexCommand.prefixArgs, ...topLevelArgs, ...args],
            {
              cwd: params.workingDir,
              env: {
                CODEX_HOME: isolatedCodexHome,
                FORGER_ALLOWED_ROOTS: allowedRoots,
                ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
                ...params.environment,
                PATH: [...codexCommand.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
              },
              inactivityTimeoutMs: attemptInactivityTimeoutMs,
              onChild: params.onChild,
              onStdout: (text) => params.onOutput?.('stdout', text),
              onStderr: (text) => params.onOutput?.('stderr', text),
            },
          );

          assertAllowedMcpServers(result.stdout, result.stderr, allowedMcpServers);
          lastResult = result;
          if (result.code === 0) {
            const parsed = parseCodexJsonl(result.stdout, result.stderr);
            return {
              assistantText: parsed.assistantText || 'Listo. ¿Qué te gustaría hacer ahora en esta app?',
              threadId: parsed.threadId,
              usageDelta: parsed.usageDelta,
              toolEvents: parsed.toolEvents,
            };
          }
          lastErrorMessage = (result.stderr || result.stdout || '').trim();
        } catch (error) {
          if (error instanceof DisallowedMcpServerError) {
            throw error;
          }
          if (error instanceof Error) {
            lastErrorMessage = error.message;
            params.onOutput?.('meta', `Intento ${index + 1} falló: ${error.message}`);
          }
        }
      }
    } finally {
      await removeIsolatedCodexHome(isolatedCodexHome);
    }

    const message = (
      lastResult?.stderr ||
      lastResult?.stdout ||
      lastErrorMessage ||
      'codex_exec_failed'
    ).trim();
    const parsed = parseCodexJsonl(lastResult?.stdout ?? '', lastResult?.stderr ?? '');
    const error = new Error(message);
    (error as Error & { chatCode?: ChatErrorCode }).chatCode = 'capability_unavailable';
    (error as Error & { parsedRun?: CodexRunResult }).parsedRun = {
      assistantText: parsed.assistantText,
      threadId: parsed.threadId,
      usageDelta: parsed.usageDelta,
      toolEvents: parsed.toolEvents,
    };
    throw error;
  }
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
      model: input.model?.trim() || 'gpt-5.3-codex',
      reasoningEffort: input.reasoningEffort ?? 'low',
      taskType,
      conversationId: typeof input.conversationId === 'string' ? input.conversationId : undefined,
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
    return this.runs.get(input.runId) ?? null;
  }

  public cancelRun(input: ChatCancelRunInput): { success: boolean } {
    const run = this.runs.get(input.runId);
    if (!run) {
      return { success: false };
    }

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
      input.decision === 'allow' ? undefined : 'Permiso denegado para ejecutar la acción solicitada.';
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
      run.userMessage = 'Version guardada. Puedes volver a la version anterior cuando quieras.';
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
      run.userMessage = 'No pudimos guardar esta version. Revisa el cambio y reintenta.';
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
        userMessage: 'Cambio deshecho correctamente.',
      };
    } catch (error) {
      const detail = normalizeErrorCode(error);
      return {
        success: false,
        ...buildFailureDiagnostic({ fallbackCode: detail.code, rawError: detail.message }),
        userMessage: 'No pudimos deshacer el cambio.',
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

      if (!(await this.options.getCodexAuthenticated())) {
        throw createChatError('auth_missing', 'Codex authentication missing');
      }

      const codexCliPath = await this.options.getCodexCliPath();
      if (!codexCliPath) {
        throw createChatError('capability_unavailable', 'Codex CLI not installed');
      }
      const codexPathEntries = await this.options.getCodexPathEntries(run.appId);
      const codexEnvironment = await this.options.getCodexEnvironment(run.appId);

      if (run.taskType === 'actualizar_aplicacion') {
        await ensureGitRepository(run.appRoot);
        await ensureUserModifiedBranch(run.appRoot);
        run.baseHead = await getGitHead(run.appRoot);
      } else if (run.taskType === 'resolver_conflicto_actualizacion') {
        await ensureGitRepository(run.appRoot);
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
      forgerMcpSession = this.options.createForgerMcpSession?.(run.runId, run.appId) ?? null;
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

      const resolvedThreadId = run.threadId === null
        ? undefined
        : run.threadId ?? this.threadsByApp.get(run.appId)?.threadId;
      const memoryContext = !resolvedThreadId
        ? await (this.options.buildMemoryContext?.([run.appId]) ?? Promise.resolve(''))
        : '';
      const prompt = memoryContext ? `${memoryContext}\n\n${run.prompt}` : run.prompt;

      const assistantReply = await this.sandboxRunner.runCodex({
        codexCliPath,
        pathEntries: codexPathEntries,
        environment: codexEnvironment,
        mcpServers,
        workingDir: this.options.forgerHomeRoot,
        prompt,
        model: run.model,
        reasoningEffort: run.reasoningEffort,
        timeoutMs: 300_000,
        onChild: () => {
          // hook reserved for cancellation propagation
        },
        onOutput: (stream, text) => {
          void appendRunLog(run.runLogPath, stream, text);
          const steps = toProgressMessages(stream, text);
          if (steps.length > 0) {
            run.progressLog = [...(run.progressLog ?? []), ...steps].slice(-40);
            run.updatedAt = new Date().toISOString();
            this.emitRun(run);
          }
        },
        threadId: resolvedThreadId,
      });

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
      run.userMessage = mapFailureMessage(detail.code, detail.message, run.runLogPath);
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
        'Revise la app y no encontre cambios que guardar. Si quieres, dime que ajustar visualmente o que flujo esperas cambiar.';
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
      title: 'Actualizacion combinada',
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
    this.options.onRunUpdated({ run });
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
}

const runCommandCapture = async (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    inactivityTimeoutMs?: number;
    onChild?: (child: ChildProcessWithoutNullStreams) => void;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
  },
): Promise<CommandResult> => {
  return await new Promise<CommandResult>((resolve, reject) => {
    const useShell = requiresWindowsShell(command);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    options.onChild?.(child);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutFired = false;

    const finalizeResolve = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const finalizeReject = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const killChild = (): void => {
      try {
        if (process.platform !== 'win32' && typeof child.pid === 'number') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // no-op
        }
      }
    };

    let timeout: NodeJS.Timeout | null = null;
    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timeoutFired = true;
        killChild();
        finalizeReject(createChatError('timeout', `${command} timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    let inactivityTimeout: NodeJS.Timeout | null = null;
    const resetInactivityTimeout = (): void => {
      if (!options.inactivityTimeoutMs || options.inactivityTimeoutMs <= 0) {
        return;
      }
      if (inactivityTimeout) {
        clearTimeout(inactivityTimeout);
      }
      inactivityTimeout = setTimeout(() => {
        timeoutFired = true;
        killChild();
        finalizeReject(
          createChatError(
            'timeout',
            `${command} timed out due to inactivity after ${options.inactivityTimeoutMs}ms`,
          ),
        );
      }, options.inactivityTimeoutMs);
    };
    resetInactivityTimeout();

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      resetInactivityTimeout();
      options.onStdout?.(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      resetInactivityTimeout();
      options.onStderr?.(text);
    });

    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (inactivityTimeout) {
        clearTimeout(inactivityTimeout);
      }
      finalizeReject(error);
    });

    child.on('exit', (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (inactivityTimeout) {
        clearTimeout(inactivityTimeout);
      }
      if (timeoutFired) {
        return;
      }
      finalizeResolve({
        code: typeof code === 'number' ? code : 1,
        stdout,
        stderr,
      });
    });
  });
};

const existsDirectory = async (dirPath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
};

const existsFile = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const findExecutableInPathEntries = async (
  entries: string[],
  executableNames: string[],
): Promise<string | null> => {
  for (const entry of entries) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      if (await existsFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

const ensureGitRepository = async (cwd: string): Promise<void> => {
  const isRepo = (await runCommandCapture('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    timeoutMs: 5_000,
  }).catch(() => null)) !== null;

  const ensureMain = async (): Promise<void> => {
    const checkoutMain = await runCommandCapture('git', ['checkout', 'main'], {
      cwd,
      timeoutMs: 10_000,
    }).catch(() => null);
    if (!checkoutMain || checkoutMain.code !== 0) {
      await runCommandCapture('git', ['checkout', '-B', 'main'], {
        cwd,
        timeoutMs: 10_000,
      });
    }
  };

  if (!isRepo) {
    await runCommandCapture('git', ['init', '-b', 'main'], { cwd, timeoutMs: 10_000 }).catch(async () => {
      await runCommandCapture('git', ['init'], { cwd, timeoutMs: 10_000 });
      await ensureMain();
    });
    await runCommandCapture('git', ['config', 'user.email', 'forger@local.invalid'], {
      cwd,
      timeoutMs: 5_000,
    });
    await runCommandCapture('git', ['config', 'user.name', 'Forger'], { cwd, timeoutMs: 5_000 });
    await runCommandCapture('git', ['add', '-A'], { cwd, timeoutMs: 10_000 });
    await runCommandCapture('git', ['commit', '--allow-empty', '-m', 'forger: initial state'], {
      cwd,
      timeoutMs: 10_000,
    }).catch(() => undefined);
    return;
  }

  await runCommandCapture('git', ['config', 'user.email', 'forger@local.invalid'], {
    cwd,
    timeoutMs: 5_000,
  }).catch(() => undefined);
  await runCommandCapture('git', ['config', 'user.name', 'Forger'], { cwd, timeoutMs: 5_000 }).catch(
    () => undefined,
  );
  await ensureMain().catch(() => undefined);
};

const ensureUserModifiedBranch = async (cwd: string): Promise<void> => {
  const checkout = await runCommandCapture('git', ['checkout', 'user-modified'], {
    cwd,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (checkout && checkout.code === 0) {
    return;
  }

  const create = await runCommandCapture('git', ['checkout', '-b', 'user-modified'], {
    cwd,
    timeoutMs: 10_000,
  });
  if (create.code !== 0) {
    throw createChatError('conflict', create.stderr || create.stdout || 'user_modified_branch_failed');
  }
};

const getGitStatus = async (cwd: string): Promise<string[]> => {
  const status = await runCommandCapture('git', ['status', '--porcelain'], {
    cwd,
    timeoutMs: 10_000,
  });
  if (status.code !== 0) {
    throw createChatError('conflict', status.stderr || status.stdout || 'git_status_failed');
  }
  return status.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const gitCommit = async (cwd: string, message: string): Promise<string> => {
  await runCommandCapture('git', ['add', '-A'], { cwd, timeoutMs: 20_000 });
  const commit = await runCommandCapture('git', ['commit', '-m', message], { cwd, timeoutMs: 20_000 });
  if (commit.code !== 0) {
    throw createChatError('conflict', commit.stderr || commit.stdout || 'git_commit_failed');
  }

  const head = await getGitHead(cwd);
  if (!head) {
    throw createChatError('conflict', 'missing_git_head_after_commit');
  }
  return head;
};

const getGitHead = async (cwd: string): Promise<string | null> => {
  const result = await runCommandCapture('git', ['rev-parse', 'HEAD'], {
    cwd,
    timeoutMs: 5_000,
  }).catch(() => null);

  if (!result || result.code !== 0) {
    return null;
  }

  const value = result.stdout.trim();
  return value || null;
};

const summarizeOperationTitle = (prompt: string): string => {
  const raw = extractUserMessage(prompt);
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'Cambio aplicado';
  }
  return compact.length <= 64 ? compact : `${compact.slice(0, 61)}...`;
};

const extractUserMessage = (prompt: string): string => {
  const markers = ['USER MESSAGE:', 'MENSAJE USUARIO:'];
  const markerMatch = markers
    .map((marker) => ({ marker, index: prompt.indexOf(marker) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)[0];
  if (!markerMatch) {
    return prompt.trim();
  }
  return prompt.slice(markerMatch.index + markerMatch.marker.length).trim();
};

const classifyForgerTask = (prompt: string): ForgerTaskType => {
  const message = extractUserMessage(prompt).toLowerCase();
  if (/\b(conflicto|conflict|merge)\b/.test(message) && /\b(actualizacion|actualización|update)\b/.test(message)) {
    return 'resolver_conflicto_actualizacion';
  }
  if (
    /\b(cambia|cambiar|modifica|modificar|actualiza|actualizar|agrega|agregar|anade|añade|quitar|quita|elimina|arregla|corrige|personaliza|ajusta|mejora|guarda|guardar|boton|botón|pantalla|vista|flujo|formulario|layout|diseno|diseño)\b/.test(
      message,
    )
  ) {
    return 'actualizar_aplicacion';
  }
  if (/\b(carga|cargar|importa|importar|datos|csv|excel|archivo|tabla|filas|registros|categorias|categorías)\b/.test(message)) {
    return 'trabajar_datos';
  }
  if (/\b(abre|abrir|ejecuta|ejecutar|revisa en la app|usa la app|haz click|aprieta|navega)\b/.test(message)) {
    return 'interactuar_con_aplicacion';
  }
  return 'resolver_dudas';
};

const buildFunctionalOperationSummary = (assistantText: string): string => {
  const compact = assistantText.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'Se guardo una nueva version de la app.';
  }
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
};

const buildAutoAppliedUserMessage = (assistantText: string): string => {
  const compact = assistantText.trim();
  const suffix = 'Version guardada. Puedes probarla ahora; si no quedo como esperabas, puedo ajustarla o volver a la version anterior.';
  if (!compact) {
    return suffix;
  }
  return `${compact}\n\n${suffix}`;
};

const buildPreview = async (stagingDir: string): Promise<{
  summary: string;
  impact: string;
  riskLevel: 'low' | 'medium' | 'high';
  filesChanged: number;
  diffFiles: PreviewDiffFile[];
  checks: string[];
}> => {
  const nameStatus = await runCommandCapture('git', ['status', '--porcelain'], {
    cwd: stagingDir,
    timeoutMs: 10_000,
  });

  const diffFiles: PreviewDiffFile[] = [];
  const lines = nameStatus.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    const status = line.slice(0, 2).trim();
    const rawPath = line.slice(3).trim();
    const changeType: PreviewDiffFile['changeType'] =
      status === 'A' || status === '??' ? 'added' : status === 'D' ? 'deleted' : 'modified';

    const diff = await runCommandCapture('git', ['diff', '--', rawPath], {
      cwd: stagingDir,
      timeoutMs: 10_000,
    });

    diffFiles.push({
      path: rawPath,
      changeType,
      diff: (diff.stdout || diff.stderr).slice(0, 30_000),
    });
  }

  const filesChanged = diffFiles.length;
  const summary =
    filesChanged === 0
      ? 'No se detectaron cambios en archivos.'
      : `Se prepararon ${filesChanged} cambios para esta app.`;

  return {
    summary,
    impact:
      filesChanged === 0
        ? 'No hay impacto para aplicar.'
        : 'Los cambios afectan solo archivos de la app objetivo dentro del workspace privado.',
    riskLevel: filesChanged > 15 ? 'high' : filesChanged > 5 ? 'medium' : 'low',
    filesChanged,
    diffFiles,
    checks: ['Sandbox privado activo', 'Sin acceso a archivos externos no compartidos'],
  };
};

const applyPreviewChanges = async (
  appRoot: string,
  stagingDir: string,
  diffFiles: PreviewDiffFile[],
): Promise<void> => {
  const broker = new PermissionBroker(appRoot, []);

  for (const file of diffFiles) {
    const targetPath = path.join(appRoot, file.path);
    await broker.assertAllowedPath(targetPath);

    if (file.changeType === 'deleted') {
      await fs.rm(targetPath, { force: true });
      continue;
    }

    const sourcePath = path.join(stagingDir, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
};

const parseCodexJsonl = (
  stdout: string,
  stderr: string,
): {
  assistantText: string;
  threadId?: string;
  usageDelta?: Partial<CodexUsage>;
  toolEvents: number;
} => {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return { assistantText: '', toolEvents: 0 };
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let threadId: string | undefined;
  let assistantText = '';
  let usageDelta: Partial<CodexUsage> | undefined;
  let toolEvents = 0;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (!assistantText) {
        assistantText = line;
      } else {
        assistantText += `\n${line}`;
      }
      continue;
    }

    const type = typeof entry.type === 'string' ? entry.type : '';
    if (type === 'thread.started' && typeof entry.thread_id === 'string') {
      threadId = entry.thread_id;
      continue;
    }

    if (type === 'item.completed' && entry.item && typeof entry.item === 'object') {
      const item = entry.item as Record<string, unknown>;
      const itemType = typeof item.type === 'string' ? item.type : '';
      if (itemType.includes('tool')) {
        toolEvents += 1;
      }
      if (itemType === 'agent_message' && typeof item.text === 'string') {
        assistantText = item.text;
      }
      continue;
    }

    if (type === 'turn.completed' && entry.usage && typeof entry.usage === 'object') {
      const usage = entry.usage as Record<string, unknown>;
      usageDelta = {
        inputTokens: toNumber(usage.input_tokens),
        cachedInputTokens: toNumber(usage.cached_input_tokens),
        outputTokens: toNumber(usage.output_tokens),
        reasoningOutputTokens: toNumber(usage.reasoning_output_tokens),
        turns: 1,
      };
      continue;
    }

    if (type.includes('tool')) {
      toolEvents += 1;
    }
  }

  return {
    assistantText: assistantText.trim(),
    threadId,
    usageDelta,
    toolEvents,
  };
};

const toNumber = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const getMcpApprovalMode = (server: CodexMcpServerConfig): 'auto' | 'approve' =>
  server.name === 'forger' ? 'auto' : 'approve';

const toProgressMessages = (
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
): string[] => {
  if (stream === 'meta') {
    return [];
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const mapped: string[] = [];
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof entry.type === 'string' ? entry.type : '';
    if (type === 'item.completed' && entry.item && typeof entry.item === 'object') {
      const item = entry.item as Record<string, unknown>;
      const itemType = typeof item.type === 'string' ? item.type : '';
      if (itemType === 'agent_message') {
        const messageText = typeof item.text === 'string' ? item.text.trim() : '';
        if (messageText) {
          const compact = messageText.replace(/\s+/g, ' ');
          const snippet = compact.length > 160 ? `${compact.slice(0, 160)}...` : compact;
          if (mapped[mapped.length - 1] !== snippet) {
            mapped.push(snippet);
          }
        }
      }
    }
  }

  return mapped.slice(-6);
};

const createChatError = (code: ChatErrorCode, message: string): Error => {
  const error = new Error(message);
  (error as Error & { chatCode?: ChatErrorCode }).chatCode = code;
  return error;
};

const getRunLogPath = (privateAppsRoot: string, runId: string): string => {
  return path.join(privateAppsRoot, '.forger', 'runs', `${runId}.log`);
};

const appendRunLog = async (
  runLogPath: string,
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(runLogPath), { recursive: true });
  const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
  await fs.appendFile(runLogPath, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
};

const normalizeErrorCode = (error: unknown): { code: ChatErrorCode; message: string } => {
  if (error && typeof error === 'object' && 'chatCode' in error) {
    const chatError = error as Error & { chatCode?: ChatErrorCode };
    return {
      code: chatError.chatCode ?? 'capability_unavailable',
      message: chatError.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'capability_unavailable',
      message: error.message,
    };
  }

  return {
    code: 'capability_unavailable',
    message: 'unknown_error',
  };
};

const mapFailureMessage = (code: ChatErrorCode, detail?: string, runLogPath?: string): string => {
  const snippet = detail?.split('\n').slice(0, 2).join(' ').trim();
  const logHint = runLogPath ? ` Log: ${runLogPath}` : '';
  switch (code) {
    case 'auth_missing':
      return 'Primero conecta Codex en Ajustes para usar Chat con cambios reales.';
    case 'app_not_installed':
      return 'La app objetivo no esta instalada en tu workspace privado.';
    case 'permission_denied':
      return 'No continuamos porque el permiso fue denegado.';
    case 'timeout':
      return 'La solicitud tardo demasiado y fue detenida.';
    case 'sandbox_violation':
      return 'Bloqueamos una accion fuera del workspace permitido.';
    case 'dirty_worktree':
      return 'Antes de comenzar, al parecer hay cambios sin guardar en tu aplicacion. ¿Quieres que guarde esa version antes de continuar?';
    case 'conflict':
      return 'Detectamos un conflicto con el estado actual de la app.';
    case 'canceled':
      return `Solicitud cancelada.${logHint}`;
    default:
      if (detail && /exec|unknown|command|not found|usage/i.test(detail)) {
        return `No pude ejecutar Codex CLI en este equipo. Revisa login y version en Ajustes. ${snippet ? `Detalle: ${snippet}` : ''}${logHint}`.trim();
      }
      return `No pude completar la solicitud con Codex.${snippet ? ` Detalle: ${snippet}` : ''}${logHint}`;
  }
};
