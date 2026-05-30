import type {
  AgentDefaults,
  AgentEffort,
  AgentPermissionMode,
  AgentProvider,
  AgentRuntime,
  ClaudeEffort,
  ClaudeModelOption,
  CodexModelOption,
  CodexReasoningEffort,
} from './types/agent-runtime';

export type AgentProviderPreference = AgentProvider | 'auto';
export type AgentRuntimeSource = 'override' | 'manifest' | 'global';
export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'safe';

export interface LegacyCodexRuntimeInput {
  model?: unknown;
  reasoningEffort?: unknown;
  effort?: unknown;
}

export interface NormalizeAgentRuntimeFallback extends LegacyCodexRuntimeInput {
  provider?: unknown;
  permissionMode?: unknown;
}

export const DEFAULT_CODEX_MODEL = 'gpt-5.4';
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'medium';
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'medium';
export const DEFAULT_AGENT_PROVIDER: AgentProviderPreference = 'auto';

export const CODEX_MODEL_OPTIONS: CodexModelOption[] = [
  { displayModelName: '5.5', realModelName: 'gpt-5.5', defaultReasoningEffort: 'medium' },
  { displayModelName: '5.4', realModelName: 'gpt-5.4', defaultReasoningEffort: 'medium' },
  { displayModelName: '5.4 Mini', realModelName: 'gpt-5.4-mini', defaultReasoningEffort: 'medium' },
  { displayModelName: '5.3 Codex', realModelName: 'gpt-5.3-codex', defaultReasoningEffort: 'low' },
  { displayModelName: '5.3 Spark', realModelName: 'gpt-5.3-codex-spark', defaultReasoningEffort: 'high' },
  { displayModelName: '5.2', realModelName: 'gpt-5.2', defaultReasoningEffort: 'medium' },
];

export const CODEX_REASONING_OPTIONS: Array<{ label: string; value: CodexReasoningEffort }> = [
  { label: 'None', value: 'none' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'XHigh', value: 'xhigh' },
];

export const CLAUDE_MODEL_OPTIONS: ClaudeModelOption[] = [
  { displayModelName: 'Opus 4.8', realModelName: 'claude-opus-4-8', defaultEffort: 'high' },
  { displayModelName: 'Opus 4.7', realModelName: 'claude-opus-4-7', defaultEffort: 'xhigh' },
  { displayModelName: 'Opus 4.6', realModelName: 'claude-opus-4-6', defaultEffort: 'high' },
  { displayModelName: 'Opus 4.5', realModelName: 'claude-opus-4-5-20251101', defaultEffort: 'high' },
  { displayModelName: 'Sonnet 4.6', realModelName: 'claude-sonnet-4-6', defaultEffort: 'high' },
  { displayModelName: 'Sonnet 4.5', realModelName: 'claude-sonnet-4-5-20250929', defaultEffort: 'medium' },
  { displayModelName: 'Haiku 4.5', realModelName: 'claude-haiku-4-5-20251001', defaultEffort: 'low' },
];

const CLAUDE_LEGACY_MODEL_OPTIONS: ClaudeModelOption[] = [
  { displayModelName: 'Default', realModelName: 'default', defaultEffort: 'medium' },
  { displayModelName: 'Best', realModelName: 'best', defaultEffort: 'high' },
  { displayModelName: 'Sonnet', realModelName: 'sonnet', defaultEffort: 'medium' },
  { displayModelName: 'Opus', realModelName: 'opus', defaultEffort: 'high' },
  { displayModelName: 'Haiku', realModelName: 'haiku', defaultEffort: 'low' },
  { displayModelName: 'Sonnet 1M', realModelName: 'sonnet[1m]', defaultEffort: 'high' },
  { displayModelName: 'Opus 1M', realModelName: 'opus[1m]', defaultEffort: 'high' },
  { displayModelName: 'Opus Plan', realModelName: 'opusplan', defaultEffort: 'high' },
];

