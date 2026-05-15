import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
  Snackbar,
  ThemeProvider,
  useMediaQuery,
} from '@mui/material';
import type { AlertColor } from '@mui/material';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  AppAgent,
  AppBackupSummary,
  AppCategory,
  AppDetails,
  AppPromptTemplate,
  AppPromptRestoreInput,
  AppPromptReviewInput,
  AppSecretsState,
  AppSummary,
  AppToolsInstallGate,
  Automation,
  AutomationRun,
  AutomationRunSummary,
  AutomationUpsertInput,
  CatalogApp,
  CloudSyncSettings,
  CloudIdentityState,
  CloudFriendship,
  AgentProvider,
  AgentEffort,
  ClaudeEffort,
  CodexAuthStatus,
  ClaudeAuthStatus,
  CodexReasoningEffort,
  DesktopErrorReportInput,
  DesktopErrorReportPreview,
  DesktopUpdateState,
  FailureDiagnosticFields,
  FilesListInput,
  ForgerAccountRegisterInput,
  ForgerAccountSession,
  ForgerFileCategory,
  ForgerFileRecord,
  InstallAppResult,
  MemoryCreateInput,
  MemoryEntry,
  MemoryUpdateInput,
  OfficialToolSummary,
  PickedChatFile,
  RemoteAppBackupSummary,
  RemoteBackupsUsage,
  Settings,
  SharedFileRef,
  SubmitAppFeedbackInput,
  SubmitAppRatingInput,
  UpdateAgentDefaultsInput,
  UserSecretSummary,
} from '@shared/types';
import { AppShell } from '@renderer/components/AppShell';
import { CodexConfigModal } from '@renderer/components/CodexConfigModal';
import { ClaudeConfigModal } from '@renderer/components/ClaudeConfigModal';
import { ForgerCloudModal } from '@renderer/components/ForgerCloudModal';
import { getDictionary, type Locale } from '@renderer/i18n';
import { buildAppTheme, resolveThemeMode, type ThemePreference } from '@renderer/theme/appTheme';
import { AppView } from '@renderer/views/AppView';
import { AutomationsView } from '@renderer/views/AutomationsView';
import { BackupsView } from '@renderer/views/BackupsView';
import { CatalogView } from '@renderer/views/CatalogView';
import { ChatView, type ChatMessage, type ConversationHistoryItem } from '@renderer/views/ChatView';
import { DataView } from '@renderer/views/DataView';
import { DevicesView } from '@renderer/views/DevicesView';
import { FilesView } from '@renderer/views/FilesView';
import { FriendChatWindowView } from '@renderer/views/FriendChatWindowView';
import { InstalledAppsView } from '@renderer/views/InstalledAppsView';
import { SettingsView } from '@renderer/views/SettingsView';
import { SecretsView } from '@renderer/views/SecretsView';
import { ToolsView } from '@renderer/views/ToolsView';
import type { View } from '@renderer/components/Sidebar';
import {
  CHAT_BOT_PICTURE_OPTIONS,
  CHAT_BOT_PICTURE_STORAGE_KEY,
  CODEX_MODEL_OPTIONS,
  CODEX_MODEL_STORAGE_KEY,
  CODEX_REASONING_OPTIONS,
  CODEX_REASONING_STORAGE_KEY,
  AGENT_PROVIDER_OPTIONS,
  CHAT_AGENT_PROVIDER_STORAGE_KEY,
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_EFFORT_STORAGE_KEY,
  CLAUDE_MODEL_OPTIONS,
  CLAUDE_MODEL_STORAGE_KEY,
  LANGUAGE_STORAGE_KEY,
  STARTUP_UPDATE_CHECK_STORAGE_KEY,
  THEME_STORAGE_KEY,
  getStoredChatBotPicture,
  getStoredCodexModel,
  getStoredCodexReasoningEffort,
  getStoredChatAgentProvider,
  getStoredClaudeEffort,
  getStoredClaudeModel,
  getStoredLanguagePreference,
  getStoredThemePreference,
  resolveSystemLocale,
  type ChatBotPicture,
  type LanguagePreference,
} from '@renderer/preferences';
import {
  CHAT_STORAGE_KEY,
  makeConversationId,
  readPersistedChatState,
  summarizeConversationTitle,
  type ChatConversation,
  type PersistedChatState,
} from '@renderer/chat-state';
import {
  buildErrorReport as buildErrorReportPreview,
  shouldPromptForErrorReport,
} from '@renderer/error-reporting';

const FORGER_DATA_ROOT_NAME = 'data';
const FREE_CHAT_APP_ID = 'forger';

const mergeRecords = (
  first?: Record<string, unknown>,
  second?: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const merged = { ...(first ?? {}), ...(second ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
};

const initialSettings: Settings = {
  userEmail: '',
  plan: 'Free',
  safeMode: false,
  codexDefaults: {
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
  },
  defaultAgentProvider: 'auto',
  agentDefaults: {
    codex: {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
    },
    claude: {
      model: 'sonnet',
      effort: 'medium',
    },
  },
  providerConnections: {},
};

const initialCodexAuthStatus: CodexAuthStatus = {
  installed: false,
  authenticated: false,
  authFilePath: '',
  codexHome: '',
};

const initialClaudeAuthStatus: ClaudeAuthStatus = {
  installed: false,
  authenticated: false,
  source: 'missing',
};

const resolveChatRuntimeDraft = (
  provider: AgentProvider,
  codexModel: string,
  codexReasoningEffort: CodexReasoningEffort,
  claudeModel: string,
  claudeEffort: ClaudeEffort,
): { provider: AgentProvider; model: string; effort: AgentEffort; reasoningEffort?: CodexReasoningEffort } => {
  if (provider === 'codex') {
    return { provider: 'codex', model: codexModel, reasoningEffort: codexReasoningEffort, effort: codexReasoningEffort };
  }
  return { provider: 'claude', model: claudeModel, effort: claudeEffort };
};

const initialForgerAccount: ForgerAccountSession = {
  authenticated: false,
};

const initialRemoteBackupsUsage: RemoteBackupsUsage = {
  usedBytes: 0,
  limitBytes: 0,
  backupCount: 0,
  backupCountLimit: 0,
};

const initialDesktopUpdateState: DesktopUpdateState = {
  status: 'idle',
  currentVersion: '',
};

const initialAgentToolSettings: AgentToolSettings = {
  approvals: {
    forger_list_catalog: false,
    forger_list_installed_apps: false,
    forger_check_updates: false,
    forger_list_app_prompts: false,
    forger_update_app_prompt: true,
    forger_restore_app_prompt: true,
    forger_get_app_runtime_status: false,
    forger_open_app: true,
    forger_stop_app: true,
    forger_restart_app: true,
    forger_refresh_app_view: true,
    forger_update_app: true,
    memory_list: false,
    memory_create: false,
    memory_update: false,
    memory_delete: false,
    'gmail.connection.status': false,
    'gmail.search_messages': true,
    'gmail.read_thread': true,
    'gmail.read_attachment': true,
    'gmail.send_email': true,
  },
};

const getDesktopApi = () => {
  const desktopApi = window.forger;
  if (!desktopApi) {
    throw new Error(
      'Bridge de Electron no disponible. Ejecuta Forger con `npm run dev` en desktop (no solo Vite en navegador).',
    );
  }

  return desktopApi;
};

interface ErrorReportDialogState {
  open: boolean;
  report: DesktopErrorReportPreview | null;
  busy: boolean;
  userMessage?: string;
}

interface SocialChatWindowRoute {
  friendUserId: number;
  friendUsername: string;
  friendDisplayName: string;
}

const resolveSocialChatWindowRoute = (): SocialChatWindowRoute | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('socialChat') !== '1') {
    return null;
  }

  const friendUserId = Number(params.get('friendUserId'));
  const friendUsername = params.get('friendUsername')?.trim();
  const friendDisplayName = params.get('friendDisplayName')?.trim();
  if (!Number.isFinite(friendUserId) || !friendUsername || !friendDisplayName) {
    return null;
  }

  return {
    friendUserId,
    friendUsername,
    friendDisplayName,
  };
};

