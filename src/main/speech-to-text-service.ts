import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type fs from 'node:fs/promises';
import type path from 'node:path';

import type {
  SpeechToTextConfig,
  SpeechToTextConfigInput,
  SpeechToTextDependencyIssue,
  SpeechToTextJob,
  SpeechToTextModelWorker,
  SpeechToTextModelWorkerStatus,
  SpeechToTextModelOption,
  SpeechToTextProcessInput,
  SpeechToTextProcessResult,
  SpeechToTextProcessedFile,
  SpeechToTextState,
  SpeechToTextTask,
  SpeechToTextUploadInput,
  SpeechToTextRealtimeSession,
} from '../shared/types';
import type { RuntimeBinarySet } from './core/main-process-types';
import { killProcessTree, killServiceProcessesForMetadataRoot } from './app-agent/process';

const DEFAULT_CONFIG: SpeechToTextConfig = {
  model: 'base',
  maxConcurrentJobs: 1,
  maxRealtimeSessions: 3,
  autoStart: false,
};

const MODEL_OPTIONS = ['tiny', 'base', 'small', 'medium', 'large-v3'];
const ON_DEMAND_MODEL_IDLE_TIMEOUT_MS = 60_000;
const INSTALL_SCHEMA_VERSION = 3;
const REQUIRED_DEPENDENCIES = ['fastapi', 'uvicorn', 'python-multipart', 'faster-whisper'];

interface SpeechToTextServiceDeps {
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  fs: typeof fs;
  getFreePort: () => Promise<number>;
  getMetadataRoot: () => string;
  getPrivateAppsRoot: () => string;
  getPrivateDataRoot: () => string;
  getServiceSourcePath: () => string;
  path: typeof path;
  runCommand: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<void>;
  onDemandModelIdleTimeoutMs?: number;
}

interface SpeechAccess {
  appId?: string;
  appInstallDir?: string;
  appAllowsSpeechToText?: boolean;
  extraAllowedRoots?: string[];
  ephemeral?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

class SpeechToTextHttpError extends Error {
  constructor(readonly status: number, readonly payload?: SpeechToTextProcessResult) {
    super(payload?.technicalCode ?? `speech_http_${status}`);
  }
}

interface SpeechWorkerRef {
  model: string;
  child: ChildProcessWithoutNullStreams | null;
  port: number | null;
  token: string | null;
  status: SpeechToTextModelWorkerStatus;
  pinned: boolean;
  activeJobs: number;
  queuedJobs: number;
  lastUsedAt?: string;
  technicalCode?: string;
  startPromise?: Promise<SpeechWorkerRef>;
  idleTimer?: NodeJS.Timeout;
}

interface SpeechInstallState {
  installed: boolean;
  dependencyIssues: SpeechToTextDependencyIssue[];
  repairRequired: boolean;
}

const normalizeConfig = (input?: SpeechToTextConfigInput | null): SpeechToTextConfig => ({
  model: typeof input?.model === 'string' && input.model.trim() ? input.model.trim() : DEFAULT_CONFIG.model,
  maxConcurrentJobs: Number.isFinite(input?.maxConcurrentJobs) ? Math.max(1, Math.min(8, Math.floor(Number(input?.maxConcurrentJobs)))) : DEFAULT_CONFIG.maxConcurrentJobs,
  maxRealtimeSessions: Number.isFinite(input?.maxRealtimeSessions) ? Math.max(1, Math.min(16, Math.floor(Number(input?.maxRealtimeSessions)))) : DEFAULT_CONFIG.maxRealtimeSessions,
  autoStart: input?.autoStart === true,
});

const normalizeTask = (task: unknown): SpeechToTextTask => task === 'translate' ? 'translate' : 'transcribe';
const normalizeModel = (model: unknown, fallback: string): string => {
  const cleaned = typeof model === 'string' ? model.trim() : '';
  return MODEL_OPTIONS.includes(cleaned) ? cleaned : fallback;
};

const asJobs = (value: unknown): SpeechToTextJob[] =>
  isRecord(value) && Array.isArray(value.jobs) ? value.jobs.filter(isRecord).map<SpeechToTextJob>((job) => ({
    id: String(job.id ?? ''),
    task: normalizeTask(job.task),
    path: String(job.path ?? ''),
    status: job.status === 'queued' || job.status === 'running' || job.status === 'completed' || job.status === 'failed' ? job.status : 'failed',
    createdAt: String(job.createdAt ?? ''),
    updatedAt: String(job.updatedAt ?? ''),
    ...(typeof job.durationSeconds === 'number' ? { durationSeconds: job.durationSeconds } : {}),
    ...(typeof job.sizeBytes === 'number' ? { sizeBytes: job.sizeBytes } : {}),
    ...(typeof job.language === 'string' ? { language: job.language } : {}),
    ...(typeof job.model === 'string' ? { model: job.model } : {}),
    ...(typeof job.text === 'string' ? { text: job.text } : {}),
    ...(typeof job.error === 'string' ? { error: job.error } : {}),
    ...(typeof job.technicalCode === 'string' ? { technicalCode: job.technicalCode } : {}),
  })).filter((job) => job.id && job.path) : [];

const asProcessedFiles = (value: unknown): SpeechToTextProcessedFile[] =>
  isRecord(value) && Array.isArray(value.processedFiles) ? value.processedFiles.filter(isRecord).map<SpeechToTextProcessedFile>((item) => ({
    path: String(item.path ?? ''),
    task: normalizeTask(item.task),
    processedAt: String(item.processedAt ?? ''),
    ...(typeof item.durationSeconds === 'number' ? { durationSeconds: item.durationSeconds } : {}),
    ...(typeof item.sizeBytes === 'number' ? { sizeBytes: item.sizeBytes } : {}),
    ...(typeof item.language === 'string' ? { language: item.language } : {}),
    ...(typeof item.model === 'string' ? { model: item.model } : {}),
    ...(typeof item.textPreview === 'string' ? { textPreview: item.textPreview } : {}),
  })).filter((item) => item.path) : [];

export class SpeechToTextServiceManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private config: SpeechToTextConfig = DEFAULT_CONFIG;
  private lastError: string | undefined;
  private port: number | null = null;
  private readonly explicitlyAllowedPaths = new Set<string>();
  private ephemeralUploadCleanupPromise: Promise<void> | null = null;
  private readonly modelWorkers = new Map<string, SpeechWorkerRef>();
  private startPromise: Promise<SpeechToTextState> | null = null;
  private starting = false;
  private token: string | null = null;

