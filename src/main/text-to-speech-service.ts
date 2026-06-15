import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type fs from 'node:fs/promises';
import type path from 'node:path';

import type {
  TextToSpeechConfig,
  TextToSpeechConfigInput,
  TextToSpeechJob,
  TextToSpeechModelOption,
  TextToSpeechState,
  TextToSpeechSynthesizeInput,
  TextToSpeechSynthesizeResult,
  TextToSpeechVoice,
} from '../shared/types';
import type { RuntimeBinarySet } from './core/main-process-types';
import { killProcessTree, killServiceProcessesForMetadataRoot } from './app-agent/process';

const DEFAULT_CONFIG: TextToSpeechConfig = {
  autoStart: false,
  maxTextCharacters: 4000,
  maxConcurrentJobs: 1,
  enabledVoices: ['af_heart', 'am_adam', 'ef_dora', 'pf_dora'],
  defaultModel: 'kokoro',
  defaultVoice: 'af_heart',
};

const MODEL_OPTIONS: TextToSpeechModelOption[] = [
  { id: 'kokoro', label: 'Kokoro', installed: false },
];

const VOICE_OPTIONS: Array<Omit<TextToSpeechVoice, 'installed' | 'enabled'>> = [
  { id: 'af_heart', model: 'kokoro', label: 'Heart', language: 'English', locale: 'en-US' },
  { id: 'af_bella', model: 'kokoro', label: 'Bella', language: 'English', locale: 'en-US' },
  { id: 'am_adam', model: 'kokoro', label: 'Adam', language: 'English', locale: 'en-US' },
  { id: 'bf_emma', model: 'kokoro', label: 'Emma', language: 'English', locale: 'en-GB' },
  { id: 'bm_george', model: 'kokoro', label: 'George', language: 'English', locale: 'en-GB' },
  { id: 'ef_dora', model: 'kokoro', label: 'Dora', language: 'Spanish', locale: 'es' },
  { id: 'em_alex', model: 'kokoro', label: 'Alex', language: 'Spanish', locale: 'es' },
  { id: 'ff_siwis', model: 'kokoro', label: 'Siwis', language: 'French', locale: 'fr' },
  { id: 'if_sara', model: 'kokoro', label: 'Sara', language: 'Italian', locale: 'it' },
  { id: 'pf_dora', model: 'kokoro', label: 'Dora', language: 'Portuguese', locale: 'pt-BR' },
  { id: 'pm_alex', model: 'kokoro', label: 'Alex', language: 'Portuguese', locale: 'pt-BR' },
  { id: 'jf_alpha', model: 'kokoro', label: 'Alpha', language: 'Japanese', locale: 'ja' },
  { id: 'zf_xiaobei', model: 'kokoro', label: 'Xiaobei', language: 'Mandarin Chinese', locale: 'zh-CN' },
  { id: 'hf_alpha', model: 'kokoro', label: 'Alpha', language: 'Hindi', locale: 'hi' },
];

