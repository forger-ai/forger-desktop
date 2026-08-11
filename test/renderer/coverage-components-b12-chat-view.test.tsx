import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView, type ChatMessage, type ConversationHistoryItem } from '@renderer/views/ChatView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { ForgerFileRecord, PickedChatFile, WindowControlState } from '@shared/types';
import type { RuntimeProviderControl, RuntimeProviderControls } from '@renderer/runtime-provider-controls';

vi.mock('@renderer/views/chat/ChatMessagesPanel', () => ({
  ChatMessagesPanel: (props: {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messages: ChatMessage[];
    isSending: boolean;
    respondingPermissionIds: Set<string>;
    onRespondPermission: (runId: string, requestId: string, decision: 'allow' | 'deny') => void;
    onAutoScrollChange: (enabled: boolean) => void;
  }) => (
    <div
      data-testid="messages-panel"
      data-message-count={props.messages.length}
      data-sending={String(props.isSending)}
      data-responding={String(props.respondingPermissionIds.has('run-1:permission-1'))}
      ref={props.scrollRef}
    >
      <button onClick={() => props.onRespondPermission('run-1', 'permission-1', 'allow')}>mock allow</button>
      <button onClick={() => props.onAutoScrollChange(false)}>mock pause scroll</button>
      <button onClick={() => props.onAutoScrollChange(true)}>mock resume scroll</button>
    </div>
  ),
}));

vi.mock('@renderer/views/chat/QuestionComposer', () => ({
  QuestionComposer: (props: {
    action: Extract<NonNullable<ChatMessage['action']>, { type: 'question' }>;
    isResponding: boolean;
    onRespondQuestion: (
      runId: string,
      request: Extract<NonNullable<ChatMessage['action']>, { type: 'question' }>['request'],
      response: { answers: [] },
    ) => void;
  }) => (
    <div data-testid="question-composer" data-request-id={props.action.request.requestId} data-responding={String(props.isResponding)}>
      <button onClick={() => props.onRespondQuestion(props.action.runId, props.action.request, { answers: [] })}>
        mock answer
      </button>
    </div>
  ),
}));

const t = en as unknown as AppDictionary;
type Props = React.ComponentProps<typeof ChatView>;
const now = '2026-08-10T12:00:00.000Z';
const NativeFileReader = window.FileReader;

const runtimeControl = (prefix: string): RuntimeProviderControl => ({
  modelOptions: [
    { displayModelName: `${prefix} Fast`, realModelName: `${prefix}-fast`, defaultEffort: 'low' },
    { displayModelName: `${prefix} Pro`, realModelName: `${prefix}-pro`, defaultEffort: 'high' },
  ],
  selectedModel: `${prefix}-fast`,
  onSelectModel: vi.fn(),
  effortOptions: [
    { label: 'Low', value: 'low' },
    { label: 'High', value: 'high' },
  ],
  selectedEffort: 'low',
  onSelectEffort: vi.fn(),
  effortOptionsForModel: vi.fn().mockReturnValue([
    { label: 'Low', value: 'low' },
    { label: 'High', value: 'high' },
  ]),
  normalizeEffortForModel: vi.fn().mockImplementation((_model, effort) => effort),
});

const runtimeControls = (): RuntimeProviderControls => ({
  codex: runtimeControl('codex'),
  claude: runtimeControl('claude'),
  antigravity: runtimeControl('google'),
});

const file = (id: string, overrides: Partial<ForgerFileRecord> = {}): ForgerFileRecord => ({
  id,
  name: `${id}.txt`,
  relativePath: `notes/${id}.txt`,
  categoryPath: 'notes',
  sizeBytes: 12,
  uploadedAt: now,
  modifiedAt: now,
  type: 'text/plain',
  ...overrides,
});

const pendingFile = (id: string): PickedChatFile => ({
  grantId: id,
  name: `${id}-very-long-file-name.txt`,
  sizeBytes: 20,
  modifiedAt: now,
  type: 'text/plain',
});

const handlers = () => ({
  onOpenConversation: vi.fn(),
  onDeleteConversation: vi.fn(),
  onStartNewConversation: vi.fn(),
  onNotifyForger: vi.fn(),
  onInputChange: vi.fn(),
  onSend: vi.fn(),
  onUploadCategoryChange: vi.fn(),
  onPickFiles: vi.fn(),
  onStagePastedFile: vi.fn().mockResolvedValue(undefined),
  onCreateUploadCategory: vi.fn(),
  onRemovePendingFile: vi.fn(),
  onMentionFile: vi.fn(),
  onRemoveMentionedFile: vi.fn(),
  onSelectProvider: vi.fn(),
  onSelectPermissionMode: vi.fn(),
  onSelectNetworkAccess: vi.fn(),
  onConfigureIntelligenceProvider: vi.fn(),
  onOpenApp: vi.fn(),
  onInstallReviewedSocialApp: vi.fn(),
  onDeleteReviewedSocialApp: vi.fn(),
  onStopRun: vi.fn().mockResolvedValue(undefined),
  onRespondPermission: vi.fn().mockResolvedValue(undefined),
  onRespondQuestion: vi.fn().mockResolvedValue(undefined),
});

