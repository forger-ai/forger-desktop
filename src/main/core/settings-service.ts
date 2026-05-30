
import type fs from 'node:fs/promises';
import type path from 'node:path';

import type { PromptOverridesStore } from '../prompt-overrides';
import type {
  AgentDefaults,
  AgentPermissionMode,
  AgentProvider,
  AgentRuntime,
  AgentRuntimeRecommendations,
  AgentRuntimeRequest,
  ClaudeAuthStatus,
  ClaudeEffort,
  CodexAuthStatus,
  CodexReasoningEffort,
  Settings,
  UpdateAgentDefaultsInput,
  UpdateCodexDefaultsInput,
} from '../../shared/types';

interface SettingsServiceState {
  promptOverridesStore: PromptOverridesStore | null;
  settings: Settings;
}

interface SettingsServiceDeps {
  BUILT_IN_CLAUDE_EFFORT: ClaudeEffort;
  BUILT_IN_CLAUDE_MODEL: string;
  BUILT_IN_CODEX_MODEL: string;
  BUILT_IN_CODEX_REASONING: CodexReasoningEffort;
  CLAUDE_EFFORT_VALUES: ReadonlySet<ClaudeEffort>;
  CLAUDE_MODEL_VALUES: ReadonlySet<string>;
  CODEX_MODEL_VALUES: ReadonlySet<string>;
  CODEX_REASONING_VALUES: ReadonlySet<CodexReasoningEffort>;
  PromptOverridesStore: new (filePath: string) => PromptOverridesStore;
  fs: typeof fs;
  getClaudeAuthStatus: () => Promise<ClaudeAuthStatus>;
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  getPromptOverridesPath: () => string;
  getSettingsPath: () => string;
  path: typeof path;
  settingsSeed: Settings;
  state: SettingsServiceState;
}

