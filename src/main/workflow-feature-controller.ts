import type { WorkflowManager } from './workflow-manager';

export interface WorkflowFeatureControllerOptions {
  initialEnabled?: boolean;
  createManager: () => WorkflowManager;
  persistEnabled?: (enabled: boolean) => void | Promise<void>;
  onManagerChanged?: (manager: WorkflowManager | null) => void;
}

type OperationKind = 'initialize' | 'enable' | 'disable' | 'dispose';

interface PendingOperation {
  kind: OperationKind;
  promise: Promise<unknown>;
}

export class WorkflowFeatureController {
  private enabled = false;
  private manager: WorkflowManager | null = null;
  private preferenceEnabled: boolean;
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperation: PendingOperation | null = null;

  public constructor(private readonly options: WorkflowFeatureControllerOptions) {
    this.preferenceEnabled = options.initialEnabled === true;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getManager(): WorkflowManager | null {
    return this.manager;
  }

  public requireManager(): WorkflowManager {
    if (!this.enabled || !this.manager) {
      throw new Error('workflow_feature_disabled');
    }
    return this.manager;
  }

  public async initialize(): Promise<void> {
    await this.enqueue('initialize', async () => {
      if (!this.preferenceEnabled || this.manager) return;
      await this.activate(false);
    });
  }

  public enable(): Promise<WorkflowManager> {
    return this.enqueue('enable', async () => {
      if (this.enabled && this.manager) return this.manager;
      return await this.activate(true);
    });
  }

  public disable(): Promise<void> {
    return this.enqueue('disable', async () => {
      if (!this.manager && !this.preferenceEnabled) return;

      const manager = this.closeGate();
      let failure: unknown;

      try {
        await this.options.persistEnabled?.(false);
        this.preferenceEnabled = false;
      } catch (error) {
        if (manager) {
          this.manager = manager;
          this.enabled = true;
          this.options.onManagerChanged?.(manager);
        }
        throw error;
      }

      try {
        await manager?.dispose();
      } catch (error) {
        failure ??= error;
      }

      if (failure) throw failure;
    });
  }

  public dispose(): Promise<void> {
    return this.enqueue('dispose', async () => {
      const manager = this.closeGate();
      await manager?.dispose();
    });
  }

  private async activate(persistPreference: boolean): Promise<WorkflowManager> {
    const manager = this.options.createManager();
    try {
      await manager.initialize(persistPreference ? { recalculateSchedulesFromNow: true } : undefined);
      if (persistPreference) {
        await this.options.persistEnabled?.(true);
      }
    } catch (error) {
      try {
        await manager.dispose();
      } catch {
        // Preserve the initialization or persistence failure that caused rollback.
      }
      throw error;
    }

    this.manager = manager;
    this.enabled = true;
    if (persistPreference) this.preferenceEnabled = true;
    this.options.onManagerChanged?.(manager);
    return manager;
  }

  private closeGate(): WorkflowManager | null {
    const manager = this.manager;
    this.enabled = false;
    this.manager = null;
    if (manager) this.options.onManagerChanged?.(null);
    return manager;
  }

  private enqueue<T>(kind: OperationKind, operation: () => Promise<T>): Promise<T> {
    if (this.pendingOperation?.kind === kind) {
      return this.pendingOperation.promise as Promise<T>;
    }

    const promise = this.operationTail.then(operation, operation);
    const pendingOperation: PendingOperation = { kind, promise };
    this.pendingOperation = pendingOperation;
    this.operationTail = promise.then(
      () => undefined,
      () => undefined,
    );
    void promise.then(
      () => this.clearPendingOperation(pendingOperation),
      () => this.clearPendingOperation(pendingOperation),
    );
    return promise;
  }

  private clearPendingOperation(operation: PendingOperation): void {
    if (this.pendingOperation === operation) this.pendingOperation = null;
  }
}
