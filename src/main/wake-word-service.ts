import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type fs from 'node:fs/promises';
import type path from 'node:path';

import type {
  WakeWordConfig,
  WakeWordConfigInput,
  WakeWordDiagnosticEvent,
  WakeWordDetectionEvent,
  WakeWordModel,
  WakeWordRuntime,
  WakeWordSession,
  WakeWordState,
} from '../shared/types';
import type { RuntimeBinarySet } from './core/main-process-types';
import { killProcessTree, killServiceProcessesForMetadataRoot } from './app-agent/process';

interface WakeWordServiceDeps {
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  fs: typeof fs;
  getFreePort: () => Promise<number>;
  getMetadataRoot: () => string;
  getServiceSourcePath: () => string;
  path: typeof path;
  runCommand: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<void>;
  onWakeDetected?: (event: WakeWordDetectionEvent) => void;
}

interface WakeInstallState {
  installed: boolean;
  dependencyIssues: Array<{ code: string; dependency: string; repairable: boolean }>;
  repairRequired: boolean;
}

const INSTALL_SCHEMA_VERSION = 1;
const REQUIRED_DEPENDENCIES = ['fastapi', 'uvicorn', 'openwakeword', 'onnxruntime', 'numpy'];
const DEFAULT_MODEL_ID = 'hey jarvis';

const WAKE_MODELS: WakeWordModel[] = [
  { id: 'hey jarvis', displayName: 'Hey Jarvis', source: 'openwakeword-pretrained', installedAt: 'bundled', thresholdDefault: 0.5 },
  { id: 'hey mycroft', displayName: 'Hey Mycroft', source: 'openwakeword-pretrained', installedAt: 'bundled', thresholdDefault: 0.5 },
  { id: 'alexa', displayName: 'Alexa', source: 'openwakeword-pretrained', installedAt: 'bundled', thresholdDefault: 0.5 },
  { id: 'hey rhasspy', displayName: 'Hey Rhasspy', source: 'openwakeword-pretrained', installedAt: 'bundled', thresholdDefault: 0.5 },
];

const MODEL_IDS = new Set(WAKE_MODELS.map((model) => model.id));
const MODEL_ALIASES = new Map([
  ['hey_jarvis', 'hey jarvis'],
  ['hey_mycroft', 'hey mycroft'],
  ['hey_rhasspy', 'hey rhasspy'],
]);

const DEFAULT_CONFIG: WakeWordConfig = {
  enabled: false,
  deviceId: '',
  modelId: DEFAULT_MODEL_ID,
  threshold: 0.5,
  patience: 2,
  cooldownMs: 2500,
};

const cleanId = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, 160) : '';

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const normalizeModelId = (value: unknown): string => {
  const raw = cleanId(value);
  const modelId = MODEL_ALIASES.get(raw) ?? raw;
  return modelId && MODEL_IDS.has(modelId) ? modelId : DEFAULT_MODEL_ID;
};

export const normalizeWakeWordConfig = (input?: Partial<WakeWordConfig> | null): WakeWordConfig => ({
  enabled: input?.enabled === true,
  deviceId: cleanId(input?.deviceId),
  modelId: normalizeModelId(input?.modelId),
  threshold: clampNumber(input?.threshold, DEFAULT_CONFIG.threshold, 0.05, 0.99),
  patience: Math.round(clampNumber(input?.patience, DEFAULT_CONFIG.patience, 1, 8)),
  cooldownMs: Math.round(clampNumber(input?.cooldownMs, DEFAULT_CONFIG.cooldownMs, 250, 60_000)),
});

