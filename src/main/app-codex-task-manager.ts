import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppCodexTaskAttachment,
  AppCodexTaskEvent,
  AppCodexTaskFileArgument,
  AppCodexTaskStartInput,
  AppCodexTaskSummary,
  AppPromptTemplate,
  AppPromptTemplateArgument,
} from '../shared/types';

interface AppCodexTaskManagerOptions {
  privateAppsRoot: string;
  metadataRoot: string;
  codexHome: string;
  getCodexCliPath: () => Promise<string | null>;
  getCodexPathEntries: (appId?: string) => Promise<string[]>;
  getCodexEnvironment: (appId?: string) => Promise<Record<string, string>>;
  getCodexAuthenticated: () => Promise<boolean>;
  resolvePromptTemplates: (appId: string) => Promise<AppPromptTemplate[]>;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<CodexMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  onTaskUpdated: (event: AppCodexTaskEvent) => void;
}

interface CodexMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

interface InternalTask extends AppCodexTaskSummary {
  appRoot: string;
  transcriptPath: string;
  child?: ChildProcessWithoutNullStreams;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PreparedFileArgument {
  argumentName: string;
  name: string;
  path: string;
  mimeType?: string;
}

interface PreparedPromptArguments {
  variables: Record<string, string | number | boolean | null>;
  files: PreparedFileArgument[];
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class AppCodexTaskManager {
  private readonly tasks = new Map<string, InternalTask>();

  public constructor(private readonly options: AppCodexTaskManagerOptions) {}

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
      void this.failTask(task, error instanceof Error ? error.message : 'app_codex_task_failed');
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
    task.status = 'canceled';
    task.updatedAt = new Date().toISOString();
    task.error = 'canceled';
    void this.persist(task);
    void this.cleanupTaskInputs(task);
    this.emit(task);
    return { success: true };
  }

  private async execute(
    task: InternalTask,
    template: AppPromptTemplate,
    input: AppCodexTaskStartInput,
  ): Promise<void> {
    if (!(await this.options.getCodexAuthenticated())) {
      throw new Error('codex_auth_missing');
    }
    const codexCliPath = await this.options.getCodexCliPath();
    if (!codexCliPath) {
      throw new Error('codex_cli_missing');
    }

    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    this.addProgress(task, 'Codex esta preparando el analisis.');
    await this.persist(task);
    this.emit(task);

    try {
      const preparedArguments = await this.preparePromptArguments(task, template, input);
      const imageArgs = preparedArguments.files
        .filter((file) => file.mimeType?.toLowerCase().startsWith('image/'))
        .flatMap((file) => ['--image', file.path]);
      const prompt = renderPrompt(template.prompt, preparedArguments);
      const command = await resolveCodexCommand(codexCliPath, await this.options.getCodexPathEntries(task.appId));
      const environment = await this.options.getCodexEnvironment(task.appId);
      const mcpServers = await (this.options.listenAppMcps?.([task.appId], task.runId) ?? Promise.resolve([]));
      const mcpArgs = buildMcpArgs(mcpServers);
      const topLevelArgs = mcpServers.length > 0 ? ['--ask-for-approval', 'never'] : [];
      const args = [
        ...command.prefixArgs,
        ...topLevelArgs,
        'exec',
        '--json',
        '--model',
        'gpt-5.3-codex',
        '--config',
        'reasoning_effort="low"',
        '--full-auto',
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        ...mcpArgs,
        '-C',
        task.appRoot,
        ...imageArgs,
        prompt,
      ];

      await appendTranscript(task.transcriptPath, 'meta', `${command.command} exec --json -C ${task.appRoot}`);
      const result = await runCommandCapture(command.command, args, {
        cwd: task.appRoot,
        env: {
          CODEX_HOME: this.options.codexHome,
          FORGER_ALLOWED_ROOTS: task.appRoot,
          ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
          ...environment,
          PATH: [...command.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
        },
        timeoutMs: 300_000,
        onChild: (child) => {
          task.child = child;
        },
        onStdout: (text) => {
          void appendTranscript(task.transcriptPath, 'stdout', text);
          this.updateProgressFromOutput(task, text);
        },
        onStderr: (text) => {
          void appendTranscript(task.transcriptPath, 'stderr', text);
          this.updateProgressFromOutput(task, text);
        },
      });

      if ((task as AppCodexTaskSummary).status === 'canceled') {
        return;
      }
      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || 'codex_exec_failed').trim());
      }

