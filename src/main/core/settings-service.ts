
import type fs from 'node:fs/promises';
import type path from 'node:path';

import type { PromptOverridesStore } from '../prompt-overrides';
import type {
  AgentDefaults,
  AgentPermissionMode,
  AgentProvider,
  AgentProviderRuntimeRegistry,
  AgentRuntime,
  AgentRuntimeRecommendations,
  AgentRuntimeRequest,
  AntigravityAuthStatus,
  AntigravityEffort,
  ClaudeAuthStatus,
  ClaudeEffort,
  CodexAuthStatus,
  CodexReasoningEffort,
  Settings,
  UpdateAgentDefaultsInput,
  UpdateCodexDefaultsInput,
  UpdateDeveloperModeInput,
} from '../../shared/types';
import {
  LLM_PROVIDER_KEYS,
  normalizeAgentProviderEffort,
  normalizeAgentProviderModel,
  normalizeAgentProviderPreference,
  normalizeAgentPermissionMode as normalizeSharedAgentPermissionMode,
  normalizeProvider,
} from '../../shared/agent-runtime-registry';
import { normalizeDeveloperPathEntries, validateDeveloperPathEntries } from '../runtime/developer-paths';

interface SettingsServiceState {
  promptOverridesStore: PromptOverridesStore | null;
  settings: Settings;
}

interface SettingsServiceDeps {
  agentProviderRegistry: AgentProviderRuntimeRegistry;
  PromptOverridesStore: new (filePath: string) => PromptOverridesStore;
  fs: typeof fs;
  getAntigravityAuthStatus?: () => Promise<AntigravityAuthStatus>;
  getClaudeAuthStatus: () => Promise<ClaudeAuthStatus>;
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  getPromptOverridesPath: () => string;
  getSettingsPath: () => string;
  path: typeof path;
  settingsSeed: Settings;
  state: SettingsServiceState;
}

