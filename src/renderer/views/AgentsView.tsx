import { useCallback, useEffect, useMemo, useState } from 'react';
import AddRounded from '@mui/icons-material/AddRounded';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import ChatRounded from '@mui/icons-material/ChatRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DescriptionRounded from '@mui/icons-material/DescriptionRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import FolderRounded from '@mui/icons-material/FolderRounded';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import {
  Alert,
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
import type { AgentPermissionMode, AgentToolId, PersonalAgent, PersonalAgentConversation, PersonalAgentConversationEvent, PersonalAgentGrantOptions, PersonalAgentMessage, PersonalAgentRunStatus, PersonalAgentWorkspaceEntry, PersonalAgentWorkspaceFile } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { MarkdownMessage } from './chat/MarkdownMessage';

interface AgentsViewProps {
  t: AppDictionary;
  intelligenceProviderConfigured: boolean;
}

interface WorkspaceTreeProps {
  entries: PersonalAgentWorkspaceEntry[];
  emptyLabel: string;
  selectedPath?: string;
  onOpenFile: (entry: PersonalAgentWorkspaceEntry) => void;
}

interface AccessDraft {
  permissionMode: AgentPermissionMode;
  networkAccess: boolean;
  appIds: string[];
  toolIds: AgentToolId[];
}

function WorkspaceTree({ entries, emptyLabel, selectedPath, onOpenFile }: WorkspaceTreeProps) {
  if (entries.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">{emptyLabel}</Typography>
      </Box>
    );
  }

  const renderEntry = (entry: PersonalAgentWorkspaceEntry, depth: number) => (
    <Box key={entry.relativePath}>
      <Stack
        direction="row"
        spacing={0.75}
        alignItems="center"
        role={entry.kind === 'file' ? 'button' : undefined}
        tabIndex={entry.kind === 'file' ? 0 : undefined}
        onClick={() => {
          if (entry.kind === 'file') {
            onOpenFile(entry);
          }
        }}
        onKeyDown={(event) => {
          if (entry.kind === 'file' && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onOpenFile(entry);
          }
        }}
        sx={{
          bgcolor: entry.relativePath === selectedPath ? 'action.selected' : 'transparent',
          cursor: entry.kind === 'file' ? 'pointer' : 'default',
          minHeight: 30,
          pl: 1 + depth * 1.5,
          pr: 1,
          '&:hover': {
            bgcolor: entry.kind === 'file' ? 'action.hover' : 'transparent',
          },
        }}
      >
        {entry.kind === 'directory' ? (
          <FolderRounded color="action" sx={{ fontSize: 18, flexShrink: 0 }} />
        ) : (
          <DescriptionRounded color="action" sx={{ fontSize: 18, flexShrink: 0 }} />
        )}
        <Typography
          variant="body2"
          title={entry.relativePath}
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {entry.name}
        </Typography>
      </Stack>
      {entry.children?.map((child) => renderEntry(child, depth + 1))}
    </Box>
  );

  return <Box sx={{ py: 0.75 }}>{entries.map((entry) => renderEntry(entry, 0))}</Box>;
}

const isTerminalRunStatus = (status: PersonalAgentRunStatus | undefined): boolean =>
  status === 'completed' || status === 'failed' || status === 'canceled';

