import { createHash } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnProcess } from '../runtime/process-spawn';
import type { AgentPermissionMode, ChatErrorCode, ClaudeEffort, CodexReasoningEffort, PreviewDiffFile } from '../../shared/types';
import { antigravityCliAdapter } from '../llm-provider/adapters/antigravity-cli-adapter';
import { codexCliAdapter, type LlmTokenUsage } from '../llm-provider/adapters/codex-cli-adapter';
import { claudeCliAdapter } from '../llm-provider/adapters/claude-cli-adapter';
import type { LlmCommandResult, LlmMcpServerConfig as ProviderMcpServerConfig } from '../llm-provider/types';

export type LlmMcpServerConfig = ProviderMcpServerConfig;
export type { LlmTokenUsage };

/** @deprecated Use LlmMcpServerConfig. */
export type CodexMcpServerConfig = LlmMcpServerConfig;

interface PluginManifestV1 {
  id: string;
  version: string;
  permissions: string[];
  safeCommands: string[];
  signature: string;
  sha256: string;
}

export function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'item';
}

export interface ChatHistoryMessage {
  role: 'assistant' | 'user';
  content: string;
}

export type ForgerTaskType =
  | 'chat';

type LlmChatCommandResult = LlmCommandResult & { code: number };

/** @deprecated Use LlmTokenUsage. */
export type CodexUsage = LlmTokenUsage;

export interface LlmProviderRunResult {
  assistantText: string;
  threadId?: string;
  usageDelta?: Partial<LlmTokenUsage>;
  toolEvents: number;
}

/** @deprecated Use LlmProviderRunResult. */
export type CodexRunResult = LlmProviderRunResult;

export class AuditLogger {
  public constructor(private readonly privateAppsRoot: string) {}