export const CLAUDE_EFFORT_OPTIONS: Array<{ label: string; value: ClaudeEffort }> = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'XHigh', value: 'xhigh' },
  { label: 'Max', value: 'max' },
];

export const AGENT_PROVIDER_OPTIONS: Array<{ label: string; value: AgentProviderPreference }> = [
  { label: 'Auto', value: 'auto' },
  { label: 'Codex', value: 'codex' },
  { label: 'Claude', value: 'claude' },
];

export const AGENT_MODEL_OPTIONS = {
  codex: CODEX_MODEL_OPTIONS,
  claude: CLAUDE_MODEL_OPTIONS,
} as const;

export const DEFAULT_AGENT_DEFAULTS: AgentDefaults = {
  codex: {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  },
  claude: {
    model: DEFAULT_CLAUDE_MODEL,
    effort: DEFAULT_CLAUDE_EFFORT,
  },
};

const CODEX_MODELS = new Set(CODEX_MODEL_OPTIONS.map((option) => option.realModelName));
const CODEX_EFFORTS = new Set(CODEX_REASONING_OPTIONS.map((option) => option.value));
const CLAUDE_MODEL_LOOKUP_OPTIONS = [...CLAUDE_MODEL_OPTIONS, ...CLAUDE_LEGACY_MODEL_OPTIONS];
const CLAUDE_MODELS = new Set(CLAUDE_MODEL_LOOKUP_OPTIONS.map((option) => option.realModelName));
const CLAUDE_EFFORTS = new Set(CLAUDE_EFFORT_OPTIONS.map((option) => option.value));

export const getDefaultAgentDefaults = (): AgentDefaults => ({
  codex: { ...DEFAULT_AGENT_DEFAULTS.codex },
  claude: { ...DEFAULT_AGENT_DEFAULTS.claude },
});

export const getAgentModelOptions = (provider: AgentProvider): CodexModelOption[] | ClaudeModelOption[] =>
  provider === 'claude' ? CLAUDE_MODEL_OPTIONS : CODEX_MODEL_OPTIONS;

export const getCodexModelOption = (model: unknown): CodexModelOption | undefined => {
  const normalized = normalizeString(model);
  return CODEX_MODEL_OPTIONS.find((option) => option.realModelName === normalized);
};

export const getClaudeModelOption = (model: unknown): ClaudeModelOption | undefined => {
  const normalized = normalizeString(model);
  return CLAUDE_MODEL_LOOKUP_OPTIONS.find((option) => option.realModelName === normalized);
};

export const getDefaultCodexReasoningEffort = (model: unknown): CodexReasoningEffort =>
  getCodexModelOption(model)?.defaultReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;

export const getDefaultClaudeEffort = (model: unknown): ClaudeEffort =>
  getClaudeModelOption(model)?.defaultEffort ?? DEFAULT_CLAUDE_EFFORT;

export const isAgentProvider = (value: unknown): value is AgentProvider =>
  value === 'codex' || value === 'claude';

export const isAgentPermissionMode = (value: unknown): value is AgentPermissionMode =>
  value === 'safe' || value === 'unsafe';

export const normalizeAgentPermissionMode = (
  value: unknown,
  fallback: AgentPermissionMode = DEFAULT_AGENT_PERMISSION_MODE,
): AgentPermissionMode => isAgentPermissionMode(value) ? value : fallback;

export const isAgentProviderPreference = (value: unknown): value is AgentProviderPreference =>
  isAgentProvider(value) || value === 'auto';

export const isCodexModel = (value: unknown): value is string => CODEX_MODELS.has(value as string);
export const isCodexReasoningEffort = (value: unknown): value is CodexReasoningEffort =>
  CODEX_EFFORTS.has(value as CodexReasoningEffort);
export const isClaudeModel = (value: unknown): value is string => CLAUDE_MODELS.has(value as string);
export const isClaudeEffort = (value: unknown): value is ClaudeEffort =>
  CLAUDE_EFFORTS.has(value as ClaudeEffort);

