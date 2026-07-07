import path from 'node:path';
import type {
  CallConnectionActionInput,
  CallConnectionActionResult,
  ConfigureConnectionInput,
  ConnectionActionDefinition,
  ConnectionInstance,
  ConnectionMutationResult,
  ConnectionSecretDefinition,
  ConnectionSetupKind,
  ConnectionStatus,
  ConnectionStatusInput,
  ConnectionStatusResult,
  ConnectionTypeDefinition,
  DisconnectConnectionInput,
  SafeConnectionIdentity,
} from '../../shared/types/connections';
import type {
  CallOfficialToolResult,
  OfficialToolDefinition,
} from '../../shared/types';
import { gmailToolModule } from './modules/gmail';
import { whatsappToolModule } from './modules/whatsapp';
import { slackToolModule } from './modules/slack';
import { trelloToolModule } from './modules/trello';
import { calendarToolModule, docsToolModule, driveToolModule, sheetsToolModule } from './modules/google-workspace';
import { githubToolModule } from './modules/github';
import { notionToolModule } from './modules/notion';
import { tokenServiceConnectorModules } from './modules/token-service-connectors';
import type { InternalToolContext, InternalToolModule } from '../tools/types';
import type { ConnectionContext, InternalConnectionModule } from './types';

const setupKindByType: Record<string, ConnectionSetupKind> = {
  gmail: 'oauth',
  calendar: 'oauth',
  sheets: 'oauth',
  drive: 'oauth',
  docs: 'oauth',
  github: 'oauth',
  notion: 'manual_secret',
  whatsapp: 'qr_pairing',
  slack: 'manual_secret',
  trello: 'manual_secret',
  figma: 'manual_secret',
  zendesk: 'manual_secret',
  discord: 'manual_secret',
  calendly: 'manual_secret',
  gitlab: 'manual_secret',
  shopify: 'manual_secret',
  whatsapp_business: 'manual_secret',
  telegram: 'manual_secret',
  sendgrid: 'manual_secret',
  postmark: 'manual_secret',
  twilio: 'manual_secret',
  meta_ads: 'oauth',
};

