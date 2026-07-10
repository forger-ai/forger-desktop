import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppSummary,
  Automation,
  AutomationFrequency,
  AutomationMissedRunPolicy,
  AutomationRun,
  AutomationRunStatus,
  AutomationRunSummary,
  AutomationRunTrigger,
  AutomationUpsertInput,
  FilesActionResult,
  AgentRuntime,
  AgentRuntimeRequest,
} from '../shared/types';
import { DEFAULT_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, normalizeAgentRuntime } from '../shared/types';
import {
  appendTranscript,
  parseClaudeAssistantMessages,
  parseCodexAssistantMessages,
  runAgentCommand,
  type LlmAutomationMcpServerConfig,
} from './automation/agent-command-runner';
import { renderPromptFile } from './prompt-builder';
import type { LlmProviderAuthProfileResolver } from './llm-provider/types';

interface AutomationManagerUpdateEvent {
  automation: Automation;
  run?: AutomationRunSummary;
  diagnosticTranscript?: string;
}

interface AutomationManagerOptions {
  forgerHomeRoot: string;
  metadataRoot: string;
  codexHome: string;
  providerProfilesRoot?: string;
  resolveAuthProfile?: LlmProviderAuthProfileResolver;
  getAgentRuntime: (requested?: AgentRuntimeRequest) => Promise<AgentRuntime>;
  getInstalledApps: () => AppSummary[];
  getCodexCliPath: () => Promise<string | null>;
  getClaudeCliPath: () => Promise<string | null>;
  getAntigravityCliPath?: () => Promise<string | null>;
  getCodexPathEntries: () => Promise<string[]>;
  getAgentNetworkAccess?: (appIds: string[]) => Promise<boolean>;
  getCodexAuthenticated: () => Promise<boolean>;
  getClaudeAuthenticated: () => Promise<boolean>;
  getAntigravityAuthenticated?: () => Promise<boolean>;
  createForgerMcpSession?: (runId: string, appId: string, appIds: string[]) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext?: (appIds: string[]) => Promise<string>;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<LlmAutomationMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  onAutomationUpdated: (event: AutomationManagerUpdateEvent) => void;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const MISSED_RUN_GRACE_MS = 60_000;
export const DEFAULT_AUTOMATION_MISSED_RUN_POLICY: AutomationMissedRunPolicy = 'within_window';
export const DEFAULT_AUTOMATION_MISSED_RUN_WINDOWS_MINUTES: Record<AutomationFrequency['type'], number> = {
  interval: DEFAULT_INTERVAL_MINUTES,
  hourly: 30,
  daily: 6 * 60,
  weekly: 24 * 60,
};

export const defaultMissedRunWindowMinutes = (frequency: AutomationFrequency): number => {
  if (frequency.type === 'interval') {
    return normalizeIntervalMinutes(frequency.intervalMinutes);
  }
  return DEFAULT_AUTOMATION_MISSED_RUN_WINDOWS_MINUTES[frequency.type];
};

export const computeNextRunAt = (frequency: AutomationFrequency, from = new Date()): string => {
  const next = new Date(from);

  if (frequency.type === 'interval') {
    next.setSeconds(0, 0);
    next.setTime(next.getTime() + normalizeIntervalMinutes(frequency.intervalMinutes) * 60_000);
    return next.toISOString();
  }

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
    await this.scheduleAll();
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
      runtime: sanitizeRuntime(input.runtime),
      missedRunPolicy: sanitizeMissedRunPolicy(input.missedRunPolicy),
      missedRunWindowMinutes: sanitizeMissedRunWindowMinutes(input.missedRunWindowMinutes, sanitizeFrequency(input.frequency)),
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
    await this.scheduleAutomation(automation.id);
    return automation;
  }

