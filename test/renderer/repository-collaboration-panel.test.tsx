import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppProjectsPanel } from '@renderer/views/connections/WhatsAppProjectsPanel';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';

const group = {
  id: 'g1',
  connectionId: 'wa1',
  chatId: 'team@g.us',
  title: 'Product team',
  enabled: false,
  activatedAt: null,
};
const repo = { id: 'r1', groupId: 'g1', name: 'Backend' };
const participant = { participantId: 'alice@lid', displayName: 'Alice' };
const empty = () => ({
  groups: [],
  repositories: [],
  participants: [],
  grants: [],
  tasks: [],
  outbox: [],
});
let state: Record<string, unknown[]>;
let api: Record<string, ReturnType<typeof vi.fn>>;
const props = { connectionId: 'wa1', t: en as unknown as AppDictionary };

beforeEach(() => {
  state = empty();
  api = {
    repositoryCollaborationSnapshot: vi.fn(async () => state),
    repositoryCollaborationListGroups: vi.fn(async () => [
      { chatId: group.chatId, title: group.title },
    ]),
    repositoryCollaborationListParticipants: vi.fn(async () => [participant]),
    repositoryCollaborationConfigureGroup: vi.fn(async (input) => {
      state.groups = [{ ...group, ...input }];
      return state.groups[0];
    }),
    repositoryCollaborationAddRepository: vi.fn(async () => null),
    repositoryCollaborationRemoveRepository: vi.fn(async () => undefined),
    repositoryCollaborationSetAccess: vi.fn(async () => undefined),
    repositoryCollaborationCancelTask: vi.fn(async () => undefined),
    repositoryCollaborationRetryTask: vi.fn(async () => undefined),
  };
  Object.defineProperty(window, 'forger', {
    value: api,
    configurable: true,
    writable: true,
  });
});

