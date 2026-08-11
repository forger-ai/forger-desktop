import { ThemeProvider, createTheme } from '@mui/material/styles';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FriendChatWindowView } from '@renderer/views/FriendChatWindowView';
import type {
  CloudMessage,
  CloudSocialEvent,
  ForgerAccountSession,
  SocialUserApp,
} from '@shared/types';

const account = (overrides: Partial<ForgerAccountSession> = {}): ForgerAccountSession => ({
  authenticated: true,
  user: {
    id: 1,
    email: 'me@example.test',
    username: 'me',
    firstName: 'Me',
    lastName: 'User',
    confirmed: true,
    subscriptionTier: 'free',
  },
  ...overrides,
});

const participant = (id: number, username: string) => ({ id, username, firstName: username });

const textMessage = (
  id: number | undefined,
  plaintext: string | undefined,
  overrides: Partial<CloudMessage> = {},
): CloudMessage => ({
  id,
  type: 'CloudTextMessage',
  sender: participant(2, 'friend'),
  recipient: participant(1, 'me'),
  deliveryMode: 'persistent',
  source: 'user',
  status: 'stored',
  metadata: {},
  envelopes: [],
  plaintext,
  localState: 'received',
  createdAt: '2026-08-10T10:00:00.000Z',
  ...overrides,
});

const appShareMessage = (
  id: number | undefined,
  detail: {
    appId: number;
    name: string;
    kind: 'public_app' | 'friends_link' | 'friend_link';
    available?: boolean;
    code?: string;
    revokedAt?: string;
  },
  overrides: Partial<CloudMessage> = {},
): CloudMessage => ({
  id,
  type: 'CloudAppShareMessage',
  sender: participant(2, 'friend'),
  recipient: participant(1, 'me'),
  deliveryMode: 'persistent',
  source: 'user',
  status: 'stored',
  metadata: {},
  envelopes: [],
  createdAt: '2026-08-10T10:00:00.000Z',
  appShare: {
    id: detail.appId + 100,
    userAppId: detail.appId,
    shareKind: detail.kind,
    appVisibilityAtSend: 'public',
    appNameSnapshot: detail.name,
    appSlugSnapshot: detail.name.toLowerCase().replaceAll(' ', '-'),
    appOwnerUsernameSnapshot: 'builder',
    app: {
      id: detail.appId,
      status: 'published',
      visibility: 'public',
      available: detail.available ?? true,
    },
    share: detail.code || detail.revokedAt ? {
      id: detail.appId + 200,
      scope: 'friend',
      code: detail.code,
      revokedAt: detail.revokedAt,
      usedCount: 0,
    } : undefined,
  },
  ...overrides,
} as CloudMessage);

const socialApp = (id: number, name: string): SocialUserApp => ({
  id,
  slug: name.toLowerCase(),
  name,
  visibility: 'public',
  status: 'published',
  owner: { id: 1, username: 'me' },
});

const installForger = ({
  messages = [] as CloudMessage[],
  listCloudMessages = vi.fn().mockResolvedValue(messages),
  listMySocialApps = vi.fn().mockResolvedValue({ apps: [] }),
} = {}) => {
  let socialListener: ((event: CloudSocialEvent) => void) | undefined;
  const removeSocialListener = vi.fn();
  const api = {
    listCloudMessages,
    markFriendChatRead: vi.fn().mockResolvedValue({}),
    onCloudFriendshipEvent: vi.fn((listener: (event: CloudSocialEvent) => void) => {
      socialListener = listener;
      return removeSocialListener;
    }),
    sendCloudMessage: vi.fn(),
    listMySocialApps,
    sendCloudAppShareMessage: vi.fn(),
    installSocialApp: vi.fn(),
  };
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
  return { api, removeSocialListener, emit: (event: CloudSocialEvent) => socialListener?.(event) };
};

const renderChat = (session = account()) => render(
  <ThemeProvider theme={createTheme()}>
    <FriendChatWindowView
      account={session}
      friendUserId={2}
      friendUsername="friend"
      friendDisplayName="Friend Person"
    />
  </ThemeProvider>,
);

const cloudEvent = (message: CloudMessage, type: 'cloud_message' | 'ephemeral_cloud_message' = 'cloud_message') => ({
  type,
  message,
} as CloudSocialEvent);

const appCard = (name: string) => screen.getByText(name).closest('.MuiPaper-root') as HTMLElement;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

