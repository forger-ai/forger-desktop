import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PersonalAgent,
  PersonalAgentConversation,
  PersonalAgentConversationEvent,
  PersonalAgentMessage,
  PersonalAgentRun,
  SidekickMicrophoneRecordingSummary,
  SidekickMutationResult,
  SidekickState,
  SidekickSummary,
  SpeechToTextState,
  TextToSpeechState,
} from '@shared/types';
import { getDictionary } from '@renderer/i18n';

vi.mock('@renderer/views/sidekicks/SidekickVoiceExperience', () => ({
  SidekickVoiceSettings: ({ onSave, sidekick, busy }: {
    onSave: (sidekickId: string, config: SidekickSummary['voiceConfig']) => Promise<void>;
    sidekick: SidekickSummary;
    busy: boolean;
  }) => (
    <button type="button" disabled={busy} onClick={() => void onSave(sidekick.sidekickId, {
      model: 'model-b', voice: 'voice-b', locale: 'es-CL', conversationTtlMinutes: 60,
    })}>
      Mock save voice settings
    </button>
  ),
  SidekickConversationList: ({ conversations, loading, onOpen }: {
    conversations: PersonalAgentConversation[];
    loading: boolean;
    onOpen: (conversation: PersonalAgentConversation) => void;
  }) => (
    <section aria-label="Mock conversation list">
      {loading ? <span>Mock conversations loading</span> : null}
      {conversations.length === 0 ? <span>Mock conversations empty</span> : conversations.map((conversation) => (
        <button
          type="button"
          key={conversation.id}
          data-status={conversation.activeRun?.status ?? ''}
          data-message-count={conversation.messages.length}
          onClick={() => onOpen(conversation)}
        >
          {conversation.title}
        </button>
      ))}
    </section>
  ),
  SidekickConversationDialog: ({ conversation, onClose }: {
    conversation: PersonalAgentConversation | null;
    onClose: () => void;
  }) => conversation ? (
    <div role="dialog" aria-label="Mock conversation dialog">
      <span>{conversation.title}</span>
      <button type="button" onClick={onClose}>Close mock conversation</button>
    </div>
  ) : null,
}));

import { SidekicksView } from '@renderer/views/SidekicksView';

const t = getDictionary('en');
const copy = t.sections.sidekicks;

const recording = (id: string, overrides: Partial<SidekickMicrophoneRecordingSummary> = {}): SidekickMicrophoneRecordingSummary => ({
  recordingId: id,
  sidekickId: 'desk-1',
  createdAt: '2026-08-10T10:00:00.000Z',
  stoppedAt: '2026-08-10T10:00:02.000Z',
  durationMs: 2_000,
  sampleCount: 32_000,
  sampleRate: 16000,
  channels: 1,
  format: 'pcm_s16le',
  sizeBytes: 640,
  ...overrides,
});

const sidekick = (overrides: Partial<SidekickSummary> = {}): SidekickSummary => ({
  sidekickId: 'desk-1',
  name: 'Desk Sidekick',
  hostname: 'desk-sidekick',
  status: 'online',
  pairedAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: '2026-08-10T10:00:00.000Z',
  firmwareVersion: '1.2.3',
  capabilities: ['display.screens', 'display.idle-order', 'wake.word.local', 'microphone.record', 'speaker.playback'],
  personalAgentId: 'agent-1',
  voiceConfig: { model: 'model-a', voice: 'voice-a', conversationTtlMinutes: 30 },
  battery: { levelPercent: 80, charging: true },
  time: { synced: true, epochMs: Date.parse('2026-08-10T12:00:00.000Z'), timeZone: 'UTC' },
  voicePhase: 'idle',
  speakerPlayback: { status: 'idle' },
  microphoneRecording: { status: 'idle' },
  microphoneRecordings: [],
  idleConfig: { screens: ['eyes', 'clock'], rotateSeconds: 15 },
  idleImagePreviewDataUrl: 'data:image/jpeg;base64,preview',
  usbPath: '/dev/tty.usbserial-1',
  ipAddress: '192.168.1.20',
  ...overrides,
});

const state = (sidekicks: SidekickSummary[] = [], overrides: Partial<SidekickState> = {}): SidekickState => ({
  desktopId: 'desktop-1',
  servicePort: 4567,
  sidekicks,
  detectedUsb: [],
  ...overrides,
});

const mutation = (nextState: SidekickState, success = true, userMessage?: string): SidekickMutationResult => ({
  ...nextState,
  success,
  userMessage,
});

const speechState = (overrides: Partial<SpeechToTextState> = {}): SpeechToTextState => ({
  status: 'running', installed: true, running: true,
  config: { model: 'small', maxConcurrentJobs: 1, maxRealtimeSessions: 1, autoStart: true },
  modelOptions: [{ id: 'small', installed: true }], dependencyIssues: [], repairRequired: false,
  queue: [], processedFiles: [], modelWorkers: [],
  ...overrides,
});

