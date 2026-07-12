import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import AddRounded from '@mui/icons-material/AddRounded';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import AttachFileRounded from '@mui/icons-material/AttachFileRounded';
import BugReportRounded from '@mui/icons-material/BugReportRounded';
import ChatRounded from '@mui/icons-material/ChatRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DescriptionRounded from '@mui/icons-material/DescriptionRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import type { AgentProvider, AppSummary, AutomationFrequency, AutomationMissedRunPolicy, PersonalAgent, PersonalAgentConversation, PersonalAgentConversationEvent, PersonalAgentGrantOptions, PersonalAgentMessage, PersonalAgentPeerThread, PersonalAgentRoutine, PersonalAgentRun, PersonalAgentWorkspaceEntry, PersonalAgentWorkspaceFile, PickedChatFile, SharedFileRef, WindowControlState } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { AGENT_PROVIDER_OPTIONS, CODEX_MODEL_OPTIONS } from '@renderer/preferences';
import { usageAnalytics } from '@renderer/usage-analytics';
import { AgentRunActivityReceipt } from '@renderer/components/AgentRunActivityReceipt';
import { mergeConversationSnapshots, newerConversation } from '@renderer/stores/personal-agent-conversation-snapshots';
import { MarkdownMessage } from './chat/MarkdownMessage';
import {
  isMacOsPlatform,
  sortItemsByRecentActivity,
} from './chat/history-drawer-helpers';
import { AgentConversationHistoryDrawer } from './AgentConversationHistoryDrawer';
import {
  AgentRoutineDialog,
  AgentRoutinesPanel,
  clampRoutineIntervalMinutes,
  defaultRoutineMissedRunWindowMinutes,
  normalizeTimeOfDay,
} from './AgentRoutinesPanel';
import { DEFAULT_INTERVAL_MINUTES } from '@shared/types';
import {
  type AccessDraft,
  type AgentConversationHistoryGroup,
  type RenderPersonalAgentMessageOptions,
  accessDraftFromAgent,
  compactFileLabel,
  defaultAccessDraft,
  isTerminalRunStatus,
  personalAgentRunErrorMessage,
  personalAgentSaveErrorMessage,
  progressMessagesForMessageRun,
  upsertConversation,
  visiblePeerThreadMessages,
  WorkspaceTree,
} from './AgentsView.helpers';
import { AgentAccessControls } from './AgentAccessControls';
interface AgentsViewProps {
  t: AppDictionary;
  intelligenceProviderConfigured: boolean;
  providerOptions?: Array<{ label: string; value: AgentProvider | 'auto' }>;
  installedApps?: AppSummary[];
  onNotifyForger?: (input: { agent: PersonalAgent; conversation: PersonalAgentConversation; run?: PersonalAgentRun; auto?: boolean }) => void;
}

type AgentDetailTab = 'chat' | 'workspace' | 'routines' | 'settings';
type RoutineFrequencyType = AutomationFrequency['type'];

