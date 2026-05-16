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
}
