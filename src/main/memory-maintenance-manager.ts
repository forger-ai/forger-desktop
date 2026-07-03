import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentRuntime, AgentRuntimeRequest } from '../shared/types';
import {
  runAgentCommand,
  type LlmAutomationMcpServerConfig,
} from './automation/agent-command-runner';

interface MemoryMaintenanceManagerOptions {
  forgerHomeRoot: string;
  codexHome: string;
  getAgentRuntime: (requested?: AgentRuntimeRequest) => Promise<AgentRuntime>;
  getCodexAuthenticated: () => Promise<boolean>;
  getCodexCliPath: () => Promise<string | null>;
  getCodexPathEntries: () => Promise<string[]>;
  createForgerMcpSession?: (runId: string) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  buildMemoryContext: () => Promise<string>;
  getMemoryStore: () => {
    recordMaintenanceRun: (input: {
      id?: string;
      status: 'skipped' | 'succeeded' | 'failed';
      summary: string;
      startedAt?: string;
      finishedAt?: string;
    }) => Promise<void>;
  };
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class MemoryMaintenanceManager {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(private readonly options: MemoryMaintenanceManagerOptions) {}

  public async initialize(): Promise<void> {
    this.scheduleNext();
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public async runNow(trigger: 'scheduled' | 'manual' = 'manual'): Promise<void> {
    if (this.running) {
      await this.options.appendInstallLog('memory:maintenance_skipped', { reason: 'already_running', trigger });
      return;
    }
    this.running = true;
    const runId = `memory-maintenance-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    let session: { url: string; token: string } | null = null;
    try {
      if (!(await this.options.getCodexAuthenticated())) {
        await this.record(runId, 'skipped', 'Codex is not connected.', startedAt);
        return;
      }
      const runtime = await this.options.getAgentRuntime({ provider: 'codex' });
      if (runtime.provider !== 'codex') {
        await this.record(runId, 'skipped', 'Codex is not the selected maintenance runtime.', startedAt);
        return;
      }
      const codexCliPath = await this.options.getCodexCliPath();
      if (!codexCliPath) {
        await this.record(runId, 'skipped', 'Codex CLI is not available.', startedAt);
        return;
      }
      session = this.options.createForgerMcpSession?.(runId) ?? null;
      const mcpServers: LlmAutomationMcpServerConfig[] = session
        ? [{
            name: 'forger',
            url: session.url,
            token: session.token,
            tokenEnvVar: 'FORGER_MCP_TOKEN',
            toolTimeoutSec: 600,
          }]
        : [];
      const prompt = await this.buildPrompt();
      const result = await runAgentCommand({ cliPath: codexCliPath, pathEntries: await this.options.getCodexPathEntries() }, {
        runtime,
        cwd: this.options.forgerHomeRoot,
        codexHome: this.options.codexHome,
        prompt,
        transcriptPath: path.join(this.options.codexHome, 'memory-maintenance', `${runId}.log`),
        mcpServers,
        networkAccess: false,
      });
      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || 'memory_maintenance_failed').trim());
      }
      await this.record(runId, 'succeeded', 'Memory maintenance completed.', startedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'memory_maintenance_failed';
      await this.record(runId, 'failed', message, startedAt);
      await this.options.appendInstallLog('memory:maintenance_failed', { runId, message });
    } finally {
      if (session) {
        this.options.releaseForgerMcpSession?.(session.token);
      }
      this.running = false;
      if (trigger === 'scheduled') {
        this.scheduleNext();
      }
    }
  }

  private async buildPrompt(): Promise<string> {
    const memoryContext = await this.options.buildMemoryContext();
    return [
      memoryContext,
      'You are Forger memory maintenance. Work silently.',
      'Review active, candidate, and archived memory through the Forger memory MCP tools.',
      'Use your judgment to improve durable memory only when the change is clearly useful.',
      'You may merge duplicates, improve title/body/read_when wording, archive obsolete candidates, and attach concise evidence.',
      'Do not store secrets, credentials, sensitive personal inferences, local paths, or transient facts.',
      'Use read_when as the retrieval rule. Empty read_when means the full memory is always injected.',
      'Apply changes only through memory_create, memory_update, or memory_delete.',
      'End with a short maintenance summary.',
    ].filter(Boolean).join('\n\n');
  }

  private async record(
    id: string,
    status: 'skipped' | 'succeeded' | 'failed',
    summary: string,
    startedAt: string,
  ): Promise<void> {
    await this.options.getMemoryStore().recordMaintenanceRun({
      id,
      status,
      summary,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }

  private scheduleNext(): void {
    this.dispose();
    const delay = Math.min(msUntilNextThreeAm(), DAY_MS);
    this.timer = setTimeout(() => {
      void this.runNow('scheduled');
    }, delay);
  }
}

const msUntilNextThreeAm = (from = new Date()): number => {
  const next = new Date(from);
  next.setHours(3, 0, 0, 0);
  if (next <= from) {
    next.setDate(next.getDate() + 1);
  }
  return Math.max(1, next.getTime() - from.getTime());
};
