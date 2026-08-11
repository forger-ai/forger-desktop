import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workflow, WorkflowRevision, WorkflowRun, WorkflowRunSummary } from '../../shared/types';

export interface WorkflowStoreOptions {
  metadataRoot: string;
}

export const toWorkflowRunSummary = (run: WorkflowRun): WorkflowRunSummary => ({
  id: run.id,
  workflowId: run.workflowId,
  trigger: run.trigger,
  status: run.status,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  error: run.error,
  pendingApprovalNodeId: run.pendingApprovalNodeId,
  nodeRuns: run.nodeRuns,
  workflowRevision: run.workflowRevision,
  workflowRevisionId: run.workflowRevisionId,
  definitionHash: run.definitionHash,
  retryOfRunId: run.retryOfRunId,
  safeToRetry: run.safeToRetry,
});

export class WorkflowStore {
  public constructor(private readonly options: WorkflowStoreOptions) {}

  public async initialize(): Promise<void> {
    await fs.mkdir(this.runsRoot(), { recursive: true });
    await fs.mkdir(this.revisionsRoot(), { recursive: true });
  }

  public async readWorkflows(): Promise<Workflow[]> {
    const raw = await fs.readFile(this.workflowsFilePath(), 'utf8').catch(() => '[]');
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed as Workflow[] : [];
    } catch {
      return [];
    }
  }

  public async saveWorkflows(workflows: Workflow[]): Promise<void> {
    await this.writeJsonAtomic(this.workflowsFilePath(), workflows);
  }

  public async readRevisions(workflowId: string): Promise<WorkflowRevision[]> {
    const raw = await fs.readFile(this.revisionFilePath(workflowId), 'utf8').catch(() => '[]');
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed as WorkflowRevision[] : [];
    } catch {
      return [];
    }
  }

  public async saveRevisions(workflowId: string, revisions: WorkflowRevision[]): Promise<void> {
    await this.writeJsonAtomic(this.revisionFilePath(workflowId), revisions);
  }

  public async deleteRevisions(workflowId: string): Promise<void> {
    await fs.rm(this.revisionFilePath(workflowId), { force: true });
  }

  public async writeRun(run: WorkflowRun): Promise<void> {
    await fs.mkdir(this.runsRoot(), { recursive: true });
    await this.writeJsonAtomic(this.runFilePath(run.id), { ...run, transcript: undefined });
    if (run.transcript) {
      await fs.writeFile(this.runTranscriptPath(run.id), run.transcript, 'utf8');
    }
  }

  public async readRun(runId: string): Promise<WorkflowRun | null> {
    const raw = await fs.readFile(this.runFilePath(runId), 'utf8').catch(() => '');
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as WorkflowRun;
      const transcript = await fs.readFile(this.runTranscriptPath(runId), 'utf8').catch(() => '');
      return { ...parsed, transcript };
    } catch {
      return null;
    }
  }

  public async appendRunId(workflowId: string, runId: string): Promise<void> {
    const current = await this.readRunIds(workflowId);
    const next = [runId, ...current.filter((id) => id !== runId)].slice(0, 200);
    await fs.mkdir(this.runsRoot(), { recursive: true });
    await this.writeJsonAtomic(this.runIndexPath(workflowId), next);
  }

  public async readRunIds(workflowId: string): Promise<string[]> {
    const raw = await fs.readFile(this.runIndexPath(workflowId), 'utf8').catch(() => '[]');
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  public runTranscriptPath(runId: string): string {
    return this.runStoragePath(`${runId}.log`);
  }

  private workflowsFilePath(): string {
    return path.join(this.options.metadataRoot, 'workflows.json');
  }

  private runsRoot(): string {
    return path.join(this.options.metadataRoot, 'workflow-runs');
  }

  private revisionsRoot(): string {
    return path.join(this.options.metadataRoot, 'workflow-revisions');
  }

  private runStoragePath(fileName: string): string {
    const root = path.resolve(this.runsRoot());
    const target = path.resolve(root, fileName);
    const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (target !== root && !target.startsWith(rootWithSeparator)) {
      throw new Error('workflow_run_path_outside_storage');
    }
    return target;
  }

  private runFilePath(runId: string): string {
    return this.runStoragePath(`${runId}.json`);
  }

  private runIndexPath(workflowId: string): string {
    return this.runStoragePath(`${workflowId}.index.json`);
  }

  private revisionFilePath(workflowId: string): string {
    const root = path.resolve(this.revisionsRoot());
    const target = path.resolve(root, `${workflowId}.json`);
    const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!target.startsWith(rootWithSeparator)) {
      throw new Error('workflow_revision_path_outside_storage');
    }
    return target;
  }

  private async writeJsonAtomic(target: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