function App() {
  const persistedChatState = useMemo(() => readPersistedChatState(), []);
  const socialChatWindowRoute = useMemo(() => resolveSocialChatWindowRoute(), []);
  const [currentView, setCurrentView] = useState<View>('my-apps');
  const [installedApps, setInstalledApps] = useState<AppSummary[]>([]);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [catalogApps, setCatalogApps] = useState<CatalogApp[]>([]);
  const [openingAppIds, setOpeningAppIds] = useState<Set<string>>(new Set());
  const openingAppIdsRef = useRef<Set<string>>(new Set());
  const [installProgressByApp, setInstallProgressByApp] = useState<Record<string, InstallAppResult>>({});
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const [codexAuthStatus, setCodexAuthStatus] = useState<CodexAuthStatus>(initialCodexAuthStatus);
  const [claudeAuthStatus, setClaudeAuthStatus] = useState<ClaudeAuthStatus>(initialClaudeAuthStatus);
  const [agentToolPackages, setAgentToolPackages] = useState<AgentToolPackageDefinition[]>([]);
  const [agentToolSettings, setAgentToolSettings] = useState<AgentToolSettings>(initialAgentToolSettings);
  const [agentToolBusyId, setAgentToolBusyId] = useState<AgentToolDefinition['id'] | null>(null);
  const [agentToolError, setAgentToolError] = useState<string | null>(null);
  const [agentToolErrorCode, setAgentToolErrorCode] = useState<string | null>(null);
  const [officialTools, setOfficialTools] = useState<OfficialToolSummary[]>([]);
  const [officialToolBusyId, setOfficialToolBusyId] = useState<string | null>(null);
  const [cloudModalOpen, setCloudModalOpen] = useState(false);
  const [forgerAccount, setForgerAccount] = useState<ForgerAccountSession>(initialForgerAccount);
  const [forgerAccountBusy, setForgerAccountBusy] = useState(false);
  const [forgerAccountMessage, setForgerAccountMessage] = useState<string | null>(null);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState>(initialDesktopUpdateState);
  const [desktopUpdateBusy, setDesktopUpdateBusy] = useState(false);
  const [codexConfigOpen, setCodexConfigOpen] = useState(false);
  const [claudeConfigOpen, setClaudeConfigOpen] = useState(false);
  const [agentProviderConfigOpen, setAgentProviderConfigOpen] = useState(false);
  const [errorReportDialog, setErrorReportDialog] = useState<ErrorReportDialogState>({
    open: false,
    report: null,
    busy: false,
  });
  const [selectedAppDetailsId, setSelectedAppDetailsId] = useState<string | null>(null);
  const [selectedAppDetails, setSelectedAppDetails] = useState<AppDetails | null>(null);
  const [appDetailsBackView, setAppDetailsBackView] = useState<View>('catalog');
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [selectedDataAppId, setSelectedDataAppId] = useState<string | null>(null);
  const [appSecretsState, setAppSecretsState] = useState<AppSecretsState | null>(null);
  const [pendingInstallGate, setPendingInstallGate] = useState<AppToolsInstallGate | null>(null);
  const [pendingInstallBusy, setPendingInstallBusy] = useState(false);
  const [userSecrets, setUserSecrets] = useState<UserSecretSummary[]>([]);
  const [secretsBusy, setSecretsBusy] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [pendingChatFiles, setPendingChatFiles] = useState<PickedChatFile[]>([]);
  const [mentionedChatFileIds, setMentionedChatFileIds] = useState<string[]>([]);
  const [uploadCategoryPath, setUploadCategoryPath] = useState('');
  const [selectedCodexModel, setSelectedCodexModel] = useState(getStoredCodexModel);
  const [selectedCodexReasoningEffort, setSelectedCodexReasoningEffort] = useState(getStoredCodexReasoningEffort);
  const [selectedAgentProvider, setSelectedAgentProvider] = useState<AgentProvider | 'auto'>(getStoredChatAgentProvider);
  const [selectedClaudeModel, setSelectedClaudeModel] = useState(getStoredClaudeModel);
  const [selectedClaudeEffort, setSelectedClaudeEffort] = useState<ClaudeEffort>(getStoredClaudeEffort);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [categoryDialogSelectAfterCreate, setCategoryDialogSelectAfterCreate] = useState(false);
  const [categoryDialogName, setCategoryDialogName] = useState('');
  const [renameCategoryDialog, setRenameCategoryDialog] = useState<{ open: boolean; categoryPath: string; name: string }>({
    open: false,
    categoryPath: '',
    name: '',
  });
  const [renameFileDialog, setRenameFileDialog] = useState<{ open: boolean; file: ForgerFileRecord | null; name: string }>({
    open: false,
    file: null,
    name: '',
  });
  const [moveFileDialog, setMoveFileDialog] = useState<{ open: boolean; file: ForgerFileRecord | null; categoryPath: string }>({
    open: false,
    file: null,
    categoryPath: '',
  });
  const [forgerFiles, setForgerFiles] = useState<ForgerFileRecord[]>([]);
  const [fileCategories, setFileCategories] = useState<ForgerFileCategory[]>([]);
  const [fileFilters, setFileFilters] = useState<FilesListInput>({ sortBy: 'uploadedAt', sortDirection: 'desc' });
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRunSummary[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [selectedAutomationRun, setSelectedAutomationRun] = useState<AutomationRun | null>(null);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [backups, setBackups] = useState<AppBackupSummary[]>([]);
  const [remoteBackups, setRemoteBackups] = useState<RemoteAppBackupSummary[]>([]);
  const [remoteBackupsUsage, setRemoteBackupsUsage] = useState<RemoteBackupsUsage>(initialRemoteBackupsUsage);
  const [cloudSyncSettings, setCloudSyncSettings] = useState<CloudSyncSettings>({ appSync: {} });
  const [cloudIdentity, setCloudIdentity] = useState<CloudIdentityState | null>(null);
  const [backupsBusy, setBackupsBusy] = useState(false);
  const [chatConversations, setChatConversations] = useState<ChatConversation[]>(
    persistedChatState.conversations,
  );
  const [activeConversationByApp, setActiveConversationByApp] = useState<Record<string, string>>(
    persistedChatState.activeConversationByApp,
  );
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    persistedChatState.lastActiveConversationId,
  );
  const [chatRunActive, setChatRunActive] = useState(false);
  const [chatProgressLines, setChatProgressLines] = useState<string[]>([]);
  const activeRunConversationIdRef = useRef<string | null>(null);
  const selectedAutomationIdRef = useRef<string | null>(null);
  const runConversationIdByRunRef = useRef<Map<string, string>>(new Map());
  const deliveredRunRepliesRef = useRef<Set<string>>(new Set());
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [bannerSeverity, setBannerSeverity] = useState<AlertColor>('success');
  const [catalogFilter, setCatalogFilter] = useState<'all' | AppCategory>('all');
  const [catalogStatusFilter, setCatalogStatusFilter] = useState<'all' | 'installed' | 'not_installed'>('all');
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(getStoredThemePreference);
  const [languagePreference, setLanguagePreference] =
    useState<LanguagePreference>(getStoredLanguagePreference);
  const [systemLocale, setSystemLocale] = useState<Locale>(resolveSystemLocale);
const activeLocale = languagePreference === 'system' ? systemLocale : languagePreference;
  const t = useMemo(() => getDictionary(activeLocale), [activeLocale]);
  const [chatBotPicture, setChatBotPicture] = useState<ChatBotPicture>(getStoredChatBotPicture);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const chatBotPictureSrc =
    CHAT_BOT_PICTURE_OPTIONS.find((option) => option.value === chatBotPicture)?.src ?? CHAT_BOT_PICTURE_OPTIONS[0].src;

  const activeConversation = useMemo(
    () => chatConversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [chatConversations, activeConversationId],
  );
  const chatMessages = activeConversation?.messages ?? [];
  const mentionedChatFiles = useMemo(
    () => forgerFiles.filter((file) => mentionedChatFileIds.includes(file.id)),
    [forgerFiles, mentionedChatFileIds],
  );
  const chatHistoryItems = useMemo<ConversationHistoryItem[]>(
    () => {
      const chatScopeId = selectedAppId ?? FREE_CHAT_APP_ID;
      return chatConversations
        .filter((conversation) => conversation.appId === chatScopeId)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          threadId: conversation.threadId,
          updatedAt: conversation.updatedAt,
        }));
    },
    [chatConversations, selectedAppId],
  );
  const resolvedChatProvider = useMemo<AgentProvider>(() => {
    if (activeConversation?.runtime) {
      return activeConversation.runtime.provider;
    }
    if (selectedAgentProvider !== 'auto') {
      return selectedAgentProvider;
    }
    if (settings.defaultAgentProvider !== 'auto') {
      return settings.defaultAgentProvider;
    }
    if (claudeAuthStatus.authenticated && !codexAuthStatus.authenticated) {
      return 'claude';
    }
    if (codexAuthStatus.authenticated && !claudeAuthStatus.authenticated) {
      return 'codex';
    }
    const connectedProviders = (Object.entries(settings.providerConnections) as Array<[AgentProvider, string | undefined]>)
      .filter(([, connectedAt]) => Boolean(connectedAt))
      .sort(([, left], [, right]) => Date.parse(left ?? '') - Date.parse(right ?? ''));
    return connectedProviders[0]?.[0] ?? 'codex';
  }, [
    activeConversation?.runtime,
    claudeAuthStatus.authenticated,
    codexAuthStatus.authenticated,
    selectedAgentProvider,
    settings.defaultAgentProvider,
    settings.providerConnections,
  ]);

  const requestErrorReport = (input: DesktopErrorReportInput) => {
    if (!shouldPromptForErrorReport(input.technicalCode)) {
      return;
    }
    setErrorReportDialog({
      open: true,
      report: buildErrorReportPreview(input, desktopUpdateState.currentVersion),
      busy: false,
    });
  };

  const requestErrorReportFromResult = (
    source: DesktopErrorReportInput['source'],
    operation: string,
    result: { success: boolean; userMessage?: string } & FailureDiagnosticFields,
    extra?: Pick<DesktopErrorReportInput, 'appId' | 'appVersion' | 'details' | 'sensitiveDetails'>,
  ) => {
    if (result.success || !result.technicalCode || !shouldPromptForErrorReport(result.technicalCode)) {
      return;
    }
    requestErrorReport({
      source,
      operation,
      message: result.userMessage ?? result.technicalCode,
      technicalCode: result.technicalCode,
      appId: extra?.appId,
      appVersion: extra?.appVersion,
      details: mergeRecords(result.details, extra?.details),
      sensitiveDetails: mergeRecords(result.sensitiveDetails, extra?.sensitiveDetails),
    });
  };

  const refreshFiles = async (filters: FilesListInput = fileFilters) => {
    const desktopApi = getDesktopApi();
    const [files, categories] = await Promise.all([
      desktopApi.filesList(filters),
      desktopApi.filesListCategories(),
    ]);
    setForgerFiles(files);
    setFileCategories(categories);
  };

  const refreshAutomations = async () => {
    const desktopApi = getDesktopApi();
    const nextAutomations = await desktopApi.automationsList();
    setAutomations(nextAutomations);
    return nextAutomations;
  };

  const refreshBackups = async () => {
    const desktopApi = getDesktopApi();
    const [nextBackups, nextRemoteBackups, nextCloudSyncSettings] = await Promise.all([
      desktopApi.listBackups(),
      desktopApi.listRemoteBackups(),
      desktopApi.getCloudSyncSettings(),
    ]);
    setBackups(nextBackups);
    setRemoteBackups(nextRemoteBackups.backups);
    setRemoteBackupsUsage(nextRemoteBackups.usage);
    setCloudSyncSettings(nextCloudSyncSettings);
    return nextBackups;
  };

  const loadAutomationRuns = async (automationId: string, preferredRunId?: string) => {
    const desktopApi = getDesktopApi();
    const runs = await desktopApi.automationsListRuns(automationId);
    setAutomationRuns(runs);
    const targetRunId = preferredRunId ?? runs[0]?.id;
    if (targetRunId) {
      const run = await desktopApi.automationsGetRunTranscript(targetRunId);
      setSelectedAutomationRun(run);
    } else {
      setSelectedAutomationRun(null);
    }
  };

  const refreshApps = async () => {
    const desktopApi = getDesktopApi();
    const catalog = await desktopApi.listCatalogApps();
    const installed = await desktopApi.listInstalledApps();
    setCatalogApps(catalog);
    setInstalledApps(installed);
    return { catalog, installed };
  };

  const refreshAgentTools = async () => {
    const desktopApi = getDesktopApi();
    const [toolPackages, toolSettings] = await Promise.all([
      desktopApi.listAgentTools(),
      desktopApi.getAgentToolSettings(),
    ]);
    setAgentToolPackages(toolPackages);
    setAgentToolSettings(toolSettings);
  };

  const refreshOfficialTools = async () => {
    const state = await getDesktopApi().listOfficialTools(activeLocale);
    setOfficialTools(state.tools);
    return state.tools;
  };

  useEffect(() => {
    const loadData = async () => {
      const desktopApi = getDesktopApi();
      const [
        appsResult,
        settingsResult,
        accountResult,
        codexAuthResult,
        claudeAuthResult,
        desktopUpdateResult,
        toolsResult,
        officialToolsResult,
        filesResult,
        categoriesResult,
        automationsResult,
        backupsResult,
        remoteBackupsResult,
        cloudSyncSettingsResult,
        cloudIdentityResult,
        memoriesResult,
      ] = await Promise.allSettled([
        refreshApps(),
        desktopApi.getSettings(),
        desktopApi.getForgerAccount(),
        desktopApi.getCodexAuthStatus(),
        desktopApi.getClaudeAuthStatus(),
        desktopApi.getDesktopUpdateState(),
        refreshAgentTools(),
        refreshOfficialTools(),
        desktopApi.filesList(fileFilters),
        desktopApi.filesListCategories(),
        desktopApi.automationsList(),
        desktopApi.listBackups(),
        desktopApi.listRemoteBackups(),
        desktopApi.getCloudSyncSettings(),
        desktopApi.getCloudIdentity(),
        desktopApi.memoryList(),
      ]);

      if (appsResult.status === 'rejected') {
        setBannerSeverity('error');
        setBannerMessage(t.settings.authErrorFallback);
      }

      if (settingsResult.status === 'fulfilled') {
        setSettings(settingsResult.value);
      }

      if (accountResult.status === 'fulfilled') {
        setForgerAccount(accountResult.value);
      }

      if (filesResult.status === 'fulfilled') {
        setForgerFiles(filesResult.value);
      }

      if (categoriesResult.status === 'fulfilled') {
        setFileCategories(categoriesResult.value);
      }

      if (automationsResult.status === 'fulfilled') {
        setAutomations(automationsResult.value);
        if (automationsResult.value[0]) {
          setSelectedAutomationId(automationsResult.value[0].id);
          void loadAutomationRuns(automationsResult.value[0].id);
        }
      }

      if (backupsResult.status === 'fulfilled') {
        setBackups(backupsResult.value);
      }

      if (remoteBackupsResult.status === 'fulfilled') {
        setRemoteBackups(remoteBackupsResult.value.backups);
        setRemoteBackupsUsage(remoteBackupsResult.value.usage);
      }

      if (cloudSyncSettingsResult.status === 'fulfilled') {
        setCloudSyncSettings(cloudSyncSettingsResult.value);
      }

      if (cloudIdentityResult.status === 'fulfilled') {
        setCloudIdentity(cloudIdentityResult.value);
      }

      if (memoriesResult.status === 'fulfilled') {
        setMemories(memoriesResult.value);
      }

      if (codexAuthResult.status === 'fulfilled') {
        setCodexAuthStatus(codexAuthResult.value);
      }

      if (claudeAuthResult.status === 'fulfilled') {
        setClaudeAuthStatus(claudeAuthResult.value);
      }

      if (
        codexAuthResult.status === 'fulfilled'
        && claudeAuthResult.status === 'fulfilled'
        && !codexAuthResult.value.authenticated
        && !claudeAuthResult.value.authenticated
      ) {
        setAgentProviderConfigOpen(true);
      }

      if (desktopUpdateResult.status === 'fulfilled') {
        setDesktopUpdateState(desktopUpdateResult.value);
      }

      const today = new Date().toISOString().slice(0, 10);
      const lastStartupCheck = window.localStorage.getItem(STARTUP_UPDATE_CHECK_STORAGE_KEY);
      if (lastStartupCheck !== today) {
        window.localStorage.setItem(STARTUP_UPDATE_CHECK_STORAGE_KEY, today);
        void desktopApi.checkDesktopUpdates().then((state) => {
          setDesktopUpdateState(state);
          if (state.status === 'available' && state.availableVersion) {
            setBannerSeverity('info');
            setBannerMessage(t.settings.desktopStartupUpdateAvailable(state.availableVersion));
          } else if (state.status === 'unsupported' && state.userMessage) {
            setBannerSeverity('warning');
            setBannerMessage(state.userMessage);
          }
        }).catch(() => undefined);
      }

      if (toolsResult.status === 'rejected') {
        setAgentToolError(t.sections.tools.saveError);
      }
      if (officialToolsResult.status === 'rejected') {
        setAgentToolError(t.sections.tools.saveError);
      }
    };

    void loadData();
  }, []);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      requestErrorReport({
        source: 'renderer',
        operation: 'window.error',
        message: event.message || 'Renderer error',
        technicalCode: 'renderer_error',
        details: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
        sensitiveDetails: {
          stack: event.error instanceof Error ? event.error.stack : undefined,
        },
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      requestErrorReport({
        source: 'renderer',
        operation: 'unhandledrejection',
        message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled renderer rejection'),
        technicalCode: 'renderer_unhandled_rejection',
        sensitiveDetails: {
          stack: reason instanceof Error ? reason.stack : undefined,
          reason: reason instanceof Error ? undefined : String(reason ?? ''),
        },
      });
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, [desktopUpdateState.currentVersion]);

  useEffect(() => {
    let desktopApi: ReturnType<typeof getDesktopApi>;
    try {
      desktopApi = getDesktopApi();
    } catch {
      return () => undefined;
    }

    const unsubscribeInstall = desktopApi.onInstallProgress(({ appId, progress }) => {
      setInstallProgressByApp((current) => {
        const next = { ...current };
        if (progress.phase === 'completed' || progress.phase === 'failed' || progress.phase === 'conflict') {
          delete next[appId];
        } else {
          next[appId] = progress;
        }
        return next;
      });

      if (progress.phase === 'completed') {
        setBannerSeverity('success');
      } else if (progress.phase === 'failed') {
        setBannerSeverity('error');
      } else {
        setBannerSeverity('info');
      }

      setBannerMessage(progress.userMessage);

      void refreshApps();

      if (progress.phase === 'completed') {
        setSelectedAppId(appId);
      }
    });

    const unsubscribeRuntime = desktopApi.onRuntimeStatusChanged((status) => {
      if (status.status === 'running') {
        setBannerSeverity('success');
        setBannerMessage(status.userMessage ?? t.actions.running);
      } else if (status.status === 'error') {
        setBannerSeverity('error');
        setBannerMessage(status.userMessage ?? t.settings.authErrorFallback);
        requestErrorReport({
          source: 'app',
          operation: 'runtime.status',
          message: status.userMessage ?? t.settings.authErrorFallback,
          technicalCode: 'app_runtime_error',
          appId: status.appId,
          details: { status: status.status },
        });
      } else if (status.status === 'installed') {
        setBannerSeverity('info');
        setBannerMessage(status.userMessage ?? t.actions.installed);
      }

      void refreshApps();
    });

    const unsubscribeChat = desktopApi.onChatRunUpdated(({ run }) => {
      const isTerminal =
        run.status === 'preview_ready' ||
        run.status === 'failed' ||
        run.status === 'canceled' ||
        run.status === 'applied' ||
        run.status === 'undone';
      setChatRunActive(!isTerminal);
      setChatProgressLines(run.progressLog ?? []);

      if (run.status === 'needs_permission' && run.permissionRequest) {
        const dedupePermissionKey = `${run.runId}:needs_permission:${run.permissionRequest.requestId}`;
        if (!deliveredRunRepliesRef.current.has(dedupePermissionKey)) {
          deliveredRunRepliesRef.current.add(dedupePermissionKey);
      const targetConversationId =
            run.conversationId ??
            runConversationIdByRunRef.current.get(run.runId) ??
            activeRunConversationIdRef.current ??
            activeConversationId;
          if (targetConversationId) {
            const permissionRequest = run.permissionRequest;
            console.info('[Forger permission] rendering request', {
              runId: run.runId,
              requestId: permissionRequest.requestId,
              permission: permissionRequest.permission,
              resource: permissionRequest.resource,
              targetConversationId,
            });
            setChatConversations((currentConversations) =>
              currentConversations.map((conversation) => {
                if (conversation.id !== targetConversationId) {
                  return conversation;
                }
                return {
                  ...conversation,
                  updatedAt: new Date().toISOString(),
                  messages: [
                    ...conversation.messages,
                    {
                      id: `assistant-permission-${run.runId}-${permissionRequest.requestId}`,
                      role: 'assistant',
                      content: t.sections.chat.permissionPrompt(permissionRequest.resource),
                      action: {
                        type: 'permission',
                        runId: run.runId,
                        request: permissionRequest,
                        status: 'pending',
                      },
                    },
                  ],
                };
              }),
            );
          } else {
            console.warn('[Forger permission] request received without an active conversation target', {
              runId: run.runId,
              requestId: run.permissionRequest.requestId,
              permission: run.permissionRequest.permission,
              resource: run.permissionRequest.resource,
            });
            setBannerSeverity('warning');
            setBannerMessage(t.sections.chat.permissionPrompt(run.permissionRequest.resource));
          }
        }
        return;
      }

      const isMessageTerminal =
        run.status === 'preview_ready' ||
        run.status === 'applied' ||
        run.status === 'undone' ||
        run.status === 'failed' ||
        run.status === 'canceled';
      if (isTerminal && !isMessageTerminal) {
        activeRunConversationIdRef.current = null;
      }
      const hasMessage = typeof run.userMessage === 'string' && run.userMessage.trim().length > 0;
      const dedupeKey = `${run.runId}:${run.status}`;
      if (!isMessageTerminal || !hasMessage || deliveredRunRepliesRef.current.has(dedupeKey)) {
        return;
      }

      deliveredRunRepliesRef.current.add(dedupeKey);
      const targetConversationId =
        run.conversationId ??
        runConversationIdByRunRef.current.get(run.runId) ??
        activeRunConversationIdRef.current ??
        activeConversationId;
      if (!targetConversationId) {
        return;
      }

      setChatConversations((currentConversations) =>
        currentConversations.map((conversation) => {
          if (conversation.id !== targetConversationId) {
            return conversation;
          }
          return {
            ...conversation,
            threadId:
              typeof run.threadId === 'string' && run.threadId.trim().length > 0
                ? run.threadId
                : conversation.threadId,
            updatedAt: new Date().toISOString(),
            messages: [
              ...conversation.messages,
              {
                id: `assistant-run-${run.runId}-${run.status}`,
                role: 'assistant',
                content: run.userMessage as string,
              },
            ],
          };
        }),
      );
      if (isTerminal) {
        runConversationIdByRunRef.current.delete(run.runId);
        activeRunConversationIdRef.current = null;
      }
    });

    const unsubscribeAutomation = desktopApi.onAutomationUpdated(({ automation, run }) => {
      setAutomations((current) => {
        const withoutCurrent = current.filter((item) => item.id !== automation.id);
        return [automation, ...withoutCurrent].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      });
      if (selectedAutomationIdRef.current === automation.id) {
        void desktopApi.automationsListRuns(automation.id).then((runs) => {
          setAutomationRuns(runs);
          const targetRunId = run?.id ?? selectedAutomationRun?.id ?? runs[0]?.id;
          if (!targetRunId) {
            setSelectedAutomationRun(null);
            return;
          }
          void desktopApi.automationsGetRunTranscript(targetRunId).then(setSelectedAutomationRun);
        });
      }
    });

    const unsubscribeDesktopUpdate = desktopApi.onDesktopUpdateProgress((state) => {
      setDesktopUpdateState(state);
    });

    const unsubscribeForgerAccount = desktopApi.onForgerAccountUpdated((account) => {
      setForgerAccount(account);
      setForgerAccountMessage(account.userMessage ?? null);
    });

    const unsubscribeErrorReport = desktopApi.onDesktopErrorReportRequested((report) => {
      setErrorReportDialog({ open: true, report, busy: false });
    });

    return () => {
      unsubscribeInstall();
      unsubscribeRuntime();
      unsubscribeChat();
      unsubscribeAutomation();
      unsubscribeDesktopUpdate();
      unsubscribeForgerAccount();
      unsubscribeErrorReport();
    };
  }, []);

  useEffect(() => {
    selectedAutomationIdRef.current = selectedAutomationId;
  }, [selectedAutomationId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({
        conversations: chatConversations,
        activeConversationByApp,
        lastActiveConversationId: activeConversationId,
      } satisfies PersistedChatState),
    );
  }, [chatConversations, activeConversationByApp, activeConversationId]);

  useEffect(() => {
    const chatScopeId = selectedAppId ?? FREE_CHAT_APP_ID;
    const appSpecificActive = activeConversationByApp[chatScopeId];
    const appConversations = chatConversations
      .filter((conversation) => conversation.appId === chatScopeId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const fallback = appConversations[0]?.id ?? null;

    if (appSpecificActive && chatConversations.some((conversation) => conversation.id === appSpecificActive)) {
      setActiveConversationId(appSpecificActive);
      return;
    }
    setActiveConversationId(fallback);
  }, [selectedAppId, activeConversationByApp, chatConversations]);

  useEffect(() => {
    if (currentView !== 'datos') {
      return;
    }
    if (selectedDataAppId) {
      return;
    }
    const installedOnly = installedApps.filter((a) => a.status === 'installed' || a.status === 'running');
    if (installedOnly.length === 0) {
      return;
    }
    setSelectedDataAppId(installedOnly[0].id);
  }, [currentView, selectedDataAppId, installedApps]);

  useEffect(() => {
    if (currentView !== 'files') {
      return;
    }
    void refreshFiles(fileFilters);
  }, [currentView, fileFilters]);

  useEffect(() => {
    if (currentView !== 'backups') {
      return;
    }
    void refreshBackups().catch(() => {
      setBannerSeverity('error');
      setBannerMessage(t.sections.backups.loadError);
    });
  }, [currentView, installedApps]);

  useEffect(() => {
    if (currentView !== 'secrets') {
      return;
    }
    void refreshUserSecrets().catch(() => {
      setBannerSeverity('error');
      setBannerMessage('No pudimos cargar tus secretos.');
    });
  }, [currentView]);

  useEffect(() => {
    if (currentView !== 'chat') {
      return;
    }
    void refreshFiles({ sortBy: 'uploadedAt', sortDirection: 'desc' });
  }, [currentView]);

  useEffect(() => {
    if (currentView !== 'app' || !selectedAppDetailsId) {
      return;
    }
    const desktopApi = getDesktopApi();
    void desktopApi.getAppDetails(selectedAppDetailsId).then((details) => {
      setSelectedAppDetails(details);
      if (details?.installed) {
        void refreshAppSecrets(selectedAppDetailsId).catch(() => {
          setBannerSeverity('error');
          setBannerMessage('No pudimos cargar los secretos de esta app.');
        });
      } else {
        setAppSecretsState(null);
      }
    });
  }, [currentView, selectedAppDetailsId, installedApps, catalogApps]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    }
  }, [themePreference]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference);
    }
  }, [languagePreference]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handleLanguageChange = () => setSystemLocale(resolveSystemLocale());
    window.addEventListener('languagechange', handleLanguageChange);
    return () => window.removeEventListener('languagechange', handleLanguageChange);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CODEX_MODEL_STORAGE_KEY, selectedCodexModel);
    }
  }, [selectedCodexModel]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CODEX_REASONING_STORAGE_KEY, selectedCodexReasoningEffort);
    }
  }, [selectedCodexReasoningEffort]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CHAT_AGENT_PROVIDER_STORAGE_KEY, selectedAgentProvider);
    }
  }, [selectedAgentProvider]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CLAUDE_MODEL_STORAGE_KEY, selectedClaudeModel);
    }
  }, [selectedClaudeModel]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CLAUDE_EFFORT_STORAGE_KEY, selectedClaudeEffort);
    }
  }, [selectedClaudeEffort]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CHAT_BOT_PICTURE_STORAGE_KEY, chatBotPicture);
    }
  }, [chatBotPicture]);

  const getAppMeta = (appId: string) => {
    const fromCatalog = catalogApps.find((appEntry) => appEntry.id === appId);
    if (fromCatalog?.name) {
      return {
        name: fromCatalog.name,
        description: fromCatalog.description ?? '',
        iconUrl: fromCatalog.iconUrl,
      };
    }

    const fromInstalled = installedApps.find((appEntry) => appEntry.id === appId);
    if (fromInstalled?.name) {
      return {
        name: fromInstalled.name,
        description: fromInstalled.description ?? '',
        iconUrl: fromInstalled.iconUrl,
      };
    }

    return (
      t.apps[appId as keyof typeof t.apps] ?? {
        name: appId,
        description: '',
        iconUrl: undefined,
      }
    );
  };

  const getCategoryLabel = (category: AppCategory) => t.appCategories[category];

  const setChatContext = (appId: string) => {
    const appEntry =
      installedApps.find((app) => app.id === appId) ??
      catalogApps.find((app) => app.id === appId);

    if (!appEntry) {
      return;
    }

    setSelectedAppId(appEntry.id);
    setCurrentView('chat');
    setChatInput('');
    setChatProgressLines([]);
    deliveredRunRepliesRef.current.clear();
  };

  const openAppDetails = async (appId: string, backView: View = currentView) => {
    setAppDetailsBackView(backView);
    setSelectedAppDetailsId(appId);
    setCurrentView('app');
    const details = await getDesktopApi().getAppDetails(appId);
    setSelectedAppDetails(details);
  };

  const handleSelectChatApp = (appId: string | null) => {
    if (!appId) {
      setSelectedAppId(null);
      setChatInput('');
      setChatProgressLines([]);
      deliveredRunRepliesRef.current.clear();
      return;
    }

    setChatContext(appId);
  };

  const performInstall = async (appId: string) => {
    try {
      const desktopApi = getDesktopApi();
      const result = await desktopApi.installApp(appId, activeLocale);

      await refreshApps();

      if (result.success) {
        setBannerSeverity('success');
        setBannerMessage(result.userMessage || t.banners.installed(getAppMeta(appId).name));
        const welcome = await desktopApi.installWelcome(appId, activeLocale);
        if (welcome.success && welcome.message) {
          createInstallWelcomeConversation(appId, welcome.message);
          setSelectedAppId(appId);
          setCurrentView('chat');
        }
      } else {
        setBannerSeverity('error');
        setBannerMessage(result.userMessage);
        requestErrorReportFromResult('app', 'install', result, {
          appId,
          appVersion: installedApps.find((appEntry) => appEntry.id === appId)?.version,
        });
      }
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.settings.authErrorFallback);
      requestErrorReport({
        source: 'app',
        operation: 'install',
        message: error instanceof Error ? error.message : t.settings.authErrorFallback,
        technicalCode: 'install_unhandled_error',
        appId,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    }
  };

  const handleInstall = async (appId: string) => {
    try {
      const gate = await getDesktopApi().getAppToolsInstallGate(appId, activeLocale);
      if (gate) {
        setPendingInstallGate(gate);
        return;
      }
    } catch {
      // Installation still performs the authoritative main-process gate.
    }
    await performInstall(appId);
  };

  const handleConfirmInstallWithTools = async () => {
    if (!pendingInstallGate) {
      return;
    }
    if (!pendingInstallGate.canInstall) {
      setBannerSeverity('warning');
      setBannerMessage(t.installGate.missingRequiredTools);
      return;
    }
    setPendingInstallBusy(true);
    const appId = pendingInstallGate.appId;
    setPendingInstallGate(null);
    await performInstall(appId);
    setPendingInstallBusy(false);
  };

  const handleOptionalToolGrant = async (toolId: string, granted: boolean) => {
    if (!pendingInstallGate) {
      return;
    }
    const updated = await getDesktopApi().setAppToolGrant({ appId: pendingInstallGate.appId, toolId, granted }, activeLocale);
    if (updated) {
      setPendingInstallGate(updated);
    }
  };

  const renderInstallTool = (item: AppToolsInstallGate['required'][number] | AppToolsInstallGate['optional'][number], required: boolean) => {
    const configured = item.available && item.configured;
    const statusLabel = configured
      ? t.installGate.toolActive
      : item.available
        ? t.installGate.toolNeedsConfiguration
        : t.installGate.toolInactive;
    return (
      <Paper
        key={`${required ? 'required' : 'optional'}-${item.declaration.toolId}`}
        variant="outlined"
        sx={{ p: 1.5, borderRadius: 1, borderColor: 'divider', bgcolor: 'background.paper' }}
      >
        <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="flex-start">
          <Stack spacing={0.75} sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography fontWeight={700}>{item.tool?.name ?? item.declaration.toolId}</Typography>
              <Chip
                size="small"
                label={required ? t.installGate.requiredTool : t.installGate.optionalTool}
                sx={{ height: 24, fontWeight: 650, bgcolor: 'action.hover' }}
              />
              <Chip
                size="small"
                label={statusLabel}
                sx={{
                  height: 24,
                  fontWeight: 700,
                  color: configured ? 'success.main' : 'warning.main',
                  borderColor: configured ? 'success.main' : 'warning.main',
                  bgcolor: configured ? 'rgba(46, 125, 50, 0.12)' : 'rgba(237, 108, 2, 0.12)',
                }}
                variant="outlined"
              />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {item.declaration.reason}
            </Typography>
          </Stack>
          {required ? (
            !configured ? (
              <Button
                size="small"
                sx={{ flexShrink: 0 }}
                onClick={() => {
                  setPendingInstallGate(null);
                  setCurrentView('tools');
                }}
              >
                {t.installGate.openTools}
              </Button>
            ) : null
          ) : (
            <Switch
              checked={item.granted}
              disabled={!configured}
              onChange={(event) => void handleOptionalToolGrant(item.declaration.toolId, event.target.checked)}
            />
          )}
        </Stack>
      </Paper>
    );
  };

  const renderInstallItem = (item: AppAgent | AppPromptTemplate) => (
    <Paper key={item.id} variant="outlined" sx={{ p: 1.5, borderRadius: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
      <Stack spacing={0.5}>
        <Typography fontWeight={700}>{item.title}</Typography>
        {item.description ? (
          <Typography variant="body2" color="text.secondary">
            {item.description}
          </Typography>
        ) : null}
      </Stack>
    </Paper>
  );

  const handleUpdate = async (appId: string) => {
    try {
      const desktopApi = getDesktopApi();
      const result = await desktopApi.updateApp(appId, activeLocale);
      await refreshApps();
      setBannerSeverity(result.success ? 'success' : result.phase === 'conflict' ? 'warning' : 'error');
      setBannerMessage(result.userMessage);
      requestErrorReportFromResult('app', 'update', result, {
        appId,
        appVersion: installedApps.find((appEntry) => appEntry.id === appId)?.version,
        details: { phase: result.phase },
      });
      if (selectedAppDetailsId === appId) {
        setSelectedAppDetails(await desktopApi.getAppDetails(appId));
      }
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.settings.authErrorFallback);
      requestErrorReport({
        source: 'app',
        operation: 'update',
        message: error instanceof Error ? error.message : t.settings.authErrorFallback,
        technicalCode: 'update_unhandled_error',
        appId,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    }
  };

  const handleCreateBackup = async (appId: string) => {
    setBackupsBusy(true);
    try {
      const result = await getDesktopApi().createBackup({ appId, reason: 'manual' });
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      await refreshBackups();
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.sections.backups.createError);
      requestErrorReport({
        source: 'desktop',
        operation: 'backup.create',
        message: error instanceof Error ? error.message : t.sections.backups.createError,
        technicalCode: 'backup_create_unhandled_error',
        appId,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setBackupsBusy(false);
    }
  };

  const handleDeleteBackup = async (backup: AppBackupSummary) => {
    if (!window.confirm(t.sections.backups.deleteConfirm(backup.appName))) {
      return;
    }
    setBackupsBusy(true);
    try {
      const result = await getDesktopApi().deleteBackup({ appId: backup.appId, backupId: backup.backupId });
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      await refreshBackups();
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.sections.backups.loadError);
      requestErrorReport({
        source: 'desktop',
        operation: 'backup.delete',
        message: error instanceof Error ? error.message : t.sections.backups.loadError,
        technicalCode: 'backup_delete_unhandled_error',
        appId: backup.appId,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setBackupsBusy(false);
    }
  };

  const handleRestoreBackup = async (backup: AppBackupSummary) => {
    if (!window.confirm(t.sections.backups.restoreConfirm(backup.appName))) {
      return;
    }
    setBackupsBusy(true);
    try {
      const result = await getDesktopApi().restoreBackup({ appId: backup.appId, backupId: backup.backupId });
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      await Promise.all([refreshBackups(), refreshApps()]);
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.sections.backups.loadError);
      requestErrorReport({
        source: 'desktop',
        operation: 'backup.restore',
        message: error instanceof Error ? error.message : t.sections.backups.loadError,
        technicalCode: 'backup_restore_unhandled_error',
        appId: backup.appId,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setBackupsBusy(false);
    }
  };

  const openCloudUpsell = () => {
    setForgerAccountMessage(t.cloud.backupsUpsellBody);
    setCloudModalOpen(true);
  };

  const handleSyncNow = async (appId: string) => {
    setBackupsBusy(true);
    try {
      const result = await getDesktopApi().createRemoteBackup({ appId, backupType: 'sync_snapshot', source: 'manual' });
      if (result.technicalCode === 'cloud_account_required' || result.technicalCode === 'subscription_required') {
        openCloudUpsell();
      }
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      await refreshBackups();
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.sections.backups.cloudCreateError);
      requestErrorReport({
        source: 'desktop',
        operation: 'backup.sync_now',
        message: error instanceof Error ? error.message : t.sections.backups.cloudCreateError,
        technicalCode: 'remote_backup_sync_unhandled_error',
        appId,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setBackupsBusy(false);
    }
  };

  const handleDeleteRemoteBackup = async (backup: RemoteAppBackupSummary) => {
    if (!window.confirm(t.sections.backups.deleteConfirm(backup.appName))) {
      return;
    }
    setBackupsBusy(true);
    try {
      const result = await getDesktopApi().deleteRemoteBackup(backup.id);
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      await refreshBackups();
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.sections.backups.loadError);
      requestErrorReport({
        source: 'desktop',
        operation: 'backup.remote_delete',
        message: error instanceof Error ? error.message : t.sections.backups.loadError,
        technicalCode: 'remote_backup_delete_unhandled_error',
        appId: backup.appId,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setBackupsBusy(false);
    }
  };

  const handleRestoreRemoteBackup = async (backup: RemoteAppBackupSummary) => {
    if (!window.confirm(t.sections.backups.restoreConfirm(backup.appName))) {
      return;
    }
    setBackupsBusy(true);
    try {
      const result = await getDesktopApi().restoreRemoteBackup({ remoteBackupId: backup.id });
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      await Promise.all([refreshBackups(), refreshApps()]);
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.sections.backups.loadError);
      requestErrorReport({
        source: 'desktop',
        operation: 'backup.remote_restore',
        message: error instanceof Error ? error.message : t.sections.backups.loadError,
        technicalCode: 'remote_backup_restore_unhandled_error',
        appId: backup.appId,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setBackupsBusy(false);
    }
  };

  const handleSetAutoSync = async (appId: string, autoSync: boolean) => {
    try {
      const nextSettings = await getDesktopApi().setAppAutoSync(appId, autoSync);
      setCloudSyncSettings(nextSettings);
      setBannerSeverity('success');
      setBannerMessage(autoSync ? t.sections.backups.autoSyncEnabled : t.sections.backups.autoSyncDisabled);
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.sections.backups.loadError);
      requestErrorReport({
        source: 'desktop',
        operation: 'backup.auto_sync',
        message: error instanceof Error ? error.message : t.sections.backups.loadError,
        technicalCode: 'auto_sync_setting_unhandled_error',
        appId,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    }
  };

  const handleAgentToolApprovalChange = async (
    toolId: AgentToolDefinition['id'],
    requiresApproval: boolean,
  ) => {
    setAgentToolBusyId(toolId);
    setAgentToolError(null);
    setAgentToolErrorCode(null);
    try {
      const updated = await getDesktopApi().updateAgentToolApproval({ toolId, requiresApproval });
      setAgentToolSettings(updated);
    } catch (_error) {
      setAgentToolError(t.sections.tools.saveError);
      setAgentToolErrorCode(null);
    } finally {
      setAgentToolBusyId(null);
    }
  };

  const runOfficialToolAction = async (
    toolId: string,
    action: () => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>,
  ) => {
    setOfficialToolBusyId(toolId);
    setAgentToolError(null);
    setAgentToolErrorCode(null);
    try {
      const result = await action();
      await refreshOfficialTools();
      setBannerSeverity(result.success ? 'success' : 'error');
      const userMessage =
        !result.success && result.technicalCode === 'forger_account_required'
          ? t.sections.tools.gmailAccountRequired
          : result.userMessage;
      setBannerMessage(userMessage);
      if (!result.success) {
        setAgentToolError(userMessage);
        setAgentToolErrorCode(result.technicalCode ?? null);
      }
    } catch (_error) {
      setAgentToolError(t.sections.tools.saveError);
      setAgentToolErrorCode(null);
    } finally {
      setOfficialToolBusyId(null);
    }
  };

  const runDesktopUpdateAction = async (action: () => Promise<DesktopUpdateState>) => {
    setDesktopUpdateBusy(true);
    try {
      const state = await action();
      setDesktopUpdateState(state);
      if (state.userMessage) {
        setBannerSeverity(state.status === 'error' || state.status === 'unsupported' ? 'error' : 'info');
        setBannerMessage(state.userMessage);
      }
      if (state.status === 'error' && state.technicalCode) {
        requestErrorReport({
          source: 'update',
          operation: 'desktop-update',
          message: state.userMessage ?? state.technicalCode,
          technicalCode: state.technicalCode,
          details: { status: state.status, availableVersion: state.availableVersion },
        });
      }
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.settings.authErrorFallback);
      requestErrorReport({
        source: 'update',
        operation: 'desktop-update',
        message: error instanceof Error ? error.message : t.settings.authErrorFallback,
        technicalCode: 'desktop_update_unhandled_error',
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setDesktopUpdateBusy(false);
    }
  };

  const handleCreateMemory = async (input: MemoryCreateInput) => {
    try {
      const created = await getDesktopApi().memoryCreate(input);
      setMemories((current) => [created, ...current.filter((entry) => entry.id !== created.id)]);
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(error instanceof Error ? error.message : t.settings.memorySaveError);
    }
  };

  const handleUpdateMemory = async (input: MemoryUpdateInput) => {
    try {
      const updated = await getDesktopApi().memoryUpdate(input);
      setMemories((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(error instanceof Error ? error.message : t.settings.memorySaveError);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      await getDesktopApi().memoryDelete(id);
      setMemories((current) => current.filter((entry) => entry.id !== id));
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(error instanceof Error ? error.message : t.settings.memoryDeleteError);
    }
  };

  const handleAgentDefaultsChange = async (input: UpdateAgentDefaultsInput) => {
    setSettings((current) => {
      const nextDefaultProvider = input.defaultProvider ?? current.defaultAgentProvider;
      if (!input.provider) {
        return { ...current, defaultAgentProvider: nextDefaultProvider };
      }
      if (input.provider === 'codex') {
        const nextCodexDefaults = {
          model: input.model ?? current.agentDefaults.codex.model,
          reasoningEffort: (input.effort as CodexReasoningEffort | undefined) ?? current.agentDefaults.codex.reasoningEffort,
        };
        return {
          ...current,
          defaultAgentProvider: nextDefaultProvider,
          codexDefaults: nextCodexDefaults,
          agentDefaults: {
            ...current.agentDefaults,
            codex: nextCodexDefaults,
          },
        };
      }
      return {
        ...current,
        defaultAgentProvider: nextDefaultProvider,
        agentDefaults: {
          ...current.agentDefaults,
          claude: {
            model: input.model ?? current.agentDefaults.claude.model,
            effort: (input.effort as ClaudeEffort | undefined) ?? current.agentDefaults.claude.effort,
          },
        },
      };
    });
    try {
      const updated = await getDesktopApi().updateAgentDefaults(input);
      setSettings(updated);
      setSelectedCodexModel(updated.agentDefaults.codex.model);
      setSelectedCodexReasoningEffort(updated.agentDefaults.codex.reasoningEffort);
      setSelectedClaudeModel(updated.agentDefaults.claude.model);
      setSelectedClaudeEffort(updated.agentDefaults.claude.effort);
      if (selectedAppDetailsId) {
        setSelectedAppDetails(await getDesktopApi().getAppDetails(selectedAppDetailsId));
      }
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(error instanceof Error ? error.message : t.settings.authErrorFallback);
      void getDesktopApi().getSettings().then(setSettings).catch(() => undefined);
    }
  };

  const handleRestoreUserVersion = async (appId: string) => {
    const desktopApi = getDesktopApi();
    const result = await desktopApi.restoreAppUserVersion(appId);
    await refreshApps();
    setBannerSeverity(result.success ? 'success' : 'error');
    setBannerMessage(result.userMessage ?? t.settings.authErrorFallback);
    if (selectedAppDetailsId === appId) {
      setSelectedAppDetails(await desktopApi.getAppDetails(appId));
    }
  };

  const handleResolveConflict = async (appId: string) => {
    const desktopApi = getDesktopApi();
    const result = await desktopApi.resolveAppUpdateConflict(appId);
    if ('success' in result && !result.success) {
      setBannerSeverity('error');
      setBannerMessage(result.userMessage ?? t.settings.authErrorFallback);
      return;
    }
    setSelectedAppId(appId);
    setCurrentView('chat');
    setBannerSeverity('info');
    setBannerMessage(t.actions.resolveWithForger);
  };

  const handleOpen = async (appId: string) => {
    if (openingAppIdsRef.current.has(appId)) {
      return;
    }
    openingAppIdsRef.current = new Set(openingAppIdsRef.current).add(appId);
    setOpeningAppIds(new Set(openingAppIdsRef.current));

    const desktopApi = getDesktopApi();
    try {
      const result = await desktopApi.openApp(appId, activeLocale);

      if (result.success) {
        setBannerSeverity('success');
        setBannerMessage(result.userMessage);
      } else {
        setBannerSeverity('error');
        setBannerMessage(result.userMessage);
        requestErrorReportFromResult('app', 'open', result, {
          appId,
          appVersion: installedApps.find((appEntry) => appEntry.id === appId)?.version,
        });
      }
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.settings.authErrorFallback);
      requestErrorReport({
        source: 'app',
        operation: 'open',
        message: error instanceof Error ? error.message : t.settings.authErrorFallback,
        technicalCode: 'open_app_unhandled_error',
        appId,
        appVersion: installedApps.find((appEntry) => appEntry.id === appId)?.version,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      const nextOpeningAppIds = new Set(openingAppIdsRef.current);
      nextOpeningAppIds.delete(appId);
      openingAppIdsRef.current = nextOpeningAppIds;
      setOpeningAppIds(new Set(nextOpeningAppIds));
    }
  };

  const handleStop = async (appId: string) => {
    const desktopApi = getDesktopApi();
    const result = await desktopApi.stopApp(appId);

    if (result.success) {
      setBannerSeverity('info');
      setBannerMessage(result.userMessage);
    } else {
      setBannerSeverity('error');
      setBannerMessage(result.userMessage);
    }
  };

  const handleRetry = async (appId: string) => {
    await handleInstall(appId);
  };

  const refreshAppSecrets = async (appId: string) => {
    const desktopApi = getDesktopApi();
    const nextState = await desktopApi.getAppSecrets(appId);
    setAppSecretsState(nextState);
    setUserSecrets(nextState.userSecrets);
  };

  const refreshUserSecrets = async () => {
    const desktopApi = getDesktopApi();
    const nextSecrets = await desktopApi.listUserSecrets();
    setUserSecrets(nextSecrets);
  };

  const runSecretMutation = async (
    action: () => Promise<{ success: boolean; userMessage: string }>,
    targetAppId?: string | null,
  ) => {
    setSecretsBusy(true);
    try {
      const result = await action();
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      if (targetAppId) {
        await refreshAppSecrets(targetAppId);
      } else {
        await refreshUserSecrets();
      }
    } catch {
      setBannerSeverity('error');
      setBannerMessage('No pudimos actualizar los secretos.');
    } finally {
      setSecretsBusy(false);
    }
  };

  const handleCreateSecret = async (input: { name: string; value: string }) => {
    const desktopApi = getDesktopApi();
    await runSecretMutation(() => desktopApi.createUserSecret(input));
  };

  const handleUpdateSecret = async (input: { id: string; name: string; value?: string }) => {
    const desktopApi = getDesktopApi();
    await runSecretMutation(() => desktopApi.updateUserSecret(input));
  };

  const handleDeleteSecret = async (id: string) => {
    const desktopApi = getDesktopApi();
    await runSecretMutation(() => desktopApi.deleteUserSecret({ id }));
  };

  const handleConnectSecret = async (appSecretName: string, userSecretId: string) => {
    const targetAppId = selectedAppDetailsId;
    if (!targetAppId) {
      return;
    }
    const desktopApi = getDesktopApi();
    await runSecretMutation(() =>
      desktopApi.connectAppSecret({
        appId: targetAppId,
        appSecretName,
        userSecretId,
      }),
      targetAppId,
    );
  };

  const handleDisconnectSecret = async (appSecretName: string) => {
    const targetAppId = selectedAppDetailsId;
    if (!targetAppId) {
      return;
    }
    const desktopApi = getDesktopApi();
    await runSecretMutation(() =>
      desktopApi.disconnectAppSecret({
        appId: targetAppId,
        appSecretName,
      }),
      targetAppId,
    );
  };

  const handleDeleteApp = async (appId: string) => {
    const meta = getAppMeta(appId);
    const confirmed = window.confirm(t.appView.deleteConfirm(meta.name));
    if (!confirmed) {
      return;
    }

    const desktopApi = getDesktopApi();
    const result = await desktopApi.uninstallApp(appId);
    await refreshApps();
    if (selectedAppDetailsId === appId) {
      setSelectedAppDetails(null);
      setCurrentView('my-apps');
    }
    setBannerSeverity(result.success ? 'success' : 'error');
    setBannerMessage(result.userMessage);
  };

  const createInstallWelcomeConversation = (appId: string, message: string) => {
    const now = new Date().toISOString();
    const conversationId = makeConversationId();
    const appName = getAppMeta(appId).name;
    const conversation: ChatConversation = {
      id: conversationId,
      appId,
      title: `Bienvenida a ${appName}`,
      threadId: null,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: `assistant-install-welcome-${Date.now()}`,
          role: 'assistant',
          content: message,
          action: {
            type: 'open-app',
            appId,
            label: t.actions.open,
          },
        },
      ],
    };
    setChatConversations((current) => [conversation, ...current.filter((item) => !(item.appId === appId && item.title === conversation.title))]);
    setActiveConversationByApp((current) => ({ ...current, [appId]: conversationId }));
    setActiveConversationId(conversationId);
  };

  const handlePickChatFiles = async () => {
    const picked = await getDesktopApi().filesPickForChat();
    setPendingChatFiles((current) => {
      const seen = new Set(current.map((file) => file.sourcePath));
      return [...current, ...picked.filter((file) => !seen.has(file.sourcePath))];
    });
  };

  const discardStagedChatFiles = (files: PickedChatFile[]) => {
    const sourcePaths = files.filter((file) => file.staged).map((file) => file.sourcePath);
    if (sourcePaths.length > 0) {
      void getDesktopApi().filesDiscardStagedForChat({ sourcePaths });
    }
  };

  const handleStagePastedChatFile = async (input: Parameters<ReturnType<typeof getDesktopApi>['filesStageForChat']>[0]) => {
    const staged = await getDesktopApi().filesStageForChat(input);
    setPendingChatFiles((current) => {
      const seen = new Set(current.map((file) => file.sourcePath));
      return seen.has(staged.sourcePath) ? current : [...current, staged];
    });
  };

  const handleRemovePendingChatFile = (sourcePath: string) => {
    setPendingChatFiles((current) => {
      const removed = current.filter((file) => file.sourcePath === sourcePath);
      discardStagedChatFiles(removed);
      return current.filter((file) => file.sourcePath !== sourcePath);
    });
  };

  const handleMentionFile = (file: ForgerFileRecord) => {
    setMentionedChatFileIds((current) => current.includes(file.id) ? current : [...current, file.id]);
  };

  const openCreateCategoryDialog = (parentPath?: string, selectAfterCreate = false) => {
    void parentPath;
    setCategoryDialogSelectAfterCreate(selectAfterCreate);
    setCategoryDialogName('');
    setCategoryDialogOpen(true);
  };

  const handleCreateCategorySubmit = async () => {
    const name = categoryDialogName.trim();
    if (!name) {
      return;
    }
    const created = await getDesktopApi().filesCreateCategory({
      name,
    });
    setCategoryDialogOpen(false);
    setCategoryDialogName('');
    if (categoryDialogSelectAfterCreate) {
      setUploadCategoryPath(created.path);
    }
    await refreshFiles(fileFilters);
  };

  const openRenameCategoryDialog = (categoryPath: string) => {
    const category = fileCategories.find((item) => item.path === categoryPath);
    setRenameCategoryDialog({
      open: true,
      categoryPath,
      name: category?.name ?? categoryPath.split('/').pop() ?? categoryPath,
    });
  };

  const handleRenameCategorySubmit = async () => {
    const name = renameCategoryDialog.name.trim();
    if (!renameCategoryDialog.categoryPath || !name) {
      return;
    }
    const result = await getDesktopApi().filesRenameCategory({
      categoryPath: renameCategoryDialog.categoryPath,
      newName: name,
    });
    setRenameCategoryDialog({ open: false, categoryPath: '', name: '' });
    setBannerSeverity(result.success ? 'success' : 'error');
    setBannerMessage(result.userMessage ?? result.technicalCode ?? t.settings.authErrorFallback);
    await refreshFiles(fileFilters);
  };

  const handleDeleteCategory = async (categoryPath: string) => {
    if (!window.confirm(t.sections.files.deleteCategoryConfirm)) {
      return;
    }
    const result = await getDesktopApi().filesDeleteCategory({ categoryPath, mode: 'emptyOnly' });
    setBannerSeverity(result.success ? 'success' : 'error');
    setBannerMessage(result.userMessage ?? result.technicalCode ?? t.settings.authErrorFallback);
    await refreshFiles(fileFilters);
  };

  const openRenameFileDialog = (file: ForgerFileRecord) => {
    setRenameFileDialog({ open: true, file, name: file.name });
  };

  const handleRenameFileSubmit = async () => {
    const file = renameFileDialog.file;
    const name = renameFileDialog.name.trim();
    if (!file || !name) {
      return;
    }
    await getDesktopApi().filesRename({ fileId: file.id, name });
    setRenameFileDialog({ open: false, file: null, name: '' });
    await refreshFiles(fileFilters);
  };

  const openMoveFileDialog = (file: ForgerFileRecord) => {
    setMoveFileDialog({ open: true, file, categoryPath: file.categoryPath });
  };

  const handleMoveFileSubmit = async () => {
    const file = moveFileDialog.file;
    if (!file) {
      return;
    }
    await getDesktopApi().filesMove({ fileIds: [file.id], categoryPath: moveFileDialog.categoryPath });
    setMoveFileDialog({ open: false, file: null, categoryPath: '' });
    await refreshFiles(fileFilters);
  };

  const handleDeleteFile = async (file: ForgerFileRecord) => {
    if (!window.confirm(t.sections.files.deleteFileConfirm)) {
      return;
    }
    await getDesktopApi().filesDelete({ fileIds: [file.id] });
    setMentionedChatFileIds((current) => current.filter((id) => id !== file.id));
    await refreshFiles(fileFilters);
  };

  const handleSendMessage = async (nextMessage?: string) => {
    const trimmed = (nextMessage ?? chatInput).trim();
    const sharedFileNames = [
      ...pendingChatFiles.map((file) => file.name),
      ...mentionedChatFiles.map((file) => file.name),
    ];
    const userVisibleContent = trimmed || `Archivos compartidos: ${sharedFileNames.join(', ')}`;

    const hasAgentProvider = codexAuthStatus.authenticated || claudeAuthStatus.authenticated;
    if ((!trimmed && pendingChatFiles.length === 0 && mentionedChatFileIds.length === 0) || chatRunActive || !hasAgentProvider) {
      if (!hasAgentProvider) {
        setAgentProviderConfigOpen(true);
      }
      return;
    }

    const chatScopeId = selectedAppId ?? FREE_CHAT_APP_ID;
    let targetConversationId = activeConversationId;
    let createdRuntime: ChatConversation['runtime'] | undefined;
    if (!targetConversationId) {
      const now = new Date().toISOString();
      const draft = resolveChatRuntimeDraft(
        resolvedChatProvider,
        selectedCodexModel,
        selectedCodexReasoningEffort,
        selectedClaudeModel,
        selectedClaudeEffort,
      );
      createdRuntime = { provider: draft.provider, model: draft.model, effort: draft.effort };
      const createdConversation: ChatConversation = {
        id: makeConversationId(),
        appId: chatScopeId,
        title: summarizeConversationTitle(userVisibleContent),
        threadId: null,
        ...(createdRuntime ? { runtime: createdRuntime } : {}),
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      targetConversationId = createdConversation.id;
      setChatConversations((current) => [createdConversation, ...current]);
      setActiveConversationId(createdConversation.id);
      setActiveConversationByApp((current) => ({ ...current, [chatScopeId]: createdConversation.id }));
    }

    const conversationForRun = chatConversations.find((conversation) => conversation.id === targetConversationId);
    const lockedRuntime = conversationForRun?.runtime ?? createdRuntime;
    const runtimeDraft = lockedRuntime
      ? {
          provider: lockedRuntime.provider,
          model: lockedRuntime.model,
          effort: lockedRuntime.effort,
          ...(lockedRuntime.provider === 'codex' ? { reasoningEffort: lockedRuntime.effort as CodexReasoningEffort } : {}),
        }
      : resolveChatRuntimeDraft(
          resolvedChatProvider,
          selectedCodexModel,
          selectedCodexReasoningEffort,
          selectedClaudeModel,
          selectedClaudeEffort,
        );
    setActiveConversationByApp((current) => ({ ...current, [chatScopeId]: targetConversationId as string }));
    setChatRunActive(true);
    activeRunConversationIdRef.current = targetConversationId;

    try {
      const desktopApi = getDesktopApi();
      const stagedFilesForCleanup = pendingChatFiles.filter((file) => file.staged);
      const importedFiles = pendingChatFiles.length > 0
        ? await desktopApi.filesImport({
            sourcePaths: pendingChatFiles.map((file) => file.sourcePath),
            categoryPath: uploadCategoryPath,
            ...(selectedAppId ? { appId: selectedAppId } : {}),
          })
        : [];
      discardStagedChatFiles(stagedFilesForCleanup);
      const mentionedFilesForRun = forgerFiles.filter((file) => mentionedChatFileIds.includes(file.id));
      const sharedFiles: SharedFileRef[] = [
        ...importedFiles.map((file) => ({
          id: file.id,
          path: file.relativePath,
          name: file.name,
          relativePath: file.relativePath,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          source: 'attached' as const,
        })),
        ...mentionedFilesForRun.map((file) => ({
          id: file.id,
          path: file.relativePath,
          name: file.name,
          relativePath: file.relativePath,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          source: 'mentioned' as const,
        })),
      ];
      const messageFiles: NonNullable<ChatMessage['files']> = sharedFiles.map((file) => ({
        id: file.id ?? file.path,
        name: file.name ?? file.path.split('/').pop() ?? file.path,
        relativePath: file.relativePath ?? file.path,
        displayPath: `${FORGER_DATA_ROOT_NAME}/${file.relativePath ?? file.path}`,
        sizeBytes: file.sizeBytes ?? 0,
        source: file.source ?? 'mentioned',
      }));
      const refreshedFiles = await desktopApi.filesList(fileFilters);
      setForgerFiles(refreshedFiles);
      setChatInput('');
      setPendingChatFiles([]);
      setMentionedChatFileIds([]);
      const now = new Date().toISOString();
      setChatConversations((currentConversations) =>
        currentConversations.map((conversation) => {
          if (conversation.id !== targetConversationId) {
            return conversation;
          }
          const nextTitle =
            (conversation.title === 'Conversacion nueva' || conversation.title === t.sections.chat.newConversationTitle) &&
              conversation.messages.length === 0
              ? summarizeConversationTitle(userVisibleContent, t.sections.chat.newConversationTitle)
              : conversation.title;
          return {
            ...conversation,
            title: nextTitle,
            updatedAt: now,
            runtime: conversation.runtime ?? (
              runtimeDraft.provider && runtimeDraft.model && runtimeDraft.effort
                ? {
                    provider: runtimeDraft.provider,
                    model: runtimeDraft.model,
                    effort: runtimeDraft.effort,
                  }
                : undefined
            ),
            messages: [
              ...conversation.messages,
              {
                id: `user-${Date.now()}`,
                role: 'user',
                content: userVisibleContent,
                files: messageFiles,
              },
            ],
          };
        }),
      );
      const startResult = await desktopApi.chatStartRun({
        appId: selectedAppId ?? undefined,
        prompt: trimmed || 'Review the shared files in this message.',
        threadId: conversationForRun?.threadId ?? null,
        conversationHistory: [
          ...(conversationForRun?.messages ?? []).map((message) => ({
            role: message.role,
            content: message.content,
          })),
          {
            role: 'user',
            content: userVisibleContent,
          },
        ],
        userLanguage: activeLocale,
        sharedFiles,
        ...runtimeDraft,
        conversationId: targetConversationId,
      });
      runConversationIdByRunRef.current.set(startResult.runId, targetConversationId);
    } catch (error) {
      setChatRunActive(false);
      activeRunConversationIdRef.current = null;
      const detail = error instanceof Error ? error.message : t.settings.authErrorFallback;
      const friendly =
        /another_run_in_progress/i.test(detail)
          ? t.sections.chat.sendInProgress
          : t.sections.chat.sendFailed(detail);
      setChatConversations((currentConversations) =>
        currentConversations.map((conversation) => {
          if (conversation.id !== targetConversationId) {
            return conversation;
          }
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            messages: [
              ...conversation.messages,
              {
                id: `assistant-error-${Date.now()}`,
                role: 'assistant',
                content: friendly,
              },
            ],
          };
        }),
      );
      requestErrorReport({
        source: 'agent',
        operation: 'chat.start-run',
        message: detail,
        technicalCode: 'chat_start_run_failed',
        appId: selectedAppId ?? undefined,
        appVersion: installedApps.find((appEntry) => appEntry.id === selectedAppId)?.version,
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    }
  };

  const handleRespondPermission = async (
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => {
    console.info('[Forger permission] user decision', { runId, requestId, decision });
    const result = await getDesktopApi().chatApprovePermission({ runId, requestId, decision });
    if (!result.success) {
      console.warn('[Forger permission] decision was rejected by main process', { runId, requestId, decision });
      setBannerSeverity('error');
      setBannerMessage(t.settings.authErrorFallback);
      setChatConversations((currentConversations) =>
        currentConversations.map((conversation) => ({
          ...conversation,
          messages: conversation.messages.map((message) => {
            if (
              message.action?.type === 'permission' &&
              message.action.runId === runId &&
              message.action.request.requestId === requestId
            ) {
              return {
                ...message,
                action: {
                  ...message.action,
                  status: 'pending',
                },
              };
            }
            return message;
          }),
        })),
      );
      return;
    }
    setChatConversations((currentConversations) =>
      currentConversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => {
          if (
            message.action?.type === 'permission' &&
            message.action.runId === runId &&
            message.action.request.requestId === requestId
          ) {
            return {
              ...message,
              action: {
                ...message.action,
                status: decision === 'allow' ? 'approved' : 'denied',
              },
            };
          }
          return message;
        }),
      })),
    );
  };

  const handleOpenConversation = (conversationId: string) => {
    const target = chatConversations.find((conversation) => conversation.id === conversationId);
    if (!target) {
      return;
    }
    setSelectedAppId(target.appId === FREE_CHAT_APP_ID ? null : target.appId);
    setCurrentView('chat');
    setActiveConversationId(target.id);
    setActiveConversationByApp((current) => ({ ...current, [target.appId]: target.id }));
    setChatProgressLines([]);
    deliveredRunRepliesRef.current.clear();
  };

  const handleDeleteConversation = (conversationId: string) => {
    setChatConversations((currentConversations) =>
      currentConversations.filter((conversation) => conversation.id !== conversationId),
    );
    setActiveConversationByApp((current) => {
      const next = { ...current };
      for (const [appId, mappedConversationId] of Object.entries(next)) {
        if (mappedConversationId === conversationId) {
          delete next[appId];
        }
      }
      return next;
    });
    if (activeConversationId === conversationId) {
      setActiveConversationId(null);
    }
    if (activeRunConversationIdRef.current === conversationId) {
      activeRunConversationIdRef.current = null;
    }
  };

  const handleStartNewConversation = () => {
    const chatScopeId = selectedAppId ?? FREE_CHAT_APP_ID;
    const now = new Date().toISOString();
    const nextConversation: ChatConversation = {
      id: makeConversationId(),
      appId: chatScopeId,
      title: t.sections.chat.newConversationTitle,
      threadId: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    setChatConversations((current) => [nextConversation, ...current]);
    setActiveConversationId(nextConversation.id);
    setActiveConversationByApp((current) => ({ ...current, [chatScopeId]: nextConversation.id }));
    setChatInput('');
    discardStagedChatFiles(pendingChatFiles);
    setPendingChatFiles([]);
    setMentionedChatFileIds([]);
    setChatProgressLines([]);
    deliveredRunRepliesRef.current.clear();
  };

  const handleSelectAutomation = (automationId: string) => {
    setSelectedAutomationId(automationId);
    void loadAutomationRuns(automationId);
  };

  const handleSelectAutomationRun = async (runId: string) => {
    const run = await getDesktopApi().automationsGetRunTranscript(runId);
    setSelectedAutomationRun(run);
  };

  const handleSaveAutomation = async (input: AutomationUpsertInput & { id?: string }) => {
    setAutomationBusy(true);
    try {
      const desktopApi = getDesktopApi();
      const saved = input.id
        ? await desktopApi.automationsUpdate({ ...input, id: input.id })
        : await desktopApi.automationsCreate(input);
      const nextAutomations = await refreshAutomations();
      setSelectedAutomationId(saved.id);
      await loadAutomationRuns(saved.id);
      setBannerSeverity('success');
      setBannerMessage(saved.enabled ? 'Automatizacion guardada y activa.' : 'Automatizacion guardada pausada.');
      if (nextAutomations.length === 0) {
        setAutomations([saved]);
      }
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(error instanceof Error ? error.message : t.settings.authErrorFallback);
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleDeleteAutomation = async (automationId: string) => {
    if (!window.confirm(t.sections.automations.deleteConfirm)) {
      return;
    }
    setAutomationBusy(true);
    try {
      const result = await getDesktopApi().automationsDelete(automationId);
      const nextAutomations = await refreshAutomations();
      const nextSelectedId = nextAutomations[0]?.id ?? null;
      setSelectedAutomationId(nextSelectedId);
      setAutomationRuns([]);
      setSelectedAutomationRun(null);
      if (nextSelectedId) {
        await loadAutomationRuns(nextSelectedId);
      }
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage ?? result.technicalCode ?? t.settings.authErrorFallback);
    } finally {
      setAutomationBusy(false);
    }
  };

  const handlePauseAutomation = async (automationId: string) => {
    setAutomationBusy(true);
    try {
      await getDesktopApi().automationsPause(automationId);
      await refreshAutomations();
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleResumeAutomation = async (automationId: string) => {
    setAutomationBusy(true);
    try {
      await getDesktopApi().automationsResume(automationId);
      await refreshAutomations();
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleRunAutomationNow = async (automationId: string) => {
    setAutomationBusy(true);
    try {
      const run = await getDesktopApi().automationsRunNow(automationId);
      setSelectedAutomationId(automationId);
      await loadAutomationRuns(automationId, run.id);
      setBannerSeverity(run.status === 'skipped' ? 'warning' : 'info');
      setBannerMessage(run.status === 'skipped' ? 'Ya hay un run activo para esta automatizacion.' : 'Run manual iniciado.');
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(error instanceof Error ? error.message : t.settings.authErrorFallback);
    } finally {
      setAutomationBusy(false);
    }
  };

  const refreshCodexAuthStatus = async () => {
    const desktopApi = getDesktopApi();
    const nextStatus = await desktopApi.getCodexAuthStatus();
    setCodexAuthStatus(nextStatus);
  };

  const refreshClaudeAuthStatus = async () => {
    const desktopApi = getDesktopApi();
    const nextStatus = await desktopApi.getClaudeAuthStatus();
    setClaudeAuthStatus(nextStatus);
  };

  const handleConnectCodexAuth = async () => {
    setCodexAuthBusy(true);
    try {
      const desktopApi = getDesktopApi();
      const result = await desktopApi.connectCodexAuth();
      setBannerSeverity(result.success ? 'info' : 'error');
      setBannerMessage(result.userMessage);
      requestErrorReportFromResult('agent', 'codex-connect', result);
      await refreshCodexAuthStatus();
      setAgentProviderConfigOpen(false);
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.settings.codexConnectError);
      requestErrorReport({
        source: 'agent',
        operation: 'codex-connect',
        message: error instanceof Error ? error.message : t.settings.codexConnectError,
        technicalCode: 'codex_connect_unhandled_error',
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setCodexAuthBusy(false);
    }
  };

  const handleConnectClaudeAuth = async () => {
    setCodexAuthBusy(true);
    try {
      const result = await getDesktopApi().connectClaudeAuth();
      setBannerSeverity(result.success ? 'info' : 'error');
      setBannerMessage(result.userMessage);
      if (result.status) {
        setClaudeAuthStatus(result.status);
      } else {
        await refreshClaudeAuthStatus();
      }
      setAgentProviderConfigOpen(false);
      requestErrorReportFromResult('agent', 'claude-connect', result);
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage('No pudimos iniciar la conexion con Claude Code.');
      requestErrorReport({
        source: 'agent',
        operation: 'claude-connect',
        message: error instanceof Error ? error.message : 'No pudimos iniciar la conexion con Claude Code.',
        technicalCode: 'claude_connect_unhandled_error',
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setCodexAuthBusy(false);
    }
  };

  const handleReinstallClaude = async () => {
    setCodexAuthBusy(true);
    try {
      const result = await getDesktopApi().reinstallClaude();
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      if (result.status) {
        setClaudeAuthStatus(result.status);
      } else {
        await refreshClaudeAuthStatus();
      }
      requestErrorReportFromResult('agent', 'claude-reinstall', result);
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage('No pudimos instalar Claude Code.');
      requestErrorReport({
        source: 'agent',
        operation: 'claude-reinstall',
        message: error instanceof Error ? error.message : 'No pudimos instalar Claude Code.',
        technicalCode: 'claude_reinstall_unhandled_error',
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setCodexAuthBusy(false);
    }
  };

  const handleReinstallCodex = async () => {
    setCodexAuthBusy(true);
    try {
      const desktopApi = getDesktopApi();
      const result = await desktopApi.reinstallCodex();
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      if (result.status) {
        setCodexAuthStatus(result.status);
      } else {
        await refreshCodexAuthStatus();
      }
      requestErrorReportFromResult('agent', 'codex-reinstall', result);
    } catch (error) {
      setBannerSeverity('error');
      setBannerMessage(t.settings.codexReinstallError);
      requestErrorReport({
        source: 'agent',
        operation: 'codex-reinstall',
        message: error instanceof Error ? error.message : t.settings.codexReinstallError,
        technicalCode: 'codex_reinstall_unhandled_error',
        sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined },
      });
    } finally {
      setCodexAuthBusy(false);
    }
  };

  const handleForgerLogin = async (email: string, password: string) => {
    setForgerAccountBusy(true);
    try {
      const result = await getDesktopApi().loginForgerAccount({ email, password, locale: t.locale });
      setForgerAccount(result);
      setForgerAccountMessage(result.success ? null : result.userMessage ?? null);
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.success ? t.cloud.loginSuccess : result.userMessage ?? t.settings.authErrorFallback);
      if (result.success) {
        void refreshBackups();
      }
      if (result.success) {
        setCloudModalOpen(false);
      }
      await refreshApps();
    } catch {
      setBannerSeverity('error');
      setBannerMessage(t.settings.authErrorFallback);
    } finally {
      setForgerAccountBusy(false);
    }
  };

  const closeErrorReportDialog = () => {
    if (errorReportDialog.busy) {
      return;
    }
    setErrorReportDialog({ open: false, report: null, busy: false });
  };

  const copyErrorReportDetails = async () => {
    if (!errorReportDialog.report) {
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(errorReportDialog.report, null, 2));
    setErrorReportDialog((current) => ({ ...current, userMessage: t.settings.errorReportCopied }));
  };

  const submitErrorReport = async () => {
    if (!errorReportDialog.report) {
      return;
    }
    setErrorReportDialog((current) => ({ ...current, busy: true, userMessage: undefined }));
    try {
      const result = await getDesktopApi().submitDesktopErrorReport(errorReportDialog.report);
      if (result.success) {
        setBannerSeverity('success');
        setBannerMessage(result.userMessage || t.settings.errorReportSent);
        setErrorReportDialog({ open: false, report: null, busy: false });
        return;
      }
      setErrorReportDialog((current) => ({
        ...current,
        busy: false,
        userMessage: result.userMessage || t.settings.errorReportSendError,
      }));
    } catch {
      setErrorReportDialog((current) => ({
        ...current,
        busy: false,
        userMessage: t.settings.errorReportSendError,
      }));
    }
  };

  const handleForgerRegister = async (input: ForgerAccountRegisterInput) => {
    setForgerAccountBusy(true);
    try {
      const result = await getDesktopApi().registerForgerAccount({ ...input, locale: t.locale });
      setForgerAccount(result);
      setForgerAccountMessage(result.userMessage ?? null);
      setBannerSeverity(result.success ? 'info' : 'error');
      setBannerMessage(result.userMessage ?? t.settings.authErrorFallback);
      return result.success;
    } catch {
      setBannerSeverity('error');
      setBannerMessage(t.settings.authErrorFallback);
      return false;
    } finally {
      setForgerAccountBusy(false);
    }
  };

  const handleForgerLogout = async () => {
    setForgerAccountBusy(true);
    try {
      const result = await getDesktopApi().logoutForgerAccount();
      setForgerAccount(result);
      setRemoteBackups([]);
      setRemoteBackupsUsage(initialRemoteBackupsUsage);
      setForgerAccountMessage(null);
      await refreshApps();
    } finally {
      setForgerAccountBusy(false);
    }
  };

  const handleSubmitRating = async (input: SubmitAppRatingInput) => {
    const result = await getDesktopApi().submitAppRating({ ...input, locale: t.locale });
    setBannerSeverity(result.success ? 'success' : 'error');
    setBannerMessage(result.userMessage ?? t.settings.authErrorFallback);
    await refreshApps();
    if (selectedAppDetailsId) {
      setSelectedAppDetails(await getDesktopApi().getAppDetails(selectedAppDetailsId));
    }
    return result;
  };

  const handleSubmitFeedback = async (input: SubmitAppFeedbackInput) => {
    const result = await getDesktopApi().submitAppFeedback({ ...input, locale: t.locale });
    setBannerSeverity(result.success ? 'success' : 'error');
    setBannerMessage(result.userMessage ?? t.settings.authErrorFallback);
    return result;
  };

  const handleUpdateAppPrompt = async (input: AppPromptReviewInput) => {
    const result = await getDesktopApi().updateAppPrompt(input);
    setBannerSeverity(result.success ? 'success' : 'error');
    setBannerMessage(result.userMessage ?? t.appView.promptErrorFallback);
    if (selectedAppDetailsId) {
      setSelectedAppDetails(await getDesktopApi().getAppDetails(selectedAppDetailsId));
    }
    return result;
  };

  const handleRestoreAppPrompt = async (input: AppPromptRestoreInput) => {
    const result = await getDesktopApi().restoreAppPrompt(input);
    setBannerSeverity(result.success ? 'success' : 'error');
    setBannerMessage(result.userMessage ?? t.appView.promptErrorFallback);
    if (selectedAppDetailsId) {
      setSelectedAppDetails(await getDesktopApi().getAppDetails(selectedAppDetailsId));
    }
    return result;
  };

  const resolvedMode = resolveThemeMode(themePreference, prefersDark);
  const theme = useMemo(() => buildAppTheme(resolvedMode), [resolvedMode]);
  const handleOpenFriendChat = async (friendship: CloudFriendship) => await getDesktopApi().openFriendChatWindow(friendship);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {socialChatWindowRoute ? (
        <FriendChatWindowView
          account={forgerAccount}
          friendUserId={socialChatWindowRoute.friendUserId}
          friendUsername={socialChatWindowRoute.friendUsername}
          friendDisplayName={socialChatWindowRoute.friendDisplayName}
        />
      ) : (
        <AppShell
          currentView={currentView}
          onNavigate={setCurrentView}
          t={t}
          chatApps={installedApps}
          selectedChatAppId={selectedAppId}
          dataApps={installedApps.filter((a) => a.status === 'installed' || a.status === 'running')}
          selectedDataAppId={selectedDataAppId}
          getAppMeta={getAppMeta}
          onSelectChatApp={handleSelectChatApp}
          onSelectDataApp={setSelectedDataAppId}
          onOpenCloudModal={() => setCloudModalOpen(true)}
          account={forgerAccount}
          accountBusy={forgerAccountBusy}
          onOpenFriendChat={(friendship) => handleOpenFriendChat(friendship)}
          onSocialNotify={(message, severity = 'info') => {
            setBannerSeverity(severity);
            setBannerMessage(message);
          }}
          onLogout={() => void handleForgerLogout()}
          desktopUpdateState={desktopUpdateState}
        >
        {currentView === 'my-apps' ? (
          <InstalledAppsView
            apps={installedApps}
            openingAppIds={openingAppIds}
            t={t}
            getAppMeta={getAppMeta}
            getCategoryLabel={getCategoryLabel}
            onOpen={handleOpen}
            onStop={handleStop}
            onRetry={handleRetry}
            onUpdate={(appId) => void handleUpdate(appId)}
            onRestoreUserVersion={(appId) => void handleRestoreUserVersion(appId)}
            onResolveConflict={(appId) => void handleResolveConflict(appId)}
            onDetails={(appId) => void openAppDetails(appId, 'my-apps')}
            onDelete={(appId) => void handleDeleteApp(appId)}
            onGoCatalog={() => setCurrentView('catalog')}
            installProgressByApp={installProgressByApp}
          />
        ) : null}

        {currentView === 'catalog' ? (
          <CatalogView
            apps={catalogApps}
            openingAppIds={openingAppIds}
            filter={catalogFilter}
            onFilterChange={setCatalogFilter}
            statusFilter={catalogStatusFilter}
            onStatusFilterChange={setCatalogStatusFilter}
            onInstall={handleInstall}
            onUpdate={(appId) => void handleUpdate(appId)}
            onOpen={handleOpen}
            onStop={handleStop}
            onRetry={handleRetry}
            onRestoreUserVersion={(appId) => void handleRestoreUserVersion(appId)}
            onResolveConflict={(appId) => void handleResolveConflict(appId)}
            onDetails={(appId) => void openAppDetails(appId, 'catalog')}
            onDelete={(appId) => void handleDeleteApp(appId)}
            t={t}
            getAppMeta={getAppMeta}
            getCategoryLabel={getCategoryLabel}
            installProgressByApp={installProgressByApp}
          />
        ) : null}

        {currentView === 'app' ? (
          <AppView
            details={selectedAppDetails}
            openingAppIds={openingAppIds}
            installProgress={selectedAppDetailsId ? installProgressByApp[selectedAppDetailsId] : undefined}
            t={t}
            categoryLabel={selectedAppDetails ? getCategoryLabel(selectedAppDetails.app.category) : ''}
            appSecretsState={appSecretsState}
            secretsBusy={secretsBusy}
            account={forgerAccount}
            modelOptions={CODEX_MODEL_OPTIONS}
            reasoningOptions={CODEX_REASONING_OPTIONS}
            codexDefaults={settings.codexDefaults}
            onBack={() => setCurrentView(appDetailsBackView)}
            onInstall={(appId) => void handleInstall(appId)}
            onUpdate={(appId) => void handleUpdate(appId)}
            onOpen={(appId) => void handleOpen(appId)}
            onStop={(appId) => void handleStop(appId)}
            onRestoreUserVersion={(appId) => void handleRestoreUserVersion(appId)}
            onResolveConflict={(appId) => void handleResolveConflict(appId)}
            onConnectSecret={handleConnectSecret}
            onDisconnectSecret={handleDisconnectSecret}
            onDelete={(appId) => void handleDeleteApp(appId)}
            onOpenAccount={() => setCloudModalOpen(true)}
            onSubmitRating={handleSubmitRating}
            onSubmitFeedback={handleSubmitFeedback}
            onUpdatePrompt={handleUpdateAppPrompt}
            onRestorePrompt={handleRestoreAppPrompt}
          />
        ) : null}

        {currentView === 'chat' ? (
          <ChatView
            t={t}
            messages={chatMessages}
            conversationTitle={t.sections.chat.introTitle}
            activeConversationId={activeConversationId}
            historyItems={chatHistoryItems}
            onOpenConversation={handleOpenConversation}
            onDeleteConversation={handleDeleteConversation}
            onStartNewConversation={handleStartNewConversation}
            inputValue={chatInput}
            onInputChange={setChatInput}
            onSend={() => void handleSendMessage()}
            pendingFiles={pendingChatFiles}
            mentionedFiles={mentionedChatFiles}
            availableFiles={forgerFiles}
            fileCategories={fileCategories}
            uploadCategoryPath={uploadCategoryPath}
            onUploadCategoryChange={setUploadCategoryPath}
            onPickFiles={() => void handlePickChatFiles()}
            onStagePastedFile={handleStagePastedChatFile}
            onCreateUploadCategory={() => openCreateCategoryDialog(undefined, true)}
            onRemovePendingFile={handleRemovePendingChatFile}
            onMentionFile={handleMentionFile}
            onRemoveMentionedFile={(fileId) => setMentionedChatFileIds((current) => current.filter((id) => id !== fileId))}
            providerOptions={AGENT_PROVIDER_OPTIONS}
            selectedProvider={activeConversation?.runtime?.provider ?? selectedAgentProvider}
            resolvedProviderForAuto={resolvedChatProvider}
            onSelectProvider={setSelectedAgentProvider}
            providerLocked={Boolean(activeConversation?.runtime || activeConversation?.threadId || activeConversation?.messages.length)}
            modelOptions={CODEX_MODEL_OPTIONS}
            selectedModel={activeConversation?.runtime?.provider === 'codex' ? activeConversation.runtime.model : selectedCodexModel}
            onSelectModel={setSelectedCodexModel}
            reasoningOptions={CODEX_REASONING_OPTIONS}
            selectedReasoningEffort={activeConversation?.runtime?.provider === 'codex' ? activeConversation.runtime.effort as CodexReasoningEffort : selectedCodexReasoningEffort}
            onSelectReasoningEffort={setSelectedCodexReasoningEffort}
            claudeModelOptions={CLAUDE_MODEL_OPTIONS}
            selectedClaudeModel={activeConversation?.runtime?.provider === 'claude' ? activeConversation.runtime.model : selectedClaudeModel}
            onSelectClaudeModel={setSelectedClaudeModel}
            claudeEffortOptions={CLAUDE_EFFORT_OPTIONS}
            selectedClaudeEffort={activeConversation?.runtime?.provider === 'claude' ? activeConversation.runtime.effort as ClaudeEffort : selectedClaudeEffort}
            onSelectClaudeEffort={setSelectedClaudeEffort}
            onOpenCodexUsageDashboard={() => void getDesktopApi().openCodexUsageDashboard()}
            assistantAvatarSrc={chatBotPictureSrc}
            isSending={chatRunActive}
            progressLines={chatProgressLines}
            codexConfigured={codexAuthStatus.authenticated || claudeAuthStatus.authenticated}
            onConfigureCodex={() => setAgentProviderConfigOpen(true)}
            openingAppIds={openingAppIds}
            onOpenApp={(appId) => void handleOpen(appId)}
            onRespondPermission={handleRespondPermission}
          />
        ) : null}

        {currentView === 'automations' ? (
          <AutomationsView
            t={t}
            apps={installedApps.filter((a) => a.status === 'installed' || a.status === 'running')}
            automations={automations}
            selectedAutomationId={selectedAutomationId}
            runs={automationRuns}
            selectedRun={selectedAutomationRun}
            busy={automationBusy}
            getAppMeta={getAppMeta}
            onSave={(input) => void handleSaveAutomation(input)}
            onDelete={(id) => void handleDeleteAutomation(id)}
            onPause={(id) => void handlePauseAutomation(id)}
            onResume={(id) => void handleResumeAutomation(id)}
            onRunNow={(id) => void handleRunAutomationNow(id)}
            onSelectAutomation={handleSelectAutomation}
            onSelectRun={(runId) => void handleSelectAutomationRun(runId)}
          />
        ) : null}

        {currentView === 'files' ? (
          <FilesView
            t={t}
            files={forgerFiles}
            categories={fileCategories}
            filters={fileFilters}
            onFiltersChange={setFileFilters}
            onCreateCategory={() => openCreateCategoryDialog()}
            onRenameCategory={openRenameCategoryDialog}
            onDeleteCategory={(categoryPath) => void handleDeleteCategory(categoryPath)}
            onRenameFile={openRenameFileDialog}
            onMoveFile={openMoveFileDialog}
            onDeleteFile={(file) => void handleDeleteFile(file)}
          />
        ) : null}

        {currentView === 'backups' ? (
          <BackupsView
            backups={backups}
            remoteBackups={remoteBackups}
            remoteBackupsUsage={remoteBackupsUsage}
            apps={installedApps}
            account={forgerAccount}
            cloudSyncSettings={cloudSyncSettings}
            busy={backupsBusy}
            t={t}
            onCreateBackup={(appId) => void handleCreateBackup(appId)}
            onSyncNow={(appId) => void handleSyncNow(appId)}
            onDeleteBackup={(backup) => void handleDeleteBackup(backup)}
            onDeleteRemoteBackup={(backup) => void handleDeleteRemoteBackup(backup)}
            onRestoreBackup={(backup) => void handleRestoreBackup(backup)}
            onRestoreRemoteBackup={(backup) => void handleRestoreRemoteBackup(backup)}
            onSetAutoSync={(appId, autoSync) => void handleSetAutoSync(appId, autoSync)}
            onRequireCloud={openCloudUpsell}
          />
        ) : null}

        {currentView === 'devices' ? (
          <DevicesView account={forgerAccount} t={t} />
        ) : null}

        {currentView === 'datos' ? (
          <DataView
            t={t}
            selectedAppId={selectedDataAppId}
            onDbListTables={(appId) => getDesktopApi().dbListTables(appId)}
            onDbQueryTable={(appId, tableName, limit) => getDesktopApi().dbQueryTable(appId, tableName, limit)}
          />
        ) : null}

        {currentView === 'secrets' ? (
          <SecretsView
            secrets={userSecrets}
            busy={secretsBusy}
            t={t}
            onCreateSecret={handleCreateSecret}
            onUpdateSecret={handleUpdateSecret}
            onDeleteSecret={handleDeleteSecret}
          />
        ) : null}

        {currentView === 'tools' ? (
          <ToolsView
            packages={agentToolPackages}
            settings={agentToolSettings}
            officialTools={officialTools}
            busyToolId={agentToolBusyId}
            busyOfficialToolId={officialToolBusyId}
            errorMessage={agentToolError}
            errorTechnicalCode={agentToolErrorCode}
            t={t}
            onApprovalChange={(toolId, requiresApproval) =>
              void handleAgentToolApprovalChange(toolId, requiresApproval)
            }
            onActivateOfficialTool={(toolId) =>
              void runOfficialToolAction(toolId, () => getDesktopApi().activateOfficialTool(toolId, activeLocale))
            }
            onConfigureOfficialTool={(toolId) =>
              void runOfficialToolAction(toolId, () => getDesktopApi().configureOfficialTool({ toolId, locale: activeLocale }))
            }
            onDeactivateOfficialTool={(toolId) =>
              void runOfficialToolAction(toolId, () => getDesktopApi().deactivateOfficialTool(toolId, activeLocale))
            }
          />
        ) : null}

        {currentView === 'settings' ? (
          <SettingsView
            codexAuthBusy={codexAuthBusy}
            codexAuthStatus={codexAuthStatus}
            claudeAuthStatus={claudeAuthStatus}
            t={t}
            themePreference={themePreference}
            onThemeChange={setThemePreference}
            languagePreference={languagePreference}
            activeLocale={activeLocale}
            systemLocale={systemLocale}
            onLanguageChange={setLanguagePreference}
            chatBotPicture={chatBotPicture}
            chatBotPictureOptions={CHAT_BOT_PICTURE_OPTIONS}
            onChatBotPictureChange={setChatBotPicture}
            modelOptions={CODEX_MODEL_OPTIONS}
            reasoningOptions={CODEX_REASONING_OPTIONS}
            providerOptions={AGENT_PROVIDER_OPTIONS}
            claudeModelOptions={CLAUDE_MODEL_OPTIONS}
            claudeEffortOptions={CLAUDE_EFFORT_OPTIONS}
            defaultAgentProvider={settings.defaultAgentProvider}
            agentDefaults={settings.agentDefaults}
            onAgentDefaultsChange={(input) => void handleAgentDefaultsChange(input)}
            onOpenCodexConfig={() => setCodexConfigOpen(true)}
            onReinstallCodex={() => void handleReinstallCodex()}
            onOpenClaudeConfig={() => setClaudeConfigOpen(true)}
            onReinstallClaude={() => void handleReinstallClaude()}
            desktopUpdateState={desktopUpdateState}
            desktopUpdateBusy={desktopUpdateBusy}
            onCheckDesktopUpdates={() => void runDesktopUpdateAction(() => getDesktopApi().checkDesktopUpdates())}
            onDownloadDesktopUpdate={() => void runDesktopUpdateAction(() => getDesktopApi().downloadDesktopUpdate())}
            onInstallDesktopUpdate={() => void runDesktopUpdateAction(() => getDesktopApi().installDesktopUpdate())}
            installedApps={installedApps}
            memories={memories}
            onCreateMemory={(input) => void handleCreateMemory(input)}
            onUpdateMemory={(input) => void handleUpdateMemory(input)}
            onDeleteMemory={(id) => void handleDeleteMemory(id)}
            cloudIdentity={cloudIdentity}
            onRevealCloudSecretKey={() => getDesktopApi().revealCloudSecretKey()}
            onRegenerateCloudSecretKey={() => {
              void getDesktopApi().regenerateCloudSecretKey().then(setCloudIdentity);
            }}
          />
        ) : null}
        </AppShell>
      )}

      <Dialog
        open={Boolean(pendingInstallGate)}
        onClose={() => {
          if (!pendingInstallBusy) setPendingInstallGate(null);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {t.installGate.title(pendingInstallGate?.appName ?? t.installGate.fallbackAppName)}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.25} sx={{ pt: 1 }}>
            <Typography color="text.secondary">
              {t.installGate.body}
            </Typography>

            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.installGate.toolsTitle}</Typography>
              {pendingInstallGate && (pendingInstallGate.required.length > 0 || pendingInstallGate.optional.length > 0) ? (
                <Stack spacing={1}>
                  {pendingInstallGate.required.map((item) => renderInstallTool(item, true))}
                  {pendingInstallGate.optional.map((item) => renderInstallTool(item, false))}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.installGate.noTools}
                </Typography>
              )}
            </Stack>

            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.installGate.agentsTitle}</Typography>
              {pendingInstallGate?.agents.length ? (
                <Stack spacing={1}>{pendingInstallGate.agents.map(renderInstallItem)}</Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.installGate.noAgents}
                </Typography>
              )}
            </Stack>

            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.installGate.aiTasksTitle}</Typography>
              {pendingInstallGate?.promptTemplates.length ? (
                <Stack spacing={1}>{pendingInstallGate.promptTemplates.map(renderInstallItem)}</Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t.installGate.noAiTasks}
                </Typography>
              )}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button disabled={pendingInstallBusy} onClick={() => setPendingInstallGate(null)}>{t.installGate.cancel}</Button>
          <Button
            variant="contained"
            disabled={pendingInstallBusy || !pendingInstallGate?.canInstall}
            onClick={() => void handleConfirmInstallWithTools()}
          >
            {t.installGate.confirm}
          </Button>
        </DialogActions>
      </Dialog>

      <ForgerCloudModal
        open={cloudModalOpen}
        t={t}
        account={forgerAccount}
        busy={forgerAccountBusy}
        message={forgerAccountMessage}
        onClose={() => setCloudModalOpen(false)}
        onLogin={handleForgerLogin}
        onRegister={handleForgerRegister}
        onLogout={handleForgerLogout}
      />

      <CodexConfigModal
        open={codexConfigOpen}
        status={codexAuthStatus}
        busy={codexAuthBusy}
        t={t}
        onClose={() => setCodexConfigOpen(false)}
        onConnect={handleConnectCodexAuth}
        onRefresh={refreshCodexAuthStatus}
      />

      <ClaudeConfigModal
        open={claudeConfigOpen}
        status={claudeAuthStatus}
        busy={codexAuthBusy}
        t={t}
        onClose={() => setClaudeConfigOpen(false)}
        onConnect={handleConnectClaudeAuth}
        onRefresh={refreshClaudeAuthStatus}
        onReinstall={handleReinstallClaude}
      />

      <Dialog open={agentProviderConfigOpen} onClose={() => setAgentProviderConfigOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Conectar agente</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography color="text.secondary">
              Para conversar con tus apps o pedir cambios, conecta una cuenta de ChatGPT/Codex o Claude Code.
            </Typography>
            <Alert severity="warning">
              Claude Code puede usar la sesion local del usuario del computador. Si ya usas Claude Code fuera de Forger, Forger puede detectar esa sesion.
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAgentProviderConfigOpen(false)}>{t.actions.close}</Button>
          <Button
            variant="outlined"
            onClick={() => {
              setAgentProviderConfigOpen(false);
              setClaudeConfigOpen(true);
            }}
          >
            Conectar Claude
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setAgentProviderConfigOpen(false);
              setCodexConfigOpen(true);
            }}
          >
            Conectar ChatGPT
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={categoryDialogOpen} onClose={() => setCategoryDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t.sections.files.createCategory}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label={t.sections.files.categoryNamePrompt}
            value={categoryDialogName}
            onChange={(event) => setCategoryDialogName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleCreateCategorySubmit();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCategoryDialogOpen(false)}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void handleCreateCategorySubmit()} disabled={!categoryDialogName.trim()}>
            {t.sections.files.createCategory}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={renameCategoryDialog.open}
        onClose={() => setRenameCategoryDialog({ open: false, categoryPath: '', name: '' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t.sections.files.renameCategory}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label={t.sections.files.categoryNamePrompt}
            value={renameCategoryDialog.name}
            onChange={(event) => setRenameCategoryDialog((current) => ({ ...current, name: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleRenameCategorySubmit();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameCategoryDialog({ open: false, categoryPath: '', name: '' })}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void handleRenameCategorySubmit()} disabled={!renameCategoryDialog.name.trim()}>
            {t.sections.files.rename}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={renameFileDialog.open}
        onClose={() => setRenameFileDialog({ open: false, file: null, name: '' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t.sections.files.renameFile}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label={t.sections.files.namePrompt}
            value={renameFileDialog.name}
            onChange={(event) => setRenameFileDialog((current) => ({ ...current, name: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleRenameFileSubmit();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameFileDialog({ open: false, file: null, name: '' })}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void handleRenameFileSubmit()} disabled={!renameFileDialog.name.trim()}>
            {t.sections.files.rename}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={moveFileDialog.open}
        onClose={() => setMoveFileDialog({ open: false, file: null, categoryPath: '' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t.sections.files.moveFile}</DialogTitle>
        <DialogContent>
          <Select
            fullWidth
            size="small"
            value={moveFileDialog.categoryPath}
            onChange={(event) => setMoveFileDialog((current) => ({ ...current, categoryPath: event.target.value }))}
            sx={{ mt: 1 }}
          >
            <MenuItem value="">{t.sections.files.root}</MenuItem>
            {fileCategories.map((category) => (
              <MenuItem key={category.path} value={category.path}>{category.name}</MenuItem>
            ))}
          </Select>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMoveFileDialog({ open: false, file: null, categoryPath: '' })}>{t.actions.close}</Button>
          <Button variant="contained" onClick={() => void handleMoveFileSubmit()}>
            {t.sections.files.move}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={errorReportDialog.open}
        onClose={closeErrorReportDialog}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{t.settings.errorReportTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Typography color="text.secondary">{t.settings.errorReportBody}</Typography>
            {errorReportDialog.report ? (
              <TextField
                fullWidth
                multiline
                minRows={8}
                maxRows={14}
                label={t.settings.errorReportDetailsLabel}
                value={JSON.stringify(errorReportDialog.report, null, 2)}
                InputProps={{ readOnly: true }}
              />
            ) : null}
            {errorReportDialog.userMessage ? (
              <Alert severity="info">{errorReportDialog.userMessage}</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeErrorReportDialog} disabled={errorReportDialog.busy}>
            {t.settings.errorReportNoSend}
          </Button>
          <Button onClick={() => void copyErrorReportDetails()} disabled={errorReportDialog.busy || !errorReportDialog.report}>
            {t.settings.errorReportCopy}
          </Button>
          <Button
            variant="contained"
            onClick={() => void submitErrorReport()}
            disabled={errorReportDialog.busy || !errorReportDialog.report}
          >
            {t.settings.errorReportSend}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(bannerMessage)}
        autoHideDuration={3200}
        onClose={() => setBannerMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={bannerSeverity} variant="filled" onClose={() => setBannerMessage(null)}>
          {bannerMessage}
        </Alert>
      </Snackbar>
    </ThemeProvider>
  );
}

export default App;