  public async log(event: Record<string, unknown>): Promise<void> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const dir = path.join(this.privateAppsRoot, '.forger', 'audit');
    try {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${day}.log`);
      await fs.appendFile(filePath, `${JSON.stringify({ ts: now.toISOString(), ...event })}\n`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

export class PermissionBroker {
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
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  private async safeRealPath(input: string): Promise<string> {
    const normalized = path.normalize(input);
    const real = await fs.realpath(normalized).catch(async () => {
      const parent = path.dirname(normalized);
      const parentReal = await fs.realpath(parent);
      return path.join(parentReal, path.basename(normalized));
    });

    return real;
  }

  private createError(code: ChatErrorCode, message: string): Error {
    const error = new Error(message);
    (error as Error & { chatCode?: ChatErrorCode }).chatCode = code;
    return error;
  }
}

export class PluginRuntime {
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

export class SandboxRunner {
  public constructor(private readonly codexHome: string) {}

  public async resolveCodexCommand(params: {
    codexCliPath: string;
    pathEntries: string[];
  }): Promise<{ command: string; prefixArgs: string[]; pathEntries: string[] }> {
    return await codexCliAdapter.resolveCommand(params.codexCliPath, params.pathEntries);
  }

  public async runCodex(params: {
    codexCliPath: string;
    pathEntries: string[];
    environment: Record<string, string>;
    mcpServers?: LlmMcpServerConfig[];
    workingDir: string;
    sharedRoots?: string[];
    prompt: string;
    model: string;
    reasoningEffort: CodexReasoningEffort;
    permissionMode?: AgentPermissionMode;
    networkAccess?: boolean;
    timeoutMs: number;
    onChild: (child: ChildProcessWithoutNullStreams) => void;
    onOutput?: (stream: 'stdout' | 'stderr' | 'meta', text: string) => void;
    threadId?: string;
    codexHome?: string;
  }): Promise<LlmProviderRunResult> {
    const result = await codexCliAdapter.runChat({
      cliPath: params.codexCliPath,
      pathEntries: params.pathEntries,
      environment: params.environment,
      mcpServers: params.mcpServers,
      workingDir: params.workingDir,
      sharedRoots: params.sharedRoots,
      prompt: params.prompt,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      permissionMode: params.permissionMode,
      networkAccess: params.networkAccess,
      timeoutMs: params.timeoutMs,
      onChild: params.onChild,
      onOutput: params.onOutput,
      threadId: params.threadId,
      codexHome: params.codexHome,
      rootCodexHome: this.codexHome,
      runCommandCapture,
    });
    return {
      assistantText: result.assistantText || 'Listo. ¿Qué te gustaría hacer ahora en esta app?',
      threadId: result.threadId,
      usageDelta: result.usageDelta,
      toolEvents: result.toolEvents,
    };
  }

  public async runClaude(params: {
    claudeCliPath: string;
    pathEntries: string[];
    environment: Record<string, string>;
    mcpServers?: LlmMcpServerConfig[];
    workingDir: string;
    sharedRoots?: string[];
    prompt: string;
    model: string;
    effort: ClaudeEffort;
    permissionMode?: AgentPermissionMode;
    timeoutMs: number;
    onChild: (child: ChildProcessWithoutNullStreams) => void;
    onOutput?: (stream: 'stdout' | 'stderr' | 'meta', text: string) => void;
    threadId?: string;
  }): Promise<LlmProviderRunResult> {
    const result = await claudeCliAdapter.run({
      cliPath: params.claudeCliPath,
      pathEntries: params.pathEntries,
      environment: params.environment,
      mcpServers: params.mcpServers,
      workingDir: params.workingDir,
      sharedRoots: params.sharedRoots,
      prompt: params.prompt,
      model: params.model,
      effort: params.effort,
      permissionMode: params.permissionMode,
      timeoutMs: params.timeoutMs,
      onChild: params.onChild,
      onOutput: params.onOutput,
      threadId: params.threadId,
      runCommandCapture,
    });
    return {
      assistantText: result.assistantText || 'Listo. ¿Qué te gustaría hacer ahora en esta app?',
      threadId: result.threadId,
      toolEvents: result.toolEvents,
    };
  }

  public async runAntigravity(params: {
    antigravityCliPath: string;
    pathEntries: string[];
    environment: Record<string, string>;
    mcpServers?: LlmMcpServerConfig[];
    workingDir: string;
    sharedRoots?: string[];
    prompt: string;
    model: string;
    permissionMode?: AgentPermissionMode;
    timeoutMs: number;
    onChild: (child: ChildProcessWithoutNullStreams) => void;
    onOutput?: (stream: 'stdout' | 'stderr' | 'meta', text: string) => void;
    threadId?: string;
  }): Promise<LlmProviderRunResult> {
    const result = await antigravityCliAdapter.run({
      cliPath: params.antigravityCliPath,
      pathEntries: params.pathEntries,
      environment: params.environment,
      mcpServers: params.mcpServers,
      workingDir: params.workingDir,
      sharedRoots: params.sharedRoots,
      prompt: params.prompt,
      model: params.model,
      conversationId: params.threadId,
      permissionMode: params.permissionMode,
      timeoutMs: params.timeoutMs,
      timeoutMode: 'inactivity',
      onChild: params.onChild,
      onOutput: params.onOutput,
      runCommandCapture,
    });
    return {
      assistantText: result.assistantText,
      threadId: result.conversationId ?? undefined,
      toolEvents: result.toolEvents,
    };
  }
}

export const runCommandCapture = async (
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
): Promise<LlmChatCommandResult> => {
  return await new Promise<LlmChatCommandResult>((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    options.onChild?.(child);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutFired = false;

    const finalizeResolve = (result: LlmChatCommandResult): void => {
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

export const existsDirectory = async (dirPath: string): Promise<boolean> => {
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

export const ensureGitRepository = async (cwd: string): Promise<void> => {
  const revParse = await runCommandCapture('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    timeoutMs: 5_000,
  }).catch(() => null);
  const isRepo = Boolean(revParse && revParse.code === 0 && revParse.stdout.trim() === 'true');

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
    const initMain = await runCommandCapture('git', ['init', '-b', 'main'], { cwd, timeoutMs: 10_000 }).catch(
      () => null,
    );
    if (!initMain || initMain.code !== 0) {
      await runCommandCapture('git', ['init'], { cwd, timeoutMs: 10_000 });
      await ensureMain();
    }
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

export const ensureUserModifiedBranch = async (cwd: string): Promise<void> => {
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

export const getGitStatus = async (cwd: string): Promise<string[]> => {
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

export const gitCommit = async (cwd: string, message: string): Promise<string> => {
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

export const getGitHead = async (cwd: string): Promise<string | null> => {
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

export const summarizeOperationTitle = (prompt: string): string => {
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

export const buildFunctionalOperationSummary = (assistantText: string): string => {
  const compact = stripInternalVersioningClaims(assistantText).replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'Se guardo una nueva version de la app.';
  }
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
};

export const buildAutoAppliedUserMessage = (assistantText: string): string => {
  const compact = stripInternalVersioningClaims(assistantText).trim();
  const suffix = 'Version guardada. Puedes probarla ahora; si no quedo como esperabas, puedo ajustarla o volver a la version anterior.';
  if (!compact) {
    return suffix;
  }
  return `${compact}\n\n${suffix}`;
};

export const stripInternalVersioningClaims = (assistantText: string): string => {
  const paragraphs = assistantText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const versioningTerm = /\b(git|commit|commits|version|versi[oó]n|versiones|punto de retorno|rollback|index\.lock|lock|almac[eé]n|branch|rama)\b/i;
  const saveClaim = /\b(guardad[ao]s?|saved|save|guardar|guarde|guardo|commit(?:ted)?|versionad[ao])\b/i;
  const failureClaim = /\b(no pude|no pudo|no pudimos|could not|cannot|can't|failed|fall[oó]|bloquead[ao]|blocked|permiso|permission|lock)\b/i;
  return paragraphs
    .filter((paragraph) => !(versioningTerm.test(paragraph) && (saveClaim.test(paragraph) || failureClaim.test(paragraph))))
    .join('\n\n');
};

export const applyPreviewChanges = async (
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

export const createChatError = (code: ChatErrorCode, message: string): Error => {
  const error = new Error(message);
  (error as Error & { chatCode?: ChatErrorCode }).chatCode = code;
  return error;
};
