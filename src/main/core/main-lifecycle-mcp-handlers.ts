import type {
  SocialUserApp,
  SocialUserAppUpdateInput,
  SocialUserAppVisibility,
} from '../../shared/types';
import type { MainLifecycleState } from './main-lifecycle-types';

export interface PublishedAppInfoUpdateInput {
  userAppId?: number;
  appId?: string;
  visibility?: Exclude<SocialUserAppVisibility, 'restricted'>;
  name?: string;
  shortDescription?: string;
  description?: string;
  longDescription?: string;
  category?: string;
}

interface BackendClientWithSocialUpdates {
  updateSocialApp?: (input: SocialUserAppUpdateInput) => Promise<SocialUserApp>;
}

export const createPublishedAppInfoUpdater = (state: MainLifecycleState) =>
  async (input: PublishedAppInfoUpdateInput) => {
    const backendClient = state.forgerBackendClient as BackendClientWithSocialUpdates | null;
    if (!backendClient?.updateSocialApp) {
      return {
        success: false,
        userMessage: 'No pudimos actualizar la informacion publicada de esta app.',
        technicalCode: 'backend_client_missing',
      };
    }

    const userAppId = input.userAppId ?? (
      input.appId
        ? state.registry.apps[input.appId]?.publishedSocialSource?.userAppId
          ?? state.registry.apps[input.appId]?.socialSource?.userAppId
        : undefined
    );
    if (!userAppId) {
      return {
        success: false,
        userMessage: 'No encontramos una publicacion Social asociada a esa app.',
        technicalCode: 'published_app_target_not_found',
      };
    }

    try {
      const appInfo: SocialUserAppUpdateInput = {
        id: userAppId,
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.shortDescription !== undefined ? { shortDescription: input.shortDescription } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.longDescription !== undefined ? { longDescription: input.longDescription } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
      };
      const appInfoResult = await backendClient.updateSocialApp(appInfo);
      return {
        success: true,
        app: appInfoResult,
        userMessage: 'Informacion publicada actualizada.',
      };
    } catch (error) {
      return {
        success: false,
        userMessage: 'No pudimos actualizar la informacion publicada de esta app.',
        technicalCode: error instanceof Error ? error.message : 'published_app_info_update_failed',
      };
    }
  };
