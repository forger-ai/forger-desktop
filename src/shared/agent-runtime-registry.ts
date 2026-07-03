import type {
  AgentDefaults,
  AgentEffort,
  AgentPermissionMode,
  AgentProvider,
  AgentProviderRuntimeRegistry,
  AgentRuntime,
  AgentRuntimeRequest,
  AntigravityEffort,
  AntigravityModelOption,
  ClaudeEffort,
  ClaudeModelOption,
  CodexModelOption,
  CodexReasoningEffort,
  CreateAgentProviderRuntimeRegistryInput,
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

export const DEFAULT_CODEX_MODEL = 'gpt-5.2';
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'medium';
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'high';
export const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-3.5-flash';
export const DEFAULT_ANTIGRAVITY_EFFORT: AntigravityEffort = 'medium';
export const DEFAULT_AGENT_PROVIDER: AgentProviderPreference = 'auto';
export const LLM_PROVIDER_KEYS: AgentProvider[] = ['codex', 'claude', 'antigravity'];

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
  { displayModelName: 'Sonnet 5', realModelName: 'claude-sonnet-5', defaultEffort: 'high' },
  { displayModelName: 'Fable 5', realModelName: 'claude-fable-5', defaultEffort: 'max' },
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
  { displayModelName: 'Fable', realModelName: 'fable', defaultEffort: 'max' },
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

export const ANTIGRAVITY_MODEL_OPTIONS: AntigravityModelOption[] = [
  {
    displayModelName: 'Gemini 3.5 Flash',
    realModelName: 'gemini-3.5-flash',
    defaultEffort: 'medium',
    cliModelByEffort: {
      low: 'gemini-3.5-flash-low',
      medium: 'gemini-3.5-flash-medium',
      high: 'gemini-3.5-flash-high',
    },
  },
  {
    displayModelName: 'Gemini 3.1 Pro',
    realModelName: 'gemini-3.1-pro',
    defaultEffort: 'high',
    cliModelByEffort: {
      low: 'gemini-3.1-pro-low',
      high: 'gemini-3.1-pro-high',
    },
  },
  {
    displayModelName: 'Claude Sonnet 4.6 Thinking',
    realModelName: 'claude-sonnet-4.6-thinking',
    defaultEffort: 'high',
    cliModelByEffort: {
      high: 'claude-sonnet-4.6-thinking',
    },
  },
  {
    displayModelName: 'Claude Opus 4.6 Thinking',
    realModelName: 'claude-opus-4.6-thinking',
    defaultEffort: 'high',
    cliModelByEffort: {
      high: 'claude-opus-4.6-thinking',
    },
  },
  {
    displayModelName: 'GPT-OSS 120B',
    realModelName: 'gpt-oss-120b',
    defaultEffort: 'medium',
    cliModelByEffort: {
      medium: 'gpt-oss-120b-medium',
    },
  },
];

export const ANTIGRAVITY_EFFORT_OPTIONS: Array<{ label: string; value: AntigravityEffort }> = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
];

export const AGENT_PROVIDER_OPTIONS: Array<{ label: string; value: AgentProviderPreference }> = [
  { label: 'Auto', value: 'auto' },
  { label: 'ChatGPT', value: 'codex' },
  { label: 'Claude', value: 'claude' },
  { label: 'Google', value: 'antigravity' },
];

const PROVIDER_OPTION_BY_VALUE = new Map(AGENT_PROVIDER_OPTIONS.map((option) => [option.value, option]));

export interface ChatProviderOptionsInput {
  codexAuthenticated?: boolean;
  claudeAuthenticated?: boolean;
  antigravityAuthenticated?: boolean;
  lockedProvider?: AgentProvider | null;
}

export const providerOptionLabel = (provider: AgentProvider): string =>
  PROVIDER_OPTION_BY_VALUE.get(provider)?.label ?? provider;

export const buildChatProviderOptions = ({
  codexAuthenticated,
  claudeAuthenticated,
  antigravityAuthenticated,
  lockedProvider,
}: ChatProviderOptionsInput = {}): Array<{ label: string; value: AgentProviderPreference }> => {
  const authenticatedProviders: AgentProvider[] = [
    ...(codexAuthenticated ? ['codex' as const] : []),
    ...(claudeAuthenticated ? ['claude' as const] : []),
    ...(antigravityAuthenticated ? ['antigravity' as const] : []),
  ];
  const options = [
    ...(authenticatedProviders.length > 0 ? [PROVIDER_OPTION_BY_VALUE.get('auto')] : []),
    ...authenticatedProviders.map((provider) => PROVIDER_OPTION_BY_VALUE.get(provider)),
  ].filter((option): option is { label: string; value: AgentProviderPreference } => Boolean(option));

  if (lockedProvider && !options.some((option) => option.value === lockedProvider)) {
    const lockedOption = PROVIDER_OPTION_BY_VALUE.get(lockedProvider);
    if (lockedOption) {
      options.push(lockedOption);
    }
  }

  return options;
};

