import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import type {
  AppCodexConversationEvent,
  AppCodexTaskEvent,
  DesktopErrorReportInput,
  DesktopErrorReportPreview,
} from '../shared/types';
import { normalizeErrorReportDiagnostic } from '../shared/error-diagnostics';

type InstalledAppLookup = (appId: string) => { version?: string } | null | undefined;

interface DesktopErrorReporterOptions {
  getMainWindow: () => BrowserWindow | null;
  getAppVersion: () => string;
  getInstalledApp: InstalledAppLookup;
  platform?: NodeJS.Platform;
  arch?: string;
  dedupeTtlMs?: number;
}

const DEFAULT_DEDUPE_TTL_MS = 30_000;

const EXPECTED_ERROR_CODES = new Set([
  'app_not_installed',
  'app_update_conflict',
  'auth_missing',
  'canceled',
  'codex_auth_missing',
  'codex_auth_expired',
  'missing_secrets',
  'no_pending_update_conflict',
  'permission_denied',
  'quota_exceeded',
  'model_unsupported',
  'required_app_secrets_missing',
  'secrets_encryption_unavailable',
  'secrets_vault_unavailable',
  'tool_not_found',
  'unknown_tool',
]);

export class DesktopErrorReporter {
  private readonly seen = new Map<string, number>();
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly dedupeTtlMs: number;

  public constructor(private readonly options: DesktopErrorReporterOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
  }

  public buildPreview(input: DesktopErrorReportInput): DesktopErrorReportPreview {
    return normalizeErrorReportDiagnostic({
      ...input,
      desktopVersion: this.options.getAppVersion(),
      platform: this.platform,
      arch: this.arch,
      occurredAt: new Date().toISOString(),
    });
  }

