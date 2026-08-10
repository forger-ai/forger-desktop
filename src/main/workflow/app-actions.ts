import type {
  Workflow,
  WorkflowAppActionCallInput,
  WorkflowAppActionCallResult,
  WorkflowAppActionDefinition,
  WorkflowAppActionNode,
  WorkflowAppActionSelection,
} from '../../shared/types';
import { resolveTemplateValue, type WorkflowNodeState, type WorkflowRunContext } from './engine';
import { validateOutputAgainstSchema } from './output-schema';

export type PrepareWorkflowAppActions = (
  selections: WorkflowAppActionSelection[],
  runId: string,
  signal?: AbortSignal,
) => Promise<WorkflowAppActionDefinition[]>;

export type CallWorkflowAppAction = (
  input: WorkflowAppActionCallInput,
) => Promise<WorkflowAppActionCallResult>;

export const workflowAppActionKey = (appId: string, toolName: string): string =>
  `${appId}\u0000${toolName}`;

export const prepareWorkflowAppActions = async ({
  workflow,
  runId,
  signal,
  prepare,
  call,
  release,
}: {
  workflow: Workflow;
  runId: string;
  signal: AbortSignal;
  prepare?: PrepareWorkflowAppActions;
  call?: CallWorkflowAppAction;
  release?: (runId: string) => void | Promise<void>;
}): Promise<Map<string, WorkflowAppActionDefinition>> => {
  const selections: WorkflowAppActionSelection[] = [];
  const seen = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.type !== 'app_action') continue;
    if (!node.contract) throw new Error('workflow_app_action_contract_required');
    const key = workflowAppActionKey(node.appId, node.toolName);
    if (!seen.has(key)) {
      seen.add(key);
      selections.push({ appId: node.appId, toolName: node.toolName });
    }
  }
  if (selections.length === 0) return new Map();
  if (!prepare || !call || !release) throw new Error('workflow_app_actions_unavailable');

  const definitions = await prepare(selections, runId, signal);
  if (signal.aborted) throw new Error('workflow_app_action_canceled');
  const discovered = new Map<string, WorkflowAppActionDefinition>();
  for (const definition of definitions) {
    const key = workflowAppActionKey(definition.appId, definition.toolName);
    if (discovered.has(key)) throw new Error('workflow_app_action_list_failed');
    discovered.set(key, definition);
  }
  for (const selection of selections) {
    const key = workflowAppActionKey(selection.appId, selection.toolName);
    const definition = discovered.get(key);
    if (!definition) throw new Error('workflow_app_action_tool_not_found');
    if (!isRecord(definition.inputSchema)) throw new Error('workflow_app_action_list_failed');
    if (!isRecord(definition.outputSchema) || definition.outputSchema.type !== 'object') {
      throw new Error('workflow_app_action_output_schema_required');
    }
    for (const node of workflow.nodes) {
      if (node.type === 'app_action'
        && node.appId === selection.appId
        && node.toolName === selection.toolName
        && node.contract
        && !contractMatchesDefinition(node.contract, definition)) {
        throw new Error('workflow_app_action_contract_changed');
      }
    }
  }
  return discovered;
};

export const appActionRequiresMandatoryApproval = (
  node: WorkflowAppActionNode,
  definitions: ReadonlyMap<string, WorkflowAppActionDefinition>,
): boolean => {
  const effect = definitions.get(workflowAppActionKey(node.appId, node.toolName))?.effect;
  return effect === 'destructive' || effect === 'external' || effect === 'unknown';
};

export const executeWorkflowAppAction = async ({
  node,
  context,
  runId,
  signal,
  definitions,
  call,
  defaultTimeoutMs,
}: {
  node: WorkflowAppActionNode;
  context: WorkflowRunContext;
  runId: string;
  signal: AbortSignal;
  definitions: ReadonlyMap<string, WorkflowAppActionDefinition>;
  call?: CallWorkflowAppAction;
  defaultTimeoutMs: number;
}): Promise<WorkflowNodeState> => {
  if (!call) return { status: 'failed', error: 'workflow_app_actions_unavailable' };
  const definition = definitions.get(workflowAppActionKey(node.appId, node.toolName));
  if (!definition) return { status: 'failed', error: 'workflow_app_action_not_prepared' };
  const input = resolveTemplateValue(node.input, context);
  const nodeRunInput = {
    appId: node.appId,
    appName: definition.appName,
    toolName: node.toolName,
    actionTitle: definition.title,
    effect: definition.effect,
    input: isRecord(input) ? input : {},
  };
  if (!isRecord(input) || validateOutputAgainstSchema(input, definition.inputSchema, 'input').length > 0) {
    return { status: 'failed', input: nodeRunInput, error: 'workflow_app_action_input_invalid' };
  }
  try {
    const result = await call({
      runId,
      appId: node.appId,
      toolName: node.toolName,
      input,
      timeoutMs: node.timeoutMs ?? defaultTimeoutMs,
      signal,
    });
    if (result.isError) return { status: 'failed', input: nodeRunInput, error: 'workflow_app_action_tool_error' };
    const output = result.structuredContent;
    if (!isRecord(output) || validateOutputAgainstSchema(output, definition.outputSchema).length > 0) {
      return { status: 'failed', input: nodeRunInput, error: 'workflow_app_action_output_invalid' };
    }
    return { status: 'succeeded', input: nodeRunInput, output, summary: definition.title };
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith('workflow_app_action_')
      ? error.message
      : 'workflow_app_action_call_failed';
    return { status: 'failed', input: nodeRunInput, error: message };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const contractMatchesDefinition = (
  contract: NonNullable<WorkflowAppActionNode['contract']>,
  definition: WorkflowAppActionDefinition,
): boolean => contract.effect === definition.effect
  && canonicalJson(contract.inputSchema) === canonicalJson(definition.inputSchema)
  && canonicalJson(contract.outputSchema) === canonicalJson(definition.outputSchema);