export const createSettingsServiceController = (deps: SettingsServiceDeps) => {
  const { state, PromptOverridesStore, getPromptOverridesPath, settingsSeed, fs, path, getSettingsPath, BUILT_IN_CODEX_MODEL, BUILT_IN_CODEX_REASONING, BUILT_IN_CLAUDE_MODEL, BUILT_IN_CLAUDE_EFFORT, CODEX_MODEL_VALUES, CODEX_REASONING_VALUES, CLAUDE_MODEL_VALUES, CLAUDE_EFFORT_VALUES, getCodexAuthStatus, getClaudeAuthStatus } = deps;
const getPromptOverridesStore = (): PromptOverridesStore => {
  state.promptOverridesStore ??= new PromptOverridesStore(getPromptOverridesPath());
  return state.promptOverridesStore;
};

const normalizeCodexReasoningEffort = (value: unknown, fallback: CodexReasoningEffort): CodexReasoningEffort =>
  CODEX_REASONING_VALUES.has(value as CodexReasoningEffort) ? value as CodexReasoningEffort : fallback;

const normalizeClaudeEffort = (value: unknown, fallback: ClaudeEffort): ClaudeEffort =>
  CLAUDE_EFFORT_VALUES.has(value as ClaudeEffort) ? value as ClaudeEffort : fallback;

const normalizeCodexModel = (value: unknown, fallback: string): string =>
  typeof value === 'string' && CODEX_MODEL_VALUES.has(value.trim()) ? value.trim() : fallback;

const normalizeClaudeModel = (value: unknown, fallback: string): string =>
  typeof value === 'string' && CLAUDE_MODEL_VALUES.has(value.trim()) ? value.trim() : fallback;

const normalizeAgentProvider = (value: unknown): AgentProvider | undefined =>
  value === 'codex' || value === 'claude' ? value : undefined;

const normalizeDefaultAgentProvider = (value: unknown): AgentProvider | 'auto' =>
  value === 'codex' || value === 'claude' || value === 'auto' ? value : 'auto';

const normalizeAgentPermissionMode = (value: unknown): AgentPermissionMode =>
  value === 'unsafe' ? 'unsafe' : 'safe';

const normalizeSettings = (input?: Partial<Settings>): Settings => {
  const defaults = structuredClone(settingsSeed);
  const rawCodexDefaults =
    input?.codexDefaults && typeof input.codexDefaults === 'object'
      ? input.codexDefaults
      : undefined;
  const rawAgentDefaults =
    input?.agentDefaults && typeof input.agentDefaults === 'object'
      ? input.agentDefaults
      : undefined;
  const rawAgentCodexDefaults =
    rawAgentDefaults?.codex && typeof rawAgentDefaults.codex === 'object'
      ? rawAgentDefaults.codex
      : rawCodexDefaults;
  const rawAgentClaudeDefaults =
    rawAgentDefaults?.claude && typeof rawAgentDefaults.claude === 'object'
      ? rawAgentDefaults.claude
      : undefined;
  const codexModel =
    typeof rawCodexDefaults?.model === 'string' && rawCodexDefaults.model.trim()
      ? rawCodexDefaults.model.trim()
      : BUILT_IN_CODEX_MODEL;
  const codexReasoningEffort = normalizeCodexReasoningEffort(
    rawCodexDefaults?.reasoningEffort,
    BUILT_IN_CODEX_REASONING,
  );
  const providerConnections: Partial<Record<AgentProvider, string>> = {};
  const rawConnections = input?.providerConnections;
  if (rawConnections && typeof rawConnections === 'object') {
    for (const provider of ['codex', 'claude'] as const) {
      const value = rawConnections[provider];
      if (typeof value === 'string' && value.trim()) {
        providerConnections[provider] = value;
      }
    }
  }
  return {
    userEmail: typeof input?.userEmail === 'string' ? input.userEmail : defaults.userEmail,
    plan: typeof input?.plan === 'string' ? input.plan : defaults.plan,
    safeMode: typeof input?.safeMode === 'boolean' ? input.safeMode : defaults.safeMode,
    defaultAgentProvider: normalizeDefaultAgentProvider(input?.defaultAgentProvider),
    defaultChatPermissionMode: normalizeAgentPermissionMode(input?.defaultChatPermissionMode ?? defaults.defaultChatPermissionMode),
    codexDefaults: {
      model: codexModel,
      reasoningEffort: codexReasoningEffort,
    },
    agentDefaults: {
      codex: {
        model:
          typeof rawAgentCodexDefaults?.model === 'string' && rawAgentCodexDefaults.model.trim()
            ? rawAgentCodexDefaults.model.trim()
            : codexModel,
        reasoningEffort: normalizeCodexReasoningEffort(
          rawAgentCodexDefaults?.reasoningEffort,
          codexReasoningEffort,
        ),
      },
      claude: {
        model:
          typeof rawAgentClaudeDefaults?.model === 'string' && rawAgentClaudeDefaults.model.trim()
            ? rawAgentClaudeDefaults.model.trim()
            : BUILT_IN_CLAUDE_MODEL,
        effort: normalizeClaudeEffort(rawAgentClaudeDefaults?.effort, BUILT_IN_CLAUDE_EFFORT),
      },
    },
    providerConnections,
  };
};

const loadSettings = async (): Promise<void> => {
  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf8');
    state.settings = normalizeSettings(JSON.parse(raw) as Partial<Settings>);
  } catch {
    state.settings = normalizeSettings(settingsSeed);
  }
};

const saveSettings = async (): Promise<void> => {
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(normalizeSettings(state.settings), null, 2), 'utf8');
};

const getCodexDefaults = (): Settings['codexDefaults'] => normalizeSettings(state.settings).codexDefaults;

