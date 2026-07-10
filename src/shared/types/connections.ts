import type { ConnectionSetupGuide } from './connection-setup-guide';

export type ConnectionSetupKind = 'oauth' | 'manual_secret' | 'qr_pairing' | 'local_device';

export type ConnectionStatus =
  | 'available'
  | 'connecting'
  | 'needs_setup'
  | 'needs_reconnect'
  | 'connected'
  | 'syncing'
  | 'error'
  | 'disabled';

export type ConnectionActionRisk = 'low' | 'medium' | 'high';

export interface SafeConnectionIdentity {
  subject?: string;
  email?: string;
  phoneNumber?: string;
  workspace?: string;
  username?: string;
}

export interface ConnectionActionDefinition {
  id: string;
  name: string;
  description: string;
  risk: ConnectionActionRisk;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface ConnectionSecretDefinition {
  name: string;
  label: string;
  required: boolean;
  usage: string;
  manual?: boolean;
}

export interface ConnectionOAuthDefinition {
  callbackPath: string;
  callbackUrl?: string;
  previousCallbackUrl?: string;
  callbackPortChanged?: boolean;
  scopes: string[];
  requiresProviderRedirectConfig?: boolean;
}

export interface ConnectionTypeDefinition {
  type: string;
  displayName: string;
  description: string;
  setupKind: ConnectionSetupKind;
  supportsMultiple: boolean;
  actions: ConnectionActionDefinition[];
  secretsSchema: ConnectionSecretDefinition[];
  statusActionId: string;
  version?: string;
  oauth?: ConnectionOAuthDefinition;
  setupGuide?: ConnectionSetupGuide;
}

export interface ConnectionInstance {
  id: string;
  type: string;
  label: string;
  accountIdentity?: SafeConnectionIdentity;
  status: ConnectionStatus;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
}

export interface ConnectionStatusResult {
  connected: boolean;
  status: ConnectionStatus;
  message?: string;
  technicalCode?: string;
  accountIdentity?: SafeConnectionIdentity;
  lastCheckedAt?: string;
  capabilities?: string[];
}

export interface ConfigureConnectionInput {
  type: string;
  label?: string;
  connectionId?: string;
  secrets?: Record<string, string>;
  [key: string]: unknown;
}

export interface DisconnectConnectionInput {
  type: string;
  connectionId: string;
  keepSecrets?: boolean;
}

export interface ConnectionStatusInput {
  type: string;
  connectionId?: string;
}

export interface CallConnectionActionInput {
  type: string;
  actionId: string;
  input?: Record<string, unknown>;
  connectionId?: string;
}

export interface CallConnectionActionResult {
  success: boolean;
  userMessage?: string;
  technicalCode?: string;
  data?: unknown;
}

export interface ConnectionMutationResult {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
  instance?: ConnectionInstance;
}

export interface AppConnectionDeclaration {
  type: string;
  actions: string[];
  reason: string;
  multiple: boolean;
}

export interface PersistedConnectionGrant {
  type: string;
  requestedActions: string[];
  resolvedActions: string[];
  multiple: boolean;
  granted: boolean;
  approvedAt?: string;
  actionCatalogHash?: string;
  connectionIds?: string[];
  reason?: string;
}

export interface ConnectionSessionGrant {
  type: string;
  connectionIds?: string[];
  actions: string[];
  multiple: boolean;
}

export interface ConnectionRequirementState {
  declaration: AppConnectionDeclaration;
  required: boolean;
  definition?: ConnectionTypeDefinition;
  resolvedActions: ConnectionActionDefinition[];
  allActions: boolean;
  granted: boolean;
  hasStoredGrant: boolean;
  configured: boolean;
  instances: ConnectionInstance[];
  reviewNeeded?: boolean;
}

export interface SetAppConnectionGrantInput {
  appId: string;
  type: string;
  granted: boolean;
  connectionIds?: string[];
}

export interface ConnectionsState {
  types: ConnectionTypeDefinition[];
  instances: ConnectionInstance[];
}
