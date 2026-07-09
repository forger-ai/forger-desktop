import type {
  ConnectionActionDefinition,
  ConnectionRequirementState,
  SocialUserApp,
  SocialUserAppUpdateInput,
  SocialUserAppVisibility,
} from '../../shared/types';
import type { MainLifecycleState } from './main-lifecycle-types';

type ElectronDialog = typeof import('electron').dialog;

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

interface ConnectionsServiceWithAppGrants {
  listConnectionsForApp: (appId: string) => Promise<{ requirements: ConnectionRequirementState[] }>;
  setAppConnectionGrant: (input: {
    appId: string;
    type: string;
    granted: boolean;
    connectionIds?: string[];
  }) => Promise<ConnectionRequirementState | null | undefined>;
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

export const createConnectionGrantRequester = ({
  dialog,
  state,
}: {
  dialog: ElectronDialog;
  state: MainLifecycleState;
}) =>
  async (appId: string, input: { type: string; reason?: string; connectionIds?: string[] }) => {
    const type = typeof input.type === 'string' ? input.type.trim() : '';
    if (!type) {
      return {
        success: false,
        userMessage: 'Connection type is required.',
        technicalCode: 'connection_type_required',
      };
    }

    const service = state.connectionsService as ConnectionsServiceWithAppGrants | null;
    const connectionState = await service!.listConnectionsForApp(appId);
    const requirement = connectionState.requirements.find((candidate) => candidate.declaration.type === type);
    if (!requirement) {
      return {
        success: false,
        userMessage: 'This app has not declared this connection.',
        technicalCode: 'app_connection_not_declared',
      };
    }
    if (requirement.granted && !requirement.reviewNeeded) {
      return {
        success: true,
        userMessage: 'This connection is already allowed for the app.',
        requirement,
      };
    }

    const appName = state.registry.apps[appId]?.name ?? appId;
    const connectionName = requirement.definition?.displayName ?? type;
    const detail = connectionGrantDialogDetail(requirement, input);
    const decision = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Allow', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Allow connection access?',
      message: `Allow ${appName} to use ${connectionName}?`,
      detail,
    });
    if (decision.response !== 0) {
      return {
        success: false,
        userMessage: 'The connection was not allowed for the app.',
        technicalCode: 'connection_grant_rejected',
        requirement,
      };
    }

    const updatedRequirement = await service!.setAppConnectionGrant({
      appId,
      type,
      granted: true,
      ...(input.connectionIds?.length ? { connectionIds: input.connectionIds } : {}),
    });
    return updatedRequirement
      ? {
        success: true,
        userMessage: 'The connection is allowed for the app.',
        requirement: updatedRequirement,
      }
      : {
        success: false,
        userMessage: 'This app has not declared this connection.',
        technicalCode: 'app_connection_not_declared',
      };
  };

const connectionGrantDialogDetail = (
  requirement: ConnectionRequirementState,
  input: { reason?: string; connectionIds?: string[] },
): string => {
  const declaredReason = typeof requirement.declaration.reason === 'string'
    ? requirement.declaration.reason.trim()
    : '';
  const requestReason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const actionNames = requirement.resolvedActions
    .map((action: ConnectionActionDefinition) => action.name || action.id)
    .filter(Boolean)
    .join(', ');
  return [
    requestReason || declaredReason,
    actionNames ? `Actions: ${actionNames}` : '',
    input.connectionIds?.length ? `Selected connections: ${input.connectionIds.join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
};
