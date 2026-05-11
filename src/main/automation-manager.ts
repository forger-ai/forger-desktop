import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppSummary,
  Automation,
  AutomationFrequency,
  AutomationRun,
  AutomationRunStatus,
  AutomationRunSummary,
  AutomationRunTrigger,
  AutomationUpsertInput,
  FilesActionResult,
  AgentRuntime,
  ClaudeEffort,
} from '../shared/types';
import {
  assertAllowedMcpServers,
  createIsolatedCodexHome,
  removeIsolatedCodexHome,
} from './codex-run-isolation';

interface AutomationManagerOptions {
  forgerHomeRoot: string;
  metadataRoot: string;
  codexHome: string;
  getAgentRuntime: (requested?: Partial<AgentRuntime>) => Promise<AgentRuntime>;
  getInstalledApps: () => AppSummary[];
  getCodexCliPath: () => Promise<string | null>;
  getClaudeCliPath: () => Promise<string | null>;
  getCodexPathEntries: () => Promise<string[]>;
  getCodexAuthenticated: () => Promise<boolean>;
  getClaudeAuthenticated: () => Promise<boolean>;
  createForgerMcpSession?: (runId: string, appId: string, appIds: string[]) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext?: (appIds: string[]) => Promise<string>;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<CodexMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  onAutomationUpdated: (event: { automation: Automation; run?: AutomationRunSummary }) => void;
}

interface CodexMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const AUTOMATION_TIMEOUT_MS = 300_000;

export const computeNextRunAt = (frequency: AutomationFrequency, from = new Date()): string => {
  const next = new Date(from);

  if (frequency.type === 'hourly') {
    next.setHours(next.getHours() + 1);
    return next.toISOString();
  }

  const [hour, minute] = parseTimeOfDay(frequency.timeOfDay);
  next.setMilliseconds(0);
  next.setSeconds(0);
  next.setMinutes(minute);
  next.setHours(hour);

  if (frequency.type === 'daily') {
    if (next <= from) {
      next.setDate(next.getDate() + 1);
    }
    return next.toISOString();
  }

  const weeklyDay = normalizeWeeklyDay(frequency.weeklyDay);
  const currentDay = next.getDay();
  let daysToAdd = (weeklyDay - currentDay + 7) % 7;
  if (daysToAdd === 0 && next <= from) {
    daysToAdd = 7;
  }
  next.setDate(next.getDate() + daysToAdd);
  return next.toISOString();
};

export class AutomationManager {
  private automations = new Map<string, Automation>();
  private timers = new Map<string, NodeJS.Timeout>();
  private activeRunAutomationIds = new Set<string>();

  public constructor(private readonly options: AutomationManagerOptions) {}