  public async update(input: AutomationUpsertInput & { id: string }): Promise<Automation> {
    const current = this.requireAutomation(input.id);
    const frequency = sanitizeFrequency(input.frequency);
    const runtime = Object.prototype.hasOwnProperty.call(input, 'runtime')
      ? sanitizeRuntime(input.runtime)
      : current.runtime;
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : current.enabled;
    const next: Automation = {
      ...current,
      name: sanitizeText(input.name, 120),
      prompt: sanitizeText(input.prompt, 20_000),
      frequency,
      runtime,
      missedRunPolicy: sanitizeMissedRunPolicy(input.missedRunPolicy ?? current.missedRunPolicy),
      missedRunWindowMinutes: sanitizeMissedRunWindowMinutes(input.missedRunWindowMinutes ?? current.missedRunWindowMinutes, frequency),
      selectedAppIds: sanitizeAppIds(input.selectedAppIds),
      enabled,
      nextRunAt: enabled ? computeNextRunAt(frequency) : null,
      updatedAt: new Date().toISOString(),
    };
    this.assertValidAutomation(next);
    this.automations.set(next.id, next);
    await this.saveAutomations();
    await this.scheduleAutomation(next.id);
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
    await this.scheduleAutomation(id);
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
    const progressUpdates = new Set<Promise<void>>();
    const waitForProgressUpdates = async (): Promise<void> => {
      await Promise.allSettled(Array.from(progressUpdates));
    };
    try {
      const automation = this.requireAutomation(automationId);
      const runtimeRequest = automation.runtime ? { ...automation.runtime, strict: true as const } : undefined;
      const runtime = await this.options.getAgentRuntime(runtimeRequest);
      if (runtime.provider === 'antigravity') {
        if (!(await (this.options.getAntigravityAuthenticated?.() ?? Promise.resolve(false)))) {
          throw new Error('antigravity_auth_missing');
        }
      } else if (runtime.provider === 'claude') {
        if (!(await this.options.getClaudeAuthenticated())) {
          throw new Error('claude_auth_missing');
        }
      } else if (!(await this.options.getCodexAuthenticated())) {
        throw new Error('codex_auth_missing');
      }
      const codexCliPath = runtime.provider === 'codex' ? await this.options.getCodexCliPath() : null;
      const claudeCliPath = runtime.provider === 'claude' ? await this.options.getClaudeCliPath() : null;
      const antigravityCliPath = runtime.provider === 'antigravity' ? await (this.options.getAntigravityCliPath?.() ?? Promise.resolve(null)) : null;
      if (runtime.provider === 'codex' && !codexCliPath) {
        throw new Error('codex_cli_missing');
      }
      if (runtime.provider === 'claude' && !claudeCliPath) {
        throw new Error('claude_cli_missing');
      }
      if (runtime.provider === 'antigravity' && !antigravityCliPath) {
        throw new Error('antigravity_cli_missing');
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

      const providerCliPath = runtime.provider === 'codex'
        ? codexCliPath as string
        : runtime.provider === 'antigravity'
          ? antigravityCliPath as string
          : claudeCliPath as string;
      const activeRunId = run.id;
      let latestUserMessage = run.userMessage ?? '';
      let userMessages = run.userMessages ?? [];
      forgerMcpSession = this.options.createForgerMcpSession?.(run.id, 'forger', automation.selectedAppIds) ?? null;
      const appMcpServers = await (this.options.listenAppMcps?.(automation.selectedAppIds, run.id) ?? Promise.resolve([]));
      const networkAccess = await (this.options.getAgentNetworkAccess?.(automation.selectedAppIds) ?? Promise.resolve(false));
      const mcpServers: LlmAutomationMcpServerConfig[] = [
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
      const result = await runAgentCommand({ cliPath: providerCliPath, pathEntries }, {
        runtime,
        cwd: this.options.forgerHomeRoot,
        codexHome: this.options.codexHome,
        providerProfilesRoot: this.options.providerProfilesRoot,
        resolveAuthProfile: this.options.resolveAuthProfile,
        prompt,
        transcriptPath,
        mcpServers,
        networkAccess,
        onAssistantMessages: (assistantMessages) => {
          const latest = assistantMessages[assistantMessages.length - 1] ?? '';
          if (!latest || latest === latestUserMessage) {
            return;
          }
          latestUserMessage = latest;
          userMessages = assistantMessages;
          const update = this.updateRunUserMessage(automationId, activeRunId, latest, assistantMessages)
            .catch(() => undefined)
            .finally(() => {
              progressUpdates.delete(update);
            });
          progressUpdates.add(update);
        },
      });
      await waitForProgressUpdates();

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
      await waitForProgressUpdates();
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
        this.options.onAutomationUpdated({
          automation: next,
          run: next.lastRun,
          ...(run.status === 'failed' && run.transcript ? { diagnosticTranscript: run.transcript } : {}),
        });
        await this.scheduleAutomation(automationId);
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
              `  Status: ${appEntry.status}`,
              `  Description: ${appEntry.description ?? ''}`,
              `  Relative workspace: ${path.posix.join('apps', appEntry.id)}`,
            ].join('\n'),
          )
        : ['- No included apps.'];

    return renderPromptFile('automations/global-automation.md', {
      automationName: automation.name,
      forgerPartial: renderPromptFile('partials/forger.md', {}),
      appLines: appLines.join('\n'),
      userInstruction: automation.prompt,
    });
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

  private async scheduleAll(): Promise<void> {
    for (const automation of this.automations.values()) {
      await this.scheduleAutomation(automation.id);
    }
  }

  private async scheduleAutomation(id: string): Promise<void> {
    this.clearTimer(id);
    const automation = this.automations.get(id);
    if (!automation?.enabled || !automation.nextRunAt) {
      return;
    }
    const dueAt = Date.parse(automation.nextRunAt);
    if (!Number.isFinite(dueAt)) {
      await this.skipMissedRun(id, 'automation_invalid_schedule');
      return;
    }
    const delay = dueAt - Date.now();
    if (delay <= 0) {
      await this.handleDueScheduledRun(id);
      return;
    }
    const timer = setTimeout(() => {
      void this.scheduleAutomation(id);
    }, Math.min(delay, MAX_TIMEOUT_MS));
    this.timers.set(id, timer);
  }

  private async handleDueScheduledRun(id: string): Promise<void> {
    const automation = this.automations.get(id);
    if (!automation?.enabled || !automation.nextRunAt) {
      return;
    }
    const dueAt = Date.parse(automation.nextRunAt);
    const latenessMs = Date.now() - dueAt;
    if (latenessMs <= MISSED_RUN_GRACE_MS) {
      void this.startRun(id, 'scheduled');
      return;
    }
    if (automation.missedRunPolicy === 'always') {
      void this.startRun(id, 'scheduled');
      return;
    }
    if (automation.missedRunPolicy === 'within_window') {
      const windowMs = (automation.missedRunWindowMinutes ?? defaultMissedRunWindowMinutes(automation.frequency)) * 60_000;
      if (latenessMs <= windowMs) {
        void this.startRun(id, 'scheduled');
        return;
      }
    }
    await this.skipMissedRun(id, 'automation_missed_schedule');
  }

  private async skipMissedRun(id: string, error: string): Promise<void> {
    const automation = this.automations.get(id);
    if (!automation) {
      return;
    }
    const run = await this.createRunRecord(automation, 'scheduled', 'skipped', error);
    await this.updateLastRun(automation.id, toRunSummary(run));
    const current = this.automations.get(id);
    if (!current) {
      return;
    }
    const next: Automation = {
      ...current,
      running: false,
      nextRunAt: current.enabled ? computeNextRunAt(current.frequency) : null,
      updatedAt: new Date().toISOString(),
    };
    this.automations.set(id, next);
    await this.saveAutomations();
    this.options.onAutomationUpdated({ automation: next, run: toRunSummary(run) });
    await this.scheduleAutomation(id);
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
      runtime: sanitizeRuntime(entry.runtime),
      missedRunPolicy: sanitizeMissedRunPolicy(entry.missedRunPolicy),
      missedRunWindowMinutes: sanitizeMissedRunWindowMinutes(entry.missedRunWindowMinutes, sanitizeFrequency(entry.frequency)),
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

  private async writeRun(run: AutomationRun, options: { writeTranscript?: boolean } = {}): Promise<void> {
    await fs.mkdir(this.runsRoot(), { recursive: true });
    await fs.writeFile(this.runFilePath(run.id), JSON.stringify(run, null, 2), 'utf8');
    if (options.writeTranscript !== false && run.transcript) {
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
    await this.writeRun(next, { writeTranscript: false });
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
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(item))));
};

const sanitizeFrequency = (value: unknown): AutomationFrequency => {
  const input = value && typeof value === 'object' ? value as Partial<AutomationFrequency> : {};
  if (input.type === 'interval') {
    return { type: 'interval', intervalMinutes: normalizeIntervalMinutes(input.intervalMinutes) };
  }
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

const sanitizeRuntime = (value: unknown): AgentRuntime | undefined =>
  normalizeAgentRuntime(value);

const sanitizeMissedRunPolicy = (value: unknown): AutomationMissedRunPolicy =>
  value === 'skip' || value === 'always' || value === 'within_window'
    ? value
    : DEFAULT_AUTOMATION_MISSED_RUN_POLICY;

const sanitizeMissedRunWindowMinutes = (value: unknown, frequency: AutomationFrequency): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return defaultMissedRunWindowMinutes(frequency);
  }
  const rounded = Math.round(numeric);
  return Math.min(30 * 24 * 60, Math.max(1, rounded));
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

const normalizeIntervalMinutes = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(numeric)));
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
  if (message === 'antigravity_auth_missing') {
    return 'No se pudo ejecutar porque Antigravity no tiene una sesion activa.';
  }
  if (message === 'antigravity_cli_missing') {
    return 'No se pudo ejecutar porque Antigravity no esta listo en este equipo.';
  }
  if (message === 'automation_missed_schedule') {
    return 'La automatizacion no se ejecuto porque Forger no estaba disponible dentro de la ventana configurada.';
  }
  if (message === 'automation_invalid_schedule') {
    return 'La automatizacion no se ejecuto porque tenia una fecha programada invalida.';
  }
  if (message.startsWith('codex_timeout_after_')) {
    return 'La automatizacion se detuvo porque tardo demasiado en responder.';
  }
  return 'La automatizacion no se pudo completar.';
};