export const normalizeAgentProviderPreference = (value: unknown, fallback: AgentProviderPreference = DEFAULT_AGENT_PROVIDER): AgentProviderPreference =>
  isAgentProviderPreference(value) ? value : fallback;

export const normalizeProvider = (value: unknown): AgentProvider | undefined =>
  isAgentProvider(value) ? value : undefined;

export const normalizeCodexModel = (value: unknown, fallback = DEFAULT_CODEX_MODEL): string =>
  isCodexModel(value) ? value as string : fallback;

export const normalizeCodexReasoningEffort = (
  value: unknown,
  fallback: CodexReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
): CodexReasoningEffort =>
  isCodexReasoningEffort(value) ? value as CodexReasoningEffort : fallback;

export const normalizeClaudeModel = (value: unknown, fallback = DEFAULT_CLAUDE_MODEL): string =>
  isClaudeModel(value) ? value as string : fallback;

export const normalizeClaudeEffort = (value: unknown, fallback: ClaudeEffort = DEFAULT_CLAUDE_EFFORT): ClaudeEffort =>
  isClaudeEffort(value) ? value as ClaudeEffort : fallback;

export const normalizeRuntimeEffort = (provider: AgentProvider, value: unknown, fallback?: AgentEffort): AgentEffort =>
  provider === 'claude'
    ? normalizeClaudeEffort(value, fallback && isClaudeEffort(fallback) ? fallback : DEFAULT_CLAUDE_EFFORT)
    : normalizeCodexReasoningEffort(value, fallback && isCodexReasoningEffort(fallback) ? fallback : DEFAULT_CODEX_REASONING_EFFORT);

export const legacyCodexRuntime = (input?: LegacyCodexRuntimeInput): AgentRuntime | undefined => {
  const model = normalizeString(input?.model);
  if (!model) {
    return undefined;
  }
  return {
    provider: 'codex',
    model: normalizeCodexModel(model, model),
    effort: normalizeCodexReasoningEffort(input?.reasoningEffort ?? input?.effort, getDefaultCodexReasoningEffort(model)),
  };
};

export const normalizeAgentRuntime = (
  value: unknown,
  fallback?: NormalizeAgentRuntimeFallback,
): AgentRuntime | undefined => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const provider = normalizeProvider(record?.provider ?? fallback?.provider);
  const model = normalizeString(record?.model) ?? normalizeString(fallback?.model);
  if (!provider || !model) {
    return legacyCodexRuntime(fallback);
  }
  const rawPermissionMode = record?.permissionMode ?? fallback?.permissionMode;
  const permissionMode = isAgentPermissionMode(rawPermissionMode) ? rawPermissionMode : undefined;
  if (provider === 'claude') {
    const normalizedModel = normalizeClaudeModel(model, model);
    return {
      provider,
      model: normalizedModel,
      effort: normalizeClaudeEffort(record?.effort ?? fallback?.effort ?? fallback?.reasoningEffort, getDefaultClaudeEffort(normalizedModel)),
      ...(permissionMode ? { permissionMode } : {}),
    };
  }
  const normalizedModel = normalizeCodexModel(model, model);
  return {
    provider,
    model: normalizedModel,
    effort: normalizeCodexReasoningEffort(record?.effort ?? fallback?.effort ?? fallback?.reasoningEffort, getDefaultCodexReasoningEffort(normalizedModel)),
    ...(permissionMode ? { permissionMode } : {}),
  };
};

export const resolveAgentRuntime = (
  value: unknown,
  defaults: AgentDefaults = DEFAULT_AGENT_DEFAULTS,
  fallback?: NormalizeAgentRuntimeFallback,
): AgentRuntime => {
  const normalized = normalizeAgentRuntime(value, fallback);
  if (normalized?.provider === 'claude') {
    return {
      provider: 'claude',
      model: normalizeClaudeModel(normalized.model, defaults.claude.model),
      effort: normalizeClaudeEffort(normalized.effort, defaults.claude.effort),
      permissionMode: normalizeAgentPermissionMode(normalized.permissionMode),
    };
  }
  if (normalized?.provider === 'codex') {
    return {
      provider: 'codex',
      model: normalizeCodexModel(normalized.model, defaults.codex.model),
      effort: normalizeCodexReasoningEffort(normalized.effort, defaults.codex.reasoningEffort),
      permissionMode: normalizeAgentPermissionMode(normalized.permissionMode),
    };
  }
  return {
    provider: 'codex',
    model: defaults.codex.model,
    effort: defaults.codex.reasoningEffort,
  };
};

