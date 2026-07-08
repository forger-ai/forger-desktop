import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import AddRounded from '@mui/icons-material/AddRounded';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import AttachFileRounded from '@mui/icons-material/AttachFileRounded';
import ChatRounded from '@mui/icons-material/ChatRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DescriptionRounded from '@mui/icons-material/DescriptionRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import {
  Alert,
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  InputLabel,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import type { AgentEffort, AgentProvider, AgentRuntime, AgentToolId, PersonalAgent, PersonalAgentConnectionGrant, PersonalAgentConversation, PersonalAgentConversationEvent, PersonalAgentGrantOptionConnection, PersonalAgentGrantOptionTool, PersonalAgentGrantOptions, PersonalAgentMessage, PersonalAgentPeerThread, PersonalAgentWorkspaceEntry, PersonalAgentWorkspaceFile, PickedChatFile, SharedFileRef, WindowControlState } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { AGENT_PROVIDER_OPTIONS, ANTIGRAVITY_EFFORT_OPTIONS, ANTIGRAVITY_MODEL_OPTIONS, CLAUDE_EFFORT_OPTIONS, CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS, CODEX_REASONING_OPTIONS } from '@renderer/preferences';
import { usageAnalytics } from '@renderer/usage-analytics';
import { getRuntimeSupportedEfforts, normalizeRuntimeEffortForModel } from '@shared/agent-runtime-registry';
import { AgentRunActivityReceipt } from '@renderer/components/AgentRunActivityReceipt';
import { MarkdownMessage } from './chat/MarkdownMessage';
import {
  isMacOsPlatform,
  sortItemsByRecentActivity,
} from './chat/history-drawer-helpers';
import { AgentConversationHistoryDrawer } from './AgentConversationHistoryDrawer';
import {
  type AccessDraft,
  type AgentConversationHistoryGroup,
  type RenderPersonalAgentMessageOptions,
  compactFileLabel,
  connectionInstanceLabel,
  defaultAccessDraft,
  defaultRuntimeForProvider,
  isTerminalRunStatus,
  personalAgentRunErrorMessage,
  personalAgentSaveErrorMessage,
  progressMessagesForMessageRun,
  toggleId,
  upsertConversation,
  visiblePeerThreadMessages,
  WorkspaceTree,
} from './AgentsView.helpers';

interface AgentsViewProps {
  t: AppDictionary;
  intelligenceProviderConfigured: boolean;
  providerOptions?: Array<{ label: string; value: AgentProvider | 'auto' }>;
}

export function AgentsView({ t, intelligenceProviderConfigured, providerOptions = AGENT_PROVIDER_OPTIONS }: AgentsViewProps) {
  const theme = useTheme();
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<PersonalAgentConversation[]>([]);
  const [conversation, setConversation] = useState<PersonalAgentConversation | null>(null);
  const [workspaceEntries, setWorkspaceEntries] = useState<PersonalAgentWorkspaceEntry[]>([]);
  const [grantOptions, setGrantOptions] = useState<PersonalAgentGrantOptions>({ apps: [], tools: [], connections: [], peerAgents: [] });
  const [openFile, setOpenFile] = useState<PersonalAgentWorkspaceFile | null>(null);
  const [fileDraft, setFileDraft] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [purpose, setPurpose] = useState('');
  const [accessDraft, setAccessDraft] = useState<AccessDraft>(() => defaultAccessDraft());
  const [message, setMessage] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PickedChatFile[]>([]);
  const [detailTab, setDetailTab] = useState<'chat' | 'workspace' | 'settings'>('chat');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [windowState, setWindowState] = useState<WindowControlState | null>(null);
  const [collapsedHistoryGroups, setCollapsedHistoryGroups] = useState<Record<string, boolean>>({});
  const [historyGroupLimits, setHistoryGroupLimits] = useState<Record<string, number>>({});
  const [peerThreads, setPeerThreads] = useState<PersonalAgentPeerThread[]>([]);
  const [openPeerThread, setOpenPeerThread] = useState<PersonalAgentPeerThread | null>(null);
  const [busyAction, setBusyAction] = useState<'create' | 'delete' | 'file' | 'wake' | 'start' | 'send' | 'access' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? null,
    [agents, activeAgentId],
  );

  const isBlankAgent = Boolean(activeAgent && conversations.length === 0 && !conversation);
  const fileDirty = Boolean(openFile && fileDraft !== openFile.content);
  const activeRun = conversation?.activeRun;
  const runIsActive = Boolean(activeRun && !isTerminalRunStatus(activeRun.status));
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
  const activeRunProgressCount = activeRun?.progress.length ?? 0;
  const activeRunActivityCount = activeRun?.activity?.items.length ?? 0;
  const busy = busyAction !== null;
  const conversationReadOnly = Boolean(conversation && (conversation.readOnly || conversation.origin === 'agent'));
  const shouldReserveMacTrafficLightSpace = isMacOsPlatform() && !windowState?.isFullScreen;
  const historyGroups = useMemo<AgentConversationHistoryGroup[]>(() => {
    const userStarted = sortItemsByRecentActivity(conversations.filter((item) => item.origin !== 'agent'));
    const agentStarted = sortItemsByRecentActivity(conversations.filter((item) => item.origin === 'agent'));
    return [
      userStarted.length > 0
        ? { id: 'user-started', label: t.locale === 'es' ? 'Iniciadas por el usuario' : 'Started by user', items: userStarted }
        : null,
      agentStarted.length > 0
        ? { id: 'agent-started', label: t.locale === 'es' ? 'Iniciadas por agentes' : 'Started by agents', items: agentStarted }
        : null,
    ].filter((group): group is AgentConversationHistoryGroup => Boolean(group));
  }, [conversations, t.locale]);

  const loadAgents = useCallback(async () => {
    const nextAgents = await window.forger.personalAgentsList();
    setAgents(nextAgents);
    setActiveAgentId((current) => {
      if (!current) return null;
      return nextAgents.some((agent) => agent.id === current) ? current : null;
    });
  }, []);

  const loadAgentDetail = useCallback(async (agentId: string, preferredConversationId?: string) => {
    const [nextConversations, nextWorkspaceEntries] = await Promise.all([
      window.forger.personalAgentConversationsList({ agentId }).catch(() => []),
      window.forger.personalAgentWorkspaceList({ agentId }).catch(() => []),
    ]);
    setConversations(nextConversations);
    setWorkspaceEntries(nextWorkspaceEntries);
    setConversation(
      nextConversations.find((item) => item.id === preferredConversationId) ??
      nextConversations[0] ??
      null,
    );
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      window.forger.personalAgentsList(),
      window.forger.personalAgentGrantOptionsList().catch(() => ({ apps: [], tools: [], connections: [], peerAgents: [] })),
    ])
      .then(([nextAgents, nextGrantOptions]) => {
        if (!mounted) return;
        setAgents(nextAgents);
        setGrantOptions(nextGrantOptions);
      })
      .catch((loadError) => {
        if (mounted) {
          setError(loadError instanceof Error ? loadError.message : t.agents.loadError);
        }
      });
    return () => {
      mounted = false;
    };
  }, [t.agents.loadError]);

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
      if (activeAgentId && event.conversation.agentId !== activeAgentId) {
        return;
      }
      setConversations((current) => upsertConversation(current, event.conversation));
      setConversation((current) => {
        if (!current || current.id === event.conversation.id) {
          return event.conversation;
        }
        return current;
      });
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
    window.requestAnimationFrame(() => {
      const container = messagesScrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, [conversation?.id]);

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
    setAccessDraft(defaultAccessDraft());
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
        permissionMode: accessDraft.permissionMode,
        networkAccess: accessDraft.networkAccess,
        runtime: accessDraft.runtime,
        appIds: accessDraft.appIds,
        toolIds: accessDraft.toolIds,
        connectionGrants: accessDraft.connectionGrants,
        peerAgentGrants: accessDraft.peerAgentGrants,
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
    if (!activeAgent || busy) return;
    setBusyAction('access');
    setError(null);
    try {
      const updated = await window.forger.personalAgentUpdatePermissions({
        agentId: activeAgent.id,
        permissionMode: accessDraft.permissionMode,
        networkAccess: accessDraft.networkAccess,
        runtime: accessDraft.runtime,
        appIds: accessDraft.appIds,
        toolIds: accessDraft.toolIds,
        connectionGrants: accessDraft.connectionGrants,
        peerAgentGrants: accessDraft.peerAgentGrants,
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

  const handleOpenPeerThread = async (threadId: string) => {
    try {
      const thread = await window.forger.personalAgentPeerThreadGet({ threadId });
      setOpenPeerThread(thread);
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : (t.locale === 'es' ? 'No se pudo abrir el thread.' : 'Could not open the thread.'));
    }
  };

  const handleSendMessage = async () => {
    if (!activeAgent || !conversation || conversationReadOnly || (!message.trim() && pendingFiles.length === 0) || busy || runIsActive) return;
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
      const content = message.trim() || (t.locale === 'es' ? 'Revisa los archivos compartidos.' : 'Review the shared files.');
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

  const renderToolAccessControl = (tool: PersonalAgentGrantOptionTool) => {
    const actionIds = tool.actions.map((action) => action.id);
    const selectedCount = actionIds.filter((id) => accessDraft.toolIds.includes(id)).length;
    const allSelected = actionIds.length > 0 && selectedCount === actionIds.length;
    const partiallySelected = selectedCount > 0 && selectedCount < actionIds.length;
    const setToolChecked = (checked: boolean) => {
      setAccessDraft((current) => ({
        ...current,
        toolIds: checked
          ? [...new Set([...current.toolIds, ...actionIds])]
          : current.toolIds.filter((id) => !actionIds.includes(id)),
      }));
    };
    return (
      <Accordion key={tool.id} disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreRounded />}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
            <Checkbox
              size="small"
              checked={allSelected}
              indeterminate={partiallySelected}
              disabled={!tool.configured || actionIds.length === 0}
              onClick={(event) => event.stopPropagation()}
              onFocus={(event) => event.stopPropagation()}
              onChange={(event) => setToolChecked(event.target.checked)}
            />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" fontWeight={700} noWrap>{tool.name}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {tool.configured ? t.agents.toolActionsCount(selectedCount, actionIds.length) : t.agents.toolNeedsSetup}
              </Typography>
            </Box>
          </Stack>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          <FormGroup>
            {tool.actions.map((action) => (
              <FormControlLabel
                key={action.id}
                control={(
                  <Checkbox
                    checked={accessDraft.toolIds.includes(action.id)}
                    disabled={!tool.configured}
                    onChange={(event) => {
                      setAccessDraft((current) => ({
                        ...current,
                        toolIds: toggleId(current.toolIds, action.id, event.target.checked),
                      }));
                    }}
                  />
                )}
                label={action.name}
              />
            ))}
          </FormGroup>
        </AccordionDetails>
      </Accordion>
    );
  };

  const renderConnectionAccessControl = (connection: PersonalAgentGrantOptionConnection) => {
    const actionIds = connection.actions.map((action) => action.id as AgentToolId);
    const grant = accessDraft.connectionGrants.find((item) => item.type === connection.type);
    const selectedActionIds = grant?.actions ?? [];
    const selectedCount = actionIds.filter((id) => selectedActionIds.includes(id)).length;
    const allSelected = actionIds.length > 0 && selectedCount === actionIds.length;
    const partiallySelected = selectedCount > 0 && selectedCount < actionIds.length;
    const selectedConnectionIds = grant?.connectionIds ?? [];
    const upsertConnectionGrant = (nextGrant: PersonalAgentConnectionGrant | null) => {
      setAccessDraft((current) => ({
        ...current,
        connectionGrants: nextGrant
          ? [
              ...current.connectionGrants.filter((item) => item.type !== connection.type),
              nextGrant,
            ]
          : current.connectionGrants.filter((item) => item.type !== connection.type),
      }));
    };
    const buildGrant = (actions: string[], connectionIds = selectedConnectionIds): PersonalAgentConnectionGrant | null => {
      if (actions.length === 0) return null;
      return {
        type: connection.type,
        actions: [...new Set(actions)],
        multiple: connection.supportsMultiple && connectionIds.length !== 1,
        ...(connectionIds.length ? { connectionIds } : {}),
      };
    };
    const setConnectionChecked = (checked: boolean) => {
      upsertConnectionGrant(checked ? buildGrant(actionIds) : null);
    };
    const setActionChecked = (actionId: AgentToolId, checked: boolean) => {
      upsertConnectionGrant(buildGrant(toggleId(selectedActionIds as AgentToolId[], actionId, checked)));
    };
    const setConnectionIds = (ids: string[]) => {
      upsertConnectionGrant(buildGrant(selectedActionIds, ids));
    };
    return (
      <Accordion key={connection.type} disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreRounded />}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
            <Checkbox
              size="small"
              checked={allSelected}
              indeterminate={partiallySelected}
              disabled={!connection.configured || actionIds.length === 0}
              onClick={(event) => event.stopPropagation()}
              onFocus={(event) => event.stopPropagation()}
              onChange={(event) => setConnectionChecked(event.target.checked)}
            />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" fontWeight={700} noWrap>{connection.displayName}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {connection.configured ? t.agents.connectionActionsCount(selectedCount, actionIds.length) : t.agents.connectionNeedsSetup}
              </Typography>
            </Box>
          </Stack>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          <Stack spacing={1}>
            {connection.instances.length > 1 ? (
              <FormControl size="small" fullWidth disabled={!grant}>
                <InputLabel id={`agent-connection-instances-${connection.type}`}>{t.agents.connectionInstances}</InputLabel>
                <Select
                  labelId={`agent-connection-instances-${connection.type}`}
                  multiple
                  label={t.agents.connectionInstances}
                  value={selectedConnectionIds}
                  renderValue={(selected) => {
                    if ((selected as string[]).length === 0) return t.agents.connectionAllInstances;
                    return (selected as string[])
                      .map((id) => {
                        const instance = connection.instances.find((candidate) => candidate.id === id);
                        return instance ? connectionInstanceLabel(instance) : id;
                      })
                      .join(', ');
                  }}
                  onChange={(event) => {
                    const value = event.target.value;
                    setConnectionIds(typeof value === 'string' ? value.split(',') : value as string[]);
                  }}
                >
                  {connection.instances.map((instance) => (
                    <MenuItem key={instance.id} value={instance.id}>
                      {connectionInstanceLabel(instance)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : null}
            <FormGroup>
              {connection.actions.map((action) => (
                <FormControlLabel
                  key={action.id}
                  control={(
                    <Checkbox
                      checked={selectedActionIds.includes(action.id)}
                      disabled={!connection.configured}
                      onChange={(event) => setActionChecked(action.id as AgentToolId, event.target.checked)}
                    />
                  )}
                  label={action.name}
                />
              ))}
            </FormGroup>
          </Stack>
        </AccordionDetails>
      </Accordion>
    );
  };

  const renderAccessControls = () => {
    const runtimeProvider = accessDraft.runtime.provider;
    const runtimeModelOptions = runtimeProvider === 'claude'
      ? CLAUDE_MODEL_OPTIONS
      : runtimeProvider === 'antigravity'
        ? ANTIGRAVITY_MODEL_OPTIONS
        : CODEX_MODEL_OPTIONS;
    const runtimeEffortOptions = (runtimeProvider === 'claude'
      ? CLAUDE_EFFORT_OPTIONS
      : runtimeProvider === 'antigravity'
        ? ANTIGRAVITY_EFFORT_OPTIONS
        : CODEX_REASONING_OPTIONS
    ).filter((option) => getRuntimeSupportedEfforts(runtimeProvider, accessDraft.runtime.model).includes(option.value as AgentEffort));
    const runtimeModelValue = runtimeModelOptions.some((option) => option.realModelName === accessDraft.runtime.model)
      ? accessDraft.runtime.model
      : runtimeModelOptions[0]?.realModelName ?? accessDraft.runtime.model;
    const runtimeEffortValue = normalizeRuntimeEffortForModel(runtimeProvider, accessDraft.runtime.model, accessDraft.runtime.effort);
    return (
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel id="agent-runtime-provider-label">{t.agents.runtimeProvider}</InputLabel>
            <Select
              labelId="agent-runtime-provider-label"
              label={t.agents.runtimeProvider}
              value={runtimeProvider}
              onChange={(event) => {
                const provider = event.target.value as AgentProvider;
                setAccessDraft((current) => ({
                  ...current,
                  runtime: defaultRuntimeForProvider(provider),
                }));
              }}
            >
              {providerOptions.filter((option) => option.value !== 'auto').map((option) => (
                <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="agent-runtime-model-label">{t.agents.runtimeModel}</InputLabel>
            <Select
              labelId="agent-runtime-model-label"
              label={t.agents.runtimeModel}
              value={runtimeModelValue}
              onChange={(event) => {
                const model = event.target.value;
                setAccessDraft((current) => {
                  return {
                    ...current,
                    runtime: { ...current.runtime, model, effort: normalizeRuntimeEffortForModel(current.runtime.provider, model, current.runtime.effort) },
                  };
                });
              }}
            >
              {runtimeModelOptions.map((option) => (
                <MenuItem key={option.realModelName} value={option.realModelName}>{option.displayModelName}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel id="agent-runtime-effort-label">{t.agents.runtimeEffort}</InputLabel>
            <Select
              labelId="agent-runtime-effort-label"
              label={t.agents.runtimeEffort}
              value={runtimeEffortValue}
              onChange={(event) => {
                setAccessDraft((current) => ({
                  ...current,
                  runtime: { ...current.runtime, effort: event.target.value as AgentRuntime['effort'] },
                }));
              }}
            >
              {runtimeEffortOptions.map((option) => (
                <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="agent-permission-mode-label">{t.agents.permissionLevel}</InputLabel>
            <Select
              labelId="agent-permission-mode-label"
              label={t.agents.permissionLevel}
              value={accessDraft.permissionMode}
              onChange={(event) => {
                setAccessDraft((current) => ({
                  ...current,
                  permissionMode: event.target.value === 'unsafe' ? 'unsafe' : 'safe',
                }));
              }}
            >
              <MenuItem value="safe">{t.agents.standardPermission}</MenuItem>
              <MenuItem value="unsafe">{t.agents.expandedPermission}</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <FormControlLabel
          control={(
            <Switch
              checked={accessDraft.networkAccess}
              onChange={(event) => setAccessDraft((current) => ({ ...current, networkAccess: event.target.checked }))}
            />
          )}
          label={t.agents.internetAccess}
        />
        <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t.agents.appsAccess}</Typography>
        {grantOptions.apps.length > 0 ? (
          <FormGroup>
            {grantOptions.apps.map((app) => (
              <FormControlLabel
                key={app.appId}
                control={(
                  <Checkbox
                    checked={accessDraft.appIds.includes(app.appId)}
                    onChange={(event) => {
                      setAccessDraft((current) => ({
                        ...current,
                        appIds: toggleId(current.appIds, app.appId, event.target.checked),
                      }));
                    }}
                  />
                )}
                label={app.name}
              />
            ))}
          </FormGroup>
        ) : (
          <Typography variant="body2" color="text.secondary">{t.agents.noAppsAvailable}</Typography>
        )}
        </Box>
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t.agents.toolsAccess}</Typography>
          {grantOptions.tools.some((tool) => tool.actions.length > 0) ? (
            <Stack spacing={1}>
              {grantOptions.tools.map(renderToolAccessControl)}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">{t.agents.noToolsAvailable}</Typography>
          )}
        </Box>
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t.agents.connectionsAccess}</Typography>
          {grantOptions.connections.some((connection) => connection.actions.length > 0) ? (
            <Stack spacing={1}>
              {grantOptions.connections.map(renderConnectionAccessControl)}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">{t.agents.noConnectionsAvailable}</Typography>
          )}
        </Box>
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
            {t.locale === 'es' ? 'Agentes permitidos' : 'Allowed agents'}
          </Typography>
          {grantOptions.peerAgents.filter((peer) => peer.agentId !== activeAgent?.id).length > 0 ? (
            <Stack spacing={1}>
              {grantOptions.peerAgents.filter((peer) => peer.agentId !== activeAgent?.id).map((peer) => {
                const grant = accessDraft.peerAgentGrants.find((item) => item.agentId === peer.agentId);
                return (
                  <Paper key={peer.agentId} variant="outlined" sx={{ p: 1.25, borderRadius: 1 }}>
                    <Stack spacing={1}>
                      <FormControlLabel
                        control={(
                          <Checkbox
                            checked={Boolean(grant)}
                            onChange={(event) => {
                              setAccessDraft((current) => ({
                                ...current,
                                peerAgentGrants: event.target.checked
                                  ? [...current.peerAgentGrants.filter((item) => item.agentId !== peer.agentId), { agentId: peer.agentId, name: peer.name, description: peer.description, criteria: '' }]
                                  : current.peerAgentGrants.filter((item) => item.agentId !== peer.agentId),
                              }));
                            }}
                          />
                        )}
                        label={peer.name}
                      />
                      {grant ? (
                        <TextField
                          size="small"
                          fullWidth
                          multiline
                          minRows={2}
                          label={t.locale === 'es' ? 'Criterio de uso' : 'Usage criteria'}
                          value={grant.criteria}
                          onChange={(event) => {
                            setAccessDraft((current) => ({
                              ...current,
                              peerAgentGrants: current.peerAgentGrants.map((item) =>
                                item.agentId === peer.agentId ? { ...item, criteria: event.target.value } : item),
                            }));
                          }}
                        />
                      ) : null}
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t.locale === 'es' ? 'No hay otros agentes personales disponibles.' : 'No other personal agents are available.'}
            </Typography>
          )}
        </Box>
      </Stack>
    );
  };

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
            bgcolor: isUser ? 'primary.main' : 'transparent',
            color: isUser
              ? theme.palette.primary.contrastText
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
        <Typography variant="subtitle2" noWrap>{t.locale === 'es' ? 'Mensajes con otros agentes' : 'Messages with other agents'}</Typography>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 0.75 }}>
        {peerThreads.length > 0 ? renderPeerThreadRows(peerThreads) : (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            {t.locale === 'es' ? 'No hay threads con otros agentes.' : 'No peer agent threads yet.'}
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
            {t.locale === 'es'
              ? 'Esta conversacion fue iniciada por otro agente. Puedes revisarla, pero no responder desde aqui.'
              : 'This thread was started by another agent. You can review it, but replies are not available here.'}
          </Typography>
        </Box>
      );
    }
    return (
      <Paper variant="outlined" sx={{ m: 1.5, mt: 0, p: 1, borderRadius: 1 }}>
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
          onChange={(event) => setMessage(event.target.value)}
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
              <IconButton size="small" disabled={busy || Boolean(runIsActive)} onClick={() => void handlePickFiles()}>
                <AttachFileRounded fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t.agents.send}>
            <span>
              <IconButton
                color="primary"
                disabled={!conversation || (!message.trim() && pendingFiles.length === 0) || busy || Boolean(runIsActive)}
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

        <Tabs value={detailTab} onChange={(_event, value: 'chat' | 'workspace' | 'settings') => setDetailTab(value)}>
          <Tab value="chat" label={t.agents.chatTitle} />
          <Tab value="workspace" label={t.agents.workspaceTab} />
          <Tab value="settings" label={t.locale === 'es' ? 'Configuracion' : 'Settings'} />
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
          ) : detailTab === 'settings' ? (
            <Paper variant="outlined" sx={{ height: '100%', minHeight: 0, overflow: 'auto', p: 2, borderRadius: 1 }}>
              <Stack spacing={2}>
                {renderAccessControls()}
                <Box>
                  <Button
                    startIcon={<SaveRounded />}
                    variant="contained"
                    disabled={busyAction === 'access'}
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
            {renderAccessControls()}
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
                {t.locale === 'es' ? 'Este thread no tiene mensajes visibles.' : 'This thread has no visible messages.'}
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
