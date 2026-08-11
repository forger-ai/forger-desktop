import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject, SyntheticEvent } from 'react';
import type {
  CloudFriendship,
  CloudFriendUser,
  CloudMessage,
  CloudSocialEvent,
  ForgerAccountSession,
  SocialUserApp,
  SocialUserProfile,
} from '@shared/types';

vi.mock('@renderer/views/friends/SocialLauncherButton', () => ({
  SocialLauncherButton: ({ badgeCount, open, topbar, launcherRef, onToggle }: {
    badgeCount: number;
    open: boolean;
    topbar: boolean;
    launcherRef: MutableRefObject<HTMLButtonElement | null>;
    onToggle: () => void;
  }) => (
    <button
      ref={launcherRef}
      type="button"
      aria-label="Social launcher"
      data-badge={badgeCount}
      data-open={open}
      data-topbar={topbar}
      onClick={onToggle}
    >
      Social
    </button>
  ),
}));

vi.mock('@renderer/views/friends/SocialPanelHeader', () => ({
  SocialPanelHeader: ({
    editingUsername,
    profileUsername,
    profileUsernameError,
    tabSubtitle,
    usernameAvailableDate,
    usernameChangeBlocked,
    canUpdateUsername,
    accountBusy,
    onCancelUsernameEdit,
    onEditingUsernameChange,
    onProfileUsernameChange,
    onProfileUsernameErrorChange,
    onUsernameSubmit,
  }: {
    editingUsername: boolean;
    profileUsername: string;
    profileUsernameError: string | null;
    tabSubtitle: string;
    usernameAvailableDate: string | null;
    usernameChangeBlocked: boolean;
    canUpdateUsername: boolean;
    accountBusy: boolean;
    onCancelUsernameEdit: () => void;
    onEditingUsernameChange: (value: boolean) => void;
    onProfileUsernameChange: (value: string) => void;
    onProfileUsernameErrorChange: (value: string | null) => void;
    onUsernameSubmit: (event?: SyntheticEvent) => void;
  }) => (
    <header>
      <span>{tabSubtitle}</span>
      {usernameAvailableDate ? <span>Available {usernameAvailableDate}</span> : null}
      {editingUsername ? (
        <form onSubmit={onUsernameSubmit}>
          <label htmlFor="mock-profile-username">Profile username</label>
          <input
            id="mock-profile-username"
            value={profileUsername}
            disabled={accountBusy}
            onChange={(event) => {
              onProfileUsernameChange(event.target.value);
              onProfileUsernameErrorChange(null);
            }}
          />
          {profileUsernameError ? <span role="alert">{profileUsernameError}</span> : null}
          <button type="submit" disabled={accountBusy || usernameChangeBlocked || !profileUsername.trim()}>Save username</button>
          <button type="button" disabled={accountBusy} onClick={onCancelUsernameEdit}>Cancel username</button>
        </form>
      ) : (
        <button type="button" disabled={!canUpdateUsername || usernameChangeBlocked} onClick={() => onEditingUsernameChange(true)}>Edit username</button>
      )}
    </header>
  ),
}));

vi.mock('@renderer/views/friends/ForumPanel', () => ({
  ForumPanel: ({ active, onNotify }: { active: boolean; onNotify?: (message: string, severity?: 'info') => void }) => (
    <section aria-label="Mock forum">
      <span>{active ? 'Forum active' : 'Forum idle'}</span>
      <button type="button" onClick={() => onNotify?.('Forum notice', 'info')}>Forum notify</button>
    </section>
  ),
}));

import { FriendsView } from '@renderer/views/FriendsView';

const account = (overrides: Partial<NonNullable<ForgerAccountSession['user']>> = {}): ForgerAccountSession => ({
  authenticated: true,
  user: {
    id: 1,
    email: 'ada@example.com',
    username: 'ada',
    confirmed: true,
    subscriptionTier: 'free',
    ...overrides,
  },
});

const friendUser = (id: number, username = `friend_${id}`, overrides: Partial<CloudFriendUser> = {}): CloudFriendUser => ({
  id,
  username,
  ...overrides,
});

