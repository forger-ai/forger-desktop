import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PersonalAgentWhatsAppChannelPolicy, WhatsAppAgentActivityItem } from '@shared/types';
import { WhatsAppConnectionManager } from '../../src/main/connections/modules/whatsapp/manager';
import { AgentWhatsAppPanel } from '@renderer/views/AgentWhatsAppPanel';
import { getDictionary } from '@renderer/i18n';
import { PolicyEditor } from '@renderer/views/whatsapp-agent-channel/PolicyEditor';
import { ActivityDialog } from '@renderer/views/whatsapp-agent-channel/ActivityDialog';
import { emptyPolicy, observedParticipants } from '@renderer/views/whatsapp-agent-channel/model';
import { copy } from '@renderer/views/whatsapp-agent-channel/copy';

const binding = { agentId: 'agent', connectionId: 'phone', chatId: 'chat' };
const request = (change: Partial<WhatsAppAgentActivityItem> = {}): WhatsAppAgentActivityItem => ({ requestId: 'request-1', runId: 'run', requestText: 'Summarize meetings', responseText: 'Complete response', authorId: 'person', isFromMe: false, createdAt: '2026-09-26T10:00:00Z', updatedAt: '2026-09-26T10:01:00Z', status: 'completed', deliveryState: 'sent', reason: null, conversationId: 'conversation', ...change });
const api = () => {
  const bridge = {
    personalAgentWhatsAppActivityList: vi.fn().mockResolvedValue([]),
    personalAgentWhatsAppRequestCancel: vi.fn().mockResolvedValue(undefined),
    personalAgentWhatsAppDeliveryRetry: vi.fn().mockResolvedValue(undefined),
    personalAgentWhatsAppRequestDismiss: vi.fn().mockResolvedValue(undefined),
    personalAgentWhatsAppPolicyOptionsGet: vi.fn().mockResolvedValue({ agent: { appIds: ['app'], toolIds: ['forger_chrome_extension.navigate', 'forger.memory'], connectionGrants: [{ type: 'mail', actions: ['read', 'send'], multiple: false, connectionIds: ['private-account'] }], peerAgentGrants: [{ agentId: 'peer' }], networkAccess: true }, memories: [{ id: 'memory', title: 'Chosen memory', content: 'Team meets Tuesdays' }] }),
    personalAgentGrantOptionsList: vi.fn().mockResolvedValue({ apps: [{ appId: 'app', name: 'Selected app' }, { appId: 'denied', name: 'Forbidden app' }], tools: [{ name: 'Browser', actions: [{ id: 'forger_chrome_extension.navigate', name: 'Open selected page' }, { id: 'denied.action', name: 'Forbidden tool' }, { id: 'forger.memory', name: 'Private memory tools' }] }], connections: [{ type: 'mail', displayName: 'Work mail', actions: [{ id: 'read', name: 'Read messages' }, { id: 'send', name: 'Send messages' }] }], peerAgents: [{ agentId: 'peer', name: 'Coworker' }, { agentId: 'other', name: 'Forbidden agent' }] }),
    filesPickForChat: vi.fn().mockResolvedValue([{ grantId: 'grant' }]),
    filesImport: vi.fn().mockResolvedValue([{ id: 'file', relativePath: 'shared/report.txt', name: 'Report', sizeBytes: 12, modifiedAt: '' }]),
  };
  Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
  return bridge;
};
function PolicyHarness({ english = true, initial = emptyPolicy() }: { english?: boolean; initial?: PersonalAgentWhatsAppChannelPolicy }) {
  const [policy, setPolicy] = useState(initial);
  return <><PolicyEditor agentId="agent" value={policy} onChange={setPolicy} disabled={false} english={english} /><output data-testid="policy">{JSON.stringify(policy)}</output></>;
}