  constructor(private readonly deps: SpeechToTextServiceDeps) {}

  async load(): Promise<void> {
    this.config = await this.readConfig();
    await this.prepareEphemeralUploadRoot().catch(async (error: unknown) => {
      await this.appendServiceLog('ephemeral_upload_cleanup_failed', {
        technicalCode: error instanceof Error ? error.message : 'speech_ephemeral_upload_cleanup_failed',
      });
    });
  }

  async install(): Promise<SpeechToTextState> {
    const runtime = await this.deps.ensureRuntimeInstalled('python', '3.12');
    const root = this.root();
    await this.deps.fs.mkdir(root, { recursive: true });
    await this.deps.runCommand(runtime.python as string, ['-m', 'venv', this.venvPath()], {
      cwd: root,
      env: process.env,
      label: 'create speech to text venv',
    });
    const python = this.venvPythonPath();
    await this.deps.runCommand(python, ['-m', 'pip', 'install', '--upgrade', 'pip', 'fastapi', 'uvicorn[standard]', 'python-multipart', 'faster-whisper'], {
      cwd: root,
      env: {
        ...process.env,
        HF_HOME: this.modelCacheRoot(),
        XDG_CACHE_HOME: this.deps.path.join(this.root(), 'cache'),
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
      label: 'install speech to text dependencies',
    });
    await this.validateInstallDependencies(python);
    await this.deps.fs.writeFile(this.installedMarkerPath(), JSON.stringify({
      installedAt: new Date().toISOString(),
      schemaVersion: INSTALL_SCHEMA_VERSION,
      dependencies: REQUIRED_DEPENDENCIES,
    }, null, 2), 'utf8');
    await this.start();
    return await this.getState();
  }

  async startIfConfigured(): Promise<SpeechToTextState> {
    await this.load();
    const installState = await this.getInstallState();
    if (!this.config.autoStart || !installState.installed || installState.repairRequired) {
      return await this.getState();
    }
    return await this.start();
  }

  async start(): Promise<SpeechToTextState> {
    if (this.startPromise) {
      return await this.startPromise;
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return await this.startPromise;
  }

  private async startInternal(): Promise<SpeechToTextState> {
    await this.load();
    if (this.child && this.port && this.token) {
      return await this.getState();
    }
    const installState = await this.getInstallState();
    if (!installState.installed || installState.repairRequired) {
      if (installState.repairRequired) this.lastError = 'speech_to_text_repair_required';
      return await this.getState();
    }
    this.starting = true;
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
      '--model', this.config.model,
      '--max-concurrent-jobs', String(this.config.maxConcurrentJobs),
      '--max-realtime-sessions', String(this.config.maxRealtimeSessions),
      '--parent-pid', String(process.pid),
    ], {
      cwd: root,
      env: {
        ...process.env,
        HF_HOME: this.modelCacheRoot(),
        XDG_CACHE_HOME: this.deps.path.join(root, 'cache'),
        PYTHONUNBUFFERED: '1',
        FORGER_SPEECH_TOKEN: token,
      },
      stdio: 'pipe',
      detached: false,
    });
    this.child = child;
    this.port = port;
    this.token = token;
    child.on('exit', (code) => {
      this.lastError = code === 0 || code === null ? undefined : `speech_server_exited_${code}`;
      void this.appendServiceLog('server_exit', { code, technicalCode: this.lastError });
      this.child = null;
      this.port = null;
      this.token = null;
    });
    child.on('error', (error) => {
      this.lastError = error.message || 'speech_server_spawn_failed';
      this.child = null;
      this.port = null;
      this.token = null;
      void this.appendServiceLog('spawn_failed', { technicalCode: 'speech_server_spawn_failed' });
      void this.deps.appendInstallLog('speech_to_text:spawn_failed', { error: this.lastError });
    });
    child.stdout.on('data', (chunk) => {
      const diagnostic = sanitizeDiagnosticText(String(chunk).trim());
      if (diagnostic) {
        void this.appendServiceLog('stdout', { diagnostic });
        void this.deps.appendInstallLog('speech_to_text:stdout', { text: diagnostic });
      }
    });
    child.stderr.on('data', (chunk) => {
      const diagnostic = sanitizeDiagnosticText(String(chunk).trim());
      if (diagnostic) {
        void this.appendServiceLog('stderr', { diagnostic });
        void this.deps.appendInstallLog('speech_to_text:stderr', { text: diagnostic });
      }
    });
    try {
      await this.waitForHealth(20_000);
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'speech_health_failed';
      void this.appendServiceLog('health_failed', { technicalCode: this.lastError });
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
    for (const worker of this.modelWorkers.values()) {
      this.stopModelWorker(worker, 'stopped');
    }
  }

  async allowUserSelectedPath(rawPath: string): Promise<void> {
    this.explicitlyAllowedPaths.add(await this.deps.fs.realpath(this.deps.path.resolve(rawPath)));
  }

  environmentForApp(allowsSpeechToText: boolean): Record<string, string> {
    if (!allowsSpeechToText || !this.port || !this.token) {
      return {};
    }
    return {
      FORGER_SPEECH_TO_TEXT_URL: `http://127.0.0.1:${this.port}`,
      FORGER_SPEECH_TO_TEXT_TOKEN: this.token,
    };
  }

  async createRealtimeSession(): Promise<SpeechToTextRealtimeSession> {
    const state = await this.start();
    if (!state.running || !this.port || !this.token) {
      if (state.repairRequired) throw new Error('speech_to_text_repair_required');
      throw new Error(state.installed ? 'speech_to_text_not_running' : 'speech_to_text_not_installed');
    }
    return {
      url: `ws://127.0.0.1:${this.port}/v1/realtime/transcribe`,
      token: this.token,
      sampleRate: 16000,
      format: 'pcm_s16le',
    };
  }

  async updateConfig(input: SpeechToTextConfigInput): Promise<SpeechToTextState> {
    const previous = this.config;
    this.config = normalizeConfig({ ...this.config, ...input });
    await this.writeConfig();
    if (this.child && this.requiresRestart(previous, this.config)) {
      this.restartInBackground();
    }
    return await this.getState();
  }

  async getState(): Promise<SpeechToTextState> {
    await this.load();
    const installState = await this.getInstallState();
    const installed = installState.installed;
    const running = Boolean(this.child && this.port && this.token);
    const [health, jobs, processedFiles] = running
      ? await Promise.all([
        this.fetchJson('/health').catch(() => null),
        this.fetchJson('/v1/jobs').catch(() => null),
        this.fetchJson('/v1/processed-files').catch(() => null),
      ])
      : [null, null, await this.readProcessedFiles()];
    return {
      status: running ? 'running' : this.starting ? 'starting' : installed ? 'installed' : 'not_installed',
      installed,
      running,
      config: this.config,
      modelOptions: await this.listModelOptions(),
      dependencyIssues: installState.dependencyIssues,
      repairRequired: installState.repairRequired,
      queue: asJobs(jobs).filter((job) => job.status !== 'completed'),
      processedFiles: Array.isArray(processedFiles) ? processedFiles as SpeechToTextProcessedFile[] : asProcessedFiles(processedFiles),
      modelWorkers: this.buildModelWorkers(health),
      ...(isRecord(health) ? {
        health: {
          ok: health.ok === true,
          model: String(health.model ?? this.config.model),
          activeJobs: Number(health.activeJobs ?? 0),
          queuedJobs: Number(health.queuedJobs ?? 0),
          activeRealtimeSessions: Number(health.activeRealtimeSessions ?? 0),
          realtimeQueueDepth: Number(health.realtimeQueueDepth ?? 0),
          realtimeActiveJobs: Number(health.realtimeActiveJobs ?? 0),
          lastRealtimeFactor: Number(health.lastRealtimeFactor ?? 0),
          vadMode: typeof health.vadMode === 'string' ? health.vadMode : undefined,
        },
      } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async process(input: SpeechToTextProcessInput, access: SpeechAccess = {}): Promise<SpeechToTextProcessResult> {
    const task: SpeechToTextTask = input.task === 'translate' ? 'translate' : 'transcribe';
    await this.load();
    const model = normalizeModel(input.model, this.config.model);
    const audioPath = await this.resolveAllowedAudioPath(input.path, access);
    const endpoint = task === 'translate' ? '/v1/translate' : '/v1/transcribe';
    const worker = model === this.config.model ? null : await this.startModelWorker(model).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : 'speech_model_worker_start_failed';
      return null;
    });
    const state = worker ? null : await this.start();
    if (!worker && !state?.running) {
      return { success: false, userMessage: 'Speech to text is not ready.', technicalCode: state?.installed ? 'speech_to_text_not_running' : 'speech_to_text_not_installed' };
    }
    if (model !== this.config.model && !worker) {
      return { success: false, userMessage: 'Speech to text model is not ready.', technicalCode: 'speech_model_worker_not_running', service: 'speech_to_text', operation: task, reportable: true, details: { model } };
    }
    let payload: unknown;
    try {
      if (worker) {
        worker.queuedJobs += 1;
        worker.status = worker.status === 'starting' ? 'starting' : 'busy';
      }
      payload = await this.fetchJson(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          path: audioPath,
          task,
          language: input.language,
          ...(Array.isArray(input.languages) && input.languages.length > 0 ? { languages: input.languages } : {}),
          ...(access.ephemeral === true ? { ephemeral: true } : {}),
        }),
      }, worker ? { port: worker.port, token: worker.token } : undefined);
    } catch (error) {
      const result = this.normalizeServiceError(error, task);
      await this.appendServiceLog('process_failed', {
        technicalCode: result.technicalCode,
        operation: result.operation,
        reportable: result.reportable,
        task,
      });
      return result;
    } finally {
      if (worker) {
        worker.queuedJobs = Math.max(0, worker.queuedJobs - 1);
        worker.activeJobs = 0;
        worker.status = 'idle';
        worker.lastUsedAt = new Date().toISOString();
        this.scheduleModelWorkerIdleStop(worker);
      }
    }
    const job = asJobs({ jobs: [payload] })[0];
    if (!job || job.status === 'failed') {
      const technicalCode = job?.technicalCode ?? job?.error ?? 'speech_to_text_failed';
      return {
        success: false,
        service: 'speech_to_text',
        operation: task,
        job,
        userMessage: job?.error ?? 'Speech to text failed.',
        technicalCode,
        reportable: true,
        details: sanitizeReportableDetails({ technicalCode, status: job?.status, task, sizeBytes: job?.sizeBytes, durationSeconds: job?.durationSeconds, language: job?.language, model }),
      };
    }
    job.model = job.model ?? model;
    return {
      success: true,
      job,
      text: job.text,
      language: job.language,
      durationSeconds: job.durationSeconds,
      userMessage: task === 'translate' ? 'Audio translated.' : 'Audio transcribed.',
    };
  }

  async processUpload(input: SpeechToTextUploadInput): Promise<SpeechToTextProcessResult> {
    const filename = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '') || 'recording.webm';
    if (input.ephemeral === true) await this.prepareEphemeralUploadRoot();
    const uploadRoot = input.ephemeral === true ? this.ephemeralUploadRoot() : this.tempUploadRoot();
    await this.deps.fs.mkdir(uploadRoot, { recursive: true });
    const uploadPath = this.deps.path.join(
      uploadRoot,
      input.ephemeral === true
        ? `${Date.now()}-${randomBytes(8).toString('hex')}-${filename}`
        : `${Date.now()}-${filename}`,
    );
    await this.deps.fs.writeFile(uploadPath, Buffer.from(input.data));
    try {
      return await this.process({ path: uploadPath, task: input.task, language: input.language, languages: input.languages, model: input.model }, {
        extraAllowedRoots: [uploadRoot],
        ephemeral: input.ephemeral === true,
      });
    } finally {
      await this.deps.fs.rm(uploadPath, { force: true }).catch(() => undefined);
    }
  }

  private async resolveAllowedAudioPath(rawPath: string, access: SpeechAccess): Promise<string> {
    const audioPath = this.deps.path.resolve(rawPath);
    const realPath = await this.deps.fs.realpath(audioPath);
    const roots = [
      this.deps.getPrivateDataRoot(),
      ...(access.extraAllowedRoots ?? []),
      ...(access.appAllowsSpeechToText && access.appInstallDir ? [access.appInstallDir] : []),
    ];
    const canonicalRoots = await Promise.all(roots.map(async (root) => {
      const resolved = this.deps.path.resolve(root);
      return await this.deps.fs.realpath(resolved).catch(() => resolved);
    }));
    const allowed = this.explicitlyAllowedPaths.has(realPath) || canonicalRoots.some((root) => {
      const relative = this.deps.path.relative(root, realPath);
      return relative === '' || (!relative.startsWith('..') && !this.deps.path.isAbsolute(relative));
    });
    if (!allowed) {
      throw new Error('speech_audio_path_not_allowed');
    }
    return realPath;
  }

  private prepareEphemeralUploadRoot(): Promise<void> {
    if (!this.ephemeralUploadCleanupPromise) {
      this.ephemeralUploadCleanupPromise = (async () => {
        const root = this.ephemeralUploadRoot();
        await this.deps.fs.rm(root, { recursive: true, force: true });
        await this.deps.fs.mkdir(root, { recursive: true });
      })().catch(() => {
        throw new Error('speech_ephemeral_upload_cleanup_failed');
      });
    }
    return this.ephemeralUploadCleanupPromise;
  }

  private async readConfig(): Promise<SpeechToTextConfig> {
    try {
      const raw = JSON.parse(await this.deps.fs.readFile(this.configPath(), 'utf8')) as SpeechToTextConfigInput;
      return normalizeConfig(raw);
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  private async writeConfig(): Promise<void> {
    await this.deps.fs.mkdir(this.root(), { recursive: true });
    await this.deps.fs.writeFile(this.configPath(), JSON.stringify(this.config, null, 2), 'utf8');
  }

  private async readProcessedFiles(): Promise<SpeechToTextProcessedFile[]> {
    try {
      const raw = JSON.parse(await this.deps.fs.readFile(this.processedFilesPath(), 'utf8'));
      return Array.isArray(raw) ? raw as SpeechToTextProcessedFile[] : [];
    } catch {
      return [];
    }
  }

  private async isInstalled(): Promise<boolean> {
    return (await this.getInstallState()).installed;
  }

  private async getInstallState(): Promise<SpeechInstallState> {
    try {
      const marker = parseJson(await this.deps.fs.readFile(this.installedMarkerPath(), 'utf8'));
      const dependencies = isRecord(marker) && Array.isArray(marker.dependencies)
        ? new Set(marker.dependencies.filter((dependency): dependency is string => typeof dependency === 'string'))
        : new Set<string>();
      const missingDependencies = REQUIRED_DEPENDENCIES.filter((dependency) => !dependencies.has(dependency));
      return {
        installed: true,
        dependencyIssues: missingDependencies.map((dependency) => ({
          code: 'speech_dependency_missing',
          dependency,
          repairable: true,
        })),
        repairRequired: missingDependencies.length > 0,
      };
    } catch {
      return { installed: false, dependencyIssues: [], repairRequired: false };
    }
  }

  private async validateInstallDependencies(python: string): Promise<void> {
    await this.deps.runCommand(python, ['-c', 'import fastapi, uvicorn, multipart, faster_whisper'], {
      cwd: this.root(),
      env: {
        ...process.env,
        HF_HOME: this.modelCacheRoot(),
        XDG_CACHE_HOME: this.deps.path.join(this.root(), 'cache'),
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
      label: 'validate speech to text dependencies',
    });
  }

  private requiresRestart(previous: SpeechToTextConfig, next: SpeechToTextConfig): boolean {
    return previous.model !== next.model
      || previous.maxConcurrentJobs !== next.maxConcurrentJobs
      || previous.maxRealtimeSessions !== next.maxRealtimeSessions;
  }

  private restartInBackground(): void {
    this.stop();
    this.starting = true;
    void this.start().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : 'speech_restart_failed';
      this.starting = false;
      void this.deps.appendInstallLog('speech_to_text:restart_failed', { error: this.lastError });
      void this.appendServiceLog('restart_failed', { technicalCode: this.lastError });
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
    throw new Error('speech_health_timeout');
  }

  private async startModelWorker(model: string): Promise<SpeechWorkerRef> {
    const existing = this.modelWorkers.get(model);
    if (existing?.startPromise) return await existing.startPromise;
    if (existing?.child && existing.port && existing.token && existing.status !== 'error' && existing.status !== 'stopped') {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
      existing.status = existing.status === 'idle' ? 'ready' : existing.status;
      return existing;
    }
    const installState = await this.getInstallState();
    if (!installState.installed) {
      throw new Error('speech_to_text_not_installed');
    }
    if (installState.repairRequired) {
      throw new Error('speech_to_text_repair_required');
    }
    const worker: SpeechWorkerRef = existing ?? {
      model,
      child: null,
      port: null,
      token: null,
      status: 'stopped',
      pinned: false,
      activeJobs: 0,
      queuedJobs: 0,
    };
    this.modelWorkers.set(model, worker);
    worker.status = 'starting';
    worker.technicalCode = undefined;
    worker.startPromise = this.startModelWorkerInternal(worker).finally(() => {
      worker.startPromise = undefined;
    });
    return await worker.startPromise;
  }

  private async startModelWorkerInternal(worker: SpeechWorkerRef): Promise<SpeechWorkerRef> {
    const root = this.modelWorkerRoot(worker.model);
    await this.deps.fs.mkdir(root, { recursive: true });
    killServiceProcessesForMetadataRoot(this.deps.getServiceSourcePath(), root);
    const port = await this.deps.getFreePort();
    const token = randomBytes(24).toString('hex');
    const child = spawn(this.venvPythonPath(), [
      this.deps.getServiceSourcePath(),
      '--port', String(port),
      '--metadata-root', root,
      '--log-path', this.modelWorkerLogPath(worker.model),
      '--model', worker.model,
      '--max-concurrent-jobs', String(this.config.maxConcurrentJobs),
      '--max-realtime-sessions', '1',
      '--parent-pid', String(process.pid),
    ], {
      cwd: root,
      env: {
        ...process.env,
        HF_HOME: this.modelCacheRoot(),
        XDG_CACHE_HOME: this.deps.path.join(this.root(), 'cache'),
        PYTHONUNBUFFERED: '1',
        FORGER_SPEECH_TOKEN: token,
      },
      stdio: 'pipe',
      detached: false,
    });
    worker.child = child;
    worker.port = port;
    worker.token = token;
    child.on('exit', (code) => {
      worker.status = code === 0 || code === null ? 'stopped' : 'error';
      worker.technicalCode = worker.status === 'error' ? `speech_model_worker_exited_${code}` : undefined;
      worker.child = null;
      worker.port = null;
      worker.token = null;
    });
    child.on('error', (error) => {
      worker.status = 'error';
      worker.technicalCode = error.message || 'speech_model_worker_spawn_failed';
      worker.child = null;
      worker.port = null;
      worker.token = null;
    });
    child.stdout.on('data', (chunk) => {
      const diagnostic = sanitizeDiagnosticText(String(chunk).trim());
      if (diagnostic) void this.appendServiceLog('worker_stdout', { diagnostic, model: worker.model });
    });
    child.stderr.on('data', (chunk) => {
      const diagnostic = sanitizeDiagnosticText(String(chunk).trim());
      if (diagnostic) void this.appendServiceLog('worker_stderr', { diagnostic, model: worker.model });
    });
    try {
      await this.waitForWorkerHealth(worker, 20_000);
      worker.status = 'ready';
      worker.lastUsedAt = new Date().toISOString();
      return worker;
    } catch (error) {
      worker.status = 'error';
      worker.technicalCode = error instanceof Error ? error.message : 'speech_model_worker_health_failed';
      this.stopModelWorker(worker, 'error');
      throw error;
    }
  }

  private async waitForWorkerHealth(worker: SpeechWorkerRef, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        await this.fetchJson('/health', {}, { port: worker.port, token: worker.token });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error('speech_model_worker_health_timeout');
  }

  private scheduleModelWorkerIdleStop(worker: SpeechWorkerRef): void {
    if (worker.pinned) return;
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    worker.idleTimer = setTimeout(() => {
      if (worker.activeJobs === 0 && worker.queuedJobs === 0 && worker.status === 'idle') {
        this.stopModelWorker(worker, 'stopped');
      }
    }, this.deps.onDemandModelIdleTimeoutMs ?? ON_DEMAND_MODEL_IDLE_TIMEOUT_MS);
  }

  private stopModelWorker(worker: SpeechWorkerRef, status: SpeechToTextModelWorkerStatus): void {
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    worker.idleTimer = undefined;
    worker.status = status === 'error' ? 'error' : 'stopping';
    killProcessTree(worker.child ?? undefined);
    worker.child = null;
    worker.port = null;
    worker.token = null;
    worker.activeJobs = 0;
    worker.queuedJobs = 0;
    if (status !== 'error') worker.status = status;
  }

  private buildModelWorkers(defaultHealth: unknown): SpeechToTextModelWorker[] {
    const defaultRecord = isRecord(defaultHealth) ? defaultHealth : {};
    const workers: SpeechToTextModelWorker[] = [{
      model: this.config.model,
      status: this.child && this.port && this.token
        ? Number(defaultRecord.activeJobs ?? 0) > 0 || Number(defaultRecord.queuedJobs ?? 0) > 0 ? 'busy' : 'ready'
        : this.starting ? 'starting' : 'stopped',
      pinned: true,
      activeJobs: Number(defaultRecord.activeJobs ?? 0),
      queuedJobs: Number(defaultRecord.queuedJobs ?? 0),
      activeRealtimeSessions: Number(defaultRecord.activeRealtimeSessions ?? 0),
    }];
    for (const worker of this.modelWorkers.values()) {
      if (worker.model === this.config.model) continue;
      workers.push({
        model: worker.model,
        status: worker.status,
        pinned: worker.pinned,
        activeJobs: worker.activeJobs,
        queuedJobs: worker.queuedJobs,
        ...(worker.lastUsedAt ? { lastUsedAt: worker.lastUsedAt } : {}),
        ...(worker.technicalCode ? { technicalCode: worker.technicalCode } : {}),
      });
    }
    return workers;
  }

  private async fetchJson(pathname: string, init: RequestInit = {}, target?: { port: number | null; token: string | null }): Promise<unknown> {
    const port = target?.port ?? this.port;
    const token = target?.token ?? this.token;
    if (!port || !token) {
      throw new Error('speech_server_not_running');
    }
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const payload = text ? parseJson(text) : undefined;
    if (!response.ok) {
      throw new SpeechToTextHttpError(response.status, normalizeSpeechErrorResult(payload));
    }
    return payload;
  }

  private root(): string {
    return this.deps.path.join(this.deps.getMetadataRoot(), 'speech-to-text');
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

  private modelWorkerRoot(model: string): string {
    return this.deps.path.join(this.root(), 'model-workers', model);
  }

  private modelWorkerLogPath(model: string): string {
    return this.deps.path.join(this.logRoot(), `worker-${model}.jsonl`);
  }

  private async appendServiceLog(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.deps.fs.mkdir(this.logRoot(), { recursive: true });
      await this.deps.fs.appendFile(this.serviceLogPath(), `${JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'speech_to_text',
        event,
        ...sanitizeReportableDetails(payload),
      })}\n`, 'utf8');
    } catch {
      // Service logging must not break the local runtime.
    }
  }

  private normalizeServiceError(error: unknown, operation: string): SpeechToTextProcessResult {
    if (error instanceof SpeechToTextHttpError && error.payload?.technicalCode) {
      return {
        success: false,
        service: 'speech_to_text',
        operation: error.payload.operation ?? operation,
        userMessage: error.payload.userMessage ?? 'Speech to text failed.',
        technicalCode: error.payload.technicalCode,
        reportable: error.payload.reportable ?? true,
        ...(error.payload.details ? { details: sanitizeReportableDetails(error.payload.details) } : {}),
      };
    }
    const technicalCode = error instanceof Error && error.message ? error.message : 'speech_to_text_failed';
    return {
      success: false,
      service: 'speech_to_text',
      operation,
      userMessage: 'Speech to text failed.',
      technicalCode,
      reportable: true,
    };
  }

  private processedFilesPath(): string {
    return this.deps.path.join(this.root(), 'processed-files.json');
  }

  private tempUploadRoot(): string {
    return this.deps.path.join(this.root(), 'temp-uploads');
  }

  private ephemeralUploadRoot(): string {
    return this.deps.path.join(this.tempUploadRoot(), 'ephemeral');
  }

  private modelCacheRoot(): string {
    return this.deps.path.join(this.root(), 'models');
  }

  private async listModelOptions(): Promise<SpeechToTextModelOption[]> {
    const cacheRoot = this.modelCacheRoot();
    const installedNames = new Set<string>();
    const collect = async (dir: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory: () => boolean }>;
      try {
        entries = await this.deps.fs.readdir(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory: () => boolean }>;
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        installedNames.add(entry.name);
        await collect(this.deps.path.join(dir, entry.name));
      }
    };
    await collect(cacheRoot);
    const allModels = [...new Set([...MODEL_OPTIONS, this.config.model].filter(Boolean))];
    return allModels.map((id) => ({
      id,
      installed: installedNames.has(id) || installedNames.has(`models--Systran--faster-whisper-${id}`),
    }));
  }

  private venvPath(): string {
    return this.deps.path.join(this.root(), '.venv');
  }

  private venvPythonPath(): string {
    return process.platform === 'win32'
      ? this.deps.path.join(this.venvPath(), 'Scripts', 'python.exe')
      : this.deps.path.join(this.venvPath(), 'bin', 'python');
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const sanitizeDiagnosticText = (text: string): string =>
  text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/FORGER_[A-Z_]*TOKEN=[^\s]+/g, 'FORGER_TOKEN=[redacted]')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[redacted]')
    .slice(0, 2000);

const SAFE_DETAIL_KEYS = new Set([
  'diagnostic',
  'durationSeconds',
  'httpStatus',
  'language',
  'model',
  'operation',
  'queueDepth',
  'reportable',
  'service',
  'sizeBytes',
  'status',
  'task',
  'technicalCode',
]);

const sanitizeReportableDetails = (details: Record<string, unknown>): Record<string, unknown> => {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (typeof value === 'string') sanitized[key] = sanitizeDiagnosticText(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) sanitized[key] = value;
  }
  return sanitized;
};

const normalizeSpeechErrorResult = (value: unknown): SpeechToTextProcessResult => {
  const payload = isRecord(value) && isRecord(value.detail) ? value.detail : value;
  if (!isRecord(payload)) return { success: false, service: 'speech_to_text', operation: 'request', userMessage: 'Speech to text failed.', technicalCode: 'speech_invalid_error_response', reportable: true };
  return {
    success: false,
    ...(payload.service === 'speech_to_text' ? { service: 'speech_to_text' as const } : {}),
    ...(typeof payload.operation === 'string' ? { operation: payload.operation } : {}),
    userMessage: typeof payload.userMessage === 'string' ? payload.userMessage : 'Speech to text failed.',
    technicalCode: typeof payload.technicalCode === 'string' ? payload.technicalCode : 'speech_to_text_failed',
    reportable: typeof payload.reportable === 'boolean' ? payload.reportable : true,
    ...(isRecord(payload.details) ? { details: sanitizeReportableDetails(payload.details) } : {}),
  };
};
