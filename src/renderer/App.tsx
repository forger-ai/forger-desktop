import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  TextField,
  Snackbar,
  ThemeProvider,
  useMediaQuery,
} from '@mui/material';
import type { AlertColor } from '@mui/material';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  AppCategory,
  AppDetails,
  AppSummary,
  Automation,
  AutomationRun,
  AutomationRunSummary,
  AutomationUpsertInput,
  CatalogApp,
  CodexAuthStatus,
  CodexModelOption,
  CodexReasoningEffort,
  FilesListInput,
  ForgerFileCategory,
  ForgerFileRecord,
  PickedChatFile,
  Settings,
  SharedFileRef,
} from '@shared/types';
import { AppShell } from '@renderer/components/AppShell';
import { CodexConfigModal } from '@renderer/components/CodexConfigModal';
import { ForgerCloudModal } from '@renderer/components/ForgerCloudModal';
import { defaultLocale, getDictionary, type Locale } from '@renderer/i18n';
import { buildAppTheme, resolveThemeMode, type ThemePreference } from '@renderer/theme/appTheme';
import { AppView } from '@renderer/views/AppView';
import { AutomationsView } from '@renderer/views/AutomationsView';
import { CatalogView } from '@renderer/views/CatalogView';
import { ChatView, type ChatMessage, type ConversationHistoryItem } from '@renderer/views/ChatView';
import { DataView } from '@renderer/views/DataView';
import { FilesView } from '@renderer/views/FilesView';
import { InstalledAppsView } from '@renderer/views/InstalledAppsView';
import { SettingsView } from '@renderer/views/SettingsView';
import { ToolsView } from '@renderer/views/ToolsView';
import type { View } from '@renderer/components/Sidebar';
import chatBotIcon from '@renderer/assets/chat-bot-icon.png';
import chatFemaleIcon from '@renderer/assets/chat-female-icon.png';
import chatMaleIcon from '@renderer/assets/chat-male-icon.png';

const THEME_STORAGE_KEY = 'forger-theme-preference';
const LANGUAGE_STORAGE_KEY = 'forger-language-preference';
const CHAT_STORAGE_KEY = 'forger-chat-conversations-v1';
const CODEX_MODEL_STORAGE_KEY = 'forger-codex-model-v1';
const CODEX_REASONING_STORAGE_KEY = 'forger-codex-reasoning-effort-v1';
const CHAT_BOT_PICTURE_STORAGE_KEY = 'forger-chat-bot-picture-v1';
const FORGER_DATA_ROOT_NAME = import.meta.env.DEV ? 'dev-data' : 'data';

export type ChatBotPicture = 'bot' | 'female' | 'male';
export type LanguagePreference = 'system' | Locale;

const SUPPORTED_LOCALES: Locale[] = ['es', 'en'];

const CHAT_BOT_PICTURE_OPTIONS: Array<{ value: ChatBotPicture; label: string; src: string }> = [
  { value: 'bot', label: 'Bot', src: chatBotIcon },
  { value: 'female', label: 'Female', src: chatFemaleIcon },
  { value: 'male', label: 'Male', src: chatMaleIcon },
];

const CODEX_MODEL_OPTIONS: CodexModelOption[] = [
  { displayModelName: '5.3 Codex', realModelName: 'gpt-5.3-codex', defaultReasoningEffort: 'low' as const },
  { displayModelName: '5.3 Spark', realModelName: 'gpt-5.3-codex-spark', defaultReasoningEffort: 'high' as const },
  { displayModelName: '5.4', realModelName: 'gpt-5.4', defaultReasoningEffort: 'medium' as const },
  { displayModelName: '5.4 Mini', realModelName: 'gpt-5.4-mini', defaultReasoningEffort: 'medium' as const },
  { displayModelName: '5.5', realModelName: 'gpt-5.5', defaultReasoningEffort: 'medium' as const },
];

const CODEX_REASONING_OPTIONS: { label: string; value: CodexReasoningEffort }[] = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'XHigh', value: 'xhigh' },
];

const initialSettings: Settings = {
  userEmail: '',
  plan: 'Free',
  safeMode: false,
};

