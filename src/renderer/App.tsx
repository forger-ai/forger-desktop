import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, CssBaseline, Snackbar, ThemeProvider, useMediaQuery } from '@mui/material';
import type { AlertColor } from '@mui/material';
import type {
  AppCategory,
  AppDetails,
  AppSummary,
  CatalogApp,
  CodexAuthStatus,
  Settings,
} from '@shared/types';
import { AppShell } from '@renderer/components/AppShell';
import { CodexConfigModal } from '@renderer/components/CodexConfigModal';
import { ForgerCloudModal } from '@renderer/components/ForgerCloudModal';
import { getDictionary } from '@renderer/i18n';
import { buildAppTheme, resolveThemeMode, type ThemePreference } from '@renderer/theme/appTheme';
import { AppView } from '@renderer/views/AppView';
import { CatalogView } from '@renderer/views/CatalogView';
import { ChatView, type ChatMessage, type ConversationHistoryItem } from '@renderer/views/ChatView';
import { DataView } from '@renderer/views/DataView';
import { InstalledAppsView } from '@renderer/views/InstalledAppsView';
import { SettingsView } from '@renderer/views/SettingsView';
import type { View } from '@renderer/components/Sidebar';

const t = getDictionary('es');
const THEME_STORAGE_KEY = 'forger-theme-preference';
const CHAT_STORAGE_KEY = 'forger-chat-conversations-v1';

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
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const [codexAuthStatus, setCodexAuthStatus] = useState<CodexAuthStatus>(initialCodexAuthStatus);
  const [cloudModalOpen, setCloudModalOpen] = useState(false);
  const [codexConfigOpen, setCodexConfigOpen] = useState(false);
  const [selectedAppDetailsId, setSelectedAppDetailsId] = useState<string | null>(null);
  const [selectedAppDetails, setSelectedAppDetails] = useState<AppDetails | null>(null);
  const [appDetailsBackView, setAppDetailsBackView] = useState<View>('catalog');
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [selectedDataAppId, setSelectedDataAppId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
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
  const deliveredRunRepliesRef = useRef<Set<string>>(new Set());
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [bannerSeverity, setBannerSeverity] = useState<AlertColor>('success');
  const [catalogFilter, setCatalogFilter] = useState<'all' | AppCategory>('all');
  const [catalogStatusFilter, setCatalogStatusFilter] = useState<'all' | 'installed' | 'not_installed'>('all');
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(getStoredThemePreference);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');

  const activeConversation = useMemo(
    () => chatConversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [chatConversations, activeConversationId],
  );
  const chatMessages = activeConversation?.messages ?? [];
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

  useEffect(() => {
    const loadData = async () => {
      const desktopApi = getDesktopApi();
      const [installedResult, catalogResult, settingsResult, codexAuthResult] = await Promise.allSettled([
        desktopApi.listInstalledApps(),
        desktopApi.listCatalogApps(),
        desktopApi.getSettings(),
        desktopApi.getCodexAuthStatus(),
      ]);

      if (installedResult.status === 'fulfilled') {
        setInstalledApps(installedResult.value);
      }

      if (catalogResult.status === 'fulfilled') {
        setCatalogApps(catalogResult.value);
      } else {
        setBannerSeverity('error');
        setBannerMessage(t.settings.authErrorFallback);
      }

      if (settingsResult.status === 'fulfilled') {
        setSettings(settingsResult.value);
      }

      if (codexAuthResult.status === 'fulfilled') {
        setCodexAuthStatus(codexAuthResult.value);
        if (!codexAuthResult.value.authenticated) {
          setCodexConfigOpen(true);
        }
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

      void Promise.all([desktopApi.listInstalledApps(), desktopApi.listCatalogApps()]).then(
        ([installed, catalog]) => {
          setInstalledApps(installed);
          setCatalogApps(catalog);
        },
      );

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

      void Promise.all([desktopApi.listInstalledApps(), desktopApi.listCatalogApps()]).then(
        ([installed, catalog]) => {
          setInstalledApps(installed);
          setCatalogApps(catalog);
        },
      );
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

      const isMessageTerminal =
        run.status === 'preview_ready' ||
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
      const targetConversationId = activeRunConversationIdRef.current ?? activeConversationId;
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
        activeRunConversationIdRef.current = null;
      }
    });

    return () => {
      unsubscribeInstall();
      unsubscribeRuntime();
      unsubscribeChat();
    };
  }, []);

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

      const [installed, catalog] = await Promise.all([
        desktopApi.listInstalledApps(),
        desktopApi.listCatalogApps(),
      ]);

      setInstalledApps(installed);
      setCatalogApps(catalog);

      if (result.success) {
        setBannerSeverity('success');
        setBannerMessage(result.userMessage || t.banners.installed(getAppMeta(appId).name));
        const welcome = await desktopApi.installWelcome(appId);
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

  const handleOpen = async (appId: string) => {
    const desktopApi = getDesktopApi();
    const result = await desktopApi.openApp(appId);

    if (result.success) {
      setBannerSeverity('success');
      setBannerMessage(result.userMessage);
    } else {
      setBannerSeverity('error');
      setBannerMessage(result.userMessage);
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
    const [installed, catalog] = await Promise.all([
      desktopApi.listInstalledApps(),
      desktopApi.listCatalogApps(),
    ]);
    setInstalledApps(installed);
    setCatalogApps(catalog);
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

  const handleSendMessage = async (nextMessage?: string) => {
    const trimmed = (nextMessage ?? chatInput).trim();

    if (!trimmed || !selectedAppId || chatRunActive || !codexAuthStatus.authenticated) {
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
        title: summarizeConversationTitle(trimmed),
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
    const now = new Date().toISOString();
    setChatConversations((currentConversations) =>
      currentConversations.map((conversation) => {
        if (conversation.id !== targetConversationId) {
          return conversation;
        }
        const nextTitle =
          conversation.title === 'Conversacion nueva' && conversation.messages.length === 0
            ? summarizeConversationTitle(trimmed)
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
              content: trimmed,
            },
          ],
        };
      }),
    );
    setChatInput('');
    setChatRunActive(true);
    activeRunConversationIdRef.current = targetConversationId;

    try {
      const desktopApi = getDesktopApi();
      await desktopApi.chatStartRun({
        appId: selectedAppId,
        prompt: trimmed,
        threadId: conversationForRun?.threadId ?? null,
      });
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
            t={t}
            getAppMeta={getAppMeta}
            getCategoryLabel={getCategoryLabel}
            onOpen={handleOpen}
            onStop={handleStop}
            onRetry={handleRetry}
            onDetails={(appId) => void openAppDetails(appId, 'my-apps')}
            onDelete={(appId) => void handleDeleteApp(appId)}
            onGoCatalog={() => setCurrentView('catalog')}
          />
        ) : null}

        {currentView === 'catalog' ? (
          <CatalogView
            apps={catalogApps}
            filter={catalogFilter}
            onFilterChange={setCatalogFilter}
            statusFilter={catalogStatusFilter}
            onStatusFilterChange={setCatalogStatusFilter}
            onInstall={handleInstall}
            onOpen={handleOpen}
            onStop={handleStop}
            onRetry={handleRetry}
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
            t={t}
            categoryLabel={selectedAppDetails ? getCategoryLabel(selectedAppDetails.app.category) : ''}
            onBack={() => setCurrentView(appDetailsBackView)}
            onInstall={(appId) => void handleInstall(appId)}
            onOpen={(appId) => void handleOpen(appId)}
            onStop={(appId) => void handleStop(appId)}
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
            isSending={chatRunActive}
            progressLines={chatProgressLines}
            codexConfigured={codexAuthStatus.authenticated}
            onConfigureCodex={() => setCodexConfigOpen(true)}
            onOpenApp={(appId) => void handleOpen(appId)}
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

        {currentView === 'settings' ? (
          <SettingsView
            codexAuthBusy={codexAuthBusy}
            codexAuthStatus={codexAuthStatus}
            t={t}
            themePreference={themePreference}
            onThemeChange={setThemePreference}
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
