import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  ConfigureOfficialToolInput,
  OfficialToolDefinition,
  OfficialToolRisk,
  ToolMutationResult,
} from '../../../shared/types';
import type { InternalToolContext, InternalToolModule } from '../../tools/types';

/**
 * Local token connector schema.
 *
 * A token connector is an official tool whose credentials are plain tokens
 * provided by the user and stored in the local secrets store. There is no
 * cloud OAuth involved: the user pastes the token once, Forger validates it
 * against the service API and keeps it encrypted locally. New connectors
 * (Notion, Linear, GitHub, ...) only need a TokenConnectorDefinition.
 */

export interface TokenConnectorSecretDefinition {
  name: string;
  label: string;
  required: boolean;
  usage: string;
}

export interface TokenConnectorActionArgs {
  input: Record<string, unknown>;
  secrets: Record<string, string>;
  context: InternalToolContext;
}

export interface TokenConnectorActionDefinition {
  id: string;
  name: string;
  description: string;
  risk: OfficialToolRisk;
  /** Declared action input, used by workflow forms. */
  inputSchema?: Record<string, unknown>;
  /** Declared shape of the action result, used for workflow data mapping. */
  outputSchema?: Record<string, unknown>;
  run: (args: TokenConnectorActionArgs) => Promise<CallOfficialToolResult>;
}

export interface TokenConnectorValidationResult {
  ok: boolean;
  userMessage?: string;
  technicalCode?: string;
  data?: Record<string, unknown>;
}

export interface TokenConnectorDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  secrets: TokenConnectorSecretDefinition[];
  /** Id of the read-only action that reports connection state. */
  connectionStatusActionId: string;
  actions: TokenConnectorActionDefinition[];
  /** Validates stored secrets against the remote service. */
  validate: (secrets: Record<string, string>, context: InternalToolContext) => Promise<TokenConnectorValidationResult>;
  changelog?: string[];
  copy?: {
    secretsMissing?: string;
    connected?: string;
    connectFailed?: string;
    actionUnknown?: string;
  };
}

const readStoredSecrets = async (
  definition: TokenConnectorDefinition,
  context: InternalToolContext,
): Promise<{ secrets: Record<string, string>; missingRequired: string[] }> => {
  const secrets: Record<string, string> = {};
  const missingRequired: string[] = [];
  for (const secret of definition.secrets) {
    const value = await context.secretsStore.getToolSecret(definition.id, secret.name);
    if (value) {
      secrets[secret.name] = value;
    } else if (secret.required) {
      missingRequired.push(secret.name);
    }
  }
  return { secrets, missingRequired };
};

export const createTokenConnectorModule = (definition: TokenConnectorDefinition): InternalToolModule => {
  const toolDefinition: OfficialToolDefinition = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    runtime: 'builtin',
    official: true,
    secrets: definition.secrets.map((secret) => ({ ...secret, manual: true })),
    actions: definition.actions.map((action) => ({
      id: action.id,
      name: action.name,
      description: action.description,
      risk: action.risk,
      ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
      ...(action.outputSchema ? { outputSchema: action.outputSchema } : {}),
    })),
    ...(definition.changelog ? { changelog: definition.changelog } : {}),
  };

  const secretsMissingMessage = definition.copy?.secretsMissing
    ?? `Completa las credenciales de ${definition.name} para conectar la herramienta.`;

  const configure = async (
    context: InternalToolContext,
    input?: ConfigureOfficialToolInput,
  ): Promise<ToolMutationResult> => {
    const provided = input?.secrets ?? {};
    for (const secret of definition.secrets) {
      const value = typeof provided[secret.name] === 'string' ? provided[secret.name].trim() : '';
      if (value) {
        const stored = await context.secretsStore.setToolSecret(definition.id, secret.name, value);
        if (!stored.success) {
          return stored;
        }
      }
    }
    const { secrets, missingRequired } = await readStoredSecrets(definition, context);
    if (missingRequired.length > 0) {
      return {
        success: false,
        userMessage: secretsMissingMessage,
        technicalCode: 'connector_secrets_required',
      };
    }
    const validation = await definition.validate(secrets, context);
    if (!validation.ok) {
      return {
        success: false,
        userMessage: validation.userMessage
          ?? definition.copy?.connectFailed
          ?? `No pudimos validar la conexion con ${definition.name}. Revisa las credenciales.`,
        technicalCode: validation.technicalCode ?? 'connector_validation_failed',
      };
    }
    return {
      success: true,
      userMessage: definition.copy?.connected ?? `${definition.name} quedo conectado.`,
    };
  };

  const isConfigured = async (context: InternalToolContext): Promise<boolean> => {
    const { missingRequired } = await readStoredSecrets(definition, context);
    return missingRequired.length === 0;
  };

  const execute = async (
    input: CallOfficialToolInput,
    context: InternalToolContext,
  ): Promise<CallOfficialToolResult> => {
    const { secrets, missingRequired } = await readStoredSecrets(definition, context);

    if (input.actionId === definition.connectionStatusActionId) {
      if (missingRequired.length > 0) {
        return { success: true, data: { connected: false } };
      }
      const validation = await definition.validate(secrets, context);
      return {
        success: true,
        data: {
          connected: validation.ok,
          ...(validation.data ?? {}),
          ...(validation.ok ? {} : { technicalCode: validation.technicalCode }),
        },
      };
    }

    if (missingRequired.length > 0) {
      return {
        success: false,
        userMessage: secretsMissingMessage,
        technicalCode: 'connector_secrets_required',
      };
    }

    const action = definition.actions.find((entry) => entry.id === input.actionId);
    if (!action) {
      return {
        success: false,
        userMessage: definition.copy?.actionUnknown ?? `La accion de ${definition.name} no esta disponible.`,
        technicalCode: 'connector_action_unknown',
      };
    }
    const actionInput = input.input && typeof input.input === 'object' && !Array.isArray(input.input)
      ? input.input
      : {};
    try {
      return await action.run({ input: actionInput, secrets, context });
    } catch (error) {
      return {
        success: false,
        userMessage: `No pudimos completar la accion de ${definition.name}.`,
        technicalCode: error instanceof Error ? error.message : 'connector_action_failed',
      };
    }
  };

  return {
    definition: toolDefinition,
    configure,
    execute,
    isConfigured,
  };
};

export class ConnectorApiError extends Error {
  public constructor(public readonly technicalCode: string, message?: string) {
    super(message ?? technicalCode);
    this.name = 'ConnectorApiError';
  }
}
