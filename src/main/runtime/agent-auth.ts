/* eslint-disable max-lines */
import type fs from 'node:fs/promises';
import type path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AppManifest,
  AppManifestService,
  AppRegistry,
  InstalledAppRecord,
  RuntimeBinarySet,
} from '../core/main-process-types';
import type {
  AntigravityAuthStatus,
  AntigravityAuthSessionEvent,
  AntigravityAuthSessionStartResult,
  ClaudeAuthStatus,
  CodexAuthStatus,
  CodexRateLimitBucket,
  CodexRateLimitsStatus,
  CodexRateLimitWindow,
  FailureDiagnosticFields,
} from '../../shared/types';
import type { SpawnProcess } from './process-spawn';

interface CommandCaptureResult {
  code?: number | null;
  stdout: string;
  stderr: string;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface AgentAuthDeps {
  CLAUDE_CODE_VERSION: string;
  CODEX_CLI_VERSION: string;
  DEFAULT_NODE_VERSION: string;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  app: Electron.App;
  buildCodexAuthEnvironment: (input: { codexHome: string; codexCliPath: string; nodePathEntries: string[] }) => NodeJS.ProcessEnv;
  buildMacTerminalLoginScript: (input: { providerName: string; logPath: string; command: string[]; cwd?: string }) => string;
  buildMacTerminalScriptLaunchCommand: (scriptPath: string) => string;
  canRunCommand: (command: string, args: string[]) => Promise<boolean>;
  classifyCodexAuthOutput: (stdout: string, stderr: string) => string | undefined;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  extractAllowedCodexAuthUrls: (text: string) => string[];
  failureDiagnostic: (error: unknown, fallbackCode: string) => FailureDiagnosticFields;
  findExistingFile: (baseDir: string, candidates: string[]) => Promise<string | null>;
  findManifestService: (manifest: AppManifest | null, name: string, fallbackContext: string) => AppManifestService | null;
  fs: typeof fs;
  getClaudeRoot: () => string;
  getAntigravityRoot: () => string;
  getCodexHome: () => string;
  getCodexRoot: () => string;
  getForgerMetadataRoot: () => string;
  getLogsRoot: () => string;
  getTempRoot: () => string;
  markProviderConnected?: (provider: 'codex' | 'claude' | 'antigravity') => Promise<void> | void;
  markProviderDisconnected?: (provider: 'codex' | 'claude' | 'antigravity') => Promise<void> | void;
  path: typeof path;
  registry: AppRegistry;
  resolveInstalledManifest: (installDir: string) => Promise<AppManifest | null>;
  runCommand: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<void>;
  runCommandCapture: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<CommandCaptureResult>;
  serializeErrorForInstallLog: (error: unknown) => { message?: unknown } & Record<string, unknown>;
  shell: Electron.Shell;
  spawn: SpawnProcess;
  translateManifestEnvironment: (environment: Record<string, string>, backendDir: string) => Record<string, string>;
  truncateForInstallLog: (value: string) => string;
}

export const createAgentAuthController = (deps: AgentAuthDeps) => {
  const { path, fs, spawn, app, getCodexHome, getForgerMetadataRoot, registry, resolveInstalledManifest, findManifestService, translateManifestEnvironment, ensureRuntimeInstalled, DEFAULT_NODE_VERSION, getCodexRoot, CODEX_CLI_VERSION, runCommand, runCommandCapture, buildCodexAuthEnvironment, classifyCodexAuthOutput, extractAllowedCodexAuthUrls, appendInstallLog, getLogsRoot, getTempRoot, serializeErrorForInstallLog, shell, buildMacTerminalLoginScript, buildMacTerminalScriptLaunchCommand, failureDiagnostic, CLAUDE_CODE_VERSION, getClaudeRoot, getAntigravityRoot, canRunCommand, markProviderConnected, markProviderDisconnected, findExistingFile, truncateForInstallLog } = deps;
const escapeWindowsBatchValue = (value: string): string => value.replace(/%/g, '%%').replace(/"/g, '""');
const quotePowerShellSingle = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const CODEX_RATE_LIMITS_TIMEOUT_MS = 8_000;
const CODEX_AUTH_STATUS_RATE_LIMITS_TIMEOUT_MS = 1_500;

const getCodexAuthFilePath = (): string => path.join(getCodexHome(), 'auth.json');

const getRuntimePathEntries = (runtime: RuntimeBinarySet): string[] => {
  const entries = new Set<string>();
  for (const executable of Object.values(runtime)) {
    if (typeof executable === 'string') {
      entries.add(path.dirname(executable));
    }
  }

  return [...entries];
};

const existsDirectory = async (dir: string): Promise<boolean> => {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
};

const getAppLocalToolPathEntries = async (record: InstalledAppRecord): Promise<string[]> => {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(record.installDir, 'backend', '.venv', 'Scripts'),
          path.join(record.installDir, 'frontend', 'node_modules', '.bin'),
        ]
      : [
          path.join(record.installDir, 'backend', '.venv', 'bin'),
          path.join(record.installDir, 'frontend', 'node_modules', '.bin'),
        ];
  const entries: string[] = [];
  for (const candidate of candidates) {
    if (await existsDirectory(candidate)) {
      entries.push(candidate);
    }
  }
  return entries;
};

const getCodexToolEnvironment = async (
  appId?: string,
  pythonRuntime?: RuntimeBinarySet,
): Promise<Record<string, string>> => {
  const cacheKey = (appId ?? 'global').replace(/[^a-zA-Z0-9._-]/g, '_');
  const cacheRoot = path.join(getForgerMetadataRoot(), 'tool-cache', cacheKey);
  const uvCacheDir = path.join(cacheRoot, 'uv');
  const pipCacheDir = path.join(cacheRoot, 'pip');
  const npmCacheDir = path.join(cacheRoot, 'npm');
  await Promise.all([
    fs.mkdir(uvCacheDir, { recursive: true }),
    fs.mkdir(pipCacheDir, { recursive: true }),
    fs.mkdir(npmCacheDir, { recursive: true }),
  ]);

  const env: Record<string, string> = {
    UV_CACHE_DIR: uvCacheDir,
    PIP_CACHE_DIR: pipCacheDir,
    NPM_CONFIG_CACHE: npmCacheDir,
  };

  if (pythonRuntime?.python) {
    env.UV_PYTHON = pythonRuntime.python;
  }

  const record = appId ? registry.apps[appId] : undefined;
  if (record) {
    env.UV_PROJECT_ENVIRONMENT = path.join(record.installDir, 'backend', '.venv');
    const manifest = await resolveInstalledManifest(record.installDir);
    const backendService = findManifestService(manifest, 'backend', './backend');
    const backendDir = path.join(record.installDir, 'backend');
    const manifestEnvironment =
      backendService?.environment && typeof backendService.environment === 'object'
        ? backendService.environment
        : {};
    Object.assign(env, translateManifestEnvironment(manifestEnvironment, backendDir));
  }

  return env;
};

const resolveCodexCliPath = async (baseDir: string): Promise<string | null> => {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join('node_modules', '.bin', 'codex.cmd'),
          path.join('node_modules', '.bin', 'codex'),
        ]
      : [
    path.join('node_modules', '.bin', 'codex'),
    path.join('node_modules', '.bin', 'codex.cmd'),
        ];

  return await findExistingFile(baseDir, candidates);
};

const getInstalledCodexCliVersion = async (baseDir: string): Promise<string | null> => {
  const packageJsonPath = path.join(baseDir, 'node_modules', '@openai', 'codex', 'package.json');
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
};

const ensureCodexCliInstalled = async (): Promise<string> => {
  const existing = await resolveCodexCliPath(getCodexRoot());
  const installedVersion = existing ? await getInstalledCodexCliVersion(getCodexRoot()) : null;
  if (existing && installedVersion === CODEX_CLI_VERSION) {
    return existing;
  }
  if (existing && installedVersion !== CODEX_CLI_VERSION) {
    await appendInstallLog('codex_auth:version_mismatch', {
      installedVersion,
      expectedVersion: CODEX_CLI_VERSION,
    });
  }

  const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
  const codexRoot = getCodexRoot();
  await fs.mkdir(codexRoot, { recursive: true });

  const packageJsonPath = path.join(codexRoot, 'package.json');
  try {
    await fs.access(packageJsonPath);
  } catch {
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify(
        {
          name: 'forger-codex-runtime',
          private: true,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  await runCommand(
    nodeRuntime.npm as string,
    ['install', '--no-audit', '--no-fund', `@openai/codex@${CODEX_CLI_VERSION}`],
    {
    cwd: codexRoot,
    env: {
      PATH: `${path.dirname(nodeRuntime.node as string)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    log: {
      phase: 'codex_auth',
      label: 'install codex cli',
    },
    },
  );

  const installed = await resolveCodexCliPath(codexRoot);
  if (!installed) {
    throw new Error('codex_cli_install_failed');
  }

  return installed;
};

const buildManagedCodexAuthEnvironment = async (
  codexCliPath: string,
  codexHome: string,
): Promise<NodeJS.ProcessEnv> => {
  const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
  return buildCodexAuthEnvironment({
    codexHome,
    codexCliPath,
    nodePathEntries: getRuntimePathEntries(nodeRuntime),
  });
};

const normalizePercent = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
};

const normalizeRateLimitWindow = (value: unknown): CodexRateLimitWindow | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const usedPercent = normalizePercent(record.usedPercent);
  const windowDurationMins = typeof record.windowDurationMins === 'number' && Number.isFinite(record.windowDurationMins)
    ? Math.max(0, record.windowDurationMins)
    : undefined;
  const resetsAt = typeof record.resetsAt === 'number' && Number.isFinite(record.resetsAt)
    ? record.resetsAt
    : undefined;
  return {
    ...(usedPercent !== undefined ? { usedPercent, remainingPercent: Math.max(0, 100 - usedPercent) } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
};

const normalizeRateLimitBucket = (value: unknown): CodexRateLimitBucket | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const limitId = typeof record.limitId === 'string' && record.limitId.trim() ? record.limitId.trim() : null;
  if (!limitId) {
    return null;
  }
  const primary = normalizeRateLimitWindow(record.primary);
  const secondary = normalizeRateLimitWindow(record.secondary);
  return {
    limitId,
    limitName: typeof record.limitName === 'string' ? record.limitName : null,
    planType: typeof record.planType === 'string' ? record.planType : null,
    ...(primary ? { primary } : {}),
    secondary: secondary ?? null,
    rateLimitReachedType: typeof record.rateLimitReachedType === 'string' ? record.rateLimitReachedType : null,
    credits: record.credits && typeof record.credits === 'object' ? record.credits as Record<string, unknown> : null,
  };
};

const normalizeCodexRateLimits = (value: unknown): CodexRateLimitsStatus | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const primary = normalizeRateLimitBucket(record.rateLimits);
  const bucketMap = record.rateLimitsByLimitId && typeof record.rateLimitsByLimitId === 'object'
    ? Object.values(record.rateLimitsByLimitId as Record<string, unknown>)
    : [];
  const buckets = bucketMap
    .map(normalizeRateLimitBucket)
    .filter((bucket): bucket is CodexRateLimitBucket => Boolean(bucket));
  const dedupedBuckets = new Map<string, CodexRateLimitBucket>();
  for (const bucket of [primary, ...buckets]) {
    if (bucket) {
      dedupedBuckets.set(bucket.limitId, bucket);
    }
  }
  const normalizedBuckets = [...dedupedBuckets.values()];
  return primary || normalizedBuckets.length > 0
    ? { ...(primary ? { primary } : {}), buckets: normalizedBuckets, checkedAt: new Date().toISOString() }
    : undefined;
};

const readCodexAppServerRateLimits = async (
  codexCliPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = CODEX_RATE_LIMITS_TIMEOUT_MS,
): Promise<CodexRateLimitsStatus | undefined> => {
  return await new Promise<CodexRateLimitsStatus | undefined>((resolve, reject) => {
    const child = spawn(codexCliPath, ['app-server', '--listen', 'stdio://'], {
      cwd: app.getPath('userData'),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      finalizeReject(new Error('codex_rate_limits_timeout'));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      child.kill();
    };
    const finalizeResolve = (value: CodexRateLimitsStatus | undefined): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finalizeReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const send = (payload: Record<string, unknown>): void => {
      if (!child.stdin || child.stdin.destroyed) {
        throw new Error('codex_app_server_stdin_unavailable');
      }
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    const handleResponse = (line: string): void => {
      if (!line.trim()) return;
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return;
      }
      if (parsed.id !== 2) {
        return;
      }
      if (parsed.error) {
        finalizeReject(new Error(typeof parsed.error.message === 'string' ? parsed.error.message : 'codex_rate_limits_failed'));
        return;
      }
      finalizeResolve(normalizeCodexRateLimits(parsed.result));
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        handleResponse(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', finalizeReject);
    child.on('exit', (code) => {
      if (!settled) {
        finalizeReject(new Error(`codex_app_server_exited_${code ?? 'unknown'}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`));
      }
    });

    try {
      const appVersion = typeof app.getVersion === 'function' ? app.getVersion() : 'unknown';
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'forger-desktop', version: appVersion }, capabilities: {} } });
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' });
    } catch (error) {
      finalizeReject(error);
    }
  });
};

const getCodexAuthStatus = async (): Promise<CodexAuthStatus> => {
  const authFilePath = getCodexAuthFilePath();
  const codexHome = getCodexHome();
  const codexCliPath = await resolveCodexCliPath(getCodexRoot());
  let authFilePresent = false;
  try {
    authFilePresent = (await fs.stat(authFilePath)).isFile();
  } catch {
    authFilePresent = false;
  }

  let authenticated = false;
  if (codexCliPath) {
    try {
      const env = await buildManagedCodexAuthEnvironment(codexCliPath, codexHome);
      const status = await runCommandCapture(codexCliPath, ['login', 'status'], {
        cwd: app.getPath('userData'),
        env,
        timeoutMs: 15_000,
      });
      const output = [status.stdout, status.stderr].filter(Boolean).join('\n');
      authenticated = status.code === 0 && /logged\s+in/i.test(output) && !/not\s+logged\s+in/i.test(output);
      const technicalCode = authenticated ? undefined : classifyCodexAuthOutput(status.stdout, status.stderr);
      await appendInstallLog('codex_auth:status_checked', {
        codexHome,
        codexCliPath,
        authenticated,
        authFilePresent,
        technicalCode,
        pathPrefix: env.PATH?.split(path.delimiter).slice(0, 3).join(path.delimiter),
        stdout: truncateForInstallLog(status.stdout),
        stderr: truncateForInstallLog(status.stderr),
      });
    } catch (error) {
      authenticated = false;
      await appendInstallLog('codex_auth:status_failed', {
        codexHome,
        codexCliPath,
        authFilePresent,
        error: serializeErrorForInstallLog(error),
      });
    }
  }

  let rateLimits: CodexRateLimitsStatus | undefined;
  if (authenticated && codexCliPath) {
    try {
      const env = await buildManagedCodexAuthEnvironment(codexCliPath, codexHome);
      rateLimits = await readCodexAppServerRateLimits(codexCliPath, env, CODEX_AUTH_STATUS_RATE_LIMITS_TIMEOUT_MS);
      await appendInstallLog('codex_auth:rate_limits_checked', {
        codexHome,
        codexCliPath,
        bucketCount: rateLimits?.buckets.length ?? 0,
        primary: rateLimits?.primary,
      });
    } catch (error) {
      await appendInstallLog('codex_auth:rate_limits_failed', {
        codexHome,
        codexCliPath,
        error: serializeErrorForInstallLog(error),
      });
    }
  }

  if (authenticated) {
    await markProviderConnected?.('codex');
  }

  return {
    installed: Boolean(codexCliPath),
    authenticated,
    authFilePath,
    codexHome,
    codexCliPath: codexCliPath ?? undefined,
    rateLimits,
  };
};

const appendCodexLoginLog = async (loginLogPath: string, stream: string, text: string): Promise<void> => {
  await fs.appendFile(
    loginLogPath,
    `[${new Date().toISOString()}] [${stream}] ${text.endsWith('\n') ? text : `${text}\n`}`,
    'utf8',
  ).catch(() => undefined);
};

const installErrorMessage = (error: unknown): string => {
  const serialized = serializeErrorForInstallLog(error);
  return typeof serialized.message === 'string' ? serialized.message : String(error);
};

const launchMacCodexLoginProcess = async (
  codexCliPath: string,
  codexHome: string,
): Promise<{ loginLogPath: string; env: NodeJS.ProcessEnv }> => {
  const loginLogPath = path.join(getLogsRoot(), 'codex-login.log');
  const env = await buildManagedCodexAuthEnvironment(codexCliPath, codexHome);
  await fs.mkdir(path.dirname(loginLogPath), { recursive: true });
  await fs.writeFile(
    loginLogPath,
    [
      `[${new Date().toISOString()}] Forger prepared Codex login.`,
      `codexHome=${codexHome}`,
      `codexCliPath=${codexCliPath}`,
      `pathPrefix=${env.PATH?.split(path.delimiter).slice(0, 3).join(path.delimiter) ?? ''}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const openedUrls = new Set<string>();
  const child = spawn(codexCliPath, ['login'], {
    cwd: app.getPath('userData'),
    env,
    shell: false,
    stdio: 'pipe',
  });

  const handleOutput = (stream: 'stdout' | 'stderr', text: string): void => {
    void appendCodexLoginLog(loginLogPath, stream, text);
    for (const url of extractAllowedCodexAuthUrls(text)) {
      if (openedUrls.has(url)) {
        continue;
      }
      openedUrls.add(url);
      void shell.openExternal(url).catch((error) => {
        void appendCodexLoginLog(loginLogPath, 'open_external_error', installErrorMessage(error));
      });
    }
  };

  child.stdout.on('data', (chunk) => handleOutput('stdout', chunk.toString()));
  child.stderr.on('data', (chunk) => handleOutput('stderr', chunk.toString()));
  child.once('exit', (code, signal) => {
    void appendInstallLog('codex_auth:login_process_exit', {
      platform: process.platform,
      code,
      signal,
      loginLogPath,
    });
    void appendCodexLoginLog(loginLogPath, 'exit', `code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    child.once('error', (error) => {
      if (settled) {
        void appendCodexLoginLog(loginLogPath, 'error', installErrorMessage(error));
        return;
      }
      settled = true;
      reject(error);
    });
    setImmediate(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    });
  });

  return { loginLogPath, env };
};

const connectCodexAuth = async (): Promise<{ success: boolean; userMessage: string } & FailureDiagnosticFields> => {
  try {
    const codexCliPath = await ensureCodexCliInstalled();
    const codexHome = getCodexHome();
    await fs.mkdir(codexHome, { recursive: true });

    if (process.platform === 'darwin') {
      const launched = await launchMacCodexLoginProcess(codexCliPath, codexHome);

      await appendInstallLog('codex_auth:login_started', {
        platform: process.platform,
        codexHome,
        codexCliPath,
        loginLogPath: launched.loginLogPath,
        pathPrefix: launched.env.PATH?.split(path.delimiter).slice(0, 3).join(path.delimiter),
      });

      return {
        success: true,
        userMessage: 'Iniciamos la conexion con Codex. Completa el login de ChatGPT en el navegador.',
      };
    }

    if (process.platform === 'win32') {
      const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      const nodePathPrefix = [
        ...getRuntimePathEntries(nodeRuntime),
        path.dirname(codexCliPath),
      ].join(';');
      const loginLogPath = path.join(getLogsRoot(), 'codex-login.log');
      const loginScriptPath = path.join(getTempRoot(), 'codex-login.cmd');
      const loginScript = [
        '@echo off',
        'title Forger Codex Login',
        `set "CODEX_HOME=${escapeWindowsBatchValue(codexHome)}"`,
        `set "FORGER_CODEX_LOGIN_LOG=${escapeWindowsBatchValue(loginLogPath)}"`,
        `set "PATH=${escapeWindowsBatchValue(nodePathPrefix)};%PATH%"`,
        'echo [%DATE% %TIME%] Batch started >> "%FORGER_CODEX_LOGIN_LOG%"',
        'echo CODEX_HOME=%CODEX_HOME% >> "%FORGER_CODEX_LOGIN_LOG%"',
        'echo PATH=%PATH% >> "%FORGER_CODEX_LOGIN_LOG%"',
        'where node >> "%FORGER_CODEX_LOGIN_LOG%" 2>&1',
        'where npm >> "%FORGER_CODEX_LOGIN_LOG%" 2>&1',
        'where codex >> "%FORGER_CODEX_LOGIN_LOG%" 2>&1',
        'echo [%DATE% %TIME%] Running codex login >> "%FORGER_CODEX_LOGIN_LOG%"',
        `"${escapeWindowsBatchValue(codexCliPath)}" login`,
        'set "FORGER_CODEX_LOGIN_EXIT=%ERRORLEVEL%"',
        'echo [%DATE% %TIME%] Codex login exited with code %FORGER_CODEX_LOGIN_EXIT% >> "%FORGER_CODEX_LOGIN_LOG%"',
        'echo.',
        'echo Codex login finished with exit code %FORGER_CODEX_LOGIN_EXIT%. You can close this window.',
        'pause',
      ].join('\r\n');

      await fs.mkdir(path.dirname(loginLogPath), { recursive: true });
      await fs.mkdir(path.dirname(loginScriptPath), { recursive: true });
      await fs.writeFile(
        loginLogPath,
        [
          `[${new Date().toISOString()}] Forger prepared Codex login.`,
          `codexHome=${codexHome}`,
          `codexCliPath=${codexCliPath}`,
          `loginScriptPath=${loginScriptPath}`,
          `nodePathPrefix=${nodePathPrefix}`,
          '',
        ].join('\r\n'),
        'utf8',
      );
      await fs.writeFile(loginScriptPath, `${loginScript}\r\n`, 'utf8');

      const launchCommand = [
        '$ErrorActionPreference = "Stop"',
        `Start-Process -FilePath ${quotePowerShellSingle('cmd.exe')} -ArgumentList ${quotePowerShellSingle(`/d /k call "${loginScriptPath}"`)} -WorkingDirectory ${quotePowerShellSingle(app.getPath('userData'))}`,
      ].join('; ');

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launchCommand],
          {
            cwd: app.getPath('userData'),
            stdio: 'ignore',
            windowsHide: true,
          },
        );

        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`powershell Start-Process exited with code ${code ?? 'unknown'}`));
        });
      });

      await appendInstallLog('codex_auth:terminal_opened', {
        platform: process.platform,
        codexHome,
        codexCliPath,
        loginScriptPath,
        loginLogPath,
        nodePathPrefix,
      });

      return {
        success: true,
        userMessage: 'Abrimos una consola para completar el login de Codex con ChatGPT.',
      };
    }

    const env = await buildManagedCodexAuthEnvironment(codexCliPath, codexHome);
    await runCommand(codexCliPath, ['login'], {
      cwd: app.getPath('userData'),
      env,
      log: {
        phase: 'codex_auth',
        label: 'codex login',
      },
    });

    return {
      success: true,
      userMessage: 'Login de Codex iniciado.',
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'codex_connect_failed');
    await appendInstallLog('codex_auth:failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos iniciar el login de Codex.',
      ...diagnostic,
    };
  }
};

const disconnectCodexAuth = async (): Promise<{ success: boolean; userMessage: string } & FailureDiagnosticFields> => {
  try {
    await fs.rm(getCodexAuthFilePath(), { force: true });
    await markProviderDisconnected?.('codex');
    return {
      success: true,
      userMessage: 'Sesion de Codex desconectada.',
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'codex_logout_failed');
    return {
      success: false,
      userMessage: 'No pudimos cerrar la sesion de Codex.',
      ...diagnostic,
    };
  }
};

const reinstallCodex = async (): Promise<{ success: boolean; userMessage: string; status?: CodexAuthStatus } & FailureDiagnosticFields> => {
  try {
    await fs.rm(getCodexRoot(), { recursive: true, force: true });
    await fs.rm(getCodexHome(), { recursive: true, force: true });
    await fs.mkdir(getCodexRoot(), { recursive: true });
    await fs.mkdir(getCodexHome(), { recursive: true });
    await ensureCodexCliInstalled();
    const status = await getCodexAuthStatus();
    return {
      success: true,
      userMessage: 'Codex fue reinstalado. Vuelve a conectar ChatGPT para usar agentes desde Forger.',
      status,
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'codex_reinstall_failed');
    await appendInstallLog('codex_auth:reinstall_failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos reinstalar Codex.',
      ...diagnostic,
      status: await getCodexAuthStatus().catch(() => undefined),
    };
  }
};

const resolveManagedClaudeCliPath = async (baseDir: string): Promise<string | null> => {
  const candidates = process.platform === 'win32'
    ? [
        path.join(baseDir, 'node_modules', '.bin', 'claude.cmd'),
        path.join(baseDir, 'node_modules', '.bin', 'claude'),
      ]
    : [
        path.join(baseDir, 'node_modules', '.bin', 'claude'),
        path.join(baseDir, 'node_modules', '.bin', 'claude.cmd'),
      ];
  for (const candidate of candidates) {
    if ((await existsDirectory(candidate.replace(/[\\/][^\\/]+$/, ''))) && (await canRunCommand(candidate, ['--version']))) {
      return candidate;
    }
  }
  return null;
};

const getInstalledClaudeCliVersion = async (baseDir: string): Promise<string | null> => {
  const packageJsonPath = path.join(baseDir, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
};

const resolveSystemClaudeCliPath = async (): Promise<string | null> => {
  try {
    const result = await runCommandCapture(
      process.platform === 'win32' ? 'where' : 'which',
      ['claude'],
      { cwd: app.getPath('userData'), timeoutMs: 10_000 },
    );
    if (result.code !== 0) {
      return null;
    }
    const candidate = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!candidate) {
      return null;
    }
    return await canRunCommand(candidate, ['--version']) ? candidate : null;
  } catch {
    return null;
  }
};

const resolveClaudeCli = async (): Promise<{ path: string; source: 'managed' | 'system' } | null> => {
  const managed = await resolveManagedClaudeCliPath(getClaudeRoot());
  if (managed) {
    return { path: managed, source: 'managed' };
  }
  const system = await resolveSystemClaudeCliPath();
  return system ? { path: system, source: 'system' } : null;
};

const ensureClaudeCliInstalled = async (): Promise<string> => {
  const existing = await resolveManagedClaudeCliPath(getClaudeRoot());
  const installedVersion = existing ? await getInstalledClaudeCliVersion(getClaudeRoot()) : null;
  if (existing && installedVersion === CLAUDE_CODE_VERSION) {
    return existing;
  }
  if (existing && installedVersion !== CLAUDE_CODE_VERSION) {
    await appendInstallLog('claude_auth:version_mismatch', {
      installedVersion,
      expectedVersion: CLAUDE_CODE_VERSION,
    });
  }
  const claudeRoot = getClaudeRoot();
  await fs.mkdir(claudeRoot, { recursive: true });
  const packageJsonPath = path.join(claudeRoot, 'package.json');
  try {
    await fs.access(packageJsonPath);
  } catch {
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'forger-claude-code-runtime',
        private: true,
        description: 'Forger-managed Claude Code runtime',
      }, null, 2),
      'utf8',
    );
  }
  const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
  if (!nodeRuntime.npm) {
    throw new Error('runtime_npm_executable_not_found');
  }
  await runCommand(
    nodeRuntime.npm,
    ['install', '--no-audit', '--no-fund', `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`],
    {
      cwd: claudeRoot,
      env: {
        PATH: [...getRuntimePathEntries(nodeRuntime), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
      },
      log: {
        phase: 'claude_auth',
        label: 'install claude code cli',
      },
    },
  );
  const installed = await resolveManagedClaudeCliPath(claudeRoot);
  if (!installed) {
    throw new Error('claude_cli_install_failed');
  }
  return installed;
};

const getClaudeAuthStatus = async (): Promise<ClaudeAuthStatus> => {
  const resolved = await resolveClaudeCli();
  if (!resolved) {
    return {
      installed: false,
      authenticated: false,
      source: 'missing',
      userMessage: 'Claude Code no esta instalado en este equipo.',
    };
  }

  const [versionResult, authResult] = await Promise.all([
    runCommandCapture(resolved.path, ['--version'], { cwd: app.getPath('userData'), timeoutMs: 10_000 }).catch(() => null),
    runCommandCapture(resolved.path, ['auth', 'status'], { cwd: app.getPath('userData'), timeoutMs: 15_000 }).catch(() => null),
  ]);
  const statusText = [authResult?.stdout, authResult?.stderr].filter(Boolean).join('\n').trim();
  const authenticated = Boolean(
    authResult
    && authResult.code === 0
    && !/not\s+(authenticated|logged\s*in)|login required|no active/i.test(statusText),
  );

  if (authenticated) {
    await markProviderConnected?.('claude');
  }

  return {
    installed: true,
    authenticated,
    source: resolved.source,
    claudeCliPath: resolved.path,
    version: versionResult?.stdout.trim() || versionResult?.stderr.trim() || undefined,
    statusText: statusText || undefined,
  };
};

const connectClaudeAuth = async (): Promise<{ success: boolean; userMessage: string; status?: ClaudeAuthStatus } & FailureDiagnosticFields> => {
  try {
    const cliPath = (await resolveClaudeCli())?.path ?? await ensureClaudeCliInstalled();

    if (process.platform === 'darwin') {
      const loginLogPath = path.join(getLogsRoot(), 'claude-login.log');
      const loginScriptPath = path.join(getTempRoot(), 'claude-login.command');
      const loginScript = buildMacTerminalLoginScript({
        providerName: 'Claude Code',
        logPath: loginLogPath,
        command: [cliPath, 'auth', 'login'],
      });

      await fs.mkdir(path.dirname(loginLogPath), { recursive: true });
      await fs.mkdir(path.dirname(loginScriptPath), { recursive: true });
      await fs.writeFile(
        loginLogPath,
        [
          `[${new Date().toISOString()}] Forger prepared Claude Code login.`,
          `claudeCliPath=${cliPath}`,
          `loginScriptPath=${loginScriptPath}`,
          '',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(loginScriptPath, loginScript, 'utf8');
      await fs.chmod(loginScriptPath, 0o700);
      const terminalCommand = buildMacTerminalScriptLaunchCommand(loginScriptPath);
      await runCommand(
        '/usr/bin/osascript',
        [
          '-e',
          'tell application "Terminal"',
          '-e',
          'activate',
          '-e',
          `do script ${JSON.stringify(terminalCommand)}`,
          '-e',
          'end tell',
        ],
        { cwd: app.getPath('userData') },
      );

      await appendInstallLog('claude_auth:terminal_opened', {
        platform: process.platform,
        cliPath,
        loginScriptPath,
        terminalCommand,
        loginLogPath,
      });
      return {
        success: true,
        userMessage: 'Abrimos Terminal para completar el login local de Claude Code.',
        status: await getClaudeAuthStatus().catch(() => undefined),
      };
    }

    if (process.platform === 'win32') {
      const loginScriptPath = path.join(getTempRoot(), 'claude-login.cmd');
      const loginScript = [
        '@echo off',
        'title Forger Claude Code Login',
        `"${escapeWindowsBatchValue(cliPath)}" auth login`,
        'set "FORGER_CLAUDE_LOGIN_EXIT=%ERRORLEVEL%"',
        'echo.',
        'echo Claude Code login finished with exit code %FORGER_CLAUDE_LOGIN_EXIT%. You can close this window.',
        'pause',
      ].join('\r\n');
      await fs.mkdir(path.dirname(loginScriptPath), { recursive: true });
      await fs.writeFile(loginScriptPath, `${loginScript}\r\n`, 'utf8');
      const launchCommand = [
        '$ErrorActionPreference = "Stop"',
        `Start-Process -FilePath ${quotePowerShellSingle('cmd.exe')} -ArgumentList ${quotePowerShellSingle(`/d /k call "${loginScriptPath}"`)} -WorkingDirectory ${quotePowerShellSingle(app.getPath('userData'))}`,
      ].join('; ');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launchCommand],
          {
            cwd: app.getPath('userData'),
            stdio: 'ignore',
            windowsHide: true,
          },
        );
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`powershell Start-Process exited with code ${code ?? 'unknown'}`)));
      });
      return {
        success: true,
        userMessage: 'Abrimos una consola para completar el login local de Claude Code.',
        status: await getClaudeAuthStatus().catch(() => undefined),
      };
    }

    await runCommand(cliPath, ['auth', 'login'], {
      cwd: app.getPath('userData'),
      log: {
        phase: 'claude_auth',
        label: 'claude auth login',
      },
    });
    return {
      success: true,
      userMessage: 'Login de Claude Code completado.',
      status: await getClaudeAuthStatus().catch(() => undefined),
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'claude_connect_failed');
    await appendInstallLog('claude_auth:failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos iniciar el login de Claude Code.',
      ...diagnostic,
      status: await getClaudeAuthStatus().catch(() => undefined),
    };
  }
};

const reinstallClaude = async (): Promise<{ success: boolean; userMessage: string; status?: ClaudeAuthStatus } & FailureDiagnosticFields> => {
  try {
    await fs.rm(getClaudeRoot(), { recursive: true, force: true });
    await fs.mkdir(getClaudeRoot(), { recursive: true });
    await ensureClaudeCliInstalled();
    return {
      success: true,
      userMessage: 'Claude Code fue instalado por Forger. Si no hay sesion activa, conecta Claude para usarlo.',
      status: await getClaudeAuthStatus().catch(() => undefined),
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'claude_reinstall_failed');
    await appendInstallLog('claude_auth:reinstall_failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos instalar Claude Code.',
      ...diagnostic,
      status: await getClaudeAuthStatus().catch(() => undefined),
    };
  }
};

const disconnectClaudeAuth = async (): Promise<{ success: boolean; userMessage: string; status?: ClaudeAuthStatus } & FailureDiagnosticFields> => {
  try {
    await markProviderDisconnected?.('claude');
    const status = await getClaudeAuthStatus().catch(() => undefined);
    await appendInstallLog('claude_auth:disconnected', {
      authenticated: status?.authenticated,
      credentialScope: 'external_provider_state_preserved',
    });
    return {
      success: !status?.authenticated,
      userMessage: status?.authenticated
        ? 'Claude Code sigue conectado en este equipo. Forger no borra credenciales locales del proveedor sin una confirmación explícita.'
        : 'Claude Code fue desconectado en este equipo.',
      status,
      ...(status?.authenticated ? { technicalCode: 'claude_auth_still_authenticated' } : {}),
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'claude_disconnect_failed');
    await appendInstallLog('claude_auth:disconnect_failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos desconectar Claude Code.',
      ...diagnostic,
      status: await getClaudeAuthStatus().catch(() => undefined),
    };
  }
};

const getAntigravityBinDir = (): string => path.join(getAntigravityRoot(), 'bin');
const ANTIGRAVITY_UNIX_INSTALLER_URL = 'https://antigravity.google/cli/install.sh';
const ANTIGRAVITY_WINDOWS_INSTALLER_URL = 'https://antigravity.google/cli/install.ps1';
const ANTIGRAVITY_AUTH_PROBE_PROMPT = 'Return the exact string OK and do not use tools.';
const GOOGLE_OAUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s<>"')]+/g;
const activeAntigravityAuthSessions = new Map<string, { child: ReturnType<SpawnProcess>; completed: boolean }>();
const redactAntigravityAuthOutput = (text: string): string =>
  text.replace(GOOGLE_OAUTH_URL_PATTERN, '[redacted-google-oauth-url]');

const openMacAntigravityLoginTerminal = async (input: {
  cliPath: string;
  source: 'managed' | 'system';
  sessionId?: string;
}): Promise<{ loginLogPath: string; loginScriptPath: string; terminalCommand: string }> => {
  const loginLogPath = path.join(getLogsRoot(), 'antigravity-login.log');
  const loginScriptPath = path.join(getTempRoot(), 'antigravity-login.command');
  const loginCwd = path.join(getTempRoot(), 'antigravity-auth-login');
  await fs.mkdir(loginCwd, { recursive: true }).catch(() => undefined);
  const loginScript = buildMacTerminalLoginScript({
    providerName: 'Google Antigravity',
    logPath: loginLogPath,
    command: [input.cliPath, '--print', ANTIGRAVITY_AUTH_PROBE_PROMPT, '--print-timeout', '5m'],
    cwd: loginCwd,
  });
  await fs.mkdir(path.dirname(loginLogPath), { recursive: true });
  await fs.mkdir(path.dirname(loginScriptPath), { recursive: true });
  await fs.writeFile(loginLogPath, [
    `[${new Date().toISOString()}] Forger prepared Google Antigravity login.`,
    `antigravityCliPath=${input.cliPath}`,
    `source=${input.source}`,
    `sessionId=${input.sessionId ?? ''}`,
    `loginScriptPath=${loginScriptPath}`,
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(loginScriptPath, loginScript, 'utf8');
  await fs.chmod(loginScriptPath, 0o700);
  const terminalCommand = buildMacTerminalScriptLaunchCommand(loginScriptPath);
  await runCommand(
    '/usr/bin/osascript',
    [
      '-e',
      'tell application "Terminal"',
      '-e',
      'activate',
      '-e',
      `do script ${JSON.stringify(terminalCommand)}`,
      '-e',
      'end tell',
    ],
    { cwd: app.getPath('userData') },
  );
  return { loginLogPath, loginScriptPath, terminalCommand };
};

const openWindowsAntigravityLoginTerminal = async (input: {
  cliPath: string;
  source: 'managed' | 'system';
}): Promise<{ loginLogPath: string; loginScriptPath: string; launchCommand: string }> => {
  const loginLogPath = path.join(getLogsRoot(), 'antigravity-login.log');
  const loginScriptPath = path.join(getTempRoot(), 'antigravity-login.cmd');
  const loginCwd = path.join(getTempRoot(), 'antigravity-auth-login');
  await fs.mkdir(loginCwd, { recursive: true }).catch(() => undefined);
  const loginScript = [
    '@echo off',
    'title Forger Google Antigravity Login',
    `cd /d "${escapeWindowsBatchValue(loginCwd)}"`,
    `"${escapeWindowsBatchValue(input.cliPath)}" --print "${escapeWindowsBatchValue(ANTIGRAVITY_AUTH_PROBE_PROMPT)}" --print-timeout 5m`,
    'set "FORGER_ANTIGRAVITY_LOGIN_EXIT=%ERRORLEVEL%"',
    'echo.',
    'echo Google Antigravity login finished with exit code %FORGER_ANTIGRAVITY_LOGIN_EXIT%. You can close this window.',
    'pause',
  ].join('\r\n');
  await fs.mkdir(path.dirname(loginLogPath), { recursive: true });
  await fs.mkdir(path.dirname(loginScriptPath), { recursive: true });
  await fs.writeFile(loginLogPath, [
    `[${new Date().toISOString()}] Forger prepared Google Antigravity login.`,
    `antigravityCliPath=${input.cliPath}`,
    `source=${input.source}`,
    `loginScriptPath=${loginScriptPath}`,
    '',
  ].join('\r\n'), 'utf8');
  await fs.writeFile(loginScriptPath, `${loginScript}\r\n`, 'utf8');
  const launchCommand = [
    '$ErrorActionPreference = "Stop"',
    `Start-Process -FilePath ${quotePowerShellSingle('cmd.exe')} -ArgumentList ${quotePowerShellSingle(`/d /k call "${loginScriptPath}"`)} -WorkingDirectory ${quotePowerShellSingle(app.getPath('userData'))}`,
  ].join('; ');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launchCommand],
      {
        cwd: app.getPath('userData'),
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`powershell Start-Process exited with code ${code ?? 'unknown'}`)));
  });
  return { loginLogPath, loginScriptPath, launchCommand };
};

const hasMacKeychainGenericPassword = async (service: string, account: string): Promise<boolean> => {
  if (process.platform !== 'darwin') {
    return false;
  }
  const result = await runCommandCapture('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account], {
    cwd: app.getPath('userData'),
    timeoutMs: 5_000,
  }).catch(() => null);
  return result?.code === 0;
};

const hasAntigravityLocalState = async (): Promise<boolean> => {
  if (await hasMacKeychainGenericPassword('gemini', 'antigravity')) {
    return true;
  }
  const home = app.getPath('home');
  const candidates = [
    path.join(home, '.gemini', 'antigravity', 'antigravity_state.pbtxt'),
  ];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return true;
      }
    } catch {
      // Keep status checks best-effort and non-blocking.
    }
  }
  return false;
};

const getManagedAntigravityCliPath = (): string =>
  process.platform === 'win32'
    ? path.join(getAntigravityBinDir(), 'agy.exe')
    : path.join(getAntigravityBinDir(), 'agy');

const resolveManagedAntigravityCliPath = async (): Promise<string | null> => {
  const candidate = getManagedAntigravityCliPath();
  try {
    await fs.access(candidate);
    return await canRunCommand(candidate, ['--version']) ? candidate : null;
  } catch {
    return null;
  }
};

const resolveSystemAntigravityCliPath = async (): Promise<string | null> => {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = await runCommandCapture(command, ['agy'], { cwd: app.getPath('userData'), timeoutMs: 5_000 }).catch(() => null);
  const candidate = result?.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!candidate) {
    return null;
  }
  return await canRunCommand(candidate, ['--version']) ? candidate : null;
};

const resolveAntigravityCli = async (): Promise<{ path: string; source: 'managed' | 'system' } | null> => {
  const managed = await resolveManagedAntigravityCliPath();
  if (managed) {
    return { path: managed, source: 'managed' };
  }
  const system = await resolveSystemAntigravityCliPath();
  return system ? { path: system, source: 'system' } : null;
};

const getAntigravityInstaller = (): { url: string; id: 'windows' | 'unix'; path: string } => {
  if (process.platform === 'win32') {
    return {
      url: ANTIGRAVITY_WINDOWS_INSTALLER_URL,
      id: 'windows',
      path: path.join(getTempRoot(), 'antigravity-install.ps1'),
    };
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return {
      url: ANTIGRAVITY_UNIX_INSTALLER_URL,
      id: 'unix',
      path: path.join(getTempRoot(), 'antigravity-install.sh'),
    };
  }
  throw new Error('antigravity_unsupported_platform');
};

const downloadAntigravityInstaller = async (installer: ReturnType<typeof getAntigravityInstaller>): Promise<void> => {
  await fs.mkdir(path.dirname(installer.path), { recursive: true });
  if (installer.id === 'windows') {
    await runCommand(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          "$ProgressPreference = 'SilentlyContinue'",
          `Invoke-WebRequest -Uri ${quotePowerShellSingle(installer.url)} -OutFile ${quotePowerShellSingle(installer.path)}`,
        ].join('; '),
      ],
      {
        cwd: app.getPath('userData'),
        log: {
          phase: 'antigravity_auth',
          label: 'download antigravity installer',
        },
      },
    );
    return;
  }

  await runCommand(
    'curl',
    ['-fsSL', '-o', installer.path, installer.url],
    {
      cwd: app.getPath('userData'),
      log: {
        phase: 'antigravity_auth',
        label: 'download antigravity installer',
      },
    },
  );
  await fs.chmod(installer.path, 0o700);
};

const runAntigravityInstaller = async (installer: ReturnType<typeof getAntigravityInstaller>): Promise<void> => {
  const binDir = getAntigravityBinDir();
  await fs.mkdir(binDir, { recursive: true });
  if (installer.id === 'windows') {
    await runCommand(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        installer.path,
        '-d',
        binDir,
      ],
      {
        cwd: app.getPath('userData'),
        log: {
          phase: 'antigravity_auth',
          label: 'install antigravity cli',
        },
      },
    );
    return;
  }

  await runCommand(
    'bash',
    [installer.path, '--dir', binDir],
    {
      cwd: app.getPath('userData'),
      log: {
        phase: 'antigravity_auth',
        label: 'install antigravity cli',
      },
    },
  );
};

const ensureAntigravityCliInstalled = async (): Promise<string> => {
  const existing = await resolveManagedAntigravityCliPath();
  if (existing) {
    return existing;
  }

  const installer = getAntigravityInstaller();
  await appendInstallLog('antigravity_auth:install_start', {
    platform: process.platform,
    installer: installer.id,
    targetDir: getAntigravityBinDir(),
  });
  try {
    await downloadAntigravityInstaller(installer);
    await runAntigravityInstaller(installer);
    const installed = await resolveManagedAntigravityCliPath();
    if (!installed) {
      throw new Error('antigravity_cli_install_failed');
    }
    await appendInstallLog('antigravity_auth:install_success', {
      platform: process.platform,
      installer: installer.id,
      targetDir: getAntigravityBinDir(),
      cliPath: installed,
    });
    return installed;
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'antigravity_cli_install_failed');
    await appendInstallLog('antigravity_auth:install_failed', {
      platform: process.platform,
      installer: installer.id,
      targetDir: getAntigravityBinDir(),
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    throw error;
  }
};

const getAntigravityAuthStatus = async (): Promise<AntigravityAuthStatus> => {
  const resolved = await resolveAntigravityCli();
  if (!resolved) {
    return {
      installed: false,
      authenticated: false,
      source: 'missing',
      userMessage: 'Google Antigravity no esta instalado en este equipo.',
    };
  }
  const versionResult = await runCommandCapture(resolved.path, ['--version'], { cwd: app.getPath('userData'), timeoutMs: 10_000 }).catch(() => null);
  const authenticated = await hasAntigravityLocalState();
  if (authenticated) {
    await markProviderConnected?.('antigravity');
  }
  return {
    installed: true,
    authenticated,
    source: resolved.source,
    antigravityCliPath: resolved.path,
    version: versionResult?.stdout.trim() || versionResult?.stderr.trim() || undefined,
    statusText: authenticated
      ? 'Local Antigravity auth state found. The agy CLI does not expose a non-interactive auth status command.'
      : 'Antigravity CLI installed. Connect Google Antigravity to confirm a local session.',
  };
};

const startAntigravityAuthSession = async (
  onEvent: (event: AntigravityAuthSessionEvent) => void,
): Promise<AntigravityAuthSessionStartResult & FailureDiagnosticFields> => {
  try {
    const currentStatus = await getAntigravityAuthStatus().catch(() => undefined);
    await appendInstallLog('antigravity_auth:session_start_requested', {
      installed: currentStatus?.installed,
      authenticated: currentStatus?.authenticated,
      source: currentStatus?.source,
      cliPath: currentStatus?.antigravityCliPath,
    });
    if (currentStatus?.authenticated) {
      return {
        success: true,
        userMessage: 'Google Antigravity ya está conectado en este equipo.',
        status: currentStatus,
      };
    }
    const resolved = await resolveAntigravityCli();
    const cliPath = resolved?.path ?? await ensureAntigravityCliInstalled();
    const source = resolved?.source ?? 'managed';
    const sessionId = randomUUID();
    const loginCwd = path.join(getTempRoot(), 'antigravity-auth-login');
    await fs.mkdir(loginCwd, { recursive: true });
    await appendInstallLog('antigravity_auth:session_spawn_start', {
      sessionId,
      source,
      cliPath,
      cwd: loginCwd,
      args: ['--print', '[probe-prompt]', '--print-timeout', '5m'],
    });
    const child = spawn(cliPath, ['--print', ANTIGRAVITY_AUTH_PROBE_PROMPT, '--print-timeout', '5m'], {
      cwd: loginCwd,
      env: {
        ...process.env,
      },
      shell: false,
      stdio: 'pipe',
    });
    activeAntigravityAuthSessions.set(sessionId, { child, completed: false });
    let outputChunks = 0;
    let urlEvents = 0;
    const openedUrls = new Set<string>();
    const silenceTimer = setTimeout(() => {
      void (async () => {
        await appendInstallLog('antigravity_auth:session_no_output', {
          sessionId,
          pid: child.pid,
          elapsedMs: 5_000,
          source,
          cliPath,
        });
        if (process.platform !== 'darwin') {
          onEvent({
            sessionId,
            type: 'output',
            stream: 'system',
            text: 'Antigravity CLI está ejecutándose, pero todavía no ha escrito salida. Si esto queda así, revisaremos el log diagnóstico.',
          });
          return;
        }
        const session = activeAntigravityAuthSessions.get(sessionId);
        if (!session || session.completed || outputChunks > 0) {
          return;
        }
        try {
          const terminal = await openMacAntigravityLoginTerminal({ cliPath, source, sessionId });
          session.completed = true;
          activeAntigravityAuthSessions.delete(sessionId);
          session.child.kill('SIGTERM');
          await appendInstallLog('antigravity_auth:terminal_fallback_opened', {
            sessionId,
            cliPath,
            source,
            loginLogPath: terminal.loginLogPath,
            loginScriptPath: terminal.loginScriptPath,
          });
          const status: AntigravityAuthStatus = {
            installed: true,
            authenticated: false,
            source,
            antigravityCliPath: cliPath,
            userMessage: 'Completa el login de Google Antigravity en Terminal.',
          };
          onEvent({
            sessionId,
            type: 'output',
            stream: 'system',
            text: 'Antigravity no entregó el link en la ventana interna. Abrimos Terminal para completar el login de Google.',
          });
          onEvent({
            sessionId,
            type: 'completed',
            stream: 'system',
            status,
            userMessage: 'Abrimos Terminal para completar la conexión local de Google Antigravity.',
          });
        } catch (error) {
          const diagnostic = failureDiagnostic(error, 'antigravity_terminal_fallback_failed');
          activeAntigravityAuthSessions.delete(sessionId);
          session.completed = true;
          session.child.kill('SIGTERM');
          await appendInstallLog('antigravity_auth:terminal_fallback_failed', {
            sessionId,
            detail: diagnostic.technicalCode,
            error: serializeErrorForInstallLog(error),
          });
          onEvent({
            sessionId,
            type: 'failed',
            stream: 'system',
            technicalCode: diagnostic.technicalCode,
            userMessage: 'No pudimos abrir Terminal para completar la conexión con Google Antigravity.',
          });
        }
      })();
    }, 5_000);
    const clearSilenceTimer = (): void => clearTimeout(silenceTimer);
    const emitOutput = (stream: 'stdout' | 'stderr', text: string): void => {
      outputChunks += 1;
      const urls = text.match(GOOGLE_OAUTH_URL_PATTERN) ?? [];
      urlEvents += urls.length;
      const redactedText = redactAntigravityAuthOutput(text);
      clearSilenceTimer();
      void appendInstallLog('antigravity_auth:session_output', {
        sessionId,
        stream,
        byteLength: Buffer.byteLength(text),
        urlCount: urls.length,
        preview: truncateForInstallLog(redactedText),
      });
      onEvent({ sessionId, type: 'output', stream, text: redactedText });
      for (const url of urls) {
        if (openedUrls.has(url)) {
          continue;
        }
        openedUrls.add(url);
        void shell.openExternal(url).catch((error) => {
          void appendInstallLog('antigravity_auth:open_external_failed', {
            sessionId,
            detail: failureDiagnostic(error, 'antigravity_open_external_failed').technicalCode,
            error: serializeErrorForInstallLog(error),
          });
        });
      }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => emitOutput('stdout', chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer | string) => emitOutput('stderr', chunk.toString()));
    child.on('error', (error) => {
      clearSilenceTimer();
      activeAntigravityAuthSessions.delete(sessionId);
      const diagnostic = failureDiagnostic(error, 'antigravity_auth_session_failed');
      void appendInstallLog('antigravity_auth:session_process_error', {
        sessionId,
        detail: diagnostic.technicalCode,
        error: serializeErrorForInstallLog(error),
      });
      onEvent({
        sessionId,
        type: 'failed',
        stream: 'system',
        text: error.message,
        technicalCode: diagnostic.technicalCode,
        userMessage: 'No pudimos iniciar la conexión con Google Antigravity.',
      });
    });
    child.on('exit', (code) => {
      clearSilenceTimer();
      const session = activeAntigravityAuthSessions.get(sessionId);
      activeAntigravityAuthSessions.delete(sessionId);
      if (session?.completed) {
        return;
      }
      void appendInstallLog('antigravity_auth:session_exit', {
        sessionId,
        code,
        outputChunks,
        urlEvents,
      });
      if (code === 0) {
        const status: AntigravityAuthStatus = {
          installed: true,
          authenticated: true,
          source,
          antigravityCliPath: cliPath,
          userMessage: 'Google Antigravity está conectado en este equipo.',
        };
        void markProviderConnected?.('antigravity');
        onEvent({ sessionId, type: 'completed', stream: 'system', exitCode: code, status, userMessage: status.userMessage });
        return;
      }
      onEvent({
        sessionId,
        type: 'failed',
        stream: 'system',
        exitCode: code,
        technicalCode: 'antigravity_auth_session_failed',
        userMessage: 'No pudimos completar la conexión con Google Antigravity.',
      });
    });
    onEvent({ sessionId, type: 'started', stream: 'system', text: `Google Antigravity connection started. pid=${child.pid ?? 'unknown'}` });
    return {
      success: true,
      sessionId,
      userMessage: 'Conexión de Google Antigravity iniciada.',
      status: {
        installed: true,
        authenticated: false,
        source,
        antigravityCliPath: cliPath,
      },
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'antigravity_auth_session_start_failed');
    await appendInstallLog('antigravity_auth:session_start_failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos iniciar la conexión con Google Antigravity.',
      ...diagnostic,
      status: await getAntigravityAuthStatus().catch(() => undefined),
    };
  }
};

const writeAntigravityAuthSession = async (sessionId: string, input: string): Promise<{ success: boolean; userMessage?: string } & FailureDiagnosticFields> => {
  const session = activeAntigravityAuthSessions.get(sessionId);
  if (!session?.child.stdin || session.child.stdin.destroyed) {
    return { success: false, userMessage: 'La sesión de conexión ya no está activa.', technicalCode: 'antigravity_auth_session_not_active' };
  }
  session.child.stdin.write(`${input}\n`);
  return { success: true };
};

const cancelAntigravityAuthSession = async (sessionId: string): Promise<{ success: boolean; userMessage?: string } & FailureDiagnosticFields> => {
  const session = activeAntigravityAuthSessions.get(sessionId);
  if (!session) {
    return { success: true };
  }
  session.completed = true;
  activeAntigravityAuthSessions.delete(sessionId);
  session.child.kill('SIGTERM');
  return { success: true };
};

const connectAntigravityAuth = async (): Promise<{ success: boolean; userMessage: string; status?: AntigravityAuthStatus } & FailureDiagnosticFields> => {
  try {
    const resolved = await resolveAntigravityCli();
    const cliPath = resolved?.path ?? await ensureAntigravityCliInstalled();
    const source = resolved?.source ?? 'managed';
    const currentStatus = await getAntigravityAuthStatus().catch(() => undefined);
    if (currentStatus?.authenticated) {
      return {
        success: true,
        userMessage: 'Google Antigravity ya está conectado en este equipo.',
        status: currentStatus,
      };
    }
    if (process.platform === 'darwin') {
      const terminal = await openMacAntigravityLoginTerminal({ cliPath, source });
      await appendInstallLog('antigravity_auth:terminal_opened', {
        platform: process.platform,
        cliPath,
        loginScriptPath: terminal.loginScriptPath,
        terminalCommand: terminal.terminalCommand,
        loginLogPath: terminal.loginLogPath,
      });
      return {
        success: true,
        userMessage: 'Abrimos Terminal para completar la conexión local de Google Antigravity.',
        status: {
          installed: true,
          authenticated: false,
          source,
          antigravityCliPath: cliPath,
          userMessage: 'Completa el login de Google Antigravity en Terminal.',
        },
      };
    }
    if (process.platform === 'win32') {
      const terminal = await openWindowsAntigravityLoginTerminal({ cliPath, source });
      await appendInstallLog('antigravity_auth:terminal_opened', {
        platform: process.platform,
        cliPath,
        loginScriptPath: terminal.loginScriptPath,
        terminalCommand: terminal.launchCommand,
        loginLogPath: terminal.loginLogPath,
      });
      return {
        success: true,
        userMessage: 'Abrimos una consola para completar la conexión local de Google Antigravity.',
        status: {
          installed: true,
          authenticated: false,
          source,
          antigravityCliPath: cliPath,
          userMessage: 'Completa el login de Google Antigravity en la consola.',
        },
      };
    }
    const loginCwd = path.join(getTempRoot(), 'antigravity-auth-login');
    await fs.mkdir(loginCwd, { recursive: true }).catch(() => undefined);
    await runCommand(cliPath, ['--print', ANTIGRAVITY_AUTH_PROBE_PROMPT, '--print-timeout', '5m'], {
      cwd: loginCwd,
      log: {
        phase: 'antigravity_auth',
        label: 'antigravity login',
      },
    });
    return {
      success: true,
      userMessage: 'Conexión de Google Antigravity iniciada.',
      status: await getAntigravityAuthStatus().catch(() => ({
        installed: true,
        authenticated: false,
        source,
        antigravityCliPath: cliPath,
      })),
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'antigravity_connect_failed');
    await appendInstallLog('antigravity_auth:failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos iniciar la conexión con Google Antigravity.',
      ...diagnostic,
      status: await getAntigravityAuthStatus().catch(() => undefined),
    };
  }
};

const reinstallAntigravity = async (): Promise<{ success: boolean; userMessage: string; status?: AntigravityAuthStatus } & FailureDiagnosticFields> => {
  try {
    await fs.rm(getAntigravityRoot(), { recursive: true, force: true });
    await ensureAntigravityCliInstalled();
    return {
      success: true,
      userMessage: 'Google Antigravity fue instalado por Forger. Si no hay sesión activa, conecta Google Antigravity para usarlo.',
      status: await getAntigravityAuthStatus().catch(() => undefined),
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'antigravity_reinstall_failed');
    await appendInstallLog('antigravity_auth:reinstall_failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos instalar Google Antigravity.',
      ...diagnostic,
      status: await getAntigravityAuthStatus().catch(() => undefined),
    };
  }
};

const disconnectAntigravityAuth = async (): Promise<{ success: boolean; userMessage: string; status?: AntigravityAuthStatus } & FailureDiagnosticFields> => {
  try {
    for (const session of activeAntigravityAuthSessions.values()) {
      session.completed = true;
      session.child.kill('SIGTERM');
    }
    activeAntigravityAuthSessions.clear();
    await markProviderDisconnected?.('antigravity');
    const status = await getAntigravityAuthStatus().catch(() => undefined);
    await appendInstallLog('antigravity_auth:disconnected', {
      authenticated: status?.authenticated,
      credentialScope: 'external_provider_state_preserved',
    });
    return {
      success: true,
      userMessage: status?.authenticated
        ? 'Forger dejó de usar Google Antigravity, pero la sesión local de Google sigue guardada en este computador.'
        : 'Google Antigravity fue desconectado en este equipo.',
      status,
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'antigravity_disconnect_failed');
    await appendInstallLog('antigravity_auth:disconnect_failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos desconectar Google Antigravity.',
      ...diagnostic,
      status: await getAntigravityAuthStatus().catch(() => undefined),
    };
  }
};

  return { getRuntimePathEntries, existsDirectory, getAppLocalToolPathEntries, getCodexToolEnvironment, resolveCodexCliPath, getInstalledCodexCliVersion, ensureCodexCliInstalled, buildManagedCodexAuthEnvironment, getCodexAuthStatus, connectCodexAuth, disconnectCodexAuth, reinstallCodex, getClaudeAuthStatus, connectClaudeAuth, disconnectClaudeAuth, reinstallClaude, resolveAntigravityCli, ensureAntigravityCliInstalled, getAntigravityAuthStatus, connectAntigravityAuth, startAntigravityAuthSession, writeAntigravityAuthSession, cancelAntigravityAuthSession, disconnectAntigravityAuth, reinstallAntigravity };
};
