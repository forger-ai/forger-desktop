import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppCodexTaskAttachment,
  AppCodexTaskEvent,
  AppCodexTaskStartInput,
  AppCodexTaskSummary,
  AppPromptTemplate,
  AppPromptTemplateArgument,
  AgentRuntime,
  AgentRuntimeRequest,
  ClaudeEffort,
  CodexReasoningEffort,
  PermissionRequest,
} from '../shared/types';
import {
  createIsolatedCodexHome,
  removeIsolatedCodexHome,
} from './codex-run-isolation';
import {
  existsDirectory,
  isPathInside,
  killProcessTree,
  runCommandCapture,
} from './app-agent/process';
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
import { antigravityCliAdapter } from './llm-provider/adapters/antigravity-cli-adapter';
import { claudeCliAdapter } from './llm-provider/adapters/claude-cli-adapter';
import { codexCliAdapter, parseCodexJsonl } from './llm-provider/adapters/codex-cli-adapter';

interface AppAgentTaskManagerOptions {
  privateAppsRoot: string;
  metadataRoot: string;
  codexHome: string;
  getAgentRuntime: (requested?: AgentRuntimeRequest) => Promise<AgentRuntime>;
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
  canRequestPermission?: (appId: string) => boolean;
  onTaskUpdated: (event: AppCodexTaskEvent) => void;
}

interface InternalTask extends AppCodexTaskSummary {
  appRoot: string;
  transcriptPath: string;
  child?: ChildProcessWithoutNullStreams;
}

const taskFailureFromError = (error: unknown): Pick<AppCodexTaskSummary, 'error' | 'errorDetails'> => {
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

  return {
    error: error instanceof Error ? error.message : 'app_codex_task_failed',
  };
};