describe('WhatsApp chat access and request recovery', () => {
  it('keeps web searches off by default and lets the owner opt in only with agent internet permission', async () => {
    const bridge = api(); const user = userEvent.setup();
    const view = render(<PolicyHarness />);
    const web = await screen.findByRole('switch', { name: 'Allow web searches' });
    expect(web).not.toBeChecked();
    expect(screen.getByText(/Queries may be sent to the search provider/)).toBeVisible();
    await user.click(web);
    expect(JSON.parse(screen.getByTestId('policy').textContent!).networkAccess).toBe(true);
    view.unmount();
    bridge.personalAgentWhatsAppPolicyOptionsGet.mockResolvedValue({ agent: { appIds: [], toolIds: [], connectionGrants: [], peerAgentGrants: [], networkAccess: false }, memories: [] });
    render(<PolicyHarness english={false} />);
    expect(await screen.findByRole('switch', { name: 'Permitir búsquedas en internet' })).toBeDisabled();
    expect(screen.getByText(/Agentes → este agente → Ajustes → Permitir internet/)).toBeVisible();
  });

  it('limits available choices to agent grants and explicitly selects information and actions', async () => {
    const bridge = api();
    const user = userEvent.setup();
    render(<PolicyHarness />);
    const choose = async (field: string, option: string) => { await user.click(await screen.findByRole('combobox', { name: field })); await user.click(screen.getByRole('option', { name: option })); await user.keyboard('{Escape}'); };
    await choose('Allowed apps', 'Selected app');
    await choose('Allowed tool actions', 'Browser · Open selected page');
    await choose('Allowed agents', 'Coworker');
    await choose('Memories shared with this chat', 'Chosen memory: Team meets Tuesdays');
    await user.click(screen.getByRole('checkbox', { name: 'Read messages' }));
    await user.click(screen.getByRole('checkbox', { name: 'Send messages' }));
    await user.click(screen.getByRole('checkbox', { name: 'Read messages' }));
    await user.click(screen.getByRole('button', { name: 'Choose files to share with this chat' }));
    await screen.findByText('Report');
    expect(bridge.filesImport).toHaveBeenCalledWith({ grantIds: ['grant'] });
    const policy = JSON.parse(screen.getByTestId('policy').textContent!);
    expect(policy).toMatchObject({ appIds: ['app'], toolIds: ['forger_chrome_extension.navigate'], peerAgentIds: ['peer'], sharedMemoryIds: ['memory'], networkAccess: false, connectionGrants: [{ type: 'mail', actions: ['send'], connectionIds: ['private-account'] }] });
    expect(policy.sharedFiles[0].name).toBe('Report');
    fireEvent.click(screen.getByText('Report').parentElement!.querySelector('svg')!);
    expect(JSON.parse(screen.getByTestId('policy').textContent!).sharedFiles).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: 'Send messages' }));
    expect(JSON.parse(screen.getByTestId('policy').textContent!).connectionGrants).toEqual([]);
    expect(screen.queryByText('Forbidden app')).not.toBeInTheDocument();
  });

  it('supports retrying failed permission discovery and canceled or failed file selection', async () => {
    const bridge = api();
    bridge.personalAgentWhatsAppPolicyOptionsGet.mockRejectedValueOnce(new Error('offline'));
    bridge.filesPickForChat.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('file unavailable'));
    const user = userEvent.setup(); render(<PolicyHarness english={false} />);
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('combobox', { name: 'Apps permitidas' });
    await user.click(screen.getByRole('button', { name: 'Elegir archivos para compartir con este chat' }));
    expect(bridge.filesImport).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Elegir archivos para compartir con este chat' }));
    expect(await screen.findByText('No pude cargar o compartir información.')).toBeVisible();
  });

  it('shows execution separately from delivery and provides only safe recovery actions', async () => {
    const bridge = api();
    const user = userEvent.setup();
    const open = vi.fn(); const close = vi.fn();
    bridge.personalAgentWhatsAppActivityList.mockResolvedValue([
      request({ requestId: 'queued', status: 'queued', responseText: null, deliveryState: null, conversationId: null }),
      request({ requestId: 'failed', status: 'failed', deliveryState: 'failed', canRetryDelivery: true, reason: 'run_failed' }),
      request({ requestId: 'unknown', deliveryState: 'unknown' }),
      request({ requestId: 'dismissed', status: 'dismissed' }),
      request({ requestId: 'interrupted', status: 'interrupted', deliveryState: null }),
    ]);
    render(<ActivityDialog binding={binding} c={copy.en} onClose={close} onOpenConversation={open} />);
    expect(await screen.findByText('The task failed. Open the conversation to review its result.')).toBeVisible();
    expect(screen.queryByText('run_failed')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Cancel task' }));
    expect(bridge.personalAgentWhatsAppRequestCancel).toHaveBeenCalledWith({ ...binding, requestId: 'queued' });
    await user.click(screen.getByRole('button', { name: 'Retry delivery' }));
    expect(bridge.personalAgentWhatsAppDeliveryRetry).toHaveBeenCalledWith({ ...binding, requestId: 'failed' });
    await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);
    expect(bridge.personalAgentWhatsAppRequestDismiss).toHaveBeenCalledWith({ ...binding, requestId: 'unknown' });
    await user.click(screen.getAllByRole('button', { name: 'Open full conversation' })[0]); expect(open).toHaveBeenCalledWith('conversation');
    await user.click(screen.getByRole('button', { name: 'Close' })); expect(close).toHaveBeenCalled();
  });

  it('recovers activity loading errors, surfaces action failure, and refreshes without resending', async () => {
    const bridge = api(); const user = userEvent.setup();
    bridge.personalAgentWhatsAppActivityList.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
    let poll: () => void = () => undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => { if (delay === 5000) poll = callback as () => void; return 1; });
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
    render(<ActivityDialog binding={binding} c={copy.es} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Todavía no hay solicitudes.')).toBeVisible();
    bridge.personalAgentWhatsAppActivityList.mockResolvedValue([request({ status: 'active', reason: 'private failure /Users/private-user/secret.txt TOKEN=private' })]);
    await act(async () => poll());
    expect(screen.queryByText(/private-user|TOKEN=private/)).not.toBeInTheDocument();
    expect(screen.getByText('La tarea o la entrega necesita revisión. Consulta la conversación para ver el resultado.')).toBeVisible();
    bridge.personalAgentWhatsAppRequestCancel.mockRejectedValueOnce(new Error('race'));
    await user.click(screen.getByRole('button', { name: 'Cancelar tarea' }));
    expect(await screen.findByText('No pude completar esta acción. Actualiza la actividad y reintenta.')).toBeVisible();
    expect(bridge.personalAgentWhatsAppDeliveryRetry).not.toHaveBeenCalled();
  });

  it('keeps safe fallbacks when permission labels disappear and no shared files were saved', async () => {
    const bridge = api(); const user = userEvent.setup();
    bridge.personalAgentGrantOptionsList.mockResolvedValue({ apps: [], tools: [], connections: [], peerAgents: [] });
    const initial = emptyPolicy(); delete initial.sharedFiles;
    render(<PolicyHarness initial={initial} />);
    await user.click(await screen.findByRole('checkbox', { name: 'read' }));
    await user.click(screen.getByRole('button', { name: 'Choose files to share with this chat' }));
    expect(await screen.findByText('Report')).toBeVisible();
  });

  it('ignores permission and activity responses after closing the panel', async () => {
    const bridge = api();
    let reject!: (reason: Error) => void;
    bridge.personalAgentWhatsAppPolicyOptionsGet.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const view = render(<PolicyHarness />); view.unmount();
    await act(async () => reject(new Error('late')));
    let resolve!: (items: WhatsAppAgentActivityItem[]) => void;
    bridge.personalAgentWhatsAppActivityList.mockReturnValue(new Promise((done) => { resolve = done; }));
    const activity = render(<ActivityDialog binding={binding} c={copy.en} onClose={vi.fn()} />); activity.unmount();
    await act(async () => resolve([]));
    bridge.personalAgentWhatsAppActivityList.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const failed = render(<ActivityDialog binding={binding} c={copy.es} onClose={vi.fn()} />); failed.unmount();
    await act(async () => reject(new Error('late')));
  });

  it('does not attach a file to a different chat when selection or import finishes after leaving', async () => {
    const bridge = api(); const user = userEvent.setup();
    let resolve!: (value: unknown) => void; let reject!: (cause: Error) => void;
    bridge.filesPickForChat.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const first = render(<PolicyHarness />);
    await user.click(screen.getByRole('button', { name: 'Choose files to share with this chat' })); first.unmount();
    await act(async () => resolve([{ grantId: 'late' }]));
    expect(bridge.filesImport).not.toHaveBeenCalled();
    bridge.filesImport.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const second = render(<PolicyHarness />);
    await user.click(screen.getByRole('button', { name: 'Choose files to share with this chat' })); second.unmount();
    await act(async () => resolve([{ id: 'late', relativePath: 'late', name: 'Late file' }]));
    bridge.filesPickForChat.mockReturnValueOnce(new Promise((_done, fail) => { reject = fail; }));
    const third = render(<PolicyHarness />);
    await user.click(screen.getByRole('button', { name: 'Choose files to share with this chat' })); third.unmount();
    await act(async () => reject(new Error('late')));
  });

  it('carries known contact names from the WhatsApp manager into participant choices while saving stable identities', async () => {
    const bridge = api(); const user = userEvent.setup();
    const chatId = '120363999999999@g.us'; const personId = '56912345678@s.whatsapp.net';
    const stored = new Map([[chatId, { chatId, chatType: 'group' }], [personId, { chatId: personId, chatType: 'direct', title: 'Known colleague' }]]);
    const manager = new WhatsAppConnectionManager({ getChat: async (id: string) => stored.get(id) } as never, async () => ({}));
    Object.assign(manager, { ensureStarted: async () => undefined, socket: { groupMetadata: async () => ({ participants: [{ id: personId }] }) } });
    const details = await manager.getChatDetails({} as never, { chatId });
    const save = vi.fn().mockImplementation(async (input) => ({ ...input, revision: 1, configurationVersion: 1 }));
    Object.assign(bridge, {
      connectionsList: vi.fn().mockResolvedValue({ instances: [{ id: 'phone', type: 'whatsapp', label: 'Phone', status: 'connected' }] }),
      personalAgentWhatsAppBindingsList: vi.fn().mockResolvedValue([]), personalAgentWhatsAppUnsettledList: vi.fn().mockResolvedValue([]), personalAgentWhatsAppLatestDeliveryGet: vi.fn().mockResolvedValue(null), personalAgentWhatsAppBindingPut: save,
      connectionsCall: vi.fn().mockImplementation(async ({ actionId }) => ({ success: true, data: actionId === 'whatsapp.list_chats' ? { chats: [{ chatId, chatType: 'group', title: 'Team' }] } : details })),
    });
    render(<AgentWhatsAppPanel agentId="agent" agentName="Ana" t={getDictionary('en')} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Chat' })).not.toBeDisabled());
    await user.click(screen.getByRole('combobox', { name: 'Chat' }));
    await user.click(await screen.findByRole('option', { name: 'Team' }));
    await user.click(screen.getByRole('combobox', { name: 'Who can assign tasks' }));
    await user.click(screen.getByRole('option', { name: 'Selected people' }));
    await user.click(await screen.findByRole('combobox', { name: 'People allowed to assign tasks' }));
    await user.click(await screen.findByRole('option', { name: 'Known colleague' }));
    await user.keyboard('{Escape}'); await user.click(screen.getByRole('button', { name: 'Save chat' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ participantsAllowed: [personId] }));
  });

  it('uses names when WhatsApp provides them and retains stable participant identities', () => {
    expect(observedParticipants({ type: 'direct', chat: { chatId: 'direct', title: 'Alex' } })).toEqual([{ id: 'direct', name: 'Alex' }]);
    expect(observedParticipants({ metadata: { participants: [{ id: 'one', name: 'Ana' }, { id: 'two', notify: 'Alex' }, { id: 'three' }, null] } })).toEqual([{ id: 'one', name: 'Ana' }, { id: 'two', name: 'Alex' }, { id: 'three', name: 'three' }]);
  });
});
