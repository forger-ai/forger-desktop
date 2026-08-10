import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '@renderer/views/SettingsView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type {
  CloudStorageUsage,
  DesktopUpdateState,
  DeveloperPathState,
  LlmProviderProfileMetadata,
  MemoryEntry,
  SpeechToTextProcessResult,
  SpeechToTextState,
  TextToSpeechState,
  WakeWordState,
} from '@shared/types';

const t = en as unknown as AppDictionary;
const now = '2026-08-10T12:00:00.000Z';
type Props = React.ComponentProps<typeof SettingsView>;

const speechState = (overrides: Partial<SpeechToTextState> = {}): SpeechToTextState => ({
  status: 'running',
  installed: true,
  running: true,
  config: { model: 'base', maxConcurrentJobs: 2, maxRealtimeSessions: 1, autoStart: true },
  modelOptions: [{ id: 'base', installed: true }, { id: 'small', installed: false }],
  dependencyIssues: [],
  repairRequired: false,
  queue: [],
  processedFiles: [],
  modelWorkers: [],
  ...overrides,
});

const wakeState = (overrides: Partial<WakeWordState> = {}): WakeWordState => ({
  status: 'ready',
  installed: true,
  running: false,
  repairRequired: false,
  config: { enabled: false, deviceId: 'default', modelId: 'hey-jarvis', threshold: 0.5, patience: 2, cooldownMs: 2500 },
  models: [{ id: 'hey-jarvis', displayName: 'Hey Jarvis', source: 'bundled', installedAt: now, thresholdDefault: 0.5 }],
  runtime: { state: 'idle', modelId: 'hey-jarvis', updatedAt: now },
  dependencyIssues: [],
  ...overrides,
});

const ttsState = (overrides: Partial<TextToSpeechState> = {}): TextToSpeechState => ({
  status: 'running',
  installed: true,
  running: true,
  config: {
    autoStart: true,
    maxTextCharacters: 2_000,
    maxConcurrentJobs: 2,
    enabledVoices: ['af_heart'],
    defaultModel: 'kokoro',
    defaultVoice: 'af_heart',
  },
  models: [
    { id: 'kokoro', label: 'Kokoro', installed: true },
    { id: 'piper', label: 'Piper', installed: false },
  ],
  voices: [
    { id: 'af_heart', model: 'kokoro', label: 'Heart', language: 'English', locale: 'en-US', installed: true, enabled: true },
    { id: 'af_sky', model: 'kokoro', label: 'Sky', language: 'English', installed: true, enabled: true },
    { id: 'es_voice', model: 'piper', label: 'Sol', language: 'Spanish', installed: true, enabled: true },
    { id: 'disabled', model: 'piper', label: 'Disabled', language: 'English', installed: false, enabled: false },
  ],
  queue: [],
  ...overrides,
});

const developerPathState: DeveloperPathState = {
  enabled: true,
  globalPathEntries: ['/global/bin'],
  appPathEntries: [],
  runtimePathEntries: ['/runtime/bin'],
  systemPathEntries: ['/usr/bin'],
  effectivePathEntries: ['/runtime/bin', '/usr/bin'],
};

const makeBridge = () => ({
  speechToTextGetState: vi.fn().mockResolvedValue(speechState()),
  speechToTextInstall: vi.fn().mockResolvedValue(speechState()),
  speechToTextStart: vi.fn().mockResolvedValue(speechState()),
  speechToTextStop: vi.fn().mockResolvedValue(speechState({ running: false, status: 'stopped' })),
  speechToTextUpdateConfig: vi.fn().mockResolvedValue(speechState()),
  speechToTextPickAudio: vi.fn().mockResolvedValue({ canceled: true }),
  speechToTextProcess: vi.fn().mockResolvedValue({ success: true, text: 'Transcript' } satisfies SpeechToTextProcessResult),
  speechToTextProcessUpload: vi.fn().mockResolvedValue({ success: true, text: 'Recording transcript' } satisfies SpeechToTextProcessResult),
  microphonePermissionStatus: vi.fn().mockResolvedValue('granted'),
  microphonePermissionRequest: vi.fn().mockResolvedValue('granted'),
  desktopLog: vi.fn().mockResolvedValue(undefined),
  wakeWordGetState: vi.fn().mockResolvedValue(wakeState()),
  wakeWordInstall: vi.fn().mockResolvedValue(wakeState()),
  wakeWordStop: vi.fn().mockResolvedValue(wakeState({ status: 'stopped', running: false })),
  wakeWordUpdateConfig: vi.fn().mockResolvedValue(wakeState()),
  onWakeWordChanged: vi.fn().mockReturnValue(vi.fn()),
  textToSpeechGetState: vi.fn().mockResolvedValue(ttsState()),
  textToSpeechInstall: vi.fn().mockResolvedValue(ttsState()),
  textToSpeechStart: vi.fn().mockResolvedValue(ttsState()),
  textToSpeechStop: vi.fn().mockResolvedValue(ttsState({ running: false, status: 'stopped' })),
  textToSpeechUpdateConfig: vi.fn().mockResolvedValue(ttsState()),
  textToSpeechSynthesize: vi.fn().mockResolvedValue({ success: true, userMessage: 'Speech ready' }),
  getDeveloperPathState: vi.fn().mockResolvedValue(developerPathState),
});

const profile = (
  id: string,
  provider: LlmProviderProfileMetadata['provider'],
  overrides: Partial<LlmProviderProfileMetadata> = {},
): LlmProviderProfileMetadata => ({
  id,
  provider,
  label: `${provider} ${id}`,
  authMode: 'account',
  runtimeAuthMode: 'account',
  status: 'connected',
  ...overrides,
});

const updateState = (
  status: DesktopUpdateState['status'],
  overrides: Partial<DesktopUpdateState> = {},
): DesktopUpdateState => ({ status, currentVersion: '0.5.16', ...overrides });

const baseHandlers = () => ({
  onInitialSubviewConsumed: vi.fn(),
  onThemeChange: vi.fn(),
  onLanguageChange: vi.fn(),
  onChatBotPictureChange: vi.fn(),
  onAgentDefaultsChange: vi.fn(),
  onActiveProviderProfileChange: vi.fn(),
  onProviderProfileDefaultsChange: vi.fn(),
  onDeveloperModeChange: vi.fn().mockResolvedValue(undefined),
  onOpenCodexConfig: vi.fn(),
  onDisconnectCodex: vi.fn(),
  onReinstallCodex: vi.fn(),
  onOpenClaudeConfig: vi.fn(),
  onDisconnectClaude: vi.fn(),
  onReinstallClaude: vi.fn(),
  onOpenAntigravityConfig: vi.fn(),
  onDisconnectAntigravity: vi.fn(),
  onReinstallAntigravity: vi.fn(),
  onCancelAntigravityAuthSession: vi.fn(),
  onCloseAntigravityAuthConsole: vi.fn(),
  onRefreshCloudStorage: vi.fn(),
  onCheckDesktopUpdates: vi.fn(),
  onDownloadDesktopUpdate: vi.fn(),
  onInstallDesktopUpdate: vi.fn(),
  onCreateMemory: vi.fn(),
  onUpdateMemory: vi.fn(),
  onDeleteMemory: vi.fn(),
  onRevealCloudSecretKey: vi.fn().mockResolvedValue('revealed-secret'),
  onRegenerateCloudSecretKey: vi.fn(),
  onEnterForum: vi.fn(),
  onUsageAnalyticsChange: vi.fn(),
  onNavigate: vi.fn(),
  onResetOnboarding: vi.fn(),
});

const baseProps = (): Props => ({
  codexAuthBusy: false,
  claudeAuthBusy: false,
  antigravityAuthBusy: false,
  codexAuthStatus: { installed: true, authenticated: true, authFilePath: '/auth.json', codexHome: '/codex', codexCliPath: '/bin/codex' },
  claudeAuthStatus: { installed: true, authenticated: false, source: 'managed', claudeCliPath: '/bin/claude' },
  antigravityAuthStatus: { installed: false, authenticated: false, source: 'missing' },
  t,
  themePreference: 'system',
  languagePreference: 'system',
  activeLocale: 'en',
  systemLocale: 'es',
  chatBotPicture: 'forger',
  chatBotPictureOptions: [
    { value: 'forger', label: 'Forger bot', src: 'forger.svg' },
    { value: 'codex', label: 'Codex bot', src: 'codex.svg' },
  ],
  modelOptions: [
    { displayModelName: '5.4', realModelName: 'gpt-5.4', defaultReasoningEffort: 'medium' },
    { displayModelName: '5.6 Sol', realModelName: 'gpt-5.6-sol', defaultReasoningEffort: 'low' },
  ],
  reasoningOptions: [
    { label: 'Low', value: 'low' },
    { label: 'Medium', value: 'medium' },
    { label: 'High', value: 'high' },
  ],
  providerOptions: [
    { label: 'Automatic', value: 'auto' },
    { label: 'ChatGPT', value: 'codex' },
    { label: 'Claude', value: 'claude' },
    { label: 'Google', value: 'antigravity' },
  ],
  claudeModelOptions: [
    { displayModelName: 'Sonnet 5', realModelName: 'claude-sonnet-5' },
    { displayModelName: 'Opus 4.8', realModelName: 'claude-opus-4-8' },
  ],
  claudeEffortOptions: [
    { label: 'Low', value: 'low' },
    { label: 'High', value: 'high' },
  ],
  antigravityModelOptions: [
    {
      displayModelName: 'Gemini 3.5 Flash', realModelName: 'gemini-3.5-flash', defaultEffort: 'medium',
      cliModelByEffort: { low: 'gemini-low', medium: 'gemini-medium', high: 'gemini-high' },
    },
    {
      displayModelName: 'Gemini 3.1 Pro', realModelName: 'gemini-3.1-pro', defaultEffort: 'high',
      cliModelByEffort: { low: 'pro-low', high: 'pro-high' },
    },
  ],
  antigravityEffortOptions: [
    { label: 'Low', value: 'low' },
    { label: 'Medium', value: 'medium' },
    { label: 'High', value: 'high' },
  ],
  defaultAgentProvider: 'auto',
  defaultChatPermissionMode: 'safe',
  defaultChatNetworkAccess: false,
  providerInactivityTimeoutMinutes: { codex: 0, claude: 30, antigravity: 60 },
  agentDefaults: {
    codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
    claude: { model: 'claude-sonnet-5', effort: 'high' },
    antigravity: { model: 'gemini-3.5-flash', effort: 'medium' },
  },
  providerConnections: { codex: 'codex-account' },
  llmProviderProfiles: {},
  activeProviderProfiles: {},
  developerMode: { enabled: false, pathEntries: [] },
  antigravityAuthConsoleOpen: false,
  desktopUpdateState: updateState('idle'),
  desktopUpdateBusy: false,
  cloudStorageUsage: null,
  cloudStorageBusy: false,
  installedApps: [
    { id: 'planner', name: 'Planner', category: 'productivity', status: 'installed' },
    { id: 'notes', category: 'productivity', status: 'installed' },
  ],
  memories: [],
  cloudIdentity: { publicKey: 'public', keyFingerprint: 'fingerprint', secretKeyPreview: 'secret-preview', createdAt: now, updatedAt: now },
  usageAnalyticsEnabled: false,
  forumParticipation: { status: 'opted_out', isModerator: false },
  forumParticipationBusy: false,
  ...baseHandlers(),
});

