import type { ConnectionSetupGuideCopyValue } from '../../../shared/types/connection-setup-guide';
import type { ConnectionSecretDefinition, ConnectionTypeDefinition } from '../../../shared/types/connections';

export type SetupGuideLocale = 'es' | 'en';

export interface SetupGuideContext {
  definition: ConnectionTypeDefinition;
  locale: SetupGuideLocale;
}

export const normalizeSetupGuideLocale = (locale?: string): SetupGuideLocale =>
  locale?.toLowerCase().startsWith('es') ? 'es' : 'en';

export const scopeCopyValues = (
  definition: ConnectionTypeDefinition,
  label: string,
): ConnectionSetupGuideCopyValue[] =>
  (definition.oauth?.scopes ?? []).map((scope) => ({
    label,
    value: scope,
    kind: 'scope',
  }));

export const callbackCopyValues = (
  definition: ConnectionTypeDefinition,
  label: string,
): ConnectionSetupGuideCopyValue[] =>
  definition.oauth?.callbackUrl ? [{
    label,
    value: definition.oauth.callbackUrl,
    kind: 'callback_url',
  }] : [];

export const secretFieldCopyValues = (
  secrets: ConnectionSecretDefinition[],
  label: string,
): ConnectionSetupGuideCopyValue[] =>
  secrets.map((secret) => ({
    label,
    value: secret.label,
    kind: 'field',
  }));
