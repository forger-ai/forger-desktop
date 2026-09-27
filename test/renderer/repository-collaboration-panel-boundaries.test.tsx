import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppProjectsPanel } from '@renderer/views/connections/WhatsAppProjectsPanel';
import { en } from '@renderer/i18n/en';
import { es } from '@renderer/i18n/es';
import type { AppDictionary } from '@renderer/i18n';
import type { RepositoryCollaborationSnapshot } from '@shared/types/repository-collaboration';

const copy = en.repositoryCollaboration;
const group = { id: 'g1', connectionId: 'wa1', chatId: 'team@g.us', title: 'Team', enabled: false, activatedAt: null };
const repo = { id: 'r1', groupId: 'g1', name: 'Backend' };
const person = { groupId: 'g1', participantId: 'alice@lid', displayName: 'Alice' };
const props = { connectionId: 'wa1', t: en as unknown as AppDictionary };
const empty = (): RepositoryCollaborationSnapshot => ({ groups: [], repositories: [], participants: [], grants: [], tasks: [], outbox: [] });
let state: RepositoryCollaborationSnapshot;
let api: Record<string, ReturnType<typeof vi.fn>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = () => act(async () => { await Promise.resolve(); });
const show = () => render(<WhatsAppProjectsPanel {...props} />);
async function add() {
  fireEvent.change(await screen.findByLabelText(copy.alias), { target: { value: 'New repo' } });
  fireEvent.click(screen.getByRole('button', { name: copy.addFolder }));
}