export const LLM_PROVIDER_REGISTRY = {
  codex: {
    key: 'codex',
    label: 'Codex',
    defaultModel: DEFAULT_CODEX_MODEL,
    defaultEffort: DEFAULT_CODEX_REASONING_EFFORT,
    modelOptions: CODEX_MODEL_OPTIONS,
    effortOptions: CODEX_REASONING_OPTIONS,
    supportsMcp: true,
    supportsConversations: true,
    supportsSkills: false,
  },
  claude: {
    key: 'claude',
    label: 'Claude',
    defaultModel: DEFAULT_CLAUDE_MODEL,
    defaultEffort: DEFAULT_CLAUDE_EFFORT,
    modelOptions: CLAUDE_MODEL_OPTIONS,
    effortOptions: CLAUDE_EFFORT_OPTIONS,
    supportsMcp: true,
    supportsConversations: true,
    supportsSkills: true,
  },
  antigravity: {
    key: 'antigravity',
    label: 'Google Antigravity',
    defaultModel: DEFAULT_ANTIGRAVITY_MODEL,
    defaultEffort: DEFAULT_ANTIGRAVITY_EFFORT,
    modelOptions: ANTIGRAVITY_MODEL_OPTIONS,
    effortOptions: ANTIGRAVITY_EFFORT_OPTIONS,
    supportsMcp: true,
    supportsConversations: true,
    supportsSkills: true,
  },
} as const;

export const AGENT_MODEL_OPTIONS = {
  codex: CODEX_MODEL_OPTIONS,
  claude: CLAUDE_MODEL_OPTIONS,
  antigravity: ANTIGRAVITY_MODEL_OPTIONS,
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
  antigravity: {
    model: DEFAULT_ANTIGRAVITY_MODEL,
    effort: DEFAULT_ANTIGRAVITY_EFFORT,
  },
};

const CODEX_MODELS = new Set(CODEX_MODEL_OPTIONS.map((option) => option.realModelName));
const CODEX_EFFORTS = new Set(CODEX_REASONING_OPTIONS.map((option) => option.value));
const CLAUDE_MODEL_LOOKUP_OPTIONS = [...CLAUDE_MODEL_OPTIONS, ...CLAUDE_LEGACY_MODEL_OPTIONS];
const CLAUDE_MODELS = new Set(CLAUDE_MODEL_LOOKUP_OPTIONS.map((option) => option.realModelName));
const CLAUDE_EFFORTS = new Set(CLAUDE_EFFORT_OPTIONS.map((option) => option.value));
const ANTIGRAVITY_LEGACY_MODEL_ALIASES = new Map<string, { model: string; effort: AntigravityEffort }>(
  ANTIGRAVITY_MODEL_OPTIONS.flatMap((option) =>
    Object.entries(option.cliModelByEffort).map(([effort, cliModel]) => [
      cliModel,
      { model: option.realModelName, effort: effort as AntigravityEffort },
    ]),
  ),
);
const ANTIGRAVITY_MODELS = new Set(ANTIGRAVITY_MODEL_OPTIONS.map((option) => option.realModelName));
const ANTIGRAVITY_EFFORTS = new Set(ANTIGRAVITY_EFFORT_OPTIONS.map((option) => option.value));

export const createAgentProviderRuntimeRegistry = (
  input: CreateAgentProviderRuntimeRegistryInput,
): AgentProviderRuntimeRegistry => ({
  codex: {
    defaultModel: input.codex.defaultModel,
    defaultReasoningEffort: input.codex.defaultReasoningEffort,
    modelValues: new Set(input.codex.modelValues),
    reasoningEffortValues: new Set(input.codex.reasoningEffortValues),
  },
  claude: {
    defaultModel: input.claude.defaultModel,
    defaultEffort: input.claude.defaultEffort,
    modelValues: new Set(input.claude.modelValues),
    effortValues: new Set(input.claude.effortValues),
  },
  antigravity: {
    defaultModel: input.antigravity.defaultModel,
    defaultEffort: input.antigravity.defaultEffort,
    modelValues: new Set(input.antigravity.modelValues),
    effortValues: new Set(input.antigravity.effortValues),
  },
});