const baseProps = (): Props => ({
  t,
  conversationTitle: 'Forger chat',
  activeConversationId: 'active-chat',
  historyItems: [],
  onOpenConversation: vi.fn(),
  onDeleteConversation: vi.fn(),
  onStartNewConversation: vi.fn(),
  onNotifyForger: vi.fn(),
  chatMode: 'free_chat',
  targetAppId: null,
  installedApps: [
    { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed', privateLocal: true },
    { id: 'running', name: 'Running app', category: 'utilities', status: 'running' },
  ],
  getAppMeta: (appId) => ({ name: appId === 'planner' ? 'Planner' : `App ${appId}`, description: `Description ${appId}` }),
  messages: [],
  inputValue: '',
  onInputChange: vi.fn(),
  onSend: vi.fn(),
  pendingFiles: [],
  mentionedFiles: [],
  availableFiles: [file('report'), file('roadmap'), file('image', { name: 'photo.png', type: 'image/png', categoryPath: '' })],
  fileCategories: [{ path: 'notes', name: 'Notes', parentPath: '' }],
  uploadCategoryPath: '',
  onUploadCategoryChange: vi.fn(),
  onPickFiles: vi.fn(),
  onStagePastedFile: vi.fn().mockResolvedValue(undefined),
  onCreateUploadCategory: vi.fn(),
  onRemovePendingFile: vi.fn(),
  onMentionFile: vi.fn(),
  onRemoveMentionedFile: vi.fn(),
  providerOptions: [
    { label: 'Automatic', value: 'auto' },
    { label: 'ChatGPT', value: 'codex' },
    { label: 'Claude', value: 'claude' },
    { label: 'Google', value: 'antigravity' },
  ],
  selectedProvider: 'auto',
  resolvedProviderForAuto: 'codex',
  onSelectProvider: vi.fn(),
  providerLocked: false,
  runtimeProviderControls: runtimeControls(),
  selectedPermissionMode: 'safe',
  onSelectPermissionMode: vi.fn(),
  selectedNetworkAccess: false,
  onSelectNetworkAccess: vi.fn(),
  assistantAvatarSrc: 'assistant.svg',
  isSending: false,
  isResponding: false,
  canStopRun: false,
  progressLines: [],
  intelligenceProviderConfigured: true,
  onConfigureIntelligenceProvider: vi.fn(),
  openingAppIds: new Set(),
  onOpenApp: vi.fn(),
  onInstallReviewedSocialApp: vi.fn(),
  onDeleteReviewedSocialApp: vi.fn(),
  onStopRun: vi.fn().mockResolvedValue(undefined),
  onRespondPermission: vi.fn().mockResolvedValue(undefined),
  onRespondQuestion: vi.fn().mockResolvedValue(undefined),
  ...handlers(),
});

const renderChat = (overrides: Partial<Props> = {}) => {
  const props = { ...baseProps(), ...overrides } as Props;
  return { ...render(<ChatView {...props} />), props };
};

const choose = async (user: ReturnType<typeof userEvent.setup>, select: HTMLElement, name: string) => {
  await user.click(select);
  const options = await screen.findAllByRole('option');
  const option = options.find((candidate) => candidate.textContent?.includes(name));
  expect(option).toBeDefined();
  await user.click(option!);
};

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
  Object.defineProperty(window, 'FileReader', { configurable: true, value: NativeFileReader });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(true) });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: vi.fn().mockReturnValue({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
});

