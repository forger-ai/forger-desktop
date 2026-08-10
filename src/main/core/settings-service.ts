
import type fs from 'node:fs/promises';
import type path from 'node:path';

import type { PromptOverridesStore } from '../prompt-overrides';
import type {
  AgentDefaults,
  AgentEffort,
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
  LlmProviderProfileMetadata,
  LlmProviderProfilesState,
  SetActiveLlmProviderProfileInput,
  SetActiveLlmProviderProfileResult,
  Settings,
  UpdateAgentDefaultsInput,
  UpdateCodexDefaultsInput,
  UpdateDeveloperModeInput,
} from '../../shared/types';
import type { UpdateEarlyAccessInput } from '../../shared/types/settings';
import type { UpdateLlmProviderProfileDefaultsInput } from '../../shared/types/provider-profiles';
import { hasValidLegacyWorkflows } from '../workflow/legacy';
import {
  LLM_PROVIDER_KEYS,
  normalizeAgentProviderEffort,
  normalizeAgentProviderModel,
  normalizeAgentProviderPreference,
  normalizeAgentPermissionMode as normalizeSharedAgentPermissionMode,
  normalizeAntigravityModelAndEffort,
  normalizeRuntimeEffortForModel,
  normalizeProvider,
  validateAgentRuntimeRequest,
} from '../../shared/agent-runtime-registry';
import { normalizeDeveloperPathEntries, validateDeveloperPathEntries } from '../runtime/developer-paths';
import {
  DEFAULT_PROVIDER_INACTIVITY_TIMEOUTS_MINUTES,
  normalizeProviderInactivityTimeoutMinutes,
} from '../../shared/provider-timeouts';

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
  getMetadataRoot?: () => string;
  path: typeof path;
  settingsSeed: Settings;
  state: SettingsServiceState;
}

export const createSettingsServiceController = (deps: SettingsServiceDeps) => {
  const { state, PromptOverridesStore, getPromptOverridesPath, settingsSeed, fs, path, getSettingsPath, getMetadataRoot, agentProviderRegistry, getCodexAuthStatus, getClaudeAuthStatus, getAntigravityAuthStatus } = deps;
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

const normalizeAntigravityDefaults = (
  model: unknown,
  effort: unknown,
  fallbackModel: string,
  fallbackEffort: AntigravityEffort,
): { model: string; effort: AntigravityEffort } =>
  normalizeAntigravityModelAndEffort(
    model,
    effort,
    normalizeAntigravityModel(fallbackModel, agentProviderRegistry.antigravity.defaultModel),
    normalizeAntigravityEffort(fallbackEffort, agentProviderRegistry.antigravity.defaultEffort),
  );

const normalizeAgentProvider = (value: unknown): AgentProvider | undefined =>
  normalizeProvider(value);

const normalizeDefaultAgentProvider = (value: unknown): AgentProvider | 'auto' =>
  normalizeAgentProviderPreference(value);

const normalizeAgentPermissionMode = (value: unknown): AgentPermissionMode =>
  normalizeSharedAgentPermissionMode(value);

const normalizeChatNetworkAccess = (value: unknown, fallback = true): boolean =>
  typeof value === 'boolean' ? value : fallback;

const normalizeProviderInactivityTimeouts = (value: unknown): Settings['providerInactivityTimeoutMinutes'] => {
  const record = isPlainRecord(value) ? value : {};
  return {
    codex: normalizeProviderInactivityTimeoutMinutes(record.codex, DEFAULT_PROVIDER_INACTIVITY_TIMEOUTS_MINUTES.codex),
    claude: normalizeProviderInactivityTimeoutMinutes(record.claude, DEFAULT_PROVIDER_INACTIVITY_TIMEOUTS_MINUTES.claude),
    antigravity: normalizeProviderInactivityTimeoutMinutes(record.antigravity, DEFAULT_PROVIDER_INACTIVITY_TIMEOUTS_MINUTES.antigravity),
  };
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

const providerProfileLabel = (provider: AgentProvider): string => {
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'antigravity') {
    return 'Google';
  }
  return 'ChatGPT';
};

const systemProviderProfileId = (provider: AgentProvider): string => `${provider}:system`;
const legacyLocalProviderProfileId = (provider: AgentProvider): string => `${provider}:local-active`;

const normalizeProviderProfileId = (provider: AgentProvider, value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  return value === legacyLocalProviderProfileId(provider) ? systemProviderProfileId(provider) : value;
};

const createSystemProviderProfile = (
  provider: AgentProvider,
  connectedAt: string,
  source: LlmProviderProfileMetadata['source'] = 'legacy_provider_connections',
): LlmProviderProfileMetadata => ({
  id: systemProviderProfileId(provider),
  provider,
  label: providerProfileLabel(provider),
  authMode: 'cli',
  runtimeAuthMode: 'externalActiveOnly',
  status: 'connected',
  source,
  connectedAt,
});

const normalizeProfileDefaultModel = (provider: AgentProvider, value: unknown): string | undefined => {
  const model = normalizeOptionalString(value);
  if (!model) {
    return undefined;
  }
  if (provider === 'claude') {
    return normalizeAgentProviderModel(agentProviderRegistry, 'claude', model, agentProviderRegistry.claude.defaultModel);
  }
  if (provider === 'antigravity') {
    return normalizeAgentProviderModel(agentProviderRegistry, 'antigravity', model, agentProviderRegistry.antigravity.defaultModel);
  }
  return normalizeAgentProviderModel(agentProviderRegistry, 'codex', model, agentProviderRegistry.codex.defaultModel);
};

const normalizeProfileDefaultEffort = (provider: AgentProvider, value: unknown): AgentEffort | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (provider === 'claude') {
    return normalizeClaudeEffort(value, agentProviderRegistry.claude.defaultEffort);
  }
  if (provider === 'antigravity') {
    return normalizeAntigravityEffort(value, agentProviderRegistry.antigravity.defaultEffort);
  }
  return normalizeCodexReasoningEffort(value, agentProviderRegistry.codex.defaultReasoningEffort);
};

