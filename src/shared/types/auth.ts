export interface CodexAuthStatus {
  installed: boolean;
  authenticated: boolean;
  authFilePath: string;
  codexHome: string;
  codexCliPath?: string;
  rateLimits?: CodexRateLimitsStatus;
}

export interface CodexRateLimitWindow {
  usedPercent?: number;
  remainingPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface CodexRateLimitBucket {
  limitId: string;
  limitName?: string | null;
  planType?: string | null;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow | null;
  rateLimitReachedType?: string | null;
  credits?: Record<string, unknown> | null;
}

export interface CodexRateLimitsStatus {
  primary?: CodexRateLimitBucket;
  buckets: CodexRateLimitBucket[];
  checkedAt: string;
}

export interface ClaudeAuthStatus {
  installed: boolean;
  authenticated: boolean;
  source: 'managed' | 'system' | 'missing';
  claudeCliPath?: string;
  version?: string;
  statusText?: string;
  userMessage?: string;
}

export interface DesktopErrorReportInput {
  source: 'desktop' | 'renderer' | 'app' | 'agent' | 'codex' | 'automation' | 'update';
  operation?: string;
  message: string;
  technicalCode?: string;
  appId?: string;
  appVersion?: string;
  details?: Record<string, unknown>;
  sensitiveDetails?: Record<string, unknown>;
}

export interface DesktopErrorReportPreview extends DesktopErrorReportInput {
  desktopVersion?: string;
  platform?: string;
  arch?: string;
  occurredAt: string;
  diagnosticAttachmentToken?: string;
  diagnosticFiles?: DesktopErrorReportFileSummary[];
}

export interface DesktopErrorReportFileSummary {
  kind:
    | 'install_log'
    | 'desktop_log'
    | 'run_log'
    | 'runtime_status'
    | 'app_mcp_log'
    | 'agent_run'
    | 'provider_session'
    | 'renderer_stack'
    | 'main_stack'
    | 'automation_transcript';
  filename: string;
  contentType: string;
  originalByteSize: number;
  sanitizedByteSize: number;
  lineCount?: number;
  truncated?: boolean;
}
