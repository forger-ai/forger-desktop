import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSummary,
  CloudFriendship,
  CloudFriendUser,
  ForgerAccountSession,
  SocialUserApp,
  SocialUserProfile,
} from '@shared/types';
import { en } from '@renderer/i18n/en';

vi.mock('@renderer/views/friends/ForumPanel', () => ({
  ForumPanel: ({ active, onNotify, onOpenProfile }: {
    active: boolean;
    onNotify?: (message: string, severity?: 'info') => void;
    onOpenProfile?: (username: string) => void;
  }) => (
    <section aria-label="Mock forum">
      <span>{active ? 'Forum active' : 'Forum idle'}</span>
      <button type="button" onClick={() => onNotify?.('Forum notice', 'info')}>Forum notify</button>
      {onOpenProfile ? <button type="button" onClick={() => onOpenProfile('@forum_friend')}>Forum profile</button> : null}
    </section>
  ),
}));

import { SocialView } from '@renderer/views/SocialView';

const account = (overrides: Partial<NonNullable<ForgerAccountSession['user']>> = {}): ForgerAccountSession => ({
  authenticated: true,
  user: {
    id: 1,
    email: 'ada@example.com',
    username: 'ada',
    displayName: 'Ada Lovelace',
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

const profile = (id: number, username: string, overrides: Partial<SocialUserProfile> = {}): SocialUserProfile => ({
  id,
  username,
  ...overrides,
});

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

const installedApp = (id: string, overrides: Partial<AppSummary> = {}): AppSummary => ({
  id,
  name: `Local ${id}`,
  category: 'productivity',
  status: 'installed',
  privateLocal: true,
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createBridge = () => ({
  listFriends: vi.fn(async () => [] as CloudFriendship[]),
  markFriendChatRead: vi.fn(async (friendId: number) => friendship(100 + friendId)),
  searchFriends: vi.fn(async () => [] as CloudFriendUser[]),
  sendFriendRequest: vi.fn(async (username: string) => friendship(20, 'pending', { friend: friendUser(20, username) })),
  listMySocialApps: vi.fn(async () => ({ apps: [] as SocialUserApp[] })),
  getSocialProfile: vi.fn(async (username: string) => ({ profile: profile(2, username), apps: [] as SocialUserApp[] })),
  getSocialProfileUrl: vi.fn(async (username: string) => `https://forger.test/@${username}`),
  updateSocialAppVisibility: vi.fn(async (id: number, visibility: SocialUserApp['visibility']) => socialApp(id, { visibility })),
  updateSocialApp: vi.fn(async (input: { id: number }) => socialApp(input.id, { name: 'Updated app' })),
  deleteSocialApp: vi.fn(async () => undefined),
  openExternalUrl: vi.fn(async () => ({ success: true })),
});

const callbacks = () => ({
  onInitialProfileUsernameConsumed: vi.fn(),
  onOpenFriendChat: vi.fn(async () => ({ success: true })),
  onOpenCloudModal: vi.fn(),
  onOpenSocialApp: vi.fn(),
  onUploadSocial: vi.fn(),
  onNotify: vi.fn(),
  onUpdateUsername: vi.fn(async () => true),
  onUpdateProfile: vi.fn(async () => true),
});

const renderSocial = ({
  session = account(),
  installedApps = [] as AppSummary[],
  initialProfileUsername,
  actions = callbacks(),
  dark = false,
  accountBusy = false,
}: {
  session?: ForgerAccountSession;
  installedApps?: AppSummary[];
  initialProfileUsername?: string | null;
  actions?: ReturnType<typeof callbacks>;
  dark?: boolean;
  accountBusy?: boolean;
} = {}) => {
  const view = render(
    <ThemeProvider theme={createTheme({ palette: { mode: dark ? 'dark' : 'light' } })}>
      <SocialView
        account={session}
        t={en}
        installedApps={installedApps}
        initialProfileUsername={initialProfileUsername}
        accountBusy={accountBusy}
        {...actions}
      />
    </ThemeProvider>,
  );
  return { ...view, ...actions };
};

describe('SocialView', () => {
  let bridge: ReturnType<typeof createBridge>;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.sessionStorage.clear();
    bridge = createBridge();
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('offers Cloud login to signed-out and unconfirmed people', async () => {
    const actions = callbacks();
    const view = renderSocial({ session: { authenticated: false }, actions });
    expect(screen.getByText('Social requiere Forger Cloud')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(actions.onOpenCloudModal).toHaveBeenCalledOnce();

    view.rerender(
      <SocialView
        account={account({ confirmed: false })}
        t={en}
        onOpenCloudModal={actions.onOpenCloudModal}
        onOpenSocialApp={actions.onOpenSocialApp}
      />,
    );
    expect(screen.getByText('Social requiere Forger Cloud')).toBeVisible();
    expect(bridge.listFriends).not.toHaveBeenCalled();
  });

  it('shows friend loading, empty, errors, refresh, searches, and request outcomes', async () => {
    const firstLoad = deferred<CloudFriendship[]>();
    bridge.listFriends.mockReturnValueOnce(firstLoad.promise);
    const actions = callbacks();
    renderSocial({ actions });
    expect(await screen.findByText('Cargando amigos...')).toBeVisible();
    await act(async () => firstLoad.resolve([]));
    expect(await screen.findByText('Aún no tienes amigos')).toBeVisible();

    bridge.listFriends.mockRejectedValueOnce(new Error('Friends offline'));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Friends offline');
    bridge.listFriends.mockRejectedValueOnce('network');
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar tus amigos.');

    const search = screen.getByPlaceholderText('@username');
    bridge.searchFriends.mockResolvedValueOnce([friendUser(1, 'ada'), friendUser(2, 'grace', { firstName: 'Grace' }), friendUser(3, 'linus')]);
    await userEvent.type(search, '@gr');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('Grace')).toBeVisible();
    expect(screen.getByText('@linus')).toBeVisible();
    expect(screen.queryByText('@ada')).not.toBeInTheDocument();

    bridge.sendFriendRequest.mockRejectedValueOnce(new Error('Request blocked'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Enviar' })[0]);
    expect(await screen.findByText('Request blocked')).toBeVisible();
    expect(actions.onNotify).toHaveBeenCalledWith('Request blocked', 'error');
    bridge.sendFriendRequest.mockRejectedValueOnce('network');
    await userEvent.click(screen.getAllByRole('button', { name: 'Enviar' })[1]);
    expect(await screen.findByText('No pudimos enviar la solicitud.')).toBeVisible();
    await userEvent.clear(search);
    expect(screen.queryByText('Request blocked')).not.toBeInTheDocument();
    await userEvent.type(search, 'grace');
    bridge.searchFriends.mockResolvedValueOnce([friendUser(2, 'grace', { firstName: 'Grace' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    bridge.sendFriendRequest.mockResolvedValueOnce(friendship(44, 'pending', { friend: friendUser(2, 'grace') }));
    await userEvent.click(await screen.findByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Solicitud enviada a @grace.')).toBeVisible();
    expect(actions.onNotify).toHaveBeenCalledWith('Solicitud enviada a @grace.', 'success');

    await userEvent.clear(search);
    await userEvent.type(search, 'linus');
    bridge.searchFriends.mockResolvedValueOnce([friendUser(3, 'linus')]);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    bridge.sendFriendRequest.mockResolvedValueOnce(friendship(45, 'pending', { friend: friendUser(3, 'linus') }));
    await userEvent.click(await screen.findByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Solicitud enviada a @linus.')).toBeVisible();

    await userEvent.clear(search);
    await userEvent.type(search, 'linus');
    bridge.searchFriends.mockResolvedValueOnce([friendUser(3, 'linus')]);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    bridge.sendFriendRequest.mockResolvedValueOnce(friendship(45, 'pending', { friend: friendUser(3, 'linus') }));
    await userEvent.click(await screen.findByRole('button', { name: 'Enviar' }));

    await userEvent.clear(search);
    await userEvent.type(search, 'nobody');
    bridge.searchFriends.mockResolvedValueOnce([]);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('No encontramos a @nobody.')).toBeVisible();
    await userEvent.clear(search);
    await userEvent.type(search, 'broken');
    bridge.searchFriends.mockRejectedValueOnce('network');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('No pudimos buscar ese usuario.')).toBeVisible();

    await userEvent.clear(search);
    await userEvent.type(search, 'profile_user');
    bridge.searchFriends.mockResolvedValueOnce([friendUser(8, 'profile_user')]);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    const profileResult = (await screen.findByText('@profile_user')).closest('.MuiPaper-root') as HTMLElement;
    await userEvent.click(within(profileResult).getByRole('button', { name: 'Ver perfil' }));
    expect((await screen.findAllByText('@profile_user')).length).toBeGreaterThan(0);
  });

  it('renders accepted and pending friends, opens chats, profiles, and forum navigation', async () => {
    const online = friendship(10, 'accepted', {
      friend: friendUser(2, 'grace', { firstName: 'Grace', online: true }),
      unreadCount: 120,
      lastMessageAt: '2026-08-10T10:00:00.000Z',
    });
    const offline = friendship(11, 'accepted', { friend: friendUser(3, 'linus'), unreadCount: -2 });
    const incoming = friendship(12, 'pending', { requesterId: 2, addresseeId: 1, friend: friendUser(2, 'grace') });
    const outgoing = friendship(13, 'pending', { requesterId: 1, addresseeId: 3, friend: friendUser(3, 'linus') });
    bridge.listFriends.mockResolvedValue([offline, incoming, online, outgoing]);
    bridge.markFriendChatRead.mockResolvedValueOnce({ ...online, unreadCount: 0 });
    const actions = callbacks();
    actions.onOpenFriendChat.mockResolvedValueOnce({ success: true, userMessage: 'Chat opened' });
    renderSocial({ actions });

    expect(await screen.findByText('99+')).toBeVisible();
    expect(screen.getByText('Recibida')).toBeVisible();
    expect(screen.getByText('Enviada')).toBeVisible();
    await userEvent.click(screen.getAllByRole('button', { name: 'Ver perfil' }).at(-1)!);
    expect((await screen.findAllByText('@linus')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('tab', { name: en.social.tabs.friends }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Chat' })[0]);
    await waitFor(() => expect(actions.onNotify).toHaveBeenCalledWith('Chat opened', 'info'));
    expect(bridge.markFriendChatRead).toHaveBeenCalledWith(2);

    await userEvent.click(screen.getAllByRole('button', { name: 'Ver perfil' })[0]);
    expect(window.sessionStorage.getItem('forger.social.last-tab')).toBe('search');
    expect((await screen.findAllByText('@grace')).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('tab', { name: en.social.tabs.forum }));
    expect(screen.getByText('Forum active')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Forum notify' }));
    expect(actions.onNotify).toHaveBeenCalledWith('Forum notice', 'info');
    await userEvent.click(screen.getByRole('button', { name: 'Forum profile' }));
    expect((await screen.findAllByText('@forum_friend')).length).toBeGreaterThan(0);
  });

  it('reports chat failures and uses the default success message when no handler exists', async () => {
    const entry = friendship(10, 'accepted', { friend: friendUser(2, 'grace') });
    bridge.listFriends.mockResolvedValue([entry]);
    bridge.markFriendChatRead.mockRejectedValueOnce(new Error('read failure'));
    const actions = callbacks();
    actions.onOpenFriendChat.mockRejectedValueOnce('broken');
    const view = renderSocial({ actions });
    await userEvent.click(await screen.findByRole('button', { name: 'Chat' }));
    await waitFor(() => expect(actions.onNotify).toHaveBeenCalledWith('No pudimos abrir este chat.', 'error'));
    view.unmount();

    const errorActions = callbacks();
    errorActions.onOpenFriendChat.mockRejectedValueOnce(new Error('Chat failed'));
    const errorView = renderSocial({ actions: errorActions });
    await userEvent.click(await screen.findByRole('button', { name: 'Chat' }));
    await waitFor(() => expect(errorActions.onNotify).toHaveBeenCalledWith('Chat failed', 'error'));
    errorView.unmount();

    const defaultActions = callbacks();
    render(
      <SocialView
        account={account()}
        t={en}
        onOpenCloudModal={defaultActions.onOpenCloudModal}
        onOpenSocialApp={defaultActions.onOpenSocialApp}
        onNotify={defaultActions.onNotify}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Chat' }));
    await waitFor(() => expect(defaultActions.onNotify).toHaveBeenCalledWith('Chat de @grace listo.', 'info'));
  });

  it('loads external profiles with names, bios, app variants, empty and error states', async () => {
    const direct = socialApp(7, {
      name: 'Shared app',
      visibility: 'private',
      accessReason: 'direct_share',
      owner: profile(2, 'grace'),
      shortDescription: '',
      description: '',
      latestVersion: undefined,
    });
    bridge.getSocialProfile.mockResolvedValueOnce({
      profile: profile(2, 'grace', { firstName: 'Grace', lastInitial: 'H', socialBio: 'Compiler pioneer' }),
      apps: [direct],
    });
    const actions = callbacks();
    renderSocial({ initialProfileUsername: '@grace', actions });
    expect(actions.onInitialProfileUsernameConsumed).toHaveBeenCalledOnce();
    expect(await screen.findByText('Grace H.')).toBeVisible();
    expect(screen.getByText('Compiler pioneer')).toBeVisible();
    expect(screen.getByText(en.social.visibility.directShare)).toBeVisible();
    expect(screen.getByText('Version - · -')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir app' }));
    expect(actions.onOpenSocialApp).toHaveBeenCalledWith(direct);

    const profileInput = screen.getByRole('textbox', { name: 'Perfil' });
    await userEvent.clear(profileInput);
    await userEvent.type(profileInput, 'missing');
    bridge.getSocialProfile.mockResolvedValueOnce({ profile: null, apps: [] } as never);
    await userEvent.click(screen.getByRole('button', { name: 'Ver perfil' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No encontramos el perfil @missing.');

    bridge.getSocialProfile.mockRejectedValueOnce(new Error('Profile offline'));
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Profile offline');
    bridge.getSocialProfile.mockRejectedValueOnce('network');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar este perfil.');
  });

  it('updates the own profile, opens and copies its link, and handles profile edit outcomes', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    bridge.getSocialProfile.mockResolvedValue({ profile: profile(1, 'ada'), apps: [] });
    bridge.getSocialProfileUrl.mockResolvedValue('https://forger.test/@ada');
    const actions = callbacks();
    actions.onUpdateUsername.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    actions.onUpdateProfile.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Profile update failed')).mockResolvedValueOnce(true);
    renderSocial({ actions });

    expect(await screen.findByText('https://forger.test/@ada')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://forger.test/@ada');
    await userEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    expect(writeText).toHaveBeenCalledWith('https://forger.test/@ada');
    expect(actions.onNotify).toHaveBeenCalledWith('Link copiado.', 'success');

    const username = screen.getByRole('textbox', { name: 'Username' });
    await userEvent.clear(username);
    await userEvent.type(username, '@ada_new');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar username' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos actualizar tu username.');
    await userEvent.clear(username);
    await userEvent.type(username, 'ada_ok');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar username' }));
    expect(actions.onUpdateUsername).toHaveBeenLastCalledWith('ada_ok');
    expect(actions.onNotify).toHaveBeenCalledWith('Username actualizado.', 'success');

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    for (const expected of ['No pudimos actualizar tu perfil.', 'Profile update failed']) {
      const displayName = screen.getByRole('textbox', { name: 'Nombre visible' });
      await userEvent.clear(displayName);
      await userEvent.type(displayName, 'Ada Updated');
      await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(expected);
      await userEvent.clear(displayName);
    }
    await userEvent.type(screen.getByRole('textbox', { name: 'Nombre visible' }), 'Ada Final');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar perfil' })).not.toBeInTheDocument());
    expect(actions.onNotify).toHaveBeenCalledWith('Perfil actualizado.', 'success');
  });

  it('manages owned app visibility, info editing, deletion, and disabled unpublished actions', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    const published = socialApp(1, { shortDescription: 'Short', category: 'finance', visibility: 'restricted' });
    const suspended = socialApp(2, { status: 'suspended', description: 'Long fallback', latestVersion: { ...socialApp(2).latestVersion!, fileSizeBytes: 0 } });
    bridge.listMySocialApps.mockResolvedValue({ apps: [published, suspended] });
    bridge.getSocialProfile.mockResolvedValue({ profile: profile(1, 'ada'), apps: [published, suspended] });
    const actions = callbacks();
    renderSocial({ actions });

    expect(await screen.findByText('App 1')).toBeVisible();
    expect(screen.getByText('No publicada')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Abrir app' })[1]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: en.social.unpublishAction })[1]).toBeDisabled();
    await userEvent.click(screen.getAllByRole('button', { name: 'Abrir app' })[0]);
    expect(actions.onOpenSocialApp).toHaveBeenCalledWith(published);

    const visibility = screen.getAllByRole('combobox')[0];
    bridge.updateSocialAppVisibility.mockRejectedValueOnce(new Error('Visibility failed'));
    await userEvent.click(visibility);
    await userEvent.click(screen.getByRole('option', { name: en.social.visibility.friends }));
    await waitFor(() => expect(actions.onNotify).toHaveBeenCalledWith('Visibility failed', 'error'));
    bridge.updateSocialAppVisibility.mockResolvedValueOnce({ ...published, visibility: 'public' });
    await userEvent.click(visibility);
    await userEvent.click(screen.getByRole('option', { name: en.social.visibility.public }));
    await waitFor(() => expect(actions.onNotify).toHaveBeenCalledWith('Visibilidad actualizada.', 'success'));
    bridge.updateSocialAppVisibility.mockRejectedValueOnce('network');
    await userEvent.click(visibility);
    await userEvent.click(screen.getByRole('option', { name: en.social.visibility.friends }));
    await waitFor(() => expect(actions.onNotify).toHaveBeenCalledWith('No pudimos actualizar la visibilidad.', 'error'));

    bridge.updateSocialApp.mockRejectedValueOnce(new Error('Edit failed')).mockResolvedValueOnce({ ...published, name: 'Edited app' });
    await userEvent.click(screen.getAllByRole('button', { name: en.social.editAppInfoAction })[0]);
    const editDialog = screen.getByRole('dialog', { name: en.social.editAppInfoTitle });
    const name = within(editDialog).getByRole('textbox', { name: en.social.editAppNameLabel });
    await userEvent.clear(name);
    await userEvent.type(name, ' Edited app ');
    await userEvent.clear(within(editDialog).getByRole('textbox', { name: en.social.editAppShortDescriptionLabel }));
    await userEvent.type(within(editDialog).getByRole('textbox', { name: en.social.editAppShortDescriptionLabel }), ' New short ');
    await userEvent.clear(within(editDialog).getByRole('textbox', { name: en.social.editAppDescriptionLabel }));
    await userEvent.type(within(editDialog).getByRole('textbox', { name: en.social.editAppDescriptionLabel }), ' New long ');
    await userEvent.click(within(editDialog).getByRole('button', { name: en.actions.save }));
    expect(await within(editDialog).findByRole('alert')).toHaveTextContent('Edit failed');
    await userEvent.click(within(editDialog).getByRole('button', { name: en.actions.save }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.editAppInfoTitle })).not.toBeInTheDocument());
    expect(bridge.updateSocialApp).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'Edited app', shortDescription: 'New short', description: 'New long', longDescription: 'New long', category: 'finance', visibility: 'public',
    }));

    bridge.deleteSocialApp.mockRejectedValueOnce(new Error('Delete failed')).mockResolvedValueOnce(undefined);
    await userEvent.click(screen.getAllByRole('button', { name: en.social.unpublishAction })[0]);
    const deleteDialog = screen.getByRole('dialog', { name: en.social.unpublishTitle });
    await userEvent.click(within(deleteDialog).getByRole('button', { name: en.social.unpublishConfirmAction }));
    expect(await within(deleteDialog).findByText('Delete failed')).toBeVisible();
    await userEvent.click(within(deleteDialog).getByRole('button', { name: en.social.unpublishConfirmAction }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.unpublishTitle })).not.toBeInTheDocument());
    expect(actions.onNotify).toHaveBeenCalledWith(en.social.unpublishSuccess, 'success');
  });

  it('publishes eligible installed apps with selected metadata and handles empty candidates', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    const actions = callbacks();
    const candidates = [
      installedApp('one', { category: 'finance' }),
      installedApp('two', { category: 'utilities' }),
      installedApp('nameless', { name: undefined }),
      installedApp('installing', { status: 'installing' }),
      installedApp('public', { privateLocal: false }),
    ];
    renderSocial({ installedApps: candidates, actions });
    await userEvent.click(await screen.findByRole('button', { name: 'Subir app' }));
    const dialog = screen.getByRole('dialog', { name: en.social.uploadTitle });
    const selects = within(dialog).getAllByRole('combobox');
    await userEvent.click(selects[0]);
    await userEvent.click(screen.getByRole('option', { name: 'Local two' }));
    await userEvent.click(selects[1]);
    await userEvent.click(screen.getByRole('option', { name: en.appCategories.learning }));
    await userEvent.click(selects[2]);
    await userEvent.click(screen.getByRole('option', { name: en.social.uploadVisibility.public }));
    await userEvent.click(within(dialog).getByRole('button', { name: en.social.uploadAction }));
    expect(actions.onUploadSocial).toHaveBeenCalledWith('two', 'public', 'learning');

    const noUploadActions = callbacks();
    noUploadActions.onUploadSocial = undefined as never;
    const view = renderSocial({ actions: noUploadActions });
    const uploadButtons = screen.getAllByRole('button', { name: 'Subir app' });
    expect(uploadButtons.at(-1)).toBeDisabled();
    view.unmount();
  });

  it('covers guest profile guards and every visible account-name fallback in dark mode', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    const guest = renderSocial({ session: { authenticated: false }, dark: true });
    expect(screen.getByText('@sin-username')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Abrir' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copiar link' })).toBeDisabled();
    expect(bridge.listFriends).not.toHaveBeenCalled();
    guest.unmount();

    for (const [user, label] of [
      [{ displayName: undefined, firstName: 'Ada', username: 'ada' }, 'Ada'],
      [{ displayName: undefined, firstName: undefined, username: 'ada' }, '@ada'],
      [{ displayName: undefined, firstName: undefined, username: undefined }, '@'],
    ] as const) {
      window.sessionStorage.setItem('forger.social.last-tab', 'profile');
      const view = renderSocial({ session: account(user), dark: true });
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('handles app/profile loading failures, fallback links, and dialog cancellation', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    const appLoad = deferred<{ apps: SocialUserApp[] }>();
    bridge.listMySocialApps.mockReturnValueOnce(appLoad.promise);
    bridge.getSocialProfileUrl
      .mockRejectedValueOnce(new Error('URL failed'))
      .mockResolvedValueOnce('')
      .mockResolvedValue('https://forger.test/fallback');
    const actions = callbacks();
    actions.onUpdateProfile.mockRejectedValueOnce('network');
    renderSocial({ actions });
    expect(await screen.findByText('Cargando apps...')).toBeVisible();
    await act(async () => appLoad.reject(new Error('Apps offline')));
    expect(await screen.findByText('Apps offline')).toBeVisible();

    bridge.listMySocialApps.mockRejectedValueOnce('network');
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByText('No pudimos cargar tus apps.')).toBeVisible();
    bridge.listMySocialApps.mockResolvedValueOnce({ apps: [socialApp(9, { latestVersion: { ...socialApp(9).latestVersion!, fileSizeBytes: 512 } })] });
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByText('Version 1.2.3 · 512 B')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    expect(bridge.openExternalUrl).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://forger.test/fallback');
    await userEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    expect(writeText).toHaveBeenCalledWith('https://forger.test/fallback');

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByText('No pudimos actualizar tu perfil.')).toBeVisible();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Nombre visible' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar perfil' })).not.toBeInTheDocument());
  });

  it('does not copy an empty profile URL', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    bridge.getSocialProfileUrl.mockResolvedValue('');
    renderSocial();
    await userEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('clears form errors while editing and supports app dialog close paths and metadata selectors', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    const odd = socialApp(5, {
      category: 'not-real',
      visibility: 'restricted',
      shortDescription: undefined,
      description: 'Description fallback',
      longDescription: 'Long description',
    });
    bridge.listMySocialApps.mockResolvedValue({ apps: [odd] });
    bridge.getSocialProfile.mockResolvedValue({ profile: profile(1, 'ada'), apps: [odd] });
    bridge.updateSocialApp.mockRejectedValueOnce('network');
    bridge.deleteSocialApp.mockRejectedValueOnce('network');
    const actions = callbacks();
    renderSocial({ actions });
    expect(await screen.findByText('App 5')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: en.social.editAppInfoAction }));
    let dialog = screen.getByRole('dialog', { name: en.social.editAppInfoTitle });
    const fields = within(dialog);
    await userEvent.clear(fields.getByRole('textbox', { name: en.social.editAppNameLabel }));
    expect(fields.getByRole('button', { name: en.actions.save })).toBeDisabled();
    await userEvent.type(fields.getByRole('textbox', { name: en.social.editAppNameLabel }), 'Odd updated');
    const selects = fields.getAllByRole('combobox');
    await userEvent.click(selects[0]);
    await userEvent.click(screen.getByRole('option', { name: en.social.editAppCategoryEmpty }));
    await userEvent.click(selects[1]);
    await userEvent.click(screen.getByRole('option', { name: en.social.visibility.friends }));
    await userEvent.click(fields.getByRole('button', { name: en.actions.save }));
    expect(await fields.findByText(en.social.editAppInfoError)).toBeVisible();
    await userEvent.type(fields.getByRole('textbox', { name: en.social.editAppShortDescriptionLabel }), 'x');
    await userEvent.clear(fields.getByRole('textbox', { name: en.social.editAppShortDescriptionLabel }));
    expect(fields.queryByText(en.social.editAppInfoError)).not.toBeInTheDocument();
    await userEvent.click(fields.getByRole('button', { name: en.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.editAppInfoTitle })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: en.social.editAppInfoAction }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.editAppInfoTitle })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: en.social.editAppInfoAction }));
    dialog = screen.getByRole('dialog', { name: en.social.editAppInfoTitle });
    await userEvent.click(within(dialog).getAllByRole('combobox')[0]);
    await userEvent.click(screen.getByRole('option', { name: en.appCategories.health }));
    await userEvent.click(within(dialog).getByRole('button', { name: en.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.editAppInfoTitle })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: en.social.unpublishAction }));
    dialog = screen.getByRole('dialog', { name: en.social.unpublishTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: en.social.unpublishConfirmAction }));
    expect(await within(dialog).findByText(en.social.unpublishError)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: en.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.unpublishTitle })).not.toBeInTheDocument());
  });

  it('normalizes empty profile searches and non-Error friend/search failures', async () => {
    const actions = callbacks();
    bridge.listFriends.mockRejectedValueOnce('network').mockResolvedValueOnce([friendship(2, 'accepted', { friend: friendUser(2, 'grace'), unreadCount: 5 })]);
    renderSocial({ actions, initialProfileUsername: '@' });
    expect(await screen.findByText('No pudimos cargar tus amigos.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByText('grace')).toBeVisible();

    const search = screen.getByPlaceholderText('@username');
    fireEvent.submit(search.closest('form') as HTMLFormElement);
    expect(bridge.searchFriends).not.toHaveBeenCalled();
    await userEvent.type(search, 'grace');
    bridge.searchFriends.mockRejectedValueOnce(new Error('Search failed'));
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByText('Search failed')).toBeVisible();
  });

  it('keeps username and profile submissions single-flight and validates direct form submits', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    const usernameUpdate = deferred<boolean>();
    const profileUpdate = deferred<boolean>();
    const actions = callbacks();
    actions.onUpdateUsername.mockReturnValue(usernameUpdate.promise);
    actions.onUpdateProfile.mockReturnValue(profileUpdate.promise);
    renderSocial({ actions });

    const username = screen.getByRole('textbox', { name: 'Username' });
    const usernameForm = username.closest('form') as HTMLFormElement;
    await userEvent.clear(username);
    fireEvent.submit(usernameForm);
    expect(actions.onUpdateUsername).not.toHaveBeenCalled();
    await userEvent.type(username, 'ada_pending');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar username' }));
    fireEvent.submit(usernameForm);
    expect(actions.onUpdateUsername).toHaveBeenCalledOnce();
    await act(async () => usernameUpdate.resolve(true));

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const displayName = screen.getByRole('textbox', { name: 'Nombre visible' });
    const profileForm = displayName.closest('form') as HTMLFormElement;
    fireEvent.submit(profileForm);
    fireEvent.submit(profileForm);
    expect(actions.onUpdateProfile).toHaveBeenCalledOnce();
    await act(async () => profileUpdate.resolve(true));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar perfil' })).not.toBeInTheDocument());
  });

  it('closes profile, delete, and publish dialogs through their modal controls', async () => {
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    const app = socialApp(1);
    bridge.listMySocialApps.mockResolvedValue({ apps: [app] });
    const deletion = deferred<void>();
    bridge.deleteSocialApp.mockReturnValue(deletion.promise);
    renderSocial({ installedApps: [installedApp('one')] });
    expect(await screen.findByText('App 1')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar perfil' })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: en.social.unpublishAction }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.unpublishTitle })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: en.social.unpublishAction }));
    const deleteDialog = screen.getByRole('dialog', { name: en.social.unpublishTitle });
    await userEvent.click(within(deleteDialog).getByRole('button', { name: en.social.unpublishConfirmAction }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: en.social.unpublishTitle })).toBeVisible();
    await act(async () => deletion.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.unpublishTitle })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Subir app' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.uploadTitle })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Subir app' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: en.social.uploadTitle })).getByRole('button', { name: en.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.social.uploadTitle })).not.toBeInTheDocument());
  });

  it('routes an initial own profile and displays external-profile fallbacks without bio or surname', async () => {
    bridge.getSocialProfile.mockResolvedValue({ profile: profile(1, 'ada'), apps: [] });
    const own = renderSocial({ initialProfileUsername: '@ada' });
    expect(await screen.findByRole('tab', { name: en.social.tabs.profile })).toHaveAttribute('aria-selected', 'true');
    own.unmount();

    bridge.getSocialProfile.mockResolvedValue({ profile: profile(2, 'grace', { firstName: 'Grace' }), apps: [] });
    const external = renderSocial({ initialProfileUsername: 'grace', dark: true });
    expect(await screen.findByText('Grace')).toBeVisible();
    expect(screen.queryByText('Compiler pioneer')).not.toBeInTheDocument();
    external.unmount();
  });
});
