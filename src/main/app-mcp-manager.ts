import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { mergePathEntries, spawnProcess } from './runtime/process-spawn';

export interface AppMcpInstalledAppRecord {
  appId: string;
  installDir: string;
  requiredPythonVersion: string;
}

export interface AppManifestMcp {
  type?: string;
  context?: string;
  command?: string;
  healthcheck?: string;
  environment?: Record<string, string>;
  toolTimeoutSec?: number;
}

export interface AppMcpManifest {
  mcp?: AppManifestMcp;
}

export interface RuntimeBinarySet {
  rootDir: string;
  node?: string;
  npm?: string;
  python?: string;
  pip?: string;
}

export interface CodexMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

type AppMcpStatus = 'down' | 'starting' | 'up' | 'shutting_down';

interface AppMcpState {
  appId: string;
  status: AppMcpStatus;
  listeners: Set<string>;
  generation: number;
  process?: ChildProcessWithoutNullStreams;
  url?: string;
  token?: string;
  tokenEnvVar?: string;
  toolTimeoutSec?: number;
  startPromise?: Promise<CodexMcpServerConfig | null>;
  stopPromise?: Promise<void>;
  stopTimer?: NodeJS.Timeout;
}

interface AppMcpManagerOptions {
  getInstalledApp: (appId: string) => AppMcpInstalledAppRecord | null | undefined;
  resolveInstalledManifest: (installDir: string) => Promise<AppMcpManifest | null>;
  ensureRuntimeInstalled: (type: 'python', version: string) => Promise<RuntimeBinarySet>;
  ensureBackendPythonEnvironment: (
    pythonPath: string,
    backendDir: string,
    appId: string,
    reason: string,
  ) => Promise<void>;
  getVenvExecutables: (backendDir: string) => { python: string; pip: string };
  getFreePort: () => Promise<number>;
  splitManifestCommand: (command: string | undefined) => string[];
  ensurePathInside: (rootPath: string, targetPath: string) => boolean;
  translateManifestEnvironment: (
    environment: Record<string, string>,
    backendDir: string,
  ) => Record<string, string>;
  ensureSqliteDatabaseParent: (environment: Record<string, string>) => Promise<void>;
  getDesktopRuntimeEnvironment?: (appId: string) => Record<string, string>;
  getRuntimePathEntries: (runtime: RuntimeBinarySet) => string[];
  getPathEntries?: (appId: string) => Promise<string[]>;
  waitForHttpOk: (url: string, timeoutMs: number) => Promise<void>;
  terminateProcess: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  truncateForInstallLog: (value: string) => string;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  onMcpStartFailed?: (input: { appId: string; runId: string; error: unknown }) => void;
}

export const findManifestMcp = (manifest: AppMcpManifest | null): AppManifestMcp | null => {
  if (!manifest?.mcp || typeof manifest.mcp !== 'object') {
    return null;
  }
  if (manifest.mcp.type && manifest.mcp.type !== 'http') return null;
  if (!manifest.mcp.command || typeof manifest.mcp.command !== 'string') {
    return null;
  }
  return manifest.mcp;
};

export class AppMcpManager {
  private readonly states = new Map<string, AppMcpState>();
  private readonly runListeners = new Map<string, Set<string>>();

  public constructor(private readonly options: AppMcpManagerOptions) {}

  public async listenMcps(appIds: string[], runId: string): Promise<CodexMcpServerConfig[]> {
    const configs = await Promise.all(
      Array.from(new Set(appIds)).map((appId) => this.listenOne(appId, runId)),
    );
    return configs.filter((config): config is CodexMcpServerConfig => Boolean(config));
  }

  public releaseMcps(runId: string): void {
    const appIds = this.runListeners.get(runId);
    if (!appIds) {
      return;
    }
    this.runListeners.delete(runId);
    for (const appId of appIds) {
      const state = this.states.get(appId);
      if (!state) {
        continue;
      }
      state.listeners.delete(runId);
      if (state.listeners.size === 0) {
        this.scheduleStop(state);
      }
    }
  }

  public dispose(): void {
    for (const state of this.states.values()) {
      if (state.stopTimer) {
        clearTimeout(state.stopTimer);
      }
      if (state.process) {
        void this.options.terminateProcess(state.process);
      }
    }
    this.states.clear();
    this.runListeners.clear();
  }