      const parsed = parseCodexJsonl(result.stdout, result.stderr);
      task.status = 'completed';
      task.updatedAt = new Date().toISOString();
      task.resultText = parsed || 'Codex completo la tarea.';
      this.addProgress(task, 'Codex termino la tarea.');
      await this.persist(task);
      this.emit(task);
    } finally {
      this.options.releaseAppMcps?.(task.runId);
      await this.cleanupTaskInputs(task).catch(() => undefined);
    }
  }

  private async failTask(task: InternalTask, message: string): Promise<void> {
    if (task.status === 'canceled') {
      return;
    }
    task.status = 'failed';
    task.updatedAt = new Date().toISOString();
    task.error = message;
    await appendTranscript(task.transcriptPath, 'meta', `Run failed: ${message}`);
    await this.persist(task);
    this.emit(task);
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

  private updateProgressFromOutput(task: InternalTask, text: string): void {
    const message = progressFromCodexOutput(text);
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
  progressLog: task.progressLog,
});

const sanitizeId = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, 120) : '';

const sanitizeFilename = (value: string): string =>
  sanitizeDotFilename(value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 160));

const sanitizeDotFilename = (value: string): string => {
  const sanitized = value.trim() || 'attachment';
  return sanitized === '.' || sanitized === '..' ? 'attachment' : sanitized;
};

