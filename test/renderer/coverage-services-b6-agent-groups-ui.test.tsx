import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PersonalAgent, PersonalAgentGroup } from '@shared/types';
import { en } from '@renderer/i18n/en';
import { defaultAccessDraft, type AccessDraft } from '@renderer/views/AgentsView.helpers';

import {
  AgentCreateDialog,
  AgentGroupSelect,
  AgentGroupsDialog,
  AgentIdentityChips,
  AgentsOverview,
} from '@renderer/views/AgentGroupsUi';

const group = (id: string, name: string): PersonalAgentGroup => ({
  id,
  name,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
});

const agent = (id: string, name: string, overrides: Partial<PersonalAgent> = {}): PersonalAgent => ({
  id,
  name,
  description: '',
  purpose: '',
  instructions: '',
  permissionMode: 'safe',
  networkAccess: false,
  canSpawnAgents: false,
  appIds: [],
  toolIds: [],
  connectionGrants: [],
  peerAgentGrants: [],
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  ...overrides,
});

function GroupSelectHarness({ groups, initialDraft = defaultAccessDraft() }: { groups: PersonalAgentGroup[]; initialDraft?: AccessDraft }) {
  const [draft, setDraft] = useState(initialDraft);
  return (
    <>
      <AgentGroupSelect draft={draft} groups={groups} id="group-select" setDraft={setDraft} t={en} />
      <output data-testid="selected-group">{draft.groupId ?? 'none'}</output>
    </>
  );
}