  public request(input: DesktopErrorReportInput): void {
    if (this.isExpected(input.technicalCode)) {
      return;
    }
    const mainWindow = this.options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.webContents.isDestroyed?.()) {
      return;
    }
    const preview = this.buildPreview(input);
    if (this.shouldDedupe(preview)) {
      return;
    }
    try {
      mainWindow.webContents.send(IPC_CHANNELS.desktopErrorReportRequested, preview);
    } catch {
      // Reporting must never become the uncaught exception handler's own failure.
    }
  }

  public reportMainUncaughtException(error: Error): void {
    this.request({
      source: 'desktop',
      operation: 'uncaughtException',
      message: error.message,
      technicalCode: 'main_uncaught_exception',
      sensitiveDetails: { stack: error.stack },
    });
  }

  public reportMainUnhandledRejection(reason: unknown): void {
    this.request({
      source: 'desktop',
      operation: 'unhandledRejection',
      message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection'),
      technicalCode: 'main_unhandled_rejection',
      sensitiveDetails: {
        stack: reason instanceof Error ? reason.stack : undefined,
        reason: reason instanceof Error ? undefined : String(reason ?? ''),
      },
    });
  }

  public reportRendererProcessGone(details: { reason: string; exitCode: number }): void {
    this.request({
      source: 'renderer',
      operation: 'render-process-gone',
      message: `Renderer process ended: ${details.reason}`,
      technicalCode: 'renderer_process_gone',
      details: {
        reason: details.reason,
        exitCode: details.exitCode,
      },
    });
  }

  public reportAppCodexTaskEvent(event: AppCodexTaskEvent): void {
    if (event.task.status !== 'failed') {
      return;
    }
    const record = this.options.getInstalledApp(event.task.appId);
    const inputLimitDetails = event.task.errorDetails?.technicalCode === 'app_prompt_string_too_long'
      ? event.task.errorDetails
      : null;
    this.request({
      source: 'agent',
      operation: 'app.agent-task',
      message: event.task.error || 'App agent task failed.',
      technicalCode: inputLimitDetails ? 'app_prompt_string_too_long' : 'app_agent_task_failed',
      appId: event.task.appId,
      appVersion: record?.version,
      details: {
        runId: event.task.runId,
        templateId: event.task.templateId,
        status: event.task.status,
        progressLog: event.task.progressLog?.slice(-10),
        ...(inputLimitDetails
          ? {
              argumentName: inputLimitDetails.argumentName,
              maxLength: inputLimitDetails.maxLength,
              actualLength: inputLimitDetails.actualLength,
            }
          : {}),
      },
    });
  }

  public reportAppCodexConversationEvent(event: AppCodexConversationEvent): void {
    if (event.type !== 'run.failed' || !event.run) {
      return;
    }
    const record = this.options.getInstalledApp(event.conversation.appId);
    this.request({
      source: 'agent',
      operation: 'app.agent-conversation',
      message: event.run.error || 'App agent conversation failed.',
      technicalCode: 'app_agent_conversation_failed',
      appId: event.conversation.appId,
      appVersion: record?.version,
      details: {
        conversationId: event.conversation.conversationId,
        runId: event.run.runId,
        status: event.run.status,
        progressLog: event.run.progressLog?.slice(-10),
      },
    });
  }

  public reportAppCodexStartFailure(input: {
    appId: string;
    operation: 'app.codex-task.start' | 'app.codex-conversation.create' | 'app.codex-conversation.send-message';
    error: unknown;
  }): void {
    const record = this.options.getInstalledApp(input.appId);
    this.request({
      source: 'agent',
      operation: input.operation.replace('codex', 'agent'),
      message: errorMessage(input.error, 'App agent invocation failed.'),
      technicalCode: input.operation.replace('codex', 'agent').replace(/\./g, '_'),
      appId: input.appId,
      appVersion: record?.version,
      sensitiveDetails: {
        stack: input.error instanceof Error ? input.error.stack : undefined,
      },
    });
  }

  public reportAppMcpStartFailure(input: { appId: string; runId: string; error: unknown }): void {
    const record = this.options.getInstalledApp(input.appId);
    this.request({
      source: 'agent',
      operation: 'app.mcp.start',
      message: errorMessage(input.error, 'App MCP server failed to start.'),
      technicalCode: 'app_mcp_start_failed',
      appId: input.appId,
      appVersion: record?.version,
      details: {
        runId: input.runId,
      },
      sensitiveDetails: {
        stack: input.error instanceof Error ? input.error.stack : undefined,
      },
    });
  }

  public reportForgerMcpToolFailure(input: {
    appId: string;
    runId: string;
    toolName?: unknown;
    error: unknown;
  }): void {
    this.request({
      source: 'agent',
      operation: 'forger-mcp.tools-call',
      message: errorMessage(input.error, 'Forger MCP tool call failed.'),
      technicalCode: 'forger_mcp_tool_call_failed',
      appId: input.appId,
      details: {
        runId: input.runId,
        toolName: typeof input.toolName === 'string' ? input.toolName : null,
      },
      sensitiveDetails: {
        stack: input.error instanceof Error ? input.error.stack : undefined,
      },
    });
  }

  public reportForgerMcpHttpFailure(input: { error: unknown; appId?: string; runId?: string }): void {
    this.request({
      source: 'agent',
      operation: 'forger-mcp.http',
      message: errorMessage(input.error, 'Forger MCP request failed.'),
      technicalCode: 'forger_mcp_http_failed',
      appId: input.appId,
      details: {
        runId: input.runId,
      },
      sensitiveDetails: {
        stack: input.error instanceof Error ? input.error.stack : undefined,
      },
    });
  }

  public reportChatRunFailure(input: {
    appId: string;
    runId: string;
    errorCode?: string;
    message?: string;
  }): void {
    this.request({
      source: 'agent',
      operation: 'desktop-chat.run',
      message: input.message || input.errorCode || 'Desktop chat run failed.',
      technicalCode: input.errorCode || 'desktop_chat_run_failed',
      appId: input.appId,
      details: {
        runId: input.runId,
      },
    });
  }

  public reportAutomationRunFailure(input: {
    automationId: string;
    runId: string;
    selectedAppIds: string[];
    error: unknown;
  }): void {
    this.request({
      source: 'automation',
      operation: 'automation.run',
      message: errorMessage(input.error, 'Automation run failed.'),
      technicalCode: 'automation_run_failed',
      appId: input.selectedAppIds.length === 1 ? input.selectedAppIds[0] : undefined,
      details: {
        automationId: input.automationId,
        runId: input.runId,
        selectedAppIds: input.selectedAppIds,
      },
      sensitiveDetails: {
        stack: input.error instanceof Error ? input.error.stack : undefined,
      },
    });
  }

  private isExpected(technicalCode: string | undefined): boolean {
    if (!technicalCode) {
      return false;
    }
    return EXPECTED_ERROR_CODES.has(technicalCode);
  }

  private shouldDedupe(input: DesktopErrorReportPreview): boolean {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen.entries()) {
      if (expiresAt <= now) {
        this.seen.delete(key);
      }
    }
    const key = [
      input.source,
      input.operation ?? '',
      input.appId ?? '',
      runIdFromDetails(input.details),
      input.technicalCode ?? '',
    ].join(':');
    const existing = this.seen.get(key);
    if (existing && existing > now) {
      return true;
    }
    this.seen.set(key, now + this.dedupeTtlMs);
    return false;
  }
}

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : typeof error === 'string' && error.trim() ? error : fallback;

const runIdFromDetails = (details: Record<string, unknown> | undefined): string => {
  const value = details?.runId;
  return typeof value === 'string' ? value : '';
};