interface TextToSpeechServiceDeps {
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  fs: typeof fs;
  getFreePort: () => Promise<number>;
  getMetadataRoot: () => string;
  getPrivateDataRoot: () => string;
  getServiceSourcePath: () => string;
  path: typeof path;
  runCommand: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

class TextToSpeechHttpError extends Error {
  constructor(readonly status: number, readonly payload?: TextToSpeechSynthesizeResult) {
    super(payload?.technicalCode ?? `text_to_speech_http_${status}`);
  }
}

const normalizeConfig = (input?: TextToSpeechConfigInput | null): TextToSpeechConfig => {
  const enabledVoices = Array.isArray(input?.enabledVoices)
    ? [...new Set(input.enabledVoices.map((voice) => String(voice)).filter(Boolean))]
    : DEFAULT_CONFIG.enabledVoices;
  return {
    autoStart: input?.autoStart === true,
    maxTextCharacters: Number.isFinite(input?.maxTextCharacters) ? Math.max(1, Math.min(20_000, Math.floor(Number(input?.maxTextCharacters)))) : DEFAULT_CONFIG.maxTextCharacters,
    maxConcurrentJobs: Number.isFinite(input?.maxConcurrentJobs) ? Math.max(1, Math.min(8, Math.floor(Number(input?.maxConcurrentJobs)))) : DEFAULT_CONFIG.maxConcurrentJobs,
    enabledVoices,
    defaultModel: typeof input?.defaultModel === 'string' && input.defaultModel.trim() ? input.defaultModel.trim() : DEFAULT_CONFIG.defaultModel,
    defaultVoice: typeof input?.defaultVoice === 'string' && input.defaultVoice.trim() ? input.defaultVoice.trim() : DEFAULT_CONFIG.defaultVoice,
  };
};

export class TextToSpeechServiceManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private config: TextToSpeechConfig = DEFAULT_CONFIG;
  private lastError: string | undefined;
  private port: number | null = null;
  private startPromise: Promise<TextToSpeechState> | null = null;
  private starting = false;
  private token: string | null = null;

  constructor(private readonly deps: TextToSpeechServiceDeps) {}

  async load(): Promise<void> {
    this.config = await this.readConfig();
  }

  async install(): Promise<TextToSpeechState> {
    const runtime = await this.deps.ensureRuntimeInstalled('python', '3.12');
    const root = this.root();
    await this.deps.fs.mkdir(root, { recursive: true });
    await this.deps.runCommand(runtime.python as string, ['-m', 'venv', this.venvPath()], {
      cwd: root,
      env: process.env,
      label: 'create text to speech venv',
    });
    const python = this.venvPythonPath();
    await this.deps.runCommand(python, ['-m', 'pip', 'install', '--upgrade', 'pip', 'fastapi', 'uvicorn[standard]', 'numpy', 'soundfile', 'kokoro'], {
      cwd: root,
      env: {
        ...process.env,
        HF_HOME: this.modelCacheRoot(),
        XDG_CACHE_HOME: this.deps.path.join(root, 'cache'),
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
      label: 'install text to speech dependencies',
    });
    await this.deps.fs.writeFile(this.installedMarkerPath(), JSON.stringify({ installedAt: new Date().toISOString() }, null, 2), 'utf8');
    await this.start();
    return await this.getState();
  }

  async startIfConfigured(): Promise<TextToSpeechState> {
    await this.load();
    if (!this.config.autoStart || !await this.isInstalled()) {
      return await this.getState();
    }
    return await this.start();
  }

  async start(): Promise<TextToSpeechState> {
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return await this.startPromise;
  }

  private async startInternal(): Promise<TextToSpeechState> {
    await this.load();
    if (this.child && this.port && this.token) return await this.getState();
    if (!await this.isInstalled()) return await this.getState();
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
      '--max-text-characters', String(this.config.maxTextCharacters),
      '--max-concurrent-jobs', String(this.config.maxConcurrentJobs),
      '--parent-pid', String(process.pid),
    ], {
      cwd: root,
      env: {
        ...process.env,
        HF_HOME: this.modelCacheRoot(),
        XDG_CACHE_HOME: this.deps.path.join(root, 'cache'),
        PYTHONUNBUFFERED: '1',
        FORGER_TTS_TOKEN: token,
      },
      stdio: 'pipe',
      detached: false,
    });
    this.child = child;
    this.port = port;
    this.token = token;
    child.on('exit', (code) => {
      this.lastError = code === 0 || code === null ? undefined : `text_to_speech_server_exited_${code}`;
      void this.appendServiceLog('server_exit', { code, technicalCode: this.lastError });
      this.child = null;
      this.port = null;
      this.token = null;
    });
    child.on('error', (error) => {
      this.lastError = error.message || 'text_to_speech_spawn_failed';
      this.child = null;
      this.port = null;
      this.token = null;
      void this.appendServiceLog('spawn_failed', { technicalCode: 'text_to_speech_spawn_failed', error: this.lastError });
      void this.deps.appendInstallLog('text_to_speech:spawn_failed', { error: this.lastError });
    });
    child.stdout.on('data', (chunk) => {
      const diagnostic = sanitizeDiagnosticText(String(chunk).trim());
      if (diagnostic) {
        void this.appendServiceLog('stdout', { diagnostic });
        void this.deps.appendInstallLog('text_to_speech:stdout', { text: diagnostic });
      }
    });
    child.stderr.on('data', (chunk) => {
      const diagnostic = sanitizeDiagnosticText(String(chunk).trim());
      if (diagnostic) {
        void this.appendServiceLog('stderr', { diagnostic });
        void this.deps.appendInstallLog('text_to_speech:stderr', { text: diagnostic });
      }
    });
    try {
      await this.waitForHealth(20_000);
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'text_to_speech_health_failed';
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
  }