  public async initialize(): Promise<void> {
    await fs.mkdir(this.runsRoot(), { recursive: true });
    const raw = await fs.readFile(this.automationsFilePath(), 'utf8').catch(() => '[]');
    try {
      const parsed = JSON.parse(raw) as Automation[];
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const normalized = this.normalizeAutomation(entry);
          this.automations.set(normalized.id, normalized);
        }
      }
    } catch {
      this.automations.clear();
    }
    await this.saveAutomations();
    this.scheduleAll();
  }

  public dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  public list(): Automation[] {
    return this.sortedAutomations();
  }

  public async create(input: AutomationUpsertInput): Promise<Automation> {
    const now = new Date().toISOString();
    const enabled = Boolean(input.enabled);
    const automation: Automation = {
      id: randomUUID(),
      name: sanitizeText(input.name, 120),
      prompt: sanitizeText(input.prompt, 20_000),
      frequency: sanitizeFrequency(input.frequency),
      selectedAppIds: sanitizeAppIds(input.selectedAppIds),
      enabled,
      running: false,
      nextRunAt: enabled ? computeNextRunAt(sanitizeFrequency(input.frequency)) : null,
      createdAt: now,
      updatedAt: now,
    };
    this.assertValidAutomation(automation);
    this.automations.set(automation.id, automation);
    await this.saveAutomations();
    this.scheduleAutomation(automation.id);
    return automation;
  }

  public async update(input: AutomationUpsertInput & { id: string }): Promise<Automation> {
    const current = this.requireAutomation(input.id);
    const frequency = sanitizeFrequency(input.frequency);
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : current.enabled;
    const next: Automation = {
      ...current,
      name: sanitizeText(input.name, 120),
      prompt: sanitizeText(input.prompt, 20_000),
      frequency,
      selectedAppIds: sanitizeAppIds(input.selectedAppIds),
      enabled,
      nextRunAt: enabled ? computeNextRunAt(frequency) : null,
      updatedAt: new Date().toISOString(),
    };
    this.assertValidAutomation(next);
    this.automations.set(next.id, next);
    await this.saveAutomations();
    this.scheduleAutomation(next.id);
    return next;
  }

  public async delete(id: string): Promise<FilesActionResult> {
    if (!this.automations.has(id)) {
      return { success: false, technicalCode: 'automation_not_found', userMessage: 'No encontramos esa automatizacion.' };
    }
    this.clearTimer(id);
    this.automations.delete(id);
    await this.saveAutomations();
    return { success: true, userMessage: 'Automatizacion eliminada.' };
  }

  public async pause(id: string): Promise<Automation> {
    const automation = this.requireAutomation(id);
    const next: Automation = {
      ...automation,
      enabled: false,
      nextRunAt: null,
      updatedAt: new Date().toISOString(),
    };
    this.automations.set(id, next);
    this.clearTimer(id);
    await this.saveAutomations();
    return next;
  }

  public async resume(id: string): Promise<Automation> {
    const automation = this.requireAutomation(id);
    const next: Automation = {
      ...automation,
      enabled: true,
      nextRunAt: computeNextRunAt(automation.frequency),
      updatedAt: new Date().toISOString(),
    };
    this.automations.set(id, next);
    await this.saveAutomations();
    this.scheduleAutomation(id);
    return next;
  }

  public async runNow(id: string): Promise<AutomationRunSummary> {
    return await this.startRun(id, 'manual');
  }

  public async listRuns(automationId: string): Promise<AutomationRunSummary[]> {
    const runIds = await this.readRunIds(automationId);
    const runs = await Promise.all(runIds.map((runId) => this.readRun(runId)));
    return runs
      .filter((run): run is AutomationRun => Boolean(run))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map(toRunSummary);
  }

  public async getRunTranscript(runId: string): Promise<AutomationRun | null> {
    return await this.readRun(runId);
  }

  private async startRun(id: string, trigger: AutomationRunTrigger): Promise<AutomationRunSummary> {
    const automation = this.requireAutomation(id);
    if (this.activeRunAutomationIds.has(id)) {
      const run = await this.createRunRecord(automation, trigger, 'skipped', 'automation_already_running');
      await this.updateLastRun(automation.id, toRunSummary(run));
      return toRunSummary(run);
    }

    const run = await this.createRunRecord(automation, trigger, 'queued');
    this.activeRunAutomationIds.add(id);
    await this.markAutomationRunning(id, true, toRunSummary(run));

    void this.executeRun(id, run.id);
    return toRunSummary(run);
  }

  private async executeRun(automationId: string, runId: string): Promise<void> {
    let run = await this.readRun(runId);
    if (!run) {
      this.activeRunAutomationIds.delete(automationId);
      return;
    }
    let forgerMcpSession: { url: string; token: string } | null = null;
    try {
      const automation = this.requireAutomation(automationId);
      const runtime = await this.options.getAgentRuntime();
      if (runtime.provider === 'claude') {
        if (!(await this.options.getClaudeAuthenticated())) {
          throw new Error('claude_auth_missing');
        }
      } else if (!(await this.options.getCodexAuthenticated())) {
        throw new Error('codex_auth_missing');
      }
      const codexCliPath = runtime.provider === 'codex' ? await this.options.getCodexCliPath() : null;
      const claudeCliPath = runtime.provider === 'claude' ? await this.options.getClaudeCliPath() : null;
      if (runtime.provider === 'codex' && !codexCliPath) {
        throw new Error('codex_cli_missing');
      }
      if (runtime.provider === 'claude' && !claudeCliPath) {
        throw new Error('claude_cli_missing');
      }
      const pathEntries = await this.options.getCodexPathEntries();
      const transcriptPath = this.runTranscriptPath(run.id);
      await appendTranscript(transcriptPath, 'meta', `Automation ${automation.id} (${automation.name}) started`);
      run = {
        ...run,
        status: 'running',
        transcript: await readText(transcriptPath),
      };
      await this.writeRun(run);
      await this.updateLastRun(automationId, toRunSummary(run));

      const command = runtime.provider === 'codex'
        ? await resolveCodexCommand(codexCliPath as string, pathEntries)
        : { command: claudeCliPath as string, prefixArgs: [], pathEntries };
      const activeRunId = run.id;
      let latestUserMessage = run.userMessage ?? '';
      let userMessages = run.userMessages ?? [];
      forgerMcpSession = this.options.createForgerMcpSession?.(run.id, 'forger', automation.selectedAppIds) ?? null;
      const appMcpServers = await (this.options.listenAppMcps?.(automation.selectedAppIds, run.id) ?? Promise.resolve([]));
      const mcpServers: CodexMcpServerConfig[] = [
        ...(forgerMcpSession
          ? [{
              name: 'forger',
              url: forgerMcpSession.url,
              token: forgerMcpSession.token,
              tokenEnvVar: 'FORGER_MCP_TOKEN',
              toolTimeoutSec: 600,
            }]
          : []),
        ...appMcpServers,
      ];
      const memoryContext = await (this.options.buildMemoryContext?.(automation.selectedAppIds) ?? Promise.resolve(''));
      const prompt = memoryContext ? `${memoryContext}\n\n${this.buildPrompt(automation)}` : this.buildPrompt(automation);
      const result = await runAgentCommand(command, {
        runtime,
        cwd: this.options.forgerHomeRoot,
        codexHome: this.options.codexHome,
        prompt,
        transcriptPath,
        mcpServers,
        onAssistantMessages: (assistantMessages) => {
          const latest = assistantMessages[assistantMessages.length - 1] ?? '';
          if (!latest || latest === latestUserMessage) {
            return;
          }
          latestUserMessage = latest;
          userMessages = assistantMessages;
          void this.updateRunUserMessage(automationId, activeRunId, latest, assistantMessages);
        },
      });

      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || 'codex_exec_failed').trim());
      }

      const parsedMessages = runtime.provider === 'claude'
        ? parseClaudeAssistantMessages(result.stdout, result.stderr)
        : parseCodexAssistantMessages(result.stdout, result.stderr);
      if (parsedMessages.length > 0) {
        userMessages = parsedMessages;
        latestUserMessage = parsedMessages[parsedMessages.length - 1] ?? latestUserMessage;
      }
      run = {
        ...run,
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        userMessage: latestUserMessage,
        userMessages,
        transcript: await readText(transcriptPath),
        transcriptPreview: previewTranscript(await readText(transcriptPath)),
      };
      await this.writeRun(run);
      await this.updateLastRun(automationId, toRunSummary(run));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'automation_run_failed';
      await appendTranscript(this.runTranscriptPath(run.id), 'meta', `Run failed: ${message}`);
      run = {
        ...run,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
        userMessage: run.userMessage || friendlyAutomationFailureMessage(message),
        userMessages: run.userMessages?.length ? run.userMessages : [run.userMessage || friendlyAutomationFailureMessage(message)],
        transcript: await readText(this.runTranscriptPath(run.id)),
        transcriptPreview: previewTranscript(await readText(this.runTranscriptPath(run.id))),
      };
      await this.writeRun(run);
      await this.updateLastRun(automationId, toRunSummary(run));
    } finally {
      if (forgerMcpSession) {
        this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
      }
      this.options.releaseAppMcps?.(run.id);
      this.activeRunAutomationIds.delete(automationId);
      const current = this.automations.get(automationId);
      if (current) {
        const nextRunAt = current.enabled ? computeNextRunAt(current.frequency) : null;
        const next: Automation = {
          ...current,
          running: false,
          nextRunAt,
          updatedAt: new Date().toISOString(),
        };
        this.automations.set(automationId, next);
        await this.saveAutomations();
        this.options.onAutomationUpdated({ automation: next, run: next.lastRun });
        this.scheduleAutomation(automationId);
      }
    }
  }

  private buildPrompt(automation: Automation): string {
    const installedApps = this.options.getInstalledApps();
    const selected = installedApps.filter((appEntry) => automation.selectedAppIds.includes(appEntry.id));
    const appLines =
      selected.length > 0
        ? selected.map((appEntry) =>
            [
              `- ${appEntry.name ?? appEntry.id} (id: ${appEntry.id})`,
              `  Estado: ${appEntry.status}`,
              `  Descripcion: ${appEntry.description ?? ''}`,
              `  Workspace relativo: ${path.posix.join('apps', appEntry.id)}`,
            ].join('\n'),
          )
        : ['- No hay apps incluidas.'];

    return [
      'AUTOMATIZACION GLOBAL DE FORGER',
      `Nombre: ${automation.name}`,
      '',
      'Estas automatizaciones son globales de Forger, no pertenecen a una app especifica.',
      'Las apps incluidas son contexto sugerido inicial. La instruccion del usuario manda y puede referenciar otras apps si lo indica explicitamente.',
      'Trabaja dentro del home privado de Forger y respeta los AGENTS.md existentes antes de afirmar o cambiar capacidades.',
      '',
      'APPS INCLUIDAS:',
      ...appLines,
      '',
      'INSTRUCCION DEL USUARIO:',
      automation.prompt,
    ].join('\n');
  }

  private async createRunRecord(
    automation: Automation,
    trigger: AutomationRunTrigger,
    status: AutomationRunStatus,
    error?: string,
  ): Promise<AutomationRun> {
    const now = new Date().toISOString();
    const run: AutomationRun = {
      id: randomUUID(),
      automationId: automation.id,
      trigger,
      status,
      startedAt: now,
      finishedAt: status === 'skipped' ? now : undefined,
      error,
      userMessage: error ? friendlyAutomationFailureMessage(error) : '',
      userMessages: error ? [friendlyAutomationFailureMessage(error)] : [],
      transcript: error ? `[${now}] [meta] ${error}\n` : '',
      transcriptPreview: error,
    };
    await this.writeRun(run);
    await this.appendRunId(automation.id, run.id);
    return run;
  }

  private async updateLastRun(automationId: string, run: AutomationRunSummary): Promise<void> {
    const automation = this.automations.get(automationId);
    if (!automation) {
      return;
    }
    const next: Automation = {
      ...automation,
      lastRun: run,
      updatedAt: new Date().toISOString(),
    };
    this.automations.set(automationId, next);
    await this.saveAutomations();
    this.options.onAutomationUpdated({ automation: next, run });
  }

  private async markAutomationRunning(id: string, running: boolean, run?: AutomationRunSummary): Promise<void> {
    const automation = this.requireAutomation(id);
    const next: Automation = {
      ...automation,
      running,
      lastRun: run ?? automation.lastRun,
      updatedAt: new Date().toISOString(),
    };
    this.automations.set(id, next);
    await this.saveAutomations();
    this.options.onAutomationUpdated({ automation: next, run });
  }

  private scheduleAll(): void {
    for (const automation of this.automations.values()) {
      this.scheduleAutomation(automation.id);
    }
  }

  private scheduleAutomation(id: string): void {
    this.clearTimer(id);
    const automation = this.automations.get(id);
    if (!automation?.enabled || !automation.nextRunAt) {
      return;
    }
    const delay = Math.max(0, Date.parse(automation.nextRunAt) - Date.now());
    const timer = setTimeout(() => {
      void this.startRun(id, 'scheduled');
    }, Math.min(delay, MAX_TIMEOUT_MS));
    this.timers.set(id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private requireAutomation(id: string): Automation {
    const automation = this.automations.get(id);
    if (!automation) {
      throw new Error('automation_not_found');
    }
    return automation;
  }

  private normalizeAutomation(entry: Automation): Automation {
    const enabled = Boolean(entry.enabled);
    return {
      ...entry,
      name: sanitizeText(entry.name, 120),
      prompt: sanitizeText(entry.prompt, 20_000),
      frequency: sanitizeFrequency(entry.frequency),
      selectedAppIds: sanitizeAppIds(entry.selectedAppIds),
      enabled,
      running: false,
      nextRunAt: enabled ? entry.nextRunAt ?? computeNextRunAt(entry.frequency) : null,
      createdAt: entry.createdAt || new Date().toISOString(),
      updatedAt: entry.updatedAt || new Date().toISOString(),
    };
  }

  private assertValidAutomation(automation: Automation): void {
    if (!automation.name.trim()) {
      throw new Error('automation_name_required');
    }
    if (!automation.prompt.trim()) {
      throw new Error('automation_prompt_required');
    }
  }

  private sortedAutomations(): Automation[] {
    return Array.from(this.automations.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private automationsFilePath(): string {
    return path.join(this.options.metadataRoot, 'automations.json');
  }

  private runsRoot(): string {
    return path.join(this.options.metadataRoot, 'automation-runs');
  }

  private runStoragePath(fileName: string): string {
    const root = path.resolve(this.runsRoot());
    const target = path.resolve(root, fileName);
    const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (target !== root && !target.startsWith(rootWithSeparator)) {
      throw new Error('automation_run_path_outside_storage');
    }
    return target;
  }

  private runFilePath(runId: string): string {
    return this.runStoragePath(`${runId}.json`);
  }

  private runTranscriptPath(runId: string): string {
    return this.runStoragePath(`${runId}.log`);
  }

  private runIndexPath(automationId: string): string {
    return this.runStoragePath(`${automationId}.index.json`);
  }

  private async saveAutomations(): Promise<void> {
    await fs.mkdir(path.dirname(this.automationsFilePath()), { recursive: true });
    await fs.writeFile(this.automationsFilePath(), JSON.stringify(this.sortedAutomations(), null, 2), 'utf8');
  }

  private async writeRun(run: AutomationRun): Promise<void> {
    await fs.mkdir(this.runsRoot(), { recursive: true });
    await fs.writeFile(this.runFilePath(run.id), JSON.stringify(run, null, 2), 'utf8');
    if (run.transcript) {
      await fs.writeFile(this.runTranscriptPath(run.id), run.transcript, 'utf8');
    }
  }

  private async updateRunUserMessage(
    automationId: string,
    runId: string,
    userMessage: string,
    userMessages: string[],
  ): Promise<void> {
    const current = await this.readRun(runId);
    if (!current || current.automationId !== automationId) {
      return;
    }
    const next: AutomationRun = {
      ...current,
      userMessage,
      userMessages,
    };
    await this.writeRun(next);
    await this.updateLastRun(automationId, toRunSummary(next));
  }

  private async readRun(runId: string): Promise<AutomationRun | null> {
    const raw = await fs.readFile(this.runFilePath(runId), 'utf8').catch(() => '');
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as AutomationRun;
      const transcript = await readText(this.runTranscriptPath(runId));
      return {
        ...parsed,
        transcript: transcript || parsed.transcript || '',
        transcriptPreview: parsed.transcriptPreview ?? previewTranscript(transcript || parsed.transcript || ''),
      };
    } catch {
      return null;
    }
  }

  private async appendRunId(automationId: string, runId: string): Promise<void> {
    const current = await this.readRunIds(automationId);
    const next = [runId, ...current.filter((id) => id !== runId)];
    await fs.writeFile(this.runIndexPath(automationId), JSON.stringify(next, null, 2), 'utf8');
  }

  private async readRunIds(automationId: string): Promise<string[]> {
    const raw = await fs.readFile(this.runIndexPath(automationId), 'utf8').catch(() => '[]');
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
}

const sanitizeText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const sanitizeAppIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)));
};