const renderSettings = (overrides: Partial<Props> = {}, bridge = makeBridge()) => {
  Object.defineProperty(window, 'forger', { configurable: true, value: bridge });
  const props = { ...baseProps(), ...overrides } as Props;
  const result = render(<SettingsView {...props} />);
  return { ...result, props, bridge };
};

const choose = async (
  user: ReturnType<typeof userEvent.setup>,
  select: HTMLElement,
  option: string,
) => {
  await user.click(select);
  await user.click(await screen.findByRole('option', { name: option }));
};

const memory = (id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  scope: 'global',
  kind: 'preference',
  title: `Memory ${id}`,
  body: `Remember ${id}`,
  text: `Remember ${id}`,
  readWhen: '',
  status: 'active',
  source: 'settings',
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn().mockResolvedValue([]),
      getUserMedia: vi.fn().mockRejectedValue(new Error('No microphone fixture')),
    },
  });
});

describe('SettingsView main navigation, appearance, and updates', () => {
  it('renders the grouped settings home and delegates navigation and beta actions', async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    expect(screen.getByRole('heading', { name: t.sections.settings.title })).toBeInTheDocument();
    expect(screen.getByText(t.settings.openBetaTitle)).toBeInTheDocument();
    expect(screen.getByText(t.settings.llmProviderConnectedChip)).toBeInTheDocument();
    for (const heading of Object.values(t.settings.settingsGroups)) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: new RegExp(t.settings.sidebarFeaturesTitle) }));
    await user.click(screen.getByRole('button', { name: new RegExp(t.nav.docs) }));
    await user.click(screen.getByRole('button', { name: t.settings.resetOnboarding }));
    expect(view.props.onNavigate).toHaveBeenNthCalledWith(1, 'more');
    expect(view.props.onNavigate).toHaveBeenNthCalledWith(2, 'docs');
    expect(view.props.onResetOnboarding).toHaveBeenCalledOnce();
  });

  it('navigates to appearance and delegates language, theme, and bot choices while ignoring deselection', async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    await user.click(screen.getByRole('button', { name: new RegExp(t.settings.appearance) }));
    expect(screen.getByText(t.settings.activeLanguage(t.settings.languageNames.en))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.settings.languageSystem(t.settings.languageNames.es) }));
    const spanish = screen.getByRole('button', { name: t.settings.languageNames.es });
    await user.click(spanish);
    await user.click(screen.getByRole('button', { name: t.settings.themeSystem }));
    const dark = screen.getByRole('button', { name: t.settings.themeDark });
    await user.click(dark);
    await user.click(screen.getByRole('button', { name: /Forger bot/ }));
    const codexBot = screen.getByRole('button', { name: /Codex bot/ });
    await user.click(codexBot);
    expect(view.props.onLanguageChange).toHaveBeenCalledWith('es');
    expect(view.props.onLanguageChange).toHaveBeenCalledTimes(1);
    expect(view.props.onThemeChange).toHaveBeenCalledWith('dark');
    expect(view.props.onThemeChange).toHaveBeenCalledTimes(1);
    expect(view.props.onChatBotPictureChange).toHaveBeenCalledWith('codex');
    expect(view.props.onChatBotPictureChange).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: t.settings.backToSettings }));
    expect(screen.getByRole('heading', { name: t.sections.settings.title })).toBeInTheDocument();
  });

  it('honors initial subviews and optional consumption callbacks', async () => {
    const view = renderSettings({ initialSubview: 'appearance' });
    expect(await screen.findByRole('heading', { name: t.settings.appearance })).toBeInTheDocument();
    expect(view.props.onInitialSubviewConsumed).toHaveBeenCalledOnce();
    view.unmount();
    renderSettings({ initialSubview: 'privacySecurity', onInitialSubviewConsumed: undefined });
    expect(await screen.findByRole('heading', { name: t.settings.privacy })).toBeInTheDocument();
  });

  it('opens and returns from every settings row and shows disconnected-provider state', async () => {
    const user = userEvent.setup();
    renderSettings({
      providerConnections: {},
      codexAuthStatus: { installed: true, authenticated: true },
      claudeAuthStatus: { installed: true, authenticated: true },
      antigravityAuthStatus: { installed: true, authenticated: true },
    });
    expect(screen.getByText(t.settings.llmProviderNotConnectedChip)).toBeInTheDocument();
    const destinations = [
      t.settings.llmProviderTitle,
      t.settings.memoryTitle,
      t.settings.speechTitle,
      t.settings.wakeWordTitle,
      t.settings.ttsTitle,
      t.settings.storageTitle,
      t.settings.privacy,
      t.settings.developerModeTitle,
    ];
    for (const destination of destinations) {
      await user.click(screen.getByRole('button', { name: new RegExp(destination) }));
      expect(screen.getAllByRole('heading', { name: destination }).length).toBeGreaterThan(0);
      await user.click(screen.getByRole('button', { name: t.settings.backToSettings }));
    }
  });

  it('recognizes each connected provider after preceding providers are unavailable', () => {
    const cases: Partial<Props>[] = [
      {
        providerConnections: { claude: 'claude-account' },
        codexAuthStatus: { installed: true, authenticated: false },
        claudeAuthStatus: { installed: true, authenticated: true },
      },
      {
        providerConnections: { antigravity: 'google-account' },
        codexAuthStatus: { installed: true, authenticated: false },
        claudeAuthStatus: { installed: true, authenticated: false },
        antigravityAuthStatus: { installed: true, authenticated: true },
      },
    ];
    for (const props of cases) {
      const view = renderSettings(props);
      expect(screen.getByText(t.settings.llmProviderConnectedChip)).toBeInTheDocument();
      view.unmount();
    }
  });

  it('renders update status, release-note, progress, and action variants', async () => {
    const user = userEvent.setup();
    const cases: DesktopUpdateState[] = [
      updateState('available', {
        availableVersion: '0.6.0',
        asset: { platform: 'darwin', arch: 'arm64', kind: 'dmg', url: 'https://updates.example/app.dmg' },
        releaseNotes: { summary: 'A major release', changes: ['Faster startup'] },
        userMessage: 'Ready to download',
      }),
      updateState('ready', { availableVersion: '0.6.0', downloadedPath: '/tmp/Forger.dmg' }),
      updateState('downloading', { progress: 0.426, releaseNotes: { changes: [] } }),
      updateState('downloading'),
      updateState('up_to_date'),
      updateState('error', { userMessage: 'Update failed' }),
      updateState('unsupported', { userMessage: 'Platform unsupported' }),
    ];

    for (const update of cases) {
      const view = renderSettings({ desktopUpdateState: update });
      expect(screen.getByText(t.settings.desktopUpdateStatuses[update.status])).toBeInTheDocument();
      if (update.status === 'available') {
        await user.click(screen.getByRole('button', { name: t.settings.desktopCheckUpdates }));
        await user.click(screen.getByRole('button', { name: t.settings.desktopDownloadUpdate }));
        expect(view.props.onCheckDesktopUpdates).toHaveBeenCalledOnce();
        expect(view.props.onDownloadDesktopUpdate).toHaveBeenCalledOnce();
        expect(screen.getByText('A major release')).toBeInTheDocument();
        expect(screen.getByText('Faster startup')).toBeInTheDocument();
      } else if (update.status === 'ready') {
        await user.click(screen.getByRole('button', { name: t.settings.desktopInstallUpdate }));
        expect(view.props.onInstallDesktopUpdate).toHaveBeenCalledOnce();
      } else if (update.status === 'downloading' && update.progress !== undefined) {
        expect(screen.getByText(t.settings.desktopDownloadProgress(43))).toBeInTheDocument();
        expect(screen.getByText(t.appView.updateNoChangelog)).toBeInTheDocument();
      } else if (update.status === 'downloading') {
        expect(screen.getByText(t.settings.desktopDownloading)).toBeInTheDocument();
      }
      view.unmount();
    }

    const busy = renderSettings({ desktopUpdateBusy: true });
    expect(screen.getByRole('button', { name: t.settings.desktopCheckUpdates })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.settings.desktopDownloadUpdate })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.settings.desktopInstallUpdate })).toBeDisabled();
    busy.unmount();
  });
});

