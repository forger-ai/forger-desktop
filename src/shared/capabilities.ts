import type { AppCapability } from './types';

export const APP_CAPABILITY_DEFINITIONS = {
  app_data: {
    id: 'app_data',
    title: 'Datos privados de la app',
    description: 'Usa el almacenamiento local privado que Forger crea para esta app.',
  },
  local_app_data: {
    id: 'local_app_data',
    title: 'Datos privados de la app',
    description: 'Usa el almacenamiento local privado que Forger crea para esta app.',
  },
  internal_workspace: {
    id: 'internal_workspace',
    title: 'Workspace privado',
    description: 'Crea y edita archivos dentro del workspace privado de la app.',
  },
  local_finance_data: {
    id: 'local_finance_data',
    title: 'Datos financieros locales',
    description: 'Guarda registros financieros en la base local privada de la app.',
  },
  local_recipe_data: {
    id: 'local_recipe_data',
    title: 'Datos locales de recetas',
    description: 'Guarda recetas, ingredientes, menus y registros relacionados localmente.',
  },
  user_selected_imports: {
    id: 'user_selected_imports',
    title: 'Archivos seleccionados',
    description: 'Lee archivos solo cuando el usuario los selecciona o comparte con la app.',
  },
  user_selected_folders: {
    id: 'user_selected_folders',
    title: 'Carpetas seleccionadas',
    description: 'Lee carpetas solo cuando el usuario las selecciona o comparte con la app.',
  },
  app_exports: {
    id: 'app_exports',
    title: 'Archivos exportados',
    description: 'Crea archivos cuando el usuario elige exportar o guardar resultados.',
  },
  ai_api: {
    id: 'ai_api',
    title: 'Servicio de IA',
    description: 'Usa una credencial o servicio de IA configurado mediante Forger.',
  },
  ai_assisted_imports: {
    id: 'ai_assisted_imports',
    title: 'Importaciones asistidas por IA',
    description: 'Usa asistencia de IA de Forger para procesar archivos seleccionados por el usuario.',
  },
  local_business_data: {
    id: 'local_business_data',
    title: 'Datos de negocio locales',
    description: 'Guarda registros de negocio en la base local privada de la app.',
  },
  local_visual_assets: {
    id: 'local_visual_assets',
    title: 'Assets visuales locales',
    description: 'Guarda proyectos, referencias de imagen y exports en el workspace privado de la app.',
  },
  agent_assisted_edits: {
    id: 'agent_assisted_edits',
    title: 'Ediciones asistidas por agente',
    description: 'Permite a Forger aplicar cambios pedidos por el usuario dentro del workspace de la app.',
  },
} as const satisfies Record<string, AppCapability>;

export type AppCapabilityId = keyof typeof APP_CAPABILITY_DEFINITIONS;

const CAPABILITY_ALIASES: Record<string, AppCapabilityId> = {
  employees_and_contracts: 'local_business_data',
  payroll_calculation: 'local_business_data',
  vacation_tracking: 'local_business_data',
  previred_export: 'app_exports',
  local_visual_compositions: 'local_visual_assets',
  agent_assisted_posts: 'agent_assisted_edits',
};

const normalizeCapabilityId = (value: string): string => value.trim().toLowerCase();

const readCapabilityId = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return normalizeCapabilityId(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string') {
    return normalizeCapabilityId(record.id);
  }
  if (typeof record.name === 'string') {
    return normalizeCapabilityId(record.name);
  }
  return null;
};

export const normalizeAppCapabilityIds = (value: unknown): AppCapabilityId[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids = new Set<AppCapabilityId>();
  for (const item of value) {
    const rawId = readCapabilityId(item);
    if (!rawId) {
      continue;
    }
    const id = (CAPABILITY_ALIASES[rawId] ?? rawId) as AppCapabilityId;
    if (id in APP_CAPABILITY_DEFINITIONS) {
      ids.add(id);
    }
  }
  return Array.from(ids);
};

export const normalizeAppCapabilities = (value: unknown): AppCapability[] => {
  return normalizeAppCapabilityIds(value).map((id) => APP_CAPABILITY_DEFINITIONS[id]);
};