  private async listenOne(appId: string, runId: string): Promise<CodexMcpServerConfig | null> {
    const record = this.options.getInstalledApp(appId);
    if (!record?.installDir) {
      return null;
    }
    const manifest = await this.options.resolveInstalledManifest(record.installDir);
    const mcp = findManifestMcp(manifest);
    if (!mcp) {
      return null;
    }

    const state = this.getState(appId);
    state.listeners.add(runId);
    const runApps = this.runListeners.get(runId) ?? new Set<string>();
    runApps.add(appId);
    this.runListeners.set(runId, runApps);

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = undefined;
    }
    if (state.status === 'up' && state.url && state.token && state.tokenEnvVar) {
      return this.toConfig(state);
    }
    if (state.status === 'starting' && state.startPromise) {
      return await state.startPromise;
    }
    if (state.status === 'shutting_down' && state.stopPromise) {
      await state.stopPromise.catch(() => undefined);
    }
    if (state.status === 'up' && state.url && state.token && state.tokenEnvVar) {
      return this.toConfig(state);
    }
    state.startPromise = this.startOne(record, mcp, state, runId);
    return await state.startPromise;
  }

  private async startOne(
    record: AppMcpInstalledAppRecord,
    mcp: AppManifestMcp,
    state: AppMcpState,
    runId: string,
  ): Promise<CodexMcpServerConfig | null> {
    const generation = state.generation + 1;
    state.generation = generation;
    state.status = 'starting';
    try {
      const pythonRuntime = await this.options.ensureRuntimeInstalled('python', record.requiredPythonVersion);
      const backendDir = path.join(record.installDir, 'backend');
      await this.options.ensureBackendPythonEnvironment(
        pythonRuntime.python as string,
        backendDir,
        record.appId,
        'app_mcp_start',
      );
      const venv = this.options.getVenvExecutables(backendDir);
      const port = await this.options.getFreePort();
      const token = randomBytes(32).toString('hex');
      const config = this.buildProcessConfig(
        mcp,
        record,
        pythonRuntime.python as string,
        venv.python,
        port,
        token,
      );
      await this.options.ensureSqliteDatabaseParent(config.environment);
      const pathEntries = this.options.getPathEntries
        ? await this.options.getPathEntries(record.appId)
        : [path.dirname(venv.python), ...this.options.getRuntimePathEntries(pythonRuntime)];
      await this.options.appendInstallLog('app_mcp:start', {
        appId: record.appId,
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        url: config.url,
        healthUrl: config.healthUrl,
        pythonRuntime: pythonRuntime.rootDir,
      });
      const child = spawnProcess(config.command, config.args, {
        cwd: config.cwd,
        env: mergePathEntries({
          ...process.env,
          ...config.environment,
        }, pathEntries, path.delimiter),
        stdio: 'pipe',
      });
      let processStartErrorListener: ((error: Error) => void) | undefined;
      const processStartError = new Promise<never>((_, reject) => {
        processStartErrorListener = (error: Error) => {
          if (this.states.get(record.appId) === state && state.process === child) {
            state.process = undefined;
            state.url = undefined;
            state.token = undefined;
            state.tokenEnvVar = undefined;
            state.status = 'down';
          }
          reject(error);
        };
        child.once('error', processStartErrorListener);
      });
      child.stdout.on('data', (chunk) => {
        void this.options.appendInstallLog('app_mcp:stdout', {
          appId: record.appId,
          text: this.options.truncateForInstallLog(chunk.toString()),
        });
      });
      child.stderr.on('data', (chunk) => {
        void this.options.appendInstallLog('app_mcp:stderr', {
          appId: record.appId,
          text: this.options.truncateForInstallLog(chunk.toString()),
        });
      });
      child.once('exit', (code, signal) => {
        void this.options.appendInstallLog('app_mcp:exit', { appId: record.appId, code, signal });
        if (this.states.get(record.appId) === state && state.process === child) {
          state.process = undefined;
          state.url = undefined;
          state.token = undefined;
          state.tokenEnvVar = undefined;
          state.status = 'down';
        }
      });

      state.process = child;
      state.url = config.url;
      state.token = token;
      state.tokenEnvVar = config.tokenEnvVar;
      state.toolTimeoutSec = config.toolTimeoutSec;
      try {
        await Promise.race([
          this.options.waitForHttpOk(config.healthUrl, 30_000),
          processStartError,
        ]);
      } finally {
        if (processStartErrorListener) {
          child.off('error', processStartErrorListener);
        }
      }
      if (state.generation !== generation || state.listeners.size === 0) {
        await this.options.terminateProcess(child);
        state.status = 'down';
        return null;
      }
      state.status = 'up';
      await this.options.appendInstallLog('app_mcp:ready', { appId: record.appId, url: config.url });
      return this.toConfig(state);
    } catch (error) {
      await this.options.appendInstallLog('app_mcp:start_failed', {
        appId: record.appId,
        error: this.options.serializeErrorForInstallLog(error),
      });
      this.options.onMcpStartFailed?.({ appId: record.appId, runId, error });
      if (state.process) {
        await this.options.terminateProcess(state.process).catch(() => undefined);
      }
      state.process = undefined;
      state.url = undefined;
      state.token = undefined;
      state.tokenEnvVar = undefined;
      state.status = 'down';
      return null;
    } finally {
      state.startPromise = undefined;
    }
  }

  private buildProcessConfig(
    mcp: AppManifestMcp,
    record: AppMcpInstalledAppRecord,
    managedPython: string,
    venvPython: string,
    port: number,
    token: string,
  ): {
    command: string;
    args: string[];
    cwd: string;
    url: string;
    healthUrl: string;
    environment: Record<string, string>;
    tokenEnvVar: string;
    toolTimeoutSec: number;
  } {
    const rawArgs = this.options.splitManifestCommand(mcp.command);
    if (rawArgs.length === 0) {
      throw new Error('app_mcp_command_missing');
    }
    const backendDir = path.join(record.installDir, 'backend');
    const cwd = mcp.context ? path.resolve(path.join(record.installDir, mcp.context)) : backendDir;
    if (!this.options.ensurePathInside(record.installDir, cwd)) {
      throw new Error('app_mcp_context_outside_app');
    }
    const commandToken = rawArgs[0];
    let command = commandToken;
    if (commandToken === 'uv') {
      command = managedPython;
    } else if (commandToken === 'python' || commandToken === 'python3') {
      command = venvPython;
    }
    const args = commandToken === 'uv'
      ? ['-m', 'uv', ...rawArgs.slice(1)]
      : rawArgs.slice(1);
    const healthcheck = normalizeHealthcheckPath(mcp.healthcheck);
    const url = `http://127.0.0.1:${port}/mcp`;
    const tokenEnvVar = safeMcpTokenEnvVar(record.appId);
    const manifestEnvironment = mcp.environment && typeof mcp.environment === 'object' ? mcp.environment : {};
    const environment = translateMcpEnvironment(
      manifestEnvironment,
      backendDir,
      cwd,
      this.options.translateManifestEnvironment,
    );
    const uvEnvironment: Record<string, string> = commandToken === 'uv'
      ? {
          UV_PROJECT_ENVIRONMENT: path.join(backendDir, '.venv'),
          UV_PYTHON: managedPython,
        }
      : {};
    return {
      command,
      args,
      cwd,
      url,
      healthUrl: `http://127.0.0.1:${port}${healthcheck}`,
      environment: {
        ...environment,
        ...uvEnvironment,
        ...(this.options.getDesktopRuntimeEnvironment?.(record.appId) ?? {}),
        HOST: '127.0.0.1',
        PORT: String(port),
        FORGER_APP_ID: record.appId,
        FORGER_APP_MCP_TOKEN: token,
        [tokenEnvVar]: token,
      },
      tokenEnvVar,
      toolTimeoutSec: Math.max(1, Math.floor(mcp.toolTimeoutSec ?? 600)),
    };
  }

  private scheduleStop(state: AppMcpState): void {
    if (state.stopTimer || state.status === 'down') {
      return;
    }
    state.stopTimer = setTimeout(() => {
      state.stopTimer = undefined;
      if (state.listeners.size === 0) {
        state.stopPromise = this.stopOne(state);
      }
    }, 1_000);
  }

  private async stopOne(state: AppMcpState): Promise<void> {
    if (state.listeners.size > 0) {
      return;
    }
    if (state.status === 'starting' && state.startPromise) {
      await state.startPromise.catch(() => null);
      if (state.listeners.size > 0) {
        return;
      }
    }
    const child = state.process;
    state.status = 'shutting_down';
    state.generation += 1;
    if (child) {
      await this.options.appendInstallLog('app_mcp:stop', { appId: state.appId });
      await this.options.terminateProcess(child).catch(() => undefined);
    }
    if (state.listeners.size === 0) {
      state.process = undefined;
      state.url = undefined;
      state.token = undefined;
      state.tokenEnvVar = undefined;
      state.status = 'down';
    } else {
      state.status = 'down';
    }
    state.stopPromise = undefined;
  }

  private getState(appId: string): AppMcpState {
    const existing = this.states.get(appId);
    if (existing) {
      return existing;
    }
    const state: AppMcpState = {
      appId,
      status: 'down',
      listeners: new Set<string>(),
      generation: 0,
    };
    this.states.set(appId, state);
    return state;
  }

  private toConfig(state: AppMcpState): CodexMcpServerConfig | null {
    if (!state.url || !state.token || !state.tokenEnvVar) {
      return null;
    }
    return {
      name: safeMcpServerName(state.appId),
      url: state.url,
      token: state.token,
      tokenEnvVar: state.tokenEnvVar,
      toolTimeoutSec: state.toolTimeoutSec,
    };
  }
}

const safeMcpServerName = (appId: string): string =>
  `app_${appId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

const safeMcpTokenEnvVar = (appId: string): string =>
  `FORGER_APP_MCP_TOKEN_${appId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;

const translateMcpEnvironment = (
  environment: Record<string, string>,
  backendDir: string,
  cwd: string,
  translateManifestEnvironment: (
    environment: Record<string, string>,
    backendDir: string,
  ) => Record<string, string>,
): Record<string, string> => {
  const translated = translateManifestEnvironment(environment, backendDir);
  if (typeof translated.PYTHONPATH === 'string' && translated.PYTHONPATH.trim()) {
    const entries = translated.PYTHONPATH.split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.isAbsolute(entry) ? entry : path.resolve(cwd, entry));
    translated.PYTHONPATH = entries.join(path.delimiter);
  }
  return translated;
};

const normalizeHealthcheckPath = (healthcheck: string | undefined): string => {
  const value = healthcheck?.trim() || '/health';
  return value.startsWith('/') ? value : `/${value}`;
};