const ttsState = (overrides: Partial<TextToSpeechState> = {}): TextToSpeechState => ({
  status: 'running', installed: true, running: true,
  config: { autoStart: true, maxTextCharacters: 1000, maxConcurrentJobs: 1, enabledVoices: ['voice-a', 'voice-b'], defaultModel: 'model-a', defaultVoice: 'voice-a' },
  models: [
    { id: 'model-a', label: 'Model A', installed: true },
    { id: 'model-b', label: 'Model B', installed: true },
    { id: 'model-off', label: 'Model off', installed: false },
  ],
  voices: [
    { id: 'voice-a', model: 'model-a', label: 'Voice A', language: 'English', locale: 'en-US', installed: true, enabled: true },
    { id: 'voice-b', model: 'model-b', label: 'Voice B', language: 'Spanish', locale: 'es-CL', installed: true, enabled: true },
    { id: 'voice-c', model: 'model-b', label: 'Voice C', language: 'Spanish', locale: 'es-MX', installed: true, enabled: true },
    { id: 'voice-disabled', model: 'model-a', label: 'Disabled', language: 'English', installed: true, enabled: false },
  ],
  queue: [],
  ...overrides,
});

const agent = (id: string, name = `Agent ${id}`): PersonalAgent => ({
  id, name, description: '', purpose: '', instructions: '', permissionMode: 'ask', networkAccess: false,
  canSpawnAgents: false, appIds: [], toolIds: [], connectionGrants: [], peerAgentGrants: [],
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
});

const conversation = (
  id: string,
  overrides: Partial<PersonalAgentConversation> = {},
): PersonalAgentConversation => ({
  id, agentId: 'agent-1', title: `Conversation ${id}`, status: 'active', origin: 'sidekick', readOnly: true,
  sidekickId: 'desk-1', createdAt: '2026-08-10T09:00:00.000Z', updatedAt: '2026-08-10T10:00:00.000Z', messages: [],
  ...overrides,
});

const message = (id: string, createdAt: string): PersonalAgentMessage => ({
  id, agentId: 'agent-1', conversationId: 'conversation', role: 'assistant', kind: 'message',
  authorType: 'agent', source: 'sidekick', content: id, createdAt,
});

const run = (status: PersonalAgentRun['status'], updatedAt: string): PersonalAgentRun => ({
  id: `run-${status}-${updatedAt}`, agentId: 'agent-1', conversationId: 'conversation', status,
  progress: [], createdAt: '2026-08-10T09:00:00.000Z', updatedAt,
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

const createBridge = () => {
  const sidekickListeners: Array<(value: SidekickState) => void> = [];
  const conversationListeners: Array<(event: PersonalAgentConversationEvent) => void> = [];
  return {
    sidekickListeners,
    conversationListeners,
    sidekicksGetState: vi.fn(async () => state()),
    speechToTextGetState: vi.fn(async () => speechState()),
    textToSpeechGetState: vi.fn(async () => ttsState()),
    personalAgentsList: vi.fn(async () => [agent('agent-1')]),
    onSidekicksChanged: vi.fn((listener: (value: SidekickState) => void) => {
      sidekickListeners.push(listener);
      return vi.fn();
    }),
    onPersonalAgentConversationEvent: vi.fn((listener: (event: PersonalAgentConversationEvent) => void) => {
      conversationListeners.push(listener);
      return vi.fn();
    }),
    sidekicksScanUsb: vi.fn(async () => state()),
    sidekicksConfigureUsb: vi.fn(async () => mutation(state())),
    speechToTextInstall: vi.fn(async () => speechState()),
    textToSpeechInstall: vi.fn(async () => ttsState()),
    sidekicksSendScreen: vi.fn(async () => mutation(state([sidekick()]))),
    sidekicksSpeak: vi.fn(async () => ({ success: true })),
    sidekicksSetPersonalAgent: vi.fn(async () => mutation(state([sidekick()]))),
    sidekicksSetIdleConfig: vi.fn(async () => mutation(state([sidekick()]))),
    sidekicksSetIdleImage: vi.fn(async () => mutation(state([sidekick()]))),
    sidekicksSetVoiceConfig: vi.fn(async () => mutation(state([sidekick()]))),
    personalAgentConversationsList: vi.fn(async () => [] as PersonalAgentConversation[]),
    sidekicksStartMicrophoneRecording: vi.fn(async () => mutation(state([sidekick({ microphoneRecording: { status: 'recording' } })]))),
    sidekicksStopMicrophoneRecording: vi.fn(async () => mutation(state([sidekick()]))),
    sidekicksReadMicrophoneRecording: vi.fn(async () => ({ success: true, bytes: new Uint8Array([1, 2]), mimeType: 'audio/wav' as const })),
    sidekicksForget: vi.fn(async () => mutation(state())),
  };
};

const openSidekick = async (name = 'Desk Sidekick') => {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(name) }));
};

const openAdvanced = async () => {
  await userEvent.click(screen.getByText(copy.advancedTitle));
};