const uniqueFilename = (safeName: string, usedNames: Set<string>): string => {
  if (!usedNames.has(safeName)) {
    usedNames.add(safeName);
    return safeName;
  }
  const parsed = path.parse(safeName);
  for (let index = 2; ; index += 1) {
    const candidate = `${parsed.name}-${index}${parsed.ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
};

const normalizeMimeType = (value: string | undefined): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const isCodexFileArgument = (value: unknown): value is AppCodexTaskFileArgument =>
  Boolean(
    value
      && typeof value === 'object'
      && (value as AppCodexTaskFileArgument).type === 'file'
      && typeof (value as AppCodexTaskFileArgument).dataBase64 === 'string',
  );

const validateAttachmentType = (
  template: AppPromptTemplate,
  attachment: AppCodexTaskAttachment,
  safeName: string,
): void => {
  const accepted = template.acceptedFileTypes?.map((entry) => entry.trim().toLowerCase()).filter(Boolean) ?? [];
  if (accepted.length === 0) {
    return;
  }

  const mimeType = normalizeMimeType(attachment.mimeType);
  const fileName = safeName.toLowerCase();
  const matchesAcceptedType = accepted.some((entry) => {
    if (entry.endsWith('/*')) {
      return mimeType.startsWith(entry.slice(0, -1));
    }
    if (entry.startsWith('.')) {
      return fileName.endsWith(entry);
    }
    return mimeType === entry;
  });

  if (!matchesAcceptedType) {
    throw new Error('attachment_type_not_accepted');
  }
};

const validateFileArgumentType = (
  argument: AppPromptTemplateArgument,
  file: AppCodexTaskFileArgument,
  safeName: string,
): void => {
  const accepted = argument.acceptedFileTypes?.map((entry) => entry.trim().toLowerCase()).filter(Boolean) ?? [];
  if (accepted.length === 0) {
    return;
  }

  const mimeType = normalizeMimeType(file.mimeType);
  const fileName = safeName.toLowerCase();
  const matchesAcceptedType = accepted.some((entry) => {
    if (entry.endsWith('/*')) {
      return mimeType.startsWith(entry.slice(0, -1));
    }
    if (entry.startsWith('.')) {
      return fileName.endsWith(entry);
    }
    return mimeType === entry;
  });

  if (!matchesAcceptedType) {
    throw new Error(`app_prompt_file_type_not_accepted:${argument.name}`);
  }
};

const normalizeStringArgument = (argument: AppPromptTemplateArgument, value: unknown): string => {
  const text =
    value && typeof value === 'object' && (value as { type?: unknown }).type === 'string'
      ? (value as { value?: unknown }).value
      : value;
  if (typeof text !== 'string' && typeof text !== 'number' && typeof text !== 'boolean') {
    throw new Error(`app_prompt_argument_invalid:${argument.name}`);
  }
  const normalized = String(text);
  if (argument.maxLength && normalized.length > argument.maxLength) {
    throw new Error(`app_prompt_string_too_long:${argument.name}`);
  }
  return normalized;
};

const normalizeFileArgumentValue = (
  argument: AppPromptTemplateArgument,
  value: unknown,
): AppCodexTaskFileArgument[] => {
  const values = Array.isArray(value) ? value : [value];
  if (!argument.multiple && values.length > 1) {
    throw new Error(`app_prompt_argument_multiple_not_allowed:${argument.name}`);
  }
  if (!values.every(isCodexFileArgument)) {
    throw new Error(`app_prompt_argument_invalid:${argument.name}`);
  }
  return values;
};

const buildLegacyPromptVariables = (
  variables: Record<string, string | number | boolean | null>,
  files: PreparedFileArgument[],
): Record<string, string | number | boolean | null> => {
  if (files.length !== 1) {
    return variables;
  }
  return {
    ...variables,
    filename: files[0].path,
  };
};

const formatFileArgumentForPrompt = (files: PreparedFileArgument[]): string => {
  if (files.length === 0) {
    return '';
  }
  if (files.length === 1) {
    return files[0].path;
  }
  return files.map((file) => `- ${file.name}: ${file.path}`).join('\n');
};

const renderPrompt = (
  template: string,
  preparedArguments: PreparedPromptArguments,
): string => {
  let rendered = template;
  for (const [key, value] of Object.entries(preparedArguments.variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value == null ? '' : String(value));
  }
  const attachmentLines = preparedArguments.files.length
    ? preparedArguments.files.map((file) => `- ${file.argumentName}.${file.name}: ${file.path}${file.mimeType ? ` (${file.mimeType})` : ''}`)
    : ['- No se adjuntaron archivos.'];
  return [
    rendered.trim(),
    '',
    'ARCHIVOS COMPARTIDOS POR EL USUARIO:',
    ...attachmentLines,
    '',
    'Responde con un resumen final breve en texto para mostrarlo dentro de la app.',
  ].join('\n');
};

const appendTranscript = async (
  transcriptPath: string,
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.appendFile(transcriptPath, `[${new Date().toISOString()}] [${stream}] ${text}\n`, 'utf8');
};

const parseCodexJsonl = (stdout: string, stderr: string): string => {
  const raw = stdout.trim() || stderr.trim();
  let assistantText = '';
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'item.completed' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          assistantText = item.text.trim();
        }
      }
    } catch {
      assistantText = assistantText ? `${assistantText}\n${line}` : line;
    }
  }
  return assistantText.trim();
};

const progressFromCodexOutput = (text: string): string | null => {
  for (const line of text.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'turn.started') {
        return 'Codex esta trabajando en el documento.';
      }
      if (parsed.type === 'item.completed' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (item.type === 'command_execution') {
          return progressFromCommandExecution(item);
        }
        if (item.type === 'agent_message') {
          return progressFromAgentMessage(item);
        }
      }
      if (parsed.type === 'item.started' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (item.type === 'command_execution') {
          return progressFromCommandExecution(item);
        }
      }
    } catch {
      continue;
    }
  }
  return null;
};

const progressFromAgentMessage = (item: Record<string, unknown>): string | null => {
  if (typeof item.text !== 'string') {
    return null;
  }
  const firstSentence = stripMarkdown(item.text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)[0]
    .trim();
  if (!firstSentence) {
    return null;
  }
  return firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}...` : firstSentence;
};

const stripMarkdown = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[\s*-]*[-*+]\s+/gm, '')
    .replace(/^[\s\d.]+[.)]\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .trim();

