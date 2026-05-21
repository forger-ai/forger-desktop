import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatErrorCode, ClaudeEffort, CodexReasoningEffort, PreviewDiffFile } from '../../shared/types';
import { assertAllowedMcpServers, codexWorkspaceNetworkConfigArgs, createIsolatedCodexHome, DisallowedMcpServerError, removeIsolatedCodexHome } from '../codex-run-isolation';
import { classifyCodexAuthOutput } from '../codex-auth-helpers';

export interface CodexMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

const getMcpApprovalMode = (server: CodexMcpServerConfig): 'auto' | 'approve' =>
  server.name === 'forger' ? 'auto' : 'approve';

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

export function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'item';
}

export interface ChatHistoryMessage {
  role: 'assistant' | 'user';
  content: string;
}

export type ForgerTaskType =
  | 'resolver_dudas'
  | 'trabajar_datos'
  | 'interactuar_con_aplicacion'
  | 'actualizar_aplicacion'
  | 'resolver_conflicto_actualizacion';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  turns: number;
}

export interface CodexRunResult {
  assistantText: string;
  threadId?: string;
  usageDelta?: Partial<CodexUsage>;
  toolEvents: number;
}

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
    sharedRoots?: string[];
    prompt: string;
    model: string;
    reasoningEffort: CodexReasoningEffort;
    networkAccess?: boolean;
    timeoutMs: number;
    onChild: (child: ChildProcessWithoutNullStreams) => void;
    onOutput?: (stream: 'stdout' | 'stderr' | 'meta', text: string) => void;
    threadId?: string;
    codexHome?: string;
  }): Promise<CodexRunResult> {
    const allowedRoots = [params.workingDir, ...(params.sharedRoots ?? [])].join(path.delimiter);

    const modelArgs = ['--model', params.model];
    const reasoningArgs = ['--config', `reasoning_effort="${params.reasoningEffort}"`];
    const networkArgs = codexWorkspaceNetworkConfigArgs(params.networkAccess === true);
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
            ...networkArgs,
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
            ...networkArgs,
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
          ['exec', '--json', ...modelArgs, ...reasoningArgs, ...networkArgs, ...mcpArgs, '--full-auto', '--sandbox', 'workspace-write', ...commonArgs, params.prompt],
          ['exec', '--json', ...modelArgs, ...reasoningArgs, ...networkArgs, ...mcpArgs, '--sandbox', 'workspace-write', ...commonArgs, params.prompt],
          ['exec', '--json', ...modelArgs, ...networkArgs, ...mcpArgs, '--sandbox', 'workspace-write', ...commonArgs, params.prompt],
          ['exec', '--json', ...modelArgs, ...networkArgs, ...mcpArgs, ...commonArgs, params.prompt],
          ['exec', ...modelArgs, ...networkArgs, ...mcpArgs, ...commonArgs, params.prompt],
        ];

    const attemptInactivityTimeoutMs = Math.max(45_000, Math.floor(params.timeoutMs / attempts.length));
    let lastResult: CommandResult | null = null;
    let lastErrorMessage = '';
    const codexCommand = await this.resolveCodexCommand(params);
    const isolatedCodexHome = params.codexHome ?? await createIsolatedCodexHome(this.codexHome, {
      prefix: 'forger-chat-codex-home',
      trustedRoots: [params.workingDir, ...(params.sharedRoots ?? [])],
      networkAccess: params.networkAccess === true,
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
      if (!params.codexHome) {
        await removeIsolatedCodexHome(isolatedCodexHome);
      }
    }

    const message = (
      lastResult?.stderr ||
      lastResult?.stdout ||
      lastErrorMessage ||
      'codex_exec_failed'
    ).trim();
    const parsed = parseCodexJsonl(lastResult?.stdout ?? '', lastResult?.stderr ?? '');
    const error = new Error(message);
    const authFailure = classifyCodexAuthOutput(
      [lastResult?.stdout, lastErrorMessage].filter(Boolean).join('\n'),
      lastResult?.stderr ?? '',
    );
    (error as Error & { chatCode?: ChatErrorCode }).chatCode = authFailure === 'codex_auth_expired'
      ? 'auth_missing'
      : 'capability_unavailable';
    (error as Error & { parsedRun?: CodexRunResult }).parsedRun = {
      assistantText: parsed.assistantText,
      threadId: parsed.threadId,
      usageDelta: parsed.usageDelta,
      toolEvents: parsed.toolEvents,
    };
    throw error;
  }

  public async runClaude(params: {
    claudeCliPath: string;
    pathEntries: string[];
    environment: Record<string, string>;
    mcpServers?: CodexMcpServerConfig[];
    workingDir: string;
    sharedRoots?: string[];
    prompt: string;
    model: string;
    effort: ClaudeEffort;
    timeoutMs: number;
    onChild: (child: ChildProcessWithoutNullStreams) => void;
    onOutput?: (stream: 'stdout' | 'stderr' | 'meta', text: string) => void;
    threadId?: string;
  }): Promise<CodexRunResult> {
    const mcpServers = params.mcpServers ?? [];
    const mcpConfigPath = await writeClaudeMcpConfig(params.workingDir, mcpServers);
    const allowedMcpServers = new Set(mcpServers.map((server) => server.name));
    const args = [
      '-p',
      params.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      params.model,
      '--effort',
      params.effort,
      '--permission-mode',
      'bypassPermissions',
      ...(mcpServers.length > 0 ? ['--mcp-config', mcpConfigPath] : []),
      ...(params.threadId ? ['--resume', params.threadId] : []),
    ];
    params.onOutput?.(
      'meta',
      [
        `Claude Code workingDir=${params.workingDir}`,
        `allowedMcpServers=${mcpServers.map((server) => server.name).join(',') || '(none)'}`,
        `model=${params.model}`,
        `effort=${params.effort}`,
      ].join(' '),
    );
    try {
      const result = await runCommandCapture(params.claudeCliPath, args, {
        cwd: params.workingDir,
        env: {
          FORGER_ALLOWED_ROOTS: [params.workingDir, ...(params.sharedRoots ?? [])].join(path.delimiter),
          ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
          ...params.environment,
          PATH: [path.dirname(params.claudeCliPath), ...params.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
        },
        inactivityTimeoutMs: params.timeoutMs,
        onChild: params.onChild,
        onStdout: (text) => params.onOutput?.('stdout', text),
        onStderr: (text) => params.onOutput?.('stderr', text),
      });
      assertAllowedMcpServers(result.stdout, result.stderr, allowedMcpServers);
      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || 'claude_exec_failed').trim());
      }
      const parsed = parseClaudeJsonl(result.stdout, result.stderr);
      return {
        assistantText: parsed.assistantText || 'Listo. ¿Qué te gustaría hacer ahora en esta app?',
        threadId: parsed.threadId ?? params.threadId,
        toolEvents: parsed.toolEvents,
      };
    } finally {
      await fs.rm(mcpConfigPath, { force: true }).catch(() => undefined);
    }
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