describe('SettingsView storage, privacy, and developer settings', () => {
  const storage = (
    usedBytes: number,
    limitBytes: number,
    remainingBytes: number,
  ): CloudStorageUsage => ({
    usedBytes,
    limitBytes,
    remainingBytes,
    plan: 'pro',
    breakdown: {
      backupsBytes: 2 * 1024 ** 3,
      uploadedAppsBytes: 12 * 1024 ** 2,
      pendingUserAppUploadsBytes: 512 * 1024,
      otherBytes: 400,
    },
  });

  it('shows storage usage levels, units, unavailable states, and management navigation', async () => {
    const user = userEvent.setup();
    const fullUsage = storage(10 * 1024 ** 3, 10 * 1024 ** 3, 0);
    const view = renderSettings({ initialSubview: 'storage', cloudStorageUsage: fullUsage });
    expect(await screen.findByText(t.settings.storageLimitReached)).toBeInTheDocument();
    expect(screen.getByText(t.settings.storageUsedOfLimit('10 GB', '10 GB'))).toBeInTheDocument();
    expect(screen.getByText('2 GB')).toBeInTheDocument();
    expect(screen.getByText('13 MB')).toBeInTheDocument();
    expect(screen.getByText('0 MB')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.settings.storageRefresh }));
    await user.click(screen.getByRole('button', { name: t.settings.storageManageBackups }));
    await user.click(screen.getByRole('button', { name: t.settings.storageManageUploadedApps }));
    expect(view.props.onRefreshCloudStorage).toHaveBeenCalledOnce();
    expect(view.props.onNavigate).toHaveBeenNthCalledWith(1, 'backups');
    expect(view.props.onNavigate).toHaveBeenNthCalledWith(2, 'friends');
    view.unmount();

    const warning = renderSettings({ initialSubview: 'storage', cloudStorageUsage: storage(85, 100, 15) });
    expect(await screen.findByText(t.settings.storageRemaining('0 MB'))).toBeInTheDocument();
    warning.unmount();
    const normal = renderSettings({ initialSubview: 'storage', cloudStorageUsage: storage(10, 100, 90) });
    expect(await screen.findByText(t.settings.storagePlanLabel('pro'))).toBeInTheDocument();
    normal.unmount();
    const zeroLimit = renderSettings({ initialSubview: 'storage', cloudStorageUsage: storage(0, 0, 0) });
    expect(await screen.findByText(t.settings.storageUsedOfLimit('0 MB', '0 MB'))).toBeInTheDocument();
    zeroLimit.unmount();

    const loading = renderSettings({ initialSubview: 'storage', cloudStorageBusy: true });
    expect(await screen.findByText(t.settings.storageLoading)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.settings.storageRefresh })).toBeDisabled();
    loading.unmount();
    renderSettings({ initialSubview: 'storage' });
    expect((await screen.findAllByText(t.settings.storageUnavailable)).length).toBeGreaterThan(0);
  });

  it('reveals, copies, regenerates, and toggles private-account settings', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const view = renderSettings({ initialSubview: 'privacySecurity' });
    const keyField = await screen.findByLabelText(t.settings.secretKeyLabel);
    expect(keyField).toHaveAttribute('type', 'password');
    expect(keyField).toHaveValue('secret-preview');
    await user.click(screen.getByRole('button', { name: t.settings.secretKeyCopy }));
    expect(writeText).toHaveBeenCalledWith('secret-preview');
    await user.click(screen.getByRole('button', { name: t.settings.secretKeyReveal }));
    await waitFor(() => expect(keyField).toHaveValue('revealed-secret'));
    expect(keyField).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: t.settings.secretKeyCopy }));
    expect(writeText).toHaveBeenLastCalledWith('revealed-secret');
    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: t.settings.secretKeyRegenerate }));
    expect(view.props.onRegenerateCloudSecretKey).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: t.settings.secretKeyRegenerate }));
    expect(view.props.onRegenerateCloudSecretKey).toHaveBeenCalledOnce();
    expect(keyField).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('switch', { name: t.settings.usageAnalyticsToggle }));
    expect(view.props.onUsageAnalyticsChange).toHaveBeenCalledWith(true);
    view.unmount();

    renderSettings({ initialSubview: 'privacySecurity', cloudIdentity: null });
    expect(await screen.findByLabelText(t.settings.secretKeyLabel)).toHaveValue('');
  });

  it('toggles developer mode, edits paths, prevents duplicates, saves, and exposes failures', async () => {
    const user = userEvent.setup();
    const disabled = renderSettings({ initialSubview: 'developerMode' });
    await user.click(await screen.findByRole('switch', { name: t.settings.developerModeToggle }));
    expect(disabled.props.onDeveloperModeChange).toHaveBeenCalledWith({ enabled: true });
    disabled.unmount();

    const view = renderSettings({
      initialSubview: 'developerMode',
      developerMode: { enabled: true, pathEntries: ['/existing/bin'] },
    });
    const path = await screen.findByLabelText(t.settings.developerPathEntriesLabel);
    expect(path).toHaveValue('/existing/bin');
    expect(await screen.findByText('/runtime/bin')).toBeInTheDocument();
    const homebrew = screen.getByRole('button', { name: t.settings.developerQuickAddPath('/opt/homebrew/bin') });
    await user.click(homebrew);
    expect(path).toHaveValue('/existing/bin\n/opt/homebrew/bin');
    expect(homebrew).toBeDisabled();
    await user.clear(path);
    await user.type(path, ' /custom/bin \n\n /second/bin ');
    await user.click(screen.getByRole('button', { name: t.settings.developerPathSave }));
    expect(view.props.onDeveloperModeChange).toHaveBeenLastCalledWith({ pathEntries: [' /custom/bin ', '', ' /second/bin '] });
    view.unmount();

    const errorHandler = vi.fn().mockRejectedValue('failed');
    renderSettings({
      initialSubview: 'developerMode',
      developerMode: { enabled: true, pathEntries: [] },
      onDeveloperModeChange: errorHandler,
    });
    await user.click(await screen.findByRole('button', { name: t.settings.developerPathSave }));
    expect(await screen.findByText(t.settings.developerPathSaveError)).toBeInTheDocument();

    const errorBridge = makeBridge();
    errorBridge.getDeveloperPathState.mockResolvedValue({
      enabled: true,
      globalPathEntries: [],
      appPathEntries: [],
      runtimePathEntries: [],
      systemPathEntries: [],
      effectivePathEntries: [],
    });
    const errorView = renderSettings({
      initialSubview: 'developerMode',
      developerMode: { enabled: true, pathEntries: [] },
      onDeveloperModeChange: vi.fn().mockRejectedValue(new Error('Developer save exploded')),
    }, errorBridge);
    expect((await screen.findAllByText('-')).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: t.settings.developerPathSave }).at(-1)!);
    expect(await screen.findByText('Developer save exploded')).toBeInTheDocument();
    errorView.unmount();
  });
});

describe('SettingsView memory behavior', () => {
  const memories = [
    memory('global', {
      usage: [{ id: 'usage', memoryId: 'global', caller: 'settings', createdAt: now }],
      evidence: [{ id: 'evidence', memoryId: 'global', source: 'user', excerpt: 'The user said this', createdAt: now }],
    }),
    memory('planner', { scope: 'app', appId: 'planner', kind: 'workflow', status: 'candidate', readWhen: 'When planning' }),
    memory('missing-app', { scope: 'app', appId: 'missing', kind: 'fact', status: 'archived' }),
    memory('ignored-app', { scope: 'app', appId: undefined }),
  ];

  it('validates, creates, resets, edits, updates, and deletes global and app memories', async () => {
    const user = userEvent.setup();
    const view = renderSettings({ initialSubview: 'memory', memories });
    expect((await screen.findAllByText(t.settings.memoryGlobalGroup)).length).toBeGreaterThan(1);
    expect(screen.getByText(t.settings.memoryAppGroup('Planner'))).toBeInTheDocument();
    expect(screen.getByText(t.settings.memoryAppGroup('missing'))).toBeInTheDocument();
    expect(screen.getAllByText(t.settings.memoryAlwaysInjected).length).toBeGreaterThan(0);
    expect(screen.getByText(t.settings.memoryReadWhenValue('When planning'))).toBeInTheDocument();
    expect(screen.getByText(t.settings.memoryEvidence('The user said this'))).toBeInTheDocument();
    expect(screen.getByText(t.settings.memoryLastUsed(new Date(now).toLocaleString()))).toBeInTheDocument();

    const save = screen.getByRole('button', { name: t.settings.memorySave });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(t.settings.memoryBody), 'A global preference');
    await user.type(screen.getByLabelText(t.settings.memoryTitleLabel), 'Tone');
    await user.type(screen.getByLabelText(t.settings.memoryReadWhen), 'When writing');
    await choose(user, screen.getByRole('combobox', { name: t.settings.memoryKind }), t.settings.memoryKinds.constraint);
    await choose(user, screen.getByRole('combobox', { name: t.settings.memoryStatus }), t.settings.memoryStatuses.candidate);
    await user.click(save);
    expect(view.props.onCreateMemory).toHaveBeenCalledWith({
      scope: 'global', appId: undefined, kind: 'constraint', title: 'Tone', body: 'A global preference', readWhen: 'When writing', status: 'candidate',
    });
    expect(screen.getByLabelText(t.settings.memoryBody)).toHaveValue('');

    await choose(user, screen.getByRole('combobox', { name: t.settings.memoryScope }), t.settings.memoryScopeApp);
    await user.type(screen.getByLabelText(t.settings.memoryBody), 'App memory');
    expect(save).toBeDisabled();
    await choose(user, screen.getByRole('combobox', { name: t.settings.memoryApp }), 'Planner');
    expect(save).toBeEnabled();
    await user.click(save);
    expect(view.props.onCreateMemory).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'app', appId: 'planner', body: 'App memory' }));
    await choose(user, screen.getByRole('combobox', { name: t.settings.memoryScope }), t.settings.memoryScopeApp);
    await choose(user, screen.getByRole('combobox', { name: t.settings.memoryApp }), 'Planner');
    await choose(user, screen.getByRole('combobox', { name: t.settings.memoryScope }), t.settings.memoryScopeGlobal);
    expect(screen.getByRole('combobox', { name: t.settings.memoryApp })).not.toHaveTextContent('Planner');
    await user.click(screen.getByRole('button', { name: t.settings.memoryCancel }));

    const globalTitle = screen.getByText('Memory global');
    const globalRow = globalTitle.closest('.MuiStack-root')?.parentElement?.parentElement as HTMLElement;
    const iconButtons = within(globalRow).getAllByRole('button');
    await user.click(iconButtons[0] as HTMLElement);
    expect(screen.getByRole('heading', { name: t.settings.memoryEdit })).toBeInTheDocument();
    await user.clear(screen.getByLabelText(t.settings.memoryBody));
    await user.type(screen.getByLabelText(t.settings.memoryBody), 'Updated memory');
    await user.click(screen.getByRole('button', { name: t.settings.memorySave }));
    expect(view.props.onUpdateMemory).toHaveBeenCalledWith(expect.objectContaining({ id: 'global', body: 'Updated memory' }));
    await user.click(iconButtons[1] as HTMLElement);
    expect(view.props.onDeleteMemory).toHaveBeenCalledWith('global');
  });

  it('shows a true empty state and omits empty groups', async () => {
    renderSettings({ initialSubview: 'memory', memories: [] });
    expect(await screen.findByText(t.settings.memoryEmpty)).toBeInTheDocument();
    expect(screen.getAllByText(t.settings.memoryGlobalGroup)).toHaveLength(1);
  });
});

