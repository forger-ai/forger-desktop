import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppCodexTaskAttachment,
  AppCodexTaskEvent,
  AppCodexTaskStartInput,
  AppCodexTaskSummary,
  AppPromptTemplate,
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
  onTaskUpdated: (event: AppCodexTaskEvent) => void;
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

    const attachments = await this.writeAttachments(task, input.attachments ?? []);
    const imageArgs = attachments
      .filter((attachment) => attachment.mimeType?.toLowerCase().startsWith('image/'))
      .flatMap((attachment) => ['--image', attachment.path]);
    const prompt = renderPrompt(template.prompt, input.variables ?? {}, attachments);
    const command = await resolveCodexCommand(codexCliPath, await this.options.getCodexPathEntries(task.appId));
    const environment = await this.options.getCodexEnvironment(task.appId);
    const args = [
      ...command.prefixArgs,
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

  private async writeAttachments(
    task: InternalTask,
    attachments: AppCodexTaskAttachment[],
  ): Promise<Array<{ name: string; path: string; mimeType?: string }>> {
    const targetDir = path.join(task.appRoot, '.forger', 'codex-task-inputs', task.runId);
    await fs.mkdir(targetDir, { recursive: true });
    const written: Array<{ name: string; path: string; mimeType?: string }> = [];
    for (const [index, attachment] of attachments.entries()) {
      const safeName = sanitizeFilename(attachment.name || `attachment-${index + 1}`);
      const bytes = Buffer.from(attachment.dataBase64, 'base64');
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new Error('attachment_too_large');
      }
      const filePath = path.join(targetDir, safeName);
      await fs.writeFile(filePath, bytes);
      written.push({ name: safeName, path: filePath, mimeType: attachment.mimeType });
    }
    return written;
  }

  private addProgress(task: InternalTask, message: string): void {
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
  value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 160) || 'attachment';

const renderPrompt = (
  template: string,
  variables: Record<string, string | number | boolean | null>,
  attachments: Array<{ name: string; path: string; mimeType?: string }>,
): string => {
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value == null ? '' : String(value));
  }
  const attachmentLines = attachments.length
    ? attachments.map((file) => `- ${file.name}: ${file.path}${file.mimeType ? ` (${file.mimeType})` : ''}`)
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
        if (typeof item.type === 'string' && item.type.includes('tool')) {
          return 'Codex uso herramientas de la app.';
        }
        if (item.type === 'agent_message') {
          return 'Codex preparo un resultado.';
        }
      }
    } catch {
      continue;
    }
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