const updateCodexDefaults = async (input: UpdateCodexDefaultsInput): Promise<Settings> => {
  state.settings = normalizeSettings({
    ...state.settings,
    codexDefaults: {
      model: typeof input.model === 'string' ? input.model : '',
      reasoningEffort: input.reasoningEffort,
    },
    agentDefaults: {
      ...state.settings.agentDefaults,
      codex: {
        model: typeof input.model === 'string' ? input.model : '',
        reasoningEffort: input.reasoningEffort,
      },
    },
  });
  await saveSettings();
  return state.settings;
};

const updateAgentDefaults = async (input: UpdateAgentDefaultsInput): Promise<Settings> => {
  const current = normalizeSettings(state.settings);
  const defaultAgentProvider = input.defaultProvider === undefined
    ? current.defaultAgentProvider
    : normalizeDefaultAgentProvider(input.defaultProvider);
  const defaultChatPermissionMode = input.defaultChatPermissionMode === undefined
    ? current.defaultChatPermissionMode
    : normalizeAgentPermissionMode(input.defaultChatPermissionMode);
  const provider = normalizeAgentProvider(input.provider);
  if (!provider) {
    state.settings = normalizeSettings({ ...current, defaultAgentProvider, defaultChatPermissionMode });
    await saveSettings();
    return state.settings;
  }
  if (provider === 'codex') {
    state.settings = normalizeSettings({
      ...current,
      defaultAgentProvider,
      defaultChatPermissionMode,
      codexDefaults: {
        model: input.model ?? current.agentDefaults.codex.model,
        reasoningEffort: normalizeCodexReasoningEffort(input.effort, current.agentDefaults.codex.reasoningEffort),
      },
      agentDefaults: {
        ...current.agentDefaults,
        codex: {
          model: input.model ?? current.agentDefaults.codex.model,
          reasoningEffort: normalizeCodexReasoningEffort(input.effort, current.agentDefaults.codex.reasoningEffort),
        },
      },
    });
    await saveSettings();
    return state.settings;
  }
  state.settings = normalizeSettings({
    ...current,
    defaultAgentProvider,
    defaultChatPermissionMode,
    agentDefaults: {
      ...current.agentDefaults,
      claude: {
        model: typeof input.model === 'string' ? input.model : current.agentDefaults.claude.model,
        effort: normalizeClaudeEffort(input.effort, current.agentDefaults.claude.effort),
      },
    },
  });
  await saveSettings();
  return state.settings;
};

const markProviderConnected = async (provider: AgentProvider): Promise<void> => {
  const current = normalizeSettings(state.settings);
  if (current.providerConnections[provider]) {
    state.settings = current;
    return;
  }
  const isFirstConnectedProvider = !current.providerConnections.codex && !current.providerConnections.claude;
  state.settings = normalizeSettings({
    ...current,
    defaultAgentProvider: isFirstConnectedProvider && current.defaultAgentProvider === 'auto'
      ? provider
      : current.defaultAgentProvider,
    providerConnections: {
      ...current.providerConnections,
      [provider]: new Date().toISOString(),
    },
  });
  await saveSettings();
};

const chooseAgentRuntime = async (requested?: AgentRuntimeRequest): Promise<AgentRuntime> => {
  const provider = requested?.provider ?? await chooseConnectedProvider();
  const defaults = normalizeSettings(state.settings).agentDefaults;
  if (provider === 'claude') {
    const recommended = requested?.recommendations?.claude;
    return {
      provider,
      model: normalizeClaudeModel(requested?.model ?? recommended?.model, defaults.claude.model || BUILT_IN_CLAUDE_MODEL),
      effort: normalizeClaudeEffort(requested?.effort ?? recommended?.effort, defaults.claude.effort),
    };
  }
  const recommended = requested?.recommendations?.codex;
  return {
    provider: 'codex',
    model: normalizeCodexModel(requested?.model ?? recommended?.model, defaults.codex.model || BUILT_IN_CODEX_MODEL),
    effort: normalizeCodexReasoningEffort(requested?.effort ?? recommended?.reasoningEffort, defaults.codex.reasoningEffort),
  };
};