const progressFromCommandExecution = (item: Record<string, unknown>): string | null => {
  const command = typeof item.command === 'string' ? item.command : '';
  const status = typeof item.status === 'string' ? item.status : '';
  const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
  if (status === 'failed' || (exitCode !== null && exitCode !== 0)) {
    return 'Codex encontro una limitacion tecnica y esta probando otra estrategia.';
  }
  if (command.includes('list_categories.py')) {
    return 'Revisando categorias disponibles para clasificar.';
  }
  if (command.includes('import_movements.py')) {
    return 'Cargando movimientos en la base local.';
  }
  if (command.includes('verify_data_integrity.py') || command.includes('scripts/verify.py')) {
    return 'Validando que los datos queden consistentes.';
  }
  if (command.includes('list_movements.py')) {
    return 'Confirmando los movimientos cargados.';
  }
  if (command.includes('pdftotext') || command.includes('PdfReader') || command.includes('.pdf')) {
    return 'Leyendo el contenido del documento.';
  }
  if (command.includes('skills/load-movements') || command.includes('AGENTS.md')) {
    return 'Revisando las instrucciones internas de Finance OS.';
  }
  if (command) {
    return 'Usando herramientas internas de Finance OS.';
  }
  return null;
};

const runCommandCapture = async (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onChild?: (child: ChildProcessWithoutNullStreams) => void;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
  },
): Promise<CommandResult> =>
  await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    options.onChild?.(child);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          killProcessTree(child);
          if (!settled) {
            settled = true;
            reject(new Error(`codex_timeout_after_${options.timeoutMs}ms`));
          }
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('exit', (code) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      }
    });
  });

const killProcessTree = (child: ChildProcessWithoutNullStreams | undefined): void => {
  if (!child || child.killed) {
    return;
  }
  try {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
};

const buildMcpArgs = (mcpServers: CodexMcpServerConfig[]): string[] =>
  mcpServers.flatMap((server) => [
    '--config',
    `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`,
    '--config',
    `mcp_servers.${server.name}.bearer_token_env_var=${JSON.stringify(server.tokenEnvVar)}`,
    '--config',
    `mcp_servers.${server.name}.enabled=true`,
    '--config',
    `mcp_servers.${server.name}.tool_timeout_sec=${server.toolTimeoutSec ?? 600}`,
    '--config',
    `mcp_servers.${server.name}.default_tools_approval_mode="approve"`,
  ]);

const resolveCodexCommand = async (
  codexCliPath: string,
  pathEntries: string[],
): Promise<{ command: string; prefixArgs: string[]; pathEntries: string[] }> => {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(codexCliPath)) {
    return {
      command: codexCliPath,
      prefixArgs: [],
      pathEntries: [path.dirname(codexCliPath), ...pathEntries],
    };
  }
  const nodePath = await findExecutableInPathEntries(pathEntries, ['node.exe', 'node']);
  const codexEntrypoint = path.join(path.resolve(path.dirname(codexCliPath), '..'), '@openai', 'codex', 'bin', 'codex.js');
  if (!nodePath || !(await existsFile(codexEntrypoint))) {
    throw new Error('codex_js_entrypoint_missing');
  }
  return {
    command: nodePath,
    prefixArgs: [codexEntrypoint],
    pathEntries: [path.dirname(nodePath), path.dirname(codexCliPath), ...pathEntries],
  };
};

const findExecutableInPathEntries = async (entries: string[], executableNames: string[]): Promise<string | null> => {
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

const existsFile = async (filePath: string): Promise<boolean> => {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const existsDirectory = async (dirPath: string): Promise<boolean> => {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
};

const isPathInside = (target: string, root: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
