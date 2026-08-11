import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme } from '@mui/material/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDictionary } from '@renderer/i18n';

const state = vi.hoisted(() => ({
  captures: {} as Record<string, any>,
  appCards: [] as any[],
  tourInputs: [] as any[],
  tour: {
    activeStep: null as string | null,
    highlightRect: null,
    modalWidth: 480,
    primaryLabel: 'Continue',
    primaryVariant: 'contained',
    primaryColor: 'primary',
    isWelcomeStep: false,
    isAgentStep: false,
    welcomeUsageAnalyticsEnabled: false,
    setWelcomeUsageAnalyticsEnabled: vi.fn(),
    skipTour: vi.fn(),
    continueTour: vi.fn(),
  },
  providerOptions: [{ label: 'Automatic', value: 'auto' }] as Array<{ label: string; value: string }>,
  runnerInstances: [] as any[],
}));

function captureView(name: string) {
  return (props: any) => {
    state.captures[name] = props;
    return <section data-testid={name}>{name}</section>;
  };
}

vi.mock('@renderer/components/AppShell', () => ({
  AppShell: (props: any) => {
    state.captures.AppShell = props;
    return <main data-testid="AppShell">{props.children}</main>;
  },
}));
vi.mock('@renderer/components/AppCard', () => ({
  AppCard: (props: any) => {
    state.appCards.push(props);
    return (
      <section data-testid={`AppCard-${props.appName}`}>
        <button type="button" onClick={props.onCardClick}>card {props.appName}</button>
        <button type="button" onClick={props.onPrimaryAction}>primary {props.appName}</button>
        {props.onSecondaryAction ? <button type="button" onClick={props.onSecondaryAction}>secondary {props.appName}</button> : null}
        {props.onTertiaryAction ? <button type="button" onClick={props.onTertiaryAction}>tertiary {props.appName}</button> : null}
        {props.primaryMenuActions.map((item: any) => <button type="button" key={item.label} onClick={item.onClick}>{item.label} {props.appName}</button>)}
      </section>
    );
  },
}));
vi.mock('@renderer/components/AppsGrid', () => ({ AppsGrid: ({ children }: any) => <div data-testid="AppsGrid">{children}</div> }));

vi.mock('@renderer/views/AppView', () => ({ AppView: captureView('AppView') }));
vi.mock('@renderer/views/AgentsView', () => ({ AgentsView: captureView('AgentsView') }));
vi.mock('@renderer/views/AutomationsView', () => ({ AutomationsView: captureView('AutomationsView') }));
vi.mock('@renderer/views/workflows/WorkflowsModule', () => ({ WorkflowsModule: captureView('WorkflowsModule') }));
vi.mock('@renderer/views/BackupsView', () => ({ BackupsView: captureView('BackupsView') }));
vi.mock('@renderer/views/BackgroundTasksView', () => ({
  BackgroundTasksListView: captureView('BackgroundTasksListView'),
  BackgroundTaskDetailView: captureView('BackgroundTaskDetailView'),
  viewLabel: (_t: unknown, view: string) => `Back ${view}`,
}));
vi.mock('@renderer/views/CatalogView', () => ({ CatalogView: captureView('CatalogView') }));
vi.mock('@renderer/views/ChatView', () => ({ ChatView: captureView('ChatView') }));
vi.mock('@renderer/views/ConnectionsView', () => ({ ConnectionsView: captureView('ConnectionsView') }));
vi.mock('@renderer/views/DataView', () => ({ DataView: captureView('DataView') }));
vi.mock('@renderer/views/DevicesView', () => ({ DevicesView: captureView('DevicesView') }));
vi.mock('@renderer/views/DocsView', () => ({ DocsView: captureView('DocsView') }));
vi.mock('@renderer/views/FeedbackView', () => ({ FeedbackView: captureView('FeedbackView') }));
vi.mock('@renderer/views/FilesView', () => ({ FilesView: captureView('FilesView') }));
vi.mock('@renderer/views/FriendChatWindowView', () => ({ FriendChatWindowView: captureView('FriendChatWindowView') }));
vi.mock('@renderer/views/MoreView', () => ({ MoreView: captureView('MoreView') }));
vi.mock('@renderer/views/SocialView', () => ({ SocialView: captureView('SocialView') }));
vi.mock('@renderer/views/SettingsView', () => ({ SettingsView: captureView('SettingsView') }));
vi.mock('@renderer/views/SecretsView', () => ({ SecretsView: captureView('SecretsView') }));
vi.mock('@renderer/views/SidekicksView', () => ({ SidekicksView: captureView('SidekicksView') }));
vi.mock('@renderer/views/ToolsView', () => ({ ToolsView: captureView('ToolsView') }));

vi.mock('@renderer/app/RendererAppDialogs', () => ({ RendererAppDialogs: captureView('RendererAppDialogs') }));
vi.mock('@renderer/app/DesktopUpdateSummaryMarkdown', () => ({
  DesktopUpdateSummaryMarkdown: (props: any) => {
    state.captures.DesktopUpdateSummaryMarkdown = props;
    return <button type="button" onClick={() => props.onOpenExternalUrl('https://release.example')}>{props.content}</button>;
  },
}));
vi.mock('@renderer/components/LocalNetworkShareDialog', () => ({ LocalNetworkShareDialog: captureView('LocalNetworkShareDialog') }));
vi.mock('@renderer/tour/TourOverlay', () => ({
  TourOverlay: (props: any) => {
    state.captures.TourOverlay = props;
    return <aside data-testid="TourOverlay">{props.extraContent}</aside>;
  },
}));
vi.mock('@renderer/tour/useForgerTour', () => ({
  useForgerTour: (input: any) => {
    state.tourInputs.push(input);
    return state.tour;
  },
}));
vi.mock('@renderer/services/WakeWordClientRunner', () => ({
  WakeWordClientRunner: class {
    ensure = vi.fn();
    stop = vi.fn();
    dispose = vi.fn();
    constructor(public api: unknown) { state.runnerInstances.push(this); }
  },
}));