describe('SidekicksView', () => {
  let bridge: ReturnType<typeof createBridge>;

  beforeEach(() => {
    bridge = createBridge();
    Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:recording') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the empty state, tolerates optional service failures, refreshes, and disposes listeners', async () => {
    const load = deferred<SidekickState>();
    bridge.sidekicksGetState.mockReturnValueOnce(load.promise).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(state([], { userMessage: 'Ready', technicalCode: 'diagnostic' }));
    bridge.speechToTextGetState.mockRejectedValueOnce(new Error('no stt'));
    bridge.textToSpeechGetState.mockRejectedValueOnce(new Error('no tts'));
    bridge.personalAgentsList.mockRejectedValueOnce(new Error('no agents'));
    const view = render(<SidekicksView t={t} />);
    expect(screen.getByRole('button', { name: copy.refresh })).toBeDisabled();
    await act(async () => load.resolve(state()));
    expect(await screen.findByText(copy.empty)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: copy.refresh }));
    expect(await screen.findByText(copy.loadError)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: copy.refresh }));
    expect(await screen.findByText('Ready')).toBeVisible();

    const disposeSidekicks = bridge.onSidekicksChanged.mock.results[0]?.value;
    const disposeConversations = bridge.onPersonalAgentConversationEvent.mock.results[0]?.value;
    view.unmount();
    expect(disposeSidekicks).toHaveBeenCalledOnce();
    expect(disposeConversations).toHaveBeenCalledOnce();
  });

  it('scans USB, validates setup, installs local voice, and configures success and error results', async () => {
    const usbState = state([], {
      detectedUsb: [
        { path: '/dev/friendly', friendlyName: 'Friendly ESP', likelySidekick: true },
        { path: '/dev/manufacturer', manufacturer: 'Espressif', likelySidekick: true },
        { path: '/dev/serial', serialNumber: 'SERIAL-3', likelySidekick: true },
        { path: '/dev/path-only', likelySidekick: true },
        { path: '/dev/other', manufacturer: 'Arduino', likelySidekick: false },
      ],
    });
    bridge.sidekicksScanUsb.mockResolvedValueOnce(usbState);
    bridge.speechToTextGetState.mockResolvedValueOnce(speechState({ installed: false, repairRequired: true }));
    bridge.textToSpeechGetState.mockResolvedValueOnce(ttsState({ installed: false, voices: [] }));
    bridge.speechToTextInstall.mockRejectedValueOnce(new Error('install failed')).mockResolvedValueOnce(speechState());
    bridge.textToSpeechInstall.mockResolvedValueOnce(ttsState());
    render(<SidekicksView t={t} />);
    await screen.findByText(copy.empty);
    await userEvent.click(screen.getByRole('button', { name: copy.addSidekick }));
    const dialog = screen.getByRole('dialog', { name: copy.addSidekick });
    expect(await within(dialog).findByText('Friendly ESP')).toBeVisible();
    await userEvent.click(within(dialog).getByLabelText(copy.usbPortLabel));
    expect(screen.getByRole('option', { name: 'Espressif' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'SERIAL-3' })).toBeVisible();
    await userEvent.click(screen.getByRole('option', { name: '/dev/path-only' }));

    await userEvent.click(within(dialog).getByText(copy.otherUsbTitle));
    expect(within(dialog).getByText(/Arduino · \/dev\/other/)).toBeVisible();
    const installButtons = within(dialog).getAllByRole('button', { name: /Repair|Install/ });
    await userEvent.click(installButtons[0]);
    expect(await screen.findByText(copy.voiceSetupInstallError)).toBeVisible();
    await userEvent.click(within(dialog).getAllByRole('button', { name: /Repair|Install/ })[0]);
    await waitFor(() => expect(bridge.speechToTextInstall).toHaveBeenCalledTimes(2));
    await userEvent.click(within(dialog).getByRole('button', { name: copy.voiceSetupInstall }));
    await waitFor(() => expect(bridge.textToSpeechInstall).toHaveBeenCalledOnce());

    const name = within(dialog).getByLabelText(copy.nameLabel);
    const wifi = within(dialog).getByLabelText(copy.ssidLabel);
    const password = within(dialog).getByLabelText(copy.passwordLabel);
    await userEvent.clear(name);
    expect(within(dialog).getByText(copy.nameRequired)).toBeVisible();
    fireEvent.change(name, { target: { value: 'x'.repeat(41) } });
    expect(within(dialog).getByText(copy.nameTooLong)).toBeVisible();
    fireEvent.change(name, { target: { value: '  Kitchen Sidekick  ' } });
    fireEvent.change(wifi, { target: { value: 'My Wi-Fi' } });
    fireEvent.change(password, { target: { value: 'secret password' } });
    const configureButton = within(dialog).getByRole('button', { name: copy.configure });
    await waitFor(() => expect(configureButton).toBeEnabled());

    bridge.sidekicksConfigureUsb
      .mockResolvedValueOnce(mutation(usbState, false, 'Device rejected input'))
      .mockResolvedValueOnce(mutation(usbState, false))
      .mockRejectedValueOnce(new Error('transport'))
      .mockResolvedValueOnce(mutation(state([sidekick()]), true));
    await userEvent.click(configureButton);
    expect(await screen.findByText('Device rejected input')).toBeVisible();
    await userEvent.click(configureButton);
    expect(await screen.findByText(copy.configureError)).toBeVisible();
    await userEvent.click(configureButton);
    expect(await screen.findByText(copy.configureError)).toBeVisible();
    await userEvent.click(configureButton);
    expect(await screen.findByText(copy.configureSuccess)).toBeVisible();
    expect(bridge.sidekicksConfigureUsb).toHaveBeenLastCalledWith({
      portPath: '/dev/path-only', name: '  Kitchen Sidekick  ', ssid: 'My Wi-Fi', password: 'secret password',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.addSidekick })).not.toBeInTheDocument());
  });

  it('shows scan failures and the no-device setup variants', async () => {
    bridge.sidekicksScanUsb.mockRejectedValueOnce(new Error('scan failed')).mockResolvedValueOnce(state([], {
      detectedUsb: [{ path: '/dev/not-sidekick', likelySidekick: false }],
    }));
    render(<SidekicksView t={t} />);
    await screen.findByText(copy.empty);
    await userEvent.click(screen.getByRole('button', { name: copy.addSidekick }));
    expect(await screen.findByText(copy.scanError)).toBeVisible();
    let dialog = screen.getByRole('dialog', { name: copy.addSidekick });
    expect(within(dialog).getByLabelText(copy.usbPortLabel)).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(within(dialog).getByRole('button', { name: copy.configClose }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.addSidekick })).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole('button', { name: copy.addSidekick }));
    dialog = screen.getByRole('dialog', { name: copy.addSidekick });
    await userEvent.click(within(dialog).getByText(copy.otherUsbTitle));
    expect(await within(dialog).findByText(/\/dev\/not-sidekick/)).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.addSidekick })).not.toBeInTheDocument());
  });

  it('navigates online and offline devices and renders status, battery, time, and technical variants', async () => {
    const devices = [
      sidekick(),
      sidekick({ sidekickId: 'offline', name: 'Offline Sidekick', status: 'offline', battery: undefined, time: undefined, capabilities: [], hostname: undefined, firmwareVersion: undefined, ipAddress: undefined, usbPath: undefined }),
      sidekick({ sidekickId: 'usb:temporary', name: 'Temporary USB', status: 'usb_detected' }),
    ];
    bridge.sidekicksGetState.mockResolvedValueOnce(state(devices));
    render(<SidekicksView t={t} />);
    expect(await screen.findByText('Desk Sidekick')).toBeVisible();
    expect(screen.getByText('Offline Sidekick')).toBeVisible();
    expect(screen.queryByText('Temporary USB')).not.toBeInTheDocument();
    await openSidekick('Offline Sidekick');
    expect(screen.getAllByText(copy.statuses.offline).length).toBeGreaterThan(0);
    expect(screen.getByText(copy.batteryUnknown)).toBeVisible();
    expect(screen.getAllByText(copy.microphoneOffline).length).toBeGreaterThan(0);
    expect(screen.queryByText(new RegExp(`^${copy.timeTitle}:`))).not.toBeInTheDocument();
    await openAdvanced();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('desktop-1')).toBeVisible();
    expect(screen.getByText('4567')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: copy.backToSidekicks }));
    expect(await screen.findByText('Desk Sidekick')).toBeVisible();
  });

  it('sends every screen preset once and exposes exactly one transcript field', async () => {
    bridge.sidekicksGetState.mockResolvedValue(state([sidekick()]));
    bridge.sidekicksSendScreen
      .mockResolvedValueOnce(mutation(state([sidekick()]), true))
      .mockResolvedValueOnce(mutation(state([sidekick()]), false, 'Screen rejected'))
      .mockResolvedValueOnce(mutation(state([sidekick()]), false))
      .mockRejectedValueOnce(new Error('screen transport'))
      .mockResolvedValue(mutation(state([sidekick()]), true));
    render(<SidekicksView t={t} />);
    await openSidekick();
    await openAdvanced();
    const send = () => screen.getByRole('button', { name: copy.screenSend });
    await userEvent.click(send());
    expect(await screen.findByText(copy.screenSuccess)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: copy.screenPresets.transcript }));
    expect(screen.getAllByLabelText(copy.screenTranscriptLabel)).toHaveLength(1);
    const transcript = screen.getByLabelText(copy.screenTranscriptLabel);
    await userEvent.clear(transcript);
    expect(send()).toBeDisabled();
    await userEvent.type(transcript, 'Transcript text');
    await userEvent.click(send());
    expect(await screen.findByText('Screen rejected')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: copy.screenPresets.card }));
    await userEvent.type(screen.getByLabelText(copy.screenTitleLabel), 'Card title');
    await userEvent.type(screen.getByLabelText(copy.screenBodyLabel), 'Card body');
    await userEvent.click(send());
    expect(await screen.findByText(copy.screenError)).toBeVisible();

    for (const preset of ['listening', 'thinking', 'speaking'] as const) {
      await userEvent.click(screen.getByRole('button', { name: copy.screenPresets[preset] }));
      await userEvent.click(send());
    }
    expect(bridge.sidekicksSendScreen).toHaveBeenCalledWith({ sidekickId: 'desk-1', template: 'idle' });
    expect(bridge.sidekicksSendScreen).toHaveBeenCalledWith({ sidekickId: 'desk-1', template: 'transcript', text: 'Transcript text' });
    expect(bridge.sidekicksSendScreen).toHaveBeenCalledWith(expect.objectContaining({ template: 'card', icon: 'info', title: 'Card title', body: 'Card body' }));
    expect(bridge.sidekicksSendScreen).toHaveBeenCalledWith(expect.objectContaining({ template: 'state', icon: 'speaking' }));
  });

  it('speaks with installed voices and handles bridge errors and playback state', async () => {
    bridge.sidekicksGetState
      .mockResolvedValue(state([sidekick()]))
      .mockResolvedValueOnce(state([sidekick()]))
      .mockRejectedValueOnce(new Error('playback refresh failed'));
    bridge.sidekicksSpeak
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, userMessage: 'Speaker rejected' })
      .mockResolvedValueOnce({ success: false })
      .mockRejectedValueOnce(new Error('speaker transport'));
    render(<SidekicksView t={t} />);
    await openSidekick();
    await openAdvanced();
    const speakButton = () => screen.getByRole('button', { name: copy.voiceSpeak });
    await userEvent.click(speakButton());
    expect(await screen.findByText(copy.voiceSuccess)).toBeVisible();
    await userEvent.click(speakButton());
    expect(await screen.findByText('Speaker rejected')).toBeVisible();
    await userEvent.click(speakButton());
    expect(await screen.findByText(copy.voiceError)).toBeVisible();
    await userEvent.click(speakButton());
    expect(await screen.findByText(copy.voiceError)).toBeVisible();

    await userEvent.click(screen.getByLabelText(copy.voiceModelLabel));
    await userEvent.click(screen.getByRole('option', { name: 'Model B' }));
    await userEvent.click(screen.getByLabelText(copy.voiceVoiceLabel));
    await userEvent.click(screen.getByRole('option', { name: /Voice C/ }));
    await userEvent.clear(screen.getByLabelText(copy.voiceTextLabel));
    expect(speakButton()).toBeDisabled();
    act(() => bridge.sidekickListeners.at(-1)?.(state([sidekick({ speakerPlayback: { status: 'playing' } })])));
    expect(screen.getByRole('progressbar', { name: copy.voiceSpeaking })).toBeVisible();
  }, 15_000);

  it('starts and stops microphone tests and loads recording audio outcomes', async () => {
    const recordings = [
      recording('bytes'),
      recording('kilobytes', { durationMs: -1, sizeBytes: 2048, createdAt: '' }),
      recording('megabytes', { durationMs: 61_000, sizeBytes: 2 * 1024 * 1024 }),
      recording('fallback', { sizeBytes: 4096 }),
    ];
    const configured = sidekick({ microphoneRecordings: recordings });
    bridge.sidekicksGetState.mockResolvedValue(state([configured]));
    bridge.sidekicksStartMicrophoneRecording
      .mockResolvedValueOnce(mutation(state([sidekick({ microphoneRecordings: recordings, microphoneRecording: { status: 'recording' } })]), true))
      .mockResolvedValueOnce(mutation(state([configured]), false, 'Start rejected'))
      .mockResolvedValueOnce(mutation(state([configured]), false))
      .mockRejectedValueOnce(new Error('start transport'));
    bridge.sidekicksStopMicrophoneRecording
      .mockResolvedValueOnce(mutation(state([configured]), false, 'Stop rejected'))
      .mockResolvedValueOnce(mutation(state([configured]), false))
      .mockRejectedValueOnce(new Error('stop transport'))
      .mockResolvedValueOnce(mutation(state([configured]), true));
    bridge.sidekicksReadMicrophoneRecording
      .mockResolvedValueOnce({ success: true, bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' })
      .mockResolvedValueOnce({ success: false, userMessage: 'Audio rejected' })
      .mockResolvedValueOnce({ success: false })
      .mockRejectedValueOnce(new Error('audio transport'));
    const view = render(<SidekicksView t={t} />);
    await openSidekick();
    await openAdvanced();
    expect(screen.getByText('0:02 · 640 B')).toBeVisible();
    expect(screen.getByText('0:00 · 2.0 KB')).toBeVisible();
    expect(screen.getByText('1:01 · 2.0 MB')).toBeVisible();

    const micButton = () => screen.getByRole('button', { name: new RegExp(`${copy.microphoneStart}|${copy.microphoneStop}`) });
    await userEvent.click(micButton());
    expect(await screen.findByRole('button', { name: copy.microphoneStop })).toBeVisible();
    await userEvent.click(micButton());
    expect(await screen.findByText('Stop rejected')).toBeVisible();
    act(() => bridge.sidekickListeners.at(-1)?.(state([configured])));
    for (let index = 0; index < 3; index += 1) {
      await userEvent.click(micButton());
      await waitFor(() => expect(bridge.sidekicksStartMicrophoneRecording).toHaveBeenCalledTimes(index + 2));
    }

    const loadButtons = screen.getAllByRole('button', { name: copy.playbackLoad });
    await userEvent.click(loadButtons[0]);
    await waitFor(() => expect(document.querySelector('audio')).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole('button', { name: copy.playbackLoad })[0]);
    expect(await screen.findByText('Audio rejected')).toBeVisible();
    await userEvent.click(screen.getAllByRole('button', { name: copy.playbackLoad })[1]);
    expect(await screen.findByText(copy.playbackError)).toBeVisible();
    await userEvent.click(screen.getAllByRole('button', { name: copy.playbackLoad })[2]);
    expect(await screen.findAllByText(copy.playbackError)).not.toHaveLength(0);
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recording');
  }, 15_000);

  it('saves agents, voice settings, idle order, and custom images', async () => {
    const configured = sidekick({ idleConfig: { screens: ['eyes', 'clock', 'custom'], rotateSeconds: 17 } });
    bridge.sidekicksGetState.mockResolvedValue(state([configured]));
    bridge.personalAgentsList.mockResolvedValue([agent('agent-1'), agent('agent-2')]);
    bridge.sidekicksSetPersonalAgent
      .mockResolvedValueOnce(mutation(state([configured]), false, 'Agent rejected'))
      .mockResolvedValueOnce(mutation(state([configured]), false))
      .mockRejectedValueOnce(new Error('agent transport'))
      .mockResolvedValueOnce(mutation(state([configured]), true));
    bridge.sidekicksSetVoiceConfig
      .mockResolvedValueOnce(mutation(state([configured]), false, 'Voice config rejected'))
      .mockResolvedValueOnce(mutation(state([configured]), false))
      .mockRejectedValueOnce(new Error('voice config transport'))
      .mockResolvedValueOnce(mutation(state([configured]), true));
    bridge.sidekicksSetIdleConfig
      .mockResolvedValueOnce(mutation(state([configured]), false, 'Idle rejected'))
      .mockResolvedValueOnce(mutation(state([configured]), false))
      .mockRejectedValueOnce(new Error('idle transport'))
      .mockResolvedValueOnce(mutation(state([configured]), true));
    render(<SidekicksView t={t} />);
    await openSidekick();

    const agentSelect = screen.getByLabelText(copy.agentLabel);
    await userEvent.click(agentSelect);
    await userEvent.click(screen.getByRole('option', { name: 'Agent agent-2' }));
    expect(await screen.findByText('Agent rejected')).toBeVisible();
    for (let index = 0; index < 3; index += 1) {
      await userEvent.click(agentSelect);
      await userEvent.click(screen.getByRole('option', { name: 'Agent agent-2' }));
    }
    expect(await screen.findByText(copy.agentSaved)).toBeVisible();

    const voiceSave = screen.getByRole('button', { name: 'Mock save voice settings' });
    for (let index = 0; index < 4; index += 1) await userEvent.click(voiceSave);
    expect(await screen.findByText(copy.voiceSettingsSaved)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: copy.screenMoveDown(copy.idleScreens.eyes) }));
    await userEvent.click(screen.getByRole('button', { name: copy.screenMoveUp(copy.idleScreens.eyes) }));
    for (let index = 0; index < 3; index += 1) {
      await userEvent.click(screen.getAllByRole('button', { name: copy.screenActive })[0]);
    }
    expect(screen.getByText(copy.idleNeedsOne)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: copy.idleScreens.eyes }));
    for (const option of [
      copy.idleRotateOptions.s30,
      copy.idleRotateOptions.s60,
      copy.idleRotateOptions.s15,
      copy.idleRotateOptions.s300,
    ]) {
      await userEvent.click(screen.getByLabelText(copy.idleRotateLabel));
      await userEvent.click(screen.getByRole('option', { name: option }));
      const idleSave = screen.getByRole('button', { name: copy.idleSave });
      await waitFor(() => expect(idleSave).toBeEnabled());
      await userEvent.click(idleSave);
    }
    expect(await screen.findByText(copy.idleSaved)).toBeVisible();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    expect(bridge.sidekicksSetIdleImage).not.toHaveBeenCalled();
  }, 15_000);

  it('loads, opens, updates, and filters Sidekick conversations', async () => {
    const initial = conversation('one');
    const unrelated = conversation('other', { origin: 'user' });
    bridge.sidekicksGetState.mockResolvedValue(state([sidekick()]));
    bridge.personalAgentsList.mockResolvedValue([agent('agent-1'), agent('agent-2')]);
    bridge.personalAgentConversationsList
      .mockResolvedValueOnce([initial, unrelated])
      .mockRejectedValueOnce(new Error('second agent offline'));
    render(<SidekicksView t={t} />);
    const emit = (next: PersonalAgentConversation, type: PersonalAgentConversationEvent['type'] = 'conversation.updated') => {
      act(() => bridge.conversationListeners.at(-1)?.({ type, conversation: next }));
    };
    emit(conversation('preloaded'));
    await openSidekick();
    await userEvent.click(screen.getByRole('button', { name: copy.conversationsOpen }));
    expect(await screen.findByRole('button', { name: initial.title })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Conversation preloaded' })).toBeVisible();
    expect(screen.queryByText(unrelated.title)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: initial.title }));
    expect(screen.getByRole('dialog', { name: 'Mock conversation dialog' })).toBeVisible();

    emit(conversation('ignored-user', { origin: 'user' }));
    emit(conversation('ignored-missing', { sidekickId: undefined }));
    emit({ ...initial, title: 'Newer title', updatedAt: '2026-08-10T11:00:00.000Z' });
    expect(await within(screen.getByRole('dialog')).findByText('Newer title')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Close mock conversation' }));
    expect(screen.queryByRole('dialog', { name: 'Mock conversation dialog' })).not.toBeInTheDocument();
    bridge.personalAgentConversationsList.mockReset().mockImplementationOnce(() => {
      throw new Error('synchronous bridge failure');
    });
    await userEvent.click(screen.getByRole('button', { name: copy.conversationsOpen }));
    expect(await screen.findByText(copy.conversationsError)).toBeVisible();
  });

  it('prefers the freshest conversation payload across timestamps, terminal runs, and message counts', async () => {
    const baseTime = '2026-08-10T10:00:00.000Z';
    const base = conversation('freshness', { title: 'Base', updatedAt: baseTime, activeRun: run('running', baseTime) });
    bridge.sidekicksGetState.mockResolvedValue(state([sidekick()]));
    bridge.personalAgentConversationsList.mockResolvedValue([base, conversation('other-entry')]);
    render(<SidekicksView t={t} />);
    await openSidekick();
    await userEvent.click(screen.getByRole('button', { name: copy.conversationsOpen }));
    expect(await screen.findByRole('button', { name: 'Base' })).toBeVisible();
    const emit = (next: PersonalAgentConversation) => act(() => bridge.conversationListeners.at(-1)?.({ type: 'conversation.updated', conversation: next }));

    emit({ ...base, title: 'Older ignored', updatedAt: '2026-08-10T09:00:00.000Z', activeRun: undefined });
    expect(screen.queryByRole('button', { name: 'Older ignored' })).not.toBeInTheDocument();
    emit({ ...base, title: 'Terminal wins', activeRun: run('completed', baseTime) });
    expect(await screen.findByRole('button', { name: 'Terminal wins' })).toBeVisible();
    emit({ ...base, title: 'Running loses', activeRun: run('running', baseTime) });
    expect(screen.queryByRole('button', { name: 'Running loses' })).not.toBeInTheDocument();
    emit({ ...base, title: 'More messages wins', activeRun: run('completed', baseTime), messages: [message('one', baseTime)] });
    expect(await screen.findByRole('button', { name: 'More messages wins' })).toBeVisible();
    emit({ ...base, title: 'Fewer messages loses', activeRun: run('completed', baseTime), messages: [] });
    expect(screen.queryByRole('button', { name: 'Fewer messages loses' })).not.toBeInTheDocument();
    emit({ ...base, title: 'Equal incoming wins', activeRun: run('completed', baseTime), messages: [message('replacement', baseTime)] });
    expect(await screen.findByRole('button', { name: 'Equal incoming wins' })).toBeVisible();
    emit(conversation('newer-by-message', {
      title: 'Newest message', updatedAt: '', messages: [message('latest', '2026-08-10T13:00:00.000Z')],
    }));
    expect(await screen.findByRole('button', { name: 'Newest message' })).toBeVisible();

    const noRun = conversation('no-run', { title: 'No run', updatedAt: baseTime });
    emit(noRun);
    emit({ ...noRun, title: 'Terminal beats no run', activeRun: run('completed', baseTime) });
    expect(await screen.findByRole('button', { name: 'Terminal beats no run' })).toBeVisible();
    emit({ ...noRun, title: 'No run loses to terminal' });
    expect(screen.queryByRole('button', { name: 'No run loses to terminal' })).not.toBeInTheDocument();
  });

  it('renders every status, voice phase, low battery, wake error, and invalid timezone fallback', async () => {
    const configured = sidekick({
      battery: { levelPercent: 15, charging: false },
      time: { synced: true, epochMs: Date.parse('2026-08-10T12:00:00.000Z'), timeZone: 'Invalid/Zone' },
      wakeBeep: { wakeId: 'wake-1', status: 'failed', durationMs: 10, updatedAt: '2026-08-10T12:00:00.000Z' },
      voicePhase: 'error',
    });
    bridge.sidekicksGetState.mockResolvedValue(state([
      configured,
      sidekick({ sidekickId: 'listening-list', name: 'Listening List', voicePhase: 'listening' }),
    ]));
    render(<SidekicksView t={t} />);
    await openSidekick();
    expect(screen.getByText('15%')).toBeVisible();
    expect(screen.getAllByText(copy.voiceError).length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`^${copy.timeTitle}:`))).toBeVisible();

    for (const status of ['pairing', 'wifi_pending', 'error', 'usb_detected'] as const) {
      act(() => bridge.sidekickListeners.at(-1)?.(state([sidekick({ status, voicePhase: status === 'pairing' ? 'listening' : 'idle' })])));
      expect(await screen.findByText(copy.statuses[status])).toBeVisible();
    }
  });

  it('explains missing voice capabilities, automatic agents, and incomplete local runtimes', async () => {
    const limited = sidekick({ capabilities: [], personalAgentId: undefined, battery: { levelPercent: 50, charging: false } });
    bridge.sidekicksGetState.mockResolvedValue(state([limited], { desktopId: '', servicePort: undefined }));
    bridge.personalAgentsList.mockResolvedValue([agent('only', 'Only Agent')]);
    bridge.speechToTextGetState.mockResolvedValue(speechState({ installed: false, repairRequired: false }));
    bridge.textToSpeechGetState.mockResolvedValue(ttsState({ installed: false, models: [], voices: [] }));
    render(<SidekicksView t={t} />);
    await openSidekick();
    expect(screen.getByText(copy.wakeWordMissing)).toBeVisible();
    expect(screen.getByText(copy.agentAutomatic)).toBeVisible();
    expect(screen.getByText(copy.screenOrderUnavailable)).toBeVisible();
    await openAdvanced();
    expect(screen.getByText(copy.voiceUnsupported)).toBeVisible();
    expect(screen.getByText(copy.microphoneUnsupported)).toBeVisible();
    expect(screen.getByRole('button', { name: copy.screenSend })).toBeDisabled();
  });

  it('shows the no-agent and local voice loading states when optional services are unavailable', async () => {
    bridge.sidekicksGetState.mockResolvedValue(state([sidekick({ personalAgentId: undefined })]));
    bridge.personalAgentsList.mockResolvedValue([]);
    bridge.textToSpeechGetState.mockRejectedValueOnce(new Error('tts unavailable'));
    render(<SidekicksView t={t} />);
    await openSidekick();
    expect(screen.getByText(copy.agentNone)).toBeVisible();
    await openAdvanced();
    expect(screen.getByText(copy.voiceLoading)).toBeVisible();
  });

  it('requires an explicit agent when multiple agents are available', async () => {
    bridge.sidekicksGetState.mockResolvedValue(state([sidekick({ personalAgentId: undefined })]));
    bridge.personalAgentsList.mockResolvedValue([agent('one'), agent('two')]);
    render(<SidekicksView t={t} />);
    await openSidekick();
    expect(screen.getByText(copy.agentRequired)).toBeVisible();
  });

  it('installs speech recognition from a configured Sidekick detail', async () => {
    bridge.sidekicksGetState.mockResolvedValue(state([sidekick()]));
    bridge.speechToTextGetState.mockResolvedValue(speechState({ installed: false }));
    render(<SidekicksView t={t} />);
    await openSidekick();
    await userEvent.click(screen.getByRole('button', { name: copy.voiceSetupInstall }));
    await waitFor(() => expect(bridge.speechToTextInstall).toHaveBeenCalledOnce());
  });

  it('handles text-to-speech install failure and microphone stop fallback, throw, and success', async () => {
    const recordingSidekick = sidekick({ microphoneRecording: { status: 'recording' } });
    bridge.sidekicksGetState.mockResolvedValue(state([recordingSidekick]));
    bridge.textToSpeechGetState.mockResolvedValue(ttsState({ installed: false, voices: [] }));
    bridge.textToSpeechInstall.mockRejectedValueOnce(new Error('install failed'));
    bridge.sidekicksStopMicrophoneRecording
      .mockResolvedValueOnce(mutation(state([recordingSidekick]), false))
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce(mutation(state([sidekick()]), true));
    render(<SidekicksView t={t} />);
    await openSidekick();
    await userEvent.click(screen.getByRole('button', { name: copy.voiceSetupInstall }));
    expect(await screen.findByText(copy.voiceSetupInstallError)).toBeVisible();
    await openAdvanced();
    for (let index = 0; index < 3; index += 1) {
      await userEvent.click(screen.getByRole('button', { name: copy.microphoneStop }));
      await waitFor(() => expect(bridge.sidekicksStopMicrophoneRecording).toHaveBeenCalledTimes(index + 1));
      if (index < 2) {
        expect(await screen.findByText(copy.microphoneStopError)).toBeVisible();
        act(() => bridge.sidekickListeners.at(-1)?.(state([recordingSidekick])));
      }
    }
  });

  it('uploads and converts idle images, surfacing conversion and bridge outcomes', async () => {
    const withoutImage = sidekick({ idleImagePreviewDataUrl: undefined, idleConfig: { screens: ['eyes'], rotateSeconds: 15 } });
    const withImage = sidekick({ idleImagePreviewDataUrl: 'data:image/jpeg;base64,new' });
    bridge.sidekicksGetState.mockResolvedValue(state([withoutImage]));
    bridge.sidekicksSetIdleImage
      .mockResolvedValueOnce(mutation(state([withoutImage]), false, 'Image rejected'))
      .mockResolvedValueOnce(mutation(state([withoutImage]), false))
      .mockResolvedValueOnce(mutation(state([withImage]), true));

    const bitmapWide = { width: 480, height: 240, close: vi.fn() } as unknown as ImageBitmap;
    const bitmapTall = { width: 120, height: 480, close: vi.fn() } as unknown as ImageBitmap;
    const createBitmap = vi.fn()
      .mockRejectedValueOnce(new Error('decode failed'))
      .mockResolvedValueOnce(bitmapWide)
      .mockResolvedValueOnce(bitmapWide)
      .mockResolvedValueOnce(bitmapTall)
      .mockResolvedValueOnce(bitmapWide);
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: createBitmap });
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([255, 128, 64, 255]) })),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValueOnce(null)
      .mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,converted');

    render(<SidekicksView t={t} />);
    await openSidekick();
    expect(screen.getByText(new RegExp(copy.idleCustomNeedsImage))).toBeVisible();
    expect(screen.getByRole('button', { name: copy.idleScreens.custom })).toHaveClass('Mui-disabled');
    await userEvent.click(screen.getByRole('button', { name: copy.idleUploadImage }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['image'], 'idle.png', { type: 'image/png' });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      fireEvent.change(input, { target: { files: [file] } });
      await waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(attempt));
      if (attempt >= 3) await waitFor(() => expect(bridge.sidekicksSetIdleImage).toHaveBeenCalledTimes(attempt - 2));
    }
    expect(await screen.findByText(copy.idleImageSaved)).toBeVisible();
    expect(bridge.sidekicksSetIdleImage).toHaveBeenLastCalledWith(expect.objectContaining({
      sidekickId: 'desk-1', previewDataUrl: 'data:image/jpeg;base64,converted', rgb565: expect.any(ArrayBuffer),
    }));
    const payload = bridge.sidekicksSetIdleImage.mock.calls.at(-1)?.[0];
    expect(payload?.rgb565.byteLength).toBe(240 * 240 * 2);
    expect(bitmapWide.close).toHaveBeenCalled();
    expect(bitmapTall.close).toHaveBeenCalled();
  }, 15_000);

  it('unlinks a configured Sidekick through cancel and confirm', async () => {
    bridge.sidekicksGetState.mockResolvedValue(state([sidekick()]));
    render(<SidekicksView t={t} />);
    await openSidekick();
    await userEvent.click(screen.getByRole('button', { name: copy.unlinkAction }));
    let dialog = screen.getByRole('dialog', { name: copy.unlinkConfirmTitle });
    expect(within(dialog).getByText(copy.forgetConfirm('Desk Sidekick'))).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.unlinkConfirmTitle })).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole('button', { name: copy.unlinkAction }));
    dialog = screen.getByRole('dialog', { name: copy.unlinkConfirmTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: copy.unlinkCancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.unlinkConfirmTitle })).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole('button', { name: copy.unlinkAction }));
    dialog = screen.getByRole('dialog', { name: copy.unlinkConfirmTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: copy.unlinkConfirm }));
    expect(await screen.findByText(copy.empty)).toBeVisible();
    expect(bridge.sidekicksForget).toHaveBeenCalledWith('desk-1');
  });
});
