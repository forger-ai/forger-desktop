import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Paper, Stack, Switch, Typography, useMediaQuery } from '@mui/material';
import type { AlertColor } from '@mui/material';
import { AuthConnectAttemptTracker, type AuthConnectAttempt, type IntelligenceProviderAuth } from '@shared/auth-connect-attempts';
import type {
  AgentEffort,
  AgentPermissionMode,
  AgentProvider,
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  AppAgent,
  AppBackupSummary,
  AppCategory,
  AppDetails,
  AppPromptRestoreInput,
  AppPromptReviewInput,
  AppPromptTemplate,
  AppSecretsState,
  AppSummary,
  AppToolsInstallGate,
  Automation,
  AutomationRun,
  AutomationRunSummary,
  AutomationUpsertInput,
  BackgroundTask,
  BackgroundTaskStatus,
  CatalogApp,
  ChatMode,
  ChatRun,
  ChatRunStatus,
  ChatQuestionRequest,
  ClaudeAuthStatus,
  ClaudeEffort,
  CloudFriendship,
  CloudIdentityState,
  CloudSyncSettings,
  CloudStorageUsage,
  CodexAuthStatus,
  CodexReasoningEffort,
  DesktopErrorReportInput,
  DesktopErrorReportPreview,
  ConversationDiagnosticReportPreview,
  DesktopUpdateState,
  FailureDiagnosticFields,
  FilesListInput,
  ForgerAccountRegisterInput,
  ForgerAccountSession,
  ForumParticipationState,
  ForgerFileCategory,
  ForgerFileRecord,
  InstallAppResult,
  LocalNetworkShareStatus,
  MemoryCreateInput,
  MemoryEntry,
  MemoryUpdateInput,
  OfficialToolSummary,
  PickedChatFile,
  RemoteNetworkShareStatus,
  RemoteAppBackupSummary,
  RemoteBackupsUsage,
  RendererChatTraceEvent,
  Settings,
  SharedFileRef,
  SubmitAppRatingInput,
  SubmitProductFeedbackInput,
  SocialUserApp,
  UpdateAgentDefaultsInput,
  UpdateDeveloperModeInput,
  UserSecretSummary,
} from '@shared/types';
import { runtimeFromUserDefaults } from '@shared/agent-runtime-registry';
import {
  activeRunFromChatRun,
  isMessageTerminalChatRunStatus,
  isTerminalChatRunStatus,
  type PersistedActiveChatRun,
} from '@shared/chat-run-state';
import { getDictionary, type Locale } from '@renderer/i18n';
import { buildAppTheme, resolveThemeMode, type ThemePreference } from '@renderer/theme/appTheme';
import type { SelectedTool as SelectedToolsTool } from '@renderer/views/ToolsView';
import type { View } from '@renderer/components/Sidebar';
import type { ChatMessage, ChatQuestionResponse, ConversationHistoryItem } from '@renderer/views/ChatView';
import {
  CHAT_BOT_PICTURE_OPTIONS,
  CHAT_BOT_PICTURE_STORAGE_KEY,
  CHAT_AGENT_PROVIDER_STORAGE_KEY,
  CLAUDE_EFFORT_STORAGE_KEY,
  CLAUDE_MODEL_STORAGE_KEY,
  CODEX_MODEL_STORAGE_KEY,
  CODEX_REASONING_STORAGE_KEY,
  LANGUAGE_STORAGE_KEY,
  STARTUP_UPDATE_CHECK_STORAGE_KEY,
  THEME_STORAGE_KEY,
  getStoredChatAgentProvider,
  getStoredChatBotPicture,
  getStoredClaudeEffort,
  getStoredClaudeModel,
  getStoredCodexModel,
  getStoredCodexReasoningEffort,
  getStoredLanguagePreference,
  getStoredThemePreference,
  resolveSystemLocale,
  type ChatBotPicture,
  type LanguagePreference,
} from '@renderer/preferences';
import {
  CHAT_STORAGE_KEY,
  appendChatMessageToConversationOnce,
  makeConversationId,
  readPersistedChatState,
  summarizeConversationTitle,
  type ChatConversation,
  type PersistedChatState,
} from '@renderer/chat-state';
import { buildErrorReport as buildErrorReportPreview, shouldPromptForErrorReport } from '@renderer/error-reporting';
import { FORGER_TOUR_RESET_EVENT } from '@renderer/tour/useForgerTour';
import {
  getUsageAnalyticsEnabled,
  setUsageAnalyticsPreference,
  submitChatGptConnectedEvent,
  submitForgerInstalledEvent,
  submitUsageEvent,
} from '@renderer/usage-analytics';

