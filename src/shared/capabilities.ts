import type { AppCapability } from './types';

export const APP_CAPABILITY_IDS = [
  'app_data',
  'local_app_data',
  'internal_workspace',
  'local_finance_data',
  'local_recipe_data',
  'user_selected_imports',
  'user_selected_folders',
  'app_exports',
  'ai_api',
  'ai_assisted_imports',
  'local_network_share',
  'remote_tunnel_share',
  'local_business_data',
  'local_visual_assets',
  'agent_assisted_edits',
] as const;

export type AppCapabilityId = (typeof APP_CAPABILITY_IDS)[number];

const APP_CAPABILITY_ID_SET = new Set<string>(APP_CAPABILITY_IDS);

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
    if (APP_CAPABILITY_ID_SET.has(id)) {
      ids.add(id);
    }
  }
  return Array.from(ids);
};

export const normalizeAppCapabilities = (value: unknown): AppCapability[] => {
  return normalizeAppCapabilityIds(value).map((id) => ({ id }));
};