export const DEFAULT_AGENT_PROVIDER_RUNTIME_REGISTRY = createAgentProviderRuntimeRegistry({
  codex: {
    defaultModel: DEFAULT_CODEX_MODEL,
    defaultReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    modelValues: CODEX_MODELS,
    reasoningEffortValues: CODEX_EFFORTS,
  },
  claude: {
    defaultModel: DEFAULT_CLAUDE_MODEL,
    defaultEffort: DEFAULT_CLAUDE_EFFORT,
    modelValues: CLAUDE_MODELS,
    effortValues: CLAUDE_EFFORTS,
  },
  antigravity: {
    defaultModel: DEFAULT_ANTIGRAVITY_MODEL,
    defaultEffort: DEFAULT_ANTIGRAVITY_EFFORT,
    modelValues: ANTIGRAVITY_MODELS,
    effortValues: ANTIGRAVITY_EFFORTS,
  },
});

export const getDefaultAgentDefaults = (): AgentDefaults => ({
  codex: { ...DEFAULT_AGENT_DEFAULTS.codex },
  claude: { ...DEFAULT_AGENT_DEFAULTS.claude },
  antigravity: { ...DEFAULT_AGENT_DEFAULTS.antigravity },
});

export const getAgentModelOptions = (provider: AgentProvider): CodexModelOption[] | ClaudeModelOption[] | AntigravityModelOption[] =>
  AGENT_MODEL_OPTIONS[provider];

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

export const getAntigravityModelOption = (model: unknown): AntigravityModelOption | undefined => {
  const normalized = normalizeString(model);
  return ANTIGRAVITY_MODEL_OPTIONS.find((option) => option.realModelName === normalized);
};

export const getAntigravityLegacyModelAlias = (model: unknown): { model: string; effort: AntigravityEffort } | undefined => {
  const normalized = normalizeString(model);
  return normalized ? ANTIGRAVITY_LEGACY_MODEL_ALIASES.get(normalized) : undefined;
};

export const getAntigravitySupportedEfforts = (model: unknown): AntigravityEffort[] => {
  const option = getAntigravityModelOption(model);
  return option
    ? ANTIGRAVITY_EFFORT_OPTIONS.map((entry) => entry.value).filter((effort) => Boolean(option.cliModelByEffort[effort]))
    : ANTIGRAVITY_EFFORT_OPTIONS.map((entry) => entry.value);
};

export const getDefaultAntigravityEffort = (model: unknown): AntigravityEffort =>
  getAntigravityModelOption(model)?.defaultEffort ?? getAntigravityLegacyModelAlias(model)?.effort ?? DEFAULT_ANTIGRAVITY_EFFORT;

export const normalizeAntigravityModelAndEffort = (
  model: unknown,
  effort?: unknown,
  fallbackModel = DEFAULT_ANTIGRAVITY_MODEL,
  fallbackEffort: AntigravityEffort = DEFAULT_ANTIGRAVITY_EFFORT,
): { model: string; effort: AntigravityEffort } => {
  const legacyAlias = getAntigravityLegacyModelAlias(model);
  const canonicalFallbackModel = normalizeAntigravityModel(fallbackModel, DEFAULT_ANTIGRAVITY_MODEL);
  const canonicalModel = legacyAlias?.model ?? normalizeAntigravityModel(model, canonicalFallbackModel);
  const option = getAntigravityModelOption(canonicalModel);
  const preferredEffort = legacyAlias && effort === undefined ? legacyAlias.effort : effort;
  const normalizedEffort = normalizeAntigravityEffort(
    preferredEffort,
    option?.defaultEffort ?? fallbackEffort,
  );
  const effortValue = option?.cliModelByEffort[normalizedEffort]
    ? normalizedEffort
    : option?.defaultEffort ?? fallbackEffort;
  return {
    model: canonicalModel,
    effort: effortValue,
  };
};

export const resolveAntigravityCliModel = (model: unknown, effort: unknown): string => {
  const normalized = normalizeAntigravityModelAndEffort(model, effort);
  const option = getAntigravityModelOption(normalized.model);
  return option?.cliModelByEffort[normalized.effort] ?? normalized.model;
};

export const isAgentProvider = (value: unknown): value is AgentProvider =>
  LLM_PROVIDER_KEYS.includes(value as AgentProvider);

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
export const isAntigravityModel = (value: unknown): value is string => ANTIGRAVITY_MODELS.has(value as string);
export const isAntigravityEffort = (value: unknown): value is AntigravityEffort =>
  ANTIGRAVITY_EFFORTS.has(value as AntigravityEffort);

export const normalizeAgentProviderPreference = (value: unknown, fallback: AgentProviderPreference = DEFAULT_AGENT_PROVIDER): AgentProviderPreference =>
  isAgentProviderPreference(value) ? value : fallback;

