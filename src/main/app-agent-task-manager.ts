import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentRunActivityStatus,
  AppCodexTaskAttachment,
  AppCodexTaskEvent,
  AppCodexTaskStartInput,
  AppCodexTaskSummary,
  AppPromptTemplate,
  AppPromptTemplateArgument,
  AppAgentWorkspaceInput,
  AgentRuntime,
  AgentRuntimeRequest,
  PermissionRequest,
} from '../shared/types';
import {
  existsDirectory,
  isPathInside,
  killProcessTree,
  runCommandCapture,
} from './app-agent/process';
import { buildProviderRunFailureError } from './app-agent/provider-failures';
import {
  appendTranscript,
  buildLegacyPromptVariables,
  formatFileArgumentForPrompt,
  normalizeFileArgumentValue,
  normalizeStringArgument,
  normalizeTaskLocale,
  progressFromCodexOutput,
  renderPrompt,
  sanitizeFilename,
  isStaleCodexThreadError,
  taskMessage,
  uniqueFilename,
  validateAttachmentType,
  validateFileArgumentType,
  AppPromptStringTooLongError,
  type PreparedFileArgument,
  type PreparedPromptArguments,
  type TaskLocale,
} from './app-agent/task-helpers';
import type { LlmAppMcpServerConfig } from './app-agent/types';
import type { AppFolderGrantPublic } from './app-folder-grants';
import {
  addPermissionActivityItem,
  addStatusActivityItem,
  appendProviderActivity,
  createAgentRunActivity,
  finalizeAgentRunActivity,
  normalizeActivityStatus,
  persistAgentRunActivity,
} from './chat/agent-run-activity';
import { mapFailureMessage, normalizeProviderErrorCode, toProviderProgressMessages } from './chat/progress-errors';
import { createLlmProviderRunService } from './llm-provider/run-service';
import { parseCodexJsonl } from './llm-provider/output-parsers';
import type { LlmProviderAuthProfileResolver } from './llm-provider/types';

interface AppAgentTaskManagerOptions {
  privateAppsRoot: string;
  metadataRoot: string;
  codexHome: string;
  providerProfilesRoot?: string;
  resolveAuthProfile?: LlmProviderAuthProfileResolver;
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
  resolvePromptTemplates: (appId: string) => Promise<AppPromptTemplate[]>;
  createForgerMcpSession?: (runId: string, appId: string) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext?: (appId: string) => Promise<string>;
  buildForgerToolsContext?: (appId: string) => Promise<string>;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<LlmAppMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  resolveFolderGrant?: (appId: string, grantId: string) => Promise<AppFolderGrantPublic>;
  canRequestPermission?: (appId: string) => boolean;
  onTaskUpdated: (event: AppCodexTaskEvent) => void;
}

interface InternalTask extends AppCodexTaskSummary {
  appRoot: string;
  transcriptPath: string;
  child?: ChildProcessWithoutNullStreams;
  provider?: AgentRuntime['provider'];
}

interface ResolvedTaskWorkspace {
  runRoot: string;
  additionalRoots: string[];
}

const taskFailureFromError = (
  error: unknown,
  provider?: AgentRuntime['provider'],
): Pick<AppCodexTaskSummary, 'error' | 'errorDetails'> => {
  if (error instanceof AppPromptStringTooLongError) {
    return {
      error: error.userMessage,
      errorDetails: {
        technicalCode: error.technicalCode,
        argumentName: error.argumentName,
        maxLength: error.maxLength,
        actualLength: error.actualLength,
      },
    };
  }

  const providerDetail = normalizeProviderErrorCode(error);
  if (providerDetail) {
    return {
      error: mapFailureMessage(providerDetail.code, providerDetail.message, undefined, undefined, provider),
      errorDetails: {
        technicalCode: providerDetail.code,
      },
    };
  }

  return {
    error: error instanceof Error ? error.message : String(error ?? 'app_codex_task_failed'),
  };
};

interface PendingPermission {
  runId: string;
  requestId: string;
  resolve: (decision: 'allow' | 'deny') => void;
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const CODEX_TASK_TIMEOUT_MS = 600_000;

const hasTaskRuntimeInput = (runtime: AppCodexTaskStartInput['runtime']): boolean => {
  if (!runtime) {
    return false;
  }
  const modelParams = runtime.modelParams && typeof runtime.modelParams === 'object' ? runtime.modelParams : {};
  return Boolean(runtime.provider || runtime.model || runtime.authProfileId || runtime.effort || modelParams.effort || modelParams.reasoningEffort || runtime.permissionMode);
};

export class AppAgentTaskManager {
  private readonly tasks = new Map<string, InternalTask>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  public constructor(private readonly options: AppAgentTaskManagerOptions) {}