const friendship = (
  id: number,
  status: CloudFriendship['status'] = 'accepted',
  overrides: Partial<CloudFriendship> = {},
): CloudFriendship => ({
  id,
  status,
  requesterId: 1,
  addresseeId: id + 1,
  friend: friendUser(id + 1),
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  ...overrides,
});

const profile = (id: number, username: string): SocialUserProfile => ({ id, username });

const socialApp = (id: number, overrides: Partial<SocialUserApp> = {}): SocialUserApp => ({
  id,
  slug: `app-${id}`,
  name: `App ${id}`,
  visibility: 'public',
  status: 'published',
  owner: profile(1, 'ada'),
  latestVersion: {
    id,
    version: '1.2.3',
    runtimeStack: 'vite-fastapi-sqlite',
    supportedPlatforms: ['darwin-arm64'],
    capabilities: [],
    checksumSha256: 'abcdef0123456789',
    fileSizeBytes: 1536,
  },
  ...overrides,
});

const cloudMessage = (sender: CloudFriendUser, recipient: CloudFriendUser, overrides: Partial<CloudMessage> = {}): CloudMessage => ({
  id: 100,
  type: 'CloudTextMessage',
  source: 'user',
  status: 'delivered',
  sender,
  recipient,
  createdAt: '2026-08-10T12:00:00.000Z',
  updatedAt: '2026-08-10T12:00:01.000Z',
  body: 'Hello',
  ...overrides,
} as CloudMessage);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createBridge = () => {
  const listeners: Array<(event: CloudSocialEvent) => void> = [];
  return {
    listeners,
    listFriends: vi.fn(async () => [] as CloudFriendship[]),
    listMySocialApps: vi.fn(async () => ({ apps: [] as SocialUserApp[] })),
    onCloudFriendshipEvent: vi.fn((listener: (event: CloudSocialEvent) => void) => {
      listeners.push(listener);
      return vi.fn();
    }),
    markFriendChatRead: vi.fn(async (friendId: number) => friendship(100 + friendId, 'accepted', { friend: friendUser(friendId) })),
    acceptFriendRequest: vi.fn(async (id: number) => friendship(id, 'accepted')),
    declineFriendRequest: vi.fn(async (id: number) => friendship(id, 'declined')),
    cancelFriendRequest: vi.fn(async (id: number) => friendship(id, 'canceled')),
    searchFriends: vi.fn(async () => [] as CloudFriendUser[]),
    sendFriendRequest: vi.fn(async (username: string) => friendship(50, 'pending', { friend: friendUser(50, username) })),
    sendCloudAppShareMessage: vi.fn(async () => undefined),
  };
};

const callbacks = () => ({
  onOpenFriendChat: vi.fn(async () => ({ success: true })),
  onNotify: vi.fn(),
  onUpdateUsername: vi.fn(async () => true),
});

const renderFriends = ({
  session = account(),
  accountBusy = false,
  variant = 'floating' as const,
  actions = callbacks(),
}: {
  session?: ForgerAccountSession;
  accountBusy?: boolean;
  variant?: 'floating' | 'topbar';
  actions?: ReturnType<typeof callbacks>;
} = {}) => {
  const view = render(
    <FriendsView
      account={session}
      accountBusy={accountBusy}
      variant={variant}
      {...actions}
    />,
  );
  return { ...view, ...actions };
};

const openPanel = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Social launcher' }));
};

