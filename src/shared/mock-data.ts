import type { AppSummary, CatalogApp, Settings } from './types';

export const installedAppsSeed: AppSummary[] = [
  {
    id: 'finance-os',
    category: 'finanzas',
    status: 'installed',
  },
  {
    id: 'recetario-personal',
    category: 'hogar',
    status: 'installed',
  },
];

export const catalogAppsSeed: CatalogApp[] = [
  {
    id: 'finance-os',
    category: 'finanzas',
    status: 'installed',
  },
  {
    id: 'recetario-personal',
    category: 'hogar',
    status: 'installed',
  },
  {
    id: 'planificador-entrenamiento',
    category: 'salud',
    status: 'not_installed',
  },
  {
    id: 'agenda-focal',
    category: 'productividad',
    status: 'not_installed',
  },
  {
    id: 'hogar-en-calma',
    category: 'hogar',
    status: 'not_installed',
  },
];

export const settingsSeed: Settings = {
  userEmail: '',
  plan: 'Free',
  safeMode: true,
  codexDefaults: {
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
  },
  defaultAgentProvider: 'auto',
  agentDefaults: {
    codex: {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
    },
    claude: {
      model: 'sonnet',
      effort: 'medium',
    },
  },
  providerConnections: {},
};
