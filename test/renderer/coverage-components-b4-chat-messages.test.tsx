import { createRef } from 'react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessagesPanel } from '@renderer/views/chat/ChatMessagesPanel';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { ChatMessage } from '@renderer/views/ChatView';
import type { AgentRunActivity } from '@shared/types';

vi.mock('@renderer/components/AgentRunActivityReceipt', () => ({
  AgentRunActivityReceipt: ({ mode, emptyLabel }: { mode?: string; emptyLabel?: string }) => (
    <div data-testid={`activity-${mode ?? 'default'}`}>{emptyLabel ?? 'activity'}</div>
  ),
}));

vi.mock('@renderer/views/chat/MarkdownMessage', () => ({
  MarkdownMessage: ({ content }: { content: string }) => <div data-testid="markdown-message">{content}</div>,
}));

const t = en as unknown as AppDictionary;

const renderPanel = ({
  messages = [] as ChatMessage[],
  configured = true,
  isSending = false,
  openingAppIds = new Set<string>(),
  respondingPermissionIds = new Set<string>(),
  themeMode = 'light' as 'light' | 'dark',
} = {}) => {
  const handlers = {
    onConfigureIntelligenceProvider: vi.fn(),
    onOpenApp: vi.fn(),
    onRespondPermission: vi.fn(),
    onAutoScrollChange: vi.fn(),
  };
  const scrollRef = createRef<HTMLDivElement>();
  render(
    <ThemeProvider theme={createTheme({ palette: { mode: themeMode } })}>
      <ChatMessagesPanel
        messages={messages}
        conversationTitle="Planner chat"
        intelligenceProviderConfigured={configured}
        assistantAvatarSrc="assistant.png"
        isSending={isSending}
        progressLines={['Reviewing data']}
        activity={{} as AgentRunActivity}
        openingAppIds={openingAppIds}
        respondingPermissionIds={respondingPermissionIds}
        scrollRef={scrollRef}
        t={t}
        {...handlers}
      />
    </ThemeProvider>,
  );
  return { ...handlers, scrollRef };
};

const permissionMessage = (status?: 'pending' | 'approved' | 'denied'): ChatMessage => ({
  id: `permission-${status ?? 'default'}`,
  role: 'assistant',
  content: 'Permission required',
  action: {
    type: 'permission',
    runId: 'run-1',
    status,
    request: {
      requestId: `request-${status ?? 'default'}`,
      pluginId: 'files',
      permission: 'write',
      reason: 'Save the generated report.',
      risk: 'medium',
      resource: 'Planner files',
    },
  },
});

describe('ChatMessagesPanel', () => {
  it('guides an empty chat to configure intelligence and reports scroll position', async () => {
    const user = userEvent.setup();
    const handlers = renderPanel({ configured: false });

    expect(screen.getByText(t.sections.chat.intelligenceProviderMissingBody)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.sections.chat.configureIntelligenceProvider }));
    expect(handlers.onConfigureIntelligenceProvider).toHaveBeenCalledOnce();

    const scroller = handlers.scrollRef.current as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
      scrollTop: { configurable: true, writable: true, value: 56 },
    });
    fireEvent.scroll(scroller);
    expect(handlers.onAutoScrollChange).toHaveBeenLastCalledWith(true);
    scroller.scrollTop = 10;
    fireEvent.scroll(scroller);
    expect(handlers.onAutoScrollChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the configured introduction and live sending activity', () => {
    renderPanel({ configured: true, isSending: true });
    expect(screen.getByText(t.sections.chat.introBody)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.sections.chat.configureIntelligenceProvider })).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-live')).toHaveTextContent(t.sections.chat.agentThinking);
  });

  it('renders user files and assistant activity and opens an app when ready', async () => {
    const user = userEvent.setup();
    const messages: ChatMessage[] = [
      {
        id: 'user-files',
        role: 'user',
        content: 'Use these files',
        files: [
          { id: 'attached', name: 'very/long/report.pdf', relativePath: 'reports/report.pdf', displayPath: '/shared/report.pdf', sizeBytes: 2_048, source: 'attached' },
          { id: 'mentioned', name: 'notes.txt', relativePath: 'notes.txt', sizeBytes: 20, source: 'mentioned' },
        ],
      },
      {
        id: 'assistant-open',
        role: 'assistant',
        content: 'The planner is ready.',
        activity: {} as AgentRunActivity,
        action: { type: 'open-app', appId: 'planner', label: 'Open Planner' },
      },
    ];
    const handlers = renderPanel({ messages, themeMode: 'dark' });

    expect(screen.getByText(/report\.pdf · 2\.0 KB/).closest('.MuiChip-root')).toHaveAttribute('title', '/shared/report.pdf');
    expect(screen.getByText('@notes.txt').closest('.MuiChip-root')).toHaveAttribute('title', 'notes.txt');
    expect(screen.getByTestId('activity-completed')).toBeInTheDocument();
    expect(screen.getAllByTestId('markdown-message')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Open Planner' }));
    expect(handlers.onOpenApp).toHaveBeenCalledWith('planner');
  });

  it('disables an app action while it is opening', () => {
    renderPanel({
      messages: [{ id: 'opening', role: 'assistant', content: 'Opening', action: { type: 'open-app', appId: 'planner', label: 'Open Planner' } }],
      openingAppIds: new Set(['planner']),
    });
    expect(screen.getByRole('button', { name: t.actions.opening })).toBeDisabled();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('approves and denies pending permissions and renders responding, approved, and denied states', async () => {
    const user = userEvent.setup();
    const pending = permissionMessage();
    const explicitPending = permissionMessage('pending');
    const approved = permissionMessage('approved');
    const denied = permissionMessage('denied');
    const responseKey = `${explicitPending.action?.type === 'permission' ? explicitPending.action.runId : ''}:request-pending`;
    const handlers = renderPanel({
      messages: [pending, explicitPending, approved, denied],
      respondingPermissionIds: new Set([responseKey]),
    });

    expect(screen.getByText(t.sections.chat.permissionApproved)).toBeInTheDocument();
    expect(screen.getByText(t.sections.chat.permissionDenied)).toBeInTheDocument();
    expect(screen.getAllByText(t.sections.chat.permissionBadge)).toHaveLength(2);

    const pendingCard = screen.getAllByText('Permission required')[0]
      .closest('.MuiStack-root')
      ?.querySelector('.MuiPaper-root') as HTMLElement;
    await user.click(within(pendingCard as HTMLElement).getByRole('button', { name: t.sections.chat.permissionApprove }));
    await user.click(within(pendingCard as HTMLElement).getByRole('button', { name: t.sections.chat.permissionDeny }));
    expect(handlers.onRespondPermission.mock.calls).toEqual([
      ['run-1', 'request-default', 'allow'],
      ['run-1', 'request-default', 'deny'],
    ]);

    const respondingCard = screen.getAllByText('Save the generated report.')[1].closest('.MuiPaper-root') as HTMLElement;
    expect(within(respondingCard).getByRole('button', { name: t.sections.chat.permissionApprove })).toBeDisabled();
    expect(within(respondingCard).getByRole('button', { name: t.sections.chat.permissionDeny })).toBeDisabled();
    expect(within(respondingCard).getByRole('progressbar')).toBeInTheDocument();

    renderPanel({ messages: [permissionMessage('approved')], themeMode: 'dark' });
    expect(screen.getAllByText(t.sections.chat.permissionApproved)).toHaveLength(2);
  });

  it('renders a plain user message without files', () => {
    renderPanel({ messages: [{ id: 'plain-user', role: 'user', content: 'Hello' }] });
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-message')).not.toBeInTheDocument();
  });
});
