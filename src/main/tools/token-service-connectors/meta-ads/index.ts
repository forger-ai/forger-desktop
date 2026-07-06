import type { InternalToolModule } from '../../types';
import {
  OAUTH_ACCESS_TOKEN_SECRET,
} from '../../self-oauth';
import { configureMetaAds } from './configure';
import { metaAdsDefinition } from './definition';
import { executeMetaAds } from './actions';
import { ID } from './client';

export const metaAdsToolModule: InternalToolModule = {
  definition: metaAdsDefinition,
  configure: configureMetaAds,
  execute: executeMetaAds,
  isConfigured: async (context) =>
    Boolean(await context.secretsStore.getToolSecret(ID, OAUTH_ACCESS_TOKEN_SECRET)),
};