export function AgentsView({ t, intelligenceProviderConfigured, providerOptions = AGENT_PROVIDER_OPTIONS, installedApps = [], onNotifyForger }: AgentsViewProps) {
  const theme = useTheme();
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [sidekickNames, setSidekickNames] = useState<Record<string, string>>({});
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<PersonalAgentConversation[]>([]);
  const [conversation, setConversation] = useState<PersonalAgentConversation | null>(null);
  const [routines, setRoutines] = useState<PersonalAgentRoutine[]>([]);
  const [workspaceEntries, setWorkspaceEntries] = useState<PersonalAgentWorkspaceEntry[]>([]);
  const [grantOptions, setGrantOptions] = useState<PersonalAgentGrantOptions>({ apps: [], tools: [], connections: [], peerAgents: [] });
  const [openFile, setOpenFile] = useState<PersonalAgentWorkspaceFile | null>(null);
  const [fileDraft, setFileDraft] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [purpose, setPurpose] = useState('');
  const [createAccessDraft, setCreateAccessDraft] = useState<AccessDraft>(() => defaultAccessDraft());
  const [settingsAccessDraft, setSettingsAccessDraft] = useState<AccessDraft>(() => defaultAccessDraft());
  const [message, setMessage] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PickedChatFile[]>([]);
  const [detailTab, setDetailTab] = useState<AgentDetailTab>('chat');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [routineDialogOpen, setRoutineDialogOpen] = useState(false);
  const [editingRoutine, setEditingRoutine] = useState<PersonalAgentRoutine | null>(null);
  const [routineName, setRoutineName] = useState('');
  const [routinePrompt, setRoutinePrompt] = useState('');
  const [routineFrequencyType, setRoutineFrequencyType] = useState<RoutineFrequencyType>('hourly');
  const [routineTimeOfDay, setRoutineTimeOfDay] = useState('09:00');
  const [routineWeeklyDay, setRoutineWeeklyDay] = useState(1);
  const [routineIntervalMinutes, setRoutineIntervalMinutes] = useState(String(DEFAULT_INTERVAL_MINUTES));
  const [routineMissedRunPolicy, setRoutineMissedRunPolicy] = useState<AutomationMissedRunPolicy>('within_window');
  const [routineMissedRunWindowMinutes, setRoutineMissedRunWindowMinutes] = useState('30');
  const [routineEnabled, setRoutineEnabled] = useState(true);
  const [routineAuthorizationText, setRoutineAuthorizationText] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [windowState, setWindowState] = useState<WindowControlState | null>(null);
  const [collapsedHistoryGroups, setCollapsedHistoryGroups] = useState<Record<string, boolean>>({});
  const [historyGroupLimits, setHistoryGroupLimits] = useState<Record<string, number>>({});
  const [peerThreads, setPeerThreads] = useState<PersonalAgentPeerThread[]>([]);
  const [openPeerThread, setOpenPeerThread] = useState<PersonalAgentPeerThread | null>(null);
  const [busyAction, setBusyAction] = useState<'create' | 'delete' | 'file' | 'wake' | 'start' | 'send' | 'access' | 'routine' | 'cancelWakeup' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsDraftAgentVersion, setSettingsDraftAgentVersion] = useState<string | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const autoReportedRunIdsRef = useRef<Set<string>>(new Set());

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? null,
    [agents, activeAgentId],
  );
  const activeAgentVersion = activeAgent ? `${activeAgent.id}:${activeAgent.updatedAt}` : null;
  const settingsDraftReady = settingsDraftAgentVersion === activeAgentVersion;

  useEffect(() => {
    if (settingsDraftReady) {
      return;
    }
    setSettingsAccessDraft(activeAgent ? accessDraftFromAgent(activeAgent) : defaultAccessDraft());
    setSettingsDraftAgentVersion(activeAgentVersion);
  }, [activeAgent, activeAgentVersion, settingsDraftReady]);

  const isBlankAgent = Boolean(activeAgent && conversations.length === 0 && !conversation);
  const fileDirty = Boolean(openFile && fileDraft !== openFile.content);
  const activeRun = conversation?.activeRun;
  const runIsActive = Boolean(activeRun && !isTerminalRunStatus(activeRun.status));
  const scheduledWakeup = conversation?.scheduledWakeup?.status === 'scheduled' ? conversation.scheduledWakeup : null;
  const wakeupIsActive = Boolean(scheduledWakeup);
  const wakeupCountdownMs = scheduledWakeup ? Math.max(0, Date.parse(scheduledWakeup.dueAt) - nowMs) : 0;
  const wakeFlowInProgress = Boolean(
    !isBlankAgent &&
    runIsActive &&
    conversations.length === 1 &&
    conversation?.id === conversations[0]?.id,
  );
  const visibleMessages = useMemo(
    () => (conversation?.messages ?? []).filter((item) => item.role !== 'system' && item.kind !== 'intermediate'),
    [conversation?.messages],
  );
  const runErrorMessage = activeRun?.status === 'failed'
    ? personalAgentRunErrorMessage(activeRun.error, t)
    : null;
  const runErrorIsGeneric = runErrorMessage === t.agents.runErrorGeneric;
  const activeRunProgressCount = activeRun?.progress.length ?? 0;
  const activeRunActivityCount = activeRun?.activity?.items.length ?? 0;
  const busy = busyAction !== null;
  const conversationReadOnly = Boolean(conversation && (conversation.readOnly || conversation.origin === 'agent' || conversation.origin === 'sidekick'));
  const shouldReserveMacTrafficLightSpace = isMacOsPlatform() && !windowState?.isFullScreen;
  const installedAppsGrantOptionsKey = useMemo(
    () => installedApps
      .map((app) => `${app.id}:${app.name ?? ''}:${app.description ?? ''}:${app.shortDescription ?? ''}:${app.status}`)
      .sort()
      .join('|'),
    [installedApps],
  );
  const historyGroups = useMemo<AgentConversationHistoryGroup[]>(() => {
    const routineStarted = sortItemsByRecentActivity(conversations.filter((item) => item.origin === 'routine'));
    const userStarted = sortItemsByRecentActivity(conversations.filter((item) => item.origin === 'user'));
    const agentStarted = sortItemsByRecentActivity(conversations.filter((item) => item.origin === 'agent'));
    const sidekickStarted = sortItemsByRecentActivity(conversations.filter((item) => item.origin === 'sidekick'));
    const sidekickGroups = [...new Set(sidekickStarted.map((item) => item.sidekickId ?? ''))].map((sidekickId) => ({
      id: `sidekick-${sidekickId || 'unknown'}`,
      label: t.agents.conversationGroups.sidekick(sidekickId ? sidekickNames[sidekickId] : undefined),
      items: sidekickStarted.filter((item) => (item.sidekickId ?? '') === sidekickId),
    }));
    const groups: Array<AgentConversationHistoryGroup | null> = [
      ...sidekickGroups,
      routineStarted.length > 0
        ? { id: 'routine-started', label: t.agents.conversationGroups.routine, items: routineStarted }
        : null,
      userStarted.length > 0
        ? { id: 'user-started', label: t.agents.conversationGroups.user, items: userStarted }
        : null,
      agentStarted.length > 0
        ? { id: 'agent-started', label: t.agents.conversationGroups.agent, items: agentStarted }
        : null,
    ];
    return groups.filter((group): group is AgentConversationHistoryGroup => Boolean(group));
  }, [conversations, sidekickNames, t.locale]);

  useEffect(() => {
    if (!onNotifyForger || !activeAgent || !conversation || !activeRun || activeRun.status !== 'failed' || !runErrorIsGeneric) {
      return;
    }
    if (autoReportedRunIdsRef.current.has(activeRun.id)) {
      return;
    }
    autoReportedRunIdsRef.current.add(activeRun.id);
    onNotifyForger({ agent: activeAgent, conversation, run: activeRun, auto: true });
  }, [activeAgent, activeRun, conversation, onNotifyForger, runErrorIsGeneric]);

  const loadAgents = useCallback(async () => {
    const [nextAgents, sidekickState] = await Promise.all([
      window.forger.personalAgentsList(),
      window.forger.sidekicksGetState().catch(() => null),
    ]);
    setAgents(nextAgents);
    setSidekickNames(Object.fromEntries((sidekickState?.sidekicks ?? []).map((sidekick) => [sidekick.sidekickId, sidekick.name])));
    setActiveAgentId((current) => {
      if (!current) return null;
      return nextAgents.some((agent) => agent.id === current) ? current : null;
    });
  }, []);

  const loadAgentDetail = useCallback(async (agentId: string, preferredConversationId?: string) => {
    const [nextConversations, nextWorkspaceEntries, nextRoutines] = await Promise.all([
      window.forger.personalAgentConversationsList({ agentId }).catch(() => []),
      window.forger.personalAgentWorkspaceList({ agentId }).catch(() => []),
      window.forger.personalAgentRoutinesList({ agentId }).catch(() => []),
    ]);
    setConversations((current) => mergeConversationSnapshots(current.filter((item) => item.agentId === agentId), nextConversations));
    setWorkspaceEntries(nextWorkspaceEntries);
    setRoutines(nextRoutines);
    setConversation((current) => {
      if (current?.agentId === agentId) {
        const refreshed = nextConversations.find((item) => item.id === current.id);
        return refreshed ? newerConversation(current, refreshed) : current;
      }
      return nextConversations.find((item) => item.id === preferredConversationId) ?? nextConversations[0] ?? null;
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      window.forger.personalAgentsList(),
      window.forger.personalAgentGrantOptionsList().catch(() => ({ apps: [], tools: [], connections: [], peerAgents: [] })),
      window.forger.sidekicksGetState().catch(() => null),
    ])
      .then(([nextAgents, nextGrantOptions, sidekickState]) => {
        if (!mounted) return;
        setAgents(nextAgents);
        setGrantOptions(nextGrantOptions);
        setSidekickNames(Object.fromEntries((sidekickState?.sidekicks ?? []).map((sidekick) => [sidekick.sidekickId, sidekick.name])));
      })
      .catch((loadError) => {
        if (mounted) {
          setError(loadError instanceof Error ? loadError.message : t.agents.loadError);
        }
      });
    return () => {
      mounted = false;
    };
  }, [installedAppsGrantOptionsKey, t.agents.loadError]);

  useEffect(() => {
    if (!isMacOsPlatform()) {
      return undefined;
    }

    let mounted = true;
    void window.forger
      .getWindowState()
      .then((state) => {
        if (mounted) {
          setWindowState(state);
        }
      })
      .catch(() => undefined);

    const removeListener = window.forger.onWindowStateChanged((state) => {
      setWindowState(state);
    });

    return () => {
      mounted = false;
      removeListener();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!activeAgentId) {
      setConversations([]);
      setConversation(null);
      setRoutines([]);
      setWorkspaceEntries([]);
      setOpenFile(null);
      setFileDraft('');
      setPendingFiles([]);
      setPeerThreads([]);
      setOpenPeerThread(null);
      return () => {
        mounted = false;
      };
    }

    loadAgentDetail(activeAgentId).catch((detailError) => {
      if (mounted) {
        setError(detailError instanceof Error ? detailError.message : t.agents.loadError);
      }
    });
    return () => {
      mounted = false;
    };
  }, [activeAgentId, loadAgentDetail, t.agents.loadError]);

  useEffect(() => {
    const unsubscribe = window.forger.onPersonalAgentConversationEvent((event: PersonalAgentConversationEvent) => {
      if (!activeAgentId || event.conversation.agentId !== activeAgentId) {
        return;
      }
      setConversations((current) => upsertConversation(current, event.conversation));
      setConversation((current) => {
        if (!current || current.id === event.conversation.id) {
          return event.conversation;
        }
        return current;
      });
      if (event.routine) {
        setRoutines((current) => {
          const index = current.findIndex((item) => item.id === event.routine?.id);
          if (index < 0) {
            return [event.routine as PersonalAgentRoutine, ...current];
          }
          const next = [...current];
          next[index] = event.routine as PersonalAgentRoutine;
          return next.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        });
      }
    });
    return unsubscribe;
  }, [activeAgentId]);

  useEffect(() => {
    let mounted = true;
    if (!activeAgent || !conversation) {
      setPeerThreads([]);
      return () => {
        mounted = false;
      };
    }
    window.forger.personalAgentPeerThreadsList({ agentId: activeAgent.id, conversationId: conversation.id })
      .then((threads) => {
        if (mounted) {
          setPeerThreads(threads);
        }
      })
      .catch(() => {
        if (mounted) {
          setPeerThreads(conversation.peerThreads ?? []);
        }
      });
    return () => {
      mounted = false;
    };
  }, [activeAgent, conversation]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    setMessage(conversation?.draftMessage ?? '');
    setPendingFiles([]);
    window.requestAnimationFrame(() => {
      const container = messagesScrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, [conversation?.id]);

  useEffect(() => {
    if (!scheduledWakeup) {
      return undefined;
    }
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [scheduledWakeup?.id]);

  useEffect(() => {
    const container = messagesScrollRef.current;
    if (!container || !shouldStickToBottomRef.current) {
      return;
    }
    window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }, [visibleMessages.length, runIsActive, runErrorMessage, activeRunProgressCount, activeRunActivityCount, activeRun?.updatedAt, conversation?.updatedAt]);

  const resetCreateForm = () => {
    setName('');
    setDescription('');
    setPurpose('');
    setCreateAccessDraft(defaultAccessDraft());
  };

  const handleCreate = async () => {
    if (!name.trim() || busy) return;
    setBusyAction('create');
    setError(null);
    try {
      const agent = await window.forger.personalAgentsCreate({
        name,
        description,
        purpose,
        permissionMode: createAccessDraft.permissionMode,
        networkAccess: createAccessDraft.networkAccess,
        runtime: createAccessDraft.runtime,
        appIds: createAccessDraft.appIds,
        toolIds: createAccessDraft.toolIds,
        connectionGrants: createAccessDraft.connectionGrants,
        peerAgentGrants: createAccessDraft.peerAgentGrants,
      });
      resetCreateForm();
      setCreateOpen(false);
      await loadAgents();
      setActiveAgentId(agent.id);
      usageAnalytics.personalAgentCreated({ surface: 'agents', locale: t.locale });
    } catch (createError) {
      setError(personalAgentSaveErrorMessage(createError, t.agents.createError, t));
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenCreate = () => {
    resetCreateForm();
    setCreateOpen(true);
  };

  const handleSaveAccess = async () => {
    if (!activeAgent || busy || !settingsDraftReady) return;
    setBusyAction('access');
    setError(null);
    try {
      const updated = await window.forger.personalAgentUpdatePermissions({
        agentId: activeAgent.id,
        permissionMode: settingsAccessDraft.permissionMode,
        networkAccess: settingsAccessDraft.networkAccess,
        runtime: settingsAccessDraft.runtime,
        appIds: settingsAccessDraft.appIds,
        toolIds: settingsAccessDraft.toolIds,
        connectionGrants: settingsAccessDraft.connectionGrants,
        peerAgentGrants: settingsAccessDraft.peerAgentGrants,
      });
      setAgents((current) => current.map((agent) => agent.id === updated.id ? updated : agent));
    } catch (accessError) {
      setError(personalAgentSaveErrorMessage(accessError, t.agents.accessSaveError, t));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDelete = async (agent: PersonalAgent) => {
    if (busy || !window.confirm(t.agents.deleteConfirm(agent.name))) return;
    setBusyAction('delete');
    setError(null);
    try {
      await window.forger.personalAgentsDelete({ agentId: agent.id });
      if (activeAgentId === agent.id) {
        setActiveAgentId(null);
      }
      await loadAgents();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t.agents.deleteError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenFile = async (entry: PersonalAgentWorkspaceEntry) => {
    if (!activeAgent || entry.kind !== 'file') return;
    setBusyAction('file');
    setError(null);
    try {
      const file = await window.forger.personalAgentWorkspaceFileRead({
        agentId: activeAgent.id,
        relativePath: entry.relativePath,
      });
      setOpenFile(file);
      setFileDraft(file.content);
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : t.agents.fileOpenError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveFile = async () => {
    if (!activeAgent || !openFile || !fileDirty || busy) return;
    setBusyAction('file');
    setError(null);
    try {
      const saved = await window.forger.personalAgentWorkspaceFileWrite({
        agentId: activeAgent.id,
        relativePath: openFile.relativePath,
        content: fileDraft,
      });
      setOpenFile(saved);
      setFileDraft(saved.content);
      await loadAgentDetail(activeAgent.id, conversation?.id);
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : t.agents.fileSaveError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleStartConversation = async () => {
    if (!activeAgent || busy) return;
    setBusyAction('start');
    setError(null);
    try {
      const started = await window.forger.personalAgentStartConversation({
        agentId: activeAgent.id,
        title: activeAgent.name,
      });
      setConversation(started);
      setConversations((current) => upsertConversation(current, started));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : t.agents.startError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleWakeAgent = async () => {
    if (!activeAgent || !isBlankAgent || busy) return;
    setBusyAction('wake');
    setError(null);
    try {
      const started = await window.forger.personalAgentStartConversation({
        agentId: activeAgent.id,
        title: activeAgent.name,
        initialMessage: t.agents.wakeAgentMessage,
      });
      setConversation(started);
      setConversations((current) => upsertConversation(current, started));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : t.agents.startError);
    } finally {
      setBusyAction(null);
    }
  };

  const handlePickFiles = async () => {
    if (busy) return;
    const picked = await window.forger.filesPickForChat();
    setPendingFiles((current) => {
      const seen = new Set(current.map((file) => file.sourcePath));
      return [...current, ...picked.filter((file) => !seen.has(file.sourcePath))];
    });
  };

  const handleRemovePendingFile = (sourcePath: string) => {
    setPendingFiles((current) => current.filter((file) => file.sourcePath !== sourcePath));
  };

  const handleComposerChange = (value: string) => {
    setMessage(value);
    if (conversation?.id && wakeupIsActive) {
      void window.forger.personalAgentConversationDraftUpdate({
        conversationId: conversation.id,
        draftMessage: value,
      }).catch(() => undefined);
    }
  };

  const handleCancelWakeup = async () => {
    if (!conversation || !wakeupIsActive || busy) return;
    setBusyAction('cancelWakeup');
    setError(null);
    try {
      await window.forger.personalAgentWakeupCancel({ conversationId: conversation.id });
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : t.agents.wakeupCancelError);
    } finally {
      setBusyAction(null);
    }
  };

  const resetRoutineForm = () => {
    setEditingRoutine(null);
    setRoutineName('');
    setRoutinePrompt('');
    setRoutineFrequencyType('hourly');
    setRoutineTimeOfDay('09:00');
    setRoutineWeeklyDay(1);
    setRoutineIntervalMinutes(String(DEFAULT_INTERVAL_MINUTES));
    setRoutineMissedRunPolicy('within_window');
    setRoutineMissedRunWindowMinutes('30');
    setRoutineEnabled(true);
    setRoutineAuthorizationText('');
  };

  const handleOpenRoutineCreate = () => {
    resetRoutineForm();
    setRoutineDialogOpen(true);
  };

  const handleOpenRoutineEdit = (routine: PersonalAgentRoutine) => {
    setEditingRoutine(routine);
    setRoutineName(routine.name);
    setRoutinePrompt(routine.prompt);
    setRoutineFrequencyType(routine.frequency.type);
    setRoutineTimeOfDay('timeOfDay' in routine.frequency ? routine.frequency.timeOfDay ?? '09:00' : '09:00');
    setRoutineWeeklyDay('weeklyDay' in routine.frequency ? routine.frequency.weeklyDay ?? 1 : 1);
    setRoutineIntervalMinutes(String(routine.frequency.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES));
    setRoutineMissedRunPolicy(routine.missedRunPolicy);
    setRoutineMissedRunWindowMinutes(String(routine.missedRunWindowMinutes ?? defaultRoutineMissedRunWindowMinutes(routine.frequency.type)));
    setRoutineEnabled(routine.enabled);
    setRoutineAuthorizationText('');
    setRoutineDialogOpen(true);
  };

  const routineFrequencyFromForm = (): AutomationFrequency => {
    if (routineFrequencyType === 'interval') {
      return { type: 'interval', intervalMinutes: clampRoutineIntervalMinutes(routineIntervalMinutes) };
    }
    if (routineFrequencyType === 'daily') {
      return { type: 'daily', timeOfDay: normalizeTimeOfDay(routineTimeOfDay) };
    }
    if (routineFrequencyType === 'weekly') {
      return {
        type: 'weekly',
        timeOfDay: normalizeTimeOfDay(routineTimeOfDay),
        weeklyDay: Math.min(6, Math.max(0, Math.floor(Number(routineWeeklyDay)))),
      };
    }
    return { type: 'hourly' };
  };

  const handleSaveRoutine = async () => {
    if (!activeAgent || busy || !routineName.trim() || !routinePrompt.trim() || !routineAuthorizationText.trim()) return;
    setBusyAction('routine');
    setError(null);
    try {
      const frequency = routineFrequencyFromForm();
      const isInterval = frequency.type === 'interval';
      const input = {
        name: routineName,
        prompt: routinePrompt,
        frequency,
        missedRunPolicy: isInterval ? ('within_window' as AutomationMissedRunPolicy) : routineMissedRunPolicy,
        missedRunWindowMinutes: isInterval ? undefined : (Number(routineMissedRunWindowMinutes) || undefined),
        enabled: routineEnabled,
        authorizationText: routineAuthorizationText,
      };
      const saved = editingRoutine
        ? await window.forger.personalAgentRoutinesUpdate({ ...input, routineId: editingRoutine.id })
        : await window.forger.personalAgentRoutinesCreate({ ...input, agentId: activeAgent.id });
      setRoutines((current) => {
        const without = current.filter((item) => item.id !== saved.id);
        return [saved, ...without].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      });
      setRoutineDialogOpen(false);
      resetRoutineForm();
      await loadAgentDetail(activeAgent.id, conversation?.id);
    } catch (routineError) {
      setError(routineError instanceof Error ? routineError.message : t.agents.routines.saveError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleRoutine = async (routine: PersonalAgentRoutine) => {
    if (busy) return;
    const authorizationText = window.prompt(t.agents.routines.changeAuthPrompt);
    if (!authorizationText?.trim()) return;
    setBusyAction('routine');
    setError(null);
    try {
      const updated = await window.forger.personalAgentRoutinesSetEnabled({
        routineId: routine.id,
        enabled: !routine.enabled,
        authorizationText,
      });
      setRoutines((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (routineError) {
      setError(routineError instanceof Error ? routineError.message : t.agents.routines.updateError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteRoutine = async (routine: PersonalAgentRoutine) => {
    if (busy || !window.confirm(t.agents.routines.deleteConfirm)) return;
    const authorizationText = window.prompt(t.agents.routines.deleteAuthPrompt);
    if (!authorizationText?.trim()) return;
    setBusyAction('routine');
    setError(null);
    try {
      await window.forger.personalAgentRoutinesDelete({ routineId: routine.id, authorizationText });
      setRoutines((current) => current.filter((item) => item.id !== routine.id));
      if (activeAgent) {
        await loadAgentDetail(activeAgent.id, conversation?.id);
      }
    } catch (routineError) {
      setError(routineError instanceof Error ? routineError.message : t.agents.routines.deleteError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenRoutineThread = async (routine: PersonalAgentRoutine) => {
    const local = conversations.find((item) => item.id === routine.conversationId);
    if (local) {
      setConversation(local);
      setDetailTab('chat');
      return;
    }
    try {
      const loaded = await window.forger.personalAgentGetConversation({ conversationId: routine.conversationId });
      if (loaded) {
        setConversation(loaded);
        setConversations((current) => upsertConversation(current, loaded));
        setDetailTab('chat');
      }
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : t.agents.routines.openThreadError);
    }
  };

  const handleOpenPeerThread = async (threadId: string) => {
    try {
      const thread = await window.forger.personalAgentPeerThreadGet({ threadId });
      setOpenPeerThread(thread);
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : t.agents.openThreadError);
    }
  };

  const handleSendMessage = async () => {
    if (!activeAgent || !conversation || conversationReadOnly || (!message.trim() && pendingFiles.length === 0) || busy || runIsActive || wakeupIsActive) return;
    setBusyAction('send');
    setError(null);
    try {
      const importedFiles = pendingFiles.length > 0
        ? await window.forger.filesImport({ sourcePaths: pendingFiles.map((file) => file.sourcePath) })
        : [];
      const sharedFiles: SharedFileRef[] = importedFiles.map((file) => ({
        id: file.id,
        path: file.relativePath,
        name: file.name,
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        source: 'attached',
      }));
      const content = message.trim() || t.agents.defaultSharedFilesMessage;
      const updated = await window.forger.personalAgentSendMessage({
        conversationId: conversation.id,
        content,
        sharedFiles,
      });
      setConversation(updated);
      setConversations((current) => upsertConversation(current, updated));
      setMessage('');
      setPendingFiles([]);
      usageAnalytics.personalAgentMessageSent({ surface: 'agents', locale: t.locale });
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : t.agents.sendError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleMessagesScroll = () => {
    const container = messagesScrollRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 96;
  };

  const renderAccessChips = (agent: PersonalAgent) => (
    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
      <Chip size="small" label={`${providerOptions.find((option) => option.value === (agent.runtime?.provider ?? 'codex'))?.label ?? agent.runtime?.provider ?? 'Codex'} · ${agent.runtime?.model ?? CODEX_MODEL_OPTIONS[0]?.displayModelName ?? 'gpt-5.2'}`} />
      <Chip size="small" label={agent.permissionMode === 'unsafe' ? t.agents.expandedPermission : t.agents.standardPermission} />
      <Chip size="small" label={agent.networkAccess ? t.agents.internetOn : t.agents.internetOff} />
      <Chip size="small" label={agent.appIds.length > 0 ? t.agents.appsCount(agent.appIds.length) : t.agents.noAppsAccess} />
      <Chip size="small" label={agent.toolIds.length > 0 ? t.agents.toolsCount(agent.toolIds.length) : t.agents.noToolsAccess} />
      <Chip size="small" label={agent.connectionGrants.length > 0 ? t.agents.connectionsCount(agent.connectionGrants.length) : t.agents.noConnectionsAccess} />
    </Stack>
  );

  const renderAccessControls = (draft: AccessDraft, setDraft: typeof setCreateAccessDraft) => (
    <AgentAccessControls
      activeAgentId={activeAgent?.id}
      draft={draft}
      grantOptions={grantOptions}
      providerOptions={providerOptions}
      setDraft={setDraft}
      t={t}
    />
  );

  const renderMainList = () => (
    <Stack spacing={2.25} sx={{ height: '100%', minHeight: 0 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h4">{t.agents.title}</Typography>
          <Typography color="text.secondary">{t.agents.subtitle}</Typography>
        </Box>
        <Button startIcon={<AddRounded />} variant="contained" onClick={handleOpenCreate}>
          {t.agents.create}
        </Button>
      </Stack>

      {error ? <Alert severity="error">{error}</Alert> : null}

      {agents.length === 0 ? (
        <Box
          sx={{
            border: `1px dashed ${theme.palette.divider}`,
            borderRadius: 1,
            p: 4,
            textAlign: 'center',
          }}
        >
          <Typography color="text.secondary">{t.agents.empty}</Typography>
        </Box>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              md: 'repeat(2, minmax(0, 1fr))',
              xl: 'repeat(3, minmax(0, 1fr))',
            },
            gap: 1.5,
          }}
        >
          {agents.map((agent) => (
            <Card key={agent.id} variant="outlined" sx={{ borderRadius: 1 }}>
              <CardActionArea onClick={() => setActiveAgentId(agent.id)} sx={{ alignItems: 'stretch' }}>
                <CardContent sx={{ p: 1.75, '&:last-child': { pb: 1.75 } }}>
                  <Stack spacing={1.25}>
                    <Stack direction="row" spacing={1} alignItems="flex-start">
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="subtitle1" fontWeight={700}>{agent.name}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {agent.description || t.agents.noDescription}
                        </Typography>
                      </Box>
                      <Tooltip title={t.agents.delete}>
                        <IconButton
                          size="small"
                          disabled={busy}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleDelete(agent);
                          }}
                        >
                          <DeleteOutlineRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    {renderAccessChips(agent)}
                  </Stack>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Box>
      )}
    </Stack>
  );

  const renderFilePanel = () => {
    if (!openFile) return null;

    return (
      <Box
        sx={{
          bgcolor: 'background.paper',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 1,
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          minHeight: 0,
          overflow: 'hidden',
          position: 'relative',
          transition: 'width 180ms ease, opacity 180ms ease',
          width: { xs: '100%', lg: 440 },
          zIndex: 1,
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{
            borderBottom: `1px solid ${theme.palette.divider}`,
            minHeight: 54,
            pl: 1.5,
            pr: 1,
          }}
        >
          <DescriptionRounded color="action" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" noWrap>{openFile.relativePath}</Typography>
            <Typography variant="caption" color="text.secondary">
              {fileDirty ? t.agents.fileUnsaved : t.agents.fileSaved}
            </Typography>
          </Box>
          <Tooltip title={t.agents.saveFile}>
            <span>
              <IconButton size="small" disabled={!fileDirty || busy} onClick={() => void handleSaveFile()}>
                <SaveRounded fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t.agents.closeFile}>
            <IconButton
              size="small"
              onClick={() => {
                setOpenFile(null);
                setFileDraft('');
              }}
            >
              <CloseRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        <TextField
          value={fileDraft}
          onChange={(event) => setFileDraft(event.target.value)}
          multiline
          fullWidth
          variant="standard"
          slotProps={{
            input: {
              disableUnderline: true,
              sx: {
                alignItems: 'flex-start',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 13,
                height: '100%',
                lineHeight: 1.55,
                overflow: 'auto',
                p: 1.5,
              },
            },
          }}
          sx={{
            flex: 1,
            minHeight: 0,
            '& .MuiInputBase-root': {
              height: '100%',
            },
            '& textarea': {
              height: '100% !important',
              overflow: 'auto !important',
            },
          }}
        />
      </Box>
    );
  };

  const renderMessage = (item: PersonalAgentMessage, options: RenderPersonalAgentMessageOptions = {}) => {
    const isUser = item.role === 'user';
    const isIntermediate = item.kind === 'intermediate';
    const isScheduledUser = isUser && item.source !== 'human';
    const scheduledLabel = item.source === 'routine'
      ? t.agents.messageBadge.routine
      : item.source === 'scheduled_wakeup'
        ? t.agents.messageBadge.wakeup
        : item.source === 'sidekick'
          ? t.agents.messageBadge.sidekick
          : null;
    const messageRun = !isUser && !isIntermediate && item.runId && activeRun?.id === item.runId
      ? activeRun
      : undefined;
    const messageRunProgress = messageRun?.progress.map((entry) => ({
      id: entry.id,
      message: entry.message,
      createdAt: entry.createdAt,
    })) ?? [];
    const contextRunProgress = messageRun
      ? []
      : progressMessagesForMessageRun(item, options.contextMessages);
    const receiptProgressMessages = messageRun ? messageRunProgress : contextRunProgress;
    const authorLabel = item.authorType === 'agent' && item.authorAgentName
      ? item.authorAgentName
      : item.authorType === 'agent' && item.authorAgentId
        ? item.authorAgentId
        : null;
    return (
      <Stack
        key={item.id}
        direction="row"
        justifyContent={isUser ? 'flex-end' : 'flex-start'}
        sx={{ minWidth: 0, maxWidth: '100%', overflowX: 'hidden' }}
      >
        <Box
          sx={{
            width: isUser ? undefined : '78%',
            maxWidth: isUser ? '72%' : '78%',
            minWidth: 0,
            px: isUser ? 1.6 : 0,
            py: isUser ? 1.2 : 0,
            borderRadius: isUser ? 1 : 0,
            bgcolor: isScheduledUser ? 'action.selected' : isUser ? 'primary.main' : 'transparent',
            color: isUser
              ? isScheduledUser ? theme.palette.text.primary : theme.palette.primary.contrastText
              : isIntermediate
                ? theme.palette.text.secondary
                : theme.palette.text.primary,
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          }}
        >
          {authorLabel ? (
            <Typography variant="caption" sx={{ display: 'block', mb: 0.5, opacity: 0.78 }}>
              {authorLabel}
            </Typography>
          ) : null}
          {scheduledLabel ? (
            <Typography variant="caption" sx={{ display: 'block', mb: 0.5, opacity: 0.72 }}>
              {scheduledLabel}
            </Typography>
          ) : null}
          {messageRun?.activity || receiptProgressMessages.length > 0 ? (
            <Box sx={{ mb: item.content ? 1 : 0 }}>
              <AgentRunActivityReceipt
                t={t}
                activity={messageRun?.activity}
                completedAt={item.createdAt}
                mode="completed"
                progressMessages={receiptProgressMessages}
                excludeText={item.content}
              />
            </Box>
          ) : null}
          {isUser ? (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
              {item.content}
            </Typography>
          ) : isIntermediate ? (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
              {item.content}
            </Typography>
          ) : (
            <MarkdownMessage content={item.content} />
          )}
          {item.files?.length ? (
            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
              {item.files.map((file) => (
                <Chip
                  key={file.id}
                  size="small"
                  label={compactFileLabel(file.name)}
                  variant={isUser ? 'filled' : 'outlined'}
                  sx={{ maxWidth: 220 }}
                />
              ))}
            </Stack>
          ) : null}
        </Box>
      </Stack>
    );
  };

  const renderPeerThreadRows = (threads: PersonalAgentPeerThread[], depth = 0): ReactElement[] =>
    threads.flatMap((thread) => [
      <Box
        key={thread.id}
        role="button"
        tabIndex={0}
        onClick={() => void handleOpenPeerThread(thread.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void handleOpenPeerThread(thread.id);
          }
        }}
        sx={{
          cursor: 'pointer',
          borderRadius: 1,
          ml: depth * 1.25,
          px: 1,
          py: 0.85,
          '&:hover': { bgcolor: 'action.hover' },
        }}
      >
        <Typography variant="body2" fontWeight={700} noWrap>
          {thread.callerAgentName ?? thread.callerAgentId}{' -> '}{thread.targetAgentName ?? thread.targetAgentId}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>{thread.title}</Typography>
      </Box>,
      ...(thread.children?.length ? renderPeerThreadRows(thread.children, depth + 1) : []),
    ]);

  const renderPeerPanel = () => (
    <Paper
      variant="outlined"
      sx={{
        display: { xs: 'none', lg: 'flex' },
        flexDirection: 'column',
        width: 300,
        minHeight: 0,
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.25, py: 1, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <ChatRounded color="action" fontSize="small" />
        <Typography variant="subtitle2" noWrap>{t.agents.peerThreadsTitle}</Typography>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 0.75 }}>
        {peerThreads.length > 0 ? renderPeerThreadRows(peerThreads) : (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            {t.agents.peerThreadsEmpty}
          </Typography>
        )}
      </Box>
    </Paper>
  );

  const renderComposer = () => {
    if (conversationReadOnly) {
      return (
        <Box sx={{ p: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
          <Typography variant="body2" color="text.secondary">
            {conversation?.origin === 'sidekick' ? t.agents.sidekickReadOnlyThread : t.agents.readOnlyThread}
          </Typography>
        </Box>
      );
    }
    return (
      <Paper variant="outlined" sx={{ m: 1.5, mt: 0, p: 1, borderRadius: 1 }}>
        {scheduledWakeup ? (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            alignItems={{ xs: 'stretch', sm: 'center' }}
            sx={{
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 1,
              mb: 1,
              px: 1,
              py: 0.75,
              bgcolor: 'action.hover',
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" fontWeight={700}>
                {t.agents.wakeupWaiting(formatCountdown(wakeupCountdownMs))}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {scheduledWakeup.prompt}
              </Typography>
            </Box>
            <Button
              size="small"
              color="inherit"
              startIcon={<CloseRounded />}
              disabled={busyAction === 'cancelWakeup'}
              onClick={() => void handleCancelWakeup()}
            >
              {t.actions.cancel}
            </Button>
          </Stack>
        ) : null}
        {pendingFiles.length > 0 ? (
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
            {pendingFiles.map((file) => (
              <Chip
                key={file.sourcePath}
                size="small"
                label={compactFileLabel(file.name)}
                onDelete={() => handleRemovePendingFile(file.sourcePath)}
              />
            ))}
          </Stack>
        ) : null}
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
          variant="standard"
          value={message}
          disabled={!conversation || Boolean(runIsActive)}
          placeholder={t.agents.messagePlaceholder}
          onChange={(event) => handleComposerChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSendMessage();
            }
          }}
          slotProps={{ input: { disableUnderline: true } }}
        />
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.75 }}>
          <Tooltip title={t.sections.chat.attachFiles}>
            <span>
              <IconButton size="small" disabled={busy || Boolean(runIsActive) || wakeupIsActive} onClick={() => void handlePickFiles()}>
                <AttachFileRounded fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={wakeupIsActive ? t.agents.wakeupWaitingShort : t.agents.send}>
            <span>
              <IconButton
                color="primary"
                disabled={!conversation || (!message.trim() && pendingFiles.length === 0) || busy || Boolean(runIsActive) || wakeupIsActive}
                onClick={() => void handleSendMessage()}
              >
                <SendRounded />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Paper>
    );
  };

  const renderDetail = () => {
    if (!activeAgent) return renderMainList();

    return (
      <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0 }}>
        <AgentConversationHistoryDrawer
          t={t}
          open={historyOpen}
          groups={historyGroups}
          selectedConversationId={conversation?.id}
          collapsedGroups={collapsedHistoryGroups}
          groupLimits={historyGroupLimits}
          reserveTrafficLightSpace={shouldReserveMacTrafficLightSpace}
          onClose={() => setHistoryOpen(false)}
          onSelectConversation={(item) => {
            setConversation(item);
            setHistoryOpen(false);
            setDetailTab('chat');
          }}
          onToggleGroup={(groupId) => {
            setCollapsedHistoryGroups((current) => ({
              ...current,
              [groupId]: current[groupId] !== true,
            }));
          }}
          onShowMore={(groupId, nextLimit) => {
            setHistoryGroupLimits((current) => ({
              ...current,
              [groupId]: nextLimit,
            }));
          }}
        />
        <Stack direction="row" spacing={1.25} alignItems="center">
          <Tooltip title={t.actions.back}>
            <IconButton onClick={() => setActiveAgentId(null)}>
              <ArrowBackRounded />
            </IconButton>
          </Tooltip>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h5">{activeAgent.name}</Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {activeAgent.purpose || activeAgent.description || t.agents.noDescription}
            </Typography>
          </Box>
          <Tooltip title={t.agents.historyTab}>
            <IconButton onClick={() => setHistoryOpen(true)}>
              <HistoryRounded />
            </IconButton>
          </Tooltip>
          <Tooltip title={t.agents.editAccess}>
            <IconButton onClick={() => setDetailTab('settings')}>
              <SettingsRounded />
            </IconButton>
          </Tooltip>
        </Stack>

        <Tabs value={detailTab} onChange={(_event, value: AgentDetailTab) => setDetailTab(value)}>
          <Tab value="chat" label={t.agents.chatTitle} />
          <Tab value="workspace" label={t.agents.workspaceTab} />
          <Tab value="routines" label={t.agents.routines.tab} />
          <Tab value="settings" label={t.agents.settingsTab} />
        </Tabs>

        {error ? <Alert severity="error">{error}</Alert> : null}

        <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {detailTab === 'workspace' ? (
            <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} sx={{ height: '100%', minHeight: 0 }}>
              <Paper variant="outlined" sx={{ flex: 1, minHeight: 0, overflow: 'auto', borderRadius: 1 }}>
                <WorkspaceTree
                  entries={workspaceEntries}
                  emptyLabel={t.agents.workspaceEmpty}
                  selectedPath={openFile?.relativePath}
                  onOpenFile={(entry) => void handleOpenFile(entry)}
                />
              </Paper>
              {renderFilePanel()}
            </Stack>
          ) : detailTab === 'routines' ? (
            <AgentRoutinesPanel
              t={t}
              routines={routines}
              busy={busy}
              onCreate={handleOpenRoutineCreate}
              onOpenThread={(routine) => void handleOpenRoutineThread(routine)}
              onToggle={(routine) => void handleToggleRoutine(routine)}
              onEdit={handleOpenRoutineEdit}
              onDelete={(routine) => void handleDeleteRoutine(routine)}
            />
          ) : detailTab === 'settings' ? (
            <Paper variant="outlined" sx={{ height: '100%', minHeight: 0, overflow: 'auto', p: 2, borderRadius: 1 }}>
              <Stack spacing={2}>
                {renderAccessControls(settingsAccessDraft, setSettingsAccessDraft)}
                <Box>
                  <Button
                    startIcon={<SaveRounded />}
                    variant="contained"
                    disabled={busyAction === 'access' || !settingsDraftReady}
                    onClick={() => void handleSaveAccess()}
                  >
                    {t.agents.saveAccess}
                  </Button>
                </Box>
              </Stack>
            </Paper>
          ) : (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', lg: peerThreads.length ? 'minmax(0, 1fr) 300px' : '1fr' },
                gap: 1.5,
                height: '100%',
                minHeight: 0,
              }}
            >
          <Stack
            sx={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 1,
              overflow: 'hidden',
            }}
          >
            <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.5, py: 1.25, borderBottom: `1px solid ${theme.palette.divider}` }}>
              <Tooltip title={t.agents.historyTab}>
                <IconButton size="small" onClick={() => setHistoryOpen(true)}>
                  <HistoryRounded fontSize="small" />
                </IconButton>
              </Tooltip>
              <ChatRounded color="action" />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="subtitle2" noWrap>{conversation?.title ?? t.agents.chatTitle}</Typography>
              </Box>
              {runIsActive || busyAction === 'wake' || busyAction === 'start' || busyAction === 'send' ? <CircularProgress size={18} /> : null}
              {conversation && activeAgent && onNotifyForger ? (
                <Tooltip title={t.sections.chat.notifyForgerTooltip}>
                  <span>
                    <IconButton
                      size="small"
                      aria-label={t.sections.chat.notifyForger}
                      onClick={() => onNotifyForger({ agent: activeAgent, conversation, run: activeRun ?? conversation.activeRun })}
                      sx={{
                        width: 32,
                        height: 32,
                        border: `1px solid ${theme.palette.divider}`,
                        borderRadius: 1,
                        flexShrink: 0,
                      }}
                    >
                      <BugReportRounded fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              ) : null}
              {!isBlankAgent && !wakeFlowInProgress && busyAction !== 'wake' ? (
                <Tooltip title={!intelligenceProviderConfigured ? t.agents.llmRequired : ''}>
                  <span>
                    <Button
                      startIcon={<AddRounded />}
                      variant="outlined"
                      size="small"
                      disabled={busy || !intelligenceProviderConfigured}
                      onClick={() => void handleStartConversation()}
                      sx={{ flexShrink: 0 }}
                    >
                      {t.agents.newConversation}
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
            </Stack>

            <Box ref={messagesScrollRef} onScroll={handleMessagesScroll} sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {isBlankAgent ? (
                <Stack spacing={1.5} alignItems="center" justifyContent="center" sx={{ minHeight: '100%', p: 4, textAlign: 'center' }}>
                  <Typography variant="h6">{t.agents.blankTitle}</Typography>
                  <Typography color="text.secondary">{t.agents.blankSubtitle}</Typography>
                  {intelligenceProviderConfigured ? (
                    <Button
                      startIcon={<PlayArrowRounded />}
                      variant="contained"
                      disabled={busy}
                      onClick={() => void handleWakeAgent()}
                    >
                      {t.agents.wakeAgent}
                    </Button>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {t.agents.llmRequired}
                    </Typography>
                  )}
                </Stack>
              ) : visibleMessages.length ? (
                <Stack spacing={2} sx={{ p: 1.5, minWidth: 0 }}>
                  {visibleMessages.map((item) => renderMessage(item, { contextMessages: conversation?.messages ?? [] }))}
                  {runIsActive ? (
                    <Box sx={{ width: '78%', maxWidth: '78%', minWidth: 0 }}>
                      <AgentRunActivityReceipt
                        t={t}
                        activity={activeRun?.activity}
                        mode="live"
                        progressMessages={activeRun?.progress.map((entry) => ({
                          id: entry.id,
                          message: entry.message,
                          createdAt: entry.createdAt,
                        })) ?? []}
                        emptyLabel={t.agents.firstRunLoading}
                      />
                    </Box>
                  ) : runErrorMessage ? (
                    <Typography variant="body2" color="error" sx={{ width: '78%', maxWidth: '78%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                      {runErrorMessage}
                    </Typography>
                  ) : null}
                </Stack>
              ) : (
                <Box sx={{ p: runIsActive ? 1.5 : 4, textAlign: runIsActive ? 'left' : 'center', minHeight: '100%', display: 'grid', placeItems: runIsActive ? 'start stretch' : 'center' }}>
                  {runIsActive ? (
                    <Box sx={{ width: '78%', maxWidth: '78%', minWidth: 0 }}>
                      <AgentRunActivityReceipt
                        t={t}
                        activity={activeRun?.activity}
                        mode="live"
                        progressMessages={activeRun?.progress.map((entry) => ({
                          id: entry.id,
                          message: entry.message,
                          createdAt: entry.createdAt,
                        })) ?? []}
                        emptyLabel={t.agents.firstRunLoading}
                      />
                    </Box>
                  ) : (
                    <Stack spacing={1} alignItems="center">
                      {(busyAction === 'wake' || busyAction === 'start') ? <CircularProgress size={22} /> : null}
                      <Typography color="text.secondary">
                        {(busyAction === 'wake' || busyAction === 'start') ? t.agents.firstRunLoading : t.agents.noMessages}
                      </Typography>
                    </Stack>
                  )}
                </Box>
              )}
            </Box>

            {renderComposer()}
          </Stack>
          {peerThreads.length ? renderPeerPanel() : null}
            </Box>
          )}
        </Box>
      </Stack>
    );
  };

  const openPeerThreadMessages = openPeerThread?.messages ?? [];
  const openPeerThreadVisibleMessages = visiblePeerThreadMessages(openPeerThreadMessages);

  return (
    <>
      {activeAgentId ? renderDetail() : renderMainList()}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t.agents.createTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <TextField
              size="small"
              label={t.agents.name}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <TextField
              size="small"
              label={t.agents.description}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <TextField
              size="small"
              multiline
              minRows={4}
              label={t.agents.purpose}
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
            />
            <Divider />
            {renderAccessControls(createAccessDraft, setCreateAccessDraft)}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>{t.actions.close}</Button>
          <Button
            startIcon={<AddRounded />}
            variant="contained"
            disabled={!name.trim() || busy}
            onClick={() => void handleCreate()}
          >
            {t.agents.create}
          </Button>
        </DialogActions>
      </Dialog>

      <AgentRoutineDialog
        t={t}
        open={routineDialogOpen}
        editingRoutine={editingRoutine}
        busy={busy}
        name={routineName}
        prompt={routinePrompt}
        frequencyType={routineFrequencyType}
        timeOfDay={routineTimeOfDay}
        weeklyDay={routineWeeklyDay}
        intervalMinutes={routineIntervalMinutes}
        missedRunPolicy={routineMissedRunPolicy}
        missedRunWindowMinutes={routineMissedRunWindowMinutes}
        enabled={routineEnabled}
        authorizationText={routineAuthorizationText}
        onClose={() => setRoutineDialogOpen(false)}
        onSave={() => void handleSaveRoutine()}
        onNameChange={setRoutineName}
        onPromptChange={setRoutinePrompt}
        onFrequencyTypeChange={setRoutineFrequencyType}
        onTimeOfDayChange={setRoutineTimeOfDay}
        onWeeklyDayChange={setRoutineWeeklyDay}
        onIntervalMinutesChange={setRoutineIntervalMinutes}
        onMissedRunPolicyChange={setRoutineMissedRunPolicy}
        onMissedRunWindowMinutesChange={setRoutineMissedRunWindowMinutes}
        onEnabledChange={setRoutineEnabled}
        onAuthorizationTextChange={setRoutineAuthorizationText}
      />

      <Dialog open={Boolean(openPeerThread)} onClose={() => setOpenPeerThread(null)} fullWidth maxWidth="md">
        <DialogTitle>
          {openPeerThread
            ? `${openPeerThread.callerAgentName ?? openPeerThread.callerAgentId} -> ${openPeerThread.targetAgentName ?? openPeerThread.targetAgentId}`
            : ''}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            {openPeerThreadVisibleMessages.length > 0 ? openPeerThreadVisibleMessages.map((item) => renderMessage(item, { contextMessages: openPeerThreadMessages })) : (
              <Typography variant="body2" color="text.secondary">
                {t.agents.peerThreadEmpty}
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenPeerThread(null)}>{t.actions.close}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const formatCountdown = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};