const normalizeProviderProfile = (
  provider: AgentProvider,
  value: unknown,
): LlmProviderProfileMetadata | null => {
  if (!isPlainRecord(value)) {
    return null;
  }
  const id = normalizeProviderProfileId(provider, normalizeOptionalString(value.id));
  if (!id) {
    return null;
  }
  const authMode = value.authMode === 'api_key' || value.authMode === 'oauth' || value.authMode === 'cli'
    ? value.authMode
    : 'cli';
  const runtimeAuthMode = id === systemProviderProfileId(provider)
    ? 'externalActiveOnly'
    : value.runtimeAuthMode === 'materialized' || value.runtimeAuthMode === 'externalActiveOnly'
      ? (provider === 'antigravity' && value.runtimeAuthMode === 'materialized' ? 'externalActiveOnly' : value.runtimeAuthMode)
      : provider === 'antigravity'
        ? 'externalActiveOnly'
        : 'materialized';
  const status = value.status === 'expired' || value.status === 'missing' || value.status === 'unsupported' || value.status === 'connected'
    ? value.status
    : undefined;
  const source = value.source === 'desktop' || value.source === 'local_cli' || value.source === 'legacy_provider_connections'
    ? value.source
    : undefined;
  const installSource = value.installSource === 'managed' || value.installSource === 'system' || value.installSource === 'local_cli' || value.installSource === 'unknown'
    ? value.installSource
    : undefined;
  const defaultModel = normalizeProfileDefaultModel(provider, value.defaultModel);
  const defaultEffort = normalizeProfileDefaultEffort(provider, value.defaultEffort);
  return {
    id,
    provider,
    label: normalizeOptionalString(value.label) ?? providerProfileLabel(provider),
    authMode,
    runtimeAuthMode,
    ...(installSource ? { installSource } : {}),
    ...(normalizeOptionalString(value.accountHint) ? { accountHint: normalizeOptionalString(value.accountHint) } : {}),
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(normalizeOptionalString(value.connectedAt) ? { connectedAt: normalizeOptionalString(value.connectedAt) } : {}),
    ...(normalizeOptionalString(value.lastCheckedAt) ? { lastCheckedAt: normalizeOptionalString(value.lastCheckedAt) } : {}),
    ...(normalizeOptionalString(value.lastUsedAt) ? { lastUsedAt: normalizeOptionalString(value.lastUsedAt) } : {}),
    ...(normalizeOptionalString(value.unavailableReason) ? { unavailableReason: normalizeOptionalString(value.unavailableReason) } : {}),
  };
};

