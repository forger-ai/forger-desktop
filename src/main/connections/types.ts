import type {
  CallConnectionActionInput,
  CallConnectionActionResult,
  ConfigureConnectionInput,
  ConnectionInstance,
  ConnectionMutationResult,
  ConnectionStatusInput,
  ConnectionStatusResult,
  ConnectionTypeDefinition,
  DisconnectConnectionInput,
  SafeConnectionIdentity,
} from '../../shared/types/connections';
import type { OfficialToolRuntimeEvent, SecretMutationResult } from '../../shared/types';
import type { InternalOAuthTokenResponse } from '../tools/types';
import type { SelfOAuthCallbackServiceLike } from '../oauth-callback/types';

export interface ConnectionSecretsStore {
  setConnectionSecret(connectionId: string, secretName: string, value: string): Promise<SecretMutationResult>;
  getConnectionSecret(connectionId: string, secretName: string): Promise<string | null>;
  hasConnectionSecret(connectionId: string, secretName: string): Promise<boolean>;
  deleteConnectionSecrets(connectionId: string): Promise<SecretMutationResult>;
}

export interface CreateConnectionInstanceInput {
  type: string;
  label?: string;
  accountIdentity?: SafeConnectionIdentity;
  secrets?: Record<string, string>;
  status?: ConnectionInstance['status'];
}

export interface ConnectionContext {
  metadataRoot: string;
  secretsStore: ConnectionSecretsStore;
  locale?: string;
  getFreePort: () => Promise<number>;
  openExternalUrl: (url: string) => Promise<void>;
  isForgerAccountAuthenticated: () => boolean;
  getGmailOAuthClientId: () => Promise<string>;
  exchangeGmailOAuthCode: (input: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<InternalOAuthTokenResponse>;
  refreshGmailOAuthAccessToken: (input: {
    clientId: string;
    refreshToken: string;
  }) => Promise<InternalOAuthTokenResponse>;
  selfOAuthCallbackService?: SelfOAuthCallbackServiceLike;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  emitEvent?: (event: OfficialToolRuntimeEvent) => void;
  createInstance(input: CreateConnectionInstanceInput): Promise<ConnectionInstance>;
  updateInstance(connectionId: string, input: Partial<Pick<ConnectionInstance, 'label' | 'accountIdentity' | 'status' | 'lastCheckedAt'>>): Promise<ConnectionInstance | null>;
  deleteInstance(connectionId: string, options?: { keepSecrets?: boolean }): Promise<void>;
  listPersistedInstances(type?: string): Promise<ConnectionInstance[]>;
  setDefault(type: string, connectionId: string): Promise<void>;
  setSecret(connectionId: string, secretName: string, value: string): Promise<SecretMutationResult>;
  getSecret(connectionId: string, secretName: string): Promise<string | null>;
}

export interface InternalConnectionModule {
  definition: ConnectionTypeDefinition;
  listInstances(context: ConnectionContext): Promise<ConnectionInstance[]>;
  configure(context: ConnectionContext, input: ConfigureConnectionInput): Promise<ConnectionMutationResult>;
  disconnect(context: ConnectionContext, input: DisconnectConnectionInput): Promise<ConnectionMutationResult>;
  status(context: ConnectionContext, input: ConnectionStatusInput): Promise<ConnectionStatusResult>;
  execute(context: ConnectionContext, input: CallConnectionActionInput): Promise<CallConnectionActionResult>;
  start?(context: ConnectionContext): Promise<void>;
  stop?(context: ConnectionContext): Promise<void>;
}
