import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppCodexConversation,
  AppCodexConversationCreateInput,
  AppCodexConversationEvent,
  AppCodexConversationMessage,
  AppCodexConversationRun,
  AppCodexConversationSendMessageInput,
  AppCodexConversationRunStatus,
  CodexReasoningEffort,
} from '../shared/types';

interface CodexMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

interface AppCodexConversationManagerOptions {
  privateAppsRoot: string;
  metadataRoot: string;
  codexHome: string;
  getCodexCliPath: () => Promise<string | null>;
  getCodexPathEntries: (appId?: string) => Promise<string[]>;
  getCodexEnvironment: (appId?: string) => Promise<Record<string, string>>;
  getCodexAuthenticated: () => Promise<boolean>;
  hasCodexConversation: (appId: string) => Promise<boolean>;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<CodexMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  onConversationEvent: (event: AppCodexConversationEvent) => void;
}

interface InternalConversation extends AppCodexConversation {
  threadId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

interface InternalRun extends AppCodexConversationRun {
  appId: string;
  conversationId: string;
  child?: ChildProcessWithoutNullStreams;
  attachmentPaths?: string[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_MODEL = 'gpt-5.3-codex';
const DEFAULT_REASONING: CodexReasoningEffort = 'low';
const MAX_CONTEXT_CHARS = 40_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const CODEX_CONVERSATION_RUN_TIMEOUT_MS = 600_000;

export class AppCodexConversationManager {
  private readonly conversations = new Map<string, InternalConversation>();
  private readonly runs = new Map<string, InternalRun>();
  private loadPromise: Promise<void> | null = null;

  public constructor(private readonly options: AppCodexConversationManagerOptions) {}

  public async create(appId: string, input: AppCodexConversationCreateInput = {}): Promise<AppCodexConversation> {
    await this.assertEnabled(appId);
    await this.load();
    const now = new Date().toISOString();
    const conversation: InternalConversation = {
      conversationId: randomUUID(),
      appId,
      title: sanitizeTitle(input.title) || 'Conversacion',
      createdAt: now,
      updatedAt: now,
      messages: [],
      threadId: null,
      metadata: normalizeMetadata(input.metadata),
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
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      progressLog: [],
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
      void this.failRun(runId, error instanceof Error ? error.message : 'codex_conversation_failed');
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

  private async execute(conversationId: string, runId: string, input: AppCodexConversationSendMessageInput): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    const run = this.runs.get(runId);
    if (!conversation || !run) {
      return;
    }
    const appRoot = path.join(this.options.privateAppsRoot, conversation.appId);
    if (!(await existsDirectory(appRoot))) {
      throw new Error('app_not_installed');
    }
    if (!(await this.options.getCodexAuthenticated())) {
      throw new Error('codex_auth_missing');
    }
    const codexCliPath = await this.options.getCodexCliPath();
    if (!codexCliPath) {
      throw new Error('codex_cli_missing');
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

    let mcpServers: CodexMcpServerConfig[] = [];
    try {
      const command = await resolveCodexCommand(codexCliPath, await this.options.getCodexPathEntries(conversation.appId));
      const environment = await this.options.getCodexEnvironment(conversation.appId);
      mcpServers = await (this.options.listenAppMcps?.([conversation.appId], run.runId) ?? Promise.resolve([]));
      const mcpArgs = buildMcpArgs(mcpServers);
      const model = input.model?.trim() || DEFAULT_MODEL;
      const reasoningEffort = input.reasoningEffort ?? DEFAULT_REASONING;
      const prompt = buildPrompt(input.message, input.context);
      const attachmentPaths = await this.prepareAttachments(conversation.appId, run, input);
      const imageArgs = attachmentPaths.flatMap((filePath) => ['--image', filePath]);
      const args = conversation.threadId
        ? [
            ...command.prefixArgs,
            'exec',
            'resume',
            '--json',
            '--model',
            model,
            '--config',
            `reasoning_effort="${reasoningEffort}"`,
            ...mcpArgs,
            '--skip-git-repo-check',
            ...imageArgs,
            conversation.threadId,
            prompt,
          ]
        : [
            ...command.prefixArgs,
            ...(mcpServers.length > 0 ? ['--ask-for-approval', 'never'] : []),
            'exec',
            '--json',
            '--model',
            model,
            '--config',
            `reasoning_effort="${reasoningEffort}"`,
            '--full-auto',
            '--sandbox',
            'workspace-write',
            '--skip-git-repo-check',
            ...mcpArgs,
            '-C',
            appRoot,
            ...imageArgs,
            prompt,
          ];

      const result = await runCommandCapture(command.command, args, {
        cwd: appRoot,
        env: {
          CODEX_HOME: this.options.codexHome,
          FORGER_ALLOWED_ROOTS: appRoot,
          ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
          ...environment,
          PATH: [...command.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
        },
        timeoutMs: CODEX_CONVERSATION_RUN_TIMEOUT_MS,
        onChild: (child) => {
          run.child = child;
        },
        onStdout: (text) => this.handleOutput(conversation, run, text),
        onStderr: (text) => this.handleOutput(conversation, run, text),
      });

      if (this.runs.get(run.runId)?.status === 'canceled') {
        return;
      }
      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || 'codex_conversation_exec_failed').trim());
      }

      const parsed = parseCodexJsonl(result.stdout, result.stderr);
      if (parsed.threadId) {
        conversation.threadId = parsed.threadId;
      }
      const assistantText = parsed.assistantText || 'Listo.';
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

  private handleOutput(conversation: InternalConversation, run: InternalRun, text: string): void {
    const progress = progressFromCodexOutput(text);
    if (!progress) {
      return;
    }
    run.progressLog = [...(run.progressLog ?? []), progress].slice(-40);
    run.updatedAt = new Date().toISOString();
    conversation.activeRun = toRun(run);
    conversation.updatedAt = run.updatedAt;
    void this.persistApp(conversation.appId);
    this.options.onConversationEvent({
      type: 'run.progress',
      conversation: toConversation(conversation),
      run: toRun(run),
      progress,
    });
  }

  private async failRun(runId: string, message: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status === 'canceled') {
      return;
    }
    const conversation = this.conversations.get(run.conversationId);
    if (!conversation) {
      return;
    }
    run.status = 'failed';
    run.error = message;
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

  private async assertEnabled(appId: string): Promise<void> {
    if (!(await this.options.hasCodexConversation(appId))) {
      throw new Error('app_codex_conversation_not_declared');
    }
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
        for (const conversation of parsed.conversations ?? []) {
          if (conversation?.conversationId && conversation.appId) {
            this.conversations.set(conversation.conversationId, {
              ...conversation,
              activeRun: conversation.activeRun && isTerminalRunStatus(conversation.activeRun.status)
                ? conversation.activeRun
                : undefined,
            });
          }
        }
      } catch {
        continue;
      }
    }
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
}

const buildPrompt = (message: string, context: string | undefined): string => {
  const trimmedContext = (context ?? '').trim().slice(0, MAX_CONTEXT_CHARS);
  if (!trimmedContext) {
    return message.trim();
  }
  return [
    'Contexto actual de la app:',
    trimmedContext,
    '',
    'Mensaje del usuario:',
    message.trim(),
    '',
    'Usa las herramientas MCP de la app cuando necesites modificar su estado. Responde breve para mostrar el resultado dentro de la app.',
  ].join('\n');
};

const toConversation = (conversation: InternalConversation): AppCodexConversation => ({
  conversationId: conversation.conversationId,
  appId: conversation.appId,
  title: conversation.title,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  messages: conversation.messages,
  ...(conversation.activeRun ? { activeRun: conversation.activeRun } : {}),
});

const toRun = (run: AppCodexConversationRun): AppCodexConversationRun => ({
  runId: run.runId,
  status: run.status,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  ...(run.error ? { error: run.error } : {}),
  ...(run.progressLog ? { progressLog: run.progressLog } : {}),
});

const isTerminalRunStatus = (status: AppCodexConversationRunStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'canceled';

const sanitizeId = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'app';

const extensionForMimeType = (mimeType: string): string => {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
    return 'jpg';
  }
  if (mimeType.includes('webp')) {
    return 'webp';
  }
  if (mimeType.includes('svg')) {
    return 'svg';
  }
  return 'png';
};

const sanitizeTitle = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : '';

const normalizeMetadata = (value: unknown): Record<string, string | number | boolean | null> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) {
      output[key] = item;
    }
  }
  return output;
};

const parseCodexJsonl = (stdout: string, stderr: string): { assistantText: string; threadId?: string } => {
  const raw = stdout.trim() || stderr.trim();
  let assistantText = '';
  let threadId: string | undefined;
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
        threadId = parsed.thread_id;
      }
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
  return { assistantText: assistantText.trim(), threadId };
};

