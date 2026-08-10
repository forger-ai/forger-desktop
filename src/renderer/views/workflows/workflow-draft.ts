import type {
  AgentToolId,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTrigger,
  WorkflowUpsertInput,
} from '@shared/types';

export interface WorkflowDraft {
  id?: string;
  name: string;
  description: string;
  trigger: WorkflowTrigger;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  enabled: boolean;
}

export const emptyDraft = (): WorkflowDraft => ({
  name: '',
  description: '',
  trigger: { type: 'manual' },
  nodes: [],
  edges: [],
  enabled: true,
});

export const draftFromWorkflow = (workflow: Workflow): WorkflowDraft => ({
  id: workflow.id,
  name: workflow.name,
  description: workflow.description ?? '',
  trigger: workflow.trigger,
  nodes: workflow.nodes.map((node) => ({ ...node })),
  edges: workflow.edges.map((edge) => ({ ...edge })),
  enabled: workflow.enabled,
});

export const draftToUpsertInput = (draft: WorkflowDraft): WorkflowUpsertInput => ({
  ...(draft.id ? { id: draft.id } : {}),
  name: draft.name,
  ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
  trigger: draft.trigger,
  nodes: draft.nodes,
  edges: draft.edges,
  enabled: draft.enabled,
});

export const nextNodeId = (nodes: WorkflowNode[], prefix: string): string => {
  let index = nodes.length + 1;
  while (nodes.some((node) => node.id === `${prefix}${index}`)) {
    index += 1;
  }
  return `${prefix}${index}`;
};

export const createDraftNode = (
  type: WorkflowNode['type'],
  nodes: WorkflowNode[],
  defaultName: string,
): WorkflowNode => {
  const id = nextNodeId(nodes, 'paso');
  const position = { x: 80 + (nodes.length % 4) * 260, y: 80 + Math.floor(nodes.length / 4) * 160 };
  const base = { id, name: `${defaultName} ${nodes.length + 1}`, position };
  if (type === 'llm_agent') {
    return { ...base, type: 'llm_agent', prompt: '', toolIds: [], appIds: [], connectionGrants: [] };
  }
  if (type === 'forger_agent') {
    return { ...base, type: 'forger_agent', agentId: '', prompt: '' };
  }
  if (type === 'app_action') {
    return { ...base, type: 'app_action', appId: '', toolName: '', input: {} };
  }
  if (type === 'forger_tool') {
    return { ...base, type: 'forger_tool', toolId: '' as AgentToolId, input: {} };
  }
  if (type === 'connection') {
    return { ...base, type: 'connection', connectionType: '', actionId: '', input: {} };
  }
  return { ...base, type: 'condition', expression: { left: '', operator: 'is_not_empty' } };
};

export const edgeKey = (edge: WorkflowEdge): string => `${edge.from}__${edge.to}`;