const chooseConnectedProvider = async (): Promise<AgentProvider> => {
  const [codexStatus, claudeStatus] = await Promise.all([
    getCodexAuthStatus().catch(() => null),
    getClaudeAuthStatus().catch(() => null),
  ]);
  const connected: AgentProvider[] = [
    ...(codexStatus?.authenticated ? ['codex' as const] : []),
    ...(claudeStatus?.authenticated ? ['claude' as const] : []),
  ];
  if (connected.length === 0) {
    return 'codex';
  }
  if (connected.length === 1) {
    return connected[0];
  }
  const preferred = normalizeSettings(state.settings).defaultAgentProvider;
  if (preferred !== 'auto' && connected.includes(preferred)) {
    return preferred;
  }
  const connections = normalizeSettings(state.settings).providerConnections;
  const sorted = connected
    .map((provider) => ({ provider, connectedAt: connections[provider] }))
    .filter((entry): entry is { provider: AgentProvider; connectedAt: string } => Boolean(entry.connectedAt))
    .sort((left, right) => left.connectedAt.localeCompare(right.connectedAt));
  return sorted[0]?.provider ?? 'codex';
};

const withAgentDefaults = <T extends { model?: string; reasoningEffort?: CodexReasoningEffort; runtime?: AgentRuntime; runtimeRecommendations?: AgentRuntimeRecommendations }>(
  entry: T,
  defaults: AgentDefaults = normalizeSettings(state.settings).agentDefaults,
): T & {
  model: string;
  reasoningEffort: CodexReasoningEffort;
} => {
  const recommendations = mergeRuntimeRecommendations(defaults, entry.runtimeRecommendations, {
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
  });
  if (entry.runtime?.provider === 'claude') {
    return {
      ...entry,
      runtimeRecommendations: recommendations,
      model: recommendations.codex.model,
      reasoningEffort: recommendations.codex.reasoningEffort,
      runtime: {
        provider: 'claude',
        model: normalizeClaudeModel(entry.runtime.model, recommendations.claude.model || defaults.claude.model || BUILT_IN_CLAUDE_MODEL),
        effort: normalizeClaudeEffort(entry.runtime.effort, defaults.claude.effort),
      },
    };
  }
  return {
    ...entry,
    runtimeRecommendations: recommendations,
    model: recommendations.codex.model,
    reasoningEffort: recommendations.codex.reasoningEffort,
  };
};

const mergeRuntimeRecommendations = (
  defaults: AgentDefaults,
  recommendations?: AgentRuntimeRecommendations,
  legacyCodex?: { model?: string; reasoningEffort?: CodexReasoningEffort },
): AgentDefaults => ({
  codex: {
    model: normalizeCodexModel(
      recommendations?.codex?.model ?? legacyCodex?.model,
      defaults.codex.model || BUILT_IN_CODEX_MODEL,
    ),
    reasoningEffort: normalizeCodexReasoningEffort(
      recommendations?.codex?.reasoningEffort ?? legacyCodex?.reasoningEffort,
      defaults.codex.reasoningEffort || BUILT_IN_CODEX_REASONING,
    ),
  },
  claude: {
    model: normalizeClaudeModel(recommendations?.claude?.model, defaults.claude.model || BUILT_IN_CLAUDE_MODEL),
    effort: normalizeClaudeEffort(recommendations?.claude?.effort, defaults.claude.effort || BUILT_IN_CLAUDE_EFFORT),
  },
});

  return { getPromptOverridesStore, normalizeCodexReasoningEffort, normalizeClaudeEffort, normalizeAgentProvider, normalizeDefaultAgentProvider, normalizeSettings, loadSettings, saveSettings, getCodexDefaults, updateCodexDefaults, updateAgentDefaults, markProviderConnected, chooseAgentRuntime, chooseConnectedProvider, withAgentDefaults };
};