const upsertConversation = (
  current: PersonalAgentConversation[],
  conversation: PersonalAgentConversation,
): PersonalAgentConversation[] => {
  const next = [
    conversation,
    ...current.filter((item) => item.id !== conversation.id),
  ];
  return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

const defaultAccessDraft = (): AccessDraft => ({
  permissionMode: 'safe',
  networkAccess: false,
  appIds: [],
  toolIds: [],
});

const accessDraftFromAgent = (agent: PersonalAgent): AccessDraft => ({
  permissionMode: agent.permissionMode,
  networkAccess: agent.networkAccess,
  appIds: agent.appIds ?? [],
  toolIds: agent.toolIds ?? [],
});

const toggleId = <T extends string>(values: T[], id: T, checked: boolean): T[] =>
  checked ? [...new Set([...values, id])] : values.filter((value) => value !== id);

const personalAgentRunErrorMessage = (error: string | undefined, t: AppDictionary): string | null => {
  if (!error) return null;
  const normalized = error.trim();
  if (normalized === 'codex_auth_missing' || normalized === 'claude_auth_missing') return t.agents.runErrorLlmAuth;
  if (normalized === 'codex_cli_missing') return t.agents.runErrorCodexCli;
  if (normalized === 'claude_cli_missing') return t.agents.runErrorClaudeCli;
  if (normalized === 'personal_agent_workspace_missing') return t.agents.runErrorWorkspaceMissing;
  if (normalized === 'personal_agent_runtime_unavailable') return t.agents.runErrorRuntimeUnavailable;
  return t.agents.runErrorGeneric;
};

export function AgentsView({ t, intelligenceProviderConfigured }: AgentsViewProps) {
  const theme = useTheme();
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<PersonalAgentConversation[]>([]);
  const [conversation, setConversation] = useState<PersonalAgentConversation | null>(null);
  const [workspaceEntries, setWorkspaceEntries] = useState<PersonalAgentWorkspaceEntry[]>([]);
  const [grantOptions, setGrantOptions] = useState<PersonalAgentGrantOptions>({ apps: [], tools: [] });
  const [openFile, setOpenFile] = useState<PersonalAgentWorkspaceFile | null>(null);
  const [fileDraft, setFileDraft] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editAccessOpen, setEditAccessOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [purpose, setPurpose] = useState('');
  const [accessDraft, setAccessDraft] = useState<AccessDraft>({
    permissionMode: 'safe',
    networkAccess: false,
    appIds: [],
    toolIds: [],
  });
  const [message, setMessage] = useState('');
  const [busyAction, setBusyAction] = useState<'create' | 'delete' | 'file' | 'start' | 'send' | 'access' | null>(null);
  const [sideTab, setSideTab] = useState<'history' | 'workspace'>('history');
  const [error, setError] = useState<string | null>(null);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? null,
    [agents, activeAgentId],
  );

  const isBlankAgent = activeAgent && conversations.length === 0 && !conversation;
  const fileDirty = Boolean(openFile && fileDraft !== openFile.content);
  const activeRun = conversation?.activeRun;
  const runIsActive = Boolean(activeRun && !isTerminalRunStatus(activeRun.status));
  const visibleMessages = useMemo(
    () => (conversation?.messages ?? []).filter((item) => item.role !== 'system'),
    [conversation?.messages],
  );
  const runErrorMessage = activeRun?.status === 'failed'
    ? personalAgentRunErrorMessage(activeRun.error, t)
    : null;
  const busy = busyAction !== null;

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
      window.forger.personalAgentGrantOptionsList().catch(() => ({ apps: [], tools: [] })),
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
    let mounted = true;
    if (!activeAgentId) {
      setConversations([]);
      setConversation(null);
      setWorkspaceEntries([]);
      setOpenFile(null);
      setFileDraft('');
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
        appIds: accessDraft.appIds,
        toolIds: accessDraft.toolIds,
      });
      resetCreateForm();
      setCreateOpen(false);
      await loadAgents();
      setActiveAgentId(agent.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t.agents.createError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenCreate = () => {
    resetCreateForm();
    setCreateOpen(true);
  };

  const handleOpenEditAccess = () => {
    if (!activeAgent) return;
    setAccessDraft(accessDraftFromAgent(activeAgent));
    setEditAccessOpen(true);
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
        appIds: accessDraft.appIds,
        toolIds: accessDraft.toolIds,
      });
      setAgents((current) => current.map((agent) => agent.id === updated.id ? updated : agent));
      setEditAccessOpen(false);
    } catch (accessError) {
      setError(accessError instanceof Error ? accessError.message : t.agents.accessSaveError);
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
        initialMessage: t.agents.firstConversationMessage,
      });
      setConversation(started);
      setConversations((current) => upsertConversation(current, started));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : t.agents.startError);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSendMessage = async () => {
    if (!activeAgent || !conversation || !message.trim() || busy || runIsActive) return;
    setBusyAction('send');
    setError(null);
    try {
      const updated = await window.forger.personalAgentSendMessage({
        conversationId: conversation.id,
        content: message,
      });
      setConversation(updated);
      setConversations((current) => upsertConversation(current, updated));
      setMessage('');
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : t.agents.sendError);
    } finally {
      setBusyAction(null);
    }
  };

  const renderAccessChips = (agent: PersonalAgent) => (
    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
      <Chip size="small" label={agent.permissionMode === 'unsafe' ? t.agents.expandedPermission : t.agents.standardPermission} />
      <Chip size="small" label={agent.networkAccess ? t.agents.internetOn : t.agents.internetOff} />
      <Chip size="small" label={agent.appIds.length > 0 ? t.agents.appsCount(agent.appIds.length) : t.agents.noAppsAccess} />
      <Chip size="small" label={agent.toolIds.length > 0 ? t.agents.toolsCount(agent.toolIds.length) : t.agents.noToolsAccess} />
    </Stack>
  );

  const renderAccessControls = () => (
    <Stack spacing={1.5}>
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
            {grantOptions.tools.map((tool) => (
              <Box key={tool.id}>
                <Typography variant="body2" fontWeight={700}>{tool.name}</Typography>
                <Typography variant="caption" color="text.secondary">{tool.configured ? tool.description : t.agents.toolNeedsSetup}</Typography>
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
              </Box>
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">{t.agents.noToolsAvailable}</Typography>
        )}
      </Box>
    </Stack>
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

  const runStatusLabel = (status: PersonalAgentRunStatus | undefined) => {
    if (busyAction === 'start') return t.agents.runStarting;
    if (busyAction === 'send') return t.agents.runSending;
    switch (status) {
      case 'queued':
        return t.agents.runQueued;
      case 'running':
        return t.agents.runRunning;
      case 'needs_permission':
        return t.agents.runNeedsPermission;
      case 'completed':
        return t.agents.runCompleted;
      case 'failed':
        return t.agents.runFailed;
      case 'canceled':
        return t.agents.runCanceled;
      default:
        return t.agents.runReady;
    }
  };

  const renderMessage = (item: PersonalAgentMessage) => {
    const isUser = item.role === 'user';
    const isIntermediate = item.kind === 'intermediate';
    return (
      <Stack
        key={item.id}
        direction="row"
        justifyContent={isUser ? 'flex-end' : 'flex-start'}
        sx={{ minWidth: 0, maxWidth: '100%', overflowX: 'hidden' }}
      >
        <Box
          sx={{
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
        </Box>
      </Stack>
    );
  };

  const renderSidePanel = () => (
    <Box
      sx={{
        width: { xs: '100%', lg: 320 },
        flexShrink: 0,
        minHeight: 0,
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Tabs
        value={sideTab}
        onChange={(_event, value: 'history' | 'workspace') => setSideTab(value)}
        variant="fullWidth"
        sx={{ borderBottom: `1px solid ${theme.palette.divider}`, minHeight: 44 }}
      >
        <Tab value="history" label={t.agents.historyTab} sx={{ minHeight: 44 }} />
        <Tab value="workspace" label={t.agents.workspaceTab} sx={{ minHeight: 44 }} />
      </Tabs>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {sideTab === 'history' ? (
          conversations.length > 0 ? (
            <Stack divider={<Divider />}>
              {conversations.map((item) => (
                <Box
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setConversation(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setConversation(item);
                    }
                  }}
                  sx={{
                    bgcolor: item.id === conversation?.id ? 'action.selected' : 'transparent',
                    cursor: 'pointer',
                    p: 1.25,
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Stack spacing={0.75}>
                    <Typography variant="body2" fontWeight={700} noWrap>{item.title}</Typography>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <Chip size="small" label={runStatusLabel(item.activeRun?.status)} />
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {new Date(item.updatedAt).toLocaleString()}
                      </Typography>
                    </Stack>
                  </Stack>
                </Box>
              ))}
            </Stack>
          ) : (
            <Box sx={{ p: 2 }}>
              <Typography variant="body2" color="text.secondary">{t.agents.historyEmpty}</Typography>
            </Box>
          )
        ) : (
          <Stack sx={{ minHeight: '100%' }}>
            <WorkspaceTree
              entries={workspaceEntries}
              emptyLabel={t.agents.workspaceEmpty}
              selectedPath={openFile?.relativePath}
              onOpenFile={(entry) => void handleOpenFile(entry)}
            />
          </Stack>
        )}
      </Box>
    </Box>
  );

  const renderDetail = () => {
    if (!activeAgent) return renderMainList();

    return (
      <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0 }}>
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
          <Button startIcon={<EditRounded />} variant="outlined" onClick={handleOpenEditAccess}>
            {t.agents.editAccess}
          </Button>
        </Stack>

        {renderAccessChips(activeAgent)}

        {error ? <Alert severity="error">{error}</Alert> : null}

        <Stack
          direction={{ xs: 'column', lg: 'row' }}
          spacing={1.5}
          sx={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}
        >
          {renderSidePanel()}
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
              <ChatRounded color="action" />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="subtitle2" noWrap>{conversation?.title ?? t.agents.chatTitle}</Typography>
              </Box>
              {runIsActive || busyAction === 'start' || busyAction === 'send' ? <CircularProgress size={18} /> : null}
            </Stack>

            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {isBlankAgent ? (
                <Stack spacing={1.5} alignItems="center" justifyContent="center" sx={{ minHeight: '100%', p: 4, textAlign: 'center' }}>
                  <Typography variant="h6">{t.agents.blankTitle}</Typography>
                  <Typography color="text.secondary">{t.agents.blankSubtitle}</Typography>
                  {intelligenceProviderConfigured ? (
                    <Button
                      startIcon={<PlayArrowRounded />}
                      variant="contained"
                      disabled={busy}
                      onClick={() => void handleStartConversation()}
                    >
                      {t.agents.startConversation}
                    </Button>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {t.agents.llmRequired}
                    </Typography>
                  )}
                </Stack>
              ) : visibleMessages.length ? (
                <Stack spacing={2} sx={{ p: 1.5, minWidth: 0 }}>
                  {visibleMessages.map((item) => renderMessage(item))}
                  {runIsActive ? (
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ maxWidth: '78%', color: 'text.secondary' }}>
                      <CircularProgress size={16} />
                      <Typography variant="body2">{t.agents.firstRunLoading}</Typography>
                    </Stack>
                  ) : runErrorMessage ? (
                    <Typography variant="body2" color="error" sx={{ maxWidth: '78%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                      {runErrorMessage}
                    </Typography>
                  ) : null}
                </Stack>
              ) : (
                <Box sx={{ p: 4, textAlign: 'center', minHeight: '100%', display: 'grid', placeItems: 'center' }}>
                  <Stack spacing={1} alignItems="center">
                    {(runIsActive || busyAction === 'start') ? <CircularProgress size={22} /> : null}
                    <Typography color="text.secondary">
                      {(runIsActive || busyAction === 'start') ? t.agents.firstRunLoading : t.agents.noMessages}
                    </Typography>
                  </Stack>
                </Box>
              )}
            </Box>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ p: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
              <TextField
                fullWidth
                size="small"
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
              />
              <Button
                startIcon={<SendRounded />}
                variant="contained"
                disabled={!conversation || !message.trim() || busy || Boolean(runIsActive)}
                onClick={() => void handleSendMessage()}
              >
                {t.agents.send}
              </Button>
            </Stack>
          </Stack>
          {renderFilePanel()}
        </Stack>
      </Stack>
    );
  };

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

      <Dialog open={editAccessOpen} onClose={() => setEditAccessOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t.agents.editAccess}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 0.5 }}>
            {renderAccessControls()}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditAccessOpen(false)}>{t.actions.close}</Button>
          <Button
            startIcon={<SaveRounded />}
            variant="contained"
            disabled={busyAction === 'access'}
            onClick={() => void handleSaveAccess()}
          >
            {t.agents.saveAccess}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