const audioMocks = vi.hoisted(() => ({ enumerate: vi.fn(), play: vi.fn() }));
vi.mock('@renderer/app/audio-runtime-browser', () => ({
  enumerateAudioRuntimeDevices: audioMocks.enumerate,
  playRuntimeAudio: audioMocks.play,
}));
vi.mock('@renderer/app-error-actions', () => ({
  isOpenableError: (app: any) => app.errorKind === 'openable',
  isRetryableInstallError: (app: any) => app.errorKind === 'retry',
  isUpdateError: (app: any) => app.errorKind === 'update',
}));
vi.mock('@renderer/app-execution-labels', () => ({ appExecutionTooltip: (app: any, _t: unknown, input: any) => `${app.status}:${String(input.startingInForger)}` }));
vi.mock('@shared/agent-runtime-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/agent-runtime-registry')>(),
  buildChatProviderOptions: () => state.providerOptions,
  getRuntimeSupportedEfforts: (_provider: string, model: string) => model.includes('mini') ? ['low'] : ['low', 'medium', 'high'],
  normalizeRuntimeEffortForModel: (provider: string, model: string, effort: string) => effort || `${provider}-${model}`,
}));

import { RendererAppView } from '@renderer/app/RendererAppView';

const t = getDictionary('en');

const createDesktopApi = () => {
  const audioListeners: Array<(request: any) => void> = [];
  const wakeListeners: Array<() => void> = [];
  const wakeChangedListeners: Array<() => void> = [];
  return {
    audioListeners,
    wakeListeners,
    wakeChangedListeners,
    onAudioRuntimeBrokerRequest: vi.fn((listener: (request: any) => void) => { audioListeners.push(listener); return vi.fn(); }),
    audioRuntimeBrokerRespond: vi.fn(async () => undefined),
    onWakeWordDetected: vi.fn((listener: () => void) => { wakeListeners.push(listener); return vi.fn(); }),
    wakeWordGetState: vi.fn(async () => ({ config: { enabled: false, modelId: 'wake-model' } })),
    wakeWordRecordUnavailable: vi.fn(async () => undefined),
    onWakeWordChanged: vi.fn((listener: () => void) => { wakeChangedListeners.push(listener); return vi.fn(); }),
    desktopUpdateQuitForInstall: vi.fn(async () => undefined),
    downloadDesktopUpdate: vi.fn(async () => undefined),
    installDesktopUpdate: vi.fn(async () => undefined),
    checkDesktopUpdates: vi.fn(async () => undefined),
    openExternalUrl: vi.fn(async () => undefined),
    dbListTables: vi.fn(async () => []),
    dbQueryTable: vi.fn(async () => []),
    activateOfficialTool: vi.fn(async () => undefined),
    configureOfficialTool: vi.fn(async () => undefined),
    deactivateOfficialTool: vi.fn(async () => undefined),
    revealCloudSecretKey: vi.fn(async () => 'secret'),
    regenerateCloudSecretKey: vi.fn(async () => ({ id: 'identity' })),
  };
};

const catalogApp = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `App ${id}`,
  description: `Description ${id}`,
  category: 'productivity',
  status: 'installed',
  catalogStatus: 'published',
  ...overrides,
});

const createController = (overrides: Record<string, unknown> = {}) => {
  const api = createDesktopApi();
  const values: Record<PropertyKey, any> = {
    getDesktopApi: vi.fn(() => api),
    theme: createTheme(),
    t,
    activeLocale: 'en',
    currentView: 'apps',
    socialChatWindowRoute: null,
    socialProfileUsername: null,
    forgerAccount: null,
    forgerAccountBusy: false,
    installedApps: [],
    selectedDataAppId: null,
    getAppMeta: vi.fn((id: string) => ({ name: `App ${id}`, description: `Description ${id}` })),
    chatModeLabel: 'Chat',
    backgroundTasks: [],
    backgroundTasksDrawerOpen: false,
    activeBackgroundTaskCount: 0,
    backgroundTasksBackView: 'apps',
    selectedBackgroundTaskId: null,
    selectedWorkflowId: null,
    workflowsEnabled: true,
    workflowsEarlyAccessBusy: false,
    selectedConnectionId: null,
    desktopUpdateState: { status: 'idle', currentVersion: '1.0.0', availableVersion: null },
    pinnedViews: [],
    openingAppIds: new Set<string>(),
    getCategoryLabel: vi.fn((category: string) => `Category ${category}`),
    installProgressByApp: {},
    catalogApps: [],
    catalogFilter: '',
    catalogStatusFilter: 'all',
    selectedAppDetails: null,
    selectedAppDetailsId: null,
    selectedAppToolGate: null,
    selectedAppToolGrantBusyId: null,
    appSecretsState: null,
    secretsBusy: false,
    settings: {
      codexDefaults: {}, developerMode: false, defaultAgentProvider: 'codex', defaultChatPermissionMode: 'safe',
      defaultChatNetworkAccess: false, providerInactivityTimeoutMinutes: 15, agentDefaults: {}, providerConnections: [],
      llmProviderProfiles: [], activeProviderProfiles: {},
    },
    appDetailsBackView: 'apps',
    usageAnalyticsEnabled: false,
    forumParticipation: null,
    forumPromptOpen: false,
    forumParticipationBusy: false,
    chatMessages: [],
    activeConversationId: null,
    chatHistoryItems: [],
    chatInput: '',
    pendingChatFiles: [],
    mentionedChatFiles: [],
    forgerFiles: [],
    fileCategories: [],
    uploadCategoryPath: '',
    activeConversation: null,
    selectedAgentProvider: 'auto',
    resolvedChatProvider: 'codex',
    selectedCodexModel: 'gpt-5.2',
    selectedCodexReasoningEffort: 'medium',
    selectedClaudeModel: 'claude-sonnet-4-5',
    selectedClaudeEffort: 'medium',
    selectedAntigravityModel: 'gemini-3-pro-high',
    selectedAntigravityEffort: 'high',
    selectedChatPermissionMode: 'safe',
    selectedChatNetworkAccess: false,
    chatBotPictureSrc: '',
    activeConversationRunActive: false,
    activeConversationRunId: null,
    activeConversationProgressLines: [],
    activeConversationActivity: null,
    codexAuthStatus: { authenticated: false },
    claudeAuthStatus: { authenticated: false },
    antigravityAuthStatus: { authenticated: false },
    automations: [],
    selectedAutomationId: null,
    automationRuns: [],
    selectedAutomationRun: null,
    automationBusy: false,
    fileFilters: {},
    backups: [],
    remoteBackups: [],
    remoteBackupsUsage: null,
    cloudSyncSettings: {},
    backupsBusy: false,
    userSecrets: [],
    agentToolPackages: [],
    agentToolSettings: [],
    officialTools: [],
    selectedToolsTool: null,
    agentToolBusyId: null,
    officialToolBusyId: null,
    agentToolError: null,
    agentToolErrorCode: null,
    runOfficialToolAction: vi.fn((_toolId: string, action: () => unknown) => action()),
    codexAuthBusy: false,
    claudeAuthBusy: false,
    antigravityAuthBusy: false,
    themePreference: 'system',
    languagePreference: 'system',
    systemLocale: 'en',
    chatBotPicture: 'default',
    cloudStorageUsage: null,
    cloudStorageBusy: false,
    desktopUpdateBusy: false,
    runDesktopUpdateAction: vi.fn((action: () => unknown) => action()),
    memories: [],
    cloudIdentity: null,
    pendingInstallGate: null,
    cloudModalOpen: false,
    uploadSocialApp: vi.fn(async () => undefined),
    socialInstallReviewDialog: null,
    socialDownloadAccountRequiredOpen: false,
    capabilityRows: vi.fn(() => []),
    renderInstallTool: vi.fn((item: any) => <span key={`tool-${item.id}`}>tool {item.id}</span>),
    renderInstallConnection: vi.fn((item: any) => <span key={`connection-${item.id}`}>connection {item.id}</span>),
    renderInstallItem: vi.fn((item: any) => <span key={`item-${item.id}`}>item {item.id}</span>),
    renderInstallCapability: vi.fn((item: any) => <span key={`capability-${item.id}`}>capability {item.id}</span>),
    localNetworkShareDialogOpen: false,
    localNetworkShareStatus: null,
    ...overrides,
  };
  const functionCache = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const controller = new Proxy(values, {
    get(target, property) {
      if (property in target) return target[property];
      if (!functionCache.has(property)) functionCache.set(property, vi.fn());
      return functionCache.get(property);
    },
  });
  return { api, controller };
};