interface PendingPermission {
  runId: string;
  requestId: string;
  resolve: (decision: 'allow' | 'deny') => void;
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const CODEX_TASK_TIMEOUT_MS = 600_000;
const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_REASONING: CodexReasoningEffort = 'medium';

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
      appRoot,
      transcriptPath: path.join(runDir, 'transcript.log'),
    };
    this.tasks.set(runId, task);
    await this.persist(task);
    this.emit(task);

    void this.execute(task, template, input).catch((error) => {
      const failure = taskFailureFromError(error);
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
    await this.persist(task);
    this.emit(task);

    const decision = await new Promise<'allow' | 'deny'>((resolve) => {
      this.pendingPermissions.set(request.requestId, { runId, requestId: request.requestId, resolve });
    });

    if (this.tasks.get(runId)?.permissionRequest?.requestId === request.requestId) {
      task.permissionRequest = undefined;
      task.status = task.status === 'needs_permission' ? 'running' : task.status;
      task.updatedAt = new Date().toISOString();
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
    const runtime = await this.options.getAgentRuntime(template.runtime ?? {
      recommendations: template.runtimeRecommendations,
      model: template.runtimeRecommendations ? undefined : template.model,
      effort: template.runtimeRecommendations ? undefined : template.reasoningEffort,
    });
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

    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    this.addProgress(task, taskMessage(locale, 'preparing'));
    await this.persist(task);
    this.emit(task);

    let forgerMcpSession: { url: string; token: string } | null = null;
    const temporaryCodexHomes: string[] = [];
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
      const model = runtime.model || DEFAULT_MODEL;
      const reasoningEffort = runtime.provider === 'codex' ? runtime.effort as CodexReasoningEffort : DEFAULT_REASONING;
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
      const providerCommand = runtime.provider === 'codex'
        ? codexCliPath as string
        : runtime.provider === 'claude'
          ? claudeCliPath as string
          : antigravityCliPath as string;
      const onOutput = (stream: 'stdout' | 'stderr' | 'meta', text: string): void => {
        void appendTranscript(task.transcriptPath, stream, text);
        this.updateProgressFromOutput(task, text, locale);
      };
      const runCodexTask = async (codexHome: string) =>
        await codexCliAdapter.runTask({
          cliPath: codexCliPath as string,
          pathEntries,
          environment,
          mcpServers,
          workingDir: task.appRoot,
          prompt,
          model,
          reasoningEffort,
          permissionMode: runtime.permissionMode,
          networkAccess,
          timeoutMs: CODEX_TASK_TIMEOUT_MS,
          codexHome,
          imagePaths,
          onChild: (child) => {
            task.child = child;
          },
          onOutput,
          runCommandCapture,
        });

      await appendTranscript(task.transcriptPath, 'meta', `${runtime.provider} ${providerCommand}`);
      const isolatedCodexHome = runtime.provider === 'codex'
        ? await createIsolatedCodexHome(this.options.codexHome, {
            prefix: 'forger-task-codex-home',
            trustedRoots: [task.appRoot],
            networkAccess,
          })
        : '';
      if (isolatedCodexHome) {
        temporaryCodexHomes.push(isolatedCodexHome);
      }
      const antigravityResult = runtime.provider === 'antigravity'
        ? await antigravityCliAdapter.run({
            runId: task.runId,
            cliPath: antigravityCliPath as string,
            pathEntries: [path.dirname(antigravityCliPath as string), ...pathEntries],
            environment,
            mcpServers,
            workingDir: task.appRoot,
            configWorkspaceRoot: task.appRoot,
            sharedRoots: [],
            prompt,
            model,
            permissionMode: runtime.permissionMode,
            timeoutMs: CODEX_TASK_TIMEOUT_MS,
            timeoutMode: 'absolute',
            onChild: (child) => {
              task.child = child;
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
            workingDir: task.appRoot,
            prompt,
            model,
            effort: runtime.effort as ClaudeEffort,
            permissionMode: runtime.permissionMode,
            timeoutMs: CODEX_TASK_TIMEOUT_MS,
            imagePaths,
            alwaysIncludeMcpConfig: true,
            onChild: (child) => {
              task.child = child;
            },
            onOutput,
            runCommandCapture,
          })
        : null;
      let result = runtime.provider === 'antigravity'
        ? { code: 0, stdout: antigravityResult?.stdout ?? '', stderr: antigravityResult?.stderr ?? '', assistantText: antigravityResult?.assistantText ?? '' }
        : runtime.provider === 'claude'
          ? { code: 0, stdout: claudeResult?.stdout ?? '', stderr: claudeResult?.stderr ?? '', assistantText: claudeResult?.assistantText ?? '' }
          : await runCodexTask(isolatedCodexHome);
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
          const cleanCodexHome = await createIsolatedCodexHome(this.options.codexHome, {
            prefix: 'forger-task-codex-home',
            trustedRoots: [task.appRoot],
            networkAccess,
          });
          temporaryCodexHomes.push(cleanCodexHome);
          await appendTranscript(task.transcriptPath, 'meta', 'Retrying Codex task with a clean temporary Codex home.');
          result = await runCodexTask(cleanCodexHome);
          if ((task as AppCodexTaskSummary).status === 'canceled') return;
        }
      }
      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || 'codex_exec_failed').trim());
      }
      task.status = 'completed';
      task.updatedAt = new Date().toISOString();
      task.resultText = result.assistantText || taskMessage(locale, 'completed');
      this.addProgress(task, taskMessage(locale, 'finished'));
      await this.cleanupTaskInputs(task).catch(() => undefined);
      if (forgerMcpSession) {
        this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
        forgerMcpSession = null;
      }
      this.options.releaseAppMcps?.(task.runId);
      appMcpsReleased = true;
      await Promise.all(temporaryCodexHomes.map((dirPath) => removeIsolatedCodexHome(dirPath)));
      temporaryCodexHomes.splice(0);
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
      await Promise.all(temporaryCodexHomes.map((dirPath) => removeIsolatedCodexHome(dirPath)));
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
  }

  private updateProgressFromOutput(task: InternalTask, text: string, locale: TaskLocale): void {
    const message = progressFromCodexOutput(text, locale);
    if (!message) {
      return;
    }
    this.addProgress(task, message);
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
  permissionRequest: task.permissionRequest,
});

const sanitizeId = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, 120) : '';
