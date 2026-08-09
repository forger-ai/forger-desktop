import type { Workflow, WorkflowUpsertInput } from '../../shared/types';
import { validateWorkflowGraph } from './engine';
import { sanitizeWorkflowUpsertInput } from './sanitize';

export const isValidLegacyWorkflow = (input: unknown): input is Workflow => {
  if (!input || typeof input !== 'object') return false;
  const record = input as Partial<Workflow>;
  if (typeof record.id !== 'string' || !record.id.trim()) return false;

  try {
    const sanitized = sanitizeWorkflowUpsertInput(record as WorkflowUpsertInput);
    if (!sanitized.name) return false;
    validateWorkflowGraph(sanitized.nodes, sanitized.edges);
    return true;
  } catch {
    return false;
  }
};

export const hasValidLegacyWorkflows = (input: unknown): boolean =>
  Array.isArray(input) && input.some(isValidLegacyWorkflow);
