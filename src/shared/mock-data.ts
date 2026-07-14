import type { AppSummary, CatalogApp, Settings } from './types';
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_PERMISSION_MODE,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  getDefaultAgentDefaults,
} from './agent-runtime-registry';
import { DEFAULT_PROVIDER_INACTIVITY_TIMEOUTS_MINUTES } from './provider-timeouts';

export const installedAppsSeed: AppSummary[] = [
  {
    id: 'recetario-personal',
    category: 'home',
    status: 'installed',
  },
];

export const catalogAppsSeed: CatalogApp[] = [
  {
    id: 'recetario-personal',
    category: 'home',
    status: 'installed',
  },
  {
    id: 'planificador-entrenamiento',
    category: 'health',
    status: 'not_installed',
  },
  {
    id: 'agenda-focal',
    category: 'productivity',
    status: 'not_installed',
  },
  {
    id: 'hogar-en-calma',
    category: 'home',
    status: 'not_installed',
  },
];

export const settingsSeed: Settings = {
  userEmail: '',
  plan: 'Free',
  safeMode: true,
  developerMode: {
    enabled: false,
    pathEntries: [],
  },
  codexDefaults: {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  },
  defaultAgentProvider: DEFAULT_AGENT_PROVIDER,
  defaultChatPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
  defaultChatNetworkAccess: true,
  providerInactivityTimeoutMinutes: { ...DEFAULT_PROVIDER_INACTIVITY_TIMEOUTS_MINUTES },
  llmProviderDefaults: getDefaultAgentDefaults(),
  agentDefaults: getDefaultAgentDefaults(),
  providerConnections: {},
  llmProviderProfiles: {},
  activeProviderProfiles: {},
};
