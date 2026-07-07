import type { AgentToolDefinition, ConnectionTypeDefinition } from '../../shared/types';

type ConnectionTypeLister = {
  listTypes: () => ConnectionTypeDefinition[] | Promise<ConnectionTypeDefinition[]>;
};

const isConnectionTypeLister = (value: unknown): value is ConnectionTypeLister => (
  Boolean(value && typeof value === 'object' && typeof (value as { listTypes?: unknown }).listTypes === 'function')
);

const toMcpRisk = (risk: ConnectionTypeDefinition['actions'][number]['risk']): AgentToolDefinition['risk'] => (
  risk === 'high' ? 'alto' : risk === 'medium' ? 'medio' : 'bajo'
);

export const connectionToolDefinitionsFromState = async (
  getConnectionsService: () => unknown,
): Promise<AgentToolDefinition[]> => {
  const service = getConnectionsService();
  if (!isConnectionTypeLister(service)) {
    return [];
  }
  const types = await service.listTypes();
  return types.flatMap((definition) => definition.actions.map((action) => ({
    id: action.id as AgentToolDefinition['id'],
    packageId: `connection:${definition.type}`,
    name: action.name,
    description: action.description,
    category: action.risk === 'low' ? 'consulta' : 'app',
    risk: toMcpRisk(action.risk),
    // Connection grants are explicit access decisions. Per-call approvals can
    // be layered later without making granted personal-agent actions unusable.
    defaultRequiresApproval: false,
  } satisfies AgentToolDefinition)));
};