describe('SettingsView LLM provider behavior', () => {
  const allAuthenticated: Partial<Props> = {
    codexAuthStatus: { installed: true, authenticated: true, authFilePath: '', codexHome: '' },
    claudeAuthStatus: { installed: true, authenticated: true, source: 'managed' },
    antigravityAuthStatus: { installed: true, authenticated: true, source: 'managed' },
    providerConnections: { codex: 'codex', claude: 'claude', antigravity: 'antigravity' },
  };

  const card = (title: string) => screen.getByRole('heading', { name: title }).closest('.MuiCard-root') as HTMLElement;

  it('renders installed/authenticated states and delegates install, sign-in, reinstall, disconnect, and dialog actions', async () => {
    const user = userEvent.setup();
    const dialogView = renderSettings({ initialSubview: 'llmProvider', antigravityAuthConsoleOpen: true });
    const dialog = await screen.findByRole('dialog', { name: t.settings.antigravityAuthDialogTitle });
    expect(within(dialog).getByText(t.settings.antigravityAuthStepTerminal)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: t.settings.antigravityAuthClose }));
    expect(dialogView.props.onCancelAntigravityAuthSession).toHaveBeenCalledOnce();
    await user.keyboard('{Escape}');
    expect(dialogView.props.onCloseAntigravityAuthConsole).toHaveBeenCalledOnce();
    dialogView.unmount();

    const view = renderSettings({ initialSubview: 'llmProvider' });
    expect(await screen.findByText(t.settings.providerStatusAuthenticated)).toBeInTheDocument();
    expect(screen.getByText(t.settings.providerStatusUnauthenticated)).toBeInTheDocument();
    expect(screen.getByText(t.settings.providerStatusUninstalled)).toBeInTheDocument();
    const codex = within(card(t.settings.codexTitle));
    const claude = within(card(t.settings.claudeCodeTitle));
    const antigravity = within(card(t.settings.antigravityTitle));
    await user.click(codex.getByRole('button', { name: t.settings.providerReinstallAction }));
    await user.click(codex.getByRole('button', { name: t.settings.providerDisconnectAction }));
    await user.click(claude.getByRole('button', { name: t.settings.providerSignInAction }));
    await user.click(claude.getByRole('button', { name: t.settings.providerReinstallAction }));
    await user.click(antigravity.getByRole('button', { name: t.settings.providerInstallAction }));
    expect(view.props.onReinstallCodex).toHaveBeenCalledOnce();
    expect(view.props.onDisconnectCodex).toHaveBeenCalledOnce();
    expect(view.props.onOpenClaudeConfig).toHaveBeenCalledOnce();
    expect(view.props.onReinstallClaude).toHaveBeenCalledOnce();
    expect(view.props.onReinstallAntigravity).toHaveBeenCalledOnce();
  });

  it('disables provider actions and dialog dismissal while authentication is busy', async () => {
    const user = userEvent.setup();
    const view = renderSettings({
      initialSubview: 'llmProvider',
      antigravityAuthConsoleOpen: true,
      antigravityAuthBusy: true,
      codexAuthBusy: true,
      claudeAuthBusy: true,
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: t.settings.antigravityAuthCancel })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(view.props.onCloseAntigravityAuthConsole).not.toHaveBeenCalled();
    view.unmount();
    renderSettings({
      initialSubview: 'llmProvider',
      antigravityAuthBusy: true,
      codexAuthBusy: true,
      claudeAuthBusy: true,
    });
    expect(within(card(t.settings.codexTitle)).getByRole('button', { name: t.settings.providerDisconnectAction })).toBeDisabled();
    expect(within(card(t.settings.claudeCodeTitle)).getByRole('button', { name: t.settings.providerSignInAction })).toBeDisabled();
    expect(within(card(t.settings.antigravityTitle)).getByRole('button', { name: t.settings.providerInstallAction })).toBeDisabled();
  });

  it('updates provider models, efforts, timeouts, profiles, and global chat defaults', async () => {
    const user = userEvent.setup();
    const profiles = {
      codex: [profile('codex-active', 'codex', { defaultModel: 'gpt-5.4', defaultEffort: 'medium' })],
      claude: [
        profile('claude-default', 'claude', { isDefault: true, defaultModel: 'claude-sonnet-5', defaultEffort: 'high' }),
        profile('claude-other', 'claude'),
      ],
      antigravity: [profile('antigravity-first', 'antigravity', { defaultModel: 'gemini-3.5-flash', defaultEffort: 'medium' })],
    };
    const view = renderSettings({
      initialSubview: 'llmProvider',
      ...allAuthenticated,
      llmProviderProfiles: profiles,
      activeProviderProfiles: { codex: 'codex-active', claude: 'missing-active' },
    });
    await screen.findAllByText(t.settings.providerStatusAuthenticated);
    const codex = within(card(t.settings.codexTitle));
    const claude = within(card(t.settings.claudeCodeTitle));
    const antigravity = within(card(t.settings.antigravityTitle));
    await choose(user, codex.getByRole('combobox', { name: t.settings.providerDefaultModelLabel }), '5.6 Sol');
    await choose(user, codex.getByRole('combobox', { name: t.settings.providerDefaultEffortLabel }), 'High');
    await choose(user, codex.getByRole('combobox', { name: t.settings.providerInactivityTimeoutLabel }), `30 ${t.settings.providerTimeoutMinutes}`);
    await choose(user, claude.getByRole('combobox', { name: t.settings.providerDefaultModelLabel }), 'Opus 4.8');
    await choose(user, claude.getByRole('combobox', { name: t.settings.providerDefaultEffortLabel }), 'Low');
    await choose(user, claude.getByRole('combobox', { name: t.settings.providerInactivityTimeoutLabel }), `1 ${t.settings.providerTimeoutHour}`);
    await choose(user, antigravity.getByRole('combobox', { name: t.settings.providerDefaultModelLabel }), 'Gemini 3.1 Pro');
    await choose(user, antigravity.getByRole('combobox', { name: t.settings.providerDefaultEffortLabel }), 'Low');
    await choose(user, antigravity.getByRole('combobox', { name: t.settings.providerInactivityTimeoutLabel }), t.settings.providerTimeoutUnlimited);
    expect(view.props.onProviderProfileDefaultsChange).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', profileId: 'codex-active', model: 'gpt-5.6-sol' }));
    expect(view.props.onProviderProfileDefaultsChange).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', profileId: 'claude-default', model: 'claude-opus-4-8' }));
    expect(view.props.onProviderProfileDefaultsChange).toHaveBeenCalledWith(expect.objectContaining({ provider: 'antigravity', profileId: 'antigravity-first', model: 'gemini-3.1-pro' }));
    expect(view.props.onAgentDefaultsChange).toHaveBeenCalledWith({ provider: 'codex', inactivityTimeoutMinutes: 30 });
    expect(view.props.onAgentDefaultsChange).toHaveBeenCalledWith({ provider: 'claude', inactivityTimeoutMinutes: 60 });
    expect(view.props.onAgentDefaultsChange).toHaveBeenCalledWith({ provider: 'antigravity', inactivityTimeoutMinutes: 0 });

    const defaultsCard = screen.getByText(t.settings.agentDefaultProviderTitle).closest('.MuiCard-root') as HTMLElement;
    const defaults = within(defaultsCard);
    await choose(user, defaults.getByRole('combobox', { name: t.settings.agentDefaultProvider }), 'ChatGPT');
    await choose(user, defaults.getByRole('combobox', { name: t.settings.agentDefaultChatPermissions }), t.sections.chat.permissionElevatedLabel);
    await choose(user, defaults.getByRole('combobox', { name: t.settings.agentDefaultChatNetwork }), t.sections.chat.networkEnabledLabel);
    expect(view.props.onAgentDefaultsChange).toHaveBeenCalledWith({ defaultProvider: 'codex' });
    expect(view.props.onAgentDefaultsChange).toHaveBeenCalledWith({ defaultProvider: 'auto', defaultChatPermissionMode: 'unsafe' });
    expect(view.props.onAgentDefaultsChange).toHaveBeenCalledWith({ defaultProvider: 'auto', defaultChatNetworkAccess: true });
    await user.click(screen.getByText(t.settings.technicalDetails));
    expect(screen.getByText(t.settings.codexCliPathLabel, { exact: false })).toHaveTextContent('-');
  });

  it('falls back to agent defaults when profiles are absent and handles every provider action', async () => {
    const user = userEvent.setup();
    const view = renderSettings({ initialSubview: 'llmProvider', ...allAuthenticated, agentDefaults: {} as Props['agentDefaults'] });
    await screen.findAllByText(t.settings.providerStatusAuthenticated);
    const codex = within(card(t.settings.codexTitle));
    const claude = within(card(t.settings.claudeCodeTitle));
    const antigravity = within(card(t.settings.antigravityTitle));
    await choose(user, codex.getByRole('combobox', { name: t.settings.providerDefaultModelLabel }), '5.6 Sol');
    await choose(user, codex.getByRole('combobox', { name: t.settings.providerDefaultEffortLabel }), 'High');
    await choose(user, claude.getByRole('combobox', { name: t.settings.providerDefaultModelLabel }), 'Opus 4.8');
    await choose(user, claude.getByRole('combobox', { name: t.settings.providerDefaultEffortLabel }), 'Low');
    await choose(user, antigravity.getByRole('combobox', { name: t.settings.providerDefaultModelLabel }), 'Gemini 3.1 Pro');
    await choose(user, antigravity.getByRole('combobox', { name: t.settings.providerDefaultEffortLabel }), 'Low');
    expect(view.props.onAgentDefaultsChange).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', model: 'gpt-5.6-sol' }));
    expect(view.props.onAgentDefaultsChange).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', model: 'claude-opus-4-8' }));
    expect(view.props.onAgentDefaultsChange).toHaveBeenCalledWith(expect.objectContaining({ provider: 'antigravity', model: 'gemini-3.1-pro' }));
    await user.click(codex.getByRole('button', { name: t.settings.providerDisconnectAction }));
    await user.click(claude.getByRole('button', { name: t.settings.providerDisconnectAction }));
    await user.click(antigravity.getByRole('button', { name: t.settings.providerDisconnectAction }));
    expect(view.props.onDisconnectClaude).toHaveBeenCalledOnce();
    expect(view.props.onDisconnectAntigravity).toHaveBeenCalledOnce();
  });
});

