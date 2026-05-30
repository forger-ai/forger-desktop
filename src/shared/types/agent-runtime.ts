export interface CodexAuthStatus {
  installed: boolean;
  authenticated: boolean;
  authFilePath: string;
  codexHome: string;
  codexCliPath?: string;
}

export type AgentProvider = 'codex' | 'claude';
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentEffort = CodexReasoningEffort | ClaudeEffort;
export type AgentPermissionMode = 'safe' | 'unsafe';

export interface AgentRuntime {
  provider: AgentProvider;
  model: string;
  effort: AgentEffort;
  permissionMode?: AgentPermissionMode;
}

export interface AgentDefaults {
  codex: {
    model: string;
    reasoningEffort: CodexReasoningEffort;
  };
  claude: {
    model: string;
    effort: ClaudeEffort;
  };
}

export type AgentRuntimeRecommendations = Partial<AgentDefaults>;

export interface AgentRuntimeRequest extends Partial<AgentRuntime> {
  recommendations?: AgentRuntimeRecommendations;
}

export interface AgentModelOptions {
  codex: CodexModelOption[];
  claude: ClaudeModelOption[];
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

export interface AppAiSubscriptionStatus {
  connected: boolean;
}

export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexModelOption {
  displayModelName: string;
  realModelName: string;
  defaultReasoningEffort: CodexReasoningEffort;
}

export interface ClaudeModelOption {
  displayModelName: string;
  realModelName: string;
  defaultEffort: ClaudeEffort;
}