export const normalizeProvider = (value: unknown): AgentProvider | undefined =>
  isAgentProvider(value) ? value : undefined;

export function normalizeAgentProviderModel(
  registry: AgentProviderRuntimeRegistry,
  provider: 'codex',
  value: unknown,
  fallback?: string,
): string;
export function normalizeAgentProviderModel(
  registry: AgentProviderRuntimeRegistry,
  provider: 'claude',
  value: unknown,
  fallback?: string,
): string;
export function normalizeAgentProviderModel(
  registry: AgentProviderRuntimeRegistry,
  provider: 'antigravity',
  value: unknown,
  fallback?: string,
): string;
export function normalizeAgentProviderModel(
  registry: AgentProviderRuntimeRegistry,
  provider: AgentProvider,
  value: unknown,
  fallback?: string,
): string {
  const normalized = normalizeString(value);
  const definition = registry[provider];
  const defaultModel = fallback ?? definition.defaultModel;
  return normalized && definition.modelValues.has(normalized) ? normalized : defaultModel;
}

export function normalizeAgentProviderEffort(
  registry: AgentProviderRuntimeRegistry,
  provider: 'codex',
  value: unknown,
  fallback?: CodexReasoningEffort,
): CodexReasoningEffort;
export function normalizeAgentProviderEffort(
  registry: AgentProviderRuntimeRegistry,
  provider: 'claude',
  value: unknown,
  fallback?: ClaudeEffort,
): ClaudeEffort;
export function normalizeAgentProviderEffort(
  registry: AgentProviderRuntimeRegistry,
  provider: 'antigravity',
  value: unknown,
  fallback?: AntigravityEffort,
): AntigravityEffort;
export function normalizeAgentProviderEffort(
  registry: AgentProviderRuntimeRegistry,
  provider: AgentProvider,
  value: unknown,
  fallback?: AgentEffort,
): AgentEffort {
  if (provider === 'claude') {
    const defaultEffort = isClaudeEffort(fallback) ? fallback : registry.claude.defaultEffort;
    return registry.claude.effortValues.has(value as ClaudeEffort) ? value as ClaudeEffort : defaultEffort;
  }
  if (provider === 'antigravity') {
    const defaultEffort = isAntigravityEffort(fallback) ? fallback : registry.antigravity.defaultEffort;
    return registry.antigravity.effortValues.has(value as AntigravityEffort) ? value as AntigravityEffort : defaultEffort;
  }
  const defaultEffort = isCodexReasoningEffort(fallback) ? fallback : registry.codex.defaultReasoningEffort;
  return registry.codex.reasoningEffortValues.has(value as CodexReasoningEffort) ? value as CodexReasoningEffort : defaultEffort;
}

export class AgentRuntimeRequestValidationError extends Error {
  public constructor(public readonly code: string) {
    super(code);
  }
}

export const validateAgentRuntimeRequest = (
  registry: AgentProviderRuntimeRegistry,
  provider: AgentProvider,
  requested?: AgentRuntimeRequest,
): void => {
  if (!requested) {
    return;
  }
  const model = normalizeString(requested.model);
  if (model && !registry[provider].modelValues.has(model)) {
    throw new AgentRuntimeRequestValidationError('agent_runtime_model_unsupported');
  }
  if (requested.effort === undefined) {
    return;
  }
  const effortValid = provider === 'claude'
    ? registry.claude.effortValues.has(requested.effort as ClaudeEffort)
    : provider === 'antigravity'
      ? registry.antigravity.effortValues.has(requested.effort as AntigravityEffort)
      : registry.codex.reasoningEffortValues.has(requested.effort as CodexReasoningEffort);
  if (!effortValid) {
    throw new AgentRuntimeRequestValidationError('agent_runtime_effort_unsupported');
  }
};

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

export const normalizeAntigravityModel = (value: unknown, fallback = DEFAULT_ANTIGRAVITY_MODEL): string =>
  isAntigravityModel(value) ? value as string : getAntigravityLegacyModelAlias(value)?.model ?? fallback;

export const normalizeAntigravityEffort = (value: unknown, fallback: AntigravityEffort = DEFAULT_ANTIGRAVITY_EFFORT): AntigravityEffort =>
  isAntigravityEffort(value) ? value as AntigravityEffort : fallback;