describe('SettingsView speech-to-text behavior', () => {
  const richSpeechState = speechState({
    lastError: 'Previous speech failure',
    queue: [
      { id: 'queued', task: 'transcribe', path: '/audio/queued.wav', status: 'queued', createdAt: now, updatedAt: now },
      { id: 'completed', task: 'translate', path: '/audio/completed.wav', status: 'completed', createdAt: now, updatedAt: now },
    ],
    processedFiles: [
      { path: '/audio/done.wav', task: 'transcribe', processedAt: now, textPreview: 'A useful preview' },
      { path: '/audio/no-preview.wav', task: 'translate', processedAt: now },
    ],
    modelWorkers: [
      { model: 'base', status: 'busy', pinned: true, activeJobs: 1, queuedJobs: 2 },
      { model: 'small', status: 'idle', pinned: false, activeJobs: 0, queuedJobs: 0 },
    ],
  });

  it('renders running service diagnostics, filters completed queue work, stops, and refreshes', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.speechToTextGetState.mockResolvedValue(richSpeechState);
    bridge.speechToTextStop.mockResolvedValue(speechState({ status: 'stopped', running: false }));
    renderSettings({ initialSubview: 'speechToText' }, bridge);
    expect(await screen.findByText('Previous speech failure')).toBeInTheDocument();
    expect(screen.getByText('/audio/queued.wav')).toBeInTheDocument();
    expect(screen.queryByText('/audio/completed.wav')).not.toBeInTheDocument();
    expect(screen.getByText('/audio/done.wav')).toBeInTheDocument();
    expect(screen.getByText('/audio/no-preview.wav')).toBeInTheDocument();
    expect(screen.getByText('A useful preview')).toBeInTheDocument();
    expect(screen.getByText(t.settings.speechModelWorkerPinned, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(t.settings.speechModelWorkerOnDemand, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(t.settings.serverSettingsStoppedOnly)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.settings.speechInstall })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.settings.speechStart })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: t.settings.speechStop }));
    expect(bridge.speechToTextStop).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: t.settings.storageRefresh }));
    expect(bridge.speechToTextGetState.mock.calls.length).toBeGreaterThan(1);
  });

  it('installs and starts a stopped service, saves normalized config, and ignores invalid number characters', async () => {
    const user = userEvent.setup();
    const stopped = speechState({ status: 'not_installed', installed: false, running: false });
    const bridge = makeBridge();
    bridge.speechToTextGetState.mockResolvedValue(stopped);
    bridge.speechToTextInstall.mockResolvedValue(speechState({ status: 'installed', running: false }));
    const view = renderSettings({ initialSubview: 'speechToText' }, bridge);
    const install = await screen.findByRole('button', { name: t.settings.speechInstall });
    await user.click(install);
    expect(bridge.speechToTextInstall).toHaveBeenCalledOnce();
    view.unmount();

    const installed = speechState({ status: 'installed', installed: true, running: false });
    const configBridge = makeBridge();
    configBridge.speechToTextGetState.mockResolvedValue(installed);
    configBridge.speechToTextStart.mockResolvedValue(installed);
    renderSettings({ initialSubview: 'speechToText' }, configBridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechStart }));
    expect(configBridge.speechToTextStart).toHaveBeenCalledOnce();
    await choose(user, screen.getByRole('combobox', { name: t.settings.speechModel }), 'small · available');
    const concurrency = screen.getByRole('textbox', { name: t.settings.speechConcurrency });
    await user.clear(concurrency);
    await user.type(concurrency, 'abc');
    expect(concurrency).toHaveValue('');
    await user.tab();
    expect(concurrency).toHaveValue('0');
    const realtime = screen.getByRole('textbox', { name: t.settings.speechRealtimeSessions });
    await user.clear(realtime);
    await user.type(realtime, '3,5');
    await user.tab();
    expect(realtime).toHaveValue('3');
    await user.click(screen.getByRole('switch', { name: t.settings.speechAutoStart }));
    await user.click(screen.getByRole('button', { name: t.settings.memorySave }));
    expect(configBridge.speechToTextUpdateConfig).toHaveBeenCalledWith({
      model: 'small', maxConcurrentJobs: 0, maxRealtimeSessions: 3, autoStart: false,
    });
  });

  it('handles speech action Error and unknown failures and draft editing before state exists', async () => {
    const user = userEvent.setup();
    const unavailable = speechState({ status: 'not_installed', installed: false, running: false });
    const errorBridge = makeBridge();
    errorBridge.speechToTextGetState.mockResolvedValue(unavailable);
    errorBridge.speechToTextInstall.mockRejectedValueOnce(new Error('Installer unavailable')).mockRejectedValueOnce('unknown');
    const first = renderSettings({ initialSubview: 'speechToText' }, errorBridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechInstall }));
    expect(await screen.findByText('Installer unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.settings.speechInstall }));
    expect(await screen.findByText(t.settings.speechGenericError)).toBeInTheDocument();
    first.unmount();

    const noState = makeBridge();
    noState.speechToTextGetState.mockRejectedValue(new Error('not ready'));
    renderSettings({ initialSubview: 'speechToText' }, noState);
    const concurrency = await screen.findByRole('textbox', { name: t.settings.speechConcurrency });
    fireEvent.blur(concurrency);
    await user.clear(concurrency);
    await user.type(concurrency, '4');
    expect(concurrency).toHaveValue('4');
    expect(screen.getByRole('button', { name: t.settings.memorySave })).toBeDisabled();
  });

  it('ignores canceled and missing audio picks, then renders text, message, code, and failures', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.speechToTextGetState.mockResolvedValue(speechState());
    bridge.speechToTextPickAudio
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({ canceled: false })
      .mockResolvedValueOnce({ canceled: false, path: '/picked.wav' })
      .mockResolvedValueOnce({ canceled: false, path: '/message.wav' })
      .mockResolvedValueOnce({ canceled: false, path: '/code.wav' })
      .mockResolvedValueOnce({ canceled: false, path: '/error.wav' })
      .mockResolvedValueOnce({ canceled: false, path: '/unknown-error.wav' });
    bridge.speechToTextProcess
      .mockResolvedValueOnce({ success: true, text: 'Picked transcript' })
      .mockResolvedValueOnce({ success: false, userMessage: 'No speech detected' })
      .mockResolvedValueOnce({ success: false, technicalCode: 'speech_empty' })
      .mockRejectedValueOnce(new Error('Decoder failed'))
      .mockRejectedValueOnce('unknown');
    renderSettings({ initialSubview: 'speechToText' }, bridge);
    const pick = await screen.findByRole('button', { name: t.settings.speechPickAudio });
    await user.click(pick);
    await user.click(pick);
    expect(bridge.speechToTextProcess).not.toHaveBeenCalled();
    await user.click(pick);
    expect(await screen.findByText('Picked transcript')).toBeInTheDocument();
    await user.click(pick);
    expect(await screen.findByText('No speech detected')).toBeInTheDocument();
    await user.click(pick);
    expect(await screen.findByText('speech_empty')).toBeInTheDocument();
    await user.click(pick);
    expect(await screen.findByText('Decoder failed')).toBeInTheDocument();
    await user.click(pick);
    expect(await screen.findByText(t.settings.speechGenericError)).toBeInTheDocument();
  });
});