describe('RendererAppView orchestration', () => {
  beforeEach(() => {
    state.captures = {};
    state.appCards = [];
    state.tourInputs = [];
    state.tour.activeStep = null;
    state.tour.isWelcomeStep = false;
    state.tour.isAgentStep = false;
    state.providerOptions = [{ label: 'Automatic', value: 'auto' }];
    state.runnerInstances = [];
    audioMocks.enumerate.mockReset().mockResolvedValue([{ deviceId: 'speaker' }]);
    audioMocks.play.mockReset().mockResolvedValue({ success: true });
    vi.spyOn(window, 'setInterval').mockReturnValue(7);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes shell actions, wake-word activation, and the friend chat window', async () => {
    const { api, controller } = createController();
    const view = render(<RendererAppView controller={controller} />);
    expect(screen.getByTestId('AppShell')).toBeVisible();
    act(() => state.captures.AppShell.onNavigate('chat'));
    expect(controller.setCurrentView).toHaveBeenCalledWith('chat');
    act(() => api.wakeListeners[0]?.());
    expect(controller.handleOpenFreeChatFromWake).toHaveBeenCalledOnce();
    expect(controller.setBannerMessage).toHaveBeenCalledWith(t.settings.wakeWordActivated);
    act(() => state.captures.AppShell.onOpenCloudModal());
    act(() => state.captures.AppShell.onOpenStorageSettings());
    act(() => state.captures.AppShell.onLogout());
    act(() => state.captures.AppShell.onOpenBackgroundTasks());
    act(() => state.captures.AppShell.onCloseBackgroundTasks());
    expect(controller.setCurrentView).toHaveBeenCalledWith('settings');

    controller.socialChatWindowRoute = { friendUserId: 'friend', friendUsername: 'pal', friendDisplayName: 'Pal' };
    view.rerender(<RendererAppView controller={controller} />);
    expect(screen.getByTestId('FriendChatWindowView')).toBeVisible();
    expect(state.captures.FriendChatWindowView.friendUserId).toBe('friend');
  });

  it('brokers audio requests, records wake failures, and disposes subscriptions', async () => {
    const { api, controller } = createController();
    const audio = { pause: vi.fn() } as unknown as HTMLAudioElement;
    audioMocks.play.mockImplementationOnce(async (playbacks: Map<string, HTMLAudioElement>) => {
      playbacks.set('playback', audio);
      return { success: true };
    });
    const view = render(<RendererAppView controller={controller} />);
    await waitFor(() => expect(api.audioListeners).toHaveLength(1));
    await act(async () => api.audioListeners[0]({ type: 'list_devices', requestId: 'devices' }));
    await waitFor(() => expect(api.audioRuntimeBrokerRespond).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'devices', success: true })));
    await act(async () => {
      api.audioListeners[0]({
        type: 'play_audio', requestId: 'play', playbackId: 'playback', audioDataBase64: 'YQ==', mimeType: 'audio/wav',
      });
      await Promise.resolve();
    });
    expect(audioMocks.play).toHaveBeenCalledOnce();
    await waitFor(() => expect(api.audioRuntimeBrokerRespond).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'play', success: true })));
    act(() => api.audioListeners[0]?.({ type: 'cancel_playback', requestId: 'cancel', playbackId: 'playback' }));
    await waitFor(() => expect(audio.pause).toHaveBeenCalledOnce());
    act(() => api.audioListeners[0]?.({ type: 'cancel_playback', requestId: 'missing', playbackId: 'missing' }));
    await waitFor(() => expect(api.audioRuntimeBrokerRespond).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'missing' })));

    audioMocks.enumerate.mockRejectedValueOnce(new Error('device failure'));
    await act(async () => {
      api.audioListeners[0]({ type: 'list_devices', requestId: 'failure' });
      await Promise.resolve();
    });
    await waitFor(() => expect(api.audioRuntimeBrokerRespond).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'failure', success: false, error: 'device failure' })));
    audioMocks.enumerate.mockRejectedValueOnce('device string');
    await act(async () => {
      api.audioListeners[0]({ type: 'list_devices', requestId: 'failure-string' });
      await Promise.resolve();
    });
    await waitFor(() => expect(api.audioRuntimeBrokerRespond).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'failure-string', error: 'audio_runtime_broker_failed' })));
    audioMocks.enumerate.mockRejectedValueOnce(new Error('swallowed broker failure'));
    api.audioRuntimeBrokerRespond.mockRejectedValueOnce(new Error('response channel closed'));
    await act(async () => {
      api.audioListeners[0]({ type: 'list_devices', requestId: 'swallowed' });
      await Promise.resolve();
    });

    await waitFor(() => expect(state.runnerInstances[0].ensure).toHaveBeenCalled());
    api.wakeWordGetState
      .mockRejectedValueOnce(new Error('stream failed'))
      .mockResolvedValueOnce({ config: { enabled: true, modelId: 'wake-model' } });
    await act(async () => {
      api.wakeChangedListeners[0]?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(api.wakeWordRecordUnavailable).toHaveBeenCalledWith({ modelId: 'wake-model', technicalCode: 'stream failed' }));
    expect(state.runnerInstances[0].stop).toHaveBeenCalledWith('refresh_failed');
    api.wakeWordGetState
      .mockRejectedValueOnce(new Error(''))
      .mockResolvedValueOnce({ config: { enabled: false, modelId: 'wake-model' } });
    await act(async () => { api.wakeChangedListeners[0]?.(); await Promise.resolve(); });
    await waitFor(() => expect(state.runnerInstances[0].stop).toHaveBeenCalledTimes(2));
    api.wakeWordGetState
      .mockRejectedValueOnce('stream string')
      .mockResolvedValueOnce({ config: { enabled: true, modelId: 'wake-model' } });
    await act(async () => { api.wakeChangedListeners[0]?.(); await Promise.resolve(); });
    await waitFor(() => expect(api.wakeWordRecordUnavailable).toHaveBeenCalledWith({ modelId: 'wake-model', technicalCode: 'wake_stream_failed' }));
    api.wakeWordGetState.mockRejectedValueOnce('stream string').mockRejectedValueOnce(new Error('state failed'));
    await act(async () => { api.wakeChangedListeners[0]?.(); await Promise.resolve(); });
    await waitFor(() => expect(state.runnerInstances[0].stop).toHaveBeenCalledTimes(4));
    view.unmount();
    expect(state.runnerInstances[0].dispose).toHaveBeenCalledOnce();
  });

  it('renders empty and populated installed apps and dispatches every card action', async () => {
    const apps = [
      catalogApp('installing', { status: 'installing' }),
      catalogApp('conflict', { status: 'conflict', updateAvailable: true }),
      catalogApp('retry', { status: 'error', errorKind: 'retry' }),
      catalogApp('update-error', { status: 'error', errorKind: 'update' }),
      catalogApp('running', { status: 'running' }),
      catalogApp('private', { privateLocal: true, localNetworkShareSupported: true, remoteTunnelSupported: true, remoteNetworkShare: { active: true, state: 'active' } }),
      catalogApp('social', { socialSource: { username: 'maker' }, catalogStatus: 'coming' }),
      catalogApp('beta', { beta: true }),
      catalogApp('update-secondary', { updateAvailable: true }),
      catalogApp('excluded', { status: 'available' }),
    ];
    const { controller } = createController({ installedApps: apps, openingAppIds: new Set(['private']) });
    const view = render(<RendererAppView controller={controller} />);
    expect(screen.getByTestId('AppsGrid')).toBeVisible();
    expect(state.appCards).toHaveLength(9);
    for (const props of state.appCards) {
      act(() => props.onCardClick());
      act(() => props.onPrimaryAction());
      props.onSecondaryAction?.();
      props.onTertiaryAction?.();
      props.primaryMenuActions.forEach((action: any) => action.onClick());
    }
    expect(controller.handleResolveConflict).toHaveBeenCalledWith('conflict');
    expect(controller.handleRetry).toHaveBeenCalledWith('retry');
    expect(controller.handleUpdate).toHaveBeenCalledWith('update-error');
    expect(controller.handleStop).toHaveBeenCalledWith('running');
    expect(controller.handleOpen).toHaveBeenCalledWith('private');
    expect(controller.handleStartLocalNetworkShare).toHaveBeenCalledWith('private');
    expect(controller.handleStopRemoteNetworkShare).toHaveBeenCalledWith('private');
    expect(controller.handleUploadSocial).toHaveBeenCalled();

    controller.installedApps = [];
    view.rerender(<RendererAppView controller={controller} />);
    expect(screen.getByText(t.sections.apps.empty)).toBeVisible();
    await userEvent.click(screen.getAllByRole('button', { name: t.sections.apps.newApp })[0]);
    expect(controller.handleStartNewConversation).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: t.sections.apps.openCatalog }));
    expect(controller.setCurrentView).toHaveBeenCalledWith('catalog');
  });

  it('composes every routed view and forwards its orchestration callbacks', async () => {
    const installed = [catalogApp('installed'), catalogApp('running', { status: 'running' }), catalogApp('excluded', { status: 'available' })];
    const selectedDetails = { app: catalogApp('selected') };
    const { api, controller } = createController({
      installedApps: installed,
      catalogApps: installed,
      selectedAppDetails: selectedDetails,
      selectedAppDetailsId: 'selected',
      installProgressByApp: { selected: 0.4 },
      activeConversation: { id: 'conversation', mode: 'free', targetAppId: 'installed', messages: [], runtime: null },
      mentionedChatFiles: [{ id: 'remove' }],
      forgerFiles: [{ id: 'file' }],
      fileCategories: [{ path: 'category' }],
      backgroundTasks: [{ id: 'task' }],
      selectedBackgroundTaskId: 'task',
      selectedWorkflowId: 'workflow',
      selectedConnectionId: 'connection',
      pinnedViews: [],
    });
    controller.setMentionedChatFileIds.mockImplementation((updater: (ids: string[]) => string[]) => updater(['keep', 'remove']));
    const view = render(<RendererAppView controller={controller} />);
    const show = (currentView: string, capture: string) => {
      controller.currentView = currentView;
      view.rerender(<RendererAppView controller={controller} />);
      expect(screen.getByTestId(capture)).toBeVisible();
      return state.captures[capture];
    };

    let props = show('agents', 'AgentsView');
    props.onNotifyForger({ diagnostic: true });

    props = show('catalog', 'CatalogView');
    props.onUpdate('installed'); props.onUploadSocial('installed'); props.onOpenCloudModal();
    props.onRestoreUserVersion('installed'); props.onResolveConflict('installed'); props.onDetails('installed'); props.onDelete('installed');
    controller.refreshApps.mockResolvedValueOnce(undefined);
    await act(async () => { props.onRefresh(); await Promise.resolve(); });
    controller.refreshApps.mockRejectedValueOnce(new Error('refresh failed'));
    await act(async () => { props.onRefresh(); await Promise.resolve(); });
    await waitFor(() => expect(controller.setBannerMessage).toHaveBeenCalledWith(t.settings.authErrorFallback));
    controller.refreshApps.mockResolvedValueOnce(undefined);
    await act(async () => { state.captures.AppShell.onNavigate('catalog'); await Promise.resolve(); });
    controller.refreshApps.mockRejectedValueOnce(new Error('navigation refresh failed'));
    await act(async () => { state.captures.AppShell.onNavigate('catalog'); await Promise.resolve(); });
    await waitFor(() => expect(controller.setBannerSeverity).toHaveBeenCalledWith('error'));

    props = show('app', 'AppView');
    props.onBack(); props.onInstall('selected'); props.onUpdate('selected'); props.onOpen('selected'); props.onStop('selected');
    props.onRestoreUserVersion('selected'); props.onResolveConflict('selected'); props.onUploadSocial('selected'); props.onRenameApp('selected');
    props.onDelete('selected'); props.onOpenAccount(); props.onSetAppToolGrant('tool', true); props.onSetAppConnectionGrant('gmail', false);
    props.onOpenTools(); props.onOpenConnections(); props.onOpenProfile('   '); props.onOpenProfile(' @maker ');
    expect(window.sessionStorage.getItem('forger.social.last-tab')).toBe('profile');
    expect(controller.setSocialProfileUsername).toHaveBeenCalledWith('maker');
    expect(props.categoryLabel).toBe('Category productivity');
    controller.selectedAppDetails = null;
    controller.selectedAppDetailsId = null;
    props = show('app', 'AppView');
    expect(props.installProgress).toBeUndefined();
    expect(props.categoryLabel).toBe('');
    controller.selectedAppDetails = selectedDetails;
    controller.selectedAppDetailsId = 'selected';

    props = show('chat', 'ChatView');
    props.onNotifyForger(); props.onSend('app'); props.onPickFiles(); props.onCreateUploadCategory(); props.onRemoveMentionedFile('remove');
    props.onConfigureIntelligenceProvider(); props.onOpenApp('installed'); props.onInstallReviewedSocialApp(); props.onDeleteReviewedSocialApp();
    expect(controller.setMentionedChatFileIds).toHaveBeenCalled();
    expect(controller.openCreateCategoryDialog).toHaveBeenCalledWith(undefined, true);
    const controls = props.runtimeProviderControls;
    controls.codex.onSelectModel('gpt-5.2-codex');
    controls.codex.onSelectEffort('high');
    controls.codex.effortOptionsForModel('mini');
    controls.codex.normalizeEffortForModel('mini', '');
    controls.claude.onSelectModel('claude-opus-4-1');
    controls.claude.onSelectEffort('low');
    controls.claude.effortOptionsForModel('mini');
    controls.claude.normalizeEffortForModel('mini', '');
    controls.antigravity.onSelectModel('gemini-3-pro-high');
    controls.antigravity.onSelectEffort('medium');
    controls.antigravity.effortOptionsForModel('mini');
    controls.antigravity.normalizeEffortForModel('mini', '');

    props = show('friends', 'SocialView');
    props.onInitialProfileUsernameConsumed(); props.onOpenFriendChat({ id: 'friendship' }); props.onOpenCloudModal();
    props.onUploadSocial('installed', 'public', 'tools'); props.onUploadSocial('installed', null, 'tools');
    props.onNotify('Default notice'); props.onNotify('Warning notice', 'warning');
    expect(controller.uploadSocialApp).toHaveBeenCalledWith('installed', 'public', { category: 'tools' });

    show('feedback', 'FeedbackView');
    props = show('docs', 'DocsView'); props.onOpenExternalUrl('https://docs.example');
    props = show('more', 'MoreView'); props.onOpen('tools');

    props = show('automations', 'AutomationsView');
    props.onSave({ id: 'automation' }); props.onDelete('automation'); props.onPause('automation'); props.onResume('automation');
    props.onRunNow('automation'); props.onSelectRun('run');
    expect(screen.getByRole('button', { name: t.more.back })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.more.back }));
    controller.pinnedViews = ['automations'];
    state.providerOptions = [];
    view.rerender(<RendererAppView controller={controller} />);
    expect(screen.queryByRole('button', { name: t.more.back })).not.toBeInTheDocument();
    expect(state.captures.AutomationsView.providerOptions).toEqual([{ label: t.sections.automations.autoProvider, value: 'auto' }]);
    state.providerOptions = [{ label: 'Automatic', value: 'auto' }];

    controller.pinnedViews = ['workflows'];
    props = show('workflows', 'WorkflowsModule');
    props.onBackToMore();
    show('workflowEditor', 'WorkflowsModule');
    show('workflowDetail', 'WorkflowsModule');

    props = show('backgroundTasks', 'BackgroundTasksListView');
    expect(props.backLabel).toBe('Back apps');
    props.onBack(); props.onOpenTask('task');
    props = show('backgroundTaskDetail', 'BackgroundTaskDetailView'); props.onBack(); expect(props.task.id).toBe('task');
    controller.selectedBackgroundTaskId = 'missing';
    props = show('backgroundTaskDetail', 'BackgroundTaskDetailView'); expect(props.task).toBeNull();

    controller.pinnedViews = [];
    props = show('files', 'FilesView');
    props.onCreateCategory(); props.onDeleteCategory('category'); props.onDeleteFile({ id: 'file' });
    props = show('backups', 'BackupsView');
    props.onCreateBackup('installed'); props.onSyncNow('installed'); props.onDeleteBackup({ id: 'backup' });
    props.onDeleteRemoteBackup({ id: 'remote' }); props.onRestoreBackup({ id: 'backup' }); props.onRestoreRemoteBackup({ id: 'remote' });
    props.onSetAutoSync('installed', true);
    show('devices', 'DevicesView');
    show('sidekicks', 'SidekicksView');
    props = show('datos', 'DataView');
    await props.onDbListTables('installed'); await props.onDbQueryTable('installed', 'items', 10);
    expect(api.dbQueryTable).toHaveBeenCalledWith('installed', 'items', 10);
    show('secrets', 'SecretsView');

    props = show('connections', 'ConnectionsView');
    props.onNotice({ severity: 'success', message: 'Connected' }); props.onApprovalChange('tool', true);
    expect(props.view).toBe('list');
    props = show('connectionDetail', 'ConnectionsView');
    props.onNotice({ severity: 'warning', message: 'Check' }); props.onApprovalChange('tool', false); props.onBack();
    expect(props.view).toBe('detail');

    props = show('tools', 'ToolsView');
    props.onApprovalChange('tool', true);
    props.onActivateOfficialTool('official');
    props.onConfigureOfficialTool('official', { token: 'secret' });
    props.onConfigureOfficialTool('official');
    props.onDeactivateOfficialTool('official');
    await waitFor(() => expect(api.configureOfficialTool).toHaveBeenCalledWith({ toolId: 'official', locale: 'en', secrets: { token: 'secret' } }));

    props = show('settings', 'SettingsView');
    props.onInitialSubviewConsumed(); props.onAgentDefaultsChange({ provider: 'codex' }); props.onActiveProviderProfileChange({ provider: 'codex' });
    props.onProviderProfileDefaultsChange({ provider: 'codex' }); props.onOpenCodexConfig(); props.onDisconnectCodex(); props.onReinstallCodex();
    props.onOpenClaudeConfig(); props.onDisconnectClaude(); props.onReinstallClaude(); props.onOpenAntigravityConfig();
    props.onDisconnectAntigravity(); props.onReinstallAntigravity(); props.onCancelAntigravityAuthSession(); props.onCloseAntigravityAuthConsole();
    props.onRefreshCloudStorage(); props.onCheckDesktopUpdates(); props.onDownloadDesktopUpdate(); props.onInstallDesktopUpdate();
    props.onCreateMemory({ text: 'memory' }); props.onUpdateMemory({ id: 'memory' }); props.onDeleteMemory('memory');
    await props.onRevealCloudSecretKey();
    await act(async () => { props.onRegenerateCloudSecretKey(); await Promise.resolve(); });
    await waitFor(() => expect(controller.setCloudIdentity).toHaveBeenCalledWith({ id: 'identity' }));
    expect(state.captures.RendererAppDialogs.controller).toBe(controller);

    const local = state.captures.LocalNetworkShareDialog;
    local.onClose(); local.onStop(); local.onCopied();
    expect(controller.setBannerMessage).toHaveBeenCalledWith(t.localNetwork.copied);
  });

  it('renders onboarding variants, legal links, provider setup, and settings handoffs', async () => {
    state.tour.activeStep = 'welcome';
    state.tour.isWelcomeStep = true;
    const { api, controller } = createController({ activeLocale: 'es' });
    const view = render(<RendererAppView controller={controller} />);
    expect(screen.getByText(t.onboarding.steps.welcome.localDataBody)).toBeVisible();
    await userEvent.click(screen.getByRole('link', { name: t.onboarding.steps.welcome.termsLink }));
    await userEvent.click(screen.getByRole('link', { name: t.onboarding.steps.welcome.privacyLink }));
    expect(api.openExternalUrl).toHaveBeenCalledWith('https://forger.cloud/es/terms');
    await userEvent.click(screen.getByRole('switch'));
    expect(state.tour.setWelcomeUsageAnalyticsEnabled).toHaveBeenCalledWith(true);

    controller.activeLocale = 'en';
    view.rerender(<RendererAppView controller={controller} />);
    await userEvent.click(screen.getByRole('link', { name: t.onboarding.steps.welcome.termsLink }));
    await userEvent.click(screen.getByRole('link', { name: t.onboarding.steps.welcome.privacyLink }));
    expect(api.openExternalUrl).toHaveBeenCalledWith('https://forger.cloud/terms');
    state.tour.isWelcomeStep = false;
    state.tour.isAgentStep = true;
    controller.codexAuthStatus = { authenticated: true };
    controller.claudeAuthStatus = { authenticated: false };
    view.rerender(<RendererAppView controller={controller} />);
    expect(screen.getByText(t.agentProvider.connected)).toBeVisible();
    expect(screen.getByText(t.agentProvider.notConnected)).toBeVisible();
    await userEvent.click(screen.getByText(t.agentProvider.codexTitle).closest('button')!);
    await userEvent.click(screen.getByText(t.agentProvider.claudeTitle).closest('button')!);
    expect(controller.setAgentProviderConfigOpen).toHaveBeenCalledWith(false);
    expect(controller.setCodexConfigOpen).toHaveBeenCalledWith(true);
    expect(controller.setClaudeConfigOpen).toHaveBeenCalledWith(true);

    controller.codexAuthStatus = { authenticated: false };
    controller.claudeAuthStatus = { authenticated: true };
    controller.antigravityAuthStatus = { authenticated: false };
    view.rerender(<RendererAppView controller={controller} />);
    controller.claudeAuthStatus = { authenticated: false };
    controller.antigravityAuthStatus = { authenticated: true };
    view.rerender(<RendererAppView controller={controller} />);
    controller.antigravityAuthStatus = { authenticated: false };
    controller.codexConfigOpen = true;
    view.rerender(<RendererAppView controller={controller} />);
    controller.codexConfigOpen = false;
    controller.claudeConfigOpen = true;
    view.rerender(<RendererAppView controller={controller} />);
    controller.claudeConfigOpen = false;
    controller.agentProviderConfigOpen = true;
    view.rerender(<RendererAppView controller={controller} />);
    controller.agentProviderConfigOpen = false;
    controller.cloudModalOpen = true;
    view.rerender(<RendererAppView controller={controller} />);
    controller.cloudModalOpen = false;
    controller.pendingInstallGate = { open: true };
    view.rerender(<RendererAppView controller={controller} />);
    expect(state.tourInputs.at(-1).blocked).toBe(true);

    state.tour.isAgentStep = false;
    controller.pendingInstallGate = null;
    controller.currentView = 'chat';
    state.providerOptions = [{ label: 'Codex', value: 'codex' }];
    controller.selectedAgentProvider = 'missing';
    view.rerender(<RendererAppView controller={controller} />);
    expect(state.captures.ChatView.selectedProvider).toBe('codex');
    state.providerOptions = [
      { label: 'Codex', value: 'codex' },
      { label: 'Claude', value: 'claude' },
      { label: 'Antigravity', value: 'antigravity' },
    ];
    for (const provider of ['codex', 'claude', 'antigravity']) {
      controller.activeConversation = {
        id: provider,
        messages: [],
        runtime: { provider, model: `${provider}-model`, effort: 'high' },
      };
      view.rerender(<RendererAppView controller={controller} />);
      expect(state.captures.ChatView.selectedProvider).toBe(provider);
    }
    state.providerOptions = [];
    controller.activeConversation = null;
    view.rerender(<RendererAppView controller={controller} />);
    expect(state.captures.ChatView.selectedProvider).toBe('auto');
    state.captures.ChatView.onConfigureIntelligenceProvider();
    controller.currentView = 'settings';
    view.rerender(<RendererAppView controller={controller} />);
    expect(state.captures.SettingsView.initialSubview).toBe('llmProvider');
    state.captures.SettingsView.onInitialSubviewConsumed();
    expect(state.captures.TourOverlay.extraContent).toBeUndefined();
  });

  it('downloads, installs, dismisses, and explains desktop updates', async () => {
    const { api, controller } = createController({
      desktopUpdateState: {
        status: 'available', currentVersion: '1.0.0', availableVersion: '1.2.0', asset: { url: 'asset' },
        pendingReleaseSummaries: [{ version: '1.2.0', publishedAt: '2026-08-10T00:00:00.000Z', summary: 'Release summary' }],
      },
    });
    const view = render(<RendererAppView controller={controller} />);
    const modal = await screen.findByRole('dialog', { name: t.settings.desktopUpdateModalTitle });
    expect(within(modal).getByText('v1.2.0')).toBeVisible();
    await userEvent.click(within(modal).getByRole('button', { name: 'Release summary' }));
    expect(api.openExternalUrl).toHaveBeenCalledWith('https://release.example');
    await userEvent.click(within(modal).getByRole('button', { name: t.settings.desktopDownloadUpdate }));
    expect(api.downloadDesktopUpdate).toHaveBeenCalledOnce();
    await userEvent.click(within(modal).getByRole('button', { name: t.settings.desktopUpdateModalLater }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t.settings.desktopUpdateModalTitle })).not.toBeInTheDocument());

    controller.desktopUpdateState = {
      status: 'available', currentVersion: '', availableVersion: '1.3.0', asset: null, publishedAt: null, releaseNotes: null,
    };
    view.rerender(<RendererAppView controller={controller} />);
    const noNotes = await screen.findByRole('dialog', { name: t.settings.desktopUpdateModalTitle });
    expect(within(noNotes).getByText(t.appView.updateNoChangelog)).toBeVisible();
    expect(within(noNotes).getByRole('button', { name: t.settings.desktopDownloadUpdate })).toBeDisabled();
    await userEvent.click(within(noNotes).getByRole('button', { name: t.settings.desktopUpdateModalLater }));

    controller.desktopUpdateState = {
      status: 'ready', currentVersion: '1.0.0', availableVersion: '1.4.0', downloadedPath: '/tmp/update',
      publishedAt: '2026-08-10T00:00:00.000Z', releaseNotes: { summary: 'Fallback notes' },
    };
    view.rerender(<RendererAppView controller={controller} />);
    const ready = await screen.findByRole('dialog', { name: t.settings.desktopUpdateModalTitle });
    expect(within(ready).getByText('Fallback notes')).toBeVisible();
    await userEvent.click(within(ready).getByRole('button', { name: t.settings.desktopInstallUpdate }));
    expect(api.installDesktopUpdate).toHaveBeenCalledOnce();
  });

  it('shows download progress and coordinates installer quit timing', async () => {
    let nextTimerId = 10;
    const intervalCallbacks = new Map<number, () => void>();
    vi.mocked(window.setInterval).mockImplementation((callback) => {
      const timerId = nextTimerId++;
      intervalCallbacks.set(timerId, callback as () => void);
      return timerId;
    });
    vi.mocked(window.clearInterval).mockImplementation((timerId) => { intervalCallbacks.delete(Number(timerId)); });
    const { api, controller } = createController({
      desktopUpdateState: { status: 'downloading', currentVersion: '1.0.0', availableVersion: '2.0.0', progress: undefined },
    });
    const view = render(<RendererAppView controller={controller} />);
    let modal = await screen.findByRole('dialog', { name: t.settings.desktopUpdateModalTitle });
    expect(within(modal).getByText(t.settings.desktopDownloading)).toBeVisible();
    fireEvent.keyDown(modal, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: t.settings.desktopUpdateModalTitle })).toBeVisible();

    controller.desktopUpdateState = { ...controller.desktopUpdateState, progress: -0.5 };
    view.rerender(<RendererAppView controller={controller} />);
    expect(screen.getByText(t.settings.desktopDownloadProgress(0))).toBeVisible();
    controller.desktopUpdateState = { ...controller.desktopUpdateState, progress: 1.5 };
    view.rerender(<RendererAppView controller={controller} />);
    expect(screen.getByText(t.settings.desktopDownloadProgress(100))).toBeVisible();
    controller.desktopUpdateState = { ...controller.desktopUpdateState, progress: 0.426 };
    view.rerender(<RendererAppView controller={controller} />);
    expect(screen.getByText(t.settings.desktopDownloadProgress(43))).toBeVisible();

    controller.desktopUpdateState = {
      status: 'installer_opened', currentVersion: '1.0.0', availableVersion: '2.0.0', installerRequiresQuit: false,
    };
    view.rerender(<RendererAppView controller={controller} />);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t.settings.desktopUpdateModalTitle })).not.toBeInTheDocument());

    controller.desktopUpdateState = {
      status: 'installer_opened', currentVersion: '1.0.0', availableVersion: '2.1.0', installerRequiresQuit: true,
      installerQuitDelaySeconds: 1,
    };
    view.rerender(<RendererAppView controller={controller} />);
    modal = await screen.findByRole('dialog', { name: t.settings.desktopUpdateModalTitle });
    expect(within(modal).getByText(t.settings.desktopUpdateInstallerQuitCountdown(1))).toBeVisible();
    act(() => intervalCallbacks.forEach((callback) => callback()));
    await waitFor(() => expect(api.desktopUpdateQuitForInstall).toHaveBeenCalledOnce());
    await userEvent.click(within(modal).getByRole('button', { name: t.settings.desktopUpdateInstallerCloseNow }));
    expect(api.desktopUpdateQuitForInstall).toHaveBeenCalledTimes(2);
    await userEvent.click(within(modal).getByRole('button', { name: t.settings.desktopUpdateInstallerCloseLater }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t.settings.desktopUpdateModalTitle })).not.toBeInTheDocument());

    controller.desktopUpdateState = {
      status: 'installer_opened', currentVersion: '1.0.0', availableVersion: '2.2.0', installerRequiresQuit: true,
      installerQuitDelaySeconds: 2,
    };
    view.rerender(<RendererAppView controller={controller} />);
    modal = await screen.findByRole('dialog', { name: t.settings.desktopUpdateModalTitle });
    act(() => intervalCallbacks.forEach((callback) => callback()));
    expect(within(modal).getByText(t.settings.desktopUpdateInstallerQuitCountdown(1))).toBeVisible();
    await userEvent.click(within(modal).getByRole('button', { name: t.settings.desktopUpdateInstallerCloseNow }));
    act(() => intervalCallbacks.forEach((callback) => callback()));
    await userEvent.click(within(modal).getByRole('button', { name: t.settings.desktopUpdateInstallerCloseLater }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t.settings.desktopUpdateModalTitle })).not.toBeInTheDocument());

    controller.desktopUpdateState = {
      status: 'installer_opened', currentVersion: '1.0.0', availableVersion: '2.3.0', installerRequiresQuit: true,
    };
    view.rerender(<RendererAppView controller={controller} />);
    modal = await screen.findByRole('dialog', { name: t.settings.desktopUpdateModalTitle });
    expect(within(modal).getByText(t.settings.desktopUpdateInstallerQuitCountdown(5))).toBeVisible();
    controller.desktopUpdateState = { ...controller.desktopUpdateState, availableVersion: null };
    view.rerender(<RendererAppView controller={controller} />);
    await userEvent.click(within(modal).getByRole('button', { name: t.settings.desktopUpdateInstallerCloseLater }));
  });

  it('coordinates account, social-review, forum, and local-share dialogs', async () => {
    const populatedGate = {
      required: [{ id: 'required' }],
      optional: [{ id: 'optional' }],
      connectionRequired: [{ id: 'connection-required' }],
      connectionOptional: [{ id: 'connection-optional' }],
      agents: [{ id: 'agent' }],
      promptTemplates: [{ id: 'prompt' }],
    };
    const { controller } = createController({
      socialDownloadAccountRequiredOpen: true,
      forumPromptOpen: true,
      localNetworkShareDialogOpen: true,
      localNetworkShareStatus: { appId: 'shared' },
      socialInstallReviewDialog: {
        open: true, busy: false, appName: 'Social App', gate: populatedGate, grantDrafts: undefined,
      },
      capabilityRows: vi.fn(() => [{ id: 'capability' }]),
    });
    const view = render(<RendererAppView controller={controller} />);
    const accountDialog = screen.getByText(t.sections.catalog.signInDownloadTitle).closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(within(accountDialog).getByRole('button', { name: t.actions.cancel, hidden: true }));
    await userEvent.click(within(accountDialog).getByRole('button', { name: t.sections.catalog.signInDownloadAction, hidden: true }));
    expect(controller.setSocialDownloadAccountRequiredOpen).toHaveBeenCalledWith(false);
    expect(controller.setCloudModalOpen).toHaveBeenCalledWith(true);

    let review = screen.getByText(t.social.reviewInstallTitle).closest('[role="dialog"]') as HTMLElement;
    expect(within(review).getByText('capability capability')).toBeVisible();
    expect(controller.renderInstallTool).toHaveBeenCalledTimes(2);
    expect(controller.renderInstallConnection).toHaveBeenCalledTimes(2);
    await userEvent.click(within(review).getByRole('button', { name: t.social.installWithoutReviewAction, hidden: true }));
    await userEvent.click(within(review).getByRole('button', { name: t.social.reviewWithAiAction, hidden: true }));
    await userEvent.click(within(review).getByRole('button', { name: t.actions.cancel, hidden: true }));
    expect(controller.handleSocialInstallReviewDecision).toHaveBeenCalledWith('skipped_review');
    expect(controller.handleSocialInstallReviewDecision).toHaveBeenCalledWith('reviewed');
    expect(controller.closeSocialInstallReviewDialog).toHaveBeenCalled();

    controller.socialInstallReviewDialog = {
      open: true, busy: false, appName: 'Optional connection',
      gate: { required: [], optional: [], connectionOptional: [{ id: 'only-optional' }], agents: [], promptTemplates: [] },
    };
    view.rerender(<RendererAppView controller={controller} />);
    expect(controller.renderInstallConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'only-optional' }), false, {}, controller.handleSocialOptionalGrantDraftChange,
    );
    controller.socialInstallReviewDialog = {
      open: true, busy: false, appName: 'Required connection',
      gate: { required: [], optional: [], connectionRequired: [{ id: 'only-required' }], agents: [], promptTemplates: [] },
    };
    view.rerender(<RendererAppView controller={controller} />);
    expect(controller.renderInstallConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'only-required' }), true, {}, controller.handleSocialOptionalGrantDraftChange,
    );

    const forum = screen.getByText(t.settings.forumPromptTitle).closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(within(forum).getByRole('button', { name: t.settings.forumPromptLater }));
    await userEvent.click(within(forum).getByRole('button', { name: t.settings.forumPromptEnter }));
    fireEvent.keyDown(forum, { key: 'Escape' });
    expect(controller.handleDismissForumPrompt).toHaveBeenCalled();
    expect(controller.handleEnterForum).toHaveBeenCalled();
    expect(state.captures.LocalNetworkShareDialog.appName).toBe('App shared');

    controller.socialDownloadAccountRequiredOpen = false;
    controller.forumPromptOpen = false;
    controller.socialInstallReviewDialog = {
      open: true,
      busy: true,
      appName: 'Busy Social App',
      gate: { required: [], optional: [], agents: [], promptTemplates: [] },
      grantDrafts: {},
    };
    controller.capabilityRows.mockReturnValue([]);
    view.rerender(<RendererAppView controller={controller} />);
    review = screen.getByText(t.social.reviewInstallTitle).closest('[role="dialog"]') as HTMLElement;
    expect(within(review).getByText(t.installGate.noCapabilities)).toBeVisible();
    expect(within(review).getByText(t.installGate.noTools)).toBeVisible();
    expect(within(review).getByText(t.installGate.noConnections)).toBeVisible();
    expect(within(review).getByText(t.installGate.noAgents)).toBeVisible();
    expect(within(review).getByText(t.installGate.noAiTasks)).toBeVisible();
    expect(within(review).getByText(t.social.reviewPrepareProgress)).toBeVisible();
    expect(within(review).getByRole('button', { name: t.actions.cancel, hidden: true })).toBeDisabled();
    fireEvent.keyDown(review, { key: 'Escape' });

    controller.socialInstallReviewDialog = { open: true, busy: false, appName: 'Ungated', gate: null };
    controller.localNetworkShareStatus = null;
    view.rerender(<RendererAppView controller={controller} />);
    expect(state.captures.LocalNetworkShareDialog.appName).toBe('');

    controller.socialInstallReviewDialog = null;
    controller.socialDownloadAccountRequiredOpen = true;
    view.rerender(<RendererAppView controller={controller} />);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(controller.setSocialDownloadAccountRequiredOpen).toHaveBeenCalledWith(false));
  });

  it('closes the account-required dialog through its modal boundary', async () => {
    const { controller } = createController({ socialDownloadAccountRequiredOpen: true });
    render(<RendererAppView controller={controller} />);
    expect(await screen.findByRole('dialog', { name: t.sections.catalog.signInDownloadTitle })).toBeVisible();
    const backdrop = document.querySelector('.MuiBackdrop-root') as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(controller.setSocialDownloadAccountRequiredOpen).toHaveBeenCalledWith(false);
  });
});
