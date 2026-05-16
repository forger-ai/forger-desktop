export interface AppSecretDeclaration {
  name: string;
  required: boolean;
  usage: string;
  label?: string;
}

export interface UserSecretSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppSecretConnection {
  appSecret: AppSecretDeclaration;
  envName: string;
  connected: boolean;
  userSecretId?: string;
  userSecretName?: string;
}

export interface AppSecretsState {
  appId: string;
  appName: string;
  appSecrets: AppSecretConnection[];
  userSecrets: UserSecretSummary[];
}

export interface SecretMutationResult {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
}

export interface CreateUserSecretInput {
  name: string;
  value: string;
}

export interface UpdateUserSecretInput {
  id: string;
  name: string;
  value?: string;
}

export interface DeleteUserSecretInput {
  id: string;
}

export interface ConnectAppSecretInput {
  appId: string;
  appSecretName: string;
  userSecretId: string;
}

export interface DisconnectAppSecretInput {
  appId: string;
  appSecretName: string;
}