describe('SettingsView wake-word behavior', () => {
  it('shows repair, runtime diagnostics, detected confidence, and delegates repair, stop, and refresh', async () => {
    const user = userEvent.setup();
    const diagnosticState = wakeState({
      status: 'error',
      running: true,
      repairRequired: true,
      lastError: 'Wake listener crashed',
      runtime: {
        state: 'unavailable',
        modelId: 'hey-jarvis',
        updatedAt: now,
        confidence: 0.876,
        technicalCode: 'audio_device_lost',
      },
      lastDetection: {
        id: 'detection-1',
        deviceId: 'default',
        modelId: 'hey-jarvis',
        confidence: 0.87,
        detectedAt: now,
      },
    });
    const bridge = makeBridge();
    bridge.wakeWordGetState.mockResolvedValue(diagnosticState);
    bridge.wakeWordInstall.mockResolvedValue(diagnosticState);
    bridge.wakeWordStop.mockResolvedValue(wakeState());
    renderSettings({ initialSubview: 'wakeWord' }, bridge);
    expect(await screen.findByText('Wake listener crashed')).toBeInTheDocument();
    expect(screen.getAllByText(/Unavailable \(audio_device_lost\)/)).toHaveLength(2);
    expect(screen.getByText(`${t.settings.wakeWordConfidence}: 88%`)).toBeInTheDocument();
    expect(screen.getByText(t.settings.wakeWordLastDetection(now))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.settings.wakeWordRepair }));
    expect(bridge.wakeWordInstall).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: t.settings.wakeWordStop }));
    expect(bridge.wakeWordStop).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: t.settings.storageRefresh }));
    expect(bridge.wakeWordGetState.mock.calls.length).toBeGreaterThan(2);
  });

  it('uses enumerated microphone labels and saves switch, model, device, and normalized advanced values', async () => {
    const user = userEvent.setup();
    const configured = wakeState({
      config: { enabled: false, deviceId: '', modelId: 'missing-model', threshold: 0.5, patience: 2, cooldownMs: 2500 },
      models: [
        ...wakeState().models,
        { id: 'computer', displayName: 'Hey Computer', source: 'downloaded', installedAt: now, thresholdDefault: 0.6 },
      ],
    });
    const bridge = makeBridge();
    bridge.wakeWordGetState.mockResolvedValue(configured);
    bridge.wakeWordUpdateConfig.mockImplementation(async (input) => wakeState({
      ...configured,
      config: { ...configured.config, ...input },
    }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'videoinput', deviceId: 'camera', label: 'Camera' },
          { kind: 'audioinput', deviceId: '', label: '' },
          { kind: 'audioinput', deviceId: 'usb', label: '' },
          { kind: 'audioinput', deviceId: 'default', label: 'System microphone' },
        ]),
        getUserMedia: vi.fn(),
      },
    });
    renderSettings({ initialSubview: 'wakeWord' }, bridge);
    const listen = await screen.findByRole('switch', { name: t.settings.wakeWordListenSwitch });
    await user.click(listen);
    await waitFor(() => expect(bridge.wakeWordUpdateConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true })));
    await choose(user, screen.getByRole('combobox', { name: t.settings.wakeWordModel }), 'Hey Computer');
    await waitFor(() => expect(bridge.wakeWordUpdateConfig).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'computer' })));
    await choose(user, screen.getByRole('combobox', { name: t.settings.wakeWordDevice }), 'System microphone');
    await waitFor(() => expect(bridge.wakeWordUpdateConfig).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'default' })));

    await user.click(screen.getByRole('button', { name: t.settings.liveVoiceAdvancedSettings }));
    const threshold = screen.getByRole('textbox', { name: t.settings.wakeWordThreshold });
    await user.clear(threshold);
    await user.type(threshold, '0,75');
    await user.type(threshold, 'x');
    expect(threshold).toHaveValue('0,75');
    await user.tab();
    expect(threshold).toHaveValue('0.75');
    const patience = screen.getByRole('textbox', { name: t.settings.wakeWordPatience });
    await user.clear(patience);
    await user.tab();
    expect(patience).toHaveValue('0');
    const cooldown = screen.getByRole('textbox', { name: t.settings.wakeWordCooldown });
    await user.clear(cooldown);
    await user.type(cooldown, '3000');
    await user.click(screen.getByRole('button', { name: t.settings.memorySave }));
    await waitFor(() => expect(bridge.wakeWordUpdateConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      threshold: 0.75,
      patience: 0,
      cooldownMs: 3000,
    })));
    await user.click(screen.getByRole('button', { name: t.settings.liveVoiceAdvancedSettings }));
  });

  it('falls back to a default device, handles state and action failures, and receives pushed state', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    const unsubscribe = vi.fn();
    bridge.onWakeWordChanged.mockReturnValue(unsubscribe);
    bridge.wakeWordGetState.mockRejectedValueOnce(new Error('Wake state unavailable')).mockRejectedValue(new Error('Wake refresh unavailable'));
    bridge.wakeWordInstall.mockRejectedValueOnce(new Error('Repair failed')).mockRejectedValueOnce('unknown');
    const view = renderSettings({ initialSubview: 'wakeWord' }, bridge);
    expect(await screen.findByText('Wake refresh unavailable')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: t.settings.wakeWordDevice })).toHaveTextContent(t.settings.liveVoiceDefaultMic);
    await user.click(screen.getByRole('button', { name: t.settings.wakeWordInstall }));
    expect(await screen.findByText('Repair failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.settings.wakeWordInstall }));
    expect(await screen.findByText(t.settings.wakeWordGenericError)).toBeInTheDocument();
    const listener = bridge.onWakeWordChanged.mock.calls[0]?.[0];
    act(() => listener?.(wakeState({ status: 'detected', running: true, runtime: { state: 'detected', modelId: 'hey-jarvis', updatedAt: now } })));
    expect(screen.getByText(t.settings.wakeWordStatuses.detected)).toBeInTheDocument();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('uses generated ids and labels for unnamed devices and supports reinstalling a healthy listener', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.wakeWordGetState.mockResolvedValue(wakeState());
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: '', label: '' },
          { kind: 'audioinput', deviceId: '', label: '' },
        ]),
      },
    });
    renderSettings({ initialSubview: 'wakeWord' }, bridge);
    await screen.findByRole('button', { name: t.settings.wakeWordReinstall });
    await choose(user, screen.getByRole('combobox', { name: t.settings.wakeWordDevice }), t.settings.liveVoiceMic(2));
    expect(bridge.wakeWordUpdateConfig).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'audioinput-1' }));
    await user.click(screen.getByRole('button', { name: t.settings.wakeWordReinstall }));
    expect(bridge.wakeWordInstall).toHaveBeenCalledOnce();
  });
});