describe('ChatView history and top-level actions', () => {
  const history = (): ConversationHistoryItem[] => [
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `create-${index}`,
      title: `Create ${index}`,
      threadId: `thread-${index}`,
      updatedAt: new Date(Date.parse(now) - index * 60_000).toISOString(),
      appId: 'forger',
      mode: 'create_app' as const,
    })),
    { id: 'review', title: 'Review app', threadId: null, updatedAt: '2026-08-10T12:01:00.000Z', appId: 'forger', mode: 'social_app_review' },
    { id: 'free', title: 'Free chat', threadId: null, updatedAt: now, appId: 'forger', mode: 'free_chat' },
    { id: 'legacy', title: 'Legacy chat', threadId: null, updatedAt: 'invalid', appId: 'forger' },
    { id: 'app-a', title: 'Planner A', threadId: null, updatedAt: now, appId: 'planner', mode: 'edit_app', targetAppId: 'planner' },
    { id: 'app-b', title: 'Planner B', threadId: null, updatedAt: now, appId: 'planner', mode: 'edit_app' },
  ];

  it('groups, sorts, expands, collapses, deletes, and opens conversation history', async () => {
    const user = userEvent.setup();
    const view = renderChat({ historyItems: history(), activeConversationId: 'create-0' });
    await user.click(screen.getByRole('button', { name: t.sections.chat.showHistoryTooltip }));
    expect(await screen.findByText(t.sections.chat.historyGroups.createApps)).toBeInTheDocument();
    expect(screen.getByText(t.sections.chat.historyGroups.reviewApps)).toBeInTheDocument();
    expect(screen.getAllByText(t.sections.chat.historyGroups.freeChat).length).toBeGreaterThan(0);
    expect(screen.getByText('Planner')).toBeInTheDocument();
    expect(screen.getByText('Create 0')).toBeInTheDocument();
    expect(screen.queryByText('Create 6')).not.toBeInTheDocument();
    await user.click(screen.getByText(t.sections.chat.showMoreHistory));
    expect(screen.getByText('Create 6')).toBeInTheDocument();
    await user.click(screen.getByText(t.sections.chat.historyGroups.createApps));
    expect(screen.queryByText('Create 0')).not.toBeInTheDocument();
    await user.click(screen.getByText(t.sections.chat.historyGroups.createApps));
    const createRow = screen.getByText('Create 0').closest('li') as HTMLElement;
    await user.click(within(createRow).getAllByRole('button')[1]!);
    expect(view.props.onDeleteConversation).toHaveBeenCalledWith('create-0');
    await user.click(screen.getByText('Create 1'));
    expect(view.props.onOpenConversation).toHaveBeenCalledWith('create-1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('renders empty history and delegates social review, notify, and new-chat actions', async () => {
    const user = userEvent.setup();
    const view = renderChat({ chatMode: 'social_app_review', historyItems: [] });
    await user.click(screen.getByRole('button', { name: t.sections.chat.showHistoryTooltip }));
    expect(await screen.findByText(t.sections.chat.noHistory)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: t.social.reviewInstallAction }));
    await user.click(screen.getByRole('button', { name: t.social.reviewDeleteAction }));
    await user.click(screen.getByRole('button', { name: t.sections.chat.notifyForger }));
    await user.click(screen.getByRole('button', { name: t.sections.chat.newConversation }));
    expect(view.props.onInstallReviewedSocialApp).toHaveBeenCalledOnce();
    expect(view.props.onDeleteReviewedSocialApp).toHaveBeenCalledOnce();
    expect(view.props.onNotifyForger).toHaveBeenCalledOnce();
    expect(view.props.onStartNewConversation).toHaveBeenCalledOnce();
  });
});