const normalizeProviderProfiles = (
  input: Partial<Settings> | undefined,
  providerConnections: Partial<Record<AgentProvider, string>>,
): Pick<Settings, 'llmProviderProfiles' | 'activeProviderProfiles'> => {
  const llmProviderProfiles: Settings['llmProviderProfiles'] = {};
  const activeProviderProfiles: Settings['activeProviderProfiles'] = {};
  const rawProfiles = isPlainRecord(input?.llmProviderProfiles) ? input?.llmProviderProfiles : {};
  const rawActiveProfiles = isPlainRecord(input?.activeProviderProfiles) ? input?.activeProviderProfiles : {};
  for (const provider of LLM_PROVIDER_KEYS) {
    const entries = Array.isArray(rawProfiles?.[provider])
      ? rawProfiles[provider]
          .map((entry) => normalizeProviderProfile(provider, entry))
          .filter((entry): entry is LlmProviderProfileMetadata => Boolean(entry))
      : [];
    const deduped = new Map<string, LlmProviderProfileMetadata>();
    for (const entry of entries) {
      deduped.set(entry.id, entry);
    }
    const connectedAt = providerConnections[provider];
    if (connectedAt) {
      const systemId = systemProviderProfileId(provider);
      const existing = deduped.get(systemId);
      deduped.set(systemId, {
        ...(existing ?? createSystemProviderProfile(provider, connectedAt)),
        runtimeAuthMode: 'externalActiveOnly',
        status: 'connected',
        connectedAt,
      });
    }
    let profiles = Array.from(deduped.values());
    const connectedProfiles = profiles.filter((entry) => entry.status === 'connected');
    const systemProfile = connectedProfiles.find((entry) => entry.id === systemProviderProfileId(provider));
    const rawActive = normalizeProviderProfileId(provider, normalizeOptionalString(rawActiveProfiles?.[provider]));
    const active = systemProfile
      ? systemProfile.id
      : rawActive && connectedProfiles.some((entry) => entry.id === rawActive)
      ? rawActive
      : connectedProfiles[0]?.id;
    profiles = profiles.map((entry) => ({
      ...entry,
      isDefault: active ? entry.id === active : entry.isDefault === true,
    }));
    if (profiles.length > 0) {
      llmProviderProfiles[provider] = profiles;
    }
    if (active) {
      activeProviderProfiles[provider] = active;
    }
  }
  return { llmProviderProfiles, activeProviderProfiles };
};

const isConnectedProviderProfile = (profile: LlmProviderProfileMetadata | undefined): profile is LlmProviderProfileMetadata =>
  profile?.status === 'connected';