  public async start(appId: string, input: AppCodexTaskStartInput): Promise<AppCodexTaskSummary> {
    const templateId = sanitizeId(input.templateId);
    const templates = await this.options.resolvePromptTemplates(appId);
    const template = templates.find((entry) => entry.id === templateId);
    if (!template) {
      throw new Error('app_prompt_template_not_declared');
    }

    const appRoot = path.join(this.options.privateAppsRoot, appId);
    if (!(await existsDirectory(appRoot))) {
      throw new Error('app_not_installed');
    }
    await this.assertRuntimeControlAllowed(appId, input);
    if (hasTaskRuntimeInput(input.runtime)) {
      await this.resolveRuntime(template, input);
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    const runDir = this.taskRunDir(appId, runId);
    const task: InternalTask = {
      runId,
      appId,
      templateId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      progressLog: [],
      activity: createAgentRunActivity({
        runId,
        surface: 'app_prompt_task',
        status: 'queued',
        startedAt: now,
        updatedAt: now,
        sourceRef: {
          appId,
          taskId: templateId,
          title: templateId,
        },
      }),
      appRoot,
      transcriptPath: path.join(runDir, 'transcript.log'),
    };
    this.tasks.set(runId, task);
    await this.persist(task);
    this.emit(task);

    void this.execute(task, template, input).catch((error) => {
      const failure = taskFailureFromError(error, task.provider);
      void this.failTask(task, failure.error ?? 'app_codex_task_failed', failure.errorDetails);
    });

    return toSummary(task);
  }

  public get(appId: string, runId: string): AppCodexTaskSummary | null {
    const task = this.tasks.get(runId);
    if (!task || task.appId !== appId) {
      return null;
    }
    return toSummary(task);
  }

  public cancel(appId: string, runId: string): { success: boolean } {
    const task = this.tasks.get(runId);
    if (!task || task.appId !== appId) {
      return { success: false };
    }
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
      return { success: true };
    }
    killProcessTree(task.child);
    this.resolvePendingPermission(runId, 'deny');
    task.permissionRequest = undefined;
    task.status = 'canceled';
    task.updatedAt = new Date().toISOString();
    task.error = 'canceled';
    this.updateActivityForTask(task, 'canceled', task.error);
    void this.persist(task);
    void this.cleanupTaskInputs(task);
    this.emit(task);
    return { success: true };
  }

  public async requestPermission(
    runId: string,
    input: Omit<PermissionRequest, 'requestId'>,
  ): Promise<boolean | null> {
    const task = this.tasks.get(runId);
    if (!task || task.status === 'canceled' || task.status === 'failed') {
      return null;
    }
    if (this.options.canRequestPermission && !this.options.canRequestPermission(task.appId)) {
      return null;
    }

    const request: PermissionRequest = { requestId: randomUUID(), ...input };
    task.permissionRequest = request;
    task.status = 'needs_permission';
    task.updatedAt = new Date().toISOString();
    task.activity = addPermissionActivityItem(
      task.activity ?? this.createActivityForTask(task),
      request.reason || `Permission requested for ${request.resource}.`,
      `${request.permission}:${request.resource}`,
    );
    this.updateActivityForTask(task, 'needs_permission');
    await this.persist(task);
    this.emit(task);

    const decision = await new Promise<'allow' | 'deny'>((resolve) => {
      this.pendingPermissions.set(request.requestId, { runId, requestId: request.requestId, resolve });
    });

    if (this.tasks.get(runId)?.permissionRequest?.requestId === request.requestId) {
      task.permissionRequest = undefined;
      task.status = task.status === 'needs_permission' ? 'running' : task.status;
      task.updatedAt = new Date().toISOString();
      this.updateActivityForTask(task, normalizeActivityStatus(task.status));
      await this.persist(task);
      this.emit(task);
    }
    return decision === 'allow';
  }

