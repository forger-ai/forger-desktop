import { getSharedCopy } from '../../shared/i18n';
import type { ConnectionTypeDefinition } from '../../shared/types/connections';

interface LocalizedToolCopy {
  name: string;
  description: string;
  secrets?: Record<string, { label: string; usage: string }>;
  actions?: Record<string, { name: string; description: string }>;
}

export const localizeConnectionDefinition = (
  definition: ConnectionTypeDefinition,
  locale?: string,
): ConnectionTypeDefinition => {
  const localized = (getSharedCopy(locale).officialTools as Partial<Record<string, LocalizedToolCopy>>)[definition.type];
  if (!localized) return definition;
  return {
    ...definition,
    displayName: localized.name,
    description: localized.description,
    secretsSchema: definition.secretsSchema.map((secret) => {
      const copy = localized.secrets?.[secret.name];
      return copy ? { ...secret, label: copy.label, usage: copy.usage } : secret;
    }),
    actions: definition.actions.map((action) => {
      const copy = localized.actions?.[action.id];
      return copy ? { ...action, name: copy.name, description: copy.description } : action;
    }),
  };
};