const initialCodexAuthStatus: CodexAuthStatus = {
  installed: false,
  authenticated: false,
  authFilePath: '',
  codexHome: '',
};

const initialAgentToolSettings: AgentToolSettings = {
  approvals: {
    forger_list_catalog: false,
    forger_list_installed_apps: false,
    forger_check_updates: false,
    forger_get_app_runtime_status: false,
    forger_open_app: true,
    forger_stop_app: true,
    forger_restart_app: true,
    forger_refresh_app_view: true,
    forger_update_app: true,
  },
};

const normalizeLocale = (value?: string | null): Locale | null => {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  return SUPPORTED_LOCALES.find((locale) => normalized === locale || normalized.startsWith(`${locale}-`)) ?? null;
};

const resolveSystemLocale = (): Locale => {
  if (typeof navigator === 'undefined') {
    return defaultLocale;
  }
  for (const language of navigator.languages ?? []) {
    const locale = normalizeLocale(language);
    if (locale) {
      return locale;
    }
  }
  return normalizeLocale(navigator.language) ?? defaultLocale;
};

const getStoredLanguagePreference = (): LanguagePreference => {
  if (typeof window === 'undefined') {
    return 'system';
  }
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (stored === 'system' || SUPPORTED_LOCALES.includes(stored as Locale)) {
    return stored as LanguagePreference;
  }
  return 'system';
};

const getStoredThemePreference = (): ThemePreference => {
  if (typeof window === 'undefined') {
    return 'system';
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }

  return 'system';
};

const getStoredCodexModel = (): string => {
  if (typeof window === 'undefined') {
    return CODEX_MODEL_OPTIONS[0].realModelName;
  }
  const stored = window.localStorage.getItem(CODEX_MODEL_STORAGE_KEY);
  return CODEX_MODEL_OPTIONS.some((option) => option.realModelName === stored)
    ? stored as string
    : CODEX_MODEL_OPTIONS[0].realModelName;
};

const getStoredCodexReasoningEffort = (): CodexReasoningEffort => {
  if (typeof window === 'undefined') {
    return CODEX_MODEL_OPTIONS[0].defaultReasoningEffort;
  }
  const stored = window.localStorage.getItem(CODEX_REASONING_STORAGE_KEY);
  return CODEX_REASONING_OPTIONS.some((option) => option.value === stored)
    ? stored as CodexReasoningEffort
    : CODEX_MODEL_OPTIONS[0].defaultReasoningEffort;
};

