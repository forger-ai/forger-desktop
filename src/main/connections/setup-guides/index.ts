import type { ConnectionTypeDefinition } from '../../../shared/types/connections';
import { githubSetupGuide } from './github';
import { googleSetupGuide } from './google';
import { metaAdsSetupGuide } from './meta-ads';
import { qrSetupGuide } from './qr';
import { tokenSetupGuide } from './token';
import { normalizeSetupGuideLocale, type SetupGuideContext } from './types';

const googleTypes = new Set(['gmail', 'calendar', 'sheets', 'drive', 'docs']);

const guideFor = (context: SetupGuideContext) => {
  const { definition } = context;
  if (googleTypes.has(definition.type)) return googleSetupGuide(context);
  if (definition.type === 'github') return githubSetupGuide(context);
  if (definition.type === 'meta_ads') return metaAdsSetupGuide(context);
  if (definition.setupKind === 'manual_secret') return tokenSetupGuide(context);
  if (definition.setupKind === 'qr_pairing') return qrSetupGuide(context);
  return undefined;
};

export const withConnectionSetupGuide = (
  definition: ConnectionTypeDefinition,
  locale?: string,
): ConnectionTypeDefinition => {
  const setupGuide = guideFor({ definition, locale: normalizeSetupGuideLocale(locale) });
  return setupGuide ? { ...definition, setupGuide } : definition;
};