  environmentForApp(allowsTextToSpeech: boolean): Record<string, string> {
    if (!allowsTextToSpeech || !this.port || !this.token) return {};
    return {
      FORGER_TEXT_TO_SPEECH_URL: `http://127.0.0.1:${this.port}`,
      FORGER_TEXT_TO_SPEECH_TOKEN: this.token,
    };
  }

  async updateConfig(input: TextToSpeechConfigInput): Promise<TextToSpeechState> {
    const previous = this.config;
    this.config = normalizeConfig({ ...this.config, ...input });
    await this.writeConfig();
    if (this.child && this.requiresRestart(previous, this.config)) {
      this.restartInBackground();
    }
    return await this.getState();
  }

  async getState(): Promise<TextToSpeechState> {
    await this.load();
    const installed = await this.isInstalled();
    const running = Boolean(this.child && this.port && this.token);
    const [health, serviceModels, serviceVoices, jobs] = running
      ? await Promise.all([
        this.fetchJson('/health').catch(() => null),
        this.fetchJson('/v1/models').catch(() => null),
        this.fetchJson('/v1/voices').catch(() => null),
        this.fetchJson('/v1/jobs').catch(() => null),
      ])
      : [null, null, null, null];
    const models = asModels(serviceModels, installed);
    const voices = asVoices(serviceVoices, this.config, installed);
    return {
      status: running ? 'running' : this.starting ? 'starting' : installed ? 'installed' : 'not_installed',
      installed,
      running,
      config: this.config,
      models,
      voices,
      queue: asJobs(jobs).filter((job) => job.status === 'queued' || job.status === 'running'),
      ...(isRecord(health) ? {
        health: {
          ok: health.ok === true,
          activeJobs: Number(health.activeJobs ?? 0),
          queuedJobs: Number(health.queuedJobs ?? 0),
        },
      } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async synthesize(input: TextToSpeechSynthesizeInput): Promise<TextToSpeechSynthesizeResult> {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    const voice = typeof input.voice === 'string' ? input.voice.trim() : '';
    if (!text) return { success: false, userMessage: 'Text is required.', technicalCode: 'text_to_speech_text_required' };
    if (!model) return { success: false, userMessage: 'Model is required.', technicalCode: 'text_to_speech_model_required' };
    if (!voice) return { success: false, userMessage: 'Voice is required.', technicalCode: 'text_to_speech_voice_required' };
    await this.load();
    const knownVoice = asVoices(null, this.config, await this.isInstalled()).find((item) => item.id === voice && item.model === model);
    if (!knownVoice || !knownVoice.enabled) {
      return { success: false, userMessage: 'Voice is not loaded.', technicalCode: 'text_to_speech_voice_not_loaded' };
    }
    if (text.length > this.config.maxTextCharacters) {
      return { success: false, userMessage: 'Text is too long.', technicalCode: 'text_to_speech_text_too_long' };
    }
    const state = await this.start();
    if (!state.running) {
      return { success: false, userMessage: 'Text to speech is not ready.', technicalCode: state.installed ? 'text_to_speech_not_running' : 'text_to_speech_not_installed' };
    }
    try {
      const payload = await this.fetchJson('/v1/synthesize', {
        method: 'POST',
        body: JSON.stringify({
          text,
          model,
          voice,
          speed: Number.isFinite(input.speed) ? input.speed : 1,
          format: input.format ?? 'wav',
        }),
      });
      return normalizeSynthesizeResult(payload);
    } catch (error) {
      const result = this.normalizeServiceError(error, 'synthesize');
      await this.appendServiceLog('synthesize_failed', {
        technicalCode: result.technicalCode,
        operation: result.operation,
        reportable: result.reportable,
        model,
        voice,
        textLength: text.length,
      });
      return result;
    }
  }

  private async readConfig(): Promise<TextToSpeechConfig> {
    try {
      const raw = JSON.parse(await this.deps.fs.readFile(this.configPath(), 'utf8')) as TextToSpeechConfigInput;
      return normalizeConfig(raw);
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  private async writeConfig(): Promise<void> {
    await this.deps.fs.mkdir(this.root(), { recursive: true });
    await this.deps.fs.writeFile(this.configPath(), JSON.stringify(this.config, null, 2), 'utf8');
  }

  private async isInstalled(): Promise<boolean> {
    try {
      await this.deps.fs.access(this.installedMarkerPath());
      return true;
    } catch {
      return false;
    }
  }

  private requiresRestart(previous: TextToSpeechConfig, next: TextToSpeechConfig): boolean {
    return previous.maxTextCharacters !== next.maxTextCharacters
      || previous.maxConcurrentJobs !== next.maxConcurrentJobs;
  }

  private restartInBackground(): void {
    this.stop();
    this.starting = true;
    void this.start().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : 'text_to_speech_restart_failed';
      this.starting = false;
      void this.deps.appendInstallLog('text_to_speech:restart_failed', { error: this.lastError });
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
    throw new Error('text_to_speech_health_timeout');
  }

  private async fetchJson(pathname: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.port || !this.token) throw new Error('text_to_speech_server_not_running');
    const response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const payload = text ? parseJson(text) : undefined;
    if (!response.ok) throw new TextToSpeechHttpError(response.status, normalizeSynthesizeResult(payload));
    return payload;
  }

  private root(): string {
    return this.deps.path.join(this.deps.getMetadataRoot(), 'text-to-speech');
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

  private async appendServiceLog(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.deps.fs.mkdir(this.logRoot(), { recursive: true });
      await this.deps.fs.appendFile(this.serviceLogPath(), `${JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'text_to_speech',
        event,
        ...sanitizeReportableDetails(payload),
      })}\n`, 'utf8');
    } catch {
      // Service logging must not break the local runtime.
    }
  }

  private normalizeServiceError(error: unknown, operation: string): TextToSpeechSynthesizeResult {
    if (error instanceof TextToSpeechHttpError && error.payload?.technicalCode) {
      return {
        success: false,
        service: 'text_to_speech',
        operation: error.payload.operation ?? operation,
        userMessage: error.payload.userMessage ?? 'Text to speech failed.',
        technicalCode: error.payload.technicalCode,
        reportable: error.payload.reportable ?? true,
        ...(error.payload.details ? { details: sanitizeReportableDetails(error.payload.details) } : {}),
      };
    }
    const technicalCode = error instanceof Error && error.message ? error.message : 'text_to_speech_failed';
    return {
      success: false,
      service: 'text_to_speech',
      operation,
      userMessage: 'Text to speech failed.',
      technicalCode,
      reportable: true,
    };
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
}

const asModels = (value: unknown, installed: boolean): TextToSpeechModelOption[] => {
  if (isRecord(value) && Array.isArray(value.models)) {
    return value.models.filter(isRecord).map((model) => ({
      id: String(model.id ?? ''),
      label: String(model.label ?? model.id ?? ''),
      installed: model.installed === true,
    })).filter((model) => model.id);
  }
  return MODEL_OPTIONS.map((model) => ({ ...model, installed }));
};

const asVoices = (value: unknown, config: TextToSpeechConfig, installed: boolean): TextToSpeechVoice[] => {
  if (isRecord(value) && Array.isArray(value.voices)) {
    const enabled = new Set(config.enabledVoices);
    return value.voices.filter(isRecord).map((voice) => ({
      id: String(voice.id ?? ''),
      model: String(voice.model ?? ''),
      label: String(voice.label ?? voice.id ?? ''),
      language: String(voice.language ?? ''),
      ...(typeof voice.locale === 'string' ? { locale: voice.locale } : {}),
      installed: voice.installed === true,
      enabled: enabled.has(String(voice.id ?? '')),
    })).filter((voice) => voice.id && voice.model);
  }
  const enabled = new Set(config.enabledVoices);
  return VOICE_OPTIONS.map((voice) => ({
    ...voice,
    installed,
    enabled: enabled.has(voice.id),
  }));
};

const asJobs = (value: unknown): TextToSpeechJob[] =>
  isRecord(value) && Array.isArray(value.jobs) ? value.jobs.filter(isRecord).map<TextToSpeechJob>((job) => ({
    id: String(job.id ?? ''),
    status: job.status === 'queued' || job.status === 'running' || job.status === 'completed' || job.status === 'failed' ? job.status : 'failed',
    model: String(job.model ?? ''),
    voice: String(job.voice ?? ''),
    createdAt: String(job.createdAt ?? ''),
    updatedAt: String(job.updatedAt ?? ''),
    ...(typeof job.textLength === 'number' ? { textLength: job.textLength } : {}),
    ...(job.format === 'wav' || job.format === 'mp3' || job.format === 'opus' ? { format: job.format } : {}),
    ...(typeof job.durationSeconds === 'number' ? { durationSeconds: job.durationSeconds } : {}),
    ...(typeof job.error === 'string' ? { error: job.error } : {}),
    ...(typeof job.technicalCode === 'string' ? { technicalCode: job.technicalCode } : {}),
  })).filter((job) => job.id && job.model && job.voice) : [];

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
  'code',
  'diagnostic',
  'event',
  'format',
  'httpStatus',
  'language',
  'locale',
  'model',
  'operation',
  'queueDepth',
  'reportable',
  'service',
  'status',
  'technicalCode',
  'textLength',
  'voice',
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

const normalizeSynthesizeResult = (value: unknown): TextToSpeechSynthesizeResult => {
  if (!isRecord(value)) return { success: false, technicalCode: 'text_to_speech_invalid_response' };
  return {
    success: value.success === true,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.voice === 'string' ? { voice: value.voice } : {}),
    ...(typeof value.language === 'string' ? { language: value.language } : {}),
    ...(typeof value.locale === 'string' ? { locale: value.locale } : {}),
    ...(value.format === 'wav' || value.format === 'mp3' || value.format === 'opus' ? { format: value.format } : {}),
    ...(typeof value.audioPath === 'string' ? { audioPath: value.audioPath } : {}),
    ...(typeof value.audioDataBase64 === 'string' ? { audioDataBase64: value.audioDataBase64 } : {}),
    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
    ...(typeof value.durationSeconds === 'number' ? { durationSeconds: value.durationSeconds } : {}),
    ...(typeof value.userMessage === 'string' ? { userMessage: value.userMessage } : {}),
    ...(typeof value.technicalCode === 'string' ? { technicalCode: value.technicalCode } : {}),
    ...(value.service === 'text_to_speech' ? { service: value.service } : {}),
    ...(typeof value.operation === 'string' ? { operation: value.operation } : {}),
    ...(typeof value.reportable === 'boolean' ? { reportable: value.reportable } : {}),
    ...(isRecord(value.details) ? { details: sanitizeReportableDetails(value.details) } : {}),
  };
};