export const normalizeRuntimeEffort = (provider: AgentProvider, value: unknown, fallback?: AgentEffort): AgentEffort =>
  provider === 'claude'
    ? normalizeClaudeEffort(value, fallback && isClaudeEffort(fallback) ? fallback : DEFAULT_CLAUDE_EFFORT)
    : provider === 'antigravity'
      ? normalizeAntigravityEffort(value, fallback && isAntigravityEffort(fallback) ? fallback : DEFAULT_ANTIGRAVITY_EFFORT)
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
  const authProfileId = normalizeString(record?.authProfileId);
  if (provider === 'claude') {
    const normalizedModel = normalizeClaudeModel(model, model);
    return {
      provider,
      model: normalizedModel,
      effort: normalizeClaudeEffort(record?.effort ?? fallback?.effort ?? fallback?.reasoningEffort, getDefaultClaudeEffort(normalizedModel)),
      ...(permissionMode ? { permissionMode } : {}),
      ...(authProfileId ? { authProfileId } : {}),
    };
  }
  if (provider === 'antigravity') {
    const normalized = normalizeAntigravityModelAndEffort(
      model,
      record?.effort ?? fallback?.effort ?? fallback?.reasoningEffort,
      model,
    );
    return {
      provider,
      model: normalized.model,
      effort: normalized.effort,
      ...(permissionMode ? { permissionMode } : {}),
      ...(authProfileId ? { authProfileId } : {}),
    };
  }
  const normalizedModel = normalizeCodexModel(model, model);
  return {
    provider,
    model: normalizedModel,
    effort: normalizeCodexReasoningEffort(record?.effort ?? fallback?.effort ?? fallback?.reasoningEffort, getDefaultCodexReasoningEffort(normalizedModel)),
    ...(permissionMode ? { permissionMode } : {}),
    ...(authProfileId ? { authProfileId } : {}),
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
      ...(normalized.authProfileId ? { authProfileId: normalized.authProfileId } : {}),
    };
  }
  if (normalized?.provider === 'codex') {
    return {
      provider: 'codex',
      model: normalizeCodexModel(normalized.model, defaults.codex.model),
      effort: normalizeCodexReasoningEffort(normalized.effort, defaults.codex.reasoningEffort),
      permissionMode: normalizeAgentPermissionMode(normalized.permissionMode),
      ...(normalized.authProfileId ? { authProfileId: normalized.authProfileId } : {}),
    };
  }
  if (normalized?.provider === 'antigravity') {
    const antigravity = normalizeAntigravityModelAndEffort(
      normalized.model,
      normalized.effort,
      defaults.antigravity.model,
      defaults.antigravity.effort,
    );
    return {
      provider: 'antigravity',
      model: antigravity.model,
      effort: antigravity.effort,
      permissionMode: normalizeAgentPermissionMode(normalized.permissionMode),
      ...(normalized.authProfileId ? { authProfileId: normalized.authProfileId } : {}),
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
  antigravityAuthenticated?: boolean;
  defaultProvider?: AgentProviderPreference;
  defaults?: AgentDefaults;
  providerConnections?: Partial<Record<AgentProvider, string | undefined>>;
}

export const chooseDefaultAgentProvider = ({
  codexAuthenticated,
  claudeAuthenticated,
  antigravityAuthenticated,
  defaultProvider = DEFAULT_AGENT_PROVIDER,
  providerConnections = {},
}: DefaultAgentRuntimeInput = {}): AgentProvider => {
  const connected: AgentProvider[] = [
    ...(codexAuthenticated ? ['codex' as const] : []),
    ...(claudeAuthenticated ? ['claude' as const] : []),
    ...(antigravityAuthenticated ? ['antigravity' as const] : []),
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
): AgentRuntime => {
  if (provider === 'claude') {
    return {
      provider,
      model: normalizeClaudeModel(defaults.claude.model, DEFAULT_CLAUDE_MODEL),
      effort: normalizeClaudeEffort(defaults.claude.effort, DEFAULT_CLAUDE_EFFORT),
    };
  }
  if (provider === 'antigravity') {
    const antigravity = normalizeAntigravityModelAndEffort(
      defaults.antigravity.model,
      defaults.antigravity.effort,
      DEFAULT_ANTIGRAVITY_MODEL,
      DEFAULT_ANTIGRAVITY_EFFORT,
    );
    return {
      provider,
      model: antigravity.model,
      effort: antigravity.effort,
    };
  }
  return {
    provider,
    model: normalizeCodexModel(defaults.codex.model, DEFAULT_CODEX_MODEL),
    effort: normalizeCodexReasoningEffort(defaults.codex.reasoningEffort, DEFAULT_CODEX_REASONING_EFFORT),
  };
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
    && normalizeAgentPermissionMode(left.permissionMode) === normalizeAgentPermissionMode(right.permissionMode)
    && (left.authProfileId ?? '') === (right.authProfileId ?? ''),
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