describe('SettingsView text-to-speech behavior', () => {
  it('renders running diagnostics, enabled voice variants, and only active queue jobs', async () => {
    const running = ttsState({
      lastError: 'Voice engine warning',
      voices: [
        ...ttsState().voices,
        { id: 'no_locale', model: 'kokoro', label: 'Plain', language: 'English', installed: true, enabled: true },
      ],
      queue: [
        { id: 'queued', status: 'queued', model: 'kokoro', voice: 'af_heart', createdAt: now, updatedAt: now, textLength: 42 },
        { id: 'running', status: 'running', model: 'kokoro', voice: 'af_sky', createdAt: now, updatedAt: now },
        { id: 'completed', status: 'completed', model: 'kokoro', voice: 'af_heart', createdAt: now, updatedAt: now },
      ],
    });
    const bridge = makeBridge();
    bridge.textToSpeechGetState.mockResolvedValue(running);
    renderSettings({ initialSubview: 'textToSpeech' }, bridge);
    expect(await screen.findByText('Voice engine warning')).toBeInTheDocument();
    expect(screen.getByText('Heart · English (en-US)')).toBeInTheDocument();
    expect(screen.getByText('Plain · English')).toBeInTheDocument();
    expect(screen.getByText(`42 ${t.settings.ttsText.toLowerCase()} · ${now}`)).toBeInTheDocument();
    expect(screen.getByText(`0 ${t.settings.ttsText.toLowerCase()} · ${now}`)).toBeInTheDocument();
    expect(screen.queryByText('completed')).not.toBeInTheDocument();
    expect(screen.getByText(t.settings.serverSettingsStoppedOnly)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.settings.speechInstall })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.settings.speechStart })).toBeDisabled();
  });

  it('installs, starts, stops, refreshes, and reports Error and unknown service failures', async () => {
    const user = userEvent.setup();
    const unavailable = ttsState({ status: 'not_installed', installed: false, running: false });
    const bridge = makeBridge();
    bridge.textToSpeechGetState.mockResolvedValue(unavailable);
    bridge.textToSpeechInstall
      .mockResolvedValueOnce(ttsState({ status: 'installed', running: false }))
      .mockRejectedValueOnce(new Error('Voice install failed'))
      .mockRejectedValueOnce('unknown');
    const first = renderSettings({ initialSubview: 'textToSpeech' }, bridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechInstall }));
    expect(bridge.textToSpeechInstall).toHaveBeenCalledOnce();
    first.unmount();

    const installedBridge = makeBridge();
    const installed = ttsState({ status: 'installed', installed: true, running: false });
    installedBridge.textToSpeechGetState.mockResolvedValue(installed);
    installedBridge.textToSpeechStart.mockResolvedValue(installed);
    const second = renderSettings({ initialSubview: 'textToSpeech' }, installedBridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechStart }));
    expect(installedBridge.textToSpeechStart).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: t.settings.storageRefresh }));
    expect(installedBridge.textToSpeechGetState.mock.calls.length).toBeGreaterThan(1);
    second.unmount();

    const runningBridge = makeBridge();
    runningBridge.textToSpeechGetState.mockResolvedValue(ttsState());
    renderSettings({ initialSubview: 'textToSpeech' }, runningBridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechStop }));
    expect(runningBridge.textToSpeechStop).toHaveBeenCalledOnce();
    runningBridge.textToSpeechInstall.mockRejectedValueOnce(new Error('Voice install failed')).mockRejectedValueOnce('unknown');
    runningBridge.textToSpeechGetState.mockResolvedValue(unavailable);
    await act(async () => {
      await runningBridge.textToSpeechStop.mock.results.at(-1)?.value;
    });
  });

  it('saves normalized configuration, toggles voices both ways, and ignores invalid numeric text', async () => {
    const user = userEvent.setup();
    const stopped = ttsState({ status: 'stopped', running: false });
    const bridge = makeBridge();
    bridge.textToSpeechGetState.mockResolvedValue(stopped);
    bridge.textToSpeechUpdateConfig.mockResolvedValue(stopped);
    renderSettings({ initialSubview: 'textToSpeech' }, bridge);
    await screen.findByRole('button', { name: t.settings.memorySave });
    const maxText = screen.getByRole('textbox', { name: t.settings.ttsMaxText });
    await user.clear(maxText);
    await user.type(maxText, '4096,5x');
    expect(maxText).toHaveValue('4096,5');
    await user.tab();
    expect(maxText).toHaveValue('4096');
    const concurrency = screen.getByRole('textbox', { name: t.settings.speechConcurrency });
    await user.clear(concurrency);
    await user.tab();
    expect(concurrency).toHaveValue('0');
    await choose(user, screen.getAllByRole('combobox', { name: t.settings.speechModel })[0], 'Piper');
    await choose(user, screen.getByRole('combobox', { name: t.settings.ttsDefaultVoice }), 'Sol · Spanish');
    await user.click(screen.getByRole('switch', { name: t.settings.speechAutoStart }));
    await user.click(screen.getByRole('switch', { name: 'Heart · English (en-US)' }));
    await user.click(screen.getByRole('switch', { name: 'Sky · English' }));
    await user.click(screen.getByRole('button', { name: t.settings.memorySave }));
    expect(bridge.textToSpeechUpdateConfig).toHaveBeenCalledWith({
      autoStart: false,
      maxTextCharacters: 4096,
      maxConcurrentJobs: 0,
      enabledVoices: ['af_sky'],
      defaultModel: 'piper',
      defaultVoice: 'es_voice',
    });
  });

  it('changes test models with preserved, fallback, and empty voice selections and renders result variants', async () => {
    const user = userEvent.setup();
    const selectable = ttsState({
      models: [
        ...ttsState().models,
        { id: 'clone', label: 'Clone', installed: true },
        { id: 'empty', label: 'Empty', installed: true },
      ],
      voices: [
        ...ttsState().voices,
        { id: 'af_sky', model: 'clone', label: 'Sky clone', language: 'English', installed: true, enabled: true },
      ],
    });
    const bridge = makeBridge();
    bridge.textToSpeechGetState.mockResolvedValue(selectable);
    bridge.textToSpeechSynthesize
      .mockResolvedValueOnce({ success: true, userMessage: 'Voice generated' })
      .mockResolvedValueOnce({ success: false, technicalCode: 'voice_failed' });
    renderSettings({ initialSubview: 'textToSpeech' }, bridge);
    const textField = await screen.findByRole('textbox', { name: t.settings.ttsText });
    await user.clear(textField);
    expect(screen.getByRole('button', { name: t.settings.ttsSynthesize })).toBeDisabled();
    await user.type(textField, 'Read this aloud');
    const modelSelect = screen.getAllByRole('combobox', { name: t.settings.speechModel })[1];
    const voiceSelect = screen.getByRole('combobox', { name: t.settings.ttsVoice });
    await choose(user, voiceSelect, 'Sky · English');
    await choose(user, modelSelect, 'Clone');
    expect(voiceSelect).toHaveTextContent('Sky clone · English');
    await choose(user, modelSelect, 'Piper');
    expect(voiceSelect).toHaveTextContent('Sol · Spanish');
    await choose(user, modelSelect, 'Empty');
    expect(screen.getByRole('button', { name: t.settings.ttsSynthesize })).toBeDisabled();
    await choose(user, modelSelect, 'Kokoro');
    await user.click(screen.getByRole('button', { name: t.settings.ttsSynthesize }));
    expect(await screen.findByText('Voice generated')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.settings.ttsSynthesize }));
    expect(await screen.findByText('voice_failed')).toBeInTheDocument();
  });

  it('plays synthesized audio, revokes its URL when ended, and presents playback failure', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn().mockReturnValue('blob:voice');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    let ended: (() => void) | undefined;
    const play = vi.fn().mockResolvedValue(undefined);
    class PlayingAudio {
      constructor(public readonly src: string) {}
      addEventListener(_event: string, listener: () => void) { ended = listener; }
      play = play;
    }
    vi.stubGlobal('Audio', PlayingAudio);
    const bridge = makeBridge();
    bridge.textToSpeechGetState.mockResolvedValue(ttsState());
    bridge.textToSpeechSynthesize.mockResolvedValue({
      success: true,
      audioDataBase64: 'AQI=',
      mimeType: 'audio/wav',
      format: 'wav',
      model: 'kokoro',
      voice: 'af_heart',
      userMessage: 'Audio ready',
    });
    const view = renderSettings({ initialSubview: 'textToSpeech' }, bridge);
    await user.click(await screen.findByRole('button', { name: t.settings.ttsSynthesize }));
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    act(() => ended?.());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:voice');
    view.unmount();

    const rejectedPlay = vi.fn().mockRejectedValue(new Error('autoplay blocked'));
    class BlockedAudio {
      addEventListener() {}
      play = rejectedPlay;
    }
    vi.stubGlobal('Audio', BlockedAudio);
    const blockedBridge = makeBridge();
    blockedBridge.textToSpeechGetState.mockResolvedValue(ttsState());
    blockedBridge.textToSpeechSynthesize.mockResolvedValue({
      success: true,
      audioDataBase64: 'AQI=',
      mimeType: 'audio/wav',
      format: 'wav',
      model: 'kokoro',
      voice: 'af_heart',
    });
    renderSettings({ initialSubview: 'textToSpeech' }, blockedBridge);
    await user.click(await screen.findByRole('button', { name: t.settings.ttsSynthesize }));
    expect(await screen.findByText(t.settings.ttsPlaybackError)).toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:voice');
  });

  it('shows both thrown error forms while installing an unavailable engine', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.textToSpeechGetState.mockResolvedValue(ttsState({ status: 'not_installed', installed: false, running: false }));
    bridge.textToSpeechInstall.mockRejectedValueOnce(new Error('Install exploded')).mockRejectedValueOnce('unknown');
    renderSettings({ initialSubview: 'textToSpeech' }, bridge);
    const install = await screen.findByRole('button', { name: t.settings.speechInstall });
    await user.click(install);
    expect(await screen.findByText('Install exploded')).toBeInTheDocument();
    await user.click(install);
    expect(await screen.findByText(t.settings.ttsGenericError)).toBeInTheDocument();
  });
});