export const classifyForgerTask = (prompt: string): ForgerTaskType => {
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

export const buildFunctionalOperationSummary = (assistantText: string): string => {
  const compact = assistantText.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'Se guardo una nueva version de la app.';
  }
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
};

export const buildAutoAppliedUserMessage = (assistantText: string): string => {
  const compact = assistantText.trim();
  const suffix = 'Version guardada. Puedes probarla ahora; si no quedo como esperabas, puedo ajustarla o volver a la version anterior.';
  if (!compact) {
    return suffix;
  }
  return `${compact}\n\n${suffix}`;
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

const parseClaudeJsonl = (
  stdout: string,
  stderr: string,
): {
  assistantText: string;
  threadId?: string;
  toolEvents: number;
} => {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return { assistantText: '', toolEvents: 0 };
  }
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  let assistantText = '';
  let threadId: string | undefined;
  let toolEvents = 0;
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      assistantText = [assistantText, line].filter(Boolean).join('\n');
      continue;
    }
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!threadId) {
      const sessionId = entry.session_id ?? entry.sessionId ?? entry.conversation_id;
      if (typeof sessionId === 'string' && sessionId.trim()) {
        threadId = sessionId.trim();
      }
    }
    if (type.includes('tool')) {
      toolEvents += 1;
    }
    const text = extractClaudeText(entry);
    if (text) {
      assistantText = text;
    }
  }
  return { assistantText: assistantText.trim(), threadId, toolEvents };
};

const extractClaudeText = (entry: Record<string, unknown>): string => {
  if (typeof entry.result === 'string') {
    return entry.result;
  }
  if (typeof entry.text === 'string') {
    return entry.text;
  }
  const message = entry.message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return '';
          }
          const record = item as Record<string, unknown>;
          return typeof record.text === 'string' ? record.text : '';
        })
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
};

const writeClaudeMcpConfig = async (
  workingDir: string,
  mcpServers: CodexMcpServerConfig[],
): Promise<string> => {
  const configPath = path.join(workingDir, '.forger', 'tmp', `claude-mcp-${randomUUID()}.json`);
  const mcpServersConfig = Object.fromEntries(mcpServers.map((server) => [
    server.name,
    {
      type: 'http',
      url: server.url,
      headers: {
        Authorization: `Bearer \${${server.tokenEnvVar}}`,
      },
    },
  ]));
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: mcpServersConfig }, null, 2), 'utf8');
  return configPath;
};

const toNumber = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

export const createChatError = (code: ChatErrorCode, message: string): Error => {
  const error = new Error(message);
  (error as Error & { chatCode?: ChatErrorCode }).chatCode = code;
  return error;
};