const progressFromCodexOutput = (text: string): string | null => {
  for (const line of text.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'turn.started') {
        return 'Codex esta trabajando en el canvas.';
      }
      if (parsed.type === 'item.completed' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          const compact = stripMarkdown(item.text).replace(/\s+/g, ' ').trim();
          return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
        }
        if (String(item.type ?? '').includes('tool') || item.type === 'command_execution') {
          return 'Codex esta usando herramientas de Studio.';
        }
      }
      if (parsed.type === 'item.started' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (String(item.type ?? '').includes('tool') || item.type === 'command_execution') {
          return 'Codex esta usando herramientas de Studio.';
        }
      }
    } catch {
      continue;
    }
  }
  return null;
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
    let timeout: NodeJS.Timeout | null = null;
    const clearCommandTimeout = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
    const refreshCommandTimeout = (): void => {
      if (!options.timeoutMs || settled) {
        return;
      }
      clearCommandTimeout();
      timeout = setTimeout(() => {
          killProcessTree(child);
          if (!settled) {
            settled = true;
            reject(new Error(`codex_timeout_after_${options.timeoutMs}ms`));
          }
        }, options.timeoutMs);
    };
    refreshCommandTimeout();

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
      refreshCommandTimeout();
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
      refreshCommandTimeout();
    });
    child.on('error', (error) => {
      clearCommandTimeout();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code) => {
      clearCommandTimeout();
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
