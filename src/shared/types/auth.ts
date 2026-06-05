export interface CodexAuthStatus {
  installed: boolean;
  authenticated: boolean;
  authFilePath: string;
  codexHome: string;
  codexCliPath?: string;
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