const sanitizeFrequency = (value: unknown): AutomationFrequency => {
  const input = value && typeof value === 'object' ? value as Partial<AutomationFrequency> : {};
  if (input.type === 'daily') {
    return { type: 'daily', timeOfDay: formatTimeOfDay(input.timeOfDay) };
  }
  if (input.type === 'weekly') {
    return {
      type: 'weekly',
      timeOfDay: formatTimeOfDay(input.timeOfDay),
      weeklyDay: normalizeWeeklyDay(input.weeklyDay),
    };
  }
  return { type: 'hourly' };
};

const parseTimeOfDay = (value: string | undefined): [number, number] => {
  const formatted = formatTimeOfDay(value);
  const [hour, minute] = formatted.split(':').map((part) => Number(part));
  return [hour ?? 9, minute ?? 0];
};

const formatTimeOfDay = (value: string | undefined): string => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) {
    return '09:00';
  }
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
};

const normalizeWeeklyDay = (value: unknown): number => {
  const day = typeof value === 'number' && Number.isInteger(value) ? value : 1;
  return Math.min(6, Math.max(0, day));
};

const toRunSummary = (run: AutomationRun): AutomationRunSummary => ({
  id: run.id,
  automationId: run.automationId,
  trigger: run.trigger,
  status: run.status,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  error: run.error,
  userMessage: run.userMessage,
  userMessages: run.userMessages,
  transcriptPreview: run.transcriptPreview ?? previewTranscript(run.transcript),
});