export const runtimeFromDefaults = (defaults: AgentDefaults = DEFAULT_AGENT_DEFAULTS): AgentRuntime => ({
  provider: 'codex',
  model: defaults.codex.model,
  effort: defaults.codex.reasoningEffort,
});

export interface DefaultAgentRuntimeInput {
  codexAuthenticated?: boolean;
  claudeAuthenticated?: boolean;
  defaultProvider?: AgentProviderPreference;
  defaults?: AgentDefaults;
  providerConnections?: Partial<Record<AgentProvider, string | undefined>>;
}

export const chooseDefaultAgentProvider = ({
  codexAuthenticated,
  claudeAuthenticated,
  defaultProvider = DEFAULT_AGENT_PROVIDER,
  providerConnections = {},
}: DefaultAgentRuntimeInput = {}): AgentProvider => {
  const connected: AgentProvider[] = [
    ...(codexAuthenticated ? ['codex' as const] : []),
    ...(claudeAuthenticated ? ['claude' as const] : []),
  ];
  const preferred = normalizeAgentProviderPreference(defaultProvider);
  if (connected.length === 0) {
    return preferred === 'auto' ? 'codex' : preferred;
  }
  if (connected.length === 1) {
    return connected[0];
  }
  if (preferred !== 'auto' && connected.includes(preferred)) {
    return preferred;
  }
  const sorted = connected
    .map((provider) => ({ provider, connectedAt: providerConnections[provider] }))
    .filter((entry): entry is { provider: AgentProvider; connectedAt: string } => Boolean(entry.connectedAt))
    .sort((left, right) => Date.parse(left.connectedAt) - Date.parse(right.connectedAt));
  return sorted[0]?.provider ?? 'codex';
};

export const runtimeFromDefaultsForProvider = (
  provider: AgentProvider,
  defaults: AgentDefaults = DEFAULT_AGENT_DEFAULTS,
): AgentRuntime => provider === 'claude'
  ? {
      provider,
      model: normalizeClaudeModel(defaults.claude.model, DEFAULT_CLAUDE_MODEL),
      effort: normalizeClaudeEffort(defaults.claude.effort, DEFAULT_CLAUDE_EFFORT),
    }
  : {
      provider,
      model: normalizeCodexModel(defaults.codex.model, DEFAULT_CODEX_MODEL),
      effort: normalizeCodexReasoningEffort(defaults.codex.reasoningEffort, DEFAULT_CODEX_REASONING_EFFORT),
    };

export const runtimeFromUserDefaults = (input: DefaultAgentRuntimeInput = {}): AgentRuntime =>
  runtimeFromDefaultsForProvider(chooseDefaultAgentProvider(input), input.defaults ?? DEFAULT_AGENT_DEFAULTS);

export const agentRuntimeEquals = (left?: AgentRuntime | null, right?: AgentRuntime | null): boolean =>
  Boolean(
    left
    && right
    && left.provider === right.provider
    && left.model === right.model
    && left.effort === right.effort
    && normalizeAgentPermissionMode(left.permissionMode) === normalizeAgentPermissionMode(right.permissionMode),
  );

export const resolveRuntimeSource = (manifestRuntime: unknown, overrideRuntime: unknown): AgentRuntimeSource => {
  if (normalizeAgentRuntime(overrideRuntime)) {
    return 'override';
  }
  if (normalizeAgentRuntime(manifestRuntime)) {
    return 'manifest';
  }
  return 'global';
};

const normalizeString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
