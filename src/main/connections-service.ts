import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CallConnectionActionInput,
  CallConnectionActionResult,
  AppConnectionDeclaration,
  ConfigureConnectionInput,
  ConnectionInstance,
  ConnectionMutationResult,
  ConnectionRequirementState,
  ConnectionSessionGrant,
  ConnectionStatus,
  ConnectionTypeDefinition,
  ConnectionsState,
  DisconnectConnectionInput,
  PersistedConnectionGrant,
  SafeConnectionIdentity,
} from '../shared/types/connections';
import { normalizeConnectionStatus } from './connections/status';
import { BUILT_IN_CONNECTION_MODULES } from './connections';
import { localizeConnectionDefinition } from './connections/localization';
import { withConnectionSetupGuide } from './connections/setup-guides';
import type {
  ConnectionContext,
  ConnectionSecretsStore,
  CreateConnectionInstanceInput,
  InternalConnectionModule,
} from './connections/types';
import type { InternalOAuthTokenResponse } from './tools/types';
import type { OfficialToolRuntimeEvent } from '../shared/types';
import type { SelfOAuthCallbackServiceLike } from './oauth-callback/types';
import {
  connectionGrantAllowsAction,
  grantRequestsAllActions,
  resolveConnectionActionSnapshot,
  resolveGrantActions,
} from './connections/grants';

interface PersistedConnectionInstance {
  id: string;
  type: string;
  label: string;
  accountIdentity?: SafeConnectionIdentity;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
}

interface ConnectionsRegistryFile {
  version: 1;
  instances: Record<string, PersistedConnectionInstance>;
  defaults: Record<string, string>;
  appGrants: Record<string, Record<string, PersistedConnectionGrant>>;
  agentGrants: Record<string, Record<string, PersistedConnectionGrant>>;
}

