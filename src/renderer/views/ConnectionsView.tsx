import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded';
import ChatRounded from '@mui/icons-material/ChatRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded';
import MailRounded from '@mui/icons-material/MailRounded';
import type {
  AgentToolDefinition,
  AgentToolSettings,
  AppSummary,
  ConfigureConnectionInput,
  ConnectionActionDefinition,
  ConnectionInstance,
  ConnectionMutationResult,
  ConnectionsState,
  ConnectionTypeDefinition,
  PersonalAgent,
  Workflow,
} from '@shared/types';
import { BUILT_IN_CONNECTION_TYPES } from '@shared/connection-catalog';
import type { AppDictionary } from '@renderer/i18n';
import { GmailIcon, SlackIcon, TrelloIcon } from './tools/ToolIcons';
import { BrandIcon } from './tools/BrandIcons';
import { SetupGuideDialog } from './connections/SetupGuideDialog';
import { getSetupGuideUiCopy } from './connections/setupGuideUiCopy';

const SERVICE_ORDER: readonly string[] = [...BUILT_IN_CONNECTION_TYPES];
const GMAIL_SELF_OAUTH_CLIENT_ID_SECRET = 'self_oauth_client_id';
const GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET = 'self_oauth_client_secret';

const emptyState: ConnectionsState = { types: [], instances: [] };

const connectionIcon = (type: string) => {
  if (type === 'gmail') return <GmailIcon />;
  if (type === 'whatsapp') return <ChatRounded color="success" sx={{ width: 44, height: 44, flexShrink: 0 }} />;
  if (type === 'slack') return <SlackIcon />;
  if (type === 'trello') return <TrelloIcon />;
  if (BUILT_IN_CONNECTION_TYPES.includes(type as typeof BUILT_IN_CONNECTION_TYPES[number])) return <BrandIcon type={type} />;
  return <MailRounded color="primary" sx={{ width: 44, height: 44, flexShrink: 0 }} />;
};

const identityLabel = (instance: ConnectionInstance): string =>
  instance.accountIdentity?.email
  ?? instance.accountIdentity?.workspace
  ?? instance.accountIdentity?.username
  ?? instance.accountIdentity?.phoneNumber
  ?? instance.label
  ?? instance.id;

const statusColor = (status: ConnectionInstance['status']): 'default' | 'success' | 'warning' | 'error' | 'info' =>
  status === 'connected' ? 'success'
    : status === 'needs_reconnect' || status === 'needs_setup' ? 'warning'
      : status === 'error' ? 'error'
        : status === 'connecting' || status === 'syncing' ? 'info'
          : 'default';

const connectionGrantMatches = (
  grant: { type: string; connectionIds?: string[] },
  type: string,
  connectionId?: string,
): boolean => {
  if (grant.type !== type) return false;
  if (!connectionId || !grant.connectionIds?.length) return true;
  return grant.connectionIds.includes(connectionId);
};

const workflowUsesConnection = (workflow: Workflow, type: string, connectionId?: string): boolean =>
  workflow.nodes.some((node) => {
    if (node.type === 'connection') {
      return node.connectionType === type && (!connectionId || !node.connectionId || node.connectionId === connectionId);
    }
    if (node.type === 'llm_agent') {
      return node.connectionGrants.some((grant) => connectionGrantMatches(grant, type, connectionId));
    }
    return false;
  });

const appDeclaresConnection = (app: AppSummary, type: string): boolean => [
  ...(app.connections?.required ?? []),
  ...(app.connections?.optional ?? []),
].some((declaration) => declaration.type === type);

const actionToolId = (action: ConnectionActionDefinition): AgentToolDefinition['id'] =>
  action.id as AgentToolDefinition['id'];

type ConnectionsViewMode = 'list' | 'detail';
type ConnectionNotice = { severity: 'success' | 'error' | 'info'; message: string };