describe('ChatView conversation setup and runtime controls', () => {
  it('walks incomplete setup, selects each mode, requires an edit target, and sends mode overrides', async () => {
    const user = userEvent.setup();
    const view = renderChat({
      activeConversationId: null,
      chatMode: undefined,
      installedApps: [],
      historyItems: [],
      intelligenceProviderConfigured: false,
    });
    expect(screen.getByText(t.sections.chat.setup.title)).toBeInTheDocument();
    await user.click(screen.getByText(t.sections.chat.setup.connectTitle));
    await user.click(screen.getByText(t.sections.chat.setup.createTitle));
    await user.click(screen.getByText(t.sections.chat.setup.chatTitle));
    expect(view.props.onConfigureIntelligenceProvider).toHaveBeenCalledOnce();
    await choose(user, screen.getByRole('combobox', { name: t.sections.chat.modeSelector.label }), t.sections.chat.modeSelector.options.edit_app.title);
    expect(screen.getByText(t.sections.chat.modeSelector.noInstalledApps)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.sections.chat.send })).not.toBeInTheDocument();
    view.unmount();

    const configured = renderChat({ activeConversationId: null, chatMode: undefined, inputValue: 'Build it' });
    await choose(user, screen.getByRole('combobox', { name: t.sections.chat.modeSelector.label }), t.sections.chat.modeSelector.options.edit_app.title);
    const appSelect = screen.getByRole('combobox', { name: t.sections.chat.modeSelector.appLabel });
    expect(appSelect).toHaveTextContent(t.sections.chat.modeSelector.appPlaceholder);
    expect(screen.getByRole('button', { name: t.sections.chat.send })).toBeDisabled();
    await choose(user, appSelect, 'Planner');
    await user.click(screen.getByRole('button', { name: t.sections.chat.send }));
    expect(configured.props.onSend).toHaveBeenCalledWith({ mode: 'edit_app', targetAppId: 'planner' });
  });

  it('hides a completed setup checklist and resets the draft when conversation identity changes', async () => {
    const user = userEvent.setup();
    const view = renderChat({
      activeConversationId: null,
      chatMode: undefined,
      historyItems: [{ id: 'past', title: 'Past', threadId: null, updatedAt: now, appId: 'forger', mode: 'free_chat' }],
      targetAppId: 'planner',
      inputValue: 'Start',
    });
    expect(screen.queryByText(t.sections.chat.setup.title)).not.toBeInTheDocument();
    await choose(user, screen.getByRole('combobox', { name: t.sections.chat.modeSelector.label }), t.sections.chat.modeSelector.options.edit_app.title);
    expect(screen.getByRole('combobox', { name: t.sections.chat.modeSelector.appLabel })).toHaveTextContent('Planner');
    view.rerender(<ChatView {...view.props} activeConversationId="next" targetAppId={null} />);
    expect(screen.getByRole('combobox', { name: t.sections.chat.modeSelector.label })).toHaveTextContent(t.sections.chat.modeSelector.options.create_app.title);
  });

  it('changes provider, permissions, network, model, and effort while respecting locked and sending states', async () => {
    const user = userEvent.setup();
    const controls = runtimeControls();
    const view = renderChat({ runtimeProviderControls: controls });
    await choose(user, screen.getByRole('combobox', { name: t.sections.chat.providerSelectorLabel }), 'Claude');
    await choose(user, screen.getByRole('combobox', { name: t.sections.chat.permissionSelectorLabel }), t.sections.chat.permissionElevatedLabel);
    await choose(user, screen.getByRole('combobox', { name: t.sections.chat.networkSelectorLabel }), t.sections.chat.networkEnabledLabel);
    await choose(user, screen.getByRole('combobox', { name: t.sections.chat.modelSelectorLabel }), 'codex Pro');
    await choose(user, screen.getByRole('combobox', { name: t.sections.chat.effortSelectorLabel }), 'High');
    expect(view.props.onSelectProvider).toHaveBeenCalledWith('claude');
    expect(view.props.onSelectPermissionMode).toHaveBeenCalledWith('unsafe');
    expect(view.props.onSelectNetworkAccess).toHaveBeenCalledWith(true);
    expect(controls.codex.onSelectModel).toHaveBeenCalledWith('codex-pro');
    expect(controls.codex.onSelectEffort).toHaveBeenCalledWith('high');
    view.unmount();

    renderChat({
      selectedProvider: 'claude',
      providerOptions: [{ label: 'Automatic', value: 'auto' }, { label: 'ChatGPT', value: 'codex' }],
      providerLocked: true,
      isSending: true,
    });
    expect(screen.getByRole('combobox', { name: t.sections.chat.providerSelectorLabel })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('combobox', { name: t.sections.chat.permissionSelectorLabel })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('combobox', { name: t.sections.chat.networkSelectorLabel })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('combobox', { name: t.sections.chat.modelSelectorLabel })).toHaveAttribute('aria-disabled', 'true');
  });

  it('renders direct and automatic provider fallbacks plus elevated network state', () => {
    const direct = renderChat({ selectedProvider: 'codex', selectedPermissionMode: 'unsafe', selectedNetworkAccess: true });
    expect(screen.getByRole('combobox', { name: t.sections.chat.providerSelectorLabel })).toHaveTextContent('ChatGPT');
    expect(screen.getByRole('combobox', { name: t.sections.chat.permissionSelectorLabel })).toHaveTextContent(t.sections.chat.permissionElevatedLabel);
    expect(screen.getByRole('combobox', { name: t.sections.chat.networkSelectorLabel })).toHaveTextContent(t.sections.chat.networkEnabledLabel);
    direct.unmount();

    renderChat({
      providerOptions: [{ label: 'Automatic', value: 'auto' }],
      selectedProvider: 'auto',
      resolvedProviderForAuto: 'codex',
    });
    expect(screen.getByRole('combobox', { name: t.sections.chat.providerSelectorLabel })).toHaveTextContent('codex');
  });

  it('renders the composer surface in dark mode', () => {
    const props = baseProps();
    render(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <ChatView {...props} />
      </ThemeProvider>,
    );
    expect(screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder })).toBeInTheDocument();
  });
});

