import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { getDictionary } from '@renderer/i18n';
import { AgentWhatsAppPanel } from '@renderer/views/AgentWhatsAppPanel';

const t = getDictionary('en');
const account = {
  id: 'whatsapp-one', type: 'whatsapp', label: 'Personal phone', status: 'connected',
  isDefault: true, createdAt: '', updatedAt: '',
};
const binding = {
  agentId: 'agent-one', connectionId: account.id, chatId: 'group-one',
  alias: 'Helper', ownerId: 'owner-one', enabled: true,
  purpose: 'Help the group', scope: 'Use the agent workspace',
  participantsAllowed: ['member-one'], allowAgentCapabilities: false,
  conversationId: 'conversation-one', revision: 4, activeTurnId: null,
};
const chats = [
  { chatId: 'group-one', title: 'Project group', chatType: 'group' },
  { chatId: 'direct-one', title: 'Direct chat', chatType: 'direct' },
  { chatId: 'channel-one', title: 'Broadcast channel', chatType: 'channel' },
  { chatId: 7, title: 'Invalid chat', chatType: 'direct' },
];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const makeApi = (options: {
  instances?: object[];
  bindings?: object[];
  unsettled?: object[];
  delivery?: object | null;
  listChats?: unknown;
  details?: unknown;
} = {}) => {
  const api = {
    connectionsList: vi.fn().mockResolvedValue({ instances: options.instances ?? [account] }),
    personalAgentWhatsAppBindingsList: vi.fn().mockResolvedValue(options.bindings ?? []),
    personalAgentWhatsAppUnsettledList: vi.fn().mockResolvedValue(options.unsettled ?? []),
    personalAgentWhatsAppLatestDeliveryGet: vi.fn().mockResolvedValue(options.delivery ?? null),
    personalAgentWhatsAppBindingPut: vi.fn().mockImplementation(async (input) => ({
      ...binding, ...input, revision: (input.expectedRevision ?? 0) + 1,
    })),
    personalAgentWhatsAppBindingDelete: vi.fn().mockResolvedValue(undefined),
    connectionsCall: vi.fn().mockImplementation(async ({ actionId }) => actionId === 'whatsapp.list_chats'
      ? { success: true, data: Object.hasOwn(options, 'listChats') ? options.listChats : { chats } }
      : { success: true, data: Object.hasOwn(options, 'details') ? options.details : { metadata: { participants: [{ id: 'member-one' }, { id: 'member-two' }, { id: 3 }] } } }),
  };
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
  return api;
};

const showPanel = () => render(<AgentWhatsAppPanel agentId="agent-one" agentName="Helper" t={t} />);

const chooseChat = async (user: ReturnType<typeof userEvent.setup>, name = 'Project group') => {
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Chat' })).not.toBeDisabled());
  await user.click(screen.getByRole('combobox', { name: 'Chat' }));
  await user.click(await screen.findByRole('option', { name }));
};