describe('FriendsView', () => {
  let bridge: ReturnType<typeof createBridge>;

  beforeEach(() => {
    window.sessionStorage.clear();
    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('opens and closes the signed-out floating panel with launcher, Escape, and click-away', async () => {
    renderFriends({ session: { authenticated: false } });
    const launcher = screen.getByRole('button', { name: 'Social launcher' });
    expect(launcher).toHaveAttribute('data-topbar', 'false');
    expect(launcher).toHaveAttribute('data-open', 'false');
    await openPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Inicia sesión en Forger Cloud para usar Social.');
    await userEvent.click(launcher);
    expect(launcher).toHaveAttribute('data-open', 'false');
    await openPanel();
    await userEvent.keyboard('{Escape}');
    expect(launcher).toHaveAttribute('data-open', 'false');
    await openPanel();
    fireEvent.mouseDown(document.body);
    fireEvent.mouseUp(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(launcher).toHaveAttribute('data-open', 'false'));
    expect(bridge.listFriends).not.toHaveBeenCalled();
  });

  it('loads empty friends and every tab, persists selection, and restores topbar placement', async () => {
    const friendsLoad = deferred<CloudFriendship[]>();
    bridge.listFriends.mockReturnValueOnce(friendsLoad.promise);
    renderFriends({ variant: 'topbar' });
    await openPanel();
    expect(screen.getByRole('button', { name: 'Social launcher' })).toHaveAttribute('data-topbar', 'true');
    await act(async () => friendsLoad.resolve([]));
    expect(await screen.findByText('Aún no tienes amigos')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Solicitudes' }));
    expect(screen.getByText('No hay solicitudes pendientes')).toBeVisible();
    expect(window.sessionStorage.getItem('forger.social.last-tab')).toBe('requests');

    const appsLoad = deferred<{ apps: SocialUserApp[] }>();
    bridge.listMySocialApps.mockReturnValueOnce(appsLoad.promise);
    await userEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    await act(async () => appsLoad.resolve({ apps: [] }));
    expect(await screen.findByText('No has subido apps a Social')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Foro' }));
    expect(screen.getByText('Forum active')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Forum notify' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Agregar' }));
    expect(screen.getByText('Busca a alguien por username')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Amigos' }));
    expect(screen.getByText('Tus conversaciones disponibles')).toBeVisible();
  });

  it('restores the saved requests tab and keeps its loading state until friendships arrive', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'requests');
    const friendsLoad = deferred<CloudFriendship[]>();
    bridge.listFriends.mockReturnValueOnce(friendsLoad.promise);
    renderFriends();
    await openPanel();
    expect(screen.getByRole('tab', { name: 'Solicitudes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('No hay solicitudes pendientes')).not.toBeInTheDocument();
    await act(async () => friendsLoad.resolve([]));
    expect(await screen.findByText('No hay solicitudes pendientes')).toBeVisible();
  });

  it('shows friend and app load errors with both fallback types and retries', async () => {
    bridge.listFriends.mockRejectedValueOnce(new Error('Friends offline')).mockResolvedValueOnce([]);
    renderFriends();
    await openPanel();
    expect(await screen.findByText('Friends offline')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Aún no tienes amigos')).toBeVisible();

    bridge.listMySocialApps.mockRejectedValueOnce('network').mockRejectedValueOnce(new Error('Apps offline')).mockResolvedValueOnce({ apps: [] });
    await userEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    expect(await screen.findByText('No pudimos cargar apps Social.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Apps offline')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('No has subido apps a Social')).toBeVisible();

    bridge.listFriends.mockRejectedValueOnce('network');
    await userEvent.click(screen.getByRole('tab', { name: 'Solicitudes' }));
    await waitFor(() => expect(bridge.listFriends).toHaveBeenCalled());
  });

  it('shows the fallback friend error when the bridge rejects a non-Error value', async () => {
    bridge.listFriends.mockRejectedValueOnce('network');
    renderFriends();
    await openPanel();
    expect(await screen.findByText('No pudimos cargar Social.')).toBeVisible();
  });

  it('renders friend/request variants and completes chats and request actions', async () => {
    const online = friendship(10, 'accepted', {
      friend: friendUser(2, 'grace', { firstName: 'Grace', online: true }),
      unreadCount: 120,
      lastMessageAt: '2026-08-10T10:00:00.000Z',
    });
    const offline = friendship(11, 'accepted', { friend: friendUser(3, 'linus'), unreadCount: -2 });
    const incoming = friendship(12, 'pending', { requesterId: 2, addresseeId: 1, friend: friendUser(2, 'grace') });
    const outgoing = friendship(13, 'pending', { requesterId: 1, addresseeId: 3, friend: friendUser(3, 'linus') });
    bridge.listFriends.mockResolvedValue([offline, incoming, online, outgoing]);
    bridge.markFriendChatRead.mockResolvedValueOnce({ ...online, unreadCount: 0 }).mockRejectedValueOnce(new Error('Read failed'));
    const actions = callbacks();
    actions.onOpenFriendChat
      .mockResolvedValueOnce({ success: true, userMessage: 'Chat opened' })
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('Chat failed'))
      .mockRejectedValueOnce('network');
    renderFriends({ actions });
    await openPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Amigos' }));
    expect(await screen.findByText('99+')).toBeVisible();
    expect(screen.getByText('En línea')).toBeVisible();
    expect(screen.getByText('Disponible')).toBeVisible();

    const graceRow = screen.getByText('@grace').closest('[role="button"]') as HTMLElement;
    await userEvent.click(graceRow);
    expect(await screen.findByText('Chat opened')).toBeVisible();
    expect(actions.onNotify).toHaveBeenCalledWith('Chat opened', 'info');
    const linusRow = screen.getByText('@linus').closest('[role="button"]') as HTMLElement;
    await userEvent.click(linusRow);
    expect(await screen.findByText('Chat de @linus listo para abrir')).toBeVisible();

    await userEvent.click(graceRow);
    expect(await screen.findByText('Chat failed')).toBeVisible();
    await userEvent.click(graceRow);
    expect(await screen.findByText('No pudimos abrir este chat.')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Solicitudes' }));
    expect(screen.getByText('Recibidas')).toBeVisible();
    expect(screen.getByText('Enviadas')).toBeVisible();
    bridge.acceptFriendRequest.mockResolvedValueOnce({ ...incoming, status: 'accepted' });
    await userEvent.click(screen.getByRole('button', { name: 'Aceptar' }));
    expect(await screen.findByText('Agregaste a @grace a tus amigos.')).toBeVisible();

    bridge.cancelFriendRequest.mockRejectedValueOnce(new Error('Cancel failed'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByText('Cancel failed')).toBeVisible();
  });

  it('covers decline/cancel request successes and non-Error request failures', async () => {
    const incoming = friendship(12, 'pending', { requesterId: 2, addresseeId: 1, friend: friendUser(2, 'grace') });
    const outgoing = friendship(13, 'pending', { requesterId: 1, addresseeId: 3, friend: friendUser(3, 'linus') });
    bridge.listFriends.mockResolvedValue([incoming, outgoing]);
    renderFriends();
    await openPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Solicitudes' }));
    bridge.declineFriendRequest.mockRejectedValueOnce('network').mockResolvedValueOnce({ ...incoming, status: 'declined' });
    await userEvent.click(screen.getByRole('button', { name: 'Rechazar' }));
    expect(await screen.findByText('No pudimos completar la solicitud.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Rechazar' }));
    expect(await screen.findByText('Rechazaste la solicitud de @grace.')).toBeVisible();
    bridge.cancelFriendRequest.mockResolvedValueOnce({ ...outgoing, status: 'canceled' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByText('Cancelaste la solicitud para @linus.')).toBeVisible();
  });

  it('searches friends, filters self, sends requests, and clears feedback while typing', async () => {
    renderFriends();
    await openPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Agregar' }));
    const search = screen.getByPlaceholderText('@username');
    fireEvent.submit(search.closest('form') as HTMLFormElement);
    expect(bridge.searchFriends).not.toHaveBeenCalled();

    bridge.searchFriends.mockResolvedValueOnce([friendUser(1, 'ada'), friendUser(2, 'grace', { firstName: 'Grace' }), friendUser(3, 'linus')]);
    await userEvent.type(search, '@gr');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('Grace')).toBeVisible();
    expect(screen.queryByText('@ada')).not.toBeInTheDocument();

    bridge.sendFriendRequest.mockRejectedValueOnce(new Error('Request blocked')).mockRejectedValueOnce('network');
    await userEvent.click(screen.getAllByRole('button', { name: 'Enviar' })[0]);
    expect(await screen.findByText('Request blocked')).toBeVisible();
    await userEvent.click(screen.getAllByRole('button', { name: 'Enviar' })[1]);
    expect(await screen.findByText('No pudimos enviar la solicitud.')).toBeVisible();
    await userEvent.clear(search);
    expect(screen.queryByText('No pudimos enviar la solicitud.')).not.toBeInTheDocument();

    await userEvent.type(search, 'grace');
    bridge.searchFriends.mockResolvedValueOnce([friendUser(2, 'grace')]);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    bridge.sendFriendRequest.mockResolvedValueOnce(friendship(50, 'pending', { friend: friendUser(2, 'grace') }));
    await userEvent.click(await screen.findByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Solicitud enviada a @grace.')).toBeVisible();

    await userEvent.clear(search);
    await userEvent.type(search, 'nobody');
    bridge.searchFriends.mockResolvedValueOnce([]);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('No encontramos a @nobody.')).toBeVisible();
    await userEvent.clear(search);
    await userEvent.type(search, 'ada');
    bridge.searchFriends.mockResolvedValueOnce([friendUser(1, 'ada')]);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('No encontramos a @ada.')).toBeVisible();
    await userEvent.clear(search);
    await userEvent.type(search, 'broken');
    bridge.searchFriends.mockRejectedValueOnce(new Error('Search failed')).mockRejectedValueOnce('network');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('Search failed')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('No pudimos buscar ese usuario.')).toBeVisible();
  });

  it('renders app metadata variants and shares with accepted friends', async () => {
    const grace = friendship(10, 'accepted', { friend: friendUser(2, 'grace', { firstName: 'Grace' }) });
    const linus = friendship(11, 'accepted', { friend: friendUser(3, 'linus') });
    bridge.listFriends.mockResolvedValue([grace, linus]);
    bridge.listMySocialApps.mockResolvedValue({
      apps: [
        socialApp(1, { visibility: 'public', shortDescription: 'Short', latestVersion: { ...socialApp(1).latestVersion!, fileSizeBytes: 512 } }),
        socialApp(2, { visibility: 'friends', description: 'Description', latestVersion: { ...socialApp(2).latestVersion!, fileSizeBytes: 1024 ** 2 } }),
        socialApp(3, { visibility: 'private', shortDescription: '', description: '', latestVersion: { ...socialApp(3).latestVersion!, fileSizeBytes: 1024 ** 3, checksumSha256: '' } }),
        socialApp(4, { status: 'suspended', latestVersion: undefined }),
      ],
    });
    const actions = callbacks();
    renderFriends({ actions });
    await openPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    expect(await screen.findByText(/512 B/)).toBeVisible();
    expect(screen.getByText(/1 MB/)).toBeVisible();
    expect(screen.getByText(/1 GB/)).toBeVisible();
    expect(screen.getAllByText('Publica')).toHaveLength(2);
    expect(screen.getAllByText('Amigos').at(-1)).toBeVisible();
    expect(screen.getByText('Privada')).toBeVisible();
    expect(screen.getAllByText('App compartida desde Forger Social')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Enviar a amigo' }).at(-1)).toBeDisabled();

    await userEvent.click(screen.getAllByRole('button', { name: 'Enviar a amigo' })[0]);
    const dialog = screen.getByRole('dialog', { name: 'Enviar app por chat' });
    await userEvent.click(within(dialog).getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: /linus/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(bridge.sendCloudAppShareMessage).toHaveBeenCalledWith({ recipientUserId: 3, userAppId: 1 }));
    expect(actions.onNotify).toHaveBeenCalledWith('App 1 enviada a @linus.', 'success');
  });

  it('keeps share dialog open on errors and while a send is in flight', async () => {
    const grace = friendship(10, 'accepted', { friend: friendUser(2, 'grace') });
    bridge.listFriends.mockResolvedValue([grace]);
    bridge.listMySocialApps.mockResolvedValue({ apps: [socialApp(1)] });
    bridge.sendCloudAppShareMessage.mockRejectedValueOnce(new Error('Share failed')).mockRejectedValueOnce('network');
    const actions = callbacks();
    renderFriends({ actions });
    await openPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Enviar a amigo' }));
    let dialog = screen.getByRole('dialog', { name: 'Enviar app por chat' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
    expect(await within(dialog).findByText('Share failed')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
    expect(await within(dialog).findByText('No pudimos compartir esta app.')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Enviar app por chat' })).not.toBeInTheDocument());

    const sending = deferred<void>();
    bridge.sendCloudAppShareMessage.mockReturnValueOnce(sending.promise);
    await userEvent.click(screen.getByRole('button', { name: 'Enviar a amigo' }));
    dialog = screen.getByRole('dialog', { name: 'Enviar app por chat' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
    expect(await within(dialog).findByRole('button', { name: 'Enviando...' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Enviar app por chat' })).toBeVisible();
    await act(async () => sending.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Enviar app por chat' })).not.toBeInTheDocument());
  });

  it('updates usernames, exposes date variants, and resets state when the account changes', async () => {
    const actions = callbacks();
    actions.onUpdateUsername.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const view = renderFriends({ actions, session: account({ usernameChangeAvailableAt: 'not-a-date' }) });
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Edit username' }));
    let username = screen.getByRole('textbox', { name: 'Profile username' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel username' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit username' }));
    username = screen.getByRole('textbox', { name: 'Profile username' });
    await userEvent.clear(username);
    await userEvent.type(username, '@ada_new');
    await userEvent.click(screen.getByRole('button', { name: 'Save username' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos actualizar tu username.');
    await userEvent.type(username, '_ok');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save username' }));
    expect(actions.onUpdateUsername).toHaveBeenLastCalledWith('ada_new_ok');
    expect(actions.onNotify).toHaveBeenCalledWith('Username actualizado.', 'success');

    view.rerender(
      <FriendsView
        account={account({ id: 2, username: 'next', usernameChangeAvailableAt: '2099-08-10T00:00:00.000Z' })}
        {...actions}
      />,
    );
    expect(screen.getByText(/Available/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit username' })).toBeDisabled();
  });

  it('restores an empty username when editing is cancelled', async () => {
    renderFriends({ session: account({ username: undefined }) });
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Edit username' }));
    const username = screen.getByRole('textbox', { name: 'Profile username' });
    await userEvent.type(username, 'temporary');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel username' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit username' }));
    expect(screen.getByRole('textbox', { name: 'Profile username' })).toHaveValue('');
  });

  it('merges friendship and message events and reloads unknown senders', async () => {
    const grace = friendship(10, 'accepted', { friend: friendUser(2, 'grace') });
    bridge.listFriends.mockResolvedValue([grace]);
    renderFriends();
    await openPanel();
    expect(await screen.findByText('@grace')).toBeVisible();

    act(() => bridge.listeners.at(-1)?.({ type: 'friendship_changed', friendship: { ...grace, friend: friendUser(2, 'grace_new') } }));
    expect(await screen.findByText('@grace_new')).toBeVisible();
    const me = friendUser(1, 'ada');
    const graceUser = friendUser(2, 'grace_new', { firstName: 'Grace Updated' });
    act(() => bridge.listeners.at(-1)?.({ type: 'cloud_message', message: cloudMessage(graceUser, me), unread: true }));
    expect(await screen.findByText('Grace Updated')).toBeVisible();
    act(() => bridge.listeners.at(-1)?.({ type: 'ephemeral_cloud_message', message: cloudMessage(me, graceUser, { createdAt: '', updatedAt: '2026-08-10T13:00:00.000Z' }), unread: false }));
    act(() => bridge.listeners.at(-1)?.({ type: 'cloud_message', message: cloudMessage(graceUser, me, { createdAt: '', updatedAt: '' }), unread: true }));
    act(() => bridge.listeners.at(-1)?.({
      type: 'cloud_message_delivery',
      delivery: {
        id: 1,
        sender: graceUser,
        recipient: me,
        targetUserId: 1,
        targetCloudDeviceId: 1,
        clientMessageId: 'delivery-1',
        messageType: 'CloudTextMessage',
        deliveryMode: 'persistent',
        source: 'user',
        ciphertext: 'ciphertext',
        metadata: {},
        expiresAt: '2026-08-11T13:00:00.000Z',
        createdAt: '2026-08-10T13:00:00.000Z',
      },
    }));

    const callsBeforeUnknown = bridge.listFriends.mock.calls.length;
    act(() => bridge.listeners.at(-1)?.({ type: 'cloud_message', message: cloudMessage(friendUser(9, 'unknown'), me), unread: false }));
    await waitFor(() => expect(bridge.listFriends.mock.calls.length).toBeGreaterThan(callsBeforeUnknown));
  });
});