describe('ChatView composer, response, and run behavior', () => {
  const questionRequest = (requestId: string) => ({
    requestId,
    chatId: 'chat-1',
    createdAt: now,
    questions: [{
      id: 'question-1',
      question: 'Choose a direction',
      options: [{ id: 'safe', label: 'Safe', description: 'Use safe mode' }],
    }],
  });

  it('shows provider configuration before the input and delegates both setup actions', async () => {
    const user = userEvent.setup();
    const view = renderChat({ intelligenceProviderConfigured: false });
    expect(screen.getByText(t.sections.chat.inputProviderMissingTitle)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: t.sections.chat.inputPlaceholder })).not.toBeInTheDocument();
    const configureButtons = screen.getAllByRole('button', { name: t.sections.chat.inputProviderMissingAction });
    await user.click(configureButtons[0]!);
    expect(view.props.onConfigureIntelligenceProvider).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: t.sections.chat.send })).not.toBeInTheDocument();
  });

  it('mirrors controlled text, syncs edits, sends with Enter, preserves Shift+Enter, and sends by button', async () => {
    const user = userEvent.setup();
    const view = renderChat({ inputValue: 'Prefilled prompt' });
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    await waitFor(() => expect(input).toHaveTextContent('Prefilled prompt'));
    input.textContent = 'Typed   text\nnext';
    fireEvent.input(input);
    expect(view.props.onInputChange).toHaveBeenLastCalledWith('Typed text\nnext');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(view.props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(view.props.onSend).toHaveBeenCalledWith(undefined);
    await user.click(screen.getByRole('button', { name: t.sections.chat.send }));
    expect(view.props.onSend).toHaveBeenCalledTimes(2);
  });

  it('clears controlled text, preserves managed mention nodes, and ignores Enter while sending', async () => {
    const report = file('report');
    const view = renderChat({ inputValue: 'External draft' });
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    await waitFor(() => expect(input).toHaveTextContent('External draft'));
    view.rerender(<ChatView {...view.props} inputValue="" />);
    await waitFor(() => expect(input).toHaveTextContent(''));

    const chip = document.createElement('span');
    chip.dataset.fileChip = 'true';
    chip.dataset.fileChipId = report.id;
    chip.textContent = '@report.txt';
    input.appendChild(chip);
    view.rerender(<ChatView {...view.props} inputValue="changed outside" mentionedFiles={[report]} />);
    expect(input.querySelector('[data-file-chip-id="report"]')).not.toBeNull();
    fireEvent.input(input);
    expect(view.props.onRemoveMentionedFile).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(view.props.onSend).toHaveBeenCalledWith(undefined);

    view.rerender(<ChatView {...view.props} inputValue="blocked" isSending mentionedFiles={[]} />);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(view.props.onSend).toHaveBeenCalledTimes(1);
  });

  it('supports pending attachments, category controls, empty-text send, and attachment removal', async () => {
    const user = userEvent.setup();
    const pending = pendingFile('grant-1');
    const view = renderChat({ pendingFiles: [pending], uploadCategoryPath: 'notes' });
    const attach = screen.getByTestId('AttachFileRoundedIcon').closest('button') as HTMLButtonElement;
    const createCategory = screen.getByTestId('AddRoundedIcon').closest('button') as HTMLButtonElement;
    await user.click(attach);
    await user.click(createCategory);
    expect(view.props.onPickFiles).toHaveBeenCalledOnce();
    expect(view.props.onCreateUploadCategory).toHaveBeenCalledOnce();
    const categorySelect = screen.getAllByRole('combobox')[0]!;
    await choose(user, categorySelect, t.sections.chat.rootCategory);
    expect(view.props.onUploadCategoryChange).toHaveBeenCalledWith('');
    await user.click(screen.getByRole('button', { name: t.sections.chat.send }));
    expect(view.props.onSend).toHaveBeenCalledWith(undefined);
    await user.click(screen.getByTestId('CloseRoundedIcon'));
    expect(view.props.onRemovePendingFile).toHaveBeenCalledWith('grant-1');
  });

  it('sends from Enter when only pending or mentioned files provide content', () => {
    const pendingView = renderChat({ pendingFiles: [pendingFile('pending-only')] });
    fireEvent.keyDown(screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder }), { key: 'Enter' });
    expect(pendingView.props.onSend).toHaveBeenCalledOnce();
    pendingView.unmount();

    const mentionedView = renderChat({ mentionedFiles: [file('mentioned-only')] });
    fireEvent.keyDown(screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder }), { key: 'Enter' });
    expect(mentionedView.props.onSend).toHaveBeenCalledOnce();
  });

  it('renders only the latest pending assistant question and prevents duplicate answers until completion', async () => {
    const user = userEvent.setup();
    let resolveAnswer!: () => void;
    const pendingAnswer = new Promise<void>((resolve) => { resolveAnswer = resolve; });
    const onRespondQuestion = vi.fn().mockReturnValue(pendingAnswer);
    const messages: ChatMessage[] = [
      { id: 'answered', role: 'assistant', content: '', action: { type: 'question', runId: 'run-old', request: questionRequest('old'), status: 'answered' } },
      { id: 'user-question', role: 'user', content: '', action: { type: 'question', runId: 'run-user', request: questionRequest('user') } },
      { id: 'pending', role: 'assistant', content: '', action: { type: 'question', runId: 'run-new', request: questionRequest('latest') } },
    ];
    renderChat({ messages, onRespondQuestion });
    const composer = screen.getByTestId('question-composer');
    expect(composer).toHaveAttribute('data-request-id', 'latest');
    const answer = screen.getByRole('button', { name: 'mock answer' });
    await user.click(answer);
    await user.click(answer);
    expect(onRespondQuestion).toHaveBeenCalledOnce();
    expect(composer).toHaveAttribute('data-responding', 'true');
    await act(async () => resolveAnswer());
    await waitFor(() => expect(composer).toHaveAttribute('data-responding', 'false'));
    await user.click(answer);
    expect(onRespondQuestion).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: t.sections.chat.send })).not.toBeInTheDocument();
  });

  it('locks duplicate permission responses and maintains auto-scroll preference across updates', async () => {
    const user = userEvent.setup();
    const onRespondPermission = vi.fn().mockResolvedValue(undefined);
    const view = renderChat({ onRespondPermission, messages: [{ id: 'one', role: 'assistant', content: 'One' }] });
    const panel = screen.getByTestId('messages-panel');
    Object.defineProperties(panel, {
      scrollHeight: { configurable: true, value: 480 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    view.rerender(<ChatView {...view.props} messages={[...view.props.messages, { id: 'two', role: 'assistant', content: 'Two' }]} />);
    expect(panel.scrollTop).toBe(480);
    await user.click(screen.getByRole('button', { name: 'mock pause scroll' }));
    panel.scrollTop = 100;
    view.rerender(<ChatView {...view.props} messages={[...view.props.messages, { id: 'three', role: 'assistant', content: 'Three' }]} />);
    expect(panel.scrollTop).toBe(100);
    await user.click(screen.getByRole('button', { name: 'mock resume scroll' }));
    view.rerender(<ChatView {...view.props} isResponding progressLines={['Working']} />);
    expect(panel.scrollTop).toBe(480);
    const allow = screen.getByRole('button', { name: 'mock allow' });
    await user.click(allow);
    await user.click(allow);
    expect(onRespondPermission).toHaveBeenCalledOnce();
    expect(panel).toHaveAttribute('data-responding', 'true');
  });

  it('stops an active response once and restores the control after the promise settles', async () => {
    const user = userEvent.setup();
    let resolveStop!: () => void;
    const pendingStop = new Promise<void>((resolve) => { resolveStop = resolve; });
    const onStopRun = vi.fn().mockReturnValue(pendingStop);
    renderChat({ isResponding: true, canStopRun: true, onStopRun });
    const stop = screen.getByRole('button', { name: t.sections.chat.stopResponse });
    await user.click(stop);
    expect(onStopRun).toHaveBeenCalledOnce();
    expect(stop).toBeDisabled();
    await act(async () => resolveStop());
    await waitFor(() => expect(stop).toBeEnabled());
  });
});

describe('ChatView inline file mentions and clipboard input', () => {
  const setComposerCaret = (input: HTMLElement, text: string, offset = text.length) => {
    input.textContent = text;
    const textNode = input.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return range;
  };

  const paste = (input: HTMLElement, items: Array<{
    kind: string;
    type: string;
    getAsFile: () => File | null;
  }>, text = '') => {
    fireEvent.paste(input, {
      clipboardData: {
        items,
        getData: (type: string) => type === 'text/plain' ? text : '',
      },
    });
  };

  it('filters mention suggestions, inserts a semantic chip at the caret, and removes it', async () => {
    const user = userEvent.setup();
    const view = renderChat();
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    const range = setComposerCaret(input, 'Ask @rep');
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 240, left: 160, right: 160, bottom: 240, width: 0, height: 0, x: 160, y: 240, toJSON: () => ({}) }),
    });
    Object.defineProperty(input.parentElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, left: 20, right: 620, bottom: 300, width: 600, height: 200, x: 20, y: 100, toJSON: () => ({}) }),
    });
    fireEvent.input(input);
    expect(await screen.findByText('report.txt')).toBeInTheDocument();
    expect(screen.queryByText('roadmap.txt')).not.toBeInTheDocument();
    await user.click(screen.getByText('report.txt'));
    expect(view.props.onMentionFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'report' }));
    await waitFor(() => expect(input.querySelector('[data-file-chip-id="report"]')).not.toBeNull());
    const remove = input.querySelector<HTMLElement>('[data-file-chip-remove]')!;
    await user.click(remove);
    expect(view.props.onRemoveMentionedFile).toHaveBeenCalledWith('report');
    expect(input.querySelector('[data-file-chip-id="report"]')).toBeNull();
  });

  it('shows empty and capped mention results and prunes externally removed mention chips', async () => {
    const inputFiles = Array.from({ length: 10 }, (_, index) => file(`hit-${index}`, { categoryPath: index === 0 ? '' : 'notes' }));
    const mentioned = file('attached');
    const view = renderChat({ availableFiles: inputFiles, mentionedFiles: [mentioned] });
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    setComposerCaret(input, '@missing');
    fireEvent.input(input);
    expect(await screen.findByText(t.sections.files.noFiles)).toBeInTheDocument();
    expect(view.props.onRemoveMentionedFile).toHaveBeenCalledWith('attached');

    setComposerCaret(input, '@hit');
    fireEvent.input(input);
    expect(await screen.findAllByText(/hit-/)).toHaveLength(8);
    expect(screen.getByText(t.sections.files.root)).toBeInTheDocument();
    setComposerCaret(input, 'plain text');
    fireEvent.input(input);
    expect(screen.queryByText(t.sections.chat.mentionFilesTitle)).not.toBeInTheDocument();
  });

  it('handles a selection outside the composer without mutating arbitrary DOM', async () => {
    const user = userEvent.setup();
    const view = renderChat();
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    setComposerCaret(input, '@road');
    fireEvent.input(input);
    expect(await screen.findByText('roadmap.txt')).toBeInTheDocument();
    const outside = document.createElement('span');
    outside.textContent = '@outside';
    document.body.appendChild(outside);
    const outsideRange = document.createRange();
    outsideRange.selectNodeContents(outside);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(outsideRange);
    await user.click(screen.getByText('roadmap.txt'));
    expect(view.props.onMentionFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'roadmap' }));
    expect(input.querySelector('[data-file-chip]')).toBeNull();
    outside.remove();
  });

  it('inserts mentions for text-node and element carets and tolerates a stale query selection', async () => {
    const view = renderChat();
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    setComposerCaret(input, 'Ask @road');
    fireEvent.input(input);
    const roadmap = await screen.findByText('roadmap.txt');
    setComposerCaret(input, 'Ask @road');
    fireEvent.mouseDown(roadmap);
    fireEvent.click(roadmap);
    expect(input.querySelector('[data-file-chip-id="roadmap"]')).not.toBeNull();

    input.replaceChildren();
    const elementRange = document.createRange();
    elementRange.setStart(input, 0);
    elementRange.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(elementRange);
    input.textContent = '@rep';
    setComposerCaret(input, '@rep');
    fireEvent.input(input);
    const report = await screen.findByText('report.txt');
    const rootRange = document.createRange();
    rootRange.setStart(input, 0);
    rootRange.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(rootRange);
    fireEvent.click(report);
    expect(input.querySelector('[data-file-chip-id="report"]')).not.toBeNull();

    input.textContent = '@road';
    setComposerCaret(input, '@road');
    fireEvent.input(input);
    const stale = await screen.findByText('roadmap.txt');
    setComposerCaret(input, 'plain');
    fireEvent.click(stale);
    expect(view.props.onMentionFile).toHaveBeenCalledTimes(3);
    fireEvent.click(input);
  });

  it('replaces a mention token that begins at the start of the composer', async () => {
    const view = renderChat();
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    setComposerCaret(input, '@rep');
    fireEvent.input(input);
    const report = await screen.findByText('report.txt');
    setComposerCaret(input, '@rep');
    fireEvent.click(report);
    expect(input.querySelector('[data-file-chip-id="report"]')).not.toBeNull();
    expect(view.props.onMentionFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'report' }));
  });

  it('falls back to serialized text when there is no caret selection', async () => {
    const view = renderChat();
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    input.textContent = '@road';
    window.getSelection()!.removeAllRanges();
    fireEvent.input(input);
    const result = await screen.findByText('roadmap.txt');
    window.getSelection()!.removeAllRanges();
    fireEvent.click(result);
    expect(view.props.onMentionFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'roadmap' }));
    expect(input.querySelector('[data-file-chip]')).toBeNull();
  });

  it('pastes plain text as text and stages image files with captions and fallback names', async () => {
    const view = renderChat();
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    paste(input, [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], 'plain paste');
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'plain paste');

    const namedImage = new File(['named'], 'diagram.png', { type: 'image/png' });
    const unnamedImage = new File(['unnamed'], '', { type: 'image/jpeg' });
    paste(input, [
      { kind: 'file', type: 'image/png', getAsFile: () => namedImage },
      { kind: 'file', type: 'image/gif', getAsFile: () => null },
      { kind: 'file', type: 'image/jpeg', getAsFile: () => unnamedImage },
    ], 'caption');
    expect(document.execCommand).toHaveBeenLastCalledWith('insertText', false, 'caption');
    await waitFor(() => expect(view.props.onStagePastedFile).toHaveBeenCalledTimes(2));
    expect(view.props.onStagePastedFile).toHaveBeenNthCalledWith(1, expect.objectContaining({
      name: 'diagram.png',
      mimeType: 'image/png',
      dataBase64: expect.any(String),
    }));
    expect(view.props.onStagePastedFile).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: 'imagen-pegada-3',
      mimeType: 'image/jpeg',
      dataBase64: expect.any(String),
    }));
  });

  it('reports clipboard image read failures while keeping the composer usable', async () => {
    class FailingFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onerror?.();
      }
    }
    Object.defineProperty(window, 'FileReader', { configurable: true, value: FailingFileReader });
    const warn = vi.spyOn(console, 'warn');
    const view = renderChat();
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    paste(input, [{
      kind: 'file',
      type: 'image/png',
      getAsFile: () => new File(['bad'], 'bad.png', { type: 'image/png' }),
    }]);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Could not stage pasted chat image',
      expect.objectContaining({ message: 'clipboard_image_read_failed' }),
    ));
    expect(view.props.onStagePastedFile).not.toHaveBeenCalled();
  });

  it('normalizes non-string and raw FileReader results', async () => {
    class NonStringFileReader {
      result: string | ArrayBuffer | null = new ArrayBuffer(1);
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
    }
    Object.defineProperty(window, 'FileReader', { configurable: true, value: NonStringFileReader });
    const first = renderChat();
    paste(screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder }), [{
      kind: 'file', type: 'image/png', getAsFile: () => new File(['x'], 'array.png', { type: 'image/png' }),
    }]);
    await waitFor(() => expect(first.props.onStagePastedFile).toHaveBeenCalledWith(expect.objectContaining({ dataBase64: '' })));
    first.unmount();

    class RawFileReader extends NonStringFileReader {
      result = 'raw-base64';
    }
    Object.defineProperty(window, 'FileReader', { configurable: true, value: RawFileReader });
    const second = renderChat();
    paste(screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder }), [{
      kind: 'file', type: 'image/png', getAsFile: () => new File(['x'], 'raw.png', { type: 'image/png' }),
    }]);
    await waitFor(() => expect(second.props.onStagePastedFile).toHaveBeenCalledWith(expect.objectContaining({ dataBase64: 'raw-base64' })));
  });

  it('safely completes delayed text synchronization after the composer unmounts', () => {
    vi.useFakeTimers();
    const view = renderChat();
    const input = screen.getByRole('textbox', { name: t.sections.chat.inputPlaceholder });
    paste(input, [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], 'late');
    view.unmount();
    act(() => vi.runAllTimers());
    vi.useRealTimers();
  });
});

