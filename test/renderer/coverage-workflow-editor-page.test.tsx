import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDictionary } from '@renderer/i18n';
import { emptyDraft } from '@renderer/views/workflows/workflow-draft';
import { WorkflowEditorPage, type WorkflowGraphData } from '@renderer/views/workflows/WorkflowEditorPage';

const childSpies = vi.hoisted(() => ({
  editor: vi.fn(),
  params: vi.fn(),
}));

vi.mock('@renderer/views/workflows/WorkflowEditor', () => ({
  WorkflowEditor: (props: Record<string, unknown>) => {
    childSpies.editor(props);
    return <div>Workflow graph</div>;
  },
}));

vi.mock('@renderer/views/workflows/WorkflowParamsForm', () => ({
  WorkflowParamsForm: (props: Record<string, unknown>) => {
    childSpies.params(props);
    return <div>Workflow parameters</div>;
  },
}));

const t = getDictionary('en');
const data: WorkflowGraphData = {
  apps: [],
  agents: [],
  toolPackages: [],
  officialTools: [],
  connectionOptions: [],
  providerOptions: [],
  outputSamples: { prior: { value: 1 } },
  savedNodeIds: new Set(['saved-node']),
};

beforeEach(() => {
  childSpies.editor.mockClear();
  childSpies.params.mockClear();
});

describe('WorkflowEditorPage', () => {
  it('wires workflow data and primary navigation without a banner', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onSave = vi.fn();
    const onDraftChange = vi.fn();
    const draft = emptyDraft();
    render(
      <WorkflowEditorPage
        t={t}
        draft={draft}
        onDraftChange={onDraftChange}
        data={data}
        busy={false}
        banner={null}
        onClearBanner={vi.fn()}
        onSave={onSave}
        onBack={onBack}
      />,
    );

    expect(screen.getByText('Workflow parameters')).toBeVisible();
    expect(screen.getByText('Workflow graph')).toBeVisible();
    expect(childSpies.params).toHaveBeenCalledWith(expect.objectContaining({ draft, onChange: onDraftChange, t }));
    expect(childSpies.editor).toHaveBeenCalledWith(expect.objectContaining({
      draft,
      onDraftChange,
      apps: data.apps,
      agents: data.agents,
      toolPackages: data.toolPackages,
      officialTools: data.officialTools,
      connectionOptions: data.connectionOptions,
      providerOptions: data.providerOptions,
      outputSamples: data.outputSamples,
      savedNodeIds: data.savedNodeIds,
      t,
    }));

    await user.click(screen.getByRole('button', { name: t.sections.workflows.back }));
    await user.click(screen.getByRole('button', { name: t.sections.workflows.save }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('shows a dismissible banner and locks save while busy', async () => {
    const user = userEvent.setup();
    const onClearBanner = vi.fn();
    render(
      <WorkflowEditorPage
        t={t}
        draft={emptyDraft()}
        onDraftChange={vi.fn()}
        data={data}
        busy
        banner={{ severity: 'error', message: 'Could not save this workflow.' }}
        onClearBanner={onClearBanner}
        onSave={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Could not save this workflow.');
    expect(screen.getByRole('button', { name: t.sections.workflows.save })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(onClearBanner).toHaveBeenCalledOnce();
  });
});