const resolveRuntimeProviderProfile = (
  settings: Pick<Settings, 'llmProviderProfiles' | 'activeProviderProfiles'>,
  provider: AgentProvider,
  requestedProfileId?: string,
): LlmProviderProfileMetadata | undefined => {
  const profiles = settings.llmProviderProfiles[provider] ?? [];
  const activeProfileId = settings.activeProviderProfiles[provider];
  const normalizedRequestedProfileId = normalizeProviderProfileId(provider, requestedProfileId);
  const requested = profiles.find((entry) => entry.id === normalizedRequestedProfileId);
  if (normalizedRequestedProfileId) {
    if (isConnectedProviderProfile(requested)) {
      return requested;
    }
    throw new Error('provider_profile_not_found');
  }
  const active = profiles.find((entry) => entry.id === normalizeProviderProfileId(provider, activeProfileId));
  if (isConnectedProviderProfile(active)) {
    return active;
  }
  return profiles.find(isConnectedProviderProfile);
};

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
  const antigravityDefaults = normalizeAntigravityDefaults(
    rawAgentAntigravityDefaults?.model,
    rawAgentAntigravityDefaults?.effort,
    defaultAntigravityModel,
    defaultAntigravityEffort,
  );
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
  const providerProfiles = normalizeProviderProfiles(input, providerConnections);
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
          ? normalizeClaudeModel(rawAgentClaudeDefaults.model.trim(), defaultClaudeModel)
          : defaultClaudeModel,
      effort: normalizeClaudeEffort(rawAgentClaudeDefaults?.effort, defaultClaudeEffort),
    },
    antigravity: {
      model: antigravityDefaults.model,
      effort: antigravityDefaults.effort,
    },
  };
  return {
    userEmail: typeof input?.userEmail === 'string' ? input.userEmail : defaults.userEmail,
    plan: typeof input?.plan === 'string' ? input.plan : defaults.plan,
    safeMode: typeof input?.safeMode === 'boolean' ? input.safeMode : defaults.safeMode,
    earlyAccess: {
      workflowsEnabled: input?.earlyAccess?.workflowsEnabled === true,
    },
    developerMode: {
      enabled: input?.developerMode?.enabled === true,
      pathEntries: normalizeDeveloperPathEntries(input?.developerMode?.pathEntries, path),
    },
    defaultAgentProvider: normalizeDefaultAgentProvider(input?.defaultAgentProvider),
    defaultChatPermissionMode: normalizeAgentPermissionMode(input?.defaultChatPermissionMode ?? defaults.defaultChatPermissionMode),
    defaultChatNetworkAccess: normalizeChatNetworkAccess(input?.defaultChatNetworkAccess, defaults.defaultChatNetworkAccess),
    providerInactivityTimeoutMinutes: normalizeProviderInactivityTimeouts(
      input?.providerInactivityTimeoutMinutes
      ?? (input as Partial<Settings> & { providerTotalTimeoutMinutes?: unknown } | undefined)?.providerTotalTimeoutMinutes,
    ),
    codexDefaults: {
      model: codexModel,
      reasoningEffort: codexReasoningEffort,
    },
    llmProviderDefaults,
    agentDefaults: llmProviderDefaults,
    providerConnections,
    ...providerProfiles,
  };
};

const loadSettings = async (): Promise<void> => {
  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const earlyAccess = parsed.earlyAccess as unknown;
    const hasExplicitWorkflowsPreference = Boolean(
      earlyAccess
      && typeof earlyAccess === 'object'
      && Object.prototype.hasOwnProperty.call(earlyAccess, 'workflowsEnabled'),
    );
    state.settings = normalizeSettings(parsed);
    if (!hasExplicitWorkflowsPreference && await legacyWorkflowsExist()) {
      state.settings = normalizeSettings({
        ...state.settings,
        earlyAccess: { workflowsEnabled: true },
      });
      await saveSettings();
    }
  } catch {
    state.settings = normalizeSettings(settingsSeed);
  }
};

const legacyWorkflowsExist = async (): Promise<boolean> => {
  const metadataRoot = getMetadataRoot?.() ?? path.dirname(getSettingsPath());
  try {
    const raw = await fs.readFile(path.join(metadataRoot, 'workflows.json'), 'utf8');
    return hasValidLegacyWorkflows(JSON.parse(raw) as unknown);
  } catch {
    return false;
  }
};

const saveSettings = async (): Promise<void> => {
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(normalizeSettings(state.settings), null, 2), 'utf8');
};

const getCodexDefaults = (): Settings['codexDefaults'] => normalizeSettings(state.settings).codexDefaults;