describe('ChatView desktop window integration', () => {
  const windowed: WindowControlState = { isMaximized: false, isFullScreen: false, usesCustomFrame: false };

  const installDesktopWindowApi = (getWindowState: ReturnType<typeof vi.fn>) => {
    let listener: ((state: WindowControlState) => void) | undefined;
    const removeListener = vi.fn();
    const api = {
      getWindowState,
      onWindowStateChanged: vi.fn((next: (state: WindowControlState) => void) => {
        listener = next;
        return removeListener;
      }),
    };
    Object.defineProperty(window, 'forger', { configurable: true, value: api });
    return { api, removeListener, emit: (state: WindowControlState) => listener?.(state) };
  };

  it('tracks macOS full-screen changes and releases the listener', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    const desktop = installDesktopWindowApi(vi.fn().mockResolvedValue(windowed));
    const view = renderChat({
      historyItems: [{ id: 'mac-history', title: 'Mac history', threadId: null, updatedAt: now, appId: 'forger', mode: 'free_chat' }],
    });
    await waitFor(() => expect(desktop.api.getWindowState).toHaveBeenCalledOnce());
    await userEvent.setup().click(screen.getByRole('button', { name: t.sections.chat.showHistoryTooltip }));
    expect(await screen.findByText('Mac history')).toBeInTheDocument();
    await act(async () => desktop.emit({ ...windowed, isFullScreen: true }));
    view.unmount();
    expect(desktop.removeListener).toHaveBeenCalledOnce();
  });

  it('ignores a rejected or late initial macOS window read', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    const rejected = installDesktopWindowApi(vi.fn().mockRejectedValue(new Error('unavailable')));
    const rejectedView = renderChat();
    await waitFor(() => expect(rejected.api.getWindowState).toHaveBeenCalledOnce());
    rejectedView.unmount();

    const deferred = Promise.withResolvers<WindowControlState>();
    const late = installDesktopWindowApi(vi.fn().mockReturnValue(deferred.promise));
    const lateView = renderChat();
    lateView.unmount();
    deferred.resolve(windowed);
    await deferred.promise;
    expect(late.removeListener).toHaveBeenCalledOnce();
  });
});
