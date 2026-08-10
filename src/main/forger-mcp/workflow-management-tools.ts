import type {
  AgentToolId,
  Workflow,
  WorkflowApplyInput,
  WorkflowReviewReport,
  WorkflowRunSummary,
  WorkflowUpsertInput,
} from '../../shared/types';
import { getSharedCopy } from '../../shared/i18n';
import { cleanString, workflowMcpErrorMessage } from '../forger-mcp-server-helpers';
import { sanitizeWorkflowUpsertInput } from '../workflow/sanitize';

interface WorkflowManagementSession {
  caller: string;
  locale?: string;
}

export interface WorkflowManagementToolOptions {
  workflowsList?: () => Workflow[];
  workflowsGet?: (workflowId: string) => Workflow | null;
  workflowsUpsert?: (input: WorkflowUpsertInput) => Promise<Workflow>;
  workflowsReview?: (workflowId: string) => Promise<WorkflowReviewReport>;
  workflowsApply?: (workflowId: string, input: WorkflowApplyInput) => Promise<Workflow>;
  workflowsRun?: (workflowId: string) => Promise<WorkflowRunSummary>;
}

export async function executeWorkflowManagementTool(
  session: WorkflowManagementSession,
  toolId: AgentToolId,
  args: Record<string, unknown>,
  options: WorkflowManagementToolOptions,
): Promise<unknown> {
  if (session.caller === 'workflow' || session.caller === 'app-agent') {
    return {
      success: false,
      userMessage: getSharedCopy(session.locale).tools.unavailable,
      technicalCode: 'workflow_management_not_allowed',
    };
  }
  try {
    if (toolId === 'forger_workflow_list') {
      return { success: true, workflows: options.workflowsList?.() ?? [] };
    }
    if (toolId === 'forger_workflow_get') {
      const workflow = options.workflowsGet?.(cleanString(args.workflowId)) ?? null;
      return workflow
        ? { success: true, workflow }
        : { success: false, userMessage: 'No encontramos ese flujo.', technicalCode: 'workflow_not_found' };
    }
    if (toolId === 'forger_workflow_upsert') {
      if (!options.workflowsUpsert) {
        return { success: false, technicalCode: 'workflow_manager_unavailable' };
      }
      const workflow = await options.workflowsUpsert(
        sanitizeWorkflowUpsertInput(args, undefined, { rejectInvalidNodes: true }),
      );
      return { success: true, workflow };
    }
    if (toolId === 'forger_workflow_review') {
      if (!options.workflowsReview) {
        return { success: false, technicalCode: 'workflow_manager_unavailable' };
      }
      const review = await options.workflowsReview(cleanString(args.workflowId));
      return { success: true, review };
    }
    if (toolId === 'forger_workflow_apply') {
      if (!options.workflowsApply) {
        return { success: false, technicalCode: 'workflow_manager_unavailable' };
      }
      const definitionHash = cleanString(args.definitionHash);
      const expectedRevision = Number(args.expectedRevision);
      if (!definitionHash || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        return { success: false, technicalCode: 'workflow_apply_input_invalid' };
      }
      const workflow = await options.workflowsApply(cleanString(args.workflowId), {
        definitionHash,
        expectedRevision,
      });
      return { success: true, workflow };
    }
    if (!options.workflowsRun) {
      return { success: false, technicalCode: 'workflow_manager_unavailable' };
    }
    const run = await options.workflowsRun(cleanString(args.workflowId));
    return { success: true, run };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'workflow_operation_failed';
    return {
      success: false,
      userMessage: workflowMcpErrorMessage(code),
      technicalCode: code,
    };
  }
}