  public approvePermission(
    appId: string,
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): { success: boolean } {
    const task = this.tasks.get(runId);
    const pending = this.pendingPermissions.get(requestId);
    if (!task || task.appId !== appId || !pending || pending.runId !== runId) {
      return { success: false };
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve(decision);
    return { success: true };
  }

  public rejectPendingPermissionsForApp(appId: string): void {
    for (const task of this.tasks.values()) {
      if (task.appId === appId) {
        this.resolvePendingPermission(task.runId, 'deny');
        task.permissionRequest = undefined;
        if (task.status === 'needs_permission') {
          task.status = 'running';
          task.updatedAt = new Date().toISOString();
          void this.persist(task);
          this.emit(task);
        }
      }
    }
  }

  private async execute(
    task: InternalTask,
    template: AppPromptTemplate,
    input: AppCodexTaskStartInput,
  ): Promise<void> {
    const locale = normalizeTaskLocale(input.locale);
    const runtime = await this.resolveRuntime(template, input);
    task.provider = runtime.provider;
    const providerRunService = createLlmProviderRunService({
      codexHome: this.options.codexHome,
      providerProfilesRoot: this.options.providerProfilesRoot,
      resolveAuthProfile: this.options.resolveAuthProfile,
      getCodexCliPath: this.options.getCodexCliPath,
      getClaudeCliPath: this.options.getClaudeCliPath,
      getAntigravityCliPath: this.options.getAntigravityCliPath,
      getCodexAuthenticated: this.options.getCodexAuthenticated,
      getClaudeAuthenticated: this.options.getClaudeAuthenticated,
      getAntigravityAuthenticated: this.options.getAntigravityAuthenticated,
      ensureGitAvailable: this.options.ensureGitAvailable,
    });
    await providerRunService.assertReady(runtime.provider);

    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    this.updateActivityForTask(task, 'running');
    this.addProgress(task, taskMessage(locale, 'preparing'));
    await this.persist(task);
    this.emit(task);

    let forgerMcpSession: { url: string; token: string } | null = null;
    let appMcpsReleased = false;
    try {
      const preparedArguments = await this.preparePromptArguments(task, template, input);
      const imagePaths = preparedArguments.files
        .filter((file) => file.mimeType?.toLowerCase().startsWith('image/'))
        .map((file) => file.path);
      const renderedPrompt = renderPrompt(template.prompt, preparedArguments, locale);
      const memoryContext = await (this.options.buildMemoryContext?.(task.appId) ?? Promise.resolve(''));
      const forgerToolsContext = await (this.options.buildForgerToolsContext?.(task.appId) ?? Promise.resolve(''));
      const promptContext = [memoryContext, forgerToolsContext].filter((section) => section.trim()).join('\n\n');
      const prompt = promptContext ? `${promptContext}\n\n${renderedPrompt}` : renderedPrompt;
      const pathEntries = await this.options.getCodexPathEntries(task.appId);
      const environment = await this.options.getCodexEnvironment(task.appId);
      const networkAccess = await (this.options.getAgentNetworkAccess?.(task.appId) ?? Promise.resolve(false));
      const resolvedWorkspace = await this.resolveRunWorkspace(task.appId, task.appRoot, input.workspacePath, input.workspace);
      const runRoot = resolvedWorkspace.runRoot;
      const realAppRoot = await fs.realpath(task.appRoot);
      const additionalRoots = Array.from(new Set([realAppRoot, ...resolvedWorkspace.additionalRoots].filter((root) => root !== runRoot)));
      if (!(await existsDirectory(runRoot))) {
        throw new Error('agent_run_workspace_missing');
      }
      const appMcpServers = await (this.options.listenAppMcps?.([task.appId], task.runId) ?? Promise.resolve([]));
      forgerMcpSession = this.options.createForgerMcpSession?.(task.runId, task.appId) ?? null;
      const mcpServers = [
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
      const onOutput = (stream: 'stdout' | 'stderr' | 'meta', text: string): void => {
        void appendTranscript(task.transcriptPath, stream, text);
        this.updateProgressFromOutput(task, runtime.provider, stream, text, locale);
      };
      const runProviderTask = async () =>
        await providerRunService.run({
          surface: 'app_prompt_task',
          mode: 'task',
          runtime,
          runId: task.runId,
          pathEntries,
          environment,
          mcpServers,
          workingDir: runRoot,
          configWorkspaceRoot: runtime.provider === 'claude' || runtime.provider === 'antigravity' ? task.appRoot : undefined,
          sharedRoots: additionalRoots,
          addDirs: additionalRoots,
          prompt,
          permissionMode: runtime.permissionMode,
          networkAccess,
          timeoutMs: CODEX_TASK_TIMEOUT_MS,
          timeoutMode: 'absolute',
          codexHomePlan: runtime.provider === 'codex'
            ? {
                type: 'temporary',
                rootCodexHome: this.options.codexHome,
                prefix: 'forger-task-codex-home',
                trustedRoots: Array.from(new Set([runRoot, ...additionalRoots])),
                networkAccess,
              }
            : { type: 'none' },
          imagePaths,
          alwaysIncludeMcpConfig: runtime.provider === 'claude' ? true : undefined,
          onChild: (child) => {
            task.child = child;
          },
          onOutput,
          runCommandCapture,
        });

      await appendTranscript(task.transcriptPath, 'meta', `${runtime.provider} provider run`);
      let result = await runProviderTask();
      if ((task as AppCodexTaskSummary).status === 'canceled') {
        return;
      }
      if (runtime.provider === 'codex' && result.code !== 0 && isStaleCodexThreadError(result.stderr || result.stdout)) {
        const recoveredText = parseCodexJsonl(result.stdout, '').assistantText;
        if (recoveredText) {
          result = { ...result, code: 0 };
        } else {
          this.addProgress(task, taskMessage(locale, 'technicalLimit'));
          await this.persist(task);
          this.emit(task);
          await appendTranscript(task.transcriptPath, 'meta', 'Retrying Codex task with a clean temporary Codex home.');
          result = await runProviderTask();
          if ((task as AppCodexTaskSummary).status === 'canceled') return;
        }
      }
      if (result.code !== 0) {
        throw buildProviderRunFailureError(runtime.provider, result.stdout, result.stderr);
      }
      task.status = 'completed';
      task.updatedAt = new Date().toISOString();
      task.resultText = result.assistantText || taskMessage(locale, 'completed');
      this.addProgress(task, taskMessage(locale, 'finished'));
      this.updateActivityForTask(task, 'completed');
      await this.cleanupTaskInputs(task).catch(() => undefined);
      if (forgerMcpSession) {
        this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
        forgerMcpSession = null;
      }
      this.options.releaseAppMcps?.(task.runId);
      appMcpsReleased = true;
      await this.persist(task);
      this.emit(task);
    } finally {
      if (forgerMcpSession) {
        this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
      }
      if (!appMcpsReleased) {
        this.options.releaseAppMcps?.(task.runId);
      }
      await this.cleanupTaskInputs(task).catch(() => undefined);
    }
  }

  private async failTask(task: InternalTask, message: string, errorDetails?: AppCodexTaskSummary['errorDetails']): Promise<void> {
    if (task.status === 'canceled') {
      return;
    }
    task.status = 'failed';
    this.resolvePendingPermission(task.runId, 'deny');
    task.permissionRequest = undefined;
    task.updatedAt = new Date().toISOString();
    task.error = message;
    task.errorDetails = errorDetails;
    this.updateActivityForTask(task, 'failed', message);
    await appendTranscript(task.transcriptPath, 'meta', `Run failed: ${message}`);
    await this.persist(task);
    this.emit(task);
  }

  private resolvePendingPermission(runId: string, decision: 'allow' | 'deny'): void {
    for (const [requestId, pending] of this.pendingPermissions.entries()) {
      if (pending.runId === runId) {
        this.pendingPermissions.delete(requestId);
        pending.resolve(decision);
      }
    }
  }

  private async resolveRunWorkspace(
    appId: string,
    appRoot: string,
    workspacePath: string | undefined,
    workspace: AppAgentWorkspaceInput | undefined,
  ): Promise<ResolvedTaskWorkspace> {
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

  private async preparePromptArguments(
    task: InternalTask,
    template: AppPromptTemplate,
    input: AppCodexTaskStartInput,
  ): Promise<PreparedPromptArguments> {
    if (!template.arguments || template.arguments.length === 0) {
      const files = await this.writeLegacyAttachments(task, template, input.attachments ?? []);
      return {
        variables: buildLegacyPromptVariables(input.variables ?? {}, files),
        files,
      };
    }

    const rawArguments = input.arguments ?? {};
    const declaredNames = new Set(template.arguments.map((argument) => argument.name));
    for (const name of Object.keys(rawArguments)) {
      if (!declaredNames.has(name)) {
        throw new Error(`app_prompt_argument_not_declared:${name}`);
      }
    }

    const variables: PreparedPromptArguments['variables'] = {};
    const files: PreparedFileArgument[] = [];
    for (const argument of template.arguments) {
      const value = rawArguments[argument.name];
      if (value === undefined || value === null) {
        if (argument.required) {
          throw new Error(`app_prompt_argument_required:${argument.name}`);
        }
        variables[argument.name] = '';
        continue;
      }
      if (argument.type === 'string') {
        variables[argument.name] = normalizeStringArgument(argument, value);
        continue;
      }

      const argumentFiles = await this.writeFileArgument(task, argument, value);
      if (argument.required && argumentFiles.length === 0) {
        throw new Error(`app_prompt_argument_required:${argument.name}`);
      }
      files.push(...argumentFiles);
      variables[argument.name] = formatFileArgumentForPrompt(argumentFiles);
    }

    return { variables, files };
  }

  private async assertRuntimeControlAllowed(appId: string, input: AppCodexTaskStartInput): Promise<void> {
    if (!input.runtime) {
      return;
    }
    if (!(await (this.options.appAllowsAgentRuntimeControl?.(appId) ?? Promise.resolve(false)))) {
      throw new Error('desktop_runtime_agent_runtime_control_required');
    }
  }

  private async resolveRuntime(template: AppPromptTemplate, input: AppCodexTaskStartInput): Promise<AgentRuntime> {
    if (hasTaskRuntimeInput(input.runtime)) {
      const runtime = input.runtime as NonNullable<AppCodexTaskStartInput['runtime']>;
      const templateRuntime = template.runtime;
      if (runtime.provider !== undefined && runtime.provider !== 'codex' && runtime.provider !== 'claude' && runtime.provider !== 'antigravity') {
        throw new Error('agent_runtime_provider_unsupported');
      }
      const modelParams = runtime.modelParams && typeof runtime.modelParams === 'object'
        ? runtime.modelParams
        : {};
      const effort = runtime.effort === 'default'
        ? undefined
        : runtime.effort ?? modelParams.effort ?? modelParams.reasoningEffort;
      return await this.options.getAgentRuntime({
        provider: runtime.provider ?? templateRuntime?.provider,
        model: typeof runtime.model === 'string' && runtime.model.trim() && runtime.model.trim() !== 'auto'
          ? runtime.model.trim()
          : templateRuntime?.model,
        authProfileId: typeof runtime.authProfileId === 'string' && runtime.authProfileId.trim()
          ? runtime.authProfileId.trim()
          : templateRuntime?.authProfileId,
        effort: (effort ?? templateRuntime?.effort) as AgentRuntimeRequest['effort'],
        permissionMode: runtime.permissionMode ?? templateRuntime?.permissionMode,
        ...(!templateRuntime ? { recommendations: template.runtimeRecommendations } : {}),
        strict: true,
      });
    }
    return await this.options.getAgentRuntime(template.runtime ?? {
      recommendations: template.runtimeRecommendations,
      model: template.runtimeRecommendations ? undefined : template.model,
      effort: template.runtimeRecommendations ? undefined : template.reasoningEffort,
    });
  }

  private async writeLegacyAttachments(
    task: InternalTask,
    template: AppPromptTemplate,
    attachments: AppCodexTaskAttachment[],
  ): Promise<PreparedFileArgument[]> {
    const targetDir = this.taskInputDir(task);
    await fs.mkdir(targetDir, { recursive: true });
    const written: PreparedFileArgument[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const safeName = sanitizeFilename(attachment.name || `attachment-${index + 1}`);
      validateAttachmentType(template, attachment, safeName);
      const bytes = Buffer.from(attachment.dataBase64, 'base64');
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new Error('attachment_too_large');
      }
      const filePath = path.join(targetDir, safeName);
      if (!isPathInside(filePath, targetDir)) {
        throw new Error('attachment_path_outside_task_inputs');
      }
      await fs.writeFile(filePath, bytes);
      written.push({ argumentName: 'attachment', name: safeName, path: filePath, mimeType: attachment.mimeType });
    }
    return written;
  }

  private async writeFileArgument(
    task: InternalTask,
    argument: AppPromptTemplateArgument,
    value: unknown,
  ): Promise<PreparedFileArgument[]> {
    const incomingFiles = normalizeFileArgumentValue(argument, value);
    const targetDir = this.taskInputDir(task);
    await fs.mkdir(targetDir, { recursive: true });
    const written: PreparedFileArgument[] = [];
    const usedNames = new Set<string>();
    for (const [index, file] of incomingFiles.entries()) {
      const safeName = uniqueFilename(
        sanitizeFilename(file.name || `${argument.name}-${index + 1}`),
        usedNames,
      );
      validateFileArgumentType(argument, file, safeName);
      const bytes = Buffer.from(file.dataBase64, 'base64');
      if (bytes.length > (argument.maxBytes ?? MAX_ATTACHMENT_BYTES)) {
        throw new Error(`app_prompt_file_too_large:${argument.name}`);
      }
      const filePath = path.join(targetDir, safeName);
      if (!isPathInside(filePath, targetDir)) {
        throw new Error('attachment_path_outside_task_inputs');
      }
      await fs.writeFile(filePath, bytes);
      written.push({ argumentName: argument.name, name: safeName, path: filePath, mimeType: file.mimeType });
    }
    return written;
  }

  private taskInputDir(task: InternalTask): string {
    const root = path.resolve(task.appRoot, '.forger', 'tmp', 'codex-task-inputs');
    const target = path.resolve(root, task.runId);
    if (!isPathInside(target, root)) {
      throw new Error('app_codex_task_path_outside_tmp');
    }
    return target;
  }

  private async cleanupTaskInputs(task: InternalTask): Promise<void> {
    await fs.rm(this.taskInputDir(task), { recursive: true, force: true });
  }

  private addProgress(task: InternalTask, message: string): void {
    if (task.progressLog?.at(-1) === message) {
      return;
    }
    task.progressLog = [...(task.progressLog ?? []), message].slice(-40);
    task.updatedAt = new Date().toISOString();
    task.activity = addStatusActivityItem(task.activity ?? this.createActivityForTask(task), message);
    this.updateActivityForTask(task, normalizeActivityStatus(task.status));
  }

  private updateProgressFromOutput(
    task: InternalTask,
    provider: AgentRuntime['provider'],
    stream: 'stdout' | 'stderr' | 'meta',
    text: string,
    locale: TaskLocale,
  ): void {
    const activityItemCount = task.activity?.counts.total ?? 0;
    task.activity = appendProviderActivity({
      activity: task.activity ?? this.createActivityForTask(task),
      provider,
      stream,
      text,
    });
    const activityChanged = (task.activity?.counts.total ?? 0) !== activityItemCount;
    const messages = provider === 'codex'
      ? [progressFromCodexOutput(text, locale)].filter((progress): progress is string => Boolean(progress))
      : toProviderProgressMessages(provider, stream, text, locale);
    if (messages.length === 0 && !activityChanged) {
      return;
    }
    for (const message of messages) {
      this.addProgress(task, message);
    }
    if (messages.length === 0) {
      task.updatedAt = new Date().toISOString();
      this.updateActivityForTask(task, normalizeActivityStatus(task.status));
    }
    void this.persist(task);
    this.emit(task);
  }

  private taskRunDir(appId: string, runId: string): string {
    const root = path.resolve(this.options.metadataRoot, 'app-codex-runs', appId);
    const target = path.resolve(root, runId);
    if (!isPathInside(target, root)) {
      throw new Error('app_codex_task_path_outside_storage');
    }
    return target;
  }

  private async persist(task: InternalTask): Promise<void> {
    const filePath = path.join(this.taskRunDir(task.appId, task.runId), 'run.json');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(toSummary(task), null, 2), 'utf8');
  }

  private emit(task: InternalTask): void {
    this.options.onTaskUpdated({ task: toSummary(task) });
  }

  private createActivityForTask(task: InternalTask) {
    return createAgentRunActivity({
      runId: task.runId,
      surface: 'app_prompt_task',
      status: normalizeActivityStatus(task.status),
      startedAt: task.createdAt,
      updatedAt: task.updatedAt,
      sourceRef: {
        appId: task.appId,
        taskId: task.templateId,
        title: task.templateId,
      },
    });
  }

  private updateActivityForTask(task: InternalTask, status: AgentRunActivityStatus, error?: string): void {
    const base = task.activity ?? this.createActivityForTask(task);
    task.activity = status === 'completed' || status === 'failed' || status === 'canceled'
      ? finalizeAgentRunActivity(base, status, task.updatedAt, error)
      : {
          ...base,
          status,
          updatedAt: task.updatedAt,
        };
    void persistAgentRunActivity(this.options.metadataRoot, task.activity);
  }
}

const toSummary = (task: InternalTask): AppCodexTaskSummary => ({
  runId: task.runId,
  appId: task.appId,
  templateId: task.templateId,
  status: task.status,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  resultText: task.resultText,
  error: task.error,
  errorDetails: task.errorDetails,
  progressLog: task.progressLog,
  activity: task.activity,
  permissionRequest: task.permissionRequest,
});

const sanitizeId = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, 120) : '';