export function ConnectionsView({
  t,
  view,
  selectedConnectionId,
  settings,
  busyToolId,
  onOpenConnection,
  onBack,
  onNotice,
  onApprovalChange,
}: {
  t: AppDictionary;
  view: ConnectionsViewMode;
  selectedConnectionId: string | null;
  settings: AgentToolSettings;
  busyToolId: AgentToolDefinition['id'] | null;
  onOpenConnection: (connectionId: string) => void;
  onBack?: () => void;
  onNotice?: (notice: ConnectionNotice) => void;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
}) {
  const copy = t.sections.connections;
  const [state, setState] = useState<ConnectionsState>(emptyState);
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<ConnectionNotice | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupGuideOpen, setSetupGuideOpen] = useState(false);
  const [setupType, setSetupType] = useState<string>('');
  const [setupConnectionId, setSetupConnectionId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [gmailMode, setGmailMode] = useState<'forger' | 'self'>('forger');
  const [pairingConnectionId, setPairingConnectionId] = useState<string | null>(null);
  const [pairingResult, setPairingResult] = useState('');

  const refresh = useCallback(async () => {
    const [next, nextAgents, nextWorkflows, nextApps] = await Promise.all([
      window.forger.connectionsList(t.locale),
      window.forger.personalAgentsList().catch((): PersonalAgent[] => []),
      window.forger.workflowsList().catch((): Workflow[] => []),
      window.forger.listInstalledApps().catch((): AppSummary[] => []),
    ]);
    setState(next);
    setAgents(nextAgents);
    setWorkflows(nextWorkflows);
    setApps(nextApps);
    return next;
  }, [t.locale]);

  useEffect(() => {
    void refresh().catch((error) => {
      setBanner({ severity: 'error', message: error instanceof Error ? error.message : copy.loadError });
    });
  }, [copy.loadError, refresh]);

  useEffect(() => {
    if (!setupOpen || !pairingConnectionId) return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        const result = await window.forger.connectionsCall({
          type: 'whatsapp',
          actionId: 'whatsapp.connection.status',
          connectionId: pairingConnectionId,
        });
        const status = result.data && typeof result.data === 'object'
          ? (result.data as { status?: string }).status
          : undefined;
        if (result.success && status === 'connected') {
          const next = await refresh();
          const connected = next.instances.find((instance) => instance.id === pairingConnectionId);
          onOpenConnection(connected?.id ?? pairingConnectionId);
          setBanner({ severity: 'success', message: result.userMessage ?? copy.statusChecked });
          setSetupOpen(false);
          setSetupGuideOpen(false);
          setPairingConnectionId(null);
          setPairingResult('');
        }
      })().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [copy.statusChecked, onOpenConnection, pairingConnectionId, refresh, setupOpen]);

  const orderedTypes = useMemo(() => [...state.types].sort((a, b) => {
    const ai = SERVICE_ORDER.indexOf(a.type);
    const bi = SERVICE_ORDER.indexOf(b.type);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.displayName.localeCompare(b.displayName);
  }), [state.types]);

  const typeById = useMemo(
    () => new Map(orderedTypes.map((definition) => [definition.type, definition])),
    [orderedTypes],
  );

  const sortedInstances = useMemo(() => [...state.instances].sort((a, b) => {
    const typeA = typeById.get(a.type)?.displayName ?? a.type;
    const typeB = typeById.get(b.type)?.displayName ?? b.type;
    return typeA.localeCompare(typeB) || identityLabel(a).localeCompare(identityLabel(b));
  }), [state.instances, typeById]);

  const visibleInstances = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sortedInstances;
    return sortedInstances.filter((instance) => {
      const definition = typeById.get(instance.type);
      return `${identityLabel(instance)} ${definition?.displayName ?? instance.type} ${instance.status}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [query, sortedInstances, typeById]);

  const selectedInstance = sortedInstances.find((instance) => instance.id === selectedConnectionId) ?? null;
  const selectedDefinition = selectedInstance ? typeById.get(selectedInstance.type) ?? null : null;
  const setupDefinition = orderedTypes.find((definition) => definition.type === setupType) ?? null;
  const setupGuideCopy = useMemo(() => getSetupGuideUiCopy(t.locale), [t.locale]);
  const showSetupGuide = Boolean(setupDefinition?.setupGuide)
    && (setupDefinition?.type !== 'gmail' || gmailMode === 'self');

  const usage = useMemo(() => {
    if (!selectedDefinition || !selectedInstance) {
      return { agents: [], workflows: [], apps: [] };
    }
    return {
      agents: agents
        .filter((agent) => agent.connectionGrants.some((grant) =>
          connectionGrantMatches(grant, selectedDefinition.type, selectedInstance.id)))
        .map((agent) => agent.name),
      workflows: workflows
        .filter((workflow) => workflowUsesConnection(workflow, selectedDefinition.type, selectedInstance.id))
        .map((workflow) => workflow.name),
      apps: apps
        .filter((app) => appDeclaresConnection(app, selectedDefinition.type))
        .map((app) => app.name ?? app.id),
    };
  }, [agents, apps, selectedDefinition, selectedInstance, workflows]);
  const usageCount = usage.agents.length + usage.workflows.length + usage.apps.length;

  const openSetup = (type?: string, connectionId?: string) => {
    const instance = connectionId ? state.instances.find((candidate) => candidate.id === connectionId) ?? null : null;
    setSetupType(type ?? instance?.type ?? orderedTypes[0]?.type ?? '');
    setSetupConnectionId(instance?.id ?? null);
    setLabel(instance?.label ?? '');
    setSecrets({});
    setGmailMode('forger');
    setPairingConnectionId(null);
    setPairingResult('');
    setSetupGuideOpen(false);
    setSetupOpen(true);
  };

  const runMutation = async (
    key: string,
    action: () => Promise<ConnectionMutationResult>,
  ): Promise<ConnectionMutationResult> => {
    setBusy(key);
    setBanner(null);
    try {
      const result = await action();
      setBanner({ severity: result.success ? 'success' : 'error', message: result.userMessage });
      await refresh();
      return result;
    } catch {
      const result: ConnectionMutationResult = {
        success: false,
        userMessage: copy.mutationFailed,
        technicalCode: 'connection_mutation_unhandled_error',
      };
      setBanner({ severity: 'error', message: result.userMessage });
      return result;
    } finally {
      setBusy(null);
    }
  };

  const configure = async () => {
    if (!setupDefinition) return;
    const inputSecrets = setupDefinition.type === 'gmail' && gmailMode === 'self'
      ? {
          [GMAIL_SELF_OAUTH_CLIENT_ID_SECRET]: secrets[GMAIL_SELF_OAUTH_CLIENT_ID_SECRET] ?? '',
          [GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET]: secrets[GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET] ?? '',
        }
      : secrets;
    const input: ConfigureConnectionInput = {
      type: setupDefinition.type,
      ...(setupConnectionId ? { connectionId: setupConnectionId } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(Object.keys(inputSecrets).length > 0 ? { secrets: inputSecrets } : {}),
    };
    const result = await runMutation(`configure:${setupDefinition.type}`, () => window.forger.connectionsConfigure(input));
    if (!result?.success || !result.instance) return;
    onOpenConnection(result.instance.id);
    if (setupDefinition.type !== 'whatsapp') {
      setSetupOpen(false);
      setSetupGuideOpen(false);
      return;
    }
    setPairingConnectionId(result.instance.id);
    setBusy('pair:whatsapp');
    try {
      const pairing = await window.forger.connectionsCall({
        type: 'whatsapp',
        actionId: 'whatsapp.start_pairing',
        connectionId: result.instance.id,
        input: { method: 'qr' },
      });
      setPairingResult(pairing.success
        ? JSON.stringify(pairing.data ?? {}, null, 2)
        : pairing.userMessage ?? pairing.technicalCode ?? copy.statusCheckFailed);
    } finally {
      setBusy(null);
    }
  };

  const copyCallbackUrl = async (value: string) => {
    await navigator.clipboard?.writeText(value).catch(() => undefined);
  };

  const openExternalUrl = (url: string) => {
    if (!url) return;
    void window.forger.openExternalUrl(url).catch(() => undefined);
  };

  const disconnect = async (definition: ConnectionTypeDefinition, instance: ConnectionInstance) => {
    if (!window.confirm(copy.disconnectConfirm(identityLabel(instance)))) return;
    const result = await runMutation(`disconnect:${instance.id}`, () => window.forger.connectionsDisconnect({
      type: definition.type,
      connectionId: instance.id,
    }));
    if (view === 'detail') {
      onNotice?.({ severity: result.success ? 'success' : 'error', message: result.userMessage });
      onBack?.();
    }
  };

  const refreshStatus = async (definition: ConnectionTypeDefinition, instance: ConnectionInstance) => {
    setBusy(`status:${instance.id}`);
    setBanner(null);
    try {
      const result = await window.forger.connectionsCall({
        type: definition.type,
        actionId: definition.statusActionId,
        connectionId: instance.id,
      });
      setBanner({
        severity: result.success ? 'success' : 'error',
        message: result.userMessage ?? (result.success ? copy.statusChecked : copy.statusCheckFailed),
      });
      await refresh();
    } catch {
      setBanner({ severity: 'error', message: copy.statusCheckFailed });
    } finally {
      setBusy(null);
    }
  };

  const canSubmitSetup = Boolean(setupDefinition) && busy === null
    && (setupDefinition?.type !== 'gmail' || gmailMode === 'forger'
      || (Boolean(secrets[GMAIL_SELF_OAUTH_CLIENT_ID_SECRET]?.trim())
        && Boolean(secrets[GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET]?.trim())))
    && (setupDefinition?.setupKind !== 'oauth' || setupDefinition.type === 'gmail'
      || setupDefinition.secretsSchema.every((secret) => !secret.required || Boolean(secrets[secret.name]?.trim())))
    && (setupDefinition?.setupKind !== 'manual_secret'
      || setupDefinition.secretsSchema.every((secret) => !secret.required || Boolean(secrets[secret.name]?.trim())));

  return (
    <Stack spacing={2.5} data-onboarding-target="connections-list">
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', md: 'flex-start' }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h3" fontWeight={750}>{copy.title}</Typography>
          <Typography variant="body1" color="text.secondary">{copy.subtitle}</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddRounded />} data-onboarding-target="connections-add" onClick={() => openSetup()}>
          {copy.addConnection}
        </Button>
      </Stack>

      {banner ? <Alert severity={banner.severity} onClose={() => setBanner(null)}>{banner.message}</Alert> : null}

      {view === 'list' ? (
        <Paper variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
          <Stack spacing={1.25} sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
            <Typography variant="subtitle2">{copy.savedConnectionsTitle}</Typography>
            <TextField
              size="small"
              fullWidth
              placeholder={copy.searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Stack>
          {visibleInstances.length === 0 ? (
            <Box sx={{ p: 2 }}>
              <Typography color="text.secondary">{state.instances.length === 0 ? copy.emptyConnections : copy.emptySearch}</Typography>
            </Box>
          ) : (
            <Table size="small" aria-label={copy.savedConnectionsTitle}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 190 }}>{copy.providerColumn}</TableCell>
                  <TableCell>{copy.identityColumn}</TableCell>
                  <TableCell sx={{ width: 150 }}>{copy.statusColumn}</TableCell>
                  <TableCell sx={{ width: 120 }}>{copy.defaultColumn}</TableCell>
                  <TableCell sx={{ width: 190 }}>{copy.lastCheckedColumn}</TableCell>
                  <TableCell align="right" sx={{ width: 64 }}>{copy.actionColumn}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visibleInstances.map((instance) => {
                  const definition = typeById.get(instance.type);
                  return (
                    <TableRow
                      key={instance.id}
                      hover
                      data-onboarding-target={`connection-row-${instance.type}`}
                      onClick={() => onOpenConnection(instance.id)}
                      sx={{ cursor: 'pointer' }}
                    >
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                          {connectionIcon(instance.type)}
                          <Typography variant="body2" fontWeight={700} noWrap>{definition?.displayName ?? instance.type}</Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600} noWrap>{identityLabel(instance)}</Typography>
                        {instance.label && instance.label !== identityLabel(instance) ? (
                          <Typography variant="caption" color="text.secondary" noWrap>{instance.label}</Typography>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Chip size="small" color={statusColor(instance.status)} label={copy.statusLabels[instance.status] ?? instance.status} />
                      </TableCell>
                      <TableCell>{instance.isDefault ? <Chip size="small" color="primary" label={copy.defaultAccount} /> : null}</TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary" noWrap>
                          {instance.lastCheckedAt ? new Date(instance.lastCheckedAt).toLocaleString() : copy.neverChecked}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Tooltip title={copy.viewDetails}>
                          <IconButton
                            size="small"
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenConnection(instance.id);
                            }}
                            aria-label={copy.viewDetails}
                          >
                            <ArrowForwardRounded fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Paper>
      ) : (
        <Paper variant="outlined" data-onboarding-target="connection-detail" sx={{ borderRadius: 1, p: 2, minWidth: 0 }}>
          <Button
            variant="text"
            startIcon={<ArrowBackRounded />}
            onClick={onBack}
            sx={{ alignSelf: 'flex-start', mb: 1.5 }}
          >
            {copy.backToConnections}
          </Button>
          {selectedInstance && selectedDefinition ? (
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', md: 'center' }}>
                <Stack direction="row" spacing={1.25} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
                  {connectionIcon(selectedDefinition.type)}
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="h5" fontWeight={750}>{identityLabel(selectedInstance)}</Typography>
                    <Typography variant="body2" color="text.secondary">{selectedDefinition.displayName}</Typography>
                  </Box>
                </Stack>
                {selectedInstance.status === 'needs_reconnect' || selectedInstance.status === 'error' ? (
                  <Button variant="contained" onClick={() => openSetup(selectedDefinition.type, selectedInstance.id)}>
                    {copy.reconnect}
                  </Button>
                ) : null}
              </Stack>

              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                <Chip color={statusColor(selectedInstance.status)} label={copy.statusLabels[selectedInstance.status] ?? selectedInstance.status} />
                {selectedInstance.isDefault ? <Chip color="primary" label={copy.defaultAccount} /> : null}
                <Chip variant="outlined" label={selectedInstance.lastCheckedAt ? copy.lastChecked(new Date(selectedInstance.lastCheckedAt).toLocaleString()) : copy.neverChecked} />
              </Stack>

              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {!selectedInstance.isDefault ? (
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={busy !== null}
                    onClick={() => void runMutation(`default:${selectedInstance.id}`, () => window.forger.connectionsSetDefault({
                      type: selectedDefinition.type,
                      connectionId: selectedInstance.id,
                    }))}
                  >
                    {copy.setDefault}
                  </Button>
                ) : null}
                <Button size="small" variant="outlined" disabled={busy !== null} onClick={() => void refreshStatus(selectedDefinition, selectedInstance)}>
                  {copy.checkStatus}
                </Button>
                <Button size="small" color="error" variant="outlined" disabled={busy !== null} onClick={() => void disconnect(selectedDefinition, selectedInstance)}>
                  {copy.disconnect}
                </Button>
              </Stack>

              <Divider />

              <Box data-onboarding-target="connection-approvals">
                <Typography variant="subtitle2" sx={{ mb: 1 }}>{copy.actionsTitle}</Typography>
                <Stack spacing={1}>
                  {selectedDefinition.actions.map((action) => {
                    const toolId = actionToolId(action);
                    const approvalEnabled = settings.approvals[toolId] ?? action.risk !== 'low';
                    return (
                      <Paper key={action.id} variant="outlined" sx={{ p: 1.25, borderRadius: 1 }}>
                        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} alignItems={{ xs: 'stretch', md: 'center' }}>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography fontWeight={700}>{action.name}</Typography>
                            <Typography variant="body2" color="text.secondary">{action.description}</Typography>
                            <Chip size="small" variant="outlined" sx={{ mt: 0.75 }} label={`${copy.riskLabel}: ${copy.risk[action.risk] ?? action.risk}`} />
                          </Box>
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
                            <Chip
                              size="small"
                              color={approvalEnabled ? 'warning' : 'success'}
                              label={approvalEnabled ? copy.approvalOn : copy.approvalOff}
                            />
                            <Switch
                              checked={approvalEnabled}
                              disabled={busyToolId === toolId}
                              onChange={(event) => onApprovalChange(toolId, event.target.checked)}
                              inputProps={{ 'aria-label': copy.approvalToggleLabel }}
                            />
                          </Stack>
                        </Stack>
                      </Paper>
                    );
                  })}
                </Stack>
              </Box>

              <Box data-onboarding-target="connection-used-by">
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{copy.usedByTitle}</Typography>
                <Stack spacing={1}>
                  {usage.agents.length > 0 ? (
                    <Box>
                      <Typography variant="caption" color="text.secondary">{copy.usedByAgents}</Typography>
                      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                        {usage.agents.map((name) => <Chip key={`agent:${name}`} size="small" label={name} />)}
                      </Stack>
                    </Box>
                  ) : null}
                  {usage.workflows.length > 0 ? (
                    <Box>
                      <Typography variant="caption" color="text.secondary">{copy.usedByWorkflows}</Typography>
                      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                        {usage.workflows.map((name) => <Chip key={`workflow:${name}`} size="small" label={name} />)}
                      </Stack>
                    </Box>
                  ) : null}
                  {usage.apps.length > 0 ? (
                    <Box>
                      <Typography variant="caption" color="text.secondary">{copy.usedByApps}</Typography>
                      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                        {usage.apps.map((name) => <Chip key={`app:${name}`} size="small" label={name} />)}
                      </Stack>
                    </Box>
                  ) : null}
                  {usageCount === 0 ? (
                    <Typography variant="body2" color="text.secondary">{copy.usedByEmpty}</Typography>
                  ) : null}
                </Stack>
              </Box>
            </Stack>
          ) : (
            <Stack spacing={1.5}>
              <Typography variant="h5" fontWeight={750}>{copy.noConnectionSelectedTitle}</Typography>
              <Typography color="text.secondary">{state.instances.length === 0 ? copy.emptyConnections : copy.noConnectionSelectedBody}</Typography>
              <Button variant="contained" sx={{ alignSelf: 'flex-start' }} onClick={() => openSetup()}>
                {copy.addConnection}
              </Button>
            </Stack>
          )}
        </Paper>
      )}

      <Dialog open={setupOpen} onClose={() => {
        setSetupOpen(false);
        setSetupGuideOpen(false);
      }} maxWidth="sm" fullWidth>
        <DialogTitle>{setupConnectionId ? copy.reconnectTitle : copy.setupTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 0.5 }}>
            <Autocomplete
              options={orderedTypes}
              value={setupDefinition}
              disabled={Boolean(setupConnectionId)}
              getOptionLabel={(definition) => definition.displayName}
              onChange={(_event, definition) => {
                setSetupType(definition?.type ?? '');
                setSecrets({});
                setLabel('');
                setPairingResult('');
                setPairingConnectionId(null);
                setSetupGuideOpen(false);
              }}
              renderOption={(props, definition) => (
                <Box component="li" {...props}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    {connectionIcon(definition.type)}
                    <Box>
                      <Typography>{definition.displayName}</Typography>
                      <Typography variant="caption" color="text.secondary">{definition.description}</Typography>
                    </Box>
                  </Stack>
                </Box>
              )}
              renderInput={(params) => (
                <TextField {...params} label={copy.service} placeholder={copy.serviceSearchPlaceholder} />
              )}
            />
            <TextField
              label={copy.accountLabel}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              helperText={copy.accountLabelHelp}
            />
            {showSetupGuide ? (
              <Button
                variant="outlined"
                startIcon={<HelpOutlineRounded />}
                sx={{ alignSelf: 'flex-start' }}
                onClick={() => setSetupGuideOpen(true)}
              >
                {setupGuideCopy.viewGuide}
              </Button>
            ) : null}

            {setupDefinition?.type === 'gmail' ? (
              <Stack spacing={1}>
                <Typography variant="subtitle2">{copy.gmailAuthMode}</Typography>
                <RadioGroup row value={gmailMode} onChange={(event) => {
                  setGmailMode(event.target.value === 'self' ? 'self' : 'forger');
                  setSecrets({});
                  setSetupGuideOpen(false);
                }}>
                  <FormControlLabel value="forger" control={<Radio />} label={copy.gmailForgerOAuth} />
                  <FormControlLabel value="self" control={<Radio />} label={copy.gmailSelfOAuth} />
                </RadioGroup>
                {gmailMode === 'self' ? (
                  <Stack spacing={1}>
                    <Alert severity="info" variant="outlined">{copy.gmailSelfOAuthHelp}</Alert>
                    {setupDefinition.oauth?.callbackUrl ? (
                      <Stack spacing={1}>
                        <Stack direction="row" spacing={1} alignItems="flex-start">
                          <TextField
                            label={copy.oauthCallbackUrl}
                            value={setupDefinition.oauth.callbackUrl}
                            disabled
                            helperText={copy.oauthCallbackHelp}
                            sx={{ flex: 1 }}
                          />
                          <Tooltip title={copy.copyCallbackUrl}>
                            <span>
                              <IconButton
                                sx={{ mt: 1 }}
                                aria-label={copy.copyCallbackUrl}
                                onClick={() => void copyCallbackUrl(setupDefinition.oauth?.callbackUrl ?? '')}
                              >
                                <ContentCopyRounded fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                        {setupDefinition.oauth.callbackPortChanged ? (
                          <Alert severity="warning" variant="outlined">{copy.oauthCallbackRotated}</Alert>
                        ) : null}
                      </Stack>
                    ) : null}
                    <TextField
                      label={copy.oauthClientId}
                      value={secrets[GMAIL_SELF_OAUTH_CLIENT_ID_SECRET] ?? ''}
                      onChange={(event) => setSecrets((current) => ({ ...current, [GMAIL_SELF_OAUTH_CLIENT_ID_SECRET]: event.target.value }))}
                    />
                    <TextField
                      label={copy.oauthClientSecret}
                      type="password"
                      value={secrets[GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET] ?? ''}
                      onChange={(event) => setSecrets((current) => ({ ...current, [GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET]: event.target.value }))}
                    />
                  </Stack>
                ) : (
                  <Alert severity="info" variant="outlined">{copy.noManualSecrets}</Alert>
                )}
              </Stack>
            ) : null}

            {setupDefinition?.setupKind === 'oauth' && setupDefinition.type !== 'gmail' ? (
              <Stack spacing={1}>
                <Alert severity="info" variant="outlined">{copy.selfOAuthHelp}</Alert>
                {setupDefinition.oauth?.callbackUrl ? (
                  <Stack spacing={1}>
                    <Stack direction="row" spacing={1} alignItems="flex-start">
                      <TextField
                        label={copy.oauthCallbackUrl}
                        value={setupDefinition.oauth.callbackUrl}
                        disabled
                        helperText={copy.oauthCallbackHelp}
                        sx={{ flex: 1 }}
                      />
                      <Tooltip title={copy.copyCallbackUrl}>
                        <span>
                          <IconButton
                            sx={{ mt: 1 }}
                            aria-label={copy.copyCallbackUrl}
                            onClick={() => void copyCallbackUrl(setupDefinition.oauth?.callbackUrl ?? '')}
                          >
                            <ContentCopyRounded fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                    {setupDefinition.oauth.callbackPortChanged ? (
                      <Alert severity="warning" variant="outlined">{copy.oauthCallbackRotated}</Alert>
                    ) : null}
                  </Stack>
                ) : null}
                {setupDefinition.secretsSchema.map((secret) => (
                  <TextField
                    key={secret.name}
                    label={secret.label}
                    value={secrets[secret.name] ?? ''}
                    type={secret.name.toLowerCase().includes('secret') || secret.name.toLowerCase().includes('token') ? 'password' : 'text'}
                    required={secret.required}
                    helperText={secret.usage}
                    onChange={(event) => setSecrets((current) => ({ ...current, [secret.name]: event.target.value }))}
                  />
                ))}
              </Stack>
            ) : null}

            {setupDefinition?.type === 'whatsapp' ? (
              <Alert severity="info" variant="outlined">{copy.whatsappModalBody}</Alert>
            ) : null}

            {setupDefinition?.setupKind === 'manual_secret' ? (
              <Stack spacing={1}>
                {setupDefinition.secretsSchema.map((secret) => (
                  <TextField
                    key={secret.name}
                    label={secret.label}
                    value={secrets[secret.name] ?? ''}
                    type={secret.name.toLowerCase().includes('secret') || secret.name.toLowerCase().includes('token') ? 'password' : 'text'}
                    required={secret.required}
                    helperText={secret.usage}
                    onChange={(event) => setSecrets((current) => ({ ...current, [secret.name]: event.target.value }))}
                  />
                ))}
              </Stack>
            ) : null}

            {pairingResult ? (
              <TextField
                label={copy.pairingResult}
                value={pairingResult}
                multiline
                minRows={4}
                size="small"
                helperText={copy.pairingWaiting}
              />
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => {
            setSetupOpen(false);
            setSetupGuideOpen(false);
          }}>{pairingConnectionId ? t.actions.close : t.actions.cancel}</Button>
          <Button variant="contained" disabled={!canSubmitSetup} onClick={() => void configure()}>
            {setupConnectionId ? copy.reconnect : copy.connect}
          </Button>
        </DialogActions>
      </Dialog>
      <SetupGuideDialog
        guide={showSetupGuide ? setupDefinition?.setupGuide ?? null : null}
        locale={t.locale}
        onClose={() => setSetupGuideOpen(false)}
        onCopy={(value) => void copyCallbackUrl(value)}
        onOpenExternalUrl={openExternalUrl}
        open={setupGuideOpen && showSetupGuide}
      />
    </Stack>
  );
}
