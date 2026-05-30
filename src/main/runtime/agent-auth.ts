import type { spawn as spawnFn } from 'node:child_process';
import type fs from 'node:fs/promises';
import type path from 'node:path';

import type {
  AppManifest,
  AppManifestService,
  AppRegistry,
  InstalledAppRecord,
  RuntimeBinarySet,
} from '../core/main-process-types';
import type {
  ClaudeAuthStatus,
  CodexAuthStatus,
  FailureDiagnosticFields,
} from '../../shared/types';

interface CommandCaptureResult {
  code?: number | null;
  stdout: string;
  stderr: string;
}

interface AgentAuthDeps {
  CLAUDE_CODE_VERSION: string;
  CODEX_CLI_VERSION: string;
  DEFAULT_NODE_VERSION: string;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  app: Electron.App;
  buildCodexAuthEnvironment: (input: { codexHome: string; codexCliPath: string; nodePathEntries: string[] }) => NodeJS.ProcessEnv;
  buildMacTerminalLoginScript: (input: { providerName: string; logPath: string; command: string[] }) => string;
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
  getCodexHome: () => string;
  getCodexRoot: () => string;
  getForgerMetadataRoot: () => string;
  getLogsRoot: () => string;
  getTempRoot: () => string;
  markProviderConnected?: (provider: 'codex' | 'claude') => Promise<void> | void;
  path: typeof path;
  registry: AppRegistry;
  resolveInstalledManifest: (installDir: string) => Promise<AppManifest | null>;
  runCommand: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<void>;
  runCommandCapture: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<CommandCaptureResult>;
  serializeErrorForInstallLog: (error: unknown) => { message?: unknown } & Record<string, unknown>;
  shell: Electron.Shell;
  spawn: typeof spawnFn;
  translateManifestEnvironment: (environment: Record<string, string>, backendDir: string) => Record<string, string>;
  truncateForInstallLog: (value: string) => string;
}

export const createAgentAuthController = (deps: AgentAuthDeps) => {
  const { path, fs, spawn, app, getCodexHome, getForgerMetadataRoot, registry, resolveInstalledManifest, findManifestService, translateManifestEnvironment, ensureRuntimeInstalled, DEFAULT_NODE_VERSION, getCodexRoot, CODEX_CLI_VERSION, runCommand, runCommandCapture, buildCodexAuthEnvironment, classifyCodexAuthOutput, extractAllowedCodexAuthUrls, appendInstallLog, getLogsRoot, getTempRoot, serializeErrorForInstallLog, shell, buildMacTerminalLoginScript, buildMacTerminalScriptLaunchCommand, failureDiagnostic, CLAUDE_CODE_VERSION, getClaudeRoot, canRunCommand, markProviderConnected, findExistingFile, truncateForInstallLog } = deps;
const escapeWindowsBatchValue = (value: string): string => value.replace(/%/g, '%%').replace(/"/g, '""');
const quotePowerShellSingle = (value: string): string => `'${value.replace(/'/g, "''")}'`;

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

  if (authenticated) {
    await markProviderConnected?.('codex');
  }

  return {
    installed: Boolean(codexCliPath),
    authenticated,
    authFilePath,
    codexHome,
    codexCliPath: codexCliPath ?? undefined,
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

    await runCommand(codexCliPath, ['login'], {
      cwd: app.getPath('userData'),
      env: {
        CODEX_HOME: codexHome,
      },
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

  return { getRuntimePathEntries, existsDirectory, getAppLocalToolPathEntries, getCodexToolEnvironment, resolveCodexCliPath, getInstalledCodexCliVersion, ensureCodexCliInstalled, buildManagedCodexAuthEnvironment, getCodexAuthStatus, connectCodexAuth, disconnectCodexAuth, reinstallCodex, getClaudeAuthStatus, connectClaudeAuth, reinstallClaude };
};