describe('SettingsView microphone recording behavior', () => {
  class FakeMediaRecorder {
    static instances: FakeMediaRecorder[] = [];
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    mimeType = 'audio/webm';
    start = vi.fn();
    stop = vi.fn(() => this.onstop?.());

    constructor(public readonly stream: MediaStream) {
      FakeMediaRecorder.instances.push(this);
    }

    emit(data: Blob) {
      this.ondataavailable?.({ data } as BlobEvent);
    }
  }

  const mediaStream = (audioTrackCount: number) => {
    const tracks = Array.from({ length: audioTrackCount }, (_, index) => ({
      kind: 'audio',
      id: `track-${index}`,
      readyState: 'live',
      muted: false,
      stop: vi.fn(),
    }));
    return {
      tracks,
      stream: {
        getAudioTracks: () => tracks,
        getTracks: () => tracks,
      } as unknown as MediaStream,
    };
  };

  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  });

  it.each(['denied', 'restricted'] as const)('does not open the microphone when permission is %s', async (permission) => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.speechToTextGetState.mockResolvedValue(speechState());
    bridge.microphonePermissionStatus.mockResolvedValue(permission);
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia, enumerateDevices: vi.fn() } });
    renderSettings({ initialSubview: 'speechToText' }, bridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechRecord }));
    expect(await screen.findByText(t.settings.speechMicrophonePermissionDenied)).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('requests undetermined permission and reports native Error and unknown capture failures', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.speechToTextGetState.mockResolvedValue(speechState());
    bridge.microphonePermissionStatus.mockResolvedValue('not-determined');
    bridge.microphonePermissionRequest.mockRejectedValue('no response');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('Capture failed')), enumerateDevices: vi.fn() },
    });
    const first = renderSettings({ initialSubview: 'speechToText' }, bridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechRecord }));
    expect(await screen.findByText('Capture failed')).toBeInTheDocument();
    expect(bridge.microphonePermissionRequest).toHaveBeenCalledOnce();
    first.unmount();

    const unknownBridge = makeBridge();
    unknownBridge.speechToTextGetState.mockResolvedValue(speechState());
    unknownBridge.microphonePermissionStatus.mockRejectedValue(new Error('status unavailable'));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue('unknown capture failure'), enumerateDevices: vi.fn() },
    });
    renderSettings({ initialSubview: 'speechToText' }, unknownBridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechRecord }));
    expect(await screen.findByText(t.settings.speechGenericError)).toBeInTheDocument();
  });

  it('rejects an empty stream, stops its tracks, and tolerates failed diagnostics', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.speechToTextGetState.mockResolvedValue(speechState());
    bridge.desktopLog.mockRejectedValue(new Error('logging unavailable'));
    const videoTrack = { kind: 'video', readyState: 'live', muted: false, stop: vi.fn() };
    const fixture = {
      tracks: [videoTrack],
      stream: {
        getAudioTracks: () => [],
        getTracks: () => [videoTrack],
      } as unknown as MediaStream,
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(fixture.stream), enumerateDevices: vi.fn() },
    });
    renderSettings({ initialSubview: 'speechToText' }, bridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechRecord }));
    expect(await screen.findByText(t.settings.speechMicrophoneEmptyRecording)).toBeInTheDocument();
    expect(bridge.desktopLog).toHaveBeenCalledWith({
      level: 'warn',
      event: 'settings:speech:microphone_recording_empty_stream',
      context: { permissionStatus: 'granted', audioTrackCount: 0 },
    });
    expect(videoTrack.stop).toHaveBeenCalledOnce();
  });

  it('uploads a substantial recording, logs track diagnostics, and falls back to a webm MIME type', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.speechToTextGetState.mockResolvedValue(speechState());
    bridge.microphonePermissionStatus.mockRejectedValue(new Error('status unavailable'));
    const fixture = mediaStream(1);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(fixture.stream), enumerateDevices: vi.fn() },
    });
    renderSettings({ initialSubview: 'speechToText' }, bridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechRecord }));
    const recorder = FakeMediaRecorder.instances.at(-1)!;
    recorder.mimeType = '';
    expect(recorder.start).toHaveBeenCalledOnce();
    recorder.emit(new Blob(['x'.repeat(600)], { type: 'audio/webm' }));
    await user.click(screen.getByRole('button', { name: t.settings.speechStopRecording }));
    await waitFor(() => expect(bridge.speechToTextProcessUpload).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'microphone-recording.webm',
      mimeType: 'audio/webm',
      task: 'transcribe',
    })));
    expect(fixture.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(bridge.desktopLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      event: 'settings:speech:microphone_recording_ready',
      context: expect.objectContaining({ permissionStatus: 'unsupported', audioTrackCount: 1, recorderMimeType: '', chunkCount: 1, blobSize: 600 }),
    }));
    expect(await screen.findByText('Recording transcript')).toBeInTheDocument();
  });

  it('rejects recordings with no chunks or too few bytes and clears each recorder', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.speechToTextGetState.mockResolvedValue(speechState());
    bridge.desktopLog.mockRejectedValue(new Error('logging unavailable'));
    const emptyFixture = mediaStream(1);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(emptyFixture.stream), enumerateDevices: vi.fn() },
    });
    const first = renderSettings({ initialSubview: 'speechToText' }, bridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechRecord }));
    const emptyRecorder = FakeMediaRecorder.instances.at(-1)!;
    emptyRecorder.emit(new Blob([]));
    await user.click(screen.getByRole('button', { name: t.settings.speechStopRecording }));
    expect(await screen.findByText(t.settings.speechMicrophoneEmptyRecording)).toBeInTheDocument();
    expect(bridge.speechToTextProcessUpload).not.toHaveBeenCalled();
    first.unmount();

    const shortFixture = mediaStream(1);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(shortFixture.stream), enumerateDevices: vi.fn() },
    });
    renderSettings({ initialSubview: 'speechToText' }, bridge);
    await user.click(await screen.findByRole('button', { name: t.settings.speechRecord }));
    FakeMediaRecorder.instances.at(-1)!.emit(new Blob(['short audio']));
    await user.click(screen.getByRole('button', { name: t.settings.speechStopRecording }));
    expect(await screen.findByText(t.settings.speechMicrophoneEmptyRecording)).toBeInTheDocument();
    expect(bridge.desktopLog).toHaveBeenLastCalledWith(expect.objectContaining({
      level: 'warn',
      event: 'settings:speech:microphone_recording_empty',
    }));
  });
});

describe('SettingsView asynchronous and fallback behavior', () => {
  it('polls speech and text-to-speech only while their subviews are open', async () => {
    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation((handler: TimerHandler) => {
      intervalCallbacks.push(handler as () => void);
      return intervalCallbacks.length;
    });
    const speechBridge = makeBridge();
    const speechView = renderSettings({ initialSubview: 'speechToText' }, speechBridge);
    await waitFor(() => expect(intervalCallbacks.length).toBeGreaterThan(0));
    act(() => intervalCallbacks.forEach((callback) => callback()));
    await waitFor(() => expect(speechBridge.speechToTextGetState.mock.calls.length).toBeGreaterThan(1));
    speechView.unmount();

    const existingCallbackCount = intervalCallbacks.length;
    const ttsBridge = makeBridge();
    const ttsView = renderSettings({ initialSubview: 'textToSpeech' }, ttsBridge);
    await waitFor(() => expect(intervalCallbacks.length).toBeGreaterThan(existingCallbackCount));
    act(() => intervalCallbacks.slice(existingCallbackCount).forEach((callback) => callback()));
    await waitFor(() => expect(ttsBridge.textToSpeechGetState.mock.calls.length).toBeGreaterThan(1));
    ttsView.unmount();
  });

  it('uses TTS config defaults, displays error status, and tolerates unavailable initial services', async () => {
    const configWithoutDefaults = ttsState({
      status: 'error',
      running: false,
      config: {
        autoStart: false,
        maxTextCharacters: 100,
        maxConcurrentJobs: 1,
        enabledVoices: ['af_heart'],
      },
      voices: ttsState().voices.map((voice) => ({ ...voice, enabled: false })),
    });
    const bridge = makeBridge();
    bridge.textToSpeechGetState.mockResolvedValue(configWithoutDefaults);
    const view = renderSettings({ initialSubview: 'textToSpeech' }, bridge);
    expect(await screen.findByText(t.settings.speechStatuses.error)).toBeInTheDocument();
    expect(screen.getAllByRole('combobox', { name: t.settings.speechModel })[0]).toHaveTextContent('Kokoro');
    expect(screen.getByRole('combobox', { name: t.settings.ttsDefaultVoice })).not.toHaveTextContent('Heart');
    view.unmount();

    const unavailable = makeBridge();
    unavailable.textToSpeechGetState.mockRejectedValue(new Error('not ready'));
    unavailable.getDeveloperPathState.mockRejectedValue(new Error('paths unavailable'));
    renderSettings({ initialSubview: 'textToSpeech' }, unavailable);
    expect(await screen.findByText(t.settings.speechLoading)).toBeInTheDocument();
  });

  it('falls back when device enumeration is rejected or unavailable and maps unknown wake errors', async () => {
    const rejectedBridge = makeBridge();
    rejectedBridge.wakeWordGetState.mockResolvedValue(wakeState());
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: vi.fn().mockRejectedValue(new Error('devices unavailable')) },
    });
    const first = renderSettings({ initialSubview: 'wakeWord' }, rejectedBridge);
    expect(await screen.findByRole('combobox', { name: t.settings.wakeWordDevice })).toHaveTextContent(t.settings.liveVoiceDefaultMic);
    first.unmount();

    const missingBridge = makeBridge();
    missingBridge.wakeWordGetState.mockRejectedValue('unknown wake failure');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    renderSettings({ initialSubview: 'wakeWord' }, missingBridge);
    expect(await screen.findByText(t.settings.wakeWordGenericError)).toBeInTheDocument();
  });

  it('covers wake refresh rejection after a successful update, network disable, and empty secret copy', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.wakeWordGetState
      .mockResolvedValueOnce(wakeState())
      .mockResolvedValueOnce(wakeState())
      .mockRejectedValue(new Error('refresh failed'));
    bridge.wakeWordUpdateConfig.mockResolvedValue(wakeState({ config: { ...wakeState().config, enabled: true } }));
    const wakeView = renderSettings({ initialSubview: 'wakeWord' }, bridge);
    await user.click(await screen.findByRole('switch', { name: t.settings.wakeWordListenSwitch }));
    await waitFor(() => expect(bridge.wakeWordUpdateConfig).toHaveBeenCalledOnce());
    wakeView.unmount();

    const defaults = renderSettings({ initialSubview: 'llmProvider', defaultChatNetworkAccess: true });
    const defaultsCard = screen.getByText(t.settings.agentDefaultProviderTitle).closest('.MuiCard-root') as HTMLElement;
    await choose(user, within(defaultsCard).getByRole('combobox', { name: t.settings.agentDefaultChatNetwork }), t.sections.chat.networkDisabledLabel);
    expect(defaults.props.onAgentDefaultsChange).toHaveBeenCalledWith({ defaultProvider: 'auto', defaultChatNetworkAccess: false });
    defaults.unmount();

    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    renderSettings({ initialSubview: 'privacySecurity', cloudIdentity: null });
    await user.click(await screen.findByRole('button', { name: t.settings.secretKeyCopy }));
    expect(writeText).toHaveBeenCalledWith('');
  });

  it('shows speech error status when the installed service needs attention', async () => {
    const bridge = makeBridge();
    bridge.speechToTextGetState.mockResolvedValue(speechState({ status: 'error', running: false }));
    renderSettings({ initialSubview: 'speechToText' }, bridge);
    expect(await screen.findByText(t.settings.speechStatuses.error)).toBeInTheDocument();
  });
});