beforeEach(() => {
  state = { ...empty(), groups: [group], repositories: [repo], participants: [person] };
  api = {
    repositoryCollaborationSnapshot: vi.fn(async () => state),
    repositoryCollaborationListGroups: vi.fn(async () => [{ chatId: group.chatId, title: group.title }]),
    repositoryCollaborationListParticipants: vi.fn(async () => [person]),
    repositoryCollaborationConfigureGroup: vi.fn(async () => group),
    repositoryCollaborationAddRepository: vi.fn(async () => repo),
    repositoryCollaborationRemoveRepository: vi.fn(async () => undefined),
    repositoryCollaborationSetAccess: vi.fn(async () => undefined),
    repositoryCollaborationCancelTask: vi.fn(async () => undefined),
    repositoryCollaborationRetryTask: vi.fn(async () => undefined),
  };
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('shared project recovery and lifecycle', () => {
  it.each([
    ['La carpeta seleccionada no es un repositorio Git disponible.', copy.invalidRepository],
    ["Error invoking remote method 'forger:repository-collaboration:add-repository': Error: Selecciona una carpeta de proyecto válida.", copy.invalidRepository],
    ['repository_execution_platform_unsupported', copy.unsupported],
    ['codex_authentication_required', copy.authRequired],
    ['connection_not_connected', copy.unavailable],
    [null, copy.actionError],
  ])('explains a failed folder operation safely: %s', async (failure, message) => {
    api.repositoryCollaborationAddRepository.mockRejectedValueOnce(failure === null ? null : new Error(failure));
    show(); await add();
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByLabelText(copy.alias)).toHaveValue('New repo');
    expect(screen.getByRole('button', { name: copy.addFolder })).toBeEnabled();
  });

  it('clears a saved alias and persists removal of one selected grant', async () => {
    state.grants = [{ groupId: group.id, repositoryId: repo.id, participantId: person.participantId }];
    show(); await add();
    await waitFor(() => expect(screen.getByLabelText(copy.alias)).toHaveValue(''));
    const access = await screen.findByRole('checkbox', { name: repo.name });
    expect(access).toBeChecked(); fireEvent.click(access);
    fireEvent.click(screen.getByRole('button', { name: copy.saveAccessLabel(person.displayName) }));
    await waitFor(() => expect(api.repositoryCollaborationSetAccess).toHaveBeenCalledWith({ ...person, repositoryIds: [] }));
  });

  it('requires confirmation before removing a repository and tolerates a stale confirmation after keeping it', async () => {
    show(); const remove = await screen.findByRole('button', { name: `${copy.remove} ${repo.name}` });
    fireEvent.click(remove);
    let dialog = await screen.findByRole('dialog');
    const staleConfirm = within(dialog).getByRole('button', { name: copy.confirmRemove });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.keep }));
    fireEvent.click(staleConfirm);
    expect(api.repositoryCollaborationRemoveRepository).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(remove);
    dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(remove);
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: copy.confirmRemove }));
    await waitFor(() => expect(api.repositoryCollaborationRemoveRepository).toHaveBeenCalledExactlyOnceWith({ groupId: 'g1', repositoryId: 'r1' }));
  });

  it('keeps confirmation stable when opening it races with an in-flight folder save', async () => {
    const pending = deferred<unknown>(); api.repositoryCollaborationAddRepository.mockReturnValueOnce(pending.promise);
    show();
    fireEvent.change(await screen.findByLabelText(copy.alias), { target: { value: 'Another repo' } });
    const remove = screen.getByRole('button', { name: `${copy.remove} ${repo.name}` });
    const addFolder = screen.getByRole('button', { name: copy.addFolder });
    act(() => { fireEvent.click(remove); fireEvent.click(addFolder); });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: copy.keep })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    expect(screen.getByRole('dialog')).toBeVisible();
    await act(async () => pending.resolve(repo));
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('localizes saving and revoking existing access in Spanish', async () => {
    state.grants = [{ groupId: group.id, repositoryId: repo.id, participantId: person.participantId }];
    render(<WhatsAppProjectsPanel {...props} t={es as unknown as AppDictionary} />);
    const save = await screen.findByRole('button', { name: 'Guardar acceso de Alice' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(api.repositoryCollaborationSetAccess).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Quitar acceso de Alice' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Quitar acceso de Alice' }));
    await waitFor(() => expect(api.repositoryCollaborationSetAccess).toHaveBeenLastCalledWith({ ...person, repositoryIds: [] }));
  });

  it('distinguishes an unobserved group list from loading and a configured group with no participants', async () => {
    state = empty(); const groups = deferred<[]>();
    api.repositoryCollaborationListGroups.mockReturnValueOnce(groups.promise);
    const view = show(); await flush();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await act(async () => groups.resolve([]));
    expect(screen.getByText(copy.noGroups)).toBeVisible();
    state = { ...empty(), groups: [group] };
    api.repositoryCollaborationListParticipants.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: copy.refresh }));
    expect(await screen.findByText(copy.noParticipants)).toBeVisible();
    view.unmount();
  });

  it('shows completed and queued tasks, missing repository labels and pending replies only for this group', async () => {
    state.tasks = ['completed', 'queued'].map((status, index) => ({
      id: `T${index}`, groupId: 'g1', repositoryIds: ['missing'], participantId: person.participantId,
      participantName: 'Alice', prompt: 'Synthetic task', status: status as 'completed' | 'queued', result: null,
      createdAt: index, updatedAt: index, sourceMessageId: `m${index}`, parentTaskId: null, conversationId: null,
    }));
    state.outbox = [
      { id: 'o1', groupId: 'other', taskId: null, status: 'pending', attempts: 0, text: '', messageId: null },
      { id: 'o2', groupId: 'g1', taskId: null, status: 'sent', attempts: 1, text: '', messageId: 'm' },
      { id: 'o3', groupId: 'g1', taskId: 'T0', status: 'pending', attempts: 0, text: '', messageId: null },
    ];
    show(); expect(await screen.findByText(copy.pendingDelivery)).toBeVisible();
    expect(screen.getByText(copy.statuses.completed)).toBeVisible();
    expect(screen.getAllByText('—')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: `${copy.cancel} T1` }));
    await waitFor(() => expect(api.repositoryCollaborationCancelTask).toHaveBeenCalledWith({ taskId: 'T1' }));
  });

  it.each(['resolve', 'reject'] as const)('discards a folder operation that settles by %s after leaving the account', async (settle) => {
    const pending = deferred<unknown>(); api.repositoryCollaborationAddRepository.mockReturnValueOnce(pending.promise);
    const view = show(); await add();
    view.unmount();
    await act(async () => { if (settle === 'resolve') pending.resolve(repo); else pending.reject(new Error('offline')); });
    expect(api.repositoryCollaborationSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('discards group and participant queries settled by %s after unmount', async (settle) => {
    const chats = deferred<unknown>(); const people = deferred<unknown>();
    api.repositoryCollaborationListGroups.mockReturnValueOnce(chats.promise);
    api.repositoryCollaborationListParticipants.mockReturnValueOnce(people.promise);
    const view = show(); await screen.findByLabelText(copy.alias); await flush(); view.unmount();
    await act(async () => {
      if (settle === 'resolve') { chats.resolve([]); people.resolve([]); }
      else { chats.reject(new Error('offline')); people.reject(new Error('offline')); }
    });
  });

  it('discards a rejected snapshot after unmount', async () => {
    const pending = deferred<unknown>(); api.repositoryCollaborationSnapshot.mockReturnValueOnce(pending.promise);
    const view = show(); await flush(); view.unmount();
    await act(async () => pending.reject(new Error('offline')));
  });

  it('polls only a visible idle panel, applies fresh snapshots and reports a failed refresh', async () => {
    let poll!: () => void;
    const interval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation((handler, delay, ...args) => {
      if (delay === 10_000) { poll = handler as () => void; return 999999; }
      return interval(handler, delay, ...args);
    });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const view = show(); await screen.findByLabelText(copy.alias);
    act(() => poll()); await flush(); expect(api.repositoryCollaborationSnapshot).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    const pending = deferred<RepositoryCollaborationSnapshot>(); api.repositoryCollaborationSnapshot.mockReturnValueOnce(pending.promise);
    act(() => poll()); await flush(); act(() => poll()); await flush();
    expect(api.repositoryCollaborationSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ ...state, repositories: [{ ...repo, name: 'Updated repo' }] }));
    expect(screen.getByRole('button', { name: `${copy.remove} Updated repo` })).toBeVisible();
    api.repositoryCollaborationSnapshot.mockRejectedValueOnce(new Error('offline'));
    act(() => poll()); expect(await screen.findByText(copy.loadError)).toBeVisible();
    view.unmount();
  });

  it.each(['resolve', 'reject'] as const)('ignores a poll settled by %s after unmount', async (settle) => {
    let poll!: () => void;
    const interval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation((handler, delay, ...args) => {
      if (delay === 10_000) { poll = handler as () => void; return 999999; }
      return interval(handler, delay, ...args);
    });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const view = show(); await screen.findByLabelText(copy.alias);
    const pending = deferred<RepositoryCollaborationSnapshot>(); api.repositoryCollaborationSnapshot.mockReturnValueOnce(pending.promise);
    act(() => poll()); await flush(); view.unmount();
    await act(async () => { if (settle === 'resolve') pending.resolve(state); else pending.reject(new Error('offline')); });
  });
});