describe('shared WhatsApp projects', () => {
  it('saves a selected group paused, then uses a native folder choice without accepting a path', async () => {
    render(<WhatsAppProjectsPanel {...props} />);
    fireEvent.change(await screen.findByLabelText('WhatsApp group'), {
      target: { value: group.chatId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }));
    await waitFor(() =>
      expect(api.repositoryCollaborationConfigureGroup).toHaveBeenCalledWith({
        connectionId: 'wa1',
        chatId: group.chatId,
        title: group.title,
        enabled: false,
      }),
    );
    fireEvent.change(await screen.findByLabelText('Repository alias'), {
      target: { value: 'Backend' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose folder and add' }),
    );
    await waitFor(() =>
      expect(api.repositoryCollaborationAddRepository).toHaveBeenCalledWith({
        groupId: 'g1',
        name: 'Backend',
      }),
    );
    expect(screen.getByRole('button', { name: 'Activate' })).toBeDisabled();
    expect(screen.getByText('No repositories shared yet.')).toBeInTheDocument();
  });

  it('keeps a new participant without access until an explicit per-repository grant is saved', async () => {
    state = { ...empty(), groups: [group], repositories: [repo] };
    render(<WhatsAppProjectsPanel {...props} />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Backend' });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText('alice@lid')).toBeInTheDocument();
    fireEvent.click(checkbox);
    fireEvent.click(
      screen.getByRole('button', { name: 'Save access for Alice' }),
    );
    await waitFor(() =>
      expect(api.repositoryCollaborationSetAccess).toHaveBeenCalledWith({
        groupId: 'g1',
        participantId: 'alice@lid',
        displayName: 'Alice',
        repositoryIds: ['r1'],
      }),
    );
  });

  it('shows task author and all repositories, with only valid cancel/retry actions', async () => {
    const task = {
      id: 'T1',
      groupId: 'g1',
      repositoryIds: ['r1', 'r2'],
      participantId: participant.participantId,
      participantName: 'Alice',
      prompt: 'Add export',
      status: 'running',
      result: null,
      createdAt: 1,
      updatedAt: 1,
      sourceMessageId: 'm1',
      parentTaskId: null,
      conversationId: null,
    };
    state = {
      ...empty(),
      groups: [group],
      repositories: [repo, { ...repo, id: 'r2', name: 'Desktop' }],
      tasks: [
        task,
        { ...task, id: 'T2', status: 'failed', result: 'Needs adjustment' },
      ],
    };
    render(<WhatsAppProjectsPanel {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel T1' }));
    await waitFor(() =>
      expect(api.repositoryCollaborationCancelTask).toHaveBeenCalledWith({
        taskId: 'T1',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry T2' }));
    await waitFor(() =>
      expect(api.repositoryCollaborationRetryTask).toHaveBeenCalledWith({
        taskId: 'T2',
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Retry T1' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel T2' }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(/Backend · Desktop/).length).toBe(2);
  });

  it('distinguishes loading and failure from an empty list and allows a retry', async () => {
    api.repositoryCollaborationSnapshot.mockRejectedValueOnce(
      new Error('offline'),
    );
    render(<WhatsAppProjectsPanel {...props} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(
      await screen.findByText('Could not load shared projects. Try again.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByLabelText('WhatsApp group')).toBeInTheDocument();
  });

  it('preserves local configuration offline so access can be revoked and the group paused', async () => {
    state = {
      ...empty(),
      groups: [{ ...group, enabled: true }],
      repositories: [repo],
      participants: [{ ...participant, groupId: 'g1' }],
      grants: [
        {
          groupId: 'g1',
          participantId: participant.participantId,
          repositoryId: 'r1',
        },
      ],
    };
    api.repositoryCollaborationListGroups.mockRejectedValue(
      new Error('offline'),
    );
    api.repositoryCollaborationListParticipants.mockRejectedValue(
      new Error('offline'),
    );
    render(<WhatsAppProjectsPanel {...props} />);
    const revoke = await screen.findByRole('button', {
      name: 'Remove access for Alice',
    });
    expect(revoke).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Save access for Alice' }),
    ).toBeDisabled();
    fireEvent.click(revoke);
    await waitFor(() =>
      expect(api.repositoryCollaborationSetAccess).toHaveBeenCalledWith({
        groupId: 'g1',
        ...participant,
        repositoryIds: [],
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(api.repositoryCollaborationConfigureGroup).toHaveBeenCalledWith({
        connectionId: 'wa1',
        chatId: group.chatId,
        title: group.title,
        enabled: false,
      }),
    );
  });

  it('does not grant new members access when activating, and uses only saved grants', async () => {
    state = {
      ...empty(),
      groups: [group],
      repositories: [repo],
      participants: [{ ...participant, groupId: 'g1' }],
      grants: [
        {
          groupId: 'g1',
          participantId: participant.participantId,
          repositoryId: 'r1',
        },
      ],
    };
    api.repositoryCollaborationListParticipants.mockResolvedValue([
      participant,
      { participantId: 'bob@lid', displayName: 'Bob' },
    ]);
    render(<WhatsAppProjectsPanel {...props} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Activate' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(api.repositoryCollaborationConfigureGroup).toHaveBeenCalledWith({
        connectionId: 'wa1',
        chatId: group.chatId,
        title: group.title,
        enabled: true,
      }),
    );
    expect(api.repositoryCollaborationSetAccess).not.toHaveBeenCalled();
  });

  it('discards a previous account’s late load after switching keyed account panels', async () => {
    let resolveOld: (value: unknown) => void = () => undefined;
    api.repositoryCollaborationSnapshot.mockImplementation((id) =>
      id === 'wa1'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(empty()),
    );
    const view = render(<WhatsAppProjectsPanel key="wa1" {...props} />);
    await waitFor(() =>
      expect(api.repositoryCollaborationSnapshot).toHaveBeenCalledWith('wa1'),
    );
    view.rerender(
      <WhatsAppProjectsPanel key="wa2" {...props} connectionId="wa2" />,
    );
    await screen.findByLabelText('WhatsApp group');
    resolveOld({ ...empty(), groups: [group], repositories: [repo] });
    await waitFor(() =>
      expect(api.repositoryCollaborationSnapshot).toHaveBeenCalledWith('wa2'),
    );
    expect(screen.queryByLabelText('Repository alias')).not.toBeInTheDocument();
  });

  it('explains authentication failures and keeps cancellation in progress without offering another action', async () => {
    const task = {
      id: 'T1',
      groupId: 'g1',
      repositoryIds: ['r1'],
      participantId: participant.participantId,
      participantName: 'Alice',
      prompt: 'Add export',
      status: 'cancelling',
      result: null,
      createdAt: 1,
      updatedAt: 1,
      sourceMessageId: 'm1',
      parentTaskId: null,
      conversationId: null,
    };
    state = {
      ...empty(),
      groups: [group],
      repositories: [repo],
      tasks: [
        task,
        {
          ...task,
          id: 'T2',
          status: 'needs_attention',
          errorCode: 'authentication_required',
        },
      ],
    };
    render(<WhatsAppProjectsPanel {...props} />);
    expect(await screen.findByText('Cancelling')).toBeInTheDocument();
    expect(
      screen.getByText('Connect Codex in Forger settings to continue.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel T1' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry T1' }),
    ).not.toBeInTheDocument();
  });
});
