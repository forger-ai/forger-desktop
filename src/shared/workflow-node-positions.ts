import type { WorkflowNodePosition } from './types';

interface ResolveWorkflowNodePositionInput {
  draftPosition?: WorkflowNodePosition;
  previousDraftPosition?: WorkflowNodePosition;
  hadPreviousDraftPosition: boolean;
  livePosition?: WorkflowNodePosition;
  fallbackPosition: WorkflowNodePosition;
}

export const workflowNodePositionsEqual = (
  first?: WorkflowNodePosition,
  second?: WorkflowNodePosition,
): boolean => first?.x === second?.x && first?.y === second?.y;

export const resolveWorkflowNodePosition = ({
  draftPosition,
  previousDraftPosition,
  hadPreviousDraftPosition,
  livePosition,
  fallbackPosition,
}: ResolveWorkflowNodePositionInput): WorkflowNodePosition => {
  const draftPositionChanged = hadPreviousDraftPosition
    ? !workflowNodePositionsEqual(draftPosition, previousDraftPosition)
    : Boolean(draftPosition);

  if (draftPositionChanged) {
    return draftPosition ?? fallbackPosition;
  }

  return livePosition ?? draftPosition ?? fallbackPosition;
};