const oauthByType: Record<string, ConnectionTypeDefinition['oauth']> = {
  gmail: { callbackPath: '/oauth/gmail/callback', scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  calendar: { callbackPath: '/oauth/calendar/callback', scopes: ['https://www.googleapis.com/auth/calendar'] },
  sheets: { callbackPath: '/oauth/sheets/callback', scopes: ['https://www.googleapis.com/auth/spreadsheets'] },
  drive: { callbackPath: '/oauth/drive/callback', scopes: ['https://www.googleapis.com/auth/drive.file'] },
  docs: { callbackPath: '/oauth/docs/callback', scopes: ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive.file'] },
  meta_ads: {
    callbackPath: '/oauth/meta_ads/callback',
    scopes: ['ads_management', 'ads_read', 'leads_retrieval', 'pages_show_list', 'pages_read_engagement'],
    requiresProviderRedirectConfig: true,
  },
};

const toolActionsToConnectionActions = (actions: OfficialToolDefinition['actions']): ConnectionActionDefinition[] =>
  actions.map((action) => ({
    id: action.id,
    name: action.name,
    description: action.description,
    risk: action.risk,
    ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
    ...(action.outputSchema ? { outputSchema: action.outputSchema } : {}),
  }));

const toolSecretsToConnectionSecrets = (secrets: OfficialToolDefinition['secrets']): ConnectionSecretDefinition[] =>
  secrets.map((secret) => ({
    name: secret.name,
    label: secret.label,
    required: secret.required,
    usage: secret.usage,
    ...(secret.manual ? { manual: secret.manual } : {}),
  }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const safeIdentityFromValue = (value: unknown): SafeConnectionIdentity | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const identity: SafeConnectionIdentity = {};
  const subject = cleanString(value.subject);
  const email = cleanString(value.email);
  const phoneNumber = cleanString(value.phoneNumber);
  const workspace = cleanString(value.workspace ?? value.team ?? value.teamName);
  const username = cleanString(value.username ?? value.user ?? value.fullName);
  if (subject) identity.subject = subject;
  if (email) identity.email = email;
  if (phoneNumber) identity.phoneNumber = phoneNumber;
  if (workspace) identity.workspace = workspace;
  if (username) identity.username = username;
  return Object.keys(identity).length > 0 ? identity : undefined;
};

const labelFromIdentity = (
  fallback: string,
  identity?: SafeConnectionIdentity,
): string =>
  identity?.email
  ?? identity?.workspace
  ?? identity?.username
  ?? identity?.phoneNumber
  ?? fallback;

const statusFromLegacyResult = (
  result: CallOfficialToolResult,
  instance?: ConnectionInstance,
): ConnectionStatusResult => {
  if (!result.success) {
    return {
      connected: false,
      status: 'error',
      message: result.userMessage,
      technicalCode: result.technicalCode,
      accountIdentity: instance?.accountIdentity,
    };
  }
  const data = isRecord(result.data) ? result.data : {};
  const connected = data.connected === true;
  const needsReconnect = data.needsReconnect === true || data.connected === false && Boolean(instance);
  const status: ConnectionStatus = connected
    ? 'connected'
    : needsReconnect ? 'needs_reconnect' : 'needs_setup';
  const identity = safeIdentityFromValue(data) ?? instance?.accountIdentity;
  return {
    connected,
    status,
    ...(typeof data.technicalCode === 'string' ? { technicalCode: data.technicalCode } : {}),
    ...(identity ? { accountIdentity: identity } : {}),
    lastCheckedAt: new Date().toISOString(),
  };
};

const selectInstance = async (
  context: ConnectionContext,
  type: string,
  connectionId?: string,
): Promise<ConnectionInstance | null> => {
  const instances = await context.listPersistedInstances(type);
  if (connectionId) {
    return instances.find((instance) => instance.id === connectionId) ?? null;
  }
  return instances.find((instance) => instance.isDefault) ?? instances[0] ?? null;
};

const createConnectionToolContext = (
  context: ConnectionContext,
  toolId: string,
  connectionId: string,
): InternalToolContext => ({
  metadataRoot: path.join(context.metadataRoot, 'connections', toolId, connectionId),
  locale: context.locale,
  secretsStore: {
    setToolSecret: async (_toolId: string, secretName: string, value: string) =>
      context.secretsStore.setConnectionSecret(connectionId, secretName, value),
    getToolSecret: async (_toolId: string, secretName: string) =>
      context.secretsStore.getConnectionSecret(connectionId, secretName),
    hasToolSecret: async (_toolId: string, secretName: string) =>
      context.secretsStore.hasConnectionSecret(connectionId, secretName),
    deleteToolSecrets: async () =>
      context.secretsStore.deleteConnectionSecrets(connectionId),
  } as unknown as InternalToolContext['secretsStore'],
  getFreePort: context.getFreePort,
  openExternalUrl: context.openExternalUrl,
  isForgerAccountAuthenticated: context.isForgerAccountAuthenticated,
  getGmailOAuthClientId: context.getGmailOAuthClientId,
  exchangeGmailOAuthCode: context.exchangeGmailOAuthCode,
  refreshGmailOAuthAccessToken: context.refreshGmailOAuthAccessToken,
  ...(context.selfOAuthCallbackService ? { selfOAuthCallbackService: context.selfOAuthCallbackService } : {}),
  appendLog: context.appendLog,
  emitEvent: context.emitEvent,
});

const createToolBackedConnectionModule = (
  module: InternalToolModule,
  options: { setupKind: ConnectionSetupKind; supportsMultiple: boolean },
): InternalConnectionModule => {
  const type = module.definition.id;
  const actions = toolActionsToConnectionActions(module.definition.actions);
  const secretsSchema = toolSecretsToConnectionSecrets(module.definition.secrets);
  const statusActionId = actions.find((action) => action.id.endsWith('.connection.status'))?.id ?? `${type}.connection.status`;
  const definition = {
    type,
    displayName: module.definition.name,
    description: module.definition.description,
    setupKind: options.setupKind,
    supportsMultiple: options.supportsMultiple,
    actions,
    secretsSchema,
    statusActionId,
    version: module.definition.version,
    ...(oauthByType[type] ? { oauth: oauthByType[type] } : {}),
  };

  const updateFromStatus = async (
    context: ConnectionContext,
    instance: ConnectionInstance,
    status: ConnectionStatusResult,
  ): Promise<ConnectionInstance> => {
    const updated = await context.updateInstance(instance.id, {
      status: status.status,
      ...(status.accountIdentity ? { accountIdentity: status.accountIdentity } : {}),
      ...(status.lastCheckedAt ? { lastCheckedAt: status.lastCheckedAt } : {}),
      label: labelFromIdentity(instance.label, status.accountIdentity),
    });
    return updated ?? instance;
  };

  const status = async (
    context: ConnectionContext,
    input: ConnectionStatusInput,
  ): Promise<ConnectionStatusResult> => {
    const instance = await selectInstance(context, type, input.connectionId);
    if (!instance) {
      return { connected: false, status: 'needs_setup' };
    }
    const result = await module.execute(
      { toolId: type, actionId: statusActionId, input: {} },
      createConnectionToolContext(context, type, instance.id),
    );
    const normalized = statusFromLegacyResult(result, instance);
    await updateFromStatus(context, instance, normalized);
    return normalized;
  };

  return {
    definition,
    listInstances: async (context) => context.listPersistedInstances(type),
    configure: async (context: ConnectionContext, input: ConfigureConnectionInput): Promise<ConnectionMutationResult> => {
      const identity = safeIdentityFromValue(input.accountIdentity);
      const existing = cleanString(input.connectionId)
        ? (await context.listPersistedInstances(type)).find((instance) => instance.id === cleanString(input.connectionId)) ?? null
        : null;
      const instance = existing
        ? await context.updateInstance(existing.id, {
            label: cleanString(input.label) || existing.label,
            ...(identity ? { accountIdentity: identity } : {}),
            status: 'connecting',
          }) ?? existing
        : await context.createInstance({
            type,
            label: cleanString(input.label) || labelFromIdentity(definition.displayName, identity),
            ...(identity ? { accountIdentity: identity } : {}),
            secrets: input.secrets,
            status: 'connecting',
          });
      if (existing && input.secrets) {
        await Promise.all(Object.entries(input.secrets).map(async ([secretName, value]) => {
          const normalizedName = cleanString(secretName);
          if (normalizedName && value) {
            await context.setSecret(instance.id, normalizedName, value);
          }
        }));
      }
      const connectionToolContext = createConnectionToolContext(context, type, instance.id);
      const configured = await module.configure(connectionToolContext, {
        toolId: type,
        locale: context.locale,
        secrets: input.secrets,
      });
      if (!configured.success) {
        if (existing) {
          await context.updateInstance(instance.id, { status: 'error' }).catch(() => undefined);
        } else {
          await context.deleteInstance(instance.id).catch(() => undefined);
        }
        return configured;
      }
      const nextStatus = await status(context, { type, connectionId: instance.id });
      const updated = await updateFromStatus(context, instance, nextStatus);
      return {
        success: true,
        userMessage: configured.userMessage,
        instance: updated,
      };
    },
    disconnect: async (context: ConnectionContext, input: DisconnectConnectionInput): Promise<ConnectionMutationResult> => {
      await module.deactivate?.(createConnectionToolContext(context, type, input.connectionId));
      await context.deleteInstance(input.connectionId, { keepSecrets: input.keepSecrets });
      return { success: true, userMessage: `${definition.displayName} disconnected.` };
    },
    status,
    execute: async (context: ConnectionContext, input: CallConnectionActionInput): Promise<CallConnectionActionResult> => {
      if (input.actionId === statusActionId) {
        return { success: true, data: await status(context, input) };
      }
      const instance = await selectInstance(context, type, input.connectionId);
      if (!instance) {
        return {
          success: false,
          userMessage: `${definition.displayName} is not configured.`,
          technicalCode: 'connection_not_configured',
        };
      }
      return module.execute(
        { toolId: type, actionId: input.actionId, input: input.input },
        createConnectionToolContext(context, type, instance.id),
      );
    },
    start: async (context: ConnectionContext) => {
      const instances = await context.listPersistedInstances(type);
      await Promise.all(instances.map((instance) =>
        module.start?.(createConnectionToolContext(context, type, instance.id))));
    },
    stop: async (context: ConnectionContext) => {
      const instances = await context.listPersistedInstances(type);
      await Promise.all(instances.map((instance) =>
        module.stop?.(createConnectionToolContext(context, type, instance.id))));
    },
  };
};

export const BUILT_IN_CONNECTION_MODULES: InternalConnectionModule[] = [
  createToolBackedConnectionModule(gmailToolModule, { setupKind: setupKindByType.gmail, supportsMultiple: true }),
  createToolBackedConnectionModule(calendarToolModule, { setupKind: setupKindByType.calendar, supportsMultiple: true }),
  createToolBackedConnectionModule(sheetsToolModule, { setupKind: setupKindByType.sheets, supportsMultiple: true }),
  createToolBackedConnectionModule(driveToolModule, { setupKind: setupKindByType.drive, supportsMultiple: true }),
  createToolBackedConnectionModule(docsToolModule, { setupKind: setupKindByType.docs, supportsMultiple: true }),
  createToolBackedConnectionModule(githubToolModule, { setupKind: setupKindByType.github, supportsMultiple: true }),
  createToolBackedConnectionModule(notionToolModule, { setupKind: setupKindByType.notion, supportsMultiple: true }),
  createToolBackedConnectionModule(whatsappToolModule, { setupKind: setupKindByType.whatsapp, supportsMultiple: true }),
  createToolBackedConnectionModule(slackToolModule, { setupKind: setupKindByType.slack, supportsMultiple: true }),
  createToolBackedConnectionModule(trelloToolModule, { setupKind: setupKindByType.trello, supportsMultiple: true }),
  ...tokenServiceConnectorModules.map((module) =>
    createToolBackedConnectionModule(module, { setupKind: setupKindByType[module.definition.id], supportsMultiple: true })),
];