export class WakeWordServiceManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private config: WakeWordConfig = DEFAULT_CONFIG;
  private lastDetection: WakeWordDetectionEvent | undefined;
  private lastError: string | undefined;
  private port: number | null = null;
  private runtime: WakeWordRuntime = { state: 'idle', modelId: DEFAULT_MODEL_ID, updatedAt: new Date(0).toISOString() };
  private startPromise: Promise<WakeWordState> | null = null;
  private starting = false;
  private token: string | null = null;

  constructor(private readonly deps: WakeWordServiceDeps) {}

  async load(): Promise<void> {
    this.config = await this.readConfig();
  }

  async install(): Promise<WakeWordState> {
    const runtime = await this.deps.ensureRuntimeInstalled('python', '3.12');
    const root = this.root();
    await this.deps.fs.mkdir(root, { recursive: true });
    await this.deps.runCommand(runtime.python as string, ['-m', 'venv', this.venvPath()], {
      cwd: root,
      env: process.env,
      label: 'create wake word venv',
    });
    const python = this.venvPythonPath();
    await this.deps.runCommand(python, ['-m', 'pip', 'install', '--upgrade', 'pip', 'fastapi', 'uvicorn[standard]', 'openwakeword', 'onnxruntime', 'numpy'], {
      cwd: root,
      env: this.pythonEnv(),
      label: 'install wake word dependencies',
    });
    await this.validateInstallDependencies(python);
    await this.deps.fs.writeFile(this.installedMarkerPath(), JSON.stringify({
      installedAt: new Date().toISOString(),
      schemaVersion: INSTALL_SCHEMA_VERSION,
      dependencies: REQUIRED_DEPENDENCIES,
    }, null, 2), 'utf8');
    return await this.getState();
  }

  async startIfConfigured(): Promise<WakeWordState> {
    await this.load();
    if (!this.config.enabled) return await this.getState();
    return await this.start();
  }

  async start(): Promise<WakeWordState> {
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return await this.startPromise;
  }

  private async startInternal(): Promise<WakeWordState> {
    await this.load();
    const installState = await this.getInstallState();
    if (!installState.installed || installState.repairRequired) {
      if (installState.repairRequired) this.lastError = 'wake_word_repair_required';
      return await this.getState();
    }
    if (this.child && this.port && this.token) return await this.getState();
    this.starting = true;
    this.runtime = { state: 'starting', modelId: this.config.modelId, updatedAt: new Date().toISOString() };
    const root = this.root();
    await this.deps.fs.mkdir(root, { recursive: true });
    killServiceProcessesForMetadataRoot(this.deps.getServiceSourcePath(), root);
    const port = await this.deps.getFreePort();
    const token = randomBytes(24).toString('hex');
    const child = spawn(this.venvPythonPath(), [
      this.deps.getServiceSourcePath(),
      '--port', String(port),
      '--metadata-root', root,
      '--log-path', this.serviceLogPath(),
      '--parent-pid', String(process.pid),
    ], {
      cwd: root,
      env: { ...this.pythonEnv(), FORGER_WAKE_WORD_TOKEN: token, PYTHONUNBUFFERED: '1' },
      stdio: 'pipe',
      detached: false,
    });
    this.child = child;
    this.port = port;
    this.token = token;
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.lastError = code === 0 || code === null ? undefined : `wake_word_server_exited_${code}`;
      this.child = null;
      this.port = null;
      this.token = null;
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.lastError = error.message || 'wake_word_spawn_failed';
      this.child = null;
      this.port = null;
      this.token = null;
    });
    child.stderr.on('data', (chunk) => {
      void this.deps.appendInstallLog('wake_word:stderr', { text: String(chunk).trim().slice(0, 2000) });
    });
    try {
      await this.waitForHealth(20_000);
      this.lastError = undefined;
      this.runtime = {
        state: 'waiting_for_audio_session',
        modelId: this.config.modelId,
        updatedAt: new Date().toISOString(),
        technicalCode: 'wake_word_audio_session_pending',
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'wake_word_health_failed';
      this.stop();
    }
    this.starting = false;
    return await this.getState();
  }

  stop(): void {
    killProcessTree(this.child ?? undefined);
    this.child = null;
    this.port = null;
    this.starting = false;
    this.token = null;
    this.runtime = { state: 'idle', modelId: this.config.modelId, updatedAt: new Date().toISOString() };
  }

  async updateConfig(input: WakeWordConfigInput): Promise<WakeWordState> {
    await this.load();
    const previous = this.config;
    this.config = normalizeWakeWordConfig({ ...this.config, ...input });
    await this.writeConfig();
    if (this.config.enabled && !this.child) {
      return await this.start();
    }
    if (!this.config.enabled && this.child) {
      this.stop();
    } else if (this.child && this.requiresSessionRestart(previous, this.config)) {
      this.runtime = {
        state: 'waiting_for_audio_session',
        modelId: this.config.modelId,
        updatedAt: new Date().toISOString(),
        technicalCode: 'wake_word_audio_session_pending',
      };
    }
    return await this.getState();
  }

  async createSession(): Promise<WakeWordSession> {
    const state = await this.start();
    if (!state.running || !this.port || !this.token) {
      throw new Error(state.repairRequired ? 'wake_word_repair_required' : state.installed ? 'wake_word_not_running' : 'wake_word_not_installed');
    }
    return {
      sessionId: randomUUID(),
      url: `ws://127.0.0.1:${this.port}/v1/wake-word/listen`,
      token: this.token,
      sampleRate: 16000,
      format: 'pcm_s16le',
      config: this.config,
    };
  }

  async recordReady(input: Partial<WakeWordRuntime> = {}): Promise<WakeWordState> {
    await this.load();
    this.lastError = undefined;
    this.runtime = {
      state: 'ready',
      modelId: cleanId(input.modelId) || this.config.modelId,
      updatedAt: new Date().toISOString(),
      ...(typeof input.confidence === 'number' ? { confidence: clampNumber(input.confidence, 0, 0, 1) } : {}),
    };
    return await this.getState();
  }

  async recordUnavailable(input: Partial<WakeWordRuntime> = {}): Promise<WakeWordState> {
    await this.load();
    const technicalCode = cleanId(input.technicalCode);
    this.lastError = technicalCode || this.lastError;
    this.runtime = {
      state: 'unavailable',
      modelId: cleanId(input.modelId) || this.config.modelId,
      updatedAt: new Date().toISOString(),
      ...(technicalCode ? { technicalCode } : {}),
    };
    return await this.getState();
  }

  async recordConfidence(input: Partial<WakeWordRuntime> = {}): Promise<WakeWordState> {
    await this.load();
    this.runtime = {
      state: this.runtime.state === 'detected' ? 'detected' : 'ready',
      modelId: cleanId(input.modelId) || this.config.modelId,
      updatedAt: new Date().toISOString(),
      confidence: clampNumber(input.confidence, 0, 0, 1),
    };
    return await this.getState();
  }

  async recordDetected(input: { deviceId?: string; modelId?: string; confidence?: number } = {}): Promise<WakeWordState> {
    await this.load();
    const event: WakeWordDetectionEvent = {
      id: randomUUID(),
      deviceId: cleanId(input.deviceId) || this.config.deviceId || 'default',
      modelId: cleanId(input.modelId) || this.config.modelId,
      confidence: clampNumber(input.confidence, 1, 0, 1),
      detectedAt: new Date().toISOString(),
    };
    this.lastDetection = event;
    this.lastError = undefined;
    this.runtime = { state: 'detected', modelId: event.modelId, confidence: event.confidence, updatedAt: event.detectedAt };
    void this.deps.appendInstallLog('wake_word:detected', {
      deviceId: event.deviceId,
      modelId: event.modelId,
      confidence: event.confidence,
    });
    this.deps.onWakeDetected?.(event);
    return await this.getState();
  }

  async recordDiagnostic(input: WakeWordDiagnosticEvent): Promise<WakeWordState> {
    await this.load();
    const event = cleanId(input.event) || 'diagnostic';
    void this.deps.appendInstallLog(`wake_word:renderer:${event}`, {
      modelId: cleanId(input.modelId) || this.config.modelId,
      deviceId: cleanId(input.deviceId) || this.config.deviceId || 'default',
      technicalCode: cleanId(input.technicalCode),
      generation: typeof input.generation === 'number' ? input.generation : undefined,
      socketState: cleanId(input.socketState),
      audioTrackCount: typeof input.audioTrackCount === 'number' ? input.audioTrackCount : undefined,
      sampleRate: typeof input.sampleRate === 'number' ? input.sampleRate : undefined,
      frameBytes: typeof input.frameBytes === 'number' ? input.frameBytes : undefined,
    });
    return await this.getState();
  }

  async getState(): Promise<WakeWordState> {
    await this.load();
    const installState = await this.getInstallState();
    const running = Boolean(this.child && this.port && this.token);
    const status = this.lastError
      ? 'error'
      : this.runtime.state === 'detected'
        ? 'detected'
        : this.runtime.state === 'ready'
          ? 'ready'
          : running
            ? 'listening'
            : this.starting
              ? 'starting'
              : installState.installed
                ? 'installed'
                : 'not_installed';
    return {
      status,
      installed: installState.installed,
      running,
      repairRequired: installState.repairRequired,
      config: this.config,
      models: WAKE_MODELS,
      runtime: this.runtime,
      dependencyIssues: installState.dependencyIssues,
      ...(this.lastDetection ? { lastDetection: this.lastDetection } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private requiresSessionRestart(previous: WakeWordConfig, next: WakeWordConfig): boolean {
    return previous.deviceId !== next.deviceId
      || previous.modelId !== next.modelId
      || previous.threshold !== next.threshold
      || previous.patience !== next.patience
      || previous.cooldownMs !== next.cooldownMs;
  }

  private root(): string {
    return this.deps.path.join(this.deps.getMetadataRoot(), 'wake-word');
  }

  private configPath(): string {
    return this.deps.path.join(this.root(), 'config.json');
  }

  private installedMarkerPath(): string {
    return this.deps.path.join(this.root(), 'installed.json');
  }

  private logRoot(): string {
    return this.deps.path.join(this.root(), 'logs');
  }

  private serviceLogPath(): string {
    return this.deps.path.join(this.logRoot(), 'server.jsonl');
  }

  private modelCacheRoot(): string {
    return this.deps.path.join(this.root(), 'models');
  }

  private venvPath(): string {
    return this.deps.path.join(this.root(), '.venv');
  }

  private venvPythonPath(): string {
    return process.platform === 'win32'
      ? this.deps.path.join(this.venvPath(), 'Scripts', 'python.exe')
      : this.deps.path.join(this.venvPath(), 'bin', 'python');
  }

  private pythonEnv(): Record<string, string | undefined> {
    return {
      ...process.env,
      HF_HOME: this.modelCacheRoot(),
      XDG_CACHE_HOME: this.deps.path.join(this.root(), 'cache'),
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    };
  }

  private async readConfig(): Promise<WakeWordConfig> {
    try {
      return normalizeWakeWordConfig(JSON.parse(await this.deps.fs.readFile(this.configPath(), 'utf8')) as Partial<WakeWordConfig>);
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  private async writeConfig(): Promise<void> {
    await this.deps.fs.mkdir(this.root(), { recursive: true });
    await this.deps.fs.writeFile(this.configPath(), JSON.stringify(this.config, null, 2), 'utf8');
  }

  private async getInstallState(): Promise<WakeInstallState> {
    try {
      const marker = JSON.parse(await this.deps.fs.readFile(this.installedMarkerPath(), 'utf8')) as { schemaVersion?: number; dependencies?: unknown[] };
      const dependencies = new Set((Array.isArray(marker.dependencies) ? marker.dependencies : []).filter((dependency): dependency is string => typeof dependency === 'string'));
      const missing = marker.schemaVersion === INSTALL_SCHEMA_VERSION
        ? REQUIRED_DEPENDENCIES.filter((dependency) => !dependencies.has(dependency))
        : REQUIRED_DEPENDENCIES;
      return {
        installed: true,
        dependencyIssues: missing.map((dependency) => ({ code: 'wake_word_dependency_missing', dependency, repairable: true })),
        repairRequired: missing.length > 0,
      };
    } catch {
      return { installed: false, dependencyIssues: [], repairRequired: false };
    }
  }

  private async validateInstallDependencies(python: string): Promise<void> {
    await this.deps.runCommand(python, ['-c', 'import fastapi, uvicorn, openwakeword, onnxruntime, numpy'], {
      cwd: this.root(),
      env: this.pythonEnv(),
      label: 'validate wake word dependencies',
    });
  }

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        await this.fetchJson('/health');
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error('wake_word_health_timeout');
  }

  private async fetchJson(pathname: string): Promise<unknown> {
    if (!this.port || !this.token) throw new Error('wake_word_not_running');
    const response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`wake_word_http_${response.status}`);
    return await response.json();
  }
}