const previewTranscript = (transcript: string): string => {
  const compact = transcript.replace(/\s+/g, ' ').trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
};

const readText = async (filePath: string): Promise<string> =>
  await fs.readFile(filePath, 'utf8').catch(() => '');

const appendTranscript = async (
  transcriptPath: string,
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
  await fs.appendFile(transcriptPath, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
};

const parseCodexAssistantMessages = (stdout: string, stderr = ''): string[] => {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return [];
  }

  const assistantMessages: string[] = [];
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type !== 'item.completed' || !parsed.item || typeof parsed.item !== 'object') {
      continue;
    }

    const item = parsed.item as Record<string, unknown>;
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      const text = item.text.trim();
      if (text && assistantMessages[assistantMessages.length - 1] !== text) {
        assistantMessages.push(text);
      }
    }
  }

  return assistantMessages;
};

const parseClaudeAssistantMessages = (stdout: string, stderr = ''): string[] => {
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return [];
  }
  const assistantMessages: string[] = [];
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = extractClaudeText(parsed).trim();
    if (text && assistantMessages[assistantMessages.length - 1] !== text) {
      assistantMessages.push(text);
    }
  }
  return assistantMessages;
};

const extractClaudeText = (entry: Record<string, unknown>): string => {
  if (typeof entry.result === 'string') {
    return entry.result;
  }
  if (typeof entry.text === 'string') {
    return entry.text;
  }
  const message = entry.message;
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const text = (item as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
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

const friendlyAutomationFailureMessage = (message: string): string => {
  if (message === 'codex_auth_missing') {
    return 'No se pudo ejecutar porque Codex no tiene una sesion activa.';
  }
  if (message === 'claude_auth_missing') {
    return 'No se pudo ejecutar porque Claude Code no tiene una sesion activa.';
  }
  if (message === 'codex_cli_missing' || message === 'codex_js_entrypoint_missing') {
    return 'No se pudo ejecutar porque Codex no esta listo en este equipo.';
  }
  if (message === 'claude_cli_missing') {
    return 'No se pudo ejecutar porque Claude Code no esta listo en este equipo.';
  }
  if (message.startsWith('codex_timeout_after_')) {
    return 'La automatizacion se detuvo porque tardo demasiado en responder.';
  }
  return 'La automatizacion no se pudo completar.';
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
  const nodeModulesRoot = path.resolve(path.dirname(codexCliPath), '..');
  const codexEntrypoint = path.join(nodeModulesRoot, '@openai', 'codex', 'bin', 'codex.js');
  if (!nodePath || !(await existsFile(codexEntrypoint))) {
    throw new Error('codex_js_entrypoint_missing');
  }

  return {
    command: nodePath,
    prefixArgs: [codexEntrypoint],
    pathEntries: [path.dirname(nodePath), path.dirname(codexCliPath), ...pathEntries],
  };
};

const runAgentCommand = async (
  codexCommand: { command: string; prefixArgs: string[]; pathEntries: string[] },
  options: {
    runtime: AgentRuntime;
    cwd: string;
    codexHome: string;
    prompt: string;
    transcriptPath: string;
    mcpServers?: CodexMcpServerConfig[];
    onAssistantMessages?: (assistantMessages: string[]) => void;
  },
): Promise<CommandResult> => {
  const mcpServers = options.mcpServers ?? [];
  const topLevelArgs = mcpServers.length > 0 ? ['--ask-for-approval', 'never'] : [];
  const claudeMcpConfigPath = options.runtime.provider === 'claude'
    ? await writeClaudeMcpConfig(options.cwd, mcpServers)
    : null;
  const args = options.runtime.provider === 'claude'
    ? [
        '-p',
        options.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        options.runtime.model,
        '--effort',
        options.runtime.effort as ClaudeEffort,
        '--permission-mode',
        'bypassPermissions',
        ...(claudeMcpConfigPath ? ['--mcp-config', claudeMcpConfigPath] : []),
      ]
    : [
        ...codexCommand.prefixArgs,
        ...topLevelArgs,
        'exec',
        '--json',
        '--model',
        options.runtime.model || 'gpt-5.3-codex',
        '--config',
        `reasoning_effort="${options.runtime.effort || 'low'}"`,
        '--full-auto',
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        ...buildMcpArgs(mcpServers),
        '-C',
        options.cwd,
        options.prompt,
      ];
  await appendTranscript(options.transcriptPath, 'meta', `${codexCommand.command} ${args.slice(codexCommand.prefixArgs.length).join(' ')}`);
  let stdoutSoFar = '';
  const isolatedCodexHome = options.runtime.provider === 'codex'
    ? await createIsolatedCodexHome(options.codexHome, {
        prefix: 'forger-automation-codex-home',
        trustedRoots: [options.cwd],
      })
    : '';
  const allowedMcpServers = new Set(mcpServers.map((server) => server.name));
  try {
    const result = await runCommandCapture(codexCommand.command, args, {
      cwd: options.cwd,
      env: {
        ...(options.runtime.provider === 'codex' ? { CODEX_HOME: isolatedCodexHome } : {}),
        FORGER_ALLOWED_ROOTS: options.cwd,
        ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
        PATH: [...codexCommand.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
      },
      timeoutMs: AUTOMATION_TIMEOUT_MS,
      onStdout: (text) => {
        stdoutSoFar += text;
        options.onAssistantMessages?.(
          options.runtime.provider === 'claude'
            ? parseClaudeAssistantMessages(stdoutSoFar)
            : parseCodexAssistantMessages(stdoutSoFar),
        );
        void appendTranscript(options.transcriptPath, 'stdout', text);
      },
      onStderr: (text) => void appendTranscript(options.transcriptPath, 'stderr', text),
    });
    assertAllowedMcpServers(result.stdout, result.stderr, allowedMcpServers);
    return result;
  } finally {
    await removeIsolatedCodexHome(isolatedCodexHome);
    await fs.rm(claudeMcpConfigPath ?? '', { force: true }).catch(() => undefined);
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

const getMcpApprovalMode = (server: CodexMcpServerConfig): 'auto' | 'approve' =>
  server.name === 'forger' ? 'auto' : 'approve';

const runCommandCapture = async (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
  },
): Promise<CommandResult> => {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const killChild = (): void => {
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

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          killChild();
          finish(() => reject(new Error(`codex_timeout_after_${options.timeoutMs}ms`)));
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
      if (timeout) {
        clearTimeout(timeout);
      }
      finish(() => reject(error));
    });
    child.on('exit', (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      finish(() => resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr }));
    });
  });
};