const updateEarlyAccess = async (input: UpdateEarlyAccessInput): Promise<Settings> => {
  state.settings = normalizeSettings({
    ...state.settings,
    earlyAccess: {
      workflowsEnabled: input.workflowsEnabled === true,
    },
  });
  await saveSettings();
  return state.settings;
};

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
  const providerInactivityTimeoutMinutes = provider
    ? {
        ...current.providerInactivityTimeoutMinutes,
        [provider]: input.inactivityTimeoutMinutes === undefined
          ? current.providerInactivityTimeoutMinutes[provider]
          : normalizeProviderInactivityTimeoutMinutes(input.inactivityTimeoutMinutes),
      }
    : current.providerInactivityTimeoutMinutes;
  if (!provider) {
    state.settings = normalizeSettings({ ...current, defaultAgentProvider, defaultChatPermissionMode, defaultChatNetworkAccess, providerInactivityTimeoutMinutes });
    await saveSettings();
    return state.settings;
  }
  if (provider === 'codex') {
    state.settings = normalizeSettings({
      ...current,
      defaultAgentProvider,
      defaultChatPermissionMode,
      defaultChatNetworkAccess,
      providerInactivityTimeoutMinutes,
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
    const antigravityDefaults = normalizeAntigravityDefaults(
      input.model ?? current.agentDefaults.antigravity.model,
      input.effort,
      current.agentDefaults.antigravity.model,
      current.agentDefaults.antigravity.effort,
    );
    state.settings = normalizeSettings({
      ...current,
      defaultAgentProvider,
      defaultChatPermissionMode,
      defaultChatNetworkAccess,
      providerInactivityTimeoutMinutes,
      llmProviderDefaults: {
        ...current.llmProviderDefaults,
        antigravity: {
          model: antigravityDefaults.model,
          effort: antigravityDefaults.effort,
        },
      },
      agentDefaults: {
        ...current.agentDefaults,
        antigravity: {
          model: antigravityDefaults.model,
          effort: antigravityDefaults.effort,
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
    providerInactivityTimeoutMinutes,
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
  const connectedAt = new Date().toISOString();
  const isFirstConnectedProvider = LLM_PROVIDER_KEYS.every((key) => !current.providerConnections[key]);
  const llmProviderProfiles = {
    ...current.llmProviderProfiles,
    [provider]: [
      createSystemProviderProfile(provider, connectedAt, 'local_cli'),
      ...(current.llmProviderProfiles[provider] ?? []).filter((profile) =>
        normalizeProviderProfileId(provider, profile.id) !== systemProviderProfileId(provider),
      ),
    ],
  };
  state.settings = normalizeSettings({
    ...current,
    defaultAgentProvider: isFirstConnectedProvider && current.defaultAgentProvider === 'auto'
      ? provider
      : current.defaultAgentProvider,
    providerConnections: {
      ...current.providerConnections,
      [provider]: connectedAt,
    },
    llmProviderProfiles,
    activeProviderProfiles: {
      ...current.activeProviderProfiles,
      [provider]: systemProviderProfileId(provider),
    },
  });
  await saveSettings();
};

const markProviderDisconnected = async (provider: AgentProvider): Promise<void> => {
  const current = normalizeSettings(state.settings);
  if (!current.providerConnections[provider]) {
    state.settings = current;
    return;
  }
  const providerConnections = { ...current.providerConnections };
  delete providerConnections[provider];
  const activeProviderProfiles = { ...current.activeProviderProfiles };
  delete activeProviderProfiles[provider];
  const llmProviderProfiles = {
    ...current.llmProviderProfiles,
    [provider]: current.llmProviderProfiles[provider]!.map((profile) => ({ ...profile, status: 'missing' as const })),
  };
  state.settings = normalizeSettings({
    ...current,
    defaultAgentProvider: current.defaultAgentProvider === provider ? 'auto' : current.defaultAgentProvider,
    providerConnections,
    llmProviderProfiles,
    activeProviderProfiles,
  });
  await saveSettings();
};

const chooseAgentRuntime = async (requested?: AgentRuntimeRequest): Promise<AgentRuntime> => {
  const provider = requested?.provider ?? await chooseConnectedProvider();
  const normalized = normalizeSettings(state.settings);
  const defaults = normalized.agentDefaults;
  const requestedProfileId = normalizeProviderProfileId(provider, normalizeOptionalString(requested?.authProfileId));
  const profile = resolveRuntimeProviderProfile(normalized, provider, requestedProfileId);
  const authProfileId = profile?.id;
  if (requested?.strict) {
    validateAgentRuntimeRequest(agentProviderRegistry, provider, requested);
  }
  if (provider === 'claude') {
    const recommended = requested?.recommendations?.claude;
    const fallbackModel = profile?.defaultModel ?? defaults.claude.model;
    const fallbackEffort = profile?.defaultEffort ?? defaults.claude.effort;
    const model = normalizeClaudeModel(requested?.model ?? recommended?.model, fallbackModel);
    return {
      provider,
      model,
      effort: normalizeRuntimeEffortForModel('claude', model, requested?.effort ?? recommended?.effort, fallbackEffort as ClaudeEffort),
      ...(authProfileId ? { authProfileId } : {}),
    };
  }
  if (provider === 'antigravity') {
    const recommended = requested?.recommendations?.antigravity;
    const fallbackModel = profile?.defaultModel ?? defaults.antigravity.model;
    const fallbackEffort = profile?.defaultEffort ?? defaults.antigravity.effort;
    const antigravityDefaults = normalizeAntigravityDefaults(
      requested?.model ?? recommended?.model,
      requested?.effort ?? recommended?.effort,
      fallbackModel,
      fallbackEffort as AntigravityEffort,
    );
    return {
      provider,
      model: antigravityDefaults.model,
      effort: antigravityDefaults.effort,
      ...(authProfileId ? { authProfileId } : {}),
    };
  }
  const recommended = requested?.recommendations?.codex;
  const fallbackModel = profile?.defaultModel ?? defaults.codex.model;
  const fallbackEffort = profile?.defaultEffort ?? defaults.codex.reasoningEffort;
  const model = normalizeCodexModel(requested?.model ?? recommended?.model, fallbackModel);
  return {
    provider: 'codex',
    model,
    effort: normalizeRuntimeEffortForModel('codex', model, requested?.effort ?? recommended?.reasoningEffort, fallbackEffort as CodexReasoningEffort),
    ...(authProfileId ? { authProfileId } : {}),
  };
};

const chooseConnectedProvider = async (): Promise<AgentProvider> => {
  const normalized = normalizeSettings(state.settings);
  const timestampOrder = LLM_PROVIDER_KEYS
    .filter((provider) => Boolean(normalized.providerConnections[provider]))
    .sort((left, right) => Date.parse(normalized.providerConnections[left]!) - Date.parse(normalized.providerConnections[right]!));
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

const listLlmProviderProfiles = async (): Promise<LlmProviderProfilesState> => {
  const normalized = normalizeSettings(state.settings);
  const providers: LlmProviderProfilesState['providers'] = {};
  const activeProfileIds: LlmProviderProfilesState['activeProfileIds'] = {};
  for (const provider of LLM_PROVIDER_KEYS) {
    const profiles = normalized.llmProviderProfiles[provider] ?? [];
    const activeProfileId = resolveRuntimeProviderProfile(normalized, provider)?.id;
    if (activeProfileId) {
      activeProfileIds[provider] = activeProfileId;
    }
    providers[provider] = profiles.map((profile) => ({
      ...profile,
      active: profile.id === activeProfileId,
      isDefault: profile.id === activeProfileId,
      connected: profile.status === 'connected',
    }));
  }
  return {
    providers,
    activeProfileIds,
    checkedAt: new Date().toISOString(),
  };
};

const setActiveLlmProviderProfile = async (
  input: SetActiveLlmProviderProfileInput,
): Promise<SetActiveLlmProviderProfileResult> => {
  const provider = normalizeAgentProvider(input.provider);
  const profileId = provider
    ? normalizeProviderProfileId(provider, normalizeOptionalString(input.profileId))
    : normalizeOptionalString(input.profileId);
  if (!provider || !profileId) {
    return { success: false, userMessage: 'No pudimos seleccionar ese perfil.', technicalCode: 'invalid_provider_profile' };
  }
  const current = normalizeSettings(state.settings);
  const profile = (current.llmProviderProfiles[provider] ?? []).find((entry) =>
    entry.id === profileId && entry.provider === provider,
  );
  if (!profile) {
    return { success: false, userMessage: 'Ese perfil ya no está disponible.', technicalCode: 'provider_profile_not_found' };
  }
  if (!isConnectedProviderProfile(profile)) {
    return { success: false, userMessage: 'Ese perfil no está conectado.', technicalCode: 'provider_profile_not_connected' };
  }
  state.settings = normalizeSettings({
    ...current,
    activeProviderProfiles: {
      ...current.activeProviderProfiles,
      [provider]: profileId,
    },
  });
  await saveSettings();
  return {
    success: true,
    userMessage: 'Perfil seleccionado.',
    state: await listLlmProviderProfiles(),
  };
};

const updateLlmProviderProfileDefaults = async (
  input: UpdateLlmProviderProfileDefaultsInput,
): Promise<SetActiveLlmProviderProfileResult> => {
  const provider = normalizeAgentProvider(input.provider);
  const profileId = provider
    ? normalizeProviderProfileId(provider, normalizeOptionalString(input.profileId))
    : normalizeOptionalString(input.profileId);
  if (!provider || !profileId) {
    return { success: false, userMessage: 'No pudimos actualizar ese perfil.', technicalCode: 'invalid_provider_profile' };
  }
  const current = normalizeSettings(state.settings);
  const profiles = current.llmProviderProfiles[provider] ?? [];
  const profileIndex = profiles.findIndex((profile) => profile.id === profileId && profile.provider === provider);
  if (profileIndex < 0) {
    return { success: false, userMessage: 'Ese perfil ya no está disponible.', technicalCode: 'provider_profile_not_found' };
  }
  const defaultModel = normalizeProfileDefaultModel(provider, input.model);
  const defaultEffort = normalizeProfileDefaultEffort(provider, input.effort);
  const nextProfiles = profiles.map((profile, index) => index === profileIndex
    ? {
        ...profile,
        ...(defaultModel ? { defaultModel } : {}),
        ...(defaultEffort ? { defaultEffort } : {}),
      }
    : profile);
  state.settings = normalizeSettings({
    ...current,
    llmProviderProfiles: {
      ...current.llmProviderProfiles,
      [provider]: nextProfiles,
    },
  });
  await saveSettings();
  return {
    success: true,
    userMessage: 'Perfil actualizado.',
    state: await listLlmProviderProfiles(),
  };
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
        model: normalizeClaudeModel(entry.runtime.model, recommendations.claude.model),
        effort: normalizeClaudeEffort(entry.runtime.effort, defaults.claude.effort),
        ...(entry.runtime.authProfileId ? { authProfileId: entry.runtime.authProfileId } : {}),
      },
    };
  }
  if (entry.runtime?.provider === 'antigravity') {
    const antigravityRuntime = normalizeAntigravityDefaults(
      entry.runtime.model,
      entry.runtime.effort,
      recommendations.antigravity.model,
      defaults.antigravity.effort || agentProviderRegistry.antigravity.defaultEffort,
    );
    return {
      ...entry,
      runtimeRecommendations: recommendations,
      model: recommendations.codex.model,
      reasoningEffort: recommendations.codex.reasoningEffort,
      runtime: {
        provider: 'antigravity',
        model: antigravityRuntime.model,
        effort: antigravityRuntime.effort,
        ...(entry.runtime.authProfileId ? { authProfileId: entry.runtime.authProfileId } : {}),
      },
    };
  }
  if (entry.runtime?.provider === 'codex') {
    return {
      ...entry,
      runtimeRecommendations: recommendations,
      model: recommendations.codex.model,
      reasoningEffort: recommendations.codex.reasoningEffort,
      runtime: {
        provider: 'codex',
        model: normalizeCodexModel(entry.runtime.model, recommendations.codex.model),
        effort: normalizeCodexReasoningEffort(entry.runtime.effort, defaults.codex.reasoningEffort),
        ...(entry.runtime.authProfileId ? { authProfileId: entry.runtime.authProfileId } : {}),
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
): AgentDefaults => {
  const antigravity = normalizeAntigravityDefaults(
    recommendations?.antigravity?.model,
    recommendations?.antigravity?.effort,
    defaults.antigravity.model || agentProviderRegistry.antigravity.defaultModel,
    defaults.antigravity.effort || agentProviderRegistry.antigravity.defaultEffort,
  );
  return {
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
    antigravity,
  };
};

  return { getPromptOverridesStore, normalizeCodexReasoningEffort, normalizeClaudeEffort, normalizeAgentProvider, normalizeDefaultAgentProvider, normalizeSettings, loadSettings, saveSettings, getCodexDefaults, updateEarlyAccess, updateCodexDefaults, updateAgentDefaults, updateDeveloperMode, markProviderConnected, markProviderDisconnected, chooseAgentRuntime, chooseConnectedProvider, listLlmProviderProfiles, setActiveLlmProviderProfile, updateLlmProviderProfileDefaults, withAgentDefaults };
};
