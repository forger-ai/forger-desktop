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

export interface AgentRuntime {
  provider: AgentProvider;
  model: string;
  effort: AgentEffort;
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

export interface AgentModelOptions {
  codex: CodexModelOption[];
  claude: Array<{ displayModelName: string; realModelName: string; defaultEffort: ClaudeEffort }>;
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

export interface AppAiSubscriptionStatus {
  connected: boolean;
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexModelOption {
  displayModelName: string;
  realModelName: string;
  defaultReasoningEffort: CodexReasoningEffort;
}