const getStoredChatBotPicture = (): ChatBotPicture => {
  if (typeof window === 'undefined') {
    return 'bot';
  }
  const stored = window.localStorage.getItem(CHAT_BOT_PICTURE_STORAGE_KEY);
  if (stored === 'bot' || stored === 'female' || stored === 'male') {
    return stored;
  }
  const options = CHAT_BOT_PICTURE_OPTIONS.map((option) => option.value);
  return options[Math.floor(Math.random() * options.length)] ?? 'bot';
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

interface ChatConversation {
  id: string;
  appId: string;
  title: string;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

interface PersistedChatState {
  conversations: ChatConversation[];
  activeConversationByApp: Record<string, string>;
  lastActiveConversationId: string | null;
}

const readPersistedChatState = (): PersistedChatState => {
  if (typeof window === 'undefined') {
    return {
      conversations: [],
      activeConversationByApp: {},
      lastActiveConversationId: null,
    };
  }

  const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
  if (!raw) {
    return {
      conversations: [],
      activeConversationByApp: {},
      lastActiveConversationId: null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedChatState>;
    return {
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      activeConversationByApp:
        parsed.activeConversationByApp && typeof parsed.activeConversationByApp === 'object'
          ? (parsed.activeConversationByApp as Record<string, string>)
          : {},
      lastActiveConversationId:
        typeof parsed.lastActiveConversationId === 'string' ? parsed.lastActiveConversationId : null,
    };
  } catch {
    return {
      conversations: [],
      activeConversationByApp: {},
      lastActiveConversationId: null,
    };
  }
};

const makeConversationId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `conv-${Date.now()}`;

const summarizeConversationTitle = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'Conversacion nueva';
  }
  return compact.length <= 56 ? compact : `${compact.slice(0, 56)}...`;
};

function App() {
  const persistedChatState = useMemo(() => readPersistedChatState(), []);
  const [currentView, setCurrentView] = useState<View>('my-apps');
  const [installedApps, setInstalledApps] = useState<AppSummary[]>([]);
  const [catalogApps, setCatalogApps] = useState<CatalogApp[]>([]);
  const [openingAppIds, setOpeningAppIds] = useState<Set<string>>(new Set());
  const openingAppIdsRef = useRef<Set<string>>(new Set());
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const [codexAuthStatus, setCodexAuthStatus] = useState<CodexAuthStatus>(initialCodexAuthStatus);
  const [agentToolPackages, setAgentToolPackages] = useState<AgentToolPackageDefinition[]>([]);
  const [agentToolSettings, setAgentToolSettings] = useState<AgentToolSettings>(initialAgentToolSettings);
  const [agentToolBusyId, setAgentToolBusyId] = useState<AgentToolDefinition['id'] | null>(null);
  const [agentToolError, setAgentToolError] = useState<string | null>(null);
  const [cloudModalOpen, setCloudModalOpen] = useState(false);
  const [codexConfigOpen, setCodexConfigOpen] = useState(false);
  const [selectedAppDetailsId, setSelectedAppDetailsId] = useState<string | null>(null);
  const [selectedAppDetails, setSelectedAppDetails] = useState<AppDetails | null>(null);
  const [appDetailsBackView, setAppDetailsBackView] = useState<View>('catalog');
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [selectedDataAppId, setSelectedDataAppId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [pendingChatFiles, setPendingChatFiles] = useState<PickedChatFile[]>([]);
  const [mentionedChatFileIds, setMentionedChatFileIds] = useState<string[]>([]);
  const [uploadCategoryPath, setUploadCategoryPath] = useState('');
  const [selectedCodexModel, setSelectedCodexModel] = useState(getStoredCodexModel);
  const [selectedCodexReasoningEffort, setSelectedCodexReasoningEffort] = useState(getStoredCodexReasoningEffort);
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
  const promptedUpdateAppIdsRef = useRef<Set<string>>(new Set());
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
    CHAT_BOT_PICTURE_OPTIONS.find((option) => option.value === chatBotPicture)?.src ?? chatBotIcon;

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
    () =>
      chatConversations
        .filter((conversation) => (selectedAppId ? conversation.appId === selectedAppId : true))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          threadId: conversation.threadId,
          updatedAt: conversation.updatedAt,
        })),
    [chatConversations, selectedAppId],
  );

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

  useEffect(() => {
    const loadData = async () => {
      const desktopApi = getDesktopApi();
      const [appsResult, settingsResult, codexAuthResult, toolsResult, filesResult, categoriesResult, automationsResult] = await Promise.allSettled([
        refreshApps(),
        desktopApi.getSettings(),
        desktopApi.getCodexAuthStatus(),
        refreshAgentTools(),
        desktopApi.filesList(fileFilters),
        desktopApi.filesListCategories(),
        desktopApi.automationsList(),
      ]);

      if (appsResult.status === 'rejected') {
        setBannerSeverity('error');
        setBannerMessage(t.settings.authErrorFallback);
      }

      if (settingsResult.status === 'fulfilled') {
        setSettings(settingsResult.value);
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

      if (codexAuthResult.status === 'fulfilled') {
        setCodexAuthStatus(codexAuthResult.value);
        if (!codexAuthResult.value.authenticated) {
          setCodexConfigOpen(true);
        }
      }

      if (toolsResult.status === 'rejected') {
        setAgentToolError(t.sections.tools.saveError);
      }
    };

    void loadData();
  }, []);

  useEffect(() => {
    let desktopApi: ReturnType<typeof getDesktopApi>;
    try {
      desktopApi = getDesktopApi();
    } catch {
      return () => undefined;
    }

    const unsubscribeInstall = desktopApi.onInstallProgress(({ appId, progress }) => {
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

    return () => {
      unsubscribeInstall();
      unsubscribeRuntime();
      unsubscribeChat();
      unsubscribeAutomation();
    };
  }, []);

  useEffect(() => {
    selectedAutomationIdRef.current = selectedAutomationId;
  }, [selectedAutomationId]);

  useEffect(() => {
    if (currentView !== 'chat') {
      return;
    }
    if (selectedAppId) {
      return;
    }
    if (installedApps.length === 0) {
      return;
    }
    setSelectedAppId(installedApps[0].id);
  }, [currentView, selectedAppId, installedApps]);

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
    if (!selectedAppId) {
      setActiveConversationId(null);
      return;
    }

    const appSpecificActive = activeConversationByApp[selectedAppId];
    const appConversations = chatConversations
      .filter((conversation) => conversation.appId === selectedAppId)
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
    void desktopApi.getAppDetails(selectedAppDetailsId).then(setSelectedAppDetails);
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
      window.localStorage.setItem(CHAT_BOT_PICTURE_STORAGE_KEY, chatBotPicture);
    }
  }, [chatBotPicture]);

  const getAppMeta = (appId: string) => {
    const fromCatalog = catalogApps.find((appEntry) => appEntry.id === appId);
    if (fromCatalog?.name) {
      return {
        name: fromCatalog.name,
        description: fromCatalog.description ?? '',
      };
    }

    const fromInstalled = installedApps.find((appEntry) => appEntry.id === appId);
    if (fromInstalled?.name) {
      return {
        name: fromInstalled.name,
        description: fromInstalled.description ?? '',
      };
    }

    return (
      t.apps[appId as keyof typeof t.apps] ?? {
        name: appId,
        description: '',
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

  const handleInstall = async (appId: string) => {
    try {
      const desktopApi = getDesktopApi();
      const result = await desktopApi.installApp(appId);

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
      }
    } catch (_error) {
      setBannerSeverity('error');
      setBannerMessage(t.settings.authErrorFallback);
    }
  };

  const handleUpdate = async (appId: string) => {
    try {
      const desktopApi = getDesktopApi();
      const result = await desktopApi.updateApp(appId);
      await refreshApps();
      setBannerSeverity(result.success ? 'success' : result.phase === 'conflict' ? 'warning' : 'error');
      setBannerMessage(result.userMessage);
      if (selectedAppDetailsId === appId) {
        setSelectedAppDetails(await desktopApi.getAppDetails(appId));
      }
    } catch (_error) {
      setBannerSeverity('error');
      setBannerMessage(t.settings.authErrorFallback);
    }
  };

  const handleAgentToolApprovalChange = async (
    toolId: AgentToolDefinition['id'],
    requiresApproval: boolean,
  ) => {
    setAgentToolBusyId(toolId);
    setAgentToolError(null);
    try {
      const updated = await getDesktopApi().updateAgentToolApproval({ toolId, requiresApproval });
      setAgentToolSettings(updated);
    } catch (_error) {
      setAgentToolError(t.sections.tools.saveError);
    } finally {
      setAgentToolBusyId(null);
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

  useEffect(() => {
    const candidate = installedApps.find((appEntry) => appEntry.updateAvailable && appEntry.latestVersion && appEntry.status === 'installed');
    if (!candidate || promptedUpdateAppIdsRef.current.has(`${candidate.id}:${candidate.latestVersion}`)) {
      return;
    }
    const latestVersion = candidate.latestVersion;
    if (!latestVersion) {
      return;
    }
    promptedUpdateAppIdsRef.current.add(`${candidate.id}:${candidate.latestVersion}`);
    const meta = getAppMeta(candidate.id);
    const changes = candidate.changelog?.changes?.length ? `\n\n${candidate.changelog.changes.map((change) => `- ${change}`).join('\n')}` : `\n\n${t.appView.updateNoChangelog}`;
    const confirmed = window.confirm(`${t.appView.updatePrompt(meta.name, latestVersion)}${changes}`);
    if (confirmed) {
      void handleUpdate(candidate.id);
    }
  }, [installedApps]);

  const handleOpen = async (appId: string) => {
    if (openingAppIdsRef.current.has(appId)) {
      return;
    }
    openingAppIdsRef.current = new Set(openingAppIdsRef.current).add(appId);
    setOpeningAppIds(new Set(openingAppIdsRef.current));

    const desktopApi = getDesktopApi();
    try {
      const result = await desktopApi.openApp(appId);

      if (result.success) {
        setBannerSeverity('success');
        setBannerMessage(result.userMessage);
      } else {
        setBannerSeverity('error');
        setBannerMessage(result.userMessage);
      }
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

    if ((!trimmed && pendingChatFiles.length === 0 && mentionedChatFileIds.length === 0) || !selectedAppId || chatRunActive || !codexAuthStatus.authenticated) {
      if (!codexAuthStatus.authenticated) {
        setCodexConfigOpen(true);
      }
      return;
    }

    let targetConversationId = activeConversationId;
    if (!targetConversationId) {
      const now = new Date().toISOString();
      const createdConversation: ChatConversation = {
        id: makeConversationId(),
        appId: selectedAppId,
        title: summarizeConversationTitle(userVisibleContent),
        threadId: null,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      targetConversationId = createdConversation.id;
      setChatConversations((current) => [createdConversation, ...current]);
      setActiveConversationId(createdConversation.id);
      setActiveConversationByApp((current) => ({ ...current, [selectedAppId]: createdConversation.id }));
    }

    const conversationForRun = chatConversations.find((conversation) => conversation.id === targetConversationId);
    setActiveConversationByApp((current) => ({ ...current, [selectedAppId]: targetConversationId as string }));
    setChatRunActive(true);
    activeRunConversationIdRef.current = targetConversationId;

    try {
      const desktopApi = getDesktopApi();
      const modelOption =
        CODEX_MODEL_OPTIONS.find((option) => option.realModelName === selectedCodexModel) ?? CODEX_MODEL_OPTIONS[0];
      const importedFiles = pendingChatFiles.length > 0
        ? await desktopApi.filesImport({
            sourcePaths: pendingChatFiles.map((file) => file.sourcePath),
            categoryPath: uploadCategoryPath,
            appId: selectedAppId,
          })
        : [];
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
            conversation.title === 'Conversacion nueva' && conversation.messages.length === 0
              ? summarizeConversationTitle(userVisibleContent)
              : conversation.title;
          return {
            ...conversation,
            title: nextTitle,
            updatedAt: now,
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
        appId: selectedAppId,
        prompt: trimmed || 'Review the shared files in this message.',
        threadId: conversationForRun?.threadId ?? null,
        userLanguage: activeLocale,
        sharedFiles,
        model: modelOption.realModelName,
        reasoningEffort: selectedCodexReasoningEffort,
      });
      runConversationIdByRunRef.current.set(startResult.runId, targetConversationId);
    } catch (error) {
      setChatRunActive(false);
      activeRunConversationIdRef.current = null;
      const detail = error instanceof Error ? error.message : t.settings.authErrorFallback;
      const friendly =
        /another_run_in_progress/i.test(detail)
          ? 'Todavia estoy procesando tu mensaje anterior. Espera la respuesta o cancela esa solicitud.'
          : `No pude enviar tu mensaje a Codex. ${detail}`;
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
    }
  };

  const handleOpenConversation = (conversationId: string) => {
    const target = chatConversations.find((conversation) => conversation.id === conversationId);
    if (!target) {
      return;
    }
    setSelectedAppId(target.appId);
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
    if (!selectedAppId) {
      return;
    }
    const now = new Date().toISOString();
    const nextConversation: ChatConversation = {
      id: makeConversationId(),
      appId: selectedAppId,
      title: 'Conversacion nueva',
      threadId: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    setChatConversations((current) => [nextConversation, ...current]);
    setActiveConversationId(nextConversation.id);
    setActiveConversationByApp((current) => ({ ...current, [selectedAppId]: nextConversation.id }));
    setChatInput('');
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

  const handleConnectCodexAuth = async () => {
    setCodexAuthBusy(true);
    try {
      const desktopApi = getDesktopApi();
      const result = await desktopApi.connectCodexAuth();
      setBannerSeverity(result.success ? 'info' : 'error');
      setBannerMessage(result.userMessage);
      await refreshCodexAuthStatus();
    } catch {
      setBannerSeverity('error');
      setBannerMessage(t.settings.codexConnectError);
    } finally {
      setCodexAuthBusy(false);
    }
  };

  const handleDisconnectCodexAuth = async () => {
    setCodexAuthBusy(true);
    try {
      const desktopApi = getDesktopApi();
      const result = await desktopApi.disconnectCodexAuth();
      setBannerSeverity(result.success ? 'success' : 'error');
      setBannerMessage(result.userMessage);
      await refreshCodexAuthStatus();
    } catch {
      setBannerSeverity('error');
      setBannerMessage(t.settings.codexDisconnectError);
    } finally {
      setCodexAuthBusy(false);
    }
  };

  const resolvedMode = resolveThemeMode(themePreference, prefersDark);
  const theme = useMemo(() => buildAppTheme(resolvedMode), [resolvedMode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
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
          />
        ) : null}

        {currentView === 'app' ? (
          <AppView
            details={selectedAppDetails}
            openingAppIds={openingAppIds}
            t={t}
            categoryLabel={selectedAppDetails ? getCategoryLabel(selectedAppDetails.app.category) : ''}
            onBack={() => setCurrentView(appDetailsBackView)}
            onInstall={(appId) => void handleInstall(appId)}
            onUpdate={(appId) => void handleUpdate(appId)}
            onOpen={(appId) => void handleOpen(appId)}
            onStop={(appId) => void handleStop(appId)}
            onRestoreUserVersion={(appId) => void handleRestoreUserVersion(appId)}
            onResolveConflict={(appId) => void handleResolveConflict(appId)}
            onDelete={(appId) => void handleDeleteApp(appId)}
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
            onCreateUploadCategory={() => openCreateCategoryDialog(undefined, true)}
            onRemovePendingFile={(sourcePath) => setPendingChatFiles((current) => current.filter((file) => file.sourcePath !== sourcePath))}
            onMentionFile={handleMentionFile}
            onRemoveMentionedFile={(fileId) => setMentionedChatFileIds((current) => current.filter((id) => id !== fileId))}
            modelOptions={CODEX_MODEL_OPTIONS}
            selectedModel={selectedCodexModel}
            onSelectModel={setSelectedCodexModel}
            reasoningOptions={CODEX_REASONING_OPTIONS}
            selectedReasoningEffort={selectedCodexReasoningEffort}
            onSelectReasoningEffort={setSelectedCodexReasoningEffort}
            onOpenCodexUsageDashboard={() => void getDesktopApi().openCodexUsageDashboard()}
            assistantAvatarSrc={chatBotPictureSrc}
            isSending={chatRunActive}
            progressLines={chatProgressLines}
            codexConfigured={codexAuthStatus.authenticated}
            onConfigureCodex={() => setCodexConfigOpen(true)}
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
            transcript={selectedAutomationRun?.transcript ?? ''}
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

        {currentView === 'datos' ? (
          <DataView
            t={t}
            selectedAppId={selectedDataAppId}
            onDbListTables={(appId) => getDesktopApi().dbListTables(appId)}
            onDbQueryTable={(appId, tableName, limit) => getDesktopApi().dbQueryTable(appId, tableName, limit)}
          />
        ) : null}

        {currentView === 'tools' ? (
          <ToolsView
            packages={agentToolPackages}
            settings={agentToolSettings}
            busyToolId={agentToolBusyId}
            errorMessage={agentToolError}
            t={t}
            onApprovalChange={(toolId, requiresApproval) =>
              void handleAgentToolApprovalChange(toolId, requiresApproval)
            }
          />
        ) : null}

        {currentView === 'settings' ? (
          <SettingsView
            codexAuthBusy={codexAuthBusy}
            codexAuthStatus={codexAuthStatus}
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
            onOpenCodexConfig={() => setCodexConfigOpen(true)}
          />
        ) : null}
      </AppShell>

      <ForgerCloudModal
        open={cloudModalOpen}
        t={t}
        onClose={() => setCloudModalOpen(false)}
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