const AUTH_STATUS_POLL_INTERVAL_MS = 1500; const AUTH_STATUS_POLL_TIMEOUT_MS = 120000; const wait = async (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const FORGER_DATA_ROOT_NAME = 'data'; const FREE_CHAT_APP_ID = 'forger'; const EARLY_ACCESS_STORAGE_KEY = 'forger.beta.earlyAccessEnabled'; const ADVANCED_MODE_STORAGE_KEY = 'forger.beta.advancedModeEnabled'; const GLOBAL_ONBOARDING_STORAGE_KEY = 'forger.onboarding.global.dismissed'; const ADVANCED_ONBOARDING_STORAGE_PREFIX = 'forger.onboarding.advanced.';
const TOOLS_ONBOARDING_MODULE_STORAGE_KEY = 'forger.onboarding.tools.module'; const TOOLS_ONBOARDING_STORAGE_KEYS = { forger: 'forger.onboarding.tools.forger', gmail: 'forger.onboarding.tools.gmail', } as const; const ADVANCED_VIEWS = ['tools', 'files', 'backups', 'devices', 'datos', 'secrets', 'automations'] as const;
const readStoredBoolean = (key: string, fallback = false) => { if (typeof window === 'undefined') return fallback; const value = window.localStorage.getItem(key); return value === null ? fallback : value === 'true'; };
const mergeRecords = ( first?: Record<string, unknown>, second?: Record<string, unknown>, ): Record<string, unknown> | undefined => { const merged = { ...(first ?? {}), ...(second ?? {}) }; return Object.keys(merged).length > 0 ? merged : undefined; };
const initialSettings: Settings = { userEmail: '', plan: 'Free', safeMode: false, developerMode: { enabled: false, pathEntries: [] }, codexDefaults: { model: 'gpt-5.4', reasoningEffort: 'medium', }, defaultAgentProvider: 'auto', defaultChatPermissionMode: 'safe', defaultChatNetworkAccess: true, agentDefaults: { codex: { model: 'gpt-5.4', reasoningEffort: 'medium', }, claude: { model: 'claude-sonnet-4-6', effort: 'high', }, }, providerConnections: {}, };
const initialCodexAuthStatus: CodexAuthStatus = { installed: false, authenticated: false, authFilePath: '', codexHome: '', };
const initialClaudeAuthStatus: ClaudeAuthStatus = { installed: false, authenticated: false, source: 'missing', };
const resolveChatRuntimeDraft = ( provider: AgentProvider, codexModel: string, codexReasoningEffort: CodexReasoningEffort, claudeModel: string, claudeEffort: ClaudeEffort, ): { provider: AgentProvider; model: string; effort: AgentEffort; reasoningEffort?: CodexReasoningEffort } => { if (provider === 'codex') { return { provider: 'codex', model: codexModel, reasoningEffort: codexReasoningEffort, effort: codexReasoningEffort }; }
return { provider: 'claude', model: claudeModel, effort: claudeEffort }; };
const runtimeDraftFromRuntime = (runtime: { provider: AgentProvider; model: string; effort: AgentEffort }): { provider: AgentProvider; model: string; effort: AgentEffort; reasoningEffort?: CodexReasoningEffort } => ({
  provider: runtime.provider,
  model: runtime.model,
  effort: runtime.effort,
  ...(runtime.provider === 'codex' ? { reasoningEffort: runtime.effort as CodexReasoningEffort } : {}),
});
const initialForgerAccount: ForgerAccountSession = { authenticated: false, };
const initialRemoteBackupsUsage: RemoteBackupsUsage = { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0, };
const initialCloudStorageUsage: CloudStorageUsage | null = null;
const initialDesktopUpdateState: DesktopUpdateState = { status: 'idle', currentVersion: '', };
const initialAgentToolSettings: AgentToolSettings = { approvals: { forger_list_catalog: false, forger_list_installed_apps: false, forger_check_updates: false, forger_create_app: false, forger_list_app_prompts: false, forger_test_app_prompt: false, forger_update_app_prompt: true, forger_restore_app_prompt: true, forger_get_app_runtime_status: false, forger_open_app: true, forger_stop_app: true, forger_restart_app: true, forger_refresh_app_view: true, forger_update_app: true,
'gmail.connection.status': false, 'gmail.search_messages': true, 'gmail.read_thread': true, 'gmail.read_attachment': true, 'gmail.send_email': true, 'whatsapp.connection.status': false, 'whatsapp.start_pairing': true, 'whatsapp.list_chats': false, 'whatsapp.read_messages': true, 'whatsapp.send_message': true, 'whatsapp.get_chat_details': true, }, };
const getDesktopApi = () => { const desktopApi = window.forger; if (!desktopApi) { throw new Error( 'Bridge de Electron no disponible. Ejecuta Forger con `npm run dev` en desktop (no solo Vite en navegador).', ); }
return desktopApi; };
const traceChatEvent = (event: RendererChatTraceEvent) => { try { void getDesktopApi().traceChatEvent({ ...event, timestamp: event.timestamp ?? new Date().toISOString() }); } catch { /* best-effort diagnostics only */ } };
interface ErrorReportDialogState {
open: boolean; report: DesktopErrorReportPreview | null; busy: boolean; userMessage?: string; }
interface ConversationDiagnosticDialogState {
open: boolean; report: ConversationDiagnosticReportPreview | null; busy: boolean; userMessage?: string; description: string; }
interface RemoteTunnelReadyDialogState {
open: boolean; appId: string; appName: string; portalUrl: string; sessionId?: string; }
type SocialUploadVisibility = 'private' | 'friends' | 'public';
const initialForumParticipation: ForumParticipationState = { status: 'opted_out', isModerator: false };
const socialLocalAppId = (ownerUsername: string, slug: string) => {
  const safeOwner = ownerUsername.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  return `social-${safeOwner}-${safeSlug}`.slice(0, 96);
};
const socialAppDetails = (app: SocialUserApp, shareCode?: string): AppDetails => {
  const localAppId = socialLocalAppId(app.owner.username, app.slug);
  return {
    app: {
      id: localAppId,
      name: app.name,
      description: app.description ?? app.shortDescription ?? 'App compartida desde Forger Social',
      category: 'productividad',
      status: 'not_installed',
      latestVersion: app.latestVersion?.version,
      version: app.latestVersion?.version,
      capabilities: app.latestVersion?.capabilities.map((id) => ({ id })),
      averageRating: app.averageReviewScore,
      ratingsCount: app.reviewsCount,
    },
    installed: false,
    status: 'not_installed',
    version: app.latestVersion?.version,
    latestVersion: app.latestVersion?.version,
    operations: [],
    promptTemplates: app.latestVersion?.promptTemplates as AppPromptTemplate[] | undefined,
    agents: app.latestVersion?.agents as AppAgent[] | undefined,
    social: { app, shareCode, localAppId },
  };
};
interface SocialUploadDialogState {
open: boolean; appId: string | null; visibility: SocialUploadVisibility; }
interface SocialChatWindowRoute {
friendUserId: number; friendUsername: string; friendDisplayName: string; }
interface ActiveConversationRun extends PersistedActiveChatRun {
  status: ChatRunStatus;
  progressLog: string[];
}
const resolveSocialChatWindowRoute = (): SocialChatWindowRoute | null => { if (typeof window === 'undefined') { return null; }
const params = new URLSearchParams(window.location.search); if (params.get('socialChat') !== '1') { return null; }
const friendUserId = Number(params.get('friendUserId')); const friendUsername = params.get('friendUsername')?.trim(); const friendDisplayName = params.get('friendDisplayName')?.trim(); if (!Number.isFinite(friendUserId) || !friendUsername || !friendDisplayName) { return null; }
return { friendUserId, friendUsername, friendDisplayName, };
};
export function useRendererAppController() {
const persistedChatState = useMemo(() => readPersistedChatState(), []); const socialChatWindowRoute = useMemo(() => resolveSocialChatWindowRoute(), []); const [currentView, setCurrentView] = useState<View>('chat'); const [installedApps, setInstalledApps] = useState<AppSummary[]>([]); const [memories, setMemories] = useState<MemoryEntry[]>([]); const [catalogApps, setCatalogApps] = useState<CatalogApp[]>([]); const [openingAppIds, setOpeningAppIds] = useState<Set<string>>(new Set());
const openingAppIdsRef = useRef<Set<string>>(new Set()); const installedAppsRef = useRef<AppSummary[]>([]); const authConnectTrackerRef = useRef(new AuthConnectAttemptTracker()); const [installProgressByApp, setInstallProgressByApp] = useState<Record<string, InstallAppResult>>({}); const [settings, setSettings] = useState<Settings>(initialSettings); const [authBusyProvider, setAuthBusyProvider] = useState<IntelligenceProviderAuth | null>(null); const codexAuthBusy = authBusyProvider === 'codex'; const claudeAuthBusy = authBusyProvider === 'claude'; const [codexAuthStatus, setCodexAuthStatus] = useState<CodexAuthStatus>(initialCodexAuthStatus);
const [claudeAuthStatus, setClaudeAuthStatus] = useState<ClaudeAuthStatus>(initialClaudeAuthStatus); const [agentToolPackages, setAgentToolPackages] = useState<AgentToolPackageDefinition[]>([]); const [agentToolSettings, setAgentToolSettings] = useState<AgentToolSettings>(initialAgentToolSettings); const [agentToolBusyId, setAgentToolBusyId] = useState<AgentToolDefinition['id'] | null>(null); const [agentToolError, setAgentToolError] = useState<string | null>(null);
const [agentToolErrorCode, setAgentToolErrorCode] = useState<string | null>(null); const [officialTools, setOfficialTools] = useState<OfficialToolSummary[]>([]); const [officialToolBusyId, setOfficialToolBusyId] = useState<string | null>(null); const [cloudModalOpen, setCloudModalOpen] = useState(false); const [forgerAccount, setForgerAccount] = useState<ForgerAccountSession>(initialForgerAccount); const [forgerAccountBusy, setForgerAccountBusy] = useState(false);
const [forgerAccountMessage, setForgerAccountMessage] = useState<string | null>(null); const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState>(initialDesktopUpdateState); const [desktopUpdateBusy, setDesktopUpdateBusy] = useState(false); const [codexConfigOpen, setCodexConfigOpen] = useState(false); const [claudeConfigOpen, setClaudeConfigOpen] = useState(false); const [agentProviderConfigOpen, setAgentProviderConfigOpen] = useState(false);
const [errorReportDialog, setErrorReportDialog] = useState<ErrorReportDialogState>({ open: false, report: null, busy: false, }); const [conversationDiagnosticDialog, setConversationDiagnosticDialog] = useState<ConversationDiagnosticDialogState>({ open: false, report: null, busy: false, description: '', }); const [selectedAppDetailsId, setSelectedAppDetailsId] = useState<string | null>(null); const [selectedAppDetails, setSelectedAppDetails] = useState<AppDetails | null>(null); const [appDetailsBackView, setAppDetailsBackView] = useState<View>('catalog'); const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
const [selectedDataAppId, setSelectedDataAppId] = useState<string | null>(null); const [appSecretsState, setAppSecretsState] = useState<AppSecretsState | null>(null); const [pendingInstallGate, setPendingInstallGate] = useState<AppToolsInstallGate | null>(null); const [pendingInstallBusy, setPendingInstallBusy] = useState(false); const [selectedAppToolGate, setSelectedAppToolGate] = useState<AppToolsInstallGate | null>(null); const [selectedAppToolGrantBusyId, setSelectedAppToolGrantBusyId] = useState<string | null>(null); const [userSecrets, setUserSecrets] = useState<UserSecretSummary[]>([]); const [secretsBusy, setSecretsBusy] = useState(false); const [chatDraftsByConversation, setChatDraftsByConversation] = useState<Record<string, string>>(persistedChatState.draftInputByConversationId ?? {});
const [pendingChatFiles, setPendingChatFiles] = useState<PickedChatFile[]>([]); const [mentionedChatFileIds, setMentionedChatFileIds] = useState<string[]>([]); const [uploadCategoryPath, setUploadCategoryPath] = useState(''); const [selectedCodexModel, setSelectedCodexModel] = useState(getStoredCodexModel); const [selectedCodexReasoningEffort, setSelectedCodexReasoningEffort] = useState(getStoredCodexReasoningEffort);
const [selectedAgentProvider, setSelectedAgentProvider] = useState<AgentProvider | 'auto'>(getStoredChatAgentProvider); const [selectedClaudeModel, setSelectedClaudeModel] = useState(getStoredClaudeModel); const [selectedClaudeEffort, setSelectedClaudeEffort] = useState<ClaudeEffort>(getStoredClaudeEffort); const [categoryDialogOpen, setCategoryDialogOpen] = useState(false); const [categoryDialogSelectAfterCreate, setCategoryDialogSelectAfterCreate] = useState(false);
const [selectedChatPermissionMode, setSelectedChatPermissionMode] = useState<AgentPermissionMode>(settings.defaultChatPermissionMode ?? 'safe');
const [selectedChatNetworkAccess, setSelectedChatNetworkAccess] = useState(settings.defaultChatNetworkAccess !== false);
const [categoryDialogName, setCategoryDialogName] = useState(''); const [renameCategoryDialog, setRenameCategoryDialog] = useState<{ open: boolean; categoryPath: string; name: string }>({ open: false, categoryPath: '', name: '', }); const [renameFileDialog, setRenameFileDialog] = useState<{ open: boolean; file: ForgerFileRecord | null; name: string }>({ open: false, file: null, name: '', });
const [moveFileDialog, setMoveFileDialog] = useState<{ open: boolean; file: ForgerFileRecord | null; categoryPath: string }>({ open: false, file: null, categoryPath: '', }); const [forgerFiles, setForgerFiles] = useState<ForgerFileRecord[]>([]); const [fileCategories, setFileCategories] = useState<ForgerFileCategory[]>([]); const [fileFilters, setFileFilters] = useState<FilesListInput>({ sortBy: 'uploadedAt', sortDirection: 'desc' }); const [automations, setAutomations] = useState<Automation[]>([]);
const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]); const [backgroundTasksDrawerOpen, setBackgroundTasksDrawerOpen] = useState(false); const [backgroundTasksBackView, setBackgroundTasksBackView] = useState<View>('catalog'); const [selectedBackgroundTaskId, setSelectedBackgroundTaskId] = useState<string | null>(null);
const [automationRuns, setAutomationRuns] = useState<AutomationRunSummary[]>([]); const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null); const [selectedAutomationRun, setSelectedAutomationRun] = useState<AutomationRun | null>(null); const [automationBusy, setAutomationBusy] = useState(false); const [backups, setBackups] = useState<AppBackupSummary[]>([]); const [remoteBackups, setRemoteBackups] = useState<RemoteAppBackupSummary[]>([]);
const [remoteBackupsUsage, setRemoteBackupsUsage] = useState<RemoteBackupsUsage>(initialRemoteBackupsUsage); const [cloudStorageUsage, setCloudStorageUsage] = useState<CloudStorageUsage | null>(initialCloudStorageUsage); const [cloudStorageBusy, setCloudStorageBusy] = useState(false); const [cloudSyncSettings, setCloudSyncSettings] = useState<CloudSyncSettings>({ appSync: {} }); const [cloudIdentity, setCloudIdentity] = useState<CloudIdentityState | null>(null); const [backupsBusy, setBackupsBusy] = useState(false); const [chatConversations, setChatConversations] = useState<ChatConversation[]>( persistedChatState.conversations, );
const [activeConversationByApp, setActiveConversationByApp] = useState<Record<string, string>>( persistedChatState.activeConversationByApp, ); const [activeConversationId, setActiveConversationId] = useState<string | null>( persistedChatState.lastActiveConversationId, ); const initialActiveRunsByConversation = useMemo<Record<string, ActiveConversationRun>>(() => Object.fromEntries(persistedChatState.activeRuns.map((run) => [run.conversationId, { ...run, status: 'queued' as ChatRunStatus, progressLog: [] }])), [persistedChatState.activeRuns]); const [activeChatRunsByConversation, setActiveChatRunsByConversation] = useState<Record<string, ActiveConversationRun>>(initialActiveRunsByConversation); const activeChatRunsByConversationRef = useRef<Record<string, ActiveConversationRun>>(initialActiveRunsByConversation); const [startingConversationIds, setStartingConversationIds] = useState<Set<string>>(new Set());
const activeConversationIdRef = useRef<string | null>(activeConversationId); const selectedAppIdRef = useRef<string | null>(selectedAppId); const chatConversationsRef = useRef<ChatConversation[]>(chatConversations); const selectedAutomationIdRef = useRef<string | null>(null); const runConversationIdByRunRef = useRef<Map<string, string>>(new Map()); const deliveredRunRepliesRef = useRef<Set<string>>(new Set()); const createdAppUsageEventsRef = useRef<Set<string>>(new Set()); const [bannerMessage, setBannerMessage] = useState<string | null>(null); const [bannerSeverity, setBannerSeverity] = useState<AlertColor>('success'); const [catalogFilter, setCatalogFilter] = useState<'all' | AppCategory>('all');
const [catalogStatusFilter, setCatalogStatusFilter] = useState<'all' | 'installed' | 'not_installed'>('all'); const [selectedToolsTool, setSelectedToolsTool] = useState<SelectedToolsTool>(null); const [createLocalAppBusy, setCreateLocalAppBusy] = useState(false); const [localNetworkShareDialogOpen, setLocalNetworkShareDialogOpen] = useState(false); const [localNetworkShareStatus, setLocalNetworkShareStatus] = useState<LocalNetworkShareStatus | null>(null); const [remoteTunnelReadyDialog, setRemoteTunnelReadyDialog] = useState<RemoteTunnelReadyDialogState>({ open: false, appId: '', appName: '', portalUrl: '' }); const remoteTunnelReadySessionsRef = useRef<Set<string>>(new Set()); const [earlyAccessEnabled, setEarlyAccessEnabled] = useState(() => readStoredBoolean(EARLY_ACCESS_STORAGE_KEY)); const [advancedMode, setAdvancedMode] = useState(() => readStoredBoolean(ADVANCED_MODE_STORAGE_KEY)); const [usageAnalyticsEnabled, setUsageAnalyticsEnabled] = useState(getUsageAnalyticsEnabled); const [themePreference, setThemePreference] = useState<ThemePreference>(getStoredThemePreference);
const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(getStoredLanguagePreference); const [systemLocale, setSystemLocale] = useState<Locale>(resolveSystemLocale); const activeLocale = languagePreference === 'system' ? systemLocale : languagePreference; const t = useMemo(() => getDictionary(activeLocale), [activeLocale]); const [chatBotPicture, setChatBotPicture] = useState<ChatBotPicture>(getStoredChatBotPicture); const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
const [socialUploadDialog, setSocialUploadDialog] = useState<SocialUploadDialogState>({ open: false, appId: null, visibility: 'private' });
const [socialProfileUsername, setSocialProfileUsername] = useState<string | null>(null);
const [forumParticipation, setForumParticipation] = useState<ForumParticipationState>(initialForumParticipation);
const [forumPromptOpen, setForumPromptOpen] = useState(false);
const [forumParticipationBusy, setForumParticipationBusy] = useState(false);
const chatBotPictureSrc = CHAT_BOT_PICTURE_OPTIONS.find((option) => option.value === chatBotPicture)?.src ?? CHAT_BOT_PICTURE_OPTIONS[0].src; const activeConversation = useMemo( () => chatConversations.find((conversation) => conversation.id === activeConversationId) ?? null, [chatConversations, activeConversationId], ); const activeChatDraftKey = activeConversationId ?? selectedAppId ?? FREE_CHAT_APP_ID; const chatInput = chatDraftsByConversation[activeChatDraftKey] ?? ''; const setChatInput = (value: string) => { setChatDraftsByConversation((current) => { if (!value) { const next = { ...current }; delete next[activeChatDraftKey]; return next; } return { ...current, [activeChatDraftKey]: value }; }); }; const setChatDraft = (draftKey: string, value: string) => { setChatDraftsByConversation((current) => { if (!value) { const next = { ...current }; delete next[draftKey]; return next; } return { ...current, [draftKey]: value }; }); }; const chatMessages = activeConversation?.messages ?? []; const activeConversationRun = activeConversationId ? activeChatRunsByConversation[activeConversationId] ?? null : null; const chatRunActive = Object.keys(activeChatRunsByConversation).length > 0 || startingConversationIds.size > 0; const activeConversationRunActive = Boolean(activeConversationRun || (activeConversationId && startingConversationIds.has(activeConversationId))); const activeConversationRunId = activeConversationRun?.runId ?? null; const activeConversationProgressLines = activeConversationRun?.progressLog ?? []; const mentionedChatFiles = useMemo( () => forgerFiles.filter((file) => mentionedChatFileIds.includes(file.id)),
[forgerFiles, mentionedChatFileIds], ); const chatHistoryItems = useMemo<ConversationHistoryItem[]>( () => [...chatConversations] .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) .map((conversation) => ({ id: conversation.id, title: conversation.title, threadId: conversation.threadId, updatedAt: conversation.updatedAt, })), [chatConversations], );
const resolvedChatProvider = useMemo<AgentProvider>(() => { if (activeConversation?.runtime) { return activeConversation.runtime.provider; }
if (selectedAgentProvider !== 'auto') { return selectedAgentProvider; }
if (settings.defaultAgentProvider !== 'auto') { return settings.defaultAgentProvider; }
if (claudeAuthStatus.authenticated && !codexAuthStatus.authenticated) { return 'claude'; }
if (codexAuthStatus.authenticated && !claudeAuthStatus.authenticated) { return 'codex'; }
const connectedProviders = (Object.entries(settings.providerConnections) as Array<[AgentProvider, string | undefined]>) .filter(([, connectedAt]) => Boolean(connectedAt)) .sort(([, left], [, right]) => Date.parse(left ?? '') - Date.parse(right ?? '')); return connectedProviders[0]?.[0] ?? 'codex'; }, [ activeConversation?.runtime, claudeAuthStatus.authenticated, codexAuthStatus.authenticated, selectedAgentProvider, settings.defaultAgentProvider, settings.providerConnections, ]);
const prepareAndOpenErrorReport = (report: DesktopErrorReportPreview) => {
setErrorReportDialog({ open: true, report, busy: true });
void getDesktopApi().prepareDesktopErrorReport(report).then((preparedReport) => {
setErrorReportDialog((current) => current.report?.occurredAt === report.occurredAt ? { ...current, report: preparedReport, busy: false } : current);
}).catch(() => {
setErrorReportDialog((current) => current.report?.occurredAt === report.occurredAt ? { ...current, busy: false, userMessage: t.settings.errorReportPrepareError } : current);
});
};
const requestErrorReport = (input: DesktopErrorReportInput) => { if (!shouldPromptForErrorReport(input.technicalCode)) { return; }
prepareAndOpenErrorReport(buildErrorReportPreview(input, desktopUpdateState.currentVersion)); };
const requestErrorReportFromResult = ( source: DesktopErrorReportInput['source'], operation: string, result: { success: boolean; userMessage?: string } & FailureDiagnosticFields, extra?: Pick<DesktopErrorReportInput, 'appId' | 'appVersion' | 'details' | 'sensitiveDetails'>, ) => { if (result.success || !result.technicalCode || !shouldPromptForErrorReport(result.technicalCode)) { return; }
requestErrorReport({ source, operation, message: result.userMessage ?? result.technicalCode, technicalCode: result.technicalCode, appId: extra?.appId, appVersion: extra?.appVersion, details: mergeRecords(result.details, extra?.details), sensitiveDetails: mergeRecords(result.sensitiveDetails, extra?.sensitiveDetails), }); };
useEffect(() => { const handleError = (event: ErrorEvent) => { requestErrorReport({ source: 'renderer', operation: 'window.error', message: event.message || 'Unexpected renderer error.', technicalCode: 'renderer_window_error', details: { filename: event.filename, lineno: event.lineno, colno: event.colno }, sensitiveDetails: { stack: event.error instanceof Error ? event.error.stack : undefined } }); }; const handleRejection = (event: PromiseRejectionEvent) => { const reason = event.reason; requestErrorReport({ source: 'renderer', operation: 'window.unhandledrejection', message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled renderer rejection.'), technicalCode: 'renderer_unhandled_rejection', sensitiveDetails: { stack: reason instanceof Error ? reason.stack : undefined, reason: reason instanceof Error ? undefined : String(reason ?? '') } }); }; window.addEventListener('error', handleError); window.addEventListener('unhandledrejection', handleRejection); return () => { window.removeEventListener('error', handleError); window.removeEventListener('unhandledrejection', handleRejection); }; }, [desktopUpdateState.currentVersion]);
const refreshFiles = async (filters: FilesListInput = fileFilters) => { const desktopApi = getDesktopApi(); const [files, categories] = await Promise.all([ desktopApi.filesList(filters), desktopApi.filesListCategories(), ]); setForgerFiles(files); setFileCategories(categories); };
const refreshAutomations = async () => { const desktopApi = getDesktopApi(); const nextAutomations = await desktopApi.automationsList(); setAutomations(nextAutomations); return nextAutomations; };
const sortBackgroundTasks = (tasks: BackgroundTask[]) => [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
const mergeBackgroundTask = (task: BackgroundTask) => { setBackgroundTasks((current) => sortBackgroundTasks([task, ...current.filter((item) => item.id !== task.id)])); };
const automationTaskStatus = (run: AutomationRunSummary): BackgroundTaskStatus => {
if (run.status === 'succeeded') return 'succeeded';
if (run.status === 'failed') return 'failed';
if (run.status === 'skipped') return 'skipped';
if (run.status === 'running') return 'running';
return 'queued';
};
const automationTaskMessage = (run: AutomationRunSummary) => {
if (run.status === 'succeeded') return t.locale === 'es' ? 'Automatización completada.' : 'Automation completed.';
if (run.status === 'failed') return run.userMessage || (t.locale === 'es' ? 'No pudimos completar la automatización.' : 'We could not complete the automation.');
if (run.status === 'skipped') return t.locale === 'es' ? 'Automatización omitida.' : 'Automation skipped.';
if (run.status === 'running') return run.userMessage || (t.locale === 'es' ? 'Automatización en ejecución.' : 'Automation running.');
return t.locale === 'es' ? 'Automatización en cola.' : 'Automation queued.';
};
const upsertAutomationBackgroundTask = (automation: Automation, run?: AutomationRunSummary) => { if (!run) { return; }
const status = automationTaskStatus(run); const now = new Date().toISOString(); const taskId = `automation:${run.id}`; const existing = backgroundTasks.find((task) => task.id === taskId); const message = automationTaskMessage(run); const latestMessage = existing?.statusUpdates.at(-1)?.message; const statusUpdates = latestMessage === message ? existing?.statusUpdates ?? [] : [ ...(existing?.statusUpdates ?? []), { message, status, createdAt: now }, ].slice(-80); const appId = automation.selectedAppIds.length === 1 ? automation.selectedAppIds[0] : undefined; const result = status === 'succeeded' ? { status: 'success' as const, message: run.userMessage || message } : status === 'failed' ? { status: 'error' as const, message, technicalCode: run.error } : status === 'skipped' ? { status: 'info' as const, message } : undefined; void getDesktopApi().backgroundTasksUpsert({ id: taskId, source: 'automation', title: `${t.nav.automations}: ${automation.name}`, status, statusUpdates, ...(result ? { result } : {}), ...(appId ? { app: { id: appId, name: getAppMeta(appId).name } } : {}), relatedEntity: { kind: 'automation-run', id: run.id, secondaryId: automation.id }, createdAt: existing?.createdAt ?? run.startedAt, updatedAt: now, ...(run.finishedAt ? { completedAt: run.finishedAt } : status === 'succeeded' || status === 'failed' || status === 'skipped' || status === 'canceled' ? { completedAt: now } : {}), }).catch(() => undefined); };
const refreshCloudStorageUsage = async () => { setCloudStorageBusy(true); try { const usage = await getDesktopApi().getCloudStorageUsage(); setCloudStorageUsage(usage); return usage; } finally { setCloudStorageBusy(false); } };
const refreshBackups = async () => { const desktopApi = getDesktopApi(); const [nextBackups, nextRemoteBackups, nextCloudSyncSettings, nextCloudStorageUsage] = await Promise.all([ desktopApi.listBackups(), desktopApi.listRemoteBackups(), desktopApi.getCloudSyncSettings(), desktopApi.getCloudStorageUsage(), ]); setBackups(nextBackups); setRemoteBackups(nextRemoteBackups.backups); setRemoteBackupsUsage(nextRemoteBackups.usage); setCloudSyncSettings(nextCloudSyncSettings); setCloudStorageUsage(nextCloudStorageUsage); return nextBackups; };
const loadAutomationRuns = async (automationId: string, preferredRunId?: string) => { const desktopApi = getDesktopApi(); const runs = await desktopApi.automationsListRuns(automationId); setAutomationRuns(runs); const targetRunId = preferredRunId ?? runs[0]?.id; if (targetRunId) { const run = await desktopApi.automationsGetRunTranscript(targetRunId); setSelectedAutomationRun(run); } else { setSelectedAutomationRun(null); }
};
const refreshApps = async () => { const desktopApi = getDesktopApi(); const catalog = await desktopApi.listCatalogApps(); const installed = await desktopApi.listInstalledApps(); setCatalogApps(catalog); setInstalledApps(installed); return { catalog, installed }; };
const refreshForumParticipation = async (authenticated = forgerAccount.authenticated) => { if (!authenticated) { setForumParticipation(initialForumParticipation); setForumPromptOpen(false); return initialForumParticipation; }
const state = await getDesktopApi().getForumParticipation(); setForumParticipation(state); setForumPromptOpen(state.status === 'opted_out' && !state.firstPromptShownAt); return state; };
const refreshAgentTools = async () => { const desktopApi = getDesktopApi(); const [toolPackages, toolSettings] = await Promise.all([ desktopApi.listAgentTools(), desktopApi.getAgentToolSettings(), ]); setAgentToolPackages(toolPackages); setAgentToolSettings(toolSettings); };
const refreshOfficialTools = async () => { const state = await getDesktopApi().listOfficialTools(activeLocale); setOfficialTools(state.tools); return state.tools; };
const refreshSelectedAppToolGate = async (appId: string) => { const gate = await getDesktopApi().getAppToolsInstallGate(appId, activeLocale); setSelectedAppToolGate(gate); return gate; };
useEffect(() => { const loadData = async () => { const desktopApi = getDesktopApi(); const [ appsResult, settingsResult, accountResult, codexAuthResult, claudeAuthResult, desktopUpdateResult, toolsResult, officialToolsResult, filesResult, categoriesResult, automationsResult, backgroundTasksResult, backupsResult, remoteBackupsResult, cloudSyncSettingsResult, cloudStorageResult, cloudIdentityResult, memoriesResult, ] = await Promise.allSettled([ refreshApps(), desktopApi.getSettings(), desktopApi.getForgerAccount(), desktopApi.getCodexAuthStatus(),
desktopApi.getClaudeAuthStatus(), desktopApi.getDesktopUpdateState(), refreshAgentTools(), refreshOfficialTools(), desktopApi.filesList(fileFilters), desktopApi.filesListCategories(), desktopApi.automationsList(), desktopApi.backgroundTasksList(), desktopApi.listBackups(), desktopApi.listRemoteBackups(), desktopApi.getCloudSyncSettings(), desktopApi.getCloudStorageUsage(), desktopApi.getCloudIdentity(), desktopApi.memoryList(), ]); if (appsResult.status === 'rejected') { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); }
if (settingsResult.status === 'fulfilled') { setSettings(settingsResult.value); setSelectedChatPermissionMode(settingsResult.value.defaultChatPermissionMode ?? 'safe'); setSelectedChatNetworkAccess(settingsResult.value.defaultChatNetworkAccess !== false); }
if (accountResult.status === 'fulfilled') { setForgerAccount(accountResult.value); if (accountResult.value.authenticated) { void desktopApi.getForumParticipation().then((state) => { setForumParticipation(state); setForumPromptOpen(state.status === 'opted_out' && !state.firstPromptShownAt); }).catch(() => undefined); } }
if (filesResult.status === 'fulfilled') { setForgerFiles(filesResult.value); }
if (categoriesResult.status === 'fulfilled') { setFileCategories(categoriesResult.value); }
if (automationsResult.status === 'fulfilled') { setAutomations(automationsResult.value); if (automationsResult.value[0]) { setSelectedAutomationId(automationsResult.value[0].id); void loadAutomationRuns(automationsResult.value[0].id); }
}
if (backgroundTasksResult.status === 'fulfilled') { setBackgroundTasks(sortBackgroundTasks(backgroundTasksResult.value)); }
if (backupsResult.status === 'fulfilled') { setBackups(backupsResult.value); }
if (remoteBackupsResult.status === 'fulfilled') { setRemoteBackups(remoteBackupsResult.value.backups); setRemoteBackupsUsage(remoteBackupsResult.value.usage); }
if (cloudSyncSettingsResult.status === 'fulfilled') { setCloudSyncSettings(cloudSyncSettingsResult.value); }
if (cloudStorageResult.status === 'fulfilled') { setCloudStorageUsage(cloudStorageResult.value); }
if (cloudIdentityResult.status === 'fulfilled') { setCloudIdentity(cloudIdentityResult.value); }
if (memoriesResult.status === 'fulfilled') { setMemories(memoriesResult.value); }
if (codexAuthResult.status === 'fulfilled') { setCodexAuthStatus(codexAuthResult.value); }
if (claudeAuthResult.status === 'fulfilled') { setClaudeAuthStatus(claudeAuthResult.value); }
if (desktopUpdateResult.status === 'fulfilled') { setDesktopUpdateState(desktopUpdateResult.value); }
submitForgerInstalledEvent({ surface: 'startup', locale: t.locale });
const today = new Date().toISOString().slice(0, 10); const lastStartupCheck = window.localStorage.getItem(STARTUP_UPDATE_CHECK_STORAGE_KEY); if (lastStartupCheck !== today) { window.localStorage.setItem(STARTUP_UPDATE_CHECK_STORAGE_KEY, today); void desktopApi.checkDesktopUpdates().then((state) => { setDesktopUpdateState(state); if (state.status === 'available' && state.availableVersion) { setBannerSeverity('info'); setBannerMessage(t.settings.desktopStartupUpdateAvailable(state.availableVersion));
} else if (state.status === 'unsupported' && state.userMessage) { setBannerSeverity('warning'); setBannerMessage(state.userMessage); }
}).catch(() => undefined); }
if (toolsResult.status === 'rejected') { setAgentToolError(t.sections.tools.saveError); }
if (officialToolsResult.status === 'rejected') { setAgentToolError(t.sections.tools.saveError); }
};
void loadData(); }, []); useEffect(() => { const handleError = (event: ErrorEvent) => { requestErrorReport({ source: 'renderer', operation: 'window.error', message: event.message || 'Renderer error', technicalCode: 'renderer_error', details: { filename: event.filename, lineno: event.lineno, colno: event.colno, }, sensitiveDetails: { stack: event.error instanceof Error ? event.error.stack : undefined, }, }); };
const handleUnhandledRejection = (event: PromiseRejectionEvent) => { const reason = event.reason; requestErrorReport({ source: 'renderer', operation: 'unhandledrejection', message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled renderer rejection'), technicalCode: 'renderer_unhandled_rejection', sensitiveDetails: { stack: reason instanceof Error ? reason.stack : undefined, reason: reason instanceof Error ? undefined : String(reason ?? ''), }, }); };
window.addEventListener('error', handleError); window.addEventListener('unhandledrejection', handleUnhandledRejection); return () => { window.removeEventListener('error', handleError); window.removeEventListener('unhandledrejection', handleUnhandledRejection); };
}, [desktopUpdateState.currentVersion]); useEffect(() => { let desktopApi: ReturnType<typeof getDesktopApi>; try { desktopApi = getDesktopApi(); } catch { return () => undefined; }
const unsubscribeInstall = desktopApi.onInstallProgress(({ appId, progress }) => { setInstallProgressByApp((current) => { const next = { ...current }; if (progress.phase === 'completed' || progress.phase === 'failed' || progress.phase === 'conflict') { delete next[appId]; } else { next[appId] = progress; }
return next; }); if (progress.phase === 'completed') { setBannerSeverity('success'); } else if (progress.phase === 'failed') { setBannerSeverity('error'); } else { setBannerSeverity('info'); }
setBannerMessage(progress.userMessage); void refreshApps(); if (progress.phase === 'completed') { setSelectedAppId(appId); }
}); const unsubscribeRuntime = desktopApi.onRuntimeStatusChanged((status) => { if (status.localNetworkShare) { setLocalNetworkShareStatus(status.localNetworkShare); } if (status.remoteNetworkShare) { maybeShowRemoteTunnelReadyDialog(status.remoteNetworkShare); } if (status.status === 'running') { setBannerSeverity('success'); setBannerMessage(status.userMessage ?? (status.localNetworkShare?.connectedAt ? t.localNetwork.connectedBanner : t.actions.running)); } else if (status.status === 'error') { setBannerSeverity('error'); setBannerMessage(status.userMessage ?? t.settings.authErrorFallback); requestErrorReport({ source: 'app', operation: 'runtime.status', message: status.userMessage ?? t.settings.authErrorFallback, technicalCode: 'app_runtime_error',
appId: status.appId, details: { status: status.status }, }); } else if (status.status === 'installed') { setBannerSeverity('info'); setBannerMessage(status.userMessage ?? t.actions.installed); }
void refreshApps(); }); const unsubscribeChat = desktopApi.onChatRunUpdated(({ run }) => { applyChatRunUpdate(run); }); for (const activeRunToHydrate of persistedChatState.activeRuns) { runConversationIdByRunRef.current.set(activeRunToHydrate.runId, activeRunToHydrate.conversationId); setActiveConversationByApp((current) => current[activeRunToHydrate.appId] === activeRunToHydrate.conversationId ? current : { ...current, [activeRunToHydrate.appId]: activeRunToHydrate.conversationId }); if ((selectedAppIdRef.current ?? FREE_CHAT_APP_ID) === activeRunToHydrate.appId) { setActiveConversationId(activeRunToHydrate.conversationId); } void desktopApi.chatGetRun({ runId: activeRunToHydrate.runId }).then((run) => { if (run) { applyChatRunUpdate(run); return; }
clearActiveRunState(activeRunToHydrate.runId); }).catch(() => clearActiveRunState(activeRunToHydrate.runId)); } const unsubscribeAutomation = desktopApi.onAutomationUpdated(({ automation, run }) => { setAutomations((current) => { const withoutCurrent = current.filter((item) => item.id !== automation.id); return [automation, ...withoutCurrent].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)); }); upsertAutomationBackgroundTask(automation, run); if (selectedAutomationIdRef.current === automation.id) { void desktopApi.automationsListRuns(automation.id).then((runs) => { setAutomationRuns(runs);
const targetRunId = run?.id ?? selectedAutomationRun?.id ?? runs[0]?.id; if (!targetRunId) { setSelectedAutomationRun(null); return; }
void desktopApi.automationsGetRunTranscript(targetRunId).then(setSelectedAutomationRun); }); }
}); const unsubscribeBackgroundTask = desktopApi.onBackgroundTaskUpdated(({ task }) => { mergeBackgroundTask(task); }); const unsubscribeDesktopUpdate = desktopApi.onDesktopUpdateProgress((state) => { setDesktopUpdateState(state); }); const unsubscribeForgerAccount = desktopApi.onForgerAccountUpdated((account) => { setForgerAccount(account); setForgerAccountMessage(account.userMessage ?? null); if (account.authenticated) { void desktopApi.getForumParticipation().then((state) => { setForumParticipation(state); setForumPromptOpen(state.status === 'opted_out' && !state.firstPromptShownAt); }).catch(() => undefined); } else { setForumParticipation(initialForumParticipation); setForumPromptOpen(false); } }); const unsubscribeErrorReport = desktopApi.onDesktopErrorReportRequested((report) => { prepareAndOpenErrorReport(report); }); const unsubscribeDeepLink = desktopApi.onDeepLink((link) => {
  const socialProfileLink = link as typeof link & { kind: string; username?: string | null };
  if (socialProfileLink.kind === 'social-profile') {
    const username = socialProfileLink.username?.trim().replace(/^@/, '');
    if (!username) {
      setBannerSeverity('error');
      setBannerMessage('No pudimos abrir este perfil de Social.');
      return;
    }
    window.sessionStorage.setItem('forger.social.last-tab', 'profile');
    setSocialProfileUsername(username);
    setCurrentView('friends');
    return;
  }
	if (link.kind === 'social-app') { setBannerSeverity('info'); setBannerMessage(link.code ? 'Abriendo invitacion de Social. Revisa la app antes de instalarla.' : 'Abriendo app publica de Social.'); const openSocialApp = link.code ? desktopApi.resolveSocialCode(link.code) : link.id ? desktopApi.resolveSocialApp(link.id) : Promise.reject(new Error('social_app_link_invalid')); void openSocialApp.then((payload) => { const details = socialAppDetails(payload.app, link.code ?? undefined); setAppDetailsBackView('catalog'); setSelectedAppDetailsId(details.social?.localAppId ?? details.app.id); setSelectedAppDetails(details); setAppSecretsState(null); setCurrentView('app'); }).catch(() => { setBannerSeverity('error'); setBannerMessage('No pudimos abrir esta app de Social.'); }); return; }
if (link.kind !== 'chat') return; const requestedName = link.app?.trim() || null; let targetAppId: string | null = null; if (requestedName) { const exact = installedAppsRef.current.find((entry) => entry.id === requestedName); const devVariant = installedAppsRef.current.find( (entry) => entry.id === `${requestedName}-dev`, ); targetAppId = exact?.id ?? devVariant?.id ?? null; if (!targetAppId) { console.warn('[deep-link] unknown app, falling back to free chat:', requestedName); }
}
if (targetAppId) { setSelectedAppId(targetAppId); } else { setSelectedAppId(null); }
setCurrentView('chat'); if (link.prompt) { setChatDraft(targetAppId ?? FREE_CHAT_APP_ID, link.prompt); }
}); return () => { unsubscribeInstall(); unsubscribeRuntime(); unsubscribeChat(); unsubscribeAutomation(); unsubscribeBackgroundTask(); unsubscribeDesktopUpdate(); unsubscribeForgerAccount(); unsubscribeErrorReport(); unsubscribeDeepLink(); };
}, []); useEffect(() => { selectedAutomationIdRef.current = selectedAutomationId; }, [selectedAutomationId]); useEffect(() => { activeConversationIdRef.current = activeConversationId; }, [activeConversationId]); useEffect(() => { selectedAppIdRef.current = selectedAppId; }, [selectedAppId]); useEffect(() => { chatConversationsRef.current = chatConversations; }, [chatConversations]); useEffect(() => { installedAppsRef.current = installedApps; }, [installedApps]); useEffect(() => { if (typeof window === 'undefined') { return; }
window.localStorage.setItem( CHAT_STORAGE_KEY, JSON.stringify({ conversations: chatConversations, activeConversationByApp, lastActiveConversationId: activeConversationId, activeRuns: Object.values(activeChatRunsByConversation).map(({ runId, conversationId, appId }) => ({ runId, conversationId, appId })), draftInputByConversationId: chatDraftsByConversation, } satisfies PersistedChatState), ); }, [chatConversations, activeConversationByApp, activeConversationId, activeChatRunsByConversation, chatDraftsByConversation]); useEffect(() => { if (activeConversationId && chatConversations.some((conversation) => conversation.id === activeConversationId)) { return; }
const fallback = [...chatConversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]?.id ?? null; setActiveConversationId(fallback); }, [activeConversationId, chatConversations]); useEffect(() => { if (currentView !== 'datos') { return; }
if (selectedDataAppId) { return; }
const installedOnly = installedApps.filter((a) => a.status === 'installed' || a.status === 'running'); if (installedOnly.length === 0) { return; }
setSelectedDataAppId(installedOnly[0].id); }, [currentView, selectedDataAppId, installedApps]); useEffect(() => { if (currentView !== 'files') { return; }
void refreshFiles(fileFilters); }, [currentView, fileFilters]); useEffect(() => { if (currentView !== 'backups') { return; }
void refreshBackups().catch(() => { setBannerSeverity('error'); setBannerMessage(t.sections.backups.loadError); }); }, [currentView, installedApps]); useEffect(() => { if (currentView !== 'secrets') { return; }
void refreshUserSecrets().catch(() => { setBannerSeverity('error'); setBannerMessage('No pudimos cargar tus secretos.'); }); }, [currentView]); useEffect(() => { if (currentView !== 'chat') { return; }
void refreshFiles({ sortBy: 'uploadedAt', sortDirection: 'desc' }); }, [currentView]); useEffect(() => { if (currentView !== 'app' || !selectedAppDetailsId || selectedAppDetails?.social?.localAppId === selectedAppDetailsId) { return; }
const desktopApi = getDesktopApi(); void desktopApi.getAppDetails(selectedAppDetailsId).then((details) => { setSelectedAppDetails(details); if (details?.installed) { void refreshAppSecrets(selectedAppDetailsId).catch(() => { setBannerSeverity('error'); setBannerMessage('No pudimos cargar los secretos de esta app.'); }); void refreshSelectedAppToolGate(selectedAppDetailsId).catch(() => setSelectedAppToolGate(null)); } else { setAppSecretsState(null); setSelectedAppToolGate(null); }
}); }, [currentView, selectedAppDetailsId, selectedAppDetails?.social?.localAppId, installedApps, catalogApps]); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(THEME_STORAGE_KEY, themePreference); }
}, [themePreference]); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference); }
}, [languagePreference]); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(EARLY_ACCESS_STORAGE_KEY, String(earlyAccessEnabled)); }
}, [earlyAccessEnabled]); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, String(advancedMode)); }
}, [advancedMode]); useEffect(() => { if (currentView === 'catalog') { submitUsageEvent({ eventName: 'catalog_viewed', surface: 'catalog', locale: t.locale, stringParameters: { filter: catalogFilter, status_filter: catalogStatusFilter } }); } else if (currentView === 'feedback') { submitUsageEvent({ eventName: 'feedback_opened', surface: 'feedback', locale: t.locale, stringParameters: { target: 'product' } }); } }, [catalogFilter, catalogStatusFilter, currentView, t.locale]); useEffect(() => { if (typeof window === 'undefined') { return undefined; }
const handleLanguageChange = () => setSystemLocale(resolveSystemLocale()); window.addEventListener('languagechange', handleLanguageChange); return () => window.removeEventListener('languagechange', handleLanguageChange); }, []); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(CODEX_MODEL_STORAGE_KEY, selectedCodexModel); }
}, [selectedCodexModel]); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(CODEX_REASONING_STORAGE_KEY, selectedCodexReasoningEffort); }
}, [selectedCodexReasoningEffort]); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(CHAT_AGENT_PROVIDER_STORAGE_KEY, selectedAgentProvider); }
}, [selectedAgentProvider]); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(CLAUDE_MODEL_STORAGE_KEY, selectedClaudeModel); }
}, [selectedClaudeModel]); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(CLAUDE_EFFORT_STORAGE_KEY, selectedClaudeEffort); }
}, [selectedClaudeEffort]); useEffect(() => { if (typeof window !== 'undefined') { window.localStorage.setItem(CHAT_BOT_PICTURE_STORAGE_KEY, chatBotPicture); }
}, [chatBotPicture]); const getAppMeta = (appId: string) => { const fromCatalog = catalogApps.find((appEntry) => appEntry.id === appId); if (fromCatalog?.name) { return { name: fromCatalog.name, description: fromCatalog.description ?? '', iconUrl: fromCatalog.iconUrl, };
}
const fromInstalled = installedApps.find((appEntry) => appEntry.id === appId); if (fromInstalled?.name) { return { name: fromInstalled.name, description: fromInstalled.description ?? '', iconUrl: fromInstalled.iconUrl, };
}
return ( t.apps[appId as keyof typeof t.apps] ?? { name: appId, description: '', iconUrl: undefined, }
); };
const setActiveConversationRuns = (updater: (current: Record<string, ActiveConversationRun>) => Record<string, ActiveConversationRun>) => {
  setActiveChatRunsByConversation((current) => {
    const next = updater(current);
    activeChatRunsByConversationRef.current = next;
    return next;
  });
};
const clearActiveRunState = (runId?: string, conversationId?: string | null) => {
  setActiveConversationRuns((current) => {
    const next = { ...current };
    if (conversationId) {
      delete next[conversationId];
    }
    for (const [activeConversationRunId, activeRun] of Object.entries(current)) {
      if (!runId || activeRun.runId === runId) {
        delete next[activeConversationRunId];
      }
    }
    return next;
  });
  if (runId) { runConversationIdByRunRef.current.delete(runId); }
};
const applyChatRunUpdate = (run: ChatRun) => { const currentActiveConversationId = activeConversationIdRef.current; const runConversationId = typeof run.conversationId === 'string' && run.conversationId.trim().length > 0 ? run.conversationId : null; traceChatEvent({ event: 'chat_run_event_received', runId: run.runId, appId: run.appId, conversationId: runConversationId, activeConversationId: currentActiveConversationId, status: run.status, messageCount: run.progressLog?.length ?? 0 }); const isTerminal = isTerminalChatRunStatus(run.status); if (runConversationId) { runConversationIdByRunRef.current.set(run.runId, runConversationId); if (!isTerminal) { const activeRun = activeRunFromChatRun(run); if (activeRun) { setActiveConversationRuns((current) => ({ ...current, [runConversationId]: { ...activeRun, status: run.status, progressLog: run.progressLog ?? [] } })); } setActiveConversationByApp((current) => current[run.appId] === runConversationId ? current : { ...current, [run.appId]: runConversationId }); if (!currentActiveConversationId || currentActiveConversationId === runConversationId) { setActiveConversationId(runConversationId); } setChatConversations((currentConversations) => { if (currentConversations.some((conversation) => conversation.id === runConversationId)) { return currentConversations; } const now = new Date().toISOString(); const mode = run.appId === FREE_CHAT_APP_ID ? 'free_chat' : 'edit_app'; return [{ id: runConversationId, appId: run.appId, mode, targetAppId: mode === 'edit_app' ? run.appId : null, title: getAppMeta(run.appId).name, threadId: typeof run.threadId === 'string' && run.threadId.trim().length > 0 ? run.threadId : null, createdAt: run.createdAt ?? now, updatedAt: run.updatedAt ?? now, messages: [], }, ...currentConversations]; }); } }
if (isTerminal) { clearActiveRunState(run.runId, runConversationId); }
if (run.status === 'needs_permission' && run.permissionRequest) { const dedupePermissionKey = `${run.runId}:needs_permission:${run.permissionRequest.requestId}`;
if (!deliveredRunRepliesRef.current.has(dedupePermissionKey)) { const targetConversationId = runConversationId ?? runConversationIdByRunRef.current.get(run.runId) ?? activeConversationIdRef.current; if (targetConversationId) { deliveredRunRepliesRef.current.add(dedupePermissionKey); const permissionRequest = run.permissionRequest; const messageId = `assistant-permission-${run.runId}-${permissionRequest.requestId}`; console.info('[Forger permission] rendering request', { runId: run.runId, requestId: permissionRequest.requestId, permission: permissionRequest.permission,
resource: permissionRequest.resource, targetConversationId, }); setChatConversations((currentConversations) => appendChatMessageToConversationOnce(currentConversations, targetConversationId, { id: messageId, role: 'assistant', content: t.sections.chat.permissionPrompt(permissionRequest.resource), action: {
type: 'permission',
runId: run.runId, request: permissionRequest, status: 'pending', }, })); } else { console.warn('[Forger permission] request received without an active conversation target', { runId: run.runId, requestId: run.permissionRequest.requestId, permission: run.permissionRequest.permission, resource: run.permissionRequest.resource, }); setBannerSeverity('warning'); setBannerMessage(t.sections.chat.permissionPrompt(run.permissionRequest.resource)); }
}
return; }
const isMessageTerminal = isMessageTerminalChatRunStatus(run.status);
const assistantContent = typeof run.userMessage === 'string' && run.userMessage.trim().length > 0 ? run.userMessage : run.questionRequest ? t.sections.chat.questionPrompt : '';
const hasMessage = assistantContent.trim().length > 0; const dedupeKey = `${run.runId}:${run.status}`; const messageId = `assistant-run-${run.runId}-${run.status}`; if (!isMessageTerminal || !hasMessage || deliveredRunRepliesRef.current.has(dedupeKey)) { if (isTerminal) { runConversationIdByRunRef.current.delete(run.runId); }
return; }
const targetConversationId = runConversationId ?? runConversationIdByRunRef.current.get(run.runId) ?? activeConversationIdRef.current; if (!targetConversationId) { traceChatEvent({ event: 'chat_run_message_append_attempt', runId: run.runId, appId: run.appId, conversationId: null, activeConversationId: activeConversationIdRef.current, status: run.status, foundConversation: false }); return; }
deliveredRunRepliesRef.current.add(dedupeKey);
const foundConversation = chatConversationsRef.current.some((conversation) => conversation.id === targetConversationId); traceChatEvent({ event: 'chat_run_message_append_attempt', runId: run.runId, appId: run.appId, conversationId: targetConversationId, activeConversationId: activeConversationIdRef.current, status: run.status, foundConversation });
const questionAction = run.questionRequest ? { type: 'question' as const, runId: run.runId, request: run.questionRequest, status: 'pending' as const } : undefined;
setChatConversations((currentConversations) => appendChatMessageToConversationOnce(currentConversations, targetConversationId, { id: messageId, role: 'assistant', content: assistantContent, ...(questionAction ? { action: questionAction } : {}), }, { threadId: run.threadId })); traceChatEvent({ event: 'chat_run_message_appended', runId: run.runId, appId: run.appId, conversationId: targetConversationId, activeConversationId: activeConversationIdRef.current, status: run.status, foundConversation }); if (run.createdApp) { if (!createdAppUsageEventsRef.current.has(run.runId)) { createdAppUsageEventsRef.current.add(run.runId); submitUsageEvent({ eventName: 'local_app_created', surface: 'chat', locale: t.locale }); } void refreshApps(); }
if (isTerminal) { runConversationIdByRunRef.current.delete(run.runId); }
};
const getCategoryLabel = (category: AppCategory) => t.appCategories[category]; const maybeShowRemoteTunnelReadyDialog = (status?: RemoteNetworkShareStatus | null) => { if (!status || !status.active || (status.state !== 'waiting_for_session' && status.state !== 'connected')) { return; }
const sessionKey = status.sessionId || `${status.appId}:${status.frontendUrl || status.portalUrl || status.tunnelUrl || ''}`; if (!sessionKey || remoteTunnelReadySessionsRef.current.has(sessionKey)) { return; }
remoteTunnelReadySessionsRef.current.add(sessionKey); setRemoteTunnelReadyDialog({ open: true, appId: status.appId, appName: getAppMeta(status.appId).name, portalUrl: t.remoteNetwork.portalUrl, sessionId: status.sessionId }); };
const remoteNetworkStartMessage = (result: { success: boolean; userMessage?: string; technicalCode?: string; status?: RemoteNetworkShareStatus }) => { if (result.success) { return result.status?.state === 'waiting_for_session' ? t.remoteNetwork.waitingBadge : t.remoteNetwork.active; }
if (result.technicalCode === 'remote_tunnel_not_supported') { return t.remoteNetwork.notSupported; }
if (result.technicalCode === 'forger_cloud_required') { return t.remoteNetwork.cloudRequired; }
if (result.technicalCode === 'app_not_running') { return t.remoteNetwork.appNotRunning; }
if (result.status?.state === 'error' || result.technicalCode?.startsWith('remote_tunnel_') || result.technicalCode?.startsWith('localtunnel_')) { return t.remoteNetwork.prepareError; }
return t.remoteNetwork.startError; };
const remoteNetworkStopMessage = (result: { success: boolean }) => result.success ? t.remoteNetwork.stopped : t.remoteNetwork.stopError;
const resetIdleChatProgress = () => { if (!chatRunActive) { deliveredRunRepliesRef.current.clear(); } }; const setChatContext = (appId: string) => { const appEntry = installedApps.find((app) => app.id === appId) ?? catalogApps.find((app) => app.id === appId); if (!appEntry) { return; }
setSelectedAppId(appEntry.id); setCurrentView('chat'); resetIdleChatProgress(); };
const openAppDetails = async (appId: string, backView: View = currentView) => { setAppDetailsBackView(backView); setSelectedAppDetailsId(appId); setSelectedAppToolGate(null); setCurrentView('app'); const details = await getDesktopApi().getAppDetails(appId); setSelectedAppDetails(details); if (details?.installed) { void refreshSelectedAppToolGate(appId).catch(() => setSelectedAppToolGate(null)); } };
const handleSelectChatApp = (appId: string | null) => { if (!appId) { setSelectedAppId(null); resetIdleChatProgress(); return; }
setChatContext(appId); };
const performInstall = async (appId: string) => { submitUsageEvent({ eventName: 'app_install_started', surface: 'catalog', locale: t.locale, stringParameters: { app_id: appId } }); try { const desktopApi = getDesktopApi(); const result = await desktopApi.installApp(appId, activeLocale); await refreshApps(); if (result.success) { submitUsageEvent({ eventName: 'app_install_succeeded', surface: 'catalog', locale: t.locale, stringParameters: { app_id: appId } }); setBannerSeverity('success'); setBannerMessage(result.userMessage || t.banners.installed(getAppMeta(appId).name)); const welcome = await desktopApi.installWelcome(appId, activeLocale); if (welcome.success && welcome.message) { createInstallWelcomeConversation(appId, welcome.message); setSelectedAppId(appId);
setCurrentView('chat'); }
} else { submitUsageEvent({ eventName: 'app_install_failed', surface: 'catalog', locale: t.locale, stringParameters: { app_id: appId, phase: result.phase ?? 'unknown', technical_code: result.technicalCode ?? 'install_failed' } }); setBannerSeverity('error'); setBannerMessage(result.userMessage); requestErrorReportFromResult('app', 'install', result, { appId, appVersion: installedApps.find((appEntry) => appEntry.id === appId)?.version, }); }
} catch (error) { submitUsageEvent({ eventName: 'app_install_failed', surface: 'catalog', locale: t.locale, stringParameters: { app_id: appId, phase: 'exception', technical_code: 'install_unhandled_error' } }); setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); requestErrorReport({ source: 'app', operation: 'install', message: error instanceof Error ? error.message : t.settings.authErrorFallback, technicalCode: 'install_unhandled_error', appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); }
};
const handleInstall = async (appId: string) => { const social = selectedAppDetails?.social?.localAppId === appId ? selectedAppDetails.social : undefined; if (social) { submitUsageEvent({ eventName: 'app_install_started', surface: 'social', locale: t.locale, stringParameters: { app_id: appId } }); const result = await getDesktopApi().installSocialApp({ appId: social.shareCode ? undefined : social.app.id, shareCode: social.shareCode, trustDecision: 'not_reviewed' }, activeLocale); await refreshApps(); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); if (result.success && result.appId) { submitUsageEvent({ eventName: 'app_install_succeeded', surface: 'social', locale: t.locale, stringParameters: { app_id: result.appId } }); setSelectedAppDetails(await getDesktopApi().getAppDetails(result.appId)); setSelectedAppDetailsId(result.appId); setSelectedAppId(result.appId); } else if (!result.success) { requestErrorReportFromResult('app', 'social-install', result, { appId }); } return; }
try { const gate = await getDesktopApi().getAppToolsInstallGate(appId, activeLocale); if (gate) { setPendingInstallGate(gate); return; }
} catch { }
await performInstall(appId); };
const startCreatedAppConversation = async (app: { appId: string; name: string; description: string; purpose: string; agentPrompt?: string; lookAndFeel?: string }) => {
const chatScopeId = app.appId; const now = new Date().toISOString(); const conversationId = makeConversationId(); const userVisibleContent = t.sections.create.userMessage(app.name, app.description, app.purpose, app.lookAndFeel); const injectedPrompt = app.agentPrompt?.trim() || t.sections.create.injectedPrompt(app.name, app.description, app.purpose, app.lookAndFeel); const defaultRuntime = runtimeFromUserDefaults({ codexAuthenticated: codexAuthStatus.authenticated, claudeAuthenticated: claudeAuthStatus.authenticated, defaultProvider: settings.defaultAgentProvider, defaults: settings.agentDefaults, providerConnections: settings.providerConnections, }); const runtimeDraft = runtimeDraftFromRuntime(defaultRuntime); const conversation: ChatConversation = { id: conversationId, appId: chatScopeId, mode: 'edit_app', targetAppId: chatScopeId, title: t.sections.create.startPromptTitle(app.name), threadId: null, runtime: defaultRuntime, createdAt: now, updatedAt: now, messages: [ { id: `user-created-app-${Date.now()}`, role: 'user', content: userVisibleContent, }, ], };
setChatConversations((current) => [conversation, ...current]); setActiveConversationId(conversationId); setActiveConversationByApp((current) => ({ ...current, [chatScopeId]: conversationId })); setSelectedAppId(chatScopeId); setCurrentView('chat'); setChatDraft(conversationId, ''); resetIdleChatProgress(); const hasAgentProvider = codexAuthStatus.authenticated || claudeAuthStatus.authenticated; if (!hasAgentProvider) { setAgentProviderConfigOpen(true); return; }
setStartingConversationIds((current) => new Set(current).add(conversationId)); try { const startResult = await getDesktopApi().chatStartRun({ appId: chatScopeId, chatMode: 'edit_app', targetAppId: chatScopeId, prompt: injectedPrompt, threadId: null, conversationHistory: [ { role: 'user', content: userVisibleContent, }, ], userLanguage: activeLocale, sharedFiles: [], ...runtimeDraft, permissionMode: selectedChatPermissionMode, networkAccess: selectedChatNetworkAccess, conversationId, }); runConversationIdByRunRef.current.set(startResult.runId, conversationId); setActiveConversationRuns((current) => ({ ...current, [conversationId]: { runId: startResult.runId, conversationId, appId: chatScopeId, status: startResult.status, progressLog: [] } })); submitUsageEvent({ eventName: 'chat_started', surface: 'create', locale: t.locale, stringParameters: { app_id: chatScopeId, provider: runtimeDraft.provider } }); } catch (error) { clearActiveRunState(undefined, conversationId); const detail = error instanceof Error ? error.message : t.settings.authErrorFallback; setChatConversations((currentConversations) => currentConversations.map((item) => item.id === conversationId ? { ...item, updatedAt: new Date().toISOString(), messages: [ ...item.messages, { id: `assistant-error-${Date.now()}`, role: 'assistant', content: t.sections.chat.sendFailed(detail), }, ], } : item)); requestErrorReport({ source: 'agent', operation: 'create-app.chat-start-run', message: detail, technicalCode: 'create_app_chat_start_failed', appId: chatScopeId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setStartingConversationIds((current) => { const next = new Set(current); next.delete(conversationId); return next; }); }
};
const handleCreateLocalApp = async (input: { name: string; description: string; purpose: string; lookAndFeel?: string }) => { if (createLocalAppBusy) { return; }
setCreateLocalAppBusy(true); try { const result = await getDesktopApi().createLocalApp(input, activeLocale); await refreshApps(); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.success ? t.sections.create.success : result.userMessage); if (result.success && result.app) { await startCreatedAppConversation(result.app); } else if (!result.success) { requestErrorReportFromResult('app', 'create-local-app', result); } } catch (error) { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); requestErrorReport({ source: 'app', operation: 'create-local-app', message: error instanceof Error ? error.message : t.settings.authErrorFallback, technicalCode: 'create_local_app_unhandled_error', sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setCreateLocalAppBusy(false); }
};
const uploadSocialApp = async (appId: string, visibility: SocialUploadVisibility) => { setBannerSeverity('info'); setBannerMessage(t.locale === 'es' ? 'Subiendo app a Social en background.' : 'Uploading app to Social in the background.'); setBackgroundTasksDrawerOpen(true); try { const result = await getDesktopApi().uploadSocialApp({ appId, visibility }); await Promise.all([refreshApps(), refreshCloudStorageUsage()]); setBannerSeverity(result.success ? 'success' : 'error'); const uploadMessage = result.userMessage ?? (t.locale === 'es' ? 'App subida a Social.' : 'App uploaded to Social.'); setBannerMessage(result.success ? (result.share?.deepLink ? `${uploadMessage} ${result.share.deepLink}` : uploadMessage) : uploadMessage); if (!result.success) { requestErrorReportFromResult('app', 'social-upload', result, { appId }); } } catch (error) { setBannerSeverity('error'); setBannerMessage(t.locale === 'es' ? 'No pudimos subir la app a Social.' : 'We could not upload the app to Social.'); requestErrorReport({ source: 'app', operation: 'social-upload', message: error instanceof Error ? error.message : 'social_upload_unhandled_error', technicalCode: 'social_upload_unhandled_error', appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); }
};
const handleUploadSocial = (appId: string) => { setSocialUploadDialog({ open: true, appId, visibility: 'private' }); };
const closeSocialUploadDialog = () => { setSocialUploadDialog((current) => ({ ...current, open: false })); };
const setSocialUploadVisibility = (visibility: SocialUploadVisibility) => { setSocialUploadDialog((current) => ({ ...current, visibility })); };
const submitSocialUploadDialog = async () => { const { appId, visibility } = socialUploadDialog; if (!appId) { return; }
setSocialUploadDialog((current) => ({ ...current, open: false })); void uploadSocialApp(appId, visibility);
};
const activeBackgroundTaskCount = backgroundTasks.filter((task) => task.status === 'queued' || task.status === 'running').length;
const openBackgroundTaskHistory = () => { setBackgroundTasksBackView(currentView === 'backgroundTasks' || currentView === 'backgroundTaskDetail' ? backgroundTasksBackView : currentView); setBackgroundTasksDrawerOpen(false); setCurrentView('backgroundTasks'); };
const openBackgroundTaskDetail = (taskId: string) => { setSelectedBackgroundTaskId(taskId); setBackgroundTasksDrawerOpen(false); setCurrentView('backgroundTaskDetail'); };
const backFromBackgroundTaskHistory = () => { setCurrentView(backgroundTasksBackView); };
const backFromBackgroundTaskDetail = () => { setCurrentView('backgroundTasks'); };
const handleConfirmInstallWithTools = async () => { if (!pendingInstallGate) { return; }
if (!pendingInstallGate.canInstall) { setBannerSeverity('warning'); setBannerMessage(t.installGate.missingRequiredTools); return; }
setPendingInstallBusy(true); const appId = pendingInstallGate.appId; setPendingInstallGate(null); await performInstall(appId); setPendingInstallBusy(false); };
const handleOptionalToolGrant = async (toolId: string, granted: boolean) => { if (!pendingInstallGate) { return; }
const updated = await getDesktopApi().setAppToolGrant({ appId: pendingInstallGate.appId, toolId, granted }, activeLocale); if (updated) { setPendingInstallGate(updated); }
};
const handleAppDetailsToolGrant = async (toolId: string, granted: boolean) => { if (!selectedAppDetailsId) { return; }
setSelectedAppToolGrantBusyId(toolId); try { const updated = await getDesktopApi().setAppToolGrant({ appId: selectedAppDetailsId, toolId, granted }, activeLocale); setSelectedAppToolGate(updated); if (pendingInstallGate?.appId === selectedAppDetailsId && updated) { setPendingInstallGate(updated); } } catch { setBannerSeverity('error'); setBannerMessage(t.appView.toolsGrantError); } finally { setSelectedAppToolGrantBusyId((current) => current === toolId ? null : current); }
};
const renderInstallTool = (item: AppToolsInstallGate['required'][number] | AppToolsInstallGate['optional'][number], required: boolean) => { const configured = item.available && item.configured; const statusLabel = configured ? t.installGate.toolActive : item.available ? t.installGate.toolNeedsConfiguration : t.installGate.toolInactive; return ( <Paper key={`${required ? 'required' : 'optional'}-${item.declaration.toolId}`} variant="outlined"
sx={{ p: 1.5, borderRadius: 1, borderColor: 'divider', bgcolor: 'background.paper' }} > <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="flex-start"> <Stack spacing={0.75} sx={{ minWidth: 0 }}> <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap> <Typography fontWeight={700}>{item.tool?.name ?? item.declaration.toolId}</Typography> <Chip size="small" label={required ? t.installGate.requiredTool : t.installGate.optionalTool}
sx={{ height: 24, fontWeight: 650, bgcolor: 'action.hover' }} /> <Chip size="small" label={statusLabel} sx={{ height: 24, fontWeight: 700, color: configured ? 'success.main' : 'warning.main', borderColor: configured ? 'success.main' : 'warning.main', bgcolor: configured ? 'rgba(46, 125, 50, 0.12)' : 'rgba(237, 108, 2, 0.12)', }} variant="outlined" /> </Stack> <Typography variant="body2" color="text.secondary"> {item.declaration.reason} </Typography> </Stack> {required ? ( !configured ? ( <Button size="small"
sx={{ flexShrink: 0 }} onClick={() => { setPendingInstallGate(null); setCurrentView('tools'); }} > {t.installGate.openTools} </Button> ) : null ) : ( <Switch checked={item.granted} onChange={(event) => void handleOptionalToolGrant(item.declaration.toolId, event.target.checked)} /> )} </Stack> </Paper> ); };
const renderInstallItem = (item: AppAgent | AppPromptTemplate) => ( <Paper key={item.id} variant="outlined" sx={{ p: 1.5, borderRadius: 1, borderColor: 'divider', bgcolor: 'background.paper' }}> <Stack spacing={0.5}> <Typography fontWeight={700}>{item.title}</Typography> {item.description ? ( <Typography variant="body2" color="text.secondary"> {item.description} </Typography> ) : null} </Stack> </Paper> ); const handleUpdate = async (appId: string) => { try { const desktopApi = getDesktopApi();
const result = await desktopApi.updateApp(appId, activeLocale); await refreshApps(); setBannerSeverity(result.success ? 'success' : result.phase === 'conflict' ? 'warning' : 'error'); setBannerMessage(result.userMessage); requestErrorReportFromResult('app', 'update', result, { appId, appVersion: installedApps.find((appEntry) => appEntry.id === appId)?.version, details: { phase: result.phase }, }); if (selectedAppDetailsId === appId) { setSelectedAppDetails(await desktopApi.getAppDetails(appId)); }
} catch (error) { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); requestErrorReport({ source: 'app', operation: 'update', message: error instanceof Error ? error.message : t.settings.authErrorFallback, technicalCode: 'update_unhandled_error', appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); }
};
const handleCreateBackup = async (appId: string) => { setBackupsBusy(true); try { const result = await getDesktopApi().createBackup({ appId, reason: 'manual' }); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); await refreshBackups(); } catch (error) { setBannerSeverity('error'); setBannerMessage(t.sections.backups.createError); requestErrorReport({ source: 'desktop', operation: 'backup.create',
message: error instanceof Error ? error.message : t.sections.backups.createError, technicalCode: 'backup_create_unhandled_error', appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setBackupsBusy(false); }
};
const handleDeleteBackup = async (backup: AppBackupSummary) => { if (!window.confirm(t.sections.backups.deleteConfirm(backup.appName))) { return; }
setBackupsBusy(true); try { const result = await getDesktopApi().deleteBackup({ appId: backup.appId, backupId: backup.backupId }); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); await refreshBackups(); } catch (error) { setBannerSeverity('error'); setBannerMessage(t.sections.backups.loadError); requestErrorReport({ source: 'desktop', operation: 'backup.delete', message: error instanceof Error ? error.message : t.sections.backups.loadError,
technicalCode: 'backup_delete_unhandled_error', appId: backup.appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setBackupsBusy(false); }
};
const handleRestoreBackup = async (backup: AppBackupSummary) => { if (!window.confirm(t.sections.backups.restoreConfirm(backup.appName))) { return; }
setBackupsBusy(true); try { const result = await getDesktopApi().restoreBackup({ appId: backup.appId, backupId: backup.backupId }); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); await Promise.all([refreshBackups(), refreshApps()]); } catch (error) { setBannerSeverity('error'); setBannerMessage(t.sections.backups.loadError); requestErrorReport({ source: 'desktop', operation: 'backup.restore',
message: error instanceof Error ? error.message : t.sections.backups.loadError, technicalCode: 'backup_restore_unhandled_error', appId: backup.appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setBackupsBusy(false); }
};
const openCloudUpsell = () => { setForgerAccountMessage(t.cloud.backupsUpsellBody); setCloudModalOpen(true); };
const handleSyncNow = async (appId: string) => { setBackupsBusy(true); try { const result = await getDesktopApi().createRemoteBackup({ appId, backupType: 'sync_snapshot', source: 'manual' }); if (result.technicalCode === 'cloud_account_required' || result.technicalCode === 'subscription_required') { openCloudUpsell(); }
setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); await refreshBackups(); } catch (error) { setBannerSeverity('error'); setBannerMessage(t.sections.backups.cloudCreateError); requestErrorReport({ source: 'desktop', operation: 'backup.sync_now', message: error instanceof Error ? error.message : t.sections.backups.cloudCreateError, technicalCode: 'remote_backup_sync_unhandled_error', appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, });
} finally { setBackupsBusy(false); }
};
const handleDeleteRemoteBackup = async (backup: RemoteAppBackupSummary) => { if (!window.confirm(t.sections.backups.deleteConfirm(backup.appName))) { return; }
setBackupsBusy(true); try { const result = await getDesktopApi().deleteRemoteBackup(backup.id); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); await refreshBackups(); } catch (error) { setBannerSeverity('error'); setBannerMessage(t.sections.backups.loadError); requestErrorReport({ source: 'desktop', operation: 'backup.remote_delete', message: error instanceof Error ? error.message : t.sections.backups.loadError, technicalCode: 'remote_backup_delete_unhandled_error',
appId: backup.appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setBackupsBusy(false); }
};
const handleRestoreRemoteBackup = async (backup: RemoteAppBackupSummary) => { if (!window.confirm(t.sections.backups.restoreConfirm(backup.appName))) { return; }
setBackupsBusy(true); try { const result = await getDesktopApi().restoreRemoteBackup({ remoteBackupId: backup.id }); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); await Promise.all([refreshBackups(), refreshApps()]); } catch (error) { setBannerSeverity('error'); setBannerMessage(t.sections.backups.loadError); requestErrorReport({ source: 'desktop', operation: 'backup.remote_restore', message: error instanceof Error ? error.message : t.sections.backups.loadError,
technicalCode: 'remote_backup_restore_unhandled_error', appId: backup.appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setBackupsBusy(false); }
};
const handleSetAutoSync = async (appId: string, autoSync: boolean) => { try { const nextSettings = await getDesktopApi().setAppAutoSync(appId, autoSync); setCloudSyncSettings(nextSettings); setBannerSeverity('success'); setBannerMessage(autoSync ? t.sections.backups.autoSyncEnabled : t.sections.backups.autoSyncDisabled); } catch (error) { setBannerSeverity('error'); setBannerMessage(t.sections.backups.loadError); requestErrorReport({ source: 'desktop', operation: 'backup.auto_sync',
message: error instanceof Error ? error.message : t.sections.backups.loadError, technicalCode: 'auto_sync_setting_unhandled_error', appId, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); }
};
const handleAgentToolApprovalChange = async ( toolId: AgentToolDefinition['id'], requiresApproval: boolean, ) => { setAgentToolBusyId(toolId); setAgentToolError(null); setAgentToolErrorCode(null); try { const updated = await getDesktopApi().updateAgentToolApproval({ toolId, requiresApproval }); setAgentToolSettings(updated); } catch (_error) { setAgentToolError(t.sections.tools.saveError); setAgentToolErrorCode(null); } finally { setAgentToolBusyId(null); }
};
const runOfficialToolAction = async ( toolId: string, action: () => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>, ) => { setOfficialToolBusyId(toolId); setAgentToolError(null); setAgentToolErrorCode(null); try { const result = await action(); await refreshOfficialTools(); setBannerSeverity(result.success ? 'success' : 'error'); const userMessage = !result.success && result.technicalCode === 'forger_account_required' ? t.sections.tools.gmailAccountRequired : result.userMessage;
setBannerMessage(userMessage); if (!result.success) { setAgentToolError(userMessage); setAgentToolErrorCode(result.technicalCode ?? null); }
} catch (_error) { setAgentToolError(t.sections.tools.saveError); setAgentToolErrorCode(null); } finally { setOfficialToolBusyId(null); }
};
const runDesktopUpdateAction = async (action: () => Promise<DesktopUpdateState>) => { setDesktopUpdateBusy(true); try { const state = await action(); setDesktopUpdateState(state); if (state.userMessage) { setBannerSeverity(state.status === 'error' || state.status === 'unsupported' ? 'error' : 'info'); setBannerMessage(state.userMessage); }
if (state.status === 'error' && state.technicalCode) { requestErrorReport({ source: 'update', operation: 'desktop-update', message: state.userMessage ?? state.technicalCode, technicalCode: state.technicalCode, details: { status: state.status, availableVersion: state.availableVersion }, }); }
} catch (error) { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); requestErrorReport({ source: 'update', operation: 'desktop-update', message: error instanceof Error ? error.message : t.settings.authErrorFallback, technicalCode: 'desktop_update_unhandled_error', sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setDesktopUpdateBusy(false); }
};
const handleCreateMemory = async (input: MemoryCreateInput) => { try { const created = await getDesktopApi().memoryCreate(input); setMemories((current) => [created, ...current.filter((entry) => entry.id !== created.id)]); } catch (error) { setBannerSeverity('error'); setBannerMessage(error instanceof Error ? error.message : t.settings.memorySaveError); }
};
const handleUpdateMemory = async (input: MemoryUpdateInput) => { try { const updated = await getDesktopApi().memoryUpdate(input); setMemories((current) => current.map((entry) => (entry.id === updated.id ? updated : entry))); } catch (error) { setBannerSeverity('error'); setBannerMessage(error instanceof Error ? error.message : t.settings.memorySaveError); }
};
const handleDeleteMemory = async (id: string) => { try { await getDesktopApi().memoryDelete(id); setMemories((current) => current.filter((entry) => entry.id !== id)); } catch (error) { setBannerSeverity('error'); setBannerMessage(error instanceof Error ? error.message : t.settings.memoryDeleteError); }
};
const handleAgentDefaultsChange = async (input: UpdateAgentDefaultsInput) => { setSettings((current) => { const nextDefaultProvider = input.defaultProvider ?? current.defaultAgentProvider; const nextDefaultChatPermissionMode = input.defaultChatPermissionMode ?? current.defaultChatPermissionMode; const nextDefaultChatNetworkAccess = input.defaultChatNetworkAccess ?? current.defaultChatNetworkAccess; if (!input.provider) { return { ...current, defaultAgentProvider: nextDefaultProvider, defaultChatPermissionMode: nextDefaultChatPermissionMode, defaultChatNetworkAccess: nextDefaultChatNetworkAccess }; }
if (input.provider === 'codex') { const nextCodexDefaults = { model: input.model ?? current.agentDefaults.codex.model, reasoningEffort: (input.effort as CodexReasoningEffort | undefined) ?? current.agentDefaults.codex.reasoningEffort, };
return { ...current, defaultAgentProvider: nextDefaultProvider, defaultChatPermissionMode: nextDefaultChatPermissionMode, defaultChatNetworkAccess: nextDefaultChatNetworkAccess, codexDefaults: nextCodexDefaults, agentDefaults: { ...current.agentDefaults, codex: nextCodexDefaults, }, };
}
return { ...current, defaultAgentProvider: nextDefaultProvider, defaultChatPermissionMode: nextDefaultChatPermissionMode, defaultChatNetworkAccess: nextDefaultChatNetworkAccess, agentDefaults: { ...current.agentDefaults, claude: { model: input.model ?? current.agentDefaults.claude.model, effort: (input.effort as ClaudeEffort | undefined) ?? current.agentDefaults.claude.effort, }, }, };
}); try { const updated = await getDesktopApi().updateAgentDefaults(input); setSettings(updated); setSelectedChatPermissionMode(updated.defaultChatPermissionMode ?? 'safe'); setSelectedChatNetworkAccess(updated.defaultChatNetworkAccess !== false); setSelectedCodexModel(updated.agentDefaults.codex.model); setSelectedCodexReasoningEffort(updated.agentDefaults.codex.reasoningEffort); setSelectedClaudeModel(updated.agentDefaults.claude.model); setSelectedClaudeEffort(updated.agentDefaults.claude.effort); if (selectedAppDetailsId) { setSelectedAppDetails(await getDesktopApi().getAppDetails(selectedAppDetailsId)); }
} catch (error) { setBannerSeverity('error'); setBannerMessage(error instanceof Error ? error.message : t.settings.authErrorFallback); void getDesktopApi().getSettings().then(setSettings).catch(() => undefined); }
};
const handleDeveloperModeChange = async (input: UpdateDeveloperModeInput) => { const updated = await getDesktopApi().updateDeveloperMode(input); setSettings(updated); };
const handleRestoreUserVersion = async (appId: string) => { const desktopApi = getDesktopApi(); const result = await desktopApi.restoreAppUserVersion(appId); await refreshApps(); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage ?? t.settings.authErrorFallback); if (selectedAppDetailsId === appId) { setSelectedAppDetails(await desktopApi.getAppDetails(appId)); }
};
const handleResolveConflict = async (appId: string) => { const desktopApi = getDesktopApi(); const result = await desktopApi.resolveAppUpdateConflict(appId); if ('success' in result && !result.success) { setBannerSeverity('error'); setBannerMessage(result.userMessage ?? t.settings.authErrorFallback); return; }
setSelectedAppId(appId); setCurrentView('chat'); setBannerSeverity('info'); setBannerMessage(t.actions.resolveWithForger); };
const handleOpen = async (appId: string) => { if (openingAppIdsRef.current.has(appId)) { return; }
openingAppIdsRef.current = new Set(openingAppIdsRef.current).add(appId); setOpeningAppIds(new Set(openingAppIdsRef.current)); const desktopApi = getDesktopApi(); try { const result = await desktopApi.openApp(appId, activeLocale); if (result.success) { submitUsageEvent({ eventName: 'app_opened', surface: 'app', locale: t.locale, stringParameters: { app_id: appId } }); setBannerSeverity('success'); setBannerMessage(result.userMessage); } else { setBannerSeverity('error'); setBannerMessage(result.userMessage); requestErrorReportFromResult('app', 'open', result, { appId,
appVersion: installedApps.find((appEntry) => appEntry.id === appId)?.version, }); }
} catch (error) { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); requestErrorReport({ source: 'app', operation: 'open', message: error instanceof Error ? error.message : t.settings.authErrorFallback, technicalCode: 'open_app_unhandled_error', appId, appVersion: installedApps.find((appEntry) => appEntry.id === appId)?.version, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { const nextOpeningAppIds = new Set(openingAppIdsRef.current);
nextOpeningAppIds.delete(appId); openingAppIdsRef.current = nextOpeningAppIds; setOpeningAppIds(new Set(nextOpeningAppIds)); }
};
const handleStartLocalNetworkShare = async (appId: string) => { if (openingAppIdsRef.current.has(appId)) { return; }
openingAppIdsRef.current = new Set(openingAppIdsRef.current).add(appId); setOpeningAppIds(new Set(openingAppIdsRef.current)); const desktopApi = getDesktopApi(); try { const result = await desktopApi.startLocalNetworkShare(appId); setLocalNetworkShareStatus(result.status); setLocalNetworkShareDialogOpen(result.success); await refreshApps(); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.success ? t.localNetwork.waitingBadge : result.userMessage || t.localNetwork.startError); } catch { setBannerSeverity('error'); setBannerMessage(t.localNetwork.startError); } finally { const nextOpeningAppIds = new Set(openingAppIdsRef.current);
nextOpeningAppIds.delete(appId); openingAppIdsRef.current = nextOpeningAppIds; setOpeningAppIds(new Set(nextOpeningAppIds)); }
};
const handleStartRemoteNetworkShare = async (appId: string) => { if (openingAppIdsRef.current.has(appId)) { return; }
openingAppIdsRef.current = new Set(openingAppIdsRef.current).add(appId); setOpeningAppIds(new Set(openingAppIdsRef.current)); const desktopApi = getDesktopApi(); try { const result = await desktopApi.startRemoteNetworkShare(appId); await Promise.all([refreshApps(), refreshCloudStorageUsage()]); if (result.success) { maybeShowRemoteTunnelReadyDialog(result.status); } setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(remoteNetworkStartMessage(result)); } catch { setBannerSeverity('error'); setBannerMessage(t.remoteNetwork.startError); } finally { const nextOpeningAppIds = new Set(openingAppIdsRef.current);
nextOpeningAppIds.delete(appId); openingAppIdsRef.current = nextOpeningAppIds; setOpeningAppIds(new Set(nextOpeningAppIds)); }
};
const handleStopLocalNetworkShare = async (appId?: string) => { const targetAppId = appId ?? localNetworkShareStatus?.appId; if (!targetAppId) { return; }
const desktopApi = getDesktopApi(); try { const result = await desktopApi.stopLocalNetworkShare(targetAppId); setLocalNetworkShareStatus(result.status); setLocalNetworkShareDialogOpen(false); await refreshApps(); setBannerSeverity(result.success ? 'info' : 'error'); setBannerMessage(result.userMessage || (result.success ? t.localNetwork.stop : t.localNetwork.stopError)); } catch { setBannerSeverity('error'); setBannerMessage(t.localNetwork.stopError); }
};
const handleStopRemoteNetworkShare = async (appId: string) => { const desktopApi = getDesktopApi(); try { const result = await desktopApi.stopRemoteNetworkShare(appId); await Promise.all([refreshApps(), refreshCloudStorageUsage()]); setBannerSeverity(result.success ? 'info' : 'error'); setBannerMessage(remoteNetworkStopMessage(result)); } catch { setBannerSeverity('error'); setBannerMessage(t.remoteNetwork.stopError); }
};
const handleStop = async (appId: string) => { const desktopApi = getDesktopApi(); const result = await desktopApi.stopApp(appId); if (result.success) { setBannerSeverity('info'); setBannerMessage(result.userMessage); } else { setBannerSeverity('error'); setBannerMessage(result.userMessage); }
};
const handleRetry = async (appId: string) => { await handleInstall(appId); };
const refreshAppSecrets = async (appId: string) => { const desktopApi = getDesktopApi(); const nextState = await desktopApi.getAppSecrets(appId); setAppSecretsState(nextState); setUserSecrets(nextState.userSecrets); };
const refreshUserSecrets = async () => { const desktopApi = getDesktopApi(); const nextSecrets = await desktopApi.listUserSecrets(); setUserSecrets(nextSecrets); };
const runSecretMutation = async ( action: () => Promise<{ success: boolean; userMessage: string }>, targetAppId?: string | null, ) => { setSecretsBusy(true); try { const result = await action(); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); if (targetAppId) { await refreshAppSecrets(targetAppId); } else { await refreshUserSecrets(); }
} catch { setBannerSeverity('error'); setBannerMessage('No pudimos actualizar los secretos.'); } finally { setSecretsBusy(false); }
};
const handleCreateSecret = async (input: { name: string; value: string }) => { const desktopApi = getDesktopApi(); await runSecretMutation(() => desktopApi.createUserSecret(input)); };
const handleUpdateSecret = async (input: { id: string; name: string; value?: string }) => { const desktopApi = getDesktopApi(); await runSecretMutation(() => desktopApi.updateUserSecret(input)); };
const handleDeleteSecret = async (id: string) => { const desktopApi = getDesktopApi(); await runSecretMutation(() => desktopApi.deleteUserSecret({ id })); };
const handleConnectSecret = async (appSecretName: string, userSecretId: string) => { const targetAppId = selectedAppDetailsId; if (!targetAppId) { return; }
const desktopApi = getDesktopApi(); await runSecretMutation(() => desktopApi.connectAppSecret({ appId: targetAppId, appSecretName, userSecretId, }), targetAppId, ); };
const handleDisconnectSecret = async (appSecretName: string) => { const targetAppId = selectedAppDetailsId; if (!targetAppId) { return; }
const desktopApi = getDesktopApi(); await runSecretMutation(() => desktopApi.disconnectAppSecret({ appId: targetAppId, appSecretName, }), targetAppId, ); };
const isPrivateLocalInstalledApp = (appId: string) => {
const installed = installedApps.find((appEntry) => appEntry.id === appId);
if (!installed) { return false; }
if (installed.privateLocal) { return true; }
return !catalogApps.some((appEntry) => appEntry.id === appId);
};
const handleDeleteApp = async (appId: string) => { const meta = getAppMeta(appId); const confirmMessage = isPrivateLocalInstalledApp(appId) ? t.appView.deletePrivateLocalConfirm(meta.name) : t.appView.deleteConfirm(meta.name); const confirmed = window.confirm(confirmMessage); if (!confirmed) { return; }
const desktopApi = getDesktopApi(); const result = await desktopApi.uninstallApp(appId); await Promise.all([refreshApps(), refreshCloudStorageUsage()]); if (selectedAppDetailsId === appId) { setSelectedAppDetails(null); setCurrentView('catalog'); }
setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); };
const createInstallWelcomeConversation = (appId: string, message: string) => { const now = new Date().toISOString(); const conversationId = makeConversationId(); const appName = getAppMeta(appId).name; const conversation: ChatConversation = { id: conversationId, appId, mode: 'edit_app', targetAppId: appId, title: `Bienvenida a ${appName}`, threadId: null, createdAt: now, updatedAt: now, messages: [ { id: `assistant-install-welcome-${Date.now()}`, role: 'assistant', content: message, action: {
type: 'open-app',
appId, label: t.actions.open, }, }, ], };
setChatConversations((current) => [conversation, ...current.filter((item) => !(item.appId === appId && item.title === conversation.title))]); setActiveConversationByApp((current) => ({ ...current, [appId]: conversationId })); setActiveConversationId(conversationId); };
const handlePickChatFiles = async () => { const picked = await getDesktopApi().filesPickForChat(); setPendingChatFiles((current) => { const seen = new Set(current.map((file) => file.sourcePath)); return [...current, ...picked.filter((file) => !seen.has(file.sourcePath))]; }); };
const discardStagedChatFiles = (files: PickedChatFile[]) => { const sourcePaths = files.filter((file) => file.staged).map((file) => file.sourcePath); if (sourcePaths.length > 0) { void getDesktopApi().filesDiscardStagedForChat({ sourcePaths }); }
};
const handleStagePastedChatFile = async (input: Parameters<ReturnType<typeof getDesktopApi>['filesStageForChat']>[0]) => { const staged = await getDesktopApi().filesStageForChat(input); setPendingChatFiles((current) => { const seen = new Set(current.map((file) => file.sourcePath)); return seen.has(staged.sourcePath) ? current : [...current, staged]; }); };
const handleRemovePendingChatFile = (sourcePath: string) => { setPendingChatFiles((current) => { const removed = current.filter((file) => file.sourcePath === sourcePath); discardStagedChatFiles(removed); return current.filter((file) => file.sourcePath !== sourcePath); }); };
const handleMentionFile = (file: ForgerFileRecord) => { setMentionedChatFileIds((current) => current.includes(file.id) ? current : [...current, file.id]); };
const openCreateCategoryDialog = (parentPath?: string, selectAfterCreate = false) => { void parentPath; setCategoryDialogSelectAfterCreate(selectAfterCreate); setCategoryDialogName(''); setCategoryDialogOpen(true); };
const handleCreateCategorySubmit = async () => { const name = categoryDialogName.trim(); if (!name) { return; }
const created = await getDesktopApi().filesCreateCategory({ name, }); setCategoryDialogOpen(false); setCategoryDialogName(''); if (categoryDialogSelectAfterCreate) { setUploadCategoryPath(created.path); }
await refreshFiles(fileFilters); };
const openRenameCategoryDialog = (categoryPath: string) => { const category = fileCategories.find((item) => item.path === categoryPath); setRenameCategoryDialog({ open: true, categoryPath, name: category?.name ?? categoryPath.split('/').pop() ?? categoryPath, }); };
const handleRenameCategorySubmit = async () => { const name = renameCategoryDialog.name.trim(); if (!renameCategoryDialog.categoryPath || !name) { return; }
const result = await getDesktopApi().filesRenameCategory({ categoryPath: renameCategoryDialog.categoryPath, newName: name, }); setRenameCategoryDialog({ open: false, categoryPath: '', name: '' }); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage ?? result.technicalCode ?? t.settings.authErrorFallback); await refreshFiles(fileFilters); };
const handleDeleteCategory = async (categoryPath: string) => { if (!window.confirm(t.sections.files.deleteCategoryConfirm)) { return; }
const result = await getDesktopApi().filesDeleteCategory({ categoryPath, mode: 'emptyOnly' }); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage ?? result.technicalCode ?? t.settings.authErrorFallback); await refreshFiles(fileFilters); };
const openRenameFileDialog = (file: ForgerFileRecord) => { setRenameFileDialog({ open: true, file, name: file.name }); };
const handleRenameFileSubmit = async () => { const file = renameFileDialog.file; const name = renameFileDialog.name.trim(); if (!file || !name) { return; }
await getDesktopApi().filesRename({ fileId: file.id, name }); setRenameFileDialog({ open: false, file: null, name: '' }); await refreshFiles(fileFilters); };
const openMoveFileDialog = (file: ForgerFileRecord) => { setMoveFileDialog({ open: true, file, categoryPath: file.categoryPath }); };
const handleMoveFileSubmit = async () => { const file = moveFileDialog.file; if (!file) { return; }
await getDesktopApi().filesMove({ fileIds: [file.id], categoryPath: moveFileDialog.categoryPath }); setMoveFileDialog({ open: false, file: null, categoryPath: '' }); await refreshFiles(fileFilters); };
const handleDeleteFile = async (file: ForgerFileRecord) => { if (!window.confirm(t.sections.files.deleteFileConfirm)) { return; }
await getDesktopApi().filesDelete({ fileIds: [file.id] }); setMentionedChatFileIds((current) => current.filter((id) => id !== file.id)); await refreshFiles(fileFilters); };
const handleSendMessage = async (nextMessage?: string, modeOverride?: { mode: ChatMode; targetAppId?: string | null }) => { const trimmed = (nextMessage ?? chatInput).trim(); const sharedFileNames = [ ...pendingChatFiles.map((file) => file.name), ...mentionedChatFiles.map((file) => file.name), ]; const userVisibleContent = trimmed || `Archivos compartidos: ${sharedFileNames.join(', ')}`; const hasAgentProvider = codexAuthStatus.authenticated || claudeAuthStatus.authenticated; const activeChatMode = modeOverride?.mode ?? activeConversation?.mode; const activeTargetAppId = activeChatMode === 'edit_app' ? modeOverride?.targetAppId ?? activeConversation?.targetAppId ?? activeConversation?.appId ?? null : null;
if (!activeChatMode || (!trimmed && pendingChatFiles.length === 0 && mentionedChatFileIds.length === 0) || activeConversationRunActive || !hasAgentProvider) { if (!hasAgentProvider) { setAgentProviderConfigOpen(true); }
return; }
const chatScopeId = activeTargetAppId ?? FREE_CHAT_APP_ID; let targetConversationId = activeConversationId; let createdRuntime: ChatConversation['runtime'] | undefined; if (!targetConversationId) { const now = new Date().toISOString(); const draft = resolveChatRuntimeDraft( resolvedChatProvider, selectedCodexModel, selectedCodexReasoningEffort, selectedClaudeModel, selectedClaudeEffort, ); createdRuntime = { provider: draft.provider, model: draft.model, effort: draft.effort };
const createdConversation: ChatConversation = { id: makeConversationId(), appId: chatScopeId, mode: activeChatMode, targetAppId: activeTargetAppId, title: summarizeConversationTitle(userVisibleContent), threadId: null, ...(createdRuntime ? { runtime: createdRuntime } : {}), createdAt: now, updatedAt: now, messages: [], };
targetConversationId = createdConversation.id; setChatConversations((current) => [createdConversation, ...current]); setActiveConversationId(createdConversation.id); setActiveConversationByApp((current) => ({ ...current, [chatScopeId]: createdConversation.id })); }
if (targetConversationId && modeOverride) { const now = new Date().toISOString(); setChatConversations((current) => current.map((conversation) => conversation.id === targetConversationId ? { ...conversation, appId: chatScopeId, mode: activeChatMode, targetAppId: activeTargetAppId, updatedAt: now } : conversation)); setSelectedAppId(activeTargetAppId); }
const conversationForRun = chatConversations.find((conversation) => conversation.id === targetConversationId); const conversationForPrompt = conversationForRun && modeOverride ? { ...conversationForRun, appId: chatScopeId, mode: activeChatMode, targetAppId: activeTargetAppId } : conversationForRun; const lockedRuntime = conversationForPrompt?.runtime ?? createdRuntime; const runtimeDraft = lockedRuntime ? { provider: lockedRuntime.provider, model: lockedRuntime.model, effort: lockedRuntime.effort, ...(lockedRuntime.provider === 'codex' ? { reasoningEffort: lockedRuntime.effort as CodexReasoningEffort } : {}), }
: resolveChatRuntimeDraft( resolvedChatProvider, selectedCodexModel, selectedCodexReasoningEffort, selectedClaudeModel, selectedClaudeEffort, ); setActiveConversationByApp((current) => ({ ...current, [chatScopeId]: targetConversationId as string })); setStartingConversationIds((current) => new Set(current).add(targetConversationId as string)); try { const desktopApi = getDesktopApi(); const stagedFilesForCleanup = pendingChatFiles.filter((file) => file.staged); const importedFiles = pendingChatFiles.length > 0
? await desktopApi.filesImport({ sourcePaths: pendingChatFiles.map((file) => file.sourcePath), categoryPath: uploadCategoryPath, ...(activeTargetAppId ? { appId: activeTargetAppId } : {}), }) : []; discardStagedChatFiles(stagedFilesForCleanup); const mentionedFilesForRun = forgerFiles.filter((file) => mentionedChatFileIds.includes(file.id)); const sharedFiles: SharedFileRef[] = [ ...importedFiles.map((file) => ({ id: file.id, path: file.relativePath, name: file.name, relativePath: file.relativePath,
sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, source: 'attached' as const, })), ...mentionedFilesForRun.map((file) => ({ id: file.id, path: file.relativePath, name: file.name, relativePath: file.relativePath, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, source: 'mentioned' as const, })), ]; const messageFiles: NonNullable<ChatMessage['files']> = sharedFiles.map((file) => ({ id: file.id ?? file.path, name: file.name ?? file.path.split('/').pop() ?? file.path,
relativePath: file.relativePath ?? file.path, displayPath: `${FORGER_DATA_ROOT_NAME}/${file.relativePath ?? file.path}`, sizeBytes: file.sizeBytes ?? 0, source: file.source ?? 'mentioned', })); const refreshedFiles = await desktopApi.filesList(fileFilters); setForgerFiles(refreshedFiles); setChatDraft(targetConversationId as string, ''); setPendingChatFiles([]); setMentionedChatFileIds([]); const now = new Date().toISOString(); setChatConversations((currentConversations) => currentConversations.map((conversation) => {
if (conversation.id !== targetConversationId) { return conversation; }
const nextTitle = (conversation.title === 'Conversacion nueva' || conversation.title === t.sections.chat.newConversationTitle) && conversation.messages.length === 0 ? summarizeConversationTitle(userVisibleContent, t.sections.chat.newConversationTitle) : conversation.title; return { ...conversation, title: nextTitle, updatedAt: now, runtime: conversation.runtime ?? ( runtimeDraft.provider && runtimeDraft.model && runtimeDraft.effort ? { provider: runtimeDraft.provider, model: runtimeDraft.model,
effort: runtimeDraft.effort, }
: undefined ), messages: [ ...conversation.messages, { id: `user-${Date.now()}`, role: 'user', content: userVisibleContent, files: messageFiles, }, ], };
}), ); const startResult = await desktopApi.chatStartRun({ appId: activeTargetAppId ?? undefined, chatMode: activeChatMode, targetAppId: activeTargetAppId, prompt: trimmed || 'Review the shared files in this message.', threadId: conversationForPrompt?.threadId ?? null, conversationHistory: [ ...(conversationForPrompt?.messages ?? []).map((message) => ({ role: message.role, content: message.content, })), { role: 'user', content: userVisibleContent, }, ], userLanguage: activeLocale, sharedFiles, ...runtimeDraft, permissionMode: selectedChatPermissionMode, networkAccess: selectedChatNetworkAccess, conversationId: targetConversationId, });
runConversationIdByRunRef.current.set(startResult.runId, targetConversationId); setActiveConversationRuns((current) => ({ ...current, [targetConversationId]: { runId: startResult.runId, conversationId: targetConversationId, appId: chatScopeId, status: startResult.status, progressLog: [] } })); submitUsageEvent({ eventName: 'chat_started', surface: 'chat', locale: t.locale, stringParameters: { app_id: activeTargetAppId ?? FREE_CHAT_APP_ID, provider: runtimeDraft.provider, chat_mode: activeChatMode } }); } catch (error) { clearActiveRunState(undefined, targetConversationId); const detail = error instanceof Error ? error.message : t.settings.authErrorFallback; const friendly = /app_run_in_progress/i.test(detail) ? t.sections.chat.appRunInProgress : /another_run_in_progress|conversation_run_in_progress/i.test(detail) ? t.sections.chat.sendInProgress : t.sections.chat.sendFailed(detail); setChatConversations((currentConversations) => currentConversations.map((conversation) => { if (conversation.id !== targetConversationId) {
return conversation; }
return { ...conversation, updatedAt: new Date().toISOString(), messages: [ ...conversation.messages, { id: `assistant-error-${Date.now()}`, role: 'assistant', content: friendly, }, ], };
}), ); requestErrorReport({ source: 'agent', operation: 'chat.start-run', message: detail, technicalCode: 'chat_start_run_failed', appId: activeTargetAppId ?? undefined, appVersion: installedApps.find((appEntry) => appEntry.id === activeTargetAppId)?.version, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setStartingConversationIds((current) => { const next = new Set(current); next.delete(targetConversationId as string); return next; }); }
};
const handleStopChatRun = async () => { const runId = activeConversationRunId; if (!runId) { return; }
try { const result = await getDesktopApi().chatCancelRun({ runId }); if (!result.success) { setBannerSeverity('error'); setBannerMessage(t.sections.chat.stopFailed); return; }
clearActiveRunState(runId); setBannerSeverity('info'); setBannerMessage(t.sections.chat.stopSuccess); } catch (error) { setBannerSeverity('error'); setBannerMessage(error instanceof Error ? error.message : t.sections.chat.stopFailed); }
};
const handleRespondPermission = async ( runId: string, requestId: string, decision: 'allow' | 'deny', ) => { console.info('[Forger permission] user decision', { runId, requestId, decision }); const result = await getDesktopApi().chatApprovePermission({ runId, requestId, decision }); if (!result.success) { console.warn('[Forger permission] decision was rejected by main process', { runId, requestId, decision }); setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback);
setChatConversations((currentConversations) => currentConversations.map((conversation) => ({ ...conversation, messages: conversation.messages.map((message) => { if ( message.action?.type === 'permission' && message.action.runId === runId && message.action.request.requestId === requestId ) { return { ...message, action: { ...message.action, status: 'pending', }, };
}
return message; }), })), ); return; }
setChatConversations((currentConversations) => currentConversations.map((conversation) => ({ ...conversation, messages: conversation.messages.map((message) => { if ( message.action?.type === 'permission' && message.action.runId === runId && message.action.request.requestId === requestId ) { return { ...message, action: { ...message.action, status: decision === 'allow' ? 'approved' : 'denied', }, };
}
return message; }), })), ); };
const buildQuestionResponseMessage = (request: ChatQuestionRequest, response: ChatQuestionResponse): string => { const answerLines = response.answers.map((answer) => `${answer.question}: ${answer.label}`); const freeText = response.freeText?.trim(); return [ ...answerLines, ...(freeText ? [freeText] : []), ].join('\n') || t.sections.chat.questionAnswered; };
const buildQuestionResponsePrompt = (request: ChatQuestionRequest, response: ChatQuestionResponse): string => `FORGER_QUESTION_RESPONSE\n${JSON.stringify({
type: 'forger.question_response',
chatId: request.chatId,
questionRequestId: request.requestId,
answers: response.answers.map((answer) => ({
questionId: answer.questionId,
question: answer.question,
optionId: answer.optionId,
label: answer.label,
...(answer.description ? { description: answer.description } : {}),
})),
freeText: response.freeText?.trim() || '',
}, null, 2)}`;
const handleRespondQuestion = async ( runId: string, request: ChatQuestionRequest, response: ChatQuestionResponse, ) => { const targetConversationId = request.chatId; if (!chatConversationsRef.current.some((conversation) => conversation.id === targetConversationId)) { setBannerSeverity('error'); setBannerMessage(t.sections.chat.sendFailed('conversation_not_found')); return; }
const conversationForRun = chatConversationsRef.current.find((conversation) => conversation.id === targetConversationId); if (!conversationForRun) { setBannerSeverity('error'); setBannerMessage(t.sections.chat.sendFailed('conversation_not_found')); return; }
const chatMode = conversationForRun.mode ?? (conversationForRun.appId === FREE_CHAT_APP_ID ? 'free_chat' : 'edit_app'); const chatScopeId = chatMode === 'edit_app' ? conversationForRun.targetAppId ?? conversationForRun.appId : FREE_CHAT_APP_ID; const lockedRuntime = conversationForRun.runtime; const runtimeDraft = lockedRuntime ? { provider: lockedRuntime.provider, model: lockedRuntime.model, effort: lockedRuntime.effort, ...(lockedRuntime.provider === 'codex' ? { reasoningEffort: lockedRuntime.effort as CodexReasoningEffort } : {}), }
: resolveChatRuntimeDraft( resolvedChatProvider, selectedCodexModel, selectedCodexReasoningEffort, selectedClaudeModel, selectedClaudeEffort, ); const userVisibleContent = buildQuestionResponseMessage(request, response); const internalPrompt = buildQuestionResponsePrompt(request, response); const now = new Date().toISOString(); setChatConversations((currentConversations) => currentConversations.map((conversation) => { if (conversation.id !== targetConversationId) { return conversation; }
return { ...conversation, appId: chatScopeId, mode: chatMode, targetAppId: chatMode === 'edit_app' ? chatScopeId : null, updatedAt: now, messages: [ ...conversation.messages.map((message) => { if (message.action?.type === 'question' && message.action.runId === runId && message.action.request.requestId === request.requestId) { return { ...message, action: { ...message.action, status: 'answered' as const } }; }
return message; }), { id: `user-question-response-${Date.now()}`, role: 'user', content: userVisibleContent, }, ], };
}), ); setActiveConversationByApp((current) => ({ ...current, [chatScopeId]: targetConversationId })); setStartingConversationIds((current) => new Set(current).add(targetConversationId)); try { const startResult = await getDesktopApi().chatStartRun({ appId: chatScopeId === FREE_CHAT_APP_ID ? undefined : chatScopeId, chatMode, targetAppId: chatMode === 'edit_app' ? chatScopeId : null, prompt: internalPrompt, threadId: conversationForRun.threadId ?? null, conversationHistory: [ ...conversationForRun.messages.map((message) => ({ role: message.role, content: message.content, })), { role: 'user', content: userVisibleContent, }, ], userLanguage: activeLocale, sharedFiles: [], ...runtimeDraft, permissionMode: selectedChatPermissionMode, networkAccess: selectedChatNetworkAccess, conversationId: targetConversationId, }); runConversationIdByRunRef.current.set(startResult.runId, targetConversationId); setActiveConversationRuns((current) => ({ ...current, [targetConversationId]: { runId: startResult.runId, conversationId: targetConversationId, appId: chatScopeId, status: startResult.status, progressLog: [] } })); submitUsageEvent({ eventName: 'chat_started', surface: 'chat', locale: t.locale, stringParameters: { app_id: chatScopeId, provider: runtimeDraft.provider, response_to: 'question', chat_mode: chatMode } }); } catch (error) { clearActiveRunState(undefined, targetConversationId); const detail = error instanceof Error ? error.message : t.settings.authErrorFallback; const friendly = /app_run_in_progress/i.test(detail) ? t.sections.chat.appRunInProgress : /another_run_in_progress|conversation_run_in_progress/i.test(detail) ? t.sections.chat.sendInProgress : t.sections.chat.sendFailed(detail); setChatConversations((currentConversations) => currentConversations.map((conversation) => { if (conversation.id !== targetConversationId) { return conversation; }
return { ...conversation, updatedAt: new Date().toISOString(), messages: [ ...conversation.messages.map((message) => { if (message.action?.type === 'question' && message.action.runId === runId && message.action.request.requestId === request.requestId) { return { ...message, action: { ...message.action, status: 'pending' as const } }; }
return message; }), { id: `assistant-error-${Date.now()}`, role: 'assistant', content: friendly, }, ], };
}), ); requestErrorReport({ source: 'agent', operation: 'chat.question-response.start-run', message: detail, technicalCode: 'chat_question_response_failed', appId: chatScopeId === FREE_CHAT_APP_ID ? undefined : chatScopeId, appVersion: installedApps.find((appEntry) => appEntry.id === chatScopeId)?.version, sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setStartingConversationIds((current) => { const next = new Set(current); next.delete(targetConversationId); return next; }); }
};
const handleOpenConversation = (conversationId: string) => { const target = chatConversations.find((conversation) => conversation.id === conversationId); if (!target) { return; }
setSelectedAppId(target.mode === 'edit_app' ? target.targetAppId ?? target.appId : null); setCurrentView('chat'); setActiveConversationId(target.id); setActiveConversationByApp((current) => ({ ...current, [target.appId]: target.id })); resetIdleChatProgress(); };
const handleDeleteConversation = (conversationId: string) => { setChatConversations((currentConversations) => currentConversations.filter((conversation) => conversation.id !== conversationId), ); setActiveConversationByApp((current) => { const next = { ...current }; for (const [appId, mappedConversationId] of Object.entries(next)) { if (mappedConversationId === conversationId) { delete next[appId]; }
}
return next; }); if (activeConversationId === conversationId) { setActiveConversationId(null); }
clearActiveRunState(undefined, conversationId);
};
const handleStartNewConversation = () => { const chatScopeId = FREE_CHAT_APP_ID; const now = new Date().toISOString(); const nextConversation: ChatConversation = { id: makeConversationId(), appId: chatScopeId, title: t.sections.chat.newConversationTitle, threadId: null, createdAt: now, updatedAt: now, messages: [], };
traceChatEvent({ event: 'chat_new_conversation_clicked', appId: chatScopeId, conversationId: nextConversation.id, activeConversationId, messageCount: 0 });
setChatConversations((current) => [nextConversation, ...current]); setActiveConversationId(nextConversation.id); setSelectedAppId(null); setActiveConversationByApp((current) => ({ ...current, [chatScopeId]: nextConversation.id })); setChatDraft(nextConversation.id, ''); discardStagedChatFiles(pendingChatFiles); setPendingChatFiles([]); setMentionedChatFileIds([]); resetIdleChatProgress(); };
const handleSelectAutomation = (automationId: string) => { setSelectedAutomationId(automationId); void loadAutomationRuns(automationId); };
const handleSelectAutomationRun = async (runId: string) => { const run = await getDesktopApi().automationsGetRunTranscript(runId); setSelectedAutomationRun(run); };
const handleSaveAutomation = async (input: AutomationUpsertInput & { id?: string }) => { setAutomationBusy(true); try { const desktopApi = getDesktopApi(); const saved = input.id ? await desktopApi.automationsUpdate({ ...input, id: input.id }) : await desktopApi.automationsCreate(input); const nextAutomations = await refreshAutomations(); setSelectedAutomationId(saved.id); await loadAutomationRuns(saved.id); setBannerSeverity('success');
setBannerMessage(saved.enabled ? 'Automatizacion guardada y activa.' : 'Automatizacion guardada pausada.'); if (nextAutomations.length === 0) { setAutomations([saved]); }
} catch (error) { setBannerSeverity('error'); setBannerMessage(error instanceof Error ? error.message : t.settings.authErrorFallback); } finally { setAutomationBusy(false); }
};
const handleDeleteAutomation = async (automationId: string) => { if (!window.confirm(t.sections.automations.deleteConfirm)) { return; }
setAutomationBusy(true); try { const result = await getDesktopApi().automationsDelete(automationId); const nextAutomations = await refreshAutomations(); const nextSelectedId = nextAutomations[0]?.id ?? null; setSelectedAutomationId(nextSelectedId); setAutomationRuns([]); setSelectedAutomationRun(null); if (nextSelectedId) { await loadAutomationRuns(nextSelectedId); }
setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage ?? result.technicalCode ?? t.settings.authErrorFallback); } finally { setAutomationBusy(false); }
};
const handlePauseAutomation = async (automationId: string) => { setAutomationBusy(true); try { await getDesktopApi().automationsPause(automationId); await refreshAutomations(); } finally { setAutomationBusy(false); }
};
const handleResumeAutomation = async (automationId: string) => { setAutomationBusy(true); try { await getDesktopApi().automationsResume(automationId); await refreshAutomations(); } finally { setAutomationBusy(false); }
};
const handleRunAutomationNow = async (automationId: string) => { setAutomationBusy(true); try { const run = await getDesktopApi().automationsRunNow(automationId); setSelectedAutomationId(automationId); await loadAutomationRuns(automationId, run.id); setBannerSeverity(run.status === 'skipped' ? 'warning' : 'info'); setBannerMessage(run.status === 'skipped' ? 'Ya hay un run activo para esta automatizacion.' : 'Run manual iniciado.'); } catch (error) { setBannerSeverity('error');
setBannerMessage(error instanceof Error ? error.message : t.settings.authErrorFallback); } finally { setAutomationBusy(false); }
};
const refreshCodexAuthStatus = async () => { const desktopApi = getDesktopApi(); const nextStatus = await desktopApi.getCodexAuthStatus(); setCodexAuthStatus(nextStatus); return nextStatus; };
const refreshClaudeAuthStatus = async () => { const desktopApi = getDesktopApi(); const nextStatus = await desktopApi.getClaudeAuthStatus(); setClaudeAuthStatus(nextStatus); return nextStatus; };
const pollCodexAuthStatus = async (shouldStop: () => boolean) => { const deadline = Date.now() + AUTH_STATUS_POLL_TIMEOUT_MS; let lastStatus = await refreshCodexAuthStatus(); while (!lastStatus.authenticated && Date.now() < deadline && !shouldStop()) { await wait(AUTH_STATUS_POLL_INTERVAL_MS); if (shouldStop()) { return lastStatus; }
lastStatus = await refreshCodexAuthStatus(); }
return lastStatus; };
const pollClaudeAuthStatus = async (shouldStop: () => boolean) => { const deadline = Date.now() + AUTH_STATUS_POLL_TIMEOUT_MS; let lastStatus = await refreshClaudeAuthStatus(); while (!lastStatus.authenticated && Date.now() < deadline && !shouldStop()) { await wait(AUTH_STATUS_POLL_INTERVAL_MS); if (shouldStop()) { return lastStatus; }
lastStatus = await refreshClaudeAuthStatus(); }
return lastStatus; };
const beginAuthConnectAttempt = (provider: IntelligenceProviderAuth) => { const attempt = authConnectTrackerRef.current.begin(provider); setAuthBusyProvider(provider); return attempt; };
const isAuthConnectAttemptActive = (attempt: AuthConnectAttempt) => authConnectTrackerRef.current.isActive(attempt);
const finishAuthConnectAttempt = (attempt: AuthConnectAttempt) => { const provider = authConnectTrackerRef.current.finish(attempt); if (!provider) { return; }
setAuthBusyProvider((current) => current === provider ? null : current); };
const cancelAuthConnectAttempt = (provider: IntelligenceProviderAuth) => { const attempt = authConnectTrackerRef.current.cancel(provider); if (!attempt) { return; }
setAuthBusyProvider((current) => current === attempt.provider ? null : current); };
const closeCodexConfig = () => { cancelAuthConnectAttempt('codex'); setCodexConfigOpen(false); };
const closeClaudeConfig = () => { cancelAuthConnectAttempt('claude'); setClaudeConfigOpen(false); };
const handleConnectCodexAuth = async () => { const attempt = beginAuthConnectAttempt('codex'); let connectSettled = false; const polling = pollCodexAuthStatus(() => connectSettled || !isAuthConnectAttemptActive(attempt)).catch(() => undefined); try { const desktopApi = getDesktopApi(); const result = await desktopApi.connectCodexAuth(); connectSettled = true; await polling; if (!isAuthConnectAttemptActive(attempt)) { return; }
setBannerSeverity(result.success ? 'info' : 'error'); setBannerMessage(result.userMessage); requestErrorReportFromResult('agent', 'codex-connect', result); const nextStatus = result.success ? await pollCodexAuthStatus(() => !isAuthConnectAttemptActive(attempt)) : await refreshCodexAuthStatus(); if (!isAuthConnectAttemptActive(attempt)) { return; }
if (result.success && nextStatus.authenticated) { submitChatGptConnectedEvent({ surface: 'settings', locale: t.locale }); setCodexConfigOpen(false); setAgentProviderConfigOpen(false); } } catch (error) { connectSettled = true; await polling; if (!isAuthConnectAttemptActive(attempt)) { return; }
setBannerSeverity('error'); setBannerMessage(t.settings.codexConnectError); requestErrorReport({ source: 'agent',
operation: 'codex-connect', message: error instanceof Error ? error.message : t.settings.codexConnectError, technicalCode: 'codex_connect_unhandled_error', sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { connectSettled = true; finishAuthConnectAttempt(attempt); }
};
const handleConnectClaudeAuth = async () => { const attempt = beginAuthConnectAttempt('claude'); let connectSettled = false; const polling = pollClaudeAuthStatus(() => connectSettled || !isAuthConnectAttemptActive(attempt)).catch(() => undefined); try { const result = await getDesktopApi().connectClaudeAuth(); connectSettled = true; await polling; if (!isAuthConnectAttemptActive(attempt)) { return; }
setBannerSeverity(result.success ? 'info' : 'error'); setBannerMessage(result.userMessage); if (result.status) { setClaudeAuthStatus(result.status); }
const nextStatus = result.success ? await pollClaudeAuthStatus(() => !isAuthConnectAttemptActive(attempt)) : result.status ?? await refreshClaudeAuthStatus(); if (!isAuthConnectAttemptActive(attempt)) { return; }
if (nextStatus.authenticated) { setClaudeConfigOpen(false); setAgentProviderConfigOpen(false); }
requestErrorReportFromResult('agent', 'claude-connect', result); } catch (error) { connectSettled = true; await polling; if (!isAuthConnectAttemptActive(attempt)) { return; }
setBannerSeverity('error'); setBannerMessage('No pudimos iniciar la conexion con Claude Code.'); requestErrorReport({ source: 'agent', operation: 'claude-connect', message: error instanceof Error ? error.message : 'No pudimos iniciar la conexion con Claude Code.', technicalCode: 'claude_connect_unhandled_error', sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, });
} finally { connectSettled = true; finishAuthConnectAttempt(attempt); }
};
const handleReinstallClaude = async () => { setAuthBusyProvider('claude'); try { const result = await getDesktopApi().reinstallClaude(); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); if (result.status) { setClaudeAuthStatus(result.status); } else { await refreshClaudeAuthStatus(); }
requestErrorReportFromResult('agent', 'claude-reinstall', result); } catch (error) { setBannerSeverity('error'); setBannerMessage('No pudimos instalar Claude Code.'); requestErrorReport({ source: 'agent', operation: 'claude-reinstall', message: error instanceof Error ? error.message : 'No pudimos instalar Claude Code.', technicalCode: 'claude_reinstall_unhandled_error', sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setAuthBusyProvider((current) => current === 'claude' ? null : current); }
};
const handleReinstallCodex = async () => { setAuthBusyProvider('codex'); try { const desktopApi = getDesktopApi(); const result = await desktopApi.reinstallCodex(); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage); if (result.status) { setCodexAuthStatus(result.status); } else { await refreshCodexAuthStatus(); }
requestErrorReportFromResult('agent', 'codex-reinstall', result); } catch (error) { setBannerSeverity('error'); setBannerMessage(t.settings.codexReinstallError); requestErrorReport({ source: 'agent', operation: 'codex-reinstall', message: error instanceof Error ? error.message : t.settings.codexReinstallError, technicalCode: 'codex_reinstall_unhandled_error', sensitiveDetails: { stack: error instanceof Error ? error.stack : undefined }, }); } finally { setAuthBusyProvider((current) => current === 'codex' ? null : current); }
};
const handleForgerLogin = async (email: string, password: string) => { setForgerAccountBusy(true); try { const result = await getDesktopApi().loginForgerAccount({ email, password, locale: t.locale }); setForgerAccount(result); setForgerAccountMessage(result.success ? null : result.userMessage ?? null); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.success ? t.cloud.loginSuccess : result.userMessage ?? t.settings.authErrorFallback); if (result.success) { void refreshBackups(); }
if (result.success) { setCloudModalOpen(false); }
if (result.success) { void refreshForumParticipation(true); }
await refreshApps(); } catch { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); } finally { setForgerAccountBusy(false); }
};
const handleForgerGoogleLogin = async () => { setForgerAccountBusy(true); try { const result = await getDesktopApi().loginForgerAccountWithGoogle(); setForgerAccount(result); setForgerAccountMessage(result.success ? null : result.userMessage ?? null); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.success ? t.cloud.loginSuccess : result.userMessage ?? t.settings.authErrorFallback); if (result.success) { void refreshBackups(); setCloudModalOpen(false); }
if (result.success) { void refreshForumParticipation(true); }
await refreshApps(); } catch { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); } finally { setForgerAccountBusy(false); }
};
const handleForgerAppleLogin = async () => { setForgerAccountBusy(true); try { const result = await getDesktopApi().loginForgerAccountWithApple(); setForgerAccount(result); setForgerAccountMessage(result.success ? null : result.userMessage ?? null); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.success ? t.cloud.loginSuccess : result.userMessage ?? t.settings.authErrorFallback); if (result.success) { void refreshBackups(); setCloudModalOpen(false); }
if (result.success) { void refreshForumParticipation(true); }
await refreshApps(); } catch { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); } finally { setForgerAccountBusy(false); }
};
const closeErrorReportDialog = () => { if (errorReportDialog.busy) { return; }
setErrorReportDialog({ open: false, report: null, busy: false }); };
const copyErrorReportDetails = async () => { if (!errorReportDialog.report) { return; }
const { diagnosticAttachmentToken: _diagnosticAttachmentToken, ...copyableReport } = errorReportDialog.report;
await navigator.clipboard.writeText(JSON.stringify(copyableReport, null, 2)); setErrorReportDialog((current) => ({ ...current, userMessage: t.settings.errorReportCopied })); };
const submitErrorReport = async () => { if (!errorReportDialog.report) { return; }
setErrorReportDialog((current) => ({ ...current, busy: true, userMessage: undefined })); try { const result = await getDesktopApi().submitDesktopErrorReport(errorReportDialog.report); if (result.success) { setBannerSeverity('success'); setBannerMessage(result.userMessage || t.settings.errorReportSent); setErrorReportDialog({ open: false, report: null, busy: false }); return; }
setErrorReportDialog((current) => ({ ...current, busy: false, userMessage: result.userMessage || t.settings.errorReportSendError, })); } catch { setErrorReportDialog((current) => ({ ...current, busy: false, userMessage: t.settings.errorReportSendError, })); }
};
const closeConversationDiagnosticDialog = () => { if (conversationDiagnosticDialog.busy) { return; }
setConversationDiagnosticDialog({ open: false, report: null, busy: false, description: '' }); };
const prepareConversationDiagnosticReport = async () => { if (!activeConversation || conversationDiagnosticDialog.busy) { return; }
setConversationDiagnosticDialog({ open: true, report: null, busy: true, description: '' }); try { const report = await getDesktopApi().prepareConversationDiagnosticReport({ source: 'desktop_chat', appId: activeConversation.appId === FREE_CHAT_APP_ID ? undefined : activeConversation.appId, conversationId: activeConversation.id, runId: activeConversationRunId ?? undefined, title: activeConversation.title, provider: activeConversation.runtime?.provider ?? (selectedAgentProvider === 'auto' ? resolvedChatProvider : selectedAgentProvider), conversation: { appId: activeConversation.appId === FREE_CHAT_APP_ID ? undefined : activeConversation.appId, title: activeConversation.title, threadId: activeConversation.threadId, runtime: activeConversation.runtime as Record<string, unknown> | undefined, messages: activeConversation.messages.map((message) => ({ id: message.id, role: message.role, content: message.content, })), }, }); setConversationDiagnosticDialog({ open: true, report, busy: false, description: '' }); } catch (error) { setConversationDiagnosticDialog({ open: true, report: null, busy: false, description: '', userMessage: error instanceof Error ? error.message : t.settings.conversationReportPrepareError }); } };
const copyConversationDiagnosticReport = async () => { if (!conversationDiagnosticDialog.report) { return; }
const { diagnosticAttachmentToken: _diagnosticAttachmentToken, ...copyableReport } = conversationDiagnosticDialog.report;
await navigator.clipboard.writeText(JSON.stringify({ ...copyableReport, description: conversationDiagnosticDialog.description.trim() || undefined }, null, 2)); setConversationDiagnosticDialog((current) => ({ ...current, userMessage: t.settings.conversationReportCopied })); };
const setConversationDiagnosticDescription = (description: string) => {
setConversationDiagnosticDialog((current) => ({ ...current, description }));
};
const submitConversationDiagnosticReport = async () => { if (!conversationDiagnosticDialog.report) { return; }
setConversationDiagnosticDialog((current) => ({ ...current, busy: true, userMessage: undefined })); try { const result = await getDesktopApi().submitConversationDiagnosticReport({ ...conversationDiagnosticDialog.report, description: conversationDiagnosticDialog.description.trim() || undefined }); if (result.success) { setBannerSeverity('success'); setBannerMessage(result.userMessage); setConversationDiagnosticDialog({ open: false, report: null, busy: false, description: '' }); return; }
setConversationDiagnosticDialog((current) => ({ ...current, busy: false, userMessage: result.userMessage || t.settings.conversationReportSendError })); } catch { setConversationDiagnosticDialog((current) => ({ ...current, busy: false, userMessage: t.settings.conversationReportSendError })); }
};
const handleForgerRegister = async (input: ForgerAccountRegisterInput) => { setForgerAccountBusy(true); try { const result = await getDesktopApi().registerForgerAccount({ ...input, locale: t.locale }); setForgerAccount(result); setForgerAccountMessage(result.userMessage ?? null); setBannerSeverity(result.success ? 'info' : 'error'); setBannerMessage(result.userMessage ?? t.settings.authErrorFallback); return result.success; } catch { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback);
return false; } finally { setForgerAccountBusy(false); }
};
const handleForgerUsernameUpdate = async (username: string) => { setForgerAccountBusy(true); try { const result = await getDesktopApi().updateForgerAccountProfile({ username }); setForgerAccount(result); setForgerAccountMessage(result.success ? null : result.userMessage ?? null); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.success ? t.cloud.usernameUpdateSuccess : result.userMessage ?? t.settings.authErrorFallback); if (result.success) { await refreshApps(); }
return result.success; } catch { setBannerSeverity('error'); setBannerMessage(t.settings.authErrorFallback); return false; } finally { setForgerAccountBusy(false); }
};
const handleForgerLogout = async () => { setForgerAccountBusy(true); try { const result = await getDesktopApi().logoutForgerAccount(); setForgerAccount(result); setForumParticipation(initialForumParticipation); setForumPromptOpen(false); setRemoteBackups([]); setRemoteBackupsUsage(initialRemoteBackupsUsage); setCloudStorageUsage(initialCloudStorageUsage); setForgerAccountMessage(null); await refreshApps(); } finally { setForgerAccountBusy(false); }
};
const handleSubmitRating = async (input: SubmitAppRatingInput) => { const result = await getDesktopApi().submitAppRating({ ...input, locale: t.locale }); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage ?? t.settings.authErrorFallback); await refreshApps(); if (selectedAppDetailsId) { setSelectedAppDetails(await getDesktopApi().getAppDetails(selectedAppDetailsId)); }
return result; };
const handleSubmitFeedback = async (input: SubmitProductFeedbackInput) => { const result = await getDesktopApi().submitProductFeedback({ ...input, locale: t.locale }); if (result.success) { submitUsageEvent({ eventName: 'feedback_submitted', surface: input.surface, locale: t.locale, stringParameters: { target: input.target, kind: input.kind, ...(input.appId ? { app_id: input.appId } : {}) } }); } setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage ?? t.settings.authErrorFallback); requestErrorReportFromResult('desktop', 'feedback.submit', result, { appId: input.appId, details: { target: input.target, kind: input.kind, surface: input.surface, appVersionLabel: input.appVersionLabel } }); return result; };
const handleUpdateAppPrompt = async (input: AppPromptReviewInput) => { const result = await getDesktopApi().updateAppPrompt(input); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage ?? t.appView.promptErrorFallback); if (selectedAppDetailsId) { setSelectedAppDetails(await getDesktopApi().getAppDetails(selectedAppDetailsId)); }
return result; };
const handleRestoreAppPrompt = async (input: AppPromptRestoreInput) => { const result = await getDesktopApi().restoreAppPrompt(input); setBannerSeverity(result.success ? 'success' : 'error'); setBannerMessage(result.userMessage ?? t.appView.promptErrorFallback); if (selectedAppDetailsId) { setSelectedAppDetails(await getDesktopApi().getAppDetails(selectedAppDetailsId)); }
return result; };
const updateForumParticipationAction = async (action: 'mark_prompt_shown' | 'opt_in' | 'opt_out', options: { closePrompt?: boolean; navigate?: boolean } = {}) => { if (!forgerAccount.authenticated || forumParticipationBusy) { if (!forgerAccount.authenticated) { setCloudModalOpen(true); }
return; }
setForumParticipationBusy(true); try { const state = await getDesktopApi().updateForumParticipation(action); setForumParticipation(state); if (options.closePrompt ?? (action !== 'opt_out')) { setForumPromptOpen(false); }
if (action === 'opt_in') { setBannerSeverity('success'); setBannerMessage(t.settings.forumOptInSuccess); if (options.navigate) { setCurrentView('friends'); } }
} catch (error) { setBannerSeverity('error'); setBannerMessage(error instanceof Error ? error.message : t.settings.forumOptInError); } finally { setForumParticipationBusy(false); } };
const handleDismissForumPrompt = async () => updateForumParticipationAction('mark_prompt_shown', { closePrompt: true });
const handleEnterForum = async () => updateForumParticipationAction('opt_in', { closePrompt: true, navigate: true });
const resetOnboarding = () => { window.localStorage.removeItem(GLOBAL_ONBOARDING_STORAGE_KEY); ADVANCED_VIEWS.forEach((view) => window.localStorage.removeItem(ADVANCED_ONBOARDING_STORAGE_PREFIX + view)); window.localStorage.removeItem(TOOLS_ONBOARDING_MODULE_STORAGE_KEY); Object.values(TOOLS_ONBOARDING_STORAGE_KEYS).forEach((key) => window.localStorage.removeItem(key)); window.dispatchEvent(new Event(FORGER_TOUR_RESET_EVENT)); setBannerSeverity('success'); setBannerMessage(t.onboarding.resetDone); }; const handleUsageAnalyticsChange = (enabled: boolean) => { setUsageAnalyticsEnabled(enabled); setUsageAnalyticsPreference(enabled); submitUsageEvent({ eventName: enabled ? 'usage_analytics_enabled' : 'usage_analytics_revoked', surface: 'settings', locale: t.locale, stringParameters: { decision_source: 'settings' } }); submitUsageEvent({ eventName: 'settings_usage_analytics_changed', surface: 'settings', locale: t.locale, stringParameters: { decision: enabled ? 'enabled' : 'revoked' } }); }; const chatModeLabel = activeConversation?.mode === 'create_app' ? t.sections.chat.modeSelector.chips.create_app : activeConversation?.mode === 'edit_app' ? t.sections.chat.modeSelector.chips.edit_app(getAppMeta(activeConversation.targetAppId ?? activeConversation.appId).name) : activeConversation?.mode === 'free_chat' ? t.sections.chat.modeSelector.chips.free_chat : null; const resolvedMode = resolveThemeMode(themePreference, prefersDark); const theme = useMemo(() => buildAppTheme(resolvedMode), [resolvedMode]); const handleOpenFriendChat = async (friendship: CloudFriendship) => await getDesktopApi().openFriendChatWindow(friendship); const handleOpenSocialApp = (app: SocialUserApp) => { const details = socialAppDetails(app); setAppDetailsBackView('friends'); setSelectedAppDetailsId(details.social?.localAppId ?? details.app.id); setSelectedAppDetails(details); setAppSecretsState(null); setCurrentView('app'); }; const closeRemoteTunnelReadyDialog = () => setRemoteTunnelReadyDialog((current) => ({ ...current, open: false })); const stopReadyRemoteTunnel = async () => { const appId = remoteTunnelReadyDialog.appId; if (!appId) { closeRemoteTunnelReadyDialog(); return; }
await handleStopRemoteNetworkShare(appId); closeRemoteTunnelReadyDialog(); }; const openRemoteTunnelPortal = () => { void getDesktopApi().openExternalUrl(remoteTunnelReadyDialog.portalUrl || t.remoteNetwork.portalUrl); closeRemoteTunnelReadyDialog(); }; return { getDesktopApi, resetOnboarding, theme, socialChatWindowRoute, socialProfileUsername, setSocialProfileUsername, forgerAccount, currentView, setCurrentView, t, installedApps, selectedAppId, selectedDataAppId, setSelectedDataAppId, getAppMeta, handleSelectChatApp, chatModeLabel, setCloudModalOpen, forgerAccountBusy, handleOpenFriendChat, handleOpenSocialApp, backgroundTasks, backgroundTasksDrawerOpen, activeBackgroundTaskCount, openBackgroundTaskHistory, openBackgroundTaskDetail, backFromBackgroundTaskHistory, backFromBackgroundTaskDetail, setBackgroundTasksDrawerOpen, backgroundTasksBackView, selectedBackgroundTaskId,
setBannerSeverity, setBannerMessage, handleForgerLogout, cloudStorageUsage, cloudStorageBusy, refreshCloudStorageUsage, desktopUpdateState, advancedMode, openingAppIds, getCategoryLabel, handleOpen, handleStartLocalNetworkShare, handleStartRemoteNetworkShare, handleStopLocalNetworkShare, handleStopRemoteNetworkShare, localNetworkShareDialogOpen, setLocalNetworkShareDialogOpen, localNetworkShareStatus, handleStop, handleRetry, handleUpdate, handleRestoreUserVersion, handleResolveConflict, openAppDetails, handleDeleteApp, handleCreateLocalApp, handleUploadSocial, createLocalAppBusy, installProgressByApp, catalogApps, refreshApps, catalogFilter, setCatalogFilter, catalogStatusFilter, setCatalogStatusFilter, handleInstall, earlyAccessEnabled, selectedAppDetails, selectedAppDetailsId, selectedAppToolGate, selectedAppToolGrantBusyId, handleAppDetailsToolGrant, appSecretsState, secretsBusy, settings, appDetailsBackView,
handleConnectSecret, handleDisconnectSecret, handleSubmitRating, handleSubmitFeedback, handleUpdateAppPrompt, handleRestoreAppPrompt, forumParticipation, forumPromptOpen, forumParticipationBusy, handleDismissForumPrompt, handleEnterForum, usageAnalyticsEnabled, handleUsageAnalyticsChange, chatMessages, activeConversationId, chatHistoryItems, handleOpenConversation, handleDeleteConversation, handleStartNewConversation, chatInput, setChatInput, handleSendMessage, pendingChatFiles, mentionedChatFiles, forgerFiles, fileCategories, uploadCategoryPath, setUploadCategoryPath, handlePickChatFiles, handleStagePastedChatFile, openCreateCategoryDialog,
handleRemovePendingChatFile, handleMentionFile, setMentionedChatFileIds, activeConversation, selectedAgentProvider, resolvedChatProvider, setSelectedAgentProvider, selectedCodexModel, setSelectedCodexModel, selectedCodexReasoningEffort, setSelectedCodexReasoningEffort, selectedClaudeModel, setSelectedClaudeModel, selectedClaudeEffort, setSelectedClaudeEffort, selectedChatPermissionMode, setSelectedChatPermissionMode, selectedChatNetworkAccess, setSelectedChatNetworkAccess, chatBotPictureSrc, activeConversationRunActive, activeConversationRunId, activeConversationProgressLines, codexAuthStatus, claudeAuthStatus, setAgentProviderConfigOpen, handleStopChatRun, handleRespondPermission, handleRespondQuestion, prepareConversationDiagnosticReport, conversationDiagnosticDialog, setConversationDiagnosticDescription, closeConversationDiagnosticDialog, copyConversationDiagnosticReport, submitConversationDiagnosticReport, automations,
selectedAutomationId, automationRuns, selectedAutomationRun, automationBusy, handleSaveAutomation, handleDeleteAutomation, handlePauseAutomation, handleResumeAutomation, handleRunAutomationNow, handleSelectAutomation, handleSelectAutomationRun, fileFilters, setFileFilters, openRenameCategoryDialog, handleDeleteCategory, openRenameFileDialog, openMoveFileDialog, handleDeleteFile, backups, remoteBackups, remoteBackupsUsage, cloudSyncSettings, backupsBusy, handleCreateBackup, handleSyncNow, handleDeleteBackup,
handleDeleteRemoteBackup, handleRestoreBackup, handleRestoreRemoteBackup, handleSetAutoSync, openCloudUpsell, userSecrets, handleCreateSecret, handleUpdateSecret, handleDeleteSecret, agentToolPackages, agentToolSettings, officialTools, selectedToolsTool, agentToolBusyId, officialToolBusyId, agentToolError, agentToolErrorCode, setSelectedToolsTool, handleAgentToolApprovalChange, runOfficialToolAction, refreshOfficialTools, activeLocale, codexAuthBusy, claudeAuthBusy, themePreference, setThemePreference, languagePreference, systemLocale,
setLanguagePreference, chatBotPicture, setChatBotPicture, handleAgentDefaultsChange, handleDeveloperModeChange, setCodexConfigOpen, closeCodexConfig, handleReinstallCodex, setClaudeConfigOpen, closeClaudeConfig, handleReinstallClaude, desktopUpdateBusy, runDesktopUpdateAction, memories, handleCreateMemory, handleUpdateMemory, handleDeleteMemory, cloudIdentity, setCloudIdentity, setEarlyAccessEnabled, setAdvancedMode, pendingInstallGate, pendingInstallBusy, setPendingInstallGate, renderInstallTool, renderInstallItem, handleConfirmInstallWithTools, cloudModalOpen,
forgerAccountMessage, handleForgerLogin, handleForgerGoogleLogin, handleForgerAppleLogin, handleForgerRegister, handleForgerUsernameUpdate, codexConfigOpen, handleConnectCodexAuth, refreshCodexAuthStatus, claudeConfigOpen, handleConnectClaudeAuth, refreshClaudeAuthStatus, agentProviderConfigOpen, categoryDialogOpen, setCategoryDialogOpen, categoryDialogName, setCategoryDialogName, handleCreateCategorySubmit, renameCategoryDialog, setRenameCategoryDialog, handleRenameCategorySubmit, renameFileDialog, setRenameFileDialog, handleRenameFileSubmit, moveFileDialog, setMoveFileDialog,
handleMoveFileSubmit, remoteTunnelReadyDialog, closeRemoteTunnelReadyDialog, stopReadyRemoteTunnel, openRemoteTunnelPortal, socialUploadDialog, closeSocialUploadDialog, setSocialUploadVisibility, submitSocialUploadDialog, errorReportDialog, closeErrorReportDialog, copyErrorReportDetails, submitErrorReport, bannerMessage, bannerSeverity };
}
