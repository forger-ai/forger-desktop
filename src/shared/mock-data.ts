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
};