describe('AgentWhatsAppPanel', () => {
  it('starts disabled and explains when no WhatsApp account is connected', async () => {
    const api = makeApi({ instances: [{ ...account, status: 'disconnected' }, { ...account, id: 'slack-one', type: 'slack' }] });
    showPanel();
    expect(await screen.findByText('Connect WhatsApp in Connections to use this channel.')).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Allow automatic replies in this chat' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: /Allow the agent’s current capabilities/ })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Save chat' }));
    expect(screen.getByText('Choose an account and an observed chat.')).toBeVisible();
    expect(api.personalAgentWhatsAppBindingPut).not.toHaveBeenCalled();
  });

  it('validates a new chat, lets its group members be selected, and saves trimmed settings', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    showPanel();
    await chooseChat(user);
    expect(screen.queryByText('Broadcast channel')).not.toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: 'Activation word' }));
    await user.click(screen.getByRole('button', { name: 'Save chat' }));
    expect(screen.getByText('Enter an activation word.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Activation word' }), '  House  ');
    await user.click(screen.getByRole('switch', { name: 'Allow automatic replies in this chat' }));
    await user.click(screen.getByRole('button', { name: 'Save chat' }));
    expect(screen.getByText('Enter a purpose before enabling replies.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Purpose in this chat' }), '  Help with housing  ');
    await user.type(screen.getByRole('textbox', { name: 'Work instructions for this chat' }), '  Review listings  ');
    await user.click(screen.getByRole('switch', { name: /Allow the agent’s current capabilities/ }));
    await user.click(screen.getByRole('combobox', { name: 'People allowed to assign tasks' }));
    await user.click(await screen.findByRole('option', { name: 'member-two' }));
    await user.click(screen.getByRole('button', { name: 'Save chat' }));

    await waitFor(() => expect(api.personalAgentWhatsAppBindingPut).toHaveBeenCalledTimes(1));
    expect(api.personalAgentWhatsAppBindingPut).toHaveBeenCalledWith({
      agentId: 'agent-one', connectionId: account.id, chatId: 'group-one',
      alias: 'House', purpose: 'Help with housing', scope: 'Review listings',
      participantsAllowed: ['member-two'], allowAgentCapabilities: true, enabled: true,
    });
    expect(await screen.findByText('Settings saved.')).toBeVisible();
    expect(screen.getByText('Active')).toBeVisible();
  });

  it('loads existing work and delivery status, edits with the expected revision, then removes the chat', async () => {
    const user = userEvent.setup();
    const api = makeApi({
      bindings: [{ ...binding, activeTurnId: 'turn-one' }],
      unsettled: [{ agentId: binding.agentId, connectionId: binding.connectionId, chatId: binding.chatId, stableMessageRef: 'message-one', state: 'pending', turnId: null, revision: 4 }],
      delivery: { turnId: 'turn-before', revision: 3, state: 'sent', stableMessageRef: 'answer-one' },
    });
    showPanel();
    expect(await screen.findByText('Last reply sent')).toBeVisible();
    expect(screen.getByText('Working')).toBeVisible();
    expect(screen.getByText('Pending invocation')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Purpose in this chat' })).toHaveValue('Help the group');
    expect(screen.getByRole('switch', { name: 'Allow automatic replies in this chat' })).toHaveAttribute('aria-checked', 'true');
    await user.clear(screen.getByRole('textbox', { name: 'Activation word' }));
    await user.type(screen.getByRole('textbox', { name: 'Activation word' }), 'Advisor');
    await user.click(screen.getByRole('button', { name: 'Save chat' }));
    await waitFor(() => expect(api.personalAgentWhatsAppBindingPut).toHaveBeenCalledWith(expect.objectContaining({
      alias: 'Advisor', expectedRevision: 4, enabled: true,
    })));
    expect(await screen.findByText('Settings saved.')).toBeVisible();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: 'Remove chat' }));
    expect(api.personalAgentWhatsAppBindingDelete).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Remove chat' }));
    await waitFor(() => expect(api.personalAgentWhatsAppBindingDelete).toHaveBeenCalledWith({
      connectionId: account.id, chatId: 'group-one', agentId: 'agent-one',
    }));
    expect(await screen.findByText('Chat removed.')).toBeVisible();
    expect(screen.queryByText('Pending invocation')).not.toBeInTheDocument();
  });

  it.each([
    ['failed', 'Last reply failed'],
    ['unknown', 'Delivery unconfirmed'],
  ])('shows %s delivery state without claiming a confirmed send', async (state, label) => {
    makeApi({ bindings: [binding], delivery: { turnId: 'turn-one', revision: 4, state, stableMessageRef: null } });
    showPanel();
    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.queryByText('Last reply sent')).not.toBeInTheDocument();
  });

  it('shows save conflicts and delete failures while keeping the binding available to review', async () => {
    const user = userEvent.setup();
    const api = makeApi({ bindings: [binding] });
    showPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    api.personalAgentWhatsAppBindingPut
      .mockRejectedValueOnce(new Error('whatsapp_agent_binding_revision_conflict'))
      .mockRejectedValueOnce(new Error('whatsapp_agent_alias_conflict'))
      .mockRejectedValueOnce('unexpected failure');
    await user.click(screen.getByRole('button', { name: 'Save chat' }));
    expect(await screen.findByText('This chat changed while you were editing. Open it again to review before saving.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save chat' }));
    expect(await screen.findByText('Another agent already uses this activation word on this account.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save chat' }));
    expect(await screen.findByText('Could not save this chat.')).toBeVisible();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.personalAgentWhatsAppBindingDelete.mockRejectedValueOnce(new Error('delete failed'));
    await user.click(screen.getByRole('button', { name: 'Remove chat' }));
    expect(await screen.findByText('Could not remove this chat.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeVisible();
  });

  it('reports initial and observed-chat loading errors and retries a filtered search', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.connectionsList.mockRejectedValueOnce(new Error('connections unavailable'));
    const view = showPanel();
    expect(await screen.findByText('Could not load WhatsApp settings.')).toBeVisible();
    view.unmount();

    api.connectionsCall.mockResolvedValueOnce({ success: false });
    showPanel();
    expect(await screen.findByText('Could not load observed chats.')).toBeVisible();
    api.connectionsCall.mockResolvedValue({ success: true, data: { chats: [{ chatId: 'direct-one', title: 'Direct chat', chatType: 'direct' }] } });
    await user.type(screen.getByRole('textbox', { name: 'Search observed chats' }), '  Direct  ');
    await waitFor(() => expect(api.connectionsCall).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'whatsapp.list_chats', input: { limit: 100, query: 'Direct' },
    })));
    expect(screen.queryByText('Could not load observed chats.')).not.toBeInTheDocument();
  });

  it('refreshes status in place while keeping the editor open', async () => {
    const user = userEvent.setup();
    const nextBinding = { ...binding, enabled: false, activeTurnId: null, revision: 5 };
    const api = makeApi({ bindings: [binding], delivery: { turnId: 'turn-one', revision: 4, state: 'unknown', stableMessageRef: null } });
    let refresh: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 5_000) refresh = callback as () => void;
      return 1;
    });
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
    showPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Activation word' })).toHaveValue('Helper');
    api.personalAgentWhatsAppBindingsList.mockResolvedValue([nextBinding]);
    api.personalAgentWhatsAppLatestDeliveryGet.mockResolvedValue({ turnId: 'turn-two', revision: 5, state: 'sent', stableMessageRef: 'answer-two' });
    await act(async () => { refresh?.(); });
    expect(await screen.findByText('Paused')).toBeVisible();
    expect(screen.getByText('Last reply sent')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Activation word' })).toHaveValue('Helper');
  });

  it('offers observed direct chats, changes account, refreshes, and returns from edit to a new draft', async () => {
    const user = userEvent.setup();
    const second = { ...account, id: 'whatsapp-two', label: '', accountIdentity: { phoneNumber: '+1234567' } };
    const api = makeApi({ instances: [account, second], bindings: [binding], listChats: {
      chats: [
        { chatId: 'direct-one', phoneNumber: '+9876543', chatType: 'direct' },
        { chatId: 'direct-two', chatType: 'direct' },
      ],
    }, details: { type: 'direct', chat: { chatId: 'direct-one' } } });
    showPanel();
    await waitFor(() => expect(api.connectionsCall).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'whatsapp.list_chats' })));
    await user.click(screen.getByRole('combobox', { name: 'WhatsApp account' }));
    await user.click(await screen.findByRole('option', { name: '+1234567' }));
    await waitFor(() => expect(api.connectionsCall).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'whatsapp.list_chats', connectionId: 'whatsapp-two',
    })));
    await chooseChat(user, '+9876543');
    expect(await screen.findByRole('combobox', { name: 'People allowed to assign tasks' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Refresh chats' }));
    await waitFor(() => expect(api.connectionsCall.mock.calls.filter(([input]) => input.actionId === 'whatsapp.list_chats' && input.connectionId === 'whatsapp-two').length).toBeGreaterThan(1));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save chat' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Add chat' }));
    expect(screen.getByRole('textbox', { name: 'Activation word' })).toHaveValue('Helper');
    expect(screen.getByRole('switch', { name: 'Allow automatic replies in this chat' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Save chat' })).toBeEnabled();
  });

  it('handles malformed chat and participant data without offering unobserved destinations', async () => {
    const user = userEvent.setup();
    const api = makeApi({ listChats: { chats: [null, [], { chatId: 'direct-two', chatType: 'direct' }] }, details: null });
    showPanel();
    await chooseChat(user, 'direct-two');
    expect(screen.queryByRole('combobox', { name: 'People allowed to assign tasks' })).not.toBeInTheDocument();
    expect(api.personalAgentWhatsAppBindingPut).not.toHaveBeenCalled();
    api.connectionsCall.mockImplementation(async ({ actionId }) => actionId === 'whatsapp.list_chats'
      ? { success: true, data: null }
      : { success: true, data: { metadata: { participants: 'invalid' } } });
    await user.click(screen.getByRole('button', { name: 'Refresh chats' }));
    expect(await screen.findByText('No observed chats yet. Open a WhatsApp conversation and refresh the list.')).toBeVisible();
  });

  it('keeps a successful save even when follow-up status reads fail', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.personalAgentWhatsAppUnsettledList.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('status offline'));
    api.personalAgentWhatsAppLatestDeliveryGet.mockRejectedValueOnce(new Error('status offline'));
    showPanel();
    await chooseChat(user);
    await user.click(screen.getByRole('button', { name: 'Save chat' }));
    expect(await screen.findByText('Settings saved.')).toBeVisible();
    expect(screen.getByText('Paused')).toBeVisible();
    expect(api.personalAgentWhatsAppBindingPut).toHaveBeenCalledTimes(1);
  });

  it('ignores results from an initial load that finishes after leaving the agent', async () => {
    const gate = deferred<{ instances: object[] }>();
    const api = makeApi();
    api.connectionsList.mockReturnValueOnce(gate.promise);
    const view = showPanel();
    view.unmount();
    await act(async () => { gate.resolve({ instances: [account] }); });
    expect(api.personalAgentWhatsAppBindingPut).not.toHaveBeenCalled();
  });

  it('ignores late chat search and delivery results after unmount', async () => {
    const chatGate = deferred<{ success: boolean; data: unknown }>();
    const deliveryGate = deferred<unknown>();
    const api = makeApi({ bindings: [binding] });
    api.personalAgentWhatsAppLatestDeliveryGet.mockReturnValueOnce(deliveryGate.promise);
    const view = showPanel();
    await waitFor(() => expect(api.personalAgentWhatsAppLatestDeliveryGet).toHaveBeenCalled());
    view.unmount();
    await act(async () => {
      deliveryGate.resolve({ turnId: 'late', revision: 5, state: 'sent', stableMessageRef: null });
    });

    const laterApi = makeApi();
    laterApi.connectionsCall.mockImplementation(async ({ actionId }) => actionId === 'whatsapp.list_chats'
      ? await chatGate.promise
      : { success: true, data: null });
    const laterView = showPanel();
    await waitFor(() => expect(laterApi.connectionsCall).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'whatsapp.list_chats' })));
    laterView.unmount();
    await act(async () => { chatGate.resolve({ success: true, data: { chats } }); });
  });

  it('shows Spanish instructions and keeps orphaned bindings visible for safe removal', async () => {
    const user = userEvent.setup();
    makeApi({
      instances: [{ ...account, id: 'whatsapp-two', label: '', accountIdentity: {} }],
      bindings: [{ ...binding, connectionId: 'unavailable-account' }],
      listChats: { chats: [{ chatId: 'id-only', chatType: 'direct' }] },
    });
    render(<AgentWhatsAppPanel agentId="agent-one" agentName="Helper" t={getDictionary('es')} />);
    expect(await screen.findByText('La cuenta ya no está disponible.')).toBeVisible();
    expect(screen.getByText(/Helper ON/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.getByRole('button', { name: 'Guardar chat' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Agregar chat' }));
    await user.click(screen.getByRole('combobox', { name: 'Cuenta de WhatsApp' }));
    expect(await screen.findByRole('option', { name: 'whatsapp-two' })).toBeVisible();
  });

  it('does not submit an absent chat or a duplicate save while the first request is pending', async () => {
    const user = userEvent.setup();
    const saveGate = deferred<object>();
    const api = makeApi();
    api.personalAgentWhatsAppBindingPut.mockReturnValue(saveGate.promise);
    showPanel();
    await screen.findByText('Personal phone');
    const save = screen.getByRole('button', { name: 'Save chat' });
    fireEvent.click(save);
    expect(screen.getByText('Choose an account and an observed chat.')).toBeVisible();
    expect(api.personalAgentWhatsAppBindingPut).not.toHaveBeenCalled();
    await chooseChat(user);
    await user.click(screen.getByRole('button', { name: 'Save chat' }));
    await waitFor(() => expect(api.personalAgentWhatsAppBindingPut).toHaveBeenCalledTimes(1));
    const busySave = screen.getByRole('button', { name: 'Save chat' });
    expect(busySave).toBeDisabled();
    fireEvent.click(busySave);
    expect(api.personalAgentWhatsAppBindingPut).toHaveBeenCalledTimes(1);
    await act(async () => { saveGate.resolve({ ...binding, enabled: false }); });
  });

  it('preserves the binding when initial or polling delivery lookups fail', async () => {
    const api = makeApi({ bindings: [binding] });
    api.personalAgentWhatsAppLatestDeliveryGet.mockRejectedValue(new Error('delivery offline'));
    let refresh: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 5_000) refresh = callback as () => void;
      return 1;
    });
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
    showPanel();
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeVisible();
    expect(screen.queryByText('Last reply sent')).not.toBeInTheDocument();
    await act(async () => { refresh?.(); });
    expect(api.personalAgentWhatsAppLatestDeliveryGet).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Active')).toBeVisible();
  });

  it('keeps participant controls empty for missing metadata and failed detail reads', async () => {
    const user = userEvent.setup();
    makeApi({ details: {} });
    const view = showPanel();
    await chooseChat(user, 'Direct chat');
    expect(screen.queryByRole('combobox', { name: 'People allowed to assign tasks' })).not.toBeInTheDocument();
    view.unmount();

    const failedApi = makeApi();
    failedApi.connectionsCall.mockImplementation(async ({ actionId }) => actionId === 'whatsapp.list_chats'
      ? { success: true, data: { chats } }
      : Promise.reject(new Error('details unavailable')));
    showPanel();
    await chooseChat(user, 'Direct chat');
    expect(screen.queryByRole('combobox', { name: 'People allowed to assign tasks' })).not.toBeInTheDocument();
  });

  it('drops stale rejected loads, chat requests, and polling results after leaving the panel', async () => {
    const loadGate = deferred<{ instances: object[] }>();
    const api = makeApi();
    api.connectionsList.mockReturnValueOnce(loadGate.promise);
    const loading = showPanel();
    loading.unmount();
    await act(async () => { loadGate.reject(new Error('late load error')); });

    const chatGate = deferred<{ success: boolean; data: unknown }>();
    const chatApi = makeApi();
    chatApi.connectionsCall.mockImplementation(async ({ actionId }) => actionId === 'whatsapp.list_chats'
      ? await chatGate.promise
      : { success: false });
    const searching = showPanel();
    await waitFor(() => expect(chatApi.connectionsCall).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'whatsapp.list_chats' })));
    searching.unmount();
    await act(async () => { chatGate.reject(new Error('late search error')); });

    const pollGate = deferred<object[]>();
    const pollApi = makeApi({ bindings: [binding] });
    let refresh: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 5_000) refresh = callback as () => void;
      return 1;
    });
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
    const polling = showPanel();
    await screen.findByRole('button', { name: 'Edit' });
    pollApi.personalAgentWhatsAppBindingsList.mockReturnValueOnce(pollGate.promise);
    await act(async () => { refresh?.(); });
    polling.unmount();
    await act(async () => { pollGate.resolve([binding]); });
  });

  it('keeps unavailable accounts removable and resets to an empty account when none is connected', async () => {
    const user = userEvent.setup();
    const api = makeApi({ instances: [{ ...account, status: 'disconnected' }], bindings: [binding] });
    showPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Add chat' }));
    expect(screen.getByRole('combobox', { name: 'WhatsApp account' })).toHaveTextContent('​');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Remove chat' }));
    expect(await screen.findByText('Chat removed.')).toBeVisible();
    expect(api.personalAgentWhatsAppBindingDelete).toHaveBeenCalledTimes(1);
  });

  it('ignores unavailable detail results and rejected detail requests after leaving the panel', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.connectionsCall.mockImplementation(async ({ actionId }) => actionId === 'whatsapp.list_chats'
      ? { success: true, data: { chats } }
      : { success: false });
    const first = showPanel();
    await chooseChat(user, 'Direct chat');
    expect(screen.queryByRole('combobox', { name: 'People allowed to assign tasks' })).not.toBeInTheDocument();
    first.unmount();

    const detailsGate = deferred<unknown>();
    const laterApi = makeApi();
    laterApi.connectionsCall.mockImplementation(async ({ actionId }) => actionId === 'whatsapp.list_chats'
      ? { success: true, data: { chats } }
      : await detailsGate.promise);
    const later = showPanel();
    await chooseChat(user, 'Direct chat');
    await waitFor(() => expect(laterApi.connectionsCall).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'whatsapp.get_chat_details' })));
    later.unmount();
    await act(async () => { detailsGate.reject(new Error('late details error')); });
  });
});