describe('FriendChatWindowView session and conversation lifecycle', () => {
  it('shows the friend identity and a fully disabled guest experience with accessible actions', async () => {
    const desktop = installForger();
    const view = renderChat({ authenticated: false });

    expect(screen.getByText('Friend Person')).toBeInTheDocument();
    expect(screen.getByText('@friend')).toBeInTheDocument();
    expect(screen.getByText('F')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Inicia sesión en Forger Cloud');
    expect(screen.getByRole('button', { name: 'Compartir app' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enviar mensaje' })).toBeDisabled();
    window.dispatchEvent(new Event('focus'));
    expect(desktop.api.listCloudMessages).not.toHaveBeenCalled();
    expect(desktop.api.markFriendChatRead).not.toHaveBeenCalled();
    view.unmount();
    expect(desktop.removeSocialListener).toHaveBeenCalledOnce();
  });

  it('treats an unconfirmed account like a signed-out session', async () => {
    const desktop = installForger();
    renderChat(account({ user: { ...account().user!, confirmed: false } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Inicia sesión en Forger Cloud');
    expect(desktop.api.listCloudMessages).not.toHaveBeenCalled();
    expect(desktop.api.markFriendChatRead).not.toHaveBeenCalled();
  });

  it('loads in timestamp order, marks reads on mount/focus, follows the bottom, and stops following after scrolling away', async () => {
    const first = textMessage(1, 'First', { createdAt: '2026-08-10T09:00:00.000Z' });
    const second = textMessage(2, 'Second', { createdAt: '2026-08-10T11:00:00.000Z' });
    const desktop = installForger({ messages: [second, first] });
    const view = renderChat();

    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getByText('First').compareDocumentPosition(screen.getByText('Second')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
    await waitFor(() => expect(desktop.api.markFriendChatRead).toHaveBeenCalledWith(2));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(desktop.api.markFriendChatRead).toHaveBeenCalledTimes(2));

    const scrollContainer = screen.getByText('First').closest('.MuiBox-root') as HTMLElement;
    Object.defineProperties(scrollContainer, {
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 200 },
    });
    fireEvent.scroll(scrollContainer);
    const callsBeforeEvent = vi.mocked(HTMLElement.prototype.scrollTo).mock.calls.length;
    await act(async () => desktop.emit(cloudEvent(textMessage(3, 'Third'))));
    expect(screen.getByText('Third')).toBeInTheDocument();
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledTimes(callsBeforeEvent);

    Object.defineProperty(scrollContainer, 'scrollTop', { configurable: true, value: 710 });
    fireEvent.scroll(scrollContainer);
    await act(async () => desktop.emit(cloudEvent(textMessage(4, 'Fourth'))));
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledTimes(callsBeforeEvent + 1);
    view.unmount();
    expect(desktop.removeSocialListener).toHaveBeenCalledOnce();
  });

  it('recovers from load errors by retry or an incoming event and filters unrelated events', async () => {
    const listCloudMessages = vi.fn()
      .mockRejectedValueOnce(new Error('Conversation offline'))
      .mockResolvedValueOnce([]);
    const desktop = installForger({ listCloudMessages });
    renderChat();

    expect(await screen.findByRole('alert')).toHaveTextContent('Conversation offline');
    await act(async () => desktop.emit({ type: 'friendship_changed' } as CloudSocialEvent));
    await act(async () => desktop.emit(cloudEvent(textMessage(7, 'Wrong peer', { sender: participant(9, 'other') }))));
    expect(screen.queryByText('Wrong peer')).not.toBeInTheDocument();

    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await act(async () => desktop.emit(cloudEvent(textMessage(8, 'Incoming event'))));
    expect(screen.getByText('Incoming event')).toBeInTheDocument();
    expect(screen.queryByText('Conversation offline')).not.toBeInTheDocument();
  });

  it('shows fallback load errors, tolerates read-receipt failures, and retries to the empty conversation', async () => {
    const user = userEvent.setup();
    const listCloudMessages = vi.fn().mockRejectedValueOnce('offline').mockResolvedValueOnce([]);
    const desktop = installForger({ listCloudMessages });
    desktop.api.markFriendChatRead.mockRejectedValue(new Error('receipt delayed'));
    renderChat();
    expect(await screen.findByText('No pudimos cargar esta conversación.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Aún no hay mensajes')).toBeInTheDocument();
  });

  it('ignores events without a signed-in user and merges both incoming and outgoing peer events by identity', async () => {
    const desktop = installForger();
    const guestView = renderChat({ authenticated: false });
    await act(async () => desktop.emit(cloudEvent(textMessage(1, 'Ignored guest event'))));
    expect(screen.queryByText('Ignored guest event')).not.toBeInTheDocument();
    guestView.unmount();

    const live = installForger({ messages: [textMessage(11, 'Old copy')] });
    renderChat();
    expect(await screen.findByText('Old copy')).toBeInTheDocument();
    await act(async () => live.emit(cloudEvent(textMessage(11, 'Updated copy'), 'ephemeral_cloud_message')));
    expect(screen.queryByText('Old copy')).not.toBeInTheDocument();
    expect(screen.getByText('Updated copy')).toBeInTheDocument();
    const outgoing = textMessage(undefined, 'Outgoing event', {
      clientMessageId: 'client-live',
      sender: participant(1, 'me'),
      recipient: participant(2, 'friend'),
    });
    await act(async () => live.emit(cloudEvent(outgoing)));
    expect(screen.getByText('Outgoing event')).toBeInTheDocument();
    await act(async () => live.emit(cloudEvent(textMessage(undefined, 'Identity-free event'))));
    expect(screen.getByText('Identity-free event')).toBeInTheDocument();
    expect(live.api.markFriendChatRead).toHaveBeenCalled();
  });
});

describe('FriendChatWindowView text messaging', () => {
  it('sends a trimmed optimistic message with Enter, prevents duplicate input, and replaces it with the server copy', async () => {
    const user = userEvent.setup();
    const sent = Promise.withResolvers<CloudMessage>();
    const desktop = installForger();
    desktop.api.sendCloudMessage.mockReturnValue(sent.promise);
    renderChat();
    expect(await screen.findByText('Aún no hay mensajes')).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Mensaje' });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(desktop.api.sendCloudMessage).not.toHaveBeenCalled();
    await user.type(input, '  Hola  ');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(desktop.api.sendCloudMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Hola')).toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    const payload = desktop.api.sendCloudMessage.mock.calls[0][0];
    expect(payload).toMatchObject({ recipientUserId: 2, text: 'Hola', delivery: 'persistent', source: 'user' });
    expect(payload.clientMessageId).toEqual(expect.any(String));

    sent.resolve(textMessage(55, 'Hola recibida', {
      clientMessageId: payload.clientMessageId,
      sender: participant(1, 'me'),
      recipient: participant(2, 'friend'),
      localState: 'sent',
    }));
    expect(await screen.findByText('Hola recibida')).toBeInTheDocument();
    expect(screen.queryByText('Hola')).not.toBeInTheDocument();
    expect(input).toBeEnabled();
  });

  it('restores failed text and exposes Error and non-Error send failures', async () => {
    const user = userEvent.setup();
    const desktop = installForger();
    desktop.api.sendCloudMessage
      .mockRejectedValueOnce(new Error('Message rejected'))
      .mockRejectedValueOnce('network down');
    renderChat(account({ user: { ...account().user!, username: undefined } }));
    expect(await screen.findByText('Aún no hay mensajes')).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Mensaje' });

    await user.type(input, 'First failure');
    await user.click(screen.getByRole('button', { name: 'Enviar mensaje' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Message rejected');
    expect(input).toHaveValue('First failure');

    await user.clear(input);
    await user.type(input, 'Second failure');
    await user.click(screen.getByRole('button', { name: 'Enviar mensaje' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos enviar el mensaje.');
  });

  it('creates a fallback client identity when secure random values are unavailable', async () => {
    const user = userEvent.setup();
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const desktop = installForger();
    desktop.api.sendCloudMessage.mockImplementation(async (input: { clientMessageId: string; text: string }) => textMessage(90, input.text, {
      clientMessageId: input.clientMessageId,
      sender: participant(1, 'me'),
      recipient: participant(2, 'friend'),
      localState: 'sent',
    }));
    renderChat();
    await screen.findByText('Aún no hay mensajes');

    try {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      await user.type(screen.getByRole('textbox', { name: 'Mensaje' }), 'Fallback identity');
      await user.click(screen.getByRole('button', { name: 'Enviar mensaje' }));
      await waitFor(() => expect(desktop.api.sendCloudMessage).toHaveBeenCalledOnce());
    } finally {
      if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    }
  });

  it('renders text delivery variants, encrypted fallbacks, timestamps, and identity fallbacks', async () => {
    const messages = [
      textMessage(1, 'Pending', { sender: participant(1, 'me'), recipient: participant(2, 'friend'), localState: 'pending' }),
      textMessage(2, 'Sent', { sender: participant(1, 'me'), recipient: participant(2, 'friend'), localState: 'sent' }),
      textMessage(3, 'Failed', { sender: participant(1, 'me'), recipient: participant(2, 'friend'), localState: 'failed' }),
      textMessage(4, undefined, { sender: participant(1, 'me'), recipient: participant(2, 'friend'), localState: 'sent' }),
      textMessage(undefined, undefined, { clientMessageId: 'opaque-client', createdAt: 'invalid' }),
      textMessage(undefined, 'Identity free', { createdAt: '' }),
      textMessage(6, '   '),
    ];
    installForger({ messages });
    renderChat();
    expect(await screen.findByText('Pending')).toBeInTheDocument();
    expect(screen.getAllByText('No se pudo desencriptar este mensaje en este dispositivo.')).toHaveLength(2);
    expect(screen.getByText('Identity free')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('CheckRoundedIcon')).toHaveLength(2);
    expect(screen.getByTestId('ErrorOutlineRoundedIcon')).toBeInTheDocument();
  });
});

describe('FriendChatWindowView app sharing', () => {
  it('loads shared apps, labels the selector, sends the selected app, blocks dialog close while sending, and cancels after reopening', async () => {
    const user = userEvent.setup();
    const apps = [socialApp(10, 'Planner'), socialApp(20, 'Journal')];
    const appsLoad = Promise.withResolvers<{ apps: SocialUserApp[] }>();
    const shareSend = Promise.withResolvers<CloudMessage>();
    const listMySocialApps = vi.fn().mockReturnValueOnce(appsLoad.promise).mockResolvedValue({ apps });
    const desktop = installForger({ listMySocialApps });
    desktop.api.sendCloudAppShareMessage.mockReturnValue(shareSend.promise);
    renderChat();
    expect(await screen.findByText('Aún no hay mensajes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Compartir app' }));
    expect(screen.getByText('Cargando tus apps compartidas.')).toBeInTheDocument();
    appsLoad.resolve({ apps });
    const selector = await screen.findByRole('combobox', { name: 'App para compartir' });
    await user.click(selector);
    await user.click(screen.getByRole('option', { name: 'Journal' }));
    await user.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(desktop.api.sendCloudAppShareMessage).toHaveBeenCalledWith({ recipientUserId: 2, userAppId: 20 });
    expect(screen.getByRole('button', { name: 'Compartiendo...' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    shareSend.resolve(appShareMessage(80, { appId: 20, name: 'Journal', kind: 'public_app' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Journal')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Compartir app' }));
    expect(await screen.findByRole('combobox', { name: 'App para compartir' })).toHaveTextContent('Journal');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows empty, Error, and fallback app-list states', async () => {
    const user = userEvent.setup();
    const listMySocialApps = vi.fn()
      .mockResolvedValueOnce({ apps: [] })
      .mockRejectedValueOnce(new Error('Apps offline'))
      .mockRejectedValueOnce('offline');
    installForger({ listMySocialApps });
    renderChat();
    expect(await screen.findByText('Aún no hay mensajes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Compartir app' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sube una app a Social');
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Compartir app' }));
    expect(await screen.findByText('Apps offline')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Compartir app' }));
    expect(await screen.findByText('No pudimos cargar tus apps compartidas.')).toBeInTheDocument();
  });

  it('keeps the dialog open for Error and fallback share-send failures', async () => {
    const user = userEvent.setup();
    const desktop = installForger({ listMySocialApps: vi.fn().mockResolvedValue({ apps: [socialApp(10, 'Planner')] }) });
    desktop.api.sendCloudAppShareMessage
      .mockRejectedValueOnce(new Error('Share rejected'))
      .mockRejectedValueOnce('offline');
    renderChat();
    await screen.findByText('Aún no hay mensajes');
    await user.click(screen.getByRole('button', { name: 'Compartir app' }));
    await screen.findByRole('combobox', { name: 'App para compartir' });
    await user.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Share rejected');
    await user.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos compartir esta app.');
  });

  it('renders every app-share state and installs public and direct shares with success, failure, retry, and exceptions', async () => {
    const user = userEvent.setup();
    const publicShare = appShareMessage(101, { appId: 10, name: 'Public App', kind: 'public_app' }, {
      plaintext: 'Try this app',
      sender: participant(1, 'me'),
      recipient: participant(2, 'friend'),
    });
    const friendShare = appShareMessage(undefined, { appId: 20, name: 'Friend App', kind: 'friends_link', code: 'FRIEND20' });
    const fallbackKeyShare = appShareMessage(undefined, { appId: 30, name: 'Private App', kind: 'friend_link', code: 'PRIVATE30' });
    const revoked = appShareMessage(104, { appId: 40, name: 'Revoked App', kind: 'friend_link', code: 'OLD', revokedAt: '2026-08-10T10:00:00.000Z' });
    const unavailable = appShareMessage(105, { appId: 50, name: 'Gone App', kind: 'friends_link', available: false });
    const missingCode = appShareMessage(106, { appId: 60, name: 'No Code App', kind: 'friend_link' });
    const deferredInstall = Promise.withResolvers<{ success: boolean; phase: 'completed'; userMessage: string }>();
    const desktop = installForger({ messages: [publicShare, friendShare, fallbackKeyShare, revoked, unavailable, missingCode] });
    desktop.api.installSocialApp
      .mockReturnValueOnce(deferredInstall.promise)
      .mockResolvedValueOnce({ success: true, phase: 'completed', userMessage: '' })
      .mockResolvedValueOnce({ success: false, phase: 'failed', userMessage: 'Install rejected' })
      .mockResolvedValueOnce({ success: false, phase: 'failed', userMessage: '' })
      .mockRejectedValueOnce(new Error('Installer offline'))
      .mockRejectedValueOnce('offline');
    renderChat();
    expect(await screen.findByText('Public App')).toBeInTheDocument();
    expect(screen.getByText('Try this app')).toBeInTheDocument();
    expect(screen.getByText('Link revocado')).toBeInTheDocument();
    expect(screen.getByText('No disponible')).toBeInTheDocument();
    expect(screen.getAllByText('Disponible')).toHaveLength(4);
    expect(screen.getByText('Pública')).toBeInTheDocument();
    expect(screen.getAllByText('Amigos')).toHaveLength(2);
    expect(screen.getAllByText('Privada')).toHaveLength(3);
    expect(within(appCard('Revoked App')).getByRole('button', { name: 'Instalar' })).toBeDisabled();
    expect(within(appCard('Gone App')).getByRole('button', { name: 'Instalar' })).toBeDisabled();
    expect(within(appCard('No Code App')).getByRole('button', { name: 'Instalar' })).toBeDisabled();

    const publicInstall = within(appCard('Public App')).getByRole('button', { name: 'Instalar' });
    await user.click(publicInstall);
    expect(desktop.api.installSocialApp).toHaveBeenCalledWith({ appId: 10 }, navigator.language);
    expect(within(appCard('Public App')).getByRole('button', { name: 'Instalando...' })).toBeDisabled();
    expect(desktop.api.installSocialApp).toHaveBeenCalledTimes(1);
    deferredInstall.resolve({ success: true, phase: 'completed', userMessage: 'Installed Public' });
    expect(await within(appCard('Public App')).findByRole('alert')).toHaveTextContent('Installed Public');

    await user.click(within(appCard('Public App')).getByRole('button', { name: 'Instalar' }));
    expect(await within(appCard('Public App')).findByRole('alert')).toHaveTextContent('App instalada.');
    await user.click(within(appCard('Friend App')).getByRole('button', { name: 'Instalar' }));
    expect(desktop.api.installSocialApp).toHaveBeenCalledWith({ shareCode: 'FRIEND20' }, navigator.language);
    expect(await within(appCard('Friend App')).findByRole('alert')).toHaveTextContent('Install rejected');
    await user.click(within(appCard('Friend App')).getByRole('button', { name: 'Instalar' }));
    expect(await within(appCard('Friend App')).findByRole('alert')).toHaveTextContent('No pudimos instalar esta app.');
    await user.click(within(appCard('Private App')).getByRole('button', { name: 'Instalar' }));
    expect(await within(appCard('Private App')).findByRole('alert')).toHaveTextContent('Installer offline');
    await user.click(within(appCard('Private App')).getByRole('button', { name: 'Instalar' }));
    expect(await within(appCard('Private App')).findByRole('alert')).toHaveTextContent('No pudimos instalar esta app.');
  });
});