export const createSettingsServiceController = (deps: SettingsServiceDeps) => {
  const { state, PromptOverridesStore, getPromptOverridesPath, settingsSeed, fs, path, getSettingsPath, agentProviderRegistry, getCodexAuthStatus, getClaudeAuthStatus, getAntigravityAuthStatus } = deps;
const getPromptOverridesStore = (): PromptOverridesStore => {
  state.promptOverridesStore ??= new PromptOverridesStore(getPromptOverridesPath());
  return state.promptOverridesStore;
};

const normalizeCodexReasoningEffort = (value: unknown, fallback: CodexReasoningEffort): CodexReasoningEffort =>
  normalizeAgentProviderEffort(agentProviderRegistry, 'codex', value, fallback);

const normalizeClaudeEffort = (value: unknown, fallback: ClaudeEffort): ClaudeEffort =>
  normalizeAgentProviderEffort(agentProviderRegistry, 'claude', value, fallback);

const normalizeAntigravityEffort = (value: unknown, fallback: AntigravityEffort): AntigravityEffort =>
  normalizeAgentProviderEffort(agentProviderRegistry, 'antigravity', value, fallback);

const normalizeCodexModel = (value: unknown, fallback: string): string =>
  normalizeAgentProviderModel(agentProviderRegistry, 'codex', value, fallback);

const normalizeClaudeModel = (value: unknown, fallback: string): string =>
  normalizeAgentProviderModel(agentProviderRegistry, 'claude', value, fallback);

const normalizeAntigravityModel = (value: unknown, fallback: string): string =>
  normalizeAgentProviderModel(agentProviderRegistry, 'antigravity', value, fallback);

const normalizeAgentProvider = (value: unknown): AgentProvider | undefined =>
  normalizeProvider(value);

const normalizeDefaultAgentProvider = (value: unknown): AgentProvider | 'auto' =>
  normalizeAgentProviderPreference(value);

const normalizeAgentPermissionMode = (value: unknown): AgentPermissionMode =>
  normalizeSharedAgentPermissionMode(value);

const normalizeChatNetworkAccess = (value: unknown, fallback = true): boolean =>
  typeof value === 'boolean' ? value : fallback;

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
  const rawLlmProviderDefaults =
    input?.llmProviderDefaults && typeof input.llmProviderDefaults === 'object'
      ? input.llmProviderDefaults
      : rawAgentDefaults;
  const rawAgentCodexDefaults =
    rawLlmProviderDefaults?.codex && typeof rawLlmProviderDefaults.codex === 'object'
      ? rawLlmProviderDefaults.codex
      : rawCodexDefaults;
  const rawAgentClaudeDefaults =
    rawLlmProviderDefaults?.claude && typeof rawLlmProviderDefaults.claude === 'object'
      ? rawLlmProviderDefaults.claude
      : undefined;
  const rawAgentAntigravityDefaults =
    rawLlmProviderDefaults?.antigravity && typeof rawLlmProviderDefaults.antigravity === 'object'
      ? rawLlmProviderDefaults.antigravity
      : undefined;
  const defaultCodexModel = agentProviderRegistry.codex.defaultModel;
  const defaultCodexReasoningEffort = agentProviderRegistry.codex.defaultReasoningEffort;
  const defaultClaudeModel = agentProviderRegistry.claude.defaultModel;
  const defaultClaudeEffort = agentProviderRegistry.claude.defaultEffort;
  const defaultAntigravityModel = agentProviderRegistry.antigravity.defaultModel;
  const defaultAntigravityEffort = agentProviderRegistry.antigravity.defaultEffort;
  const codexModel =
    typeof rawCodexDefaults?.model === 'string' && rawCodexDefaults.model.trim()
      ? rawCodexDefaults.model.trim()
      : defaultCodexModel;
  const codexReasoningEffort = normalizeCodexReasoningEffort(
    rawCodexDefaults?.reasoningEffort,
    defaultCodexReasoningEffort,
  );
  const providerConnections: Partial<Record<AgentProvider, string>> = {};
  const rawConnections = input?.providerConnections;
  if (rawConnections && typeof rawConnections === 'object') {
    for (const provider of LLM_PROVIDER_KEYS) {
      const value = rawConnections[provider];
      if (typeof value === 'string' && value.trim()) {
        providerConnections[provider] = value;
      }
    }
  }
  const llmProviderDefaults: AgentDefaults = {
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
          : defaultClaudeModel,
      effort: normalizeClaudeEffort(rawAgentClaudeDefaults?.effort, defaultClaudeEffort),
    },
    antigravity: {
      model:
        typeof rawAgentAntigravityDefaults?.model === 'string' && rawAgentAntigravityDefaults.model.trim()
          ? rawAgentAntigravityDefaults.model.trim()
          : defaultAntigravityModel,
      effort: normalizeAntigravityEffort(rawAgentAntigravityDefaults?.effort, defaultAntigravityEffort),
    },
  };
  return {
    userEmail: typeof input?.userEmail === 'string' ? input.userEmail : defaults.userEmail,
    plan: typeof input?.plan === 'string' ? input.plan : defaults.plan,
    safeMode: typeof input?.safeMode === 'boolean' ? input.safeMode : defaults.safeMode,
    developerMode: {
      enabled: input?.developerMode?.enabled === true,
      pathEntries: normalizeDeveloperPathEntries(input?.developerMode?.pathEntries, path),
    },
    defaultAgentProvider: normalizeDefaultAgentProvider(input?.defaultAgentProvider),
    defaultChatPermissionMode: normalizeAgentPermissionMode(input?.defaultChatPermissionMode ?? defaults.defaultChatPermissionMode),
    defaultChatNetworkAccess: normalizeChatNetworkAccess(input?.defaultChatNetworkAccess, defaults.defaultChatNetworkAccess),
    codexDefaults: {
      model: codexModel,
      reasoningEffort: codexReasoningEffort,
    },
    llmProviderDefaults,
    agentDefaults: llmProviderDefaults,
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
    llmProviderDefaults: {
      ...state.settings.llmProviderDefaults,
      codex: {
        model: typeof input.model === 'string' ? input.model : '',
        reasoningEffort: input.reasoningEffort,
      },
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
  const defaultChatNetworkAccess = input.defaultChatNetworkAccess === undefined
    ? current.defaultChatNetworkAccess
    : normalizeChatNetworkAccess(input.defaultChatNetworkAccess, current.defaultChatNetworkAccess);
  const provider = normalizeAgentProvider(input.provider);
  if (!provider) {
    state.settings = normalizeSettings({ ...current, defaultAgentProvider, defaultChatPermissionMode, defaultChatNetworkAccess });
    await saveSettings();
    return state.settings;
  }
  if (provider === 'codex') {
    state.settings = normalizeSettings({
      ...current,
      defaultAgentProvider,
      defaultChatPermissionMode,
      defaultChatNetworkAccess,
      codexDefaults: {
        model: input.model ?? current.agentDefaults.codex.model,
        reasoningEffort: normalizeCodexReasoningEffort(input.effort, current.agentDefaults.codex.reasoningEffort),
      },
      llmProviderDefaults: {
        ...current.llmProviderDefaults,
        codex: {
          model: input.model ?? current.agentDefaults.codex.model,
          reasoningEffort: normalizeCodexReasoningEffort(input.effort, current.agentDefaults.codex.reasoningEffort),
        },
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
  if (provider === 'antigravity') {
    state.settings = normalizeSettings({
      ...current,
      defaultAgentProvider,
      defaultChatPermissionMode,
      defaultChatNetworkAccess,
      llmProviderDefaults: {
        ...current.llmProviderDefaults,
        antigravity: {
          model: typeof input.model === 'string' ? input.model : current.agentDefaults.antigravity.model,
          effort: normalizeAntigravityEffort(input.effort, current.agentDefaults.antigravity.effort),
        },
      },
      agentDefaults: {
        ...current.agentDefaults,
        antigravity: {
          model: typeof input.model === 'string' ? input.model : current.agentDefaults.antigravity.model,
          effort: normalizeAntigravityEffort(input.effort, current.agentDefaults.antigravity.effort),
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
    defaultChatNetworkAccess,
    llmProviderDefaults: {
      ...current.llmProviderDefaults,
      claude: {
        model: typeof input.model === 'string' ? input.model : current.agentDefaults.claude.model,
        effort: normalizeClaudeEffort(input.effort, current.agentDefaults.claude.effort),
      },
    },
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

const updateDeveloperMode = async (input: UpdateDeveloperModeInput): Promise<Settings> => {
  const current = normalizeSettings(state.settings);
  const pathEntries = input.pathEntries === undefined
    ? current.developerMode.pathEntries
    : await validateDeveloperPathEntries(input.pathEntries, { fs, path });
  state.settings = normalizeSettings({
    ...current,
    developerMode: {
      enabled: input.enabled === undefined ? current.developerMode.enabled : input.enabled === true,
      pathEntries,
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
  const isFirstConnectedProvider = LLM_PROVIDER_KEYS.every((key) => !current.providerConnections[key]);
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
      model: normalizeClaudeModel(requested?.model ?? recommended?.model, defaults.claude.model || agentProviderRegistry.claude.defaultModel),
      effort: normalizeClaudeEffort(requested?.effort ?? recommended?.effort, defaults.claude.effort),
    };
  }
  if (provider === 'antigravity') {
    const recommended = requested?.recommendations?.antigravity;
    return {
      provider,
      model: normalizeAntigravityModel(requested?.model ?? recommended?.model, defaults.antigravity.model || agentProviderRegistry.antigravity.defaultModel),
      effort: normalizeAntigravityEffort(requested?.effort ?? recommended?.effort, defaults.antigravity.effort),
    };
  }
  const recommended = requested?.recommendations?.codex;
  return {
    provider: 'codex',
    model: normalizeCodexModel(requested?.model ?? recommended?.model, defaults.codex.model || agentProviderRegistry.codex.defaultModel),
    effort: normalizeCodexReasoningEffort(requested?.effort ?? recommended?.reasoningEffort, defaults.codex.reasoningEffort),
  };
};

const chooseConnectedProvider = async (): Promise<AgentProvider> => {
  const normalized = normalizeSettings(state.settings);
  const timestampOrder = LLM_PROVIDER_KEYS
    .filter((provider) => Boolean(normalized.providerConnections[provider]))
    .sort((left, right) => Date.parse(normalized.providerConnections[left] ?? '') - Date.parse(normalized.providerConnections[right] ?? ''));
  const preferredOrder = normalized.defaultAgentProvider === 'auto'
    ? timestampOrder
    : [normalized.defaultAgentProvider, ...timestampOrder.filter((provider) => provider !== normalized.defaultAgentProvider)];
  const orderedProviders = [
    ...preferredOrder,
    ...LLM_PROVIDER_KEYS.filter((provider) => !preferredOrder.includes(provider)),
  ];
  const isAuthenticated = async (provider: AgentProvider): Promise<boolean> => {
    if (provider === 'codex') {
      return Boolean((await getCodexAuthStatus().catch(() => null))?.authenticated);
    }
    if (provider === 'claude') {
      return Boolean((await getClaudeAuthStatus().catch(() => null))?.authenticated);
    }
    return Boolean((await getAntigravityAuthStatus?.().catch(() => null))?.authenticated);
  };
  for (const provider of orderedProviders) {
    if (await isAuthenticated(provider)) {
      return provider;
    }
  }
  return 'codex';
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
        model: normalizeClaudeModel(entry.runtime.model, recommendations.claude.model || defaults.claude.model || agentProviderRegistry.claude.defaultModel),
        effort: normalizeClaudeEffort(entry.runtime.effort, defaults.claude.effort),
      },
    };
  }
  if (entry.runtime?.provider === 'antigravity') {
    return {
      ...entry,
      runtimeRecommendations: recommendations,
      model: recommendations.codex.model,
      reasoningEffort: recommendations.codex.reasoningEffort,
      runtime: {
        provider: 'antigravity',
        model: normalizeAntigravityModel(entry.runtime.model, recommendations.antigravity.model || defaults.antigravity.model || agentProviderRegistry.antigravity.defaultModel),
        effort: normalizeAntigravityEffort(entry.runtime.effort, defaults.antigravity.effort),
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
      defaults.codex.model || agentProviderRegistry.codex.defaultModel,
    ),
    reasoningEffort: normalizeCodexReasoningEffort(
      recommendations?.codex?.reasoningEffort ?? legacyCodex?.reasoningEffort,
      defaults.codex.reasoningEffort || agentProviderRegistry.codex.defaultReasoningEffort,
    ),
  },
  claude: {
    model: normalizeClaudeModel(recommendations?.claude?.model, defaults.claude.model || agentProviderRegistry.claude.defaultModel),
    effort: normalizeClaudeEffort(recommendations?.claude?.effort, defaults.claude.effort || agentProviderRegistry.claude.defaultEffort),
  },
  antigravity: {
    model: normalizeAntigravityModel(recommendations?.antigravity?.model, defaults.antigravity.model || agentProviderRegistry.antigravity.defaultModel),
    effort: normalizeAntigravityEffort(recommendations?.antigravity?.effort, defaults.antigravity.effort || agentProviderRegistry.antigravity.defaultEffort),
  },
});

  return { getPromptOverridesStore, normalizeCodexReasoningEffort, normalizeClaudeEffort, normalizeAgentProvider, normalizeDefaultAgentProvider, normalizeSettings, loadSettings, saveSettings, getCodexDefaults, updateCodexDefaults, updateAgentDefaults, updateDeveloperMode, markProviderConnected, chooseAgentRuntime, chooseConnectedProvider, withAgentDefaults };
};
