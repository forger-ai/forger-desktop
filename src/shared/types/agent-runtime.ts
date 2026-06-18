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

export type LlmProviderKey = 'codex' | 'claude' | 'antigravity';
/** @deprecated Use LlmProviderKey. Kept for manifest and IPC compatibility during the provider migration. */
export type AgentProvider = LlmProviderKey;
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AntigravityEffort = 'low' | 'medium' | 'high';
export type AgentEffort = CodexReasoningEffort | ClaudeEffort | AntigravityEffort;
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
  antigravity: {
    model: string;
    effort: AntigravityEffort;
  };
}

export type AgentRuntimeRecommendations = Partial<AgentDefaults>;

export interface AgentRuntimeRequest extends Partial<AgentRuntime> {
  recommendations?: AgentRuntimeRecommendations;
}

export interface AgentModelOptions {
  codex: CodexModelOption[];
  claude: ClaudeModelOption[];
  antigravity: AntigravityModelOption[];
}

export interface AgentProviderRuntimeRegistry {
  codex: {
    defaultModel: string;
    defaultReasoningEffort: CodexReasoningEffort;
    modelValues: ReadonlySet<string>;
    reasoningEffortValues: ReadonlySet<CodexReasoningEffort>;
  };
  claude: {
    defaultModel: string;
    defaultEffort: ClaudeEffort;
    modelValues: ReadonlySet<string>;
    effortValues: ReadonlySet<ClaudeEffort>;
  };
  antigravity: {
    defaultModel: string;
    defaultEffort: AntigravityEffort;
    modelValues: ReadonlySet<string>;
    effortValues: ReadonlySet<AntigravityEffort>;
  };
}

export interface CreateAgentProviderRuntimeRegistryInput {
  codex: {
    defaultModel: string;
    defaultReasoningEffort: CodexReasoningEffort;
    modelValues: Iterable<string>;
    reasoningEffortValues: Iterable<CodexReasoningEffort>;
  };
  claude: {
    defaultModel: string;
    defaultEffort: ClaudeEffort;
    modelValues: Iterable<string>;
    effortValues: Iterable<ClaudeEffort>;
  };
  antigravity: {
    defaultModel: string;
    defaultEffort: AntigravityEffort;
    modelValues: Iterable<string>;
    effortValues: Iterable<AntigravityEffort>;
  };
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

export interface AntigravityModelOption {
  displayModelName: string;
  realModelName: string;
  defaultEffort: AntigravityEffort;
}