interface ConnectionsServiceOptions {
  metadataRoot: string;
  secretsStore: ConnectionSecretsStore;
  modules?: InternalConnectionModule[];
  locale?: string;
  getFreePort?: () => Promise<number>;
  openExternalUrl?: (url: string) => Promise<void>;
  isForgerAccountAuthenticated?: () => boolean;
  getGmailOAuthClientId?: () => Promise<string>;
  exchangeGmailOAuthCode?: (input: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<InternalOAuthTokenResponse>;
  refreshGmailOAuthAccessToken?: (input: {
    clientId: string;
    refreshToken: string;
  }) => Promise<InternalOAuthTokenResponse>;
  selfOAuthCallbackService?: SelfOAuthCallbackServiceLike;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  emitEvent?: (event: OfficialToolRuntimeEvent) => void;
  getAppConnectionDeclarations?: (appId: string) => Promise<{
    appName: string;
    required: AppConnectionDeclaration[];
    optional: AppConnectionDeclaration[];
  } | null>;
}

interface EffectiveConnectionGrant {
  type: string;
  connectionIds?: string[];
  actions: string[];
  multiple: boolean;
}

interface ServiceCallConnectionActionInput extends CallConnectionActionInput {
  grant?: EffectiveConnectionGrant;
}

interface AppConnectionRequirementsOptions {
  defaultOptionalGrants?: boolean;
}

interface EffectiveAppConnectionGrant extends EffectiveConnectionGrant {
  actionDeclared: boolean;
  actionGranted: boolean;
}

const emptyRegistry = (): ConnectionsRegistryFile => ({
  version: 1,
  instances: {},
  defaults: {},
  appGrants: {},
  agentGrants: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const safeIdentity = (value: unknown): SafeConnectionIdentity | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const identity: SafeConnectionIdentity = {};
  for (const key of ['subject', 'email', 'phoneNumber', 'workspace', 'username'] as const) {
    const text = cleanString(value[key]);
    if (text) {
      identity[key] = text;
    }
  }
  return Object.keys(identity).length > 0 ? identity : undefined;
};

const toConnectionInstance = (
  persisted: PersistedConnectionInstance,
  defaults: Record<string, string>,
): ConnectionInstance => ({
  ...persisted,
  isDefault: defaults[persisted.type] === persisted.id,
});

const isConnectedConnectionInstance = (instance: ConnectionInstance): boolean =>
  instance.status === 'connected';

const isSetupConnectionAction = (definition: ConnectionTypeDefinition, actionId: string): boolean =>
  (definition.setupKind === 'qr_pairing' || definition.setupKind === 'local_device')
  && actionId.endsWith('.start_pairing');

export class ConnectionsService {
  private readonly modulesByType: Map<string, InternalConnectionModule>;
  private registry: ConnectionsRegistryFile = emptyRegistry();
  private loaded = false;

  constructor(private readonly options: ConnectionsServiceOptions) {
    const modules = options.modules ?? BUILT_IN_CONNECTION_MODULES;
    this.modulesByType = new Map(modules.map((module) => [module.definition.type, module]));
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.registry = await this.readRegistry();
    this.loaded = true;
  }

  async listTypes(locale?: string): Promise<ConnectionTypeDefinition[]> {
    await this.load();
    const effectiveLocale = locale ?? this.options.locale;
    return [...this.modulesByType.values()].map((module) =>
      withConnectionSetupGuide(
        this.withOAuthCallback(localizeConnectionDefinition(module.definition, effectiveLocale)),
        effectiveLocale,
      ));
  }

  async listState(locale?: string): Promise<ConnectionsState> {
    await this.load();
    return {
      types: await this.listTypes(locale),
      instances: await this.listInstances(),
    };
  }

  async listInstances(type?: string): Promise<ConnectionInstance[]> {
    await this.load();
    return Object.values(this.registry.instances)
      .filter((instance) => !type || instance.type === type)
      .map((instance) => toConnectionInstance(instance, this.registry.defaults))
      .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
  }

  async configure(input: ConfigureConnectionInput): Promise<ConnectionMutationResult> {
    await this.load();
    const type = cleanString(input.type);
    const module = this.modulesByType.get(type);
    if (!module) {
      return { success: false, userMessage: 'Connection type is not available.', technicalCode: 'connection_type_not_found' };
    }
    return module.configure(this.getContext(), { ...input, type });
  }

  async configureFromApp(appId: string, input: ConfigureConnectionInput): Promise<ConnectionMutationResult> {
    await this.load();
    const declarations = await this.options.getAppConnectionDeclarations?.(appId);
    if (!declarations) {
      return { success: false, userMessage: 'This app has not declared connections.', technicalCode: 'app_connections_not_declared' };
    }
    const type = cleanString(input.type);
    const declaration = [...declarations.required, ...declarations.optional].find((item) => item.type === type);
    if (!declaration) {
      return { success: false, userMessage: 'This app has not declared this connection.', technicalCode: 'app_connection_not_declared' };
    }
    const module = this.modulesByType.get(type);
    if (!module) {
      return { success: false, userMessage: 'Connection type is not available.', technicalCode: 'connection_type_not_found' };
    }
    if (module.definition.setupKind !== 'oauth') {
      return { success: false, userMessage: 'This connection cannot be configured from an app.', technicalCode: 'connection_setup_not_oauth' };
    }
    return this.configure({
      type,
      ...(cleanString(input.label) ? { label: cleanString(input.label) } : {}),
      ...(cleanString(input.connectionId) ? { connectionId: cleanString(input.connectionId) } : {}),
    });
  }

  async disconnect(input: DisconnectConnectionInput): Promise<ConnectionMutationResult> {
    await this.load();
    const type = cleanString(input.type);
    const module = this.modulesByType.get(type);
    if (!module) {
      return { success: false, userMessage: 'Connection type is not available.', technicalCode: 'connection_type_not_found' };
    }
    return module.disconnect(this.getContext(), input);
  }

  async setDefaultConnection(input: { type: string; connectionId: string }): Promise<ConnectionMutationResult> {
    await this.load();
    const type = cleanString(input.type);
    const connectionId = cleanString(input.connectionId);
    const instance = this.registry.instances[connectionId];
    if (!instance || instance.type !== type) {
      return { success: false, userMessage: 'Connection account was not found.', technicalCode: 'connection_instance_not_found' };
    }
    await this.setDefault(type, connectionId);
    return {
      success: true,
      userMessage: 'Default connection updated.',
      instance: toConnectionInstance(this.registry.instances[connectionId], this.registry.defaults),
    };
  }

  async call(input: ServiceCallConnectionActionInput): Promise<CallConnectionActionResult> {
    await this.load();
    const type = cleanString(input.type);
    const actionId = cleanString(input.actionId);
    const module = this.modulesByType.get(type);
    if (!module) {
      return { success: false, userMessage: 'Connection type is not available.', technicalCode: 'connection_type_not_found' };
    }
    if (!module.definition.actions.some((action) => action.id === actionId)) {
      return { success: false, userMessage: 'Connection action is not available.', technicalCode: 'connection_action_not_found' };
    }
    if (input.grant && (!input.grant.actions.includes(actionId) || input.grant.type !== type)) {
      return { success: false, userMessage: 'This connection action is not allowed.', technicalCode: 'connection_action_not_granted' };
    }

    const isStatusAction = actionId === module.definition.statusActionId;
    const isSetupAction = isSetupConnectionAction(module.definition, actionId);
    const resolved = isStatusAction
      ? input.connectionId
      : await this.resolveConnectionId(type, input.connectionId, input.grant, {
          requireConnected: !isSetupAction,
        });
    if (resolved && typeof resolved !== 'string') {
      return resolved;
    }
    if (!isStatusAction && !resolved) {
      return { success: false, userMessage: 'Connection is not configured.', technicalCode: 'connection_not_configured' };
    }

    const result = await module.execute(this.getContext(), {
      type,
      actionId,
      ...(input.input ? { input: input.input } : {}),
      ...(resolved ? { connectionId: resolved } : {}),
    });
    if (isStatusAction && result.success && isRecord(result.data)) {
      return { ...result, data: normalizeConnectionStatus(result.data) };
    }
    return result;
  }

  async listConnectionsForApp(appId: string, options?: AppConnectionRequirementsOptions): Promise<{
    types: ConnectionTypeDefinition[];
    instances: ConnectionInstance[];
    requirements: ConnectionRequirementState[];
  }> {
    await this.load();
    const requirements = await this.getRequirementsForApp(appId, options);
    const callableTypes = new Set(
      requirements
        .filter((requirement) => requirement.granted)
        .map((requirement) => requirement.declaration.type),
    );
    return {
      types: (await this.listTypes()).filter((definition) => callableTypes.has(definition.type)),
      instances: (await this.listInstances()).filter((instance) => callableTypes.has(instance.type)),
      requirements,
    };
  }

  async callFromApp(appId: string, input: CallConnectionActionInput): Promise<CallConnectionActionResult> {
    await this.load();
    const declarations = await this.options.getAppConnectionDeclarations?.(appId);
    if (!declarations) {
      return { success: false, userMessage: 'This app has not declared connections.', technicalCode: 'app_connections_not_declared' };
    }
    const type = cleanString(input.type);
    const actionId = cleanString(input.actionId);
    const required = declarations.required.find((item) => item.type === type);
    const optional = declarations.optional.find((item) => item.type === type);
    if (!required && !optional) {
      return { success: false, userMessage: 'This app has not declared this connection.', technicalCode: 'app_connection_not_declared' };
    }
    const grant = this.buildEffectiveAppGrant(appId, type, actionId, required, optional);
    if (!grant.actionDeclared) {
      return { success: false, userMessage: 'This connection action was not declared by the app.', technicalCode: 'app_connection_action_not_declared' };
    }
    if (!grant.actionGranted) {
      return { success: false, userMessage: 'The app does not have permission to use this connection.', technicalCode: 'app_connection_permission_denied' };
    }

    return this.call({
      ...input,
      type,
      actionId,
      grant,
    });
  }

  async listSessionGrantsForApp(appId: string): Promise<ConnectionSessionGrant[]> {
    await this.load();
    const declarations = await this.options.getAppConnectionDeclarations?.(appId);
    if (!declarations) {
      return [];
    }
    const grants: ConnectionSessionGrant[] = [];
    for (const declaration of declarations.required) {
      const snapshot = this.buildGrantSnapshot(declaration, { granted: true });
      if (snapshot.granted) {
        grants.push(this.snapshotToSessionGrant(snapshot));
      }
    }
    for (const declaration of declarations.optional) {
      const snapshot = this.getStoredGrantForDeclaration(appId, declaration);
      if (snapshot?.granted) {
        grants.push(this.snapshotToSessionGrant(snapshot));
      }
    }
    return this.mergeSessionGrants(grants);
  }

  async listConnectionsForSession(grants: ConnectionSessionGrant[]): Promise<{
    types: ConnectionTypeDefinition[];
    instances: ConnectionInstance[];
    grants: ConnectionSessionGrant[];
  }> {
    await this.load();
    const grantTypes = new Set(grants.map((grant) => grant.type));
    const allowedIdsByType = new Map<string, Set<string>>();
    for (const grant of grants) {
      if (grant.connectionIds?.length) {
        allowedIdsByType.set(grant.type, new Set(grant.connectionIds));
      }
    }
    const instances = (await this.listInstances()).filter((instance) => {
      if (!grantTypes.has(instance.type)) {
        return false;
      }
      if (!isConnectedConnectionInstance(instance)) {
        return false;
      }
      const allowedIds = allowedIdsByType.get(instance.type);
      return !allowedIds || allowedIds.has(instance.id);
    });
    return {
      types: (await this.listTypes()).filter((definition) => grantTypes.has(definition.type)),
      instances,
      grants,
    };
  }

  async callFromSession(
    input: CallConnectionActionInput,
    grants: ConnectionSessionGrant[],
  ): Promise<CallConnectionActionResult> {
    await this.load();
    const type = cleanString(input.type);
    const actionId = cleanString(input.actionId);
    const grant = grants.find((candidate) => candidate.type === type && candidate.actions.includes(actionId));
    if (!grant) {
      return { success: false, userMessage: 'This connection action is not granted for this session.', technicalCode: 'connection_action_not_granted' };
    }
    return this.call({
      ...input,
      type,
      actionId,
      grant,
    });
  }

  async setAppConnectionGrant(input: {
    appId: string;
    type: string;
    granted: boolean;
    connectionIds?: string[];
  }): Promise<ConnectionRequirementState | null> {
    await this.load();
    const declarations = await this.options.getAppConnectionDeclarations?.(input.appId);
    if (!declarations) {
      return null;
    }
    const type = cleanString(input.type);
    const declaration = declarations.optional.find((item) => item.type === type)
      ?? declarations.required.find((item) => item.type === type);
    if (!declaration) {
      return null;
    }
    this.registry.appGrants[input.appId] = {
      ...(this.registry.appGrants[input.appId] ?? {}),
      [type]: this.buildGrantSnapshot(declaration, {
        granted: input.granted,
        connectionIds: input.connectionIds,
      }),
    };
    await this.saveRegistry();
    return this.toRequirement(input.appId, declaration, declarations.required.includes(declaration));
  }

  async getSecretForTest(connectionId: string, secretName: string): Promise<string | null> {
    return this.options.secretsStore.getConnectionSecret(connectionId, secretName);
  }

  async clearDefaultForTest(type: string): Promise<void> {
    await this.load();
    delete this.registry.defaults[type];
    await this.saveRegistry();
  }

  private async getRequirementsForApp(appId: string, options?: AppConnectionRequirementsOptions): Promise<ConnectionRequirementState[]> {
    const declarations = await this.options.getAppConnectionDeclarations?.(appId);
    if (!declarations) {
      return [];
    }
    const requirements: ConnectionRequirementState[] = [];
    for (const declaration of declarations.required) {
      requirements.push(await this.toRequirement(appId, declaration, true, options));
    }
    for (const declaration of declarations.optional) {
      requirements.push(await this.toRequirement(appId, declaration, false, options));
    }
    return requirements;
  }

  private async toRequirement(
    appId: string,
    declaration: AppConnectionDeclaration,
    required: boolean,
    options?: AppConnectionRequirementsOptions,
  ): Promise<ConnectionRequirementState> {
    const definition = this.modulesByType.get(declaration.type)?.definition;
    const instances = await this.listInstances(declaration.type);
    const storedGrant = required
      ? undefined
      : this.getStoredGrantForDeclaration(appId, declaration);
    const hasStoredGrant = Boolean(storedGrant);
    const grant = storedGrant ?? this.buildGrantSnapshot(declaration, {
      granted: required || options?.defaultOptionalGrants === true,
    });
    const resolvedActionIds = new Set(resolveGrantActions(grant, this.getActionCatalog()));
    const resolvedActions = (definition?.actions ?? []).filter((action) => resolvedActionIds.has(action.id));
    const declaresAllActions = declaration.actions.includes('*');
    return {
      declaration,
      required,
      ...(definition ? { definition } : {}),
      resolvedActions,
      allActions: declaresAllActions,
      granted: required || (hasStoredGrant ? storedGrant?.granted === true : options?.defaultOptionalGrants === true),
      hasStoredGrant,
      configured: instances.length > 0,
      instances: storedGrant?.connectionIds?.length
        ? instances.filter((instance) => storedGrant.connectionIds?.includes(instance.id))
        : instances,
      reviewNeeded: Boolean(storedGrant && this.storedGrantNeedsReview(storedGrant, declaration)),
    };
  }

  private buildEffectiveAppGrant(
    appId: string,
    type: string,
    actionId: string,
    required?: AppConnectionDeclaration,
    optional?: AppConnectionDeclaration,
  ): EffectiveAppConnectionGrant {
    const requiredGrant = required
      ? this.buildGrantSnapshot(required, { granted: true })
      : null;
    const optionalDeclarationGrant = optional
      ? this.buildGrantSnapshot(optional, { granted: true })
      : null;
    const optionalStoredGrant = optional
      ? this.getStoredGrantForDeclaration(appId, optional)
      : undefined;
    const declaredByRequired = Boolean(requiredGrant && connectionGrantAllowsAction(requiredGrant, actionId, this.getActionCatalog()));
    const declaredByOptional = Boolean(optionalDeclarationGrant && connectionGrantAllowsAction(optionalDeclarationGrant, actionId, this.getActionCatalog()));
    const optionalAllowsAction = Boolean(optionalStoredGrant && connectionGrantAllowsAction(optionalStoredGrant, actionId, this.getActionCatalog()));
    const actionGranted = declaredByRequired || optionalAllowsAction;
    const grantForAction = declaredByRequired ? requiredGrant : optionalStoredGrant;
    const actionGrants = [
      ...(requiredGrant ? [requiredGrant] : []),
      ...(optionalStoredGrant?.granted ? [optionalStoredGrant] : []),
    ];
    const actions = [...new Set(actionGrants.flatMap((grant) => resolveGrantActions(grant, this.getActionCatalog())))];
    return {
      type,
      actions,
      multiple: actionGrants.some((grant) => grant.multiple),
      ...(grantForAction?.connectionIds?.length ? { connectionIds: [...grantForAction.connectionIds] } : {}),
      actionDeclared: declaredByRequired || declaredByOptional,
      actionGranted,
    };
  }

  private getStoredGrantForDeclaration(
    appId: string,
    declaration: AppConnectionDeclaration,
  ): PersistedConnectionGrant | undefined {
    const storedGrant = this.registry.appGrants[appId]?.[declaration.type];
    if (!storedGrant || storedGrant.type !== declaration.type) {
      return undefined;
    }
    if (grantRequestsAllActions(storedGrant)) {
      return storedGrant;
    }
    if (declaration.actions.includes('*')) {
      return storedGrant.requestedActions.includes('*') ? storedGrant : undefined;
    }
    const declarationGrant = this.buildGrantSnapshot(declaration, { granted: true });
    const declarationActions = new Set(resolveGrantActions(declarationGrant, this.getActionCatalog()));
    return storedGrant.requestedActions.some((action) => declarationActions.has(action))
      || storedGrant.resolvedActions.some((action) => declarationActions.has(action))
      ? storedGrant
      : undefined;
  }

  private storedGrantNeedsReview(
    storedGrant: PersistedConnectionGrant,
    declaration: AppConnectionDeclaration,
  ): boolean {
    if (declaration.actions.includes('*')) {
      return !grantRequestsAllActions(storedGrant);
    }
    const declarationGrant = this.buildGrantSnapshot(declaration, { granted: true });
    const approvedActions = new Set(resolveGrantActions(storedGrant, this.getActionCatalog()));
    return resolveGrantActions(declarationGrant, this.getActionCatalog())
      .some((action) => !approvedActions.has(action));
  }

  private buildGrantSnapshot(
    declaration: AppConnectionDeclaration,
    options: { granted: boolean; connectionIds?: string[] },
  ): PersistedConnectionGrant {
    return resolveConnectionActionSnapshot(declaration, this.getActionCatalog(), options);
  }

  private snapshotToSessionGrant(grant: PersistedConnectionGrant): ConnectionSessionGrant {
    return {
      type: grant.type,
      actions: resolveGrantActions(grant, this.getActionCatalog()),
      multiple: grant.multiple,
      ...(grant.connectionIds?.length ? { connectionIds: [...grant.connectionIds] } : {}),
    };
  }

  private mergeSessionGrants(grants: ConnectionSessionGrant[]): ConnectionSessionGrant[] {
    const byType = new Map<string, ConnectionSessionGrant>();
    for (const grant of grants) {
      const existing = byType.get(grant.type);
      if (!existing) {
        byType.set(grant.type, grant);
        continue;
      }
      const connectionIds = existing.connectionIds || grant.connectionIds
        ? [...new Set([...(existing.connectionIds ?? []), ...(grant.connectionIds ?? [])])]
        : undefined;
      byType.set(grant.type, {
        type: grant.type,
        actions: [...new Set([...existing.actions, ...grant.actions])],
        multiple: existing.multiple || grant.multiple,
        ...(connectionIds?.length ? { connectionIds } : {}),
      });
    }
    return [...byType.values()];
  }

  private getActionCatalog(): Record<string, string[]> {
    const catalog: Record<string, string[]> = {};
    for (const module of this.modulesByType.values()) {
      catalog[module.definition.type] = module.definition.actions.map((action) => action.id);
    }
    return catalog;
  }

  private hashForType(type: string): string {
    const actions = this.getActionCatalog()[type] ?? [];
    return `${type}:${actions.join('|')}`;
  }

  private getContext(): ConnectionContext {
    return {
      metadataRoot: this.options.metadataRoot,
      secretsStore: this.options.secretsStore,
      locale: this.options.locale,
      getFreePort: this.options.getFreePort ?? (async () => 0),
      openExternalUrl: this.options.openExternalUrl ?? (async () => undefined),
      isForgerAccountAuthenticated: this.options.isForgerAccountAuthenticated ?? (() => true),
      getGmailOAuthClientId: this.options.getGmailOAuthClientId ?? (async () => ''),
      exchangeGmailOAuthCode: this.options.exchangeGmailOAuthCode ?? (async () => ({})),
      refreshGmailOAuthAccessToken: this.options.refreshGmailOAuthAccessToken ?? (async () => ({})),
      ...(this.options.selfOAuthCallbackService ? { selfOAuthCallbackService: this.options.selfOAuthCallbackService } : {}),
      appendLog: this.options.appendLog,
      emitEvent: this.options.emitEvent,
      createInstance: (input) => this.createInstance(input),
      updateInstance: (connectionId, input) => this.updateInstance(connectionId, input),
      deleteInstance: (connectionId, options) => this.deleteInstance(connectionId, options),
      listPersistedInstances: (type) => this.listInstances(type),
      setDefault: (type, connectionId) => this.setDefault(type, connectionId),
      setSecret: (connectionId, secretName, value) => this.options.secretsStore.setConnectionSecret(connectionId, secretName, value),
      getSecret: (connectionId, secretName) => this.options.secretsStore.getConnectionSecret(connectionId, secretName),
    };
  }

  private async createInstance(input: CreateConnectionInstanceInput): Promise<ConnectionInstance> {
    const type = cleanString(input.type);
    const module = this.modulesByType.get(type);
    if (!module) {
      throw new Error('connection_type_not_found');
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const label = cleanString(input.label)
      || safeIdentity(input.accountIdentity)?.email
      || safeIdentity(input.accountIdentity)?.workspace
      || safeIdentity(input.accountIdentity)?.username
      || module.definition.displayName;
    this.registry.instances[id] = {
      id,
      type,
      label,
      ...(safeIdentity(input.accountIdentity) ? { accountIdentity: safeIdentity(input.accountIdentity) } : {}),
      status: input.status ?? 'connected',
      createdAt: now,
      updatedAt: now,
    };
    if (!this.registry.defaults[type]) {
      this.registry.defaults[type] = id;
    }
    for (const [secretName, value] of Object.entries(input.secrets ?? {})) {
      const normalizedName = cleanString(secretName);
      if (normalizedName && value) {
        await this.options.secretsStore.setConnectionSecret(id, normalizedName, value);
      }
    }
    await this.saveRegistry();
    return toConnectionInstance(this.registry.instances[id], this.registry.defaults);
  }

  private async updateInstance(
    connectionId: string,
    input: Partial<Pick<ConnectionInstance, 'label' | 'accountIdentity' | 'status' | 'lastCheckedAt'>>,
  ): Promise<ConnectionInstance | null> {
    await this.load();
    const existing = this.registry.instances[connectionId];
    if (!existing) {
      return null;
    }
    this.registry.instances[connectionId] = {
      ...existing,
      ...(cleanString(input.label) ? { label: cleanString(input.label) } : {}),
      ...(safeIdentity(input.accountIdentity) ? { accountIdentity: safeIdentity(input.accountIdentity) } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.lastCheckedAt ? { lastCheckedAt: input.lastCheckedAt } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.saveRegistry();
    return toConnectionInstance(this.registry.instances[connectionId], this.registry.defaults);
  }

  private async deleteInstance(connectionId: string, options?: { keepSecrets?: boolean }): Promise<void> {
    await this.load();
    const existing = this.registry.instances[connectionId];
    if (!existing) {
      return;
    }
    delete this.registry.instances[connectionId];
    if (this.registry.defaults[existing.type] === connectionId) {
      const next = Object.values(this.registry.instances).find((instance) => instance.type === existing.type);
      if (next) {
        this.registry.defaults[existing.type] = next.id;
      } else {
        delete this.registry.defaults[existing.type];
      }
    }
    if (!options?.keepSecrets) {
      await this.options.secretsStore.deleteConnectionSecrets(connectionId).catch(() => undefined);
    }
    await this.saveRegistry();
  }

  private async setDefault(type: string, connectionId: string): Promise<void> {
    await this.load();
    const instance = this.registry.instances[connectionId];
    if (!instance || instance.type !== type) {
      throw new Error('connection_instance_not_found');
    }
    this.registry.defaults[type] = connectionId;
    await this.saveRegistry();
  }

  private async resolveConnectionId(
    type: string,
    requestedConnectionId?: string,
    grant?: EffectiveConnectionGrant,
    options: { requireConnected?: boolean } = {},
  ): Promise<string | CallConnectionActionResult | null> {
    const instances = await this.listInstances(type);
    const requireConnected = options.requireConnected !== false;
    const grantedIds = grant?.connectionIds?.length ? new Set(grant.connectionIds) : null;
    const grantedInstances = grantedIds
      ? instances.filter((instance) => grantedIds.has(instance.id))
      : instances;
    const available = requireConnected
      ? grantedInstances.filter(isConnectedConnectionInstance)
      : grantedInstances;
    if (requestedConnectionId) {
      const grantedMatch = grantedInstances.find((instance) => instance.id === requestedConnectionId);
      if (!grantedMatch) {
        return { success: false, userMessage: 'Connection is not available for this caller.', technicalCode: 'connection_not_granted' };
      }
      if (requireConnected && !isConnectedConnectionInstance(grantedMatch)) {
        return { success: false, userMessage: 'Connection is not connected.', technicalCode: 'connection_not_connected' };
      }
      return grantedMatch.id;
    }
    const defaultInstance = available.find((instance) => instance.isDefault);
    if (defaultInstance) {
      return defaultInstance.id;
    }
    if (available.length === 0) {
      if (grantedInstances.length > 0) {
        return { success: false, userMessage: 'Connection is not connected.', technicalCode: 'connection_not_connected' };
      }
      return null;
    }
    return {
      success: false,
      userMessage: 'Choose a default connection before using this action.',
      technicalCode: 'connection_default_missing',
      data: {
        connections: available.map((instance) => ({
          id: instance.id,
          type: instance.type,
          label: instance.label,
          accountIdentity: instance.accountIdentity,
          isDefault: instance.isDefault,
        })),
      },
    };
  }

  private getRegistryPath(): string {
    return path.join(this.options.metadataRoot, 'connections.json');
  }

  private async readRegistry(): Promise<ConnectionsRegistryFile> {
    try {
      const raw = await fs.readFile(this.getRegistryPath(), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        return emptyRegistry();
      }
      return {
        version: 1,
        instances: isRecord(parsed.instances) ? parsed.instances as Record<string, PersistedConnectionInstance> : {},
        defaults: isRecord(parsed.defaults) ? parsed.defaults as Record<string, string> : {},
        appGrants: isRecord(parsed.appGrants) ? parsed.appGrants as Record<string, Record<string, PersistedConnectionGrant>> : {},
        agentGrants: isRecord(parsed.agentGrants) ? parsed.agentGrants as Record<string, Record<string, PersistedConnectionGrant>> : {},
      };
    } catch {
      return emptyRegistry();
    }
  }

  private async saveRegistry(): Promise<void> {
    const registryPath = this.getRegistryPath();
    const tempPath = `${registryPath}.tmp`;
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(this.registry, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, registryPath);
    await fs.chmod(registryPath, 0o600).catch(() => undefined);
  }

  private withOAuthCallback(definition: ConnectionTypeDefinition): ConnectionTypeDefinition {
    if (!definition.oauth || !this.options.selfOAuthCallbackService) return definition;
    const state = this.options.selfOAuthCallbackService.getState();
    const callbackUrl = this.options.selfOAuthCallbackService.callbackUrl(definition.oauth.callbackPath);
    return {
      ...definition,
      oauth: {
        ...definition.oauth,
        ...(callbackUrl ? { callbackUrl } : {}),
        ...(state?.previousPort ? { previousCallbackUrl: `http://127.0.0.1:${state.previousPort}${definition.oauth.callbackPath}` } : {}),
        ...(state ? { callbackPortChanged: state.portChanged } : {}),
      },
    };
  }
}