describe('AgentGroupsUi', () => {
  it('selects and clears an optional group through the controlled draft', async () => {
    const groups = [group('research', 'Research'), group('support', 'Support')];
    render(<GroupSelectHarness groups={groups} />);

    await userEvent.click(screen.getByRole('combobox', { name: en.agents.group }));
    await userEvent.click(screen.getByRole('option', { name: 'Research' }));
    expect(screen.getByTestId('selected-group')).toHaveTextContent('research');

    await userEvent.click(screen.getByRole('combobox', { name: en.agents.group }));
    await userEvent.click(screen.getByRole('option', { name: en.agents.noGroup }));
    expect(screen.getByTestId('selected-group')).toHaveTextContent('none');
  });

  it('shows group and creator identity with safe fallbacks', () => {
    const groups = [group('research', 'Research')];
    const creator = agent('creator', 'Ada');
    const view = render(
      <AgentIdentityChips
        agent={agent('worker', 'Worker', { groupId: 'research', createdByAgentId: 'creator' })}
        agents={[creator]}
        groups={groups}
        t={en}
      />,
    );
    expect(screen.getByText('Research')).toBeVisible();
    expect(screen.getByText(en.agents.createdBy('Ada'))).toBeVisible();

    view.rerender(
      <AgentIdentityChips
        agent={agent('worker', 'Worker', { groupId: 'missing', createdByAgentId: 'missing-creator' })}
        agents={[]}
        groups={groups}
        t={en}
      />,
    );
    expect(screen.getByText(en.agents.noGroup)).toBeVisible();
    expect(screen.getByText(en.agents.createdBy('missing-creator'))).toBeVisible();

    view.rerender(<AgentIdentityChips agent={agent('worker', 'Worker')} agents={[]} groups={groups} t={en} />);
    expect(view.container.firstElementChild).toBeEmptyDOMElement();
  });

  it('edits every create field, group, and action while enforcing name and busy requirements', async () => {
    const callbacks = {
      onClose: vi.fn(),
      onCreate: vi.fn(),
      onDescriptionChange: vi.fn(),
      onNameChange: vi.fn(),
      onPurposeChange: vi.fn(),
      setDraft: vi.fn(),
    };
    const baseProps = {
      accessControls: <div>Access controls</div>,
      description: 'Description',
      draft: defaultAccessDraft(),
      groups: [group('research', 'Research')],
      name: '   ',
      open: true,
      purpose: 'Purpose',
      t: en,
      ...callbacks,
    };
    const view = render(<AgentCreateDialog {...baseProps} busy={false} />);

    expect(screen.getByText('Access controls')).toBeVisible();
    expect(screen.getByRole('button', { name: en.agents.create })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: en.agents.name }), 'A');
    await userEvent.type(screen.getByRole('textbox', { name: en.agents.description }), '!');
    await userEvent.type(screen.getByRole('textbox', { name: en.agents.purpose }), '!');
    expect(callbacks.onNameChange).toHaveBeenCalled();
    expect(callbacks.onDescriptionChange).toHaveBeenCalled();
    expect(callbacks.onPurposeChange).toHaveBeenCalled();

    await userEvent.click(screen.getByRole('combobox', { name: en.agents.group }));
    await userEvent.click(screen.getByRole('option', { name: 'Research' }));
    expect(callbacks.setDraft).toHaveBeenCalled();

    view.rerender(<AgentCreateDialog {...baseProps} name="Builder" busy />);
    expect(screen.getByRole('button', { name: en.agents.create })).toBeDisabled();
    view.rerender(<AgentCreateDialog {...baseProps} name="Builder" busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: en.agents.create }));
    await userEvent.click(screen.getByRole('button', { name: en.actions.close }));
    expect(callbacks.onCreate).toHaveBeenCalledOnce();
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('renders the empty overview, error, and header actions', async () => {
    const onCreate = vi.fn();
    const onManageGroups = vi.fn();
    render(
      <AgentsOverview
        agents={[]}
        busy={false}
        createdByLabel={() => null}
        error="Agents unavailable"
        manageGroupsLabel="Manage groups"
        onCreate={onCreate}
        onDelete={vi.fn()}
        onManageGroups={onManageGroups}
        onOpen={vi.fn()}
        renderAccessChips={() => null}
        sections={[]}
        t={en}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Agents unavailable');
    expect(screen.getByText(en.agents.empty)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Manage groups' }));
    await userEvent.click(screen.getByRole('button', { name: en.agents.create }));
    expect(onManageGroups).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('opens agent cards, keeps delete isolated, and renders descriptions and access', async () => {
    const builder = agent('builder', 'Builder', { description: 'Builds reports' });
    const reviewer = agent('reviewer', 'Reviewer');
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const props = {
      agents: [builder, reviewer],
      busy: false,
      createdByLabel: (value: PersonalAgent) => value.id === 'builder' ? 'Created by Ada' : null,
      error: null,
      manageGroupsLabel: 'Manage groups',
      onCreate: vi.fn(),
      onDelete,
      onManageGroups: vi.fn(),
      onOpen,
      renderAccessChips: (value: PersonalAgent) => <span>{`Access ${value.name}`}</span>,
      sections: [{ id: 'research', label: 'Research', agents: [builder, reviewer] }],
      t: en,
    };
    const view = render(<AgentsOverview {...props} />);

    expect(consoleError).not.toHaveBeenCalled();
    expect(screen.getByText('Builds reports')).toBeVisible();
    expect(screen.getByText(en.agents.noDescription)).toBeVisible();
    expect(screen.getByText('Created by Ada')).toBeVisible();
    expect(screen.getByText('Access Reviewer')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Builder Builds reports/ }));
    expect(onOpen).toHaveBeenCalledWith(builder);

    const deleteButtons = screen.getAllByRole('button', { name: en.agents.delete });
    await userEvent.click(deleteButtons[0]);
    expect(onDelete).toHaveBeenCalledWith(builder);
    expect(onOpen).toHaveBeenCalledTimes(1);

    view.rerender(<AgentsOverview {...props} busy />);
    expect(screen.getAllByRole('button', { name: en.agents.delete })[0]).toBeDisabled();
  });

  it('creates, renames, counts, edits, deletes, and closes groups', async () => {
    const groups = [group('research', 'Research'), group('support', 'Support')];
    const agents = [
      agent('one', 'One', { groupId: 'research' }),
      agent('two', 'Two', { groupId: 'support' }),
      agent('three', 'Three', { groupId: 'support' }),
      agent('free', 'Free'),
    ];
    const callbacks = {
      onClose: vi.fn(),
      onDelete: vi.fn(),
      onEdit: vi.fn(),
      onGroupNameChange: vi.fn(),
      onSave: vi.fn(),
    };
    const baseProps = { agents, groups, open: true, t: en, error: 'Group warning', ...callbacks };
    const view = render(
      <AgentGroupsDialog {...baseProps} busy={false} editingGroupId={null} groupName="" />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Group warning');
    expect(screen.getByText(en.agents.agentsCount(1))).toBeVisible();
    expect(screen.getByText(en.agents.agentsCount(2))).toBeVisible();
    expect(screen.getByRole('button', { name: en.agents.createGroup })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: en.agents.groupName }), 'New group');
    expect(callbacks.onGroupNameChange).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: en.agents.groupName }), { key: 'Escape' });
    expect(callbacks.onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: en.agents.groupName }), { key: 'Enter' });
    expect(callbacks.onSave).toHaveBeenCalledOnce();

    view.rerender(
      <AgentGroupsDialog {...baseProps} error={null} busy={false} editingGroupId="research" groupName="Renamed" />,
    );
    await userEvent.click(screen.getByRole('button', { name: en.agents.saveGroup }));
    await userEvent.click(screen.getAllByRole('button', { name: en.agents.renameGroup })[0]);
    await userEvent.click(screen.getAllByRole('button', { name: en.agents.deleteGroup })[0]);
    expect(callbacks.onSave).toHaveBeenCalledTimes(2);
    expect(callbacks.onEdit).toHaveBeenCalledWith(groups[0]);
    expect(callbacks.onDelete).toHaveBeenCalledWith(groups[0]);
    await userEvent.click(screen.getByRole('button', { name: en.actions.close }));
    expect(callbacks.onClose).toHaveBeenCalledTimes(2);

    view.rerender(
      <AgentGroupsDialog {...baseProps} error={null} groups={[]} busy editingGroupId={null} groupName="Busy" />,
    );
    expect(screen.getByText(en.agents.groupsEmpty)).toBeVisible();
    expect(screen.getByRole('button', { name: en.agents.createGroup })).toBeDisabled();
  });
});
