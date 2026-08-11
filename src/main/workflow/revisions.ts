import { createHash, randomUUID } from 'node:crypto';
import type {
  Workflow,
  WorkflowAppAction,
  WorkflowAppActionDefinition,
  WorkflowReviewReport,
  WorkflowRevision,
} from '../../shared/types';

export const stableWorkflowValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableWorkflowValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableWorkflowValue(nested)]),
  );
};

export const canonicalWorkflowHash = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(stableWorkflowValue(value)))
  .digest('hex');

export const workflowAppActionContractValue = (
  toolName: string,
  action: WorkflowAppAction | WorkflowAppActionDefinition,
): Omit<WorkflowAppActionDefinition, 'contractHash'> => ({
  toolName,
  title: action.title,
  ...(action.description ? { description: action.description } : {}),
  inputSchema: action.inputSchema,
  outputSchema: action.outputSchema,
  effect: action.effect,
  risk: action.risk,
  idempotent: action.idempotent,
});

export const workflowAppActionContractHash = (
  toolName: string,
  action: WorkflowAppAction | WorkflowAppActionDefinition,
): string => canonicalWorkflowHash(workflowAppActionContractValue(toolName, action));

export const assertAuthenticWorkflowAppAction = (
  toolName: string,
  action: WorkflowAppAction | WorkflowAppActionDefinition,
): void => {
  if (workflowAppActionContractHash(toolName, action) !== action.contractHash) {
    throw new Error('workflow_app_action_contract_hash_invalid');
  }
};

const definitionOf = (workflow: Pick<Workflow, 'name' | 'description' | 'trigger' | 'nodes' | 'edges'>) => ({
  name: workflow.name,
  ...(workflow.description ? { description: workflow.description } : {}),
  trigger: workflow.trigger,
  nodes: workflow.nodes,
  edges: workflow.edges,
});

export const workflowDefinitionHash = (
  workflow: Pick<Workflow, 'name' | 'description' | 'trigger' | 'nodes' | 'edges'>,
): string => canonicalWorkflowHash(definitionOf(workflow));

const cloneWorkflow = (workflow: Workflow): Workflow => JSON.parse(JSON.stringify(workflow)) as Workflow;

export const createWorkflowRevision = (
  workflow: Workflow,
  options: { id?: string; applied?: boolean; appliedAt?: string } = {},
): WorkflowRevision => ({
  id: options.id ?? workflow.revisionId ?? randomUUID(),
  workflowId: workflow.id,
  revision: workflow.revision,
  definitionHash: workflowDefinitionHash(workflow),
  createdAt: workflow.updatedAt,
  applied: options.applied === true,
  ...(options.appliedAt ? { appliedAt: options.appliedAt } : {}),
  workflow: cloneWorkflow({ ...workflow, review: undefined }),
});

/** Review deliberately performs no discovery, execution, provider lookup, or preflight. */
export const reviewWorkflowDefinition = (workflow: Workflow): WorkflowReviewReport => {
  const issues: string[] = [];
  return {
    status: issues.length === 0 ? 'ready' : 'blocked',
    issues,
    definitionHash: workflowDefinitionHash(workflow),
  };
};

export const workflowForExecution = (current: Workflow, revision: WorkflowRevision): Workflow => ({
  ...cloneWorkflow(revision.workflow),
  enabled: current.enabled,
  running: current.running,
  nextRunAt: current.nextRunAt,
  updatedAt: current.updatedAt,
  ...(current.lastRun ? { lastRun: current.lastRun } : {}),
  revision: revision.revision,
  revisionId: revision.id,
  appliedRevision: revision.revision,
  appliedRevisionId: revision.id,
  appliedTrigger: revision.workflow.trigger,
  review: undefined,
});
