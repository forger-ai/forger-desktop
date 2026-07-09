import type { Dispatch, SetStateAction } from 'react';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type {
  AgentEffort,
  AgentProvider,
  AgentRuntime,
  AgentToolId,
  PersonalAgentConnectionGrant,
  PersonalAgentGrantOptionApp,
  PersonalAgentGrantOptionConnection,
  PersonalAgentGrantOptionTool,
  PersonalAgentGrantOptions,
} from '@shared/types';
import { getRuntimeSupportedEfforts, normalizeRuntimeEffortForModel } from '@shared/agent-runtime-registry';
import type { AppDictionary } from '@renderer/i18n';
import {
  ANTIGRAVITY_EFFORT_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
} from '@renderer/preferences';
import type { AccessDraft } from './AgentsView.helpers';
import {
  connectionInstanceLabel,
  defaultRuntimeForProvider,
  toggleId,
} from './AgentsView.helpers';

interface AgentAccessControlsProps {
  activeAgentId?: string | null;
  draft: AccessDraft;
  grantOptions: PersonalAgentGrantOptions;
  providerOptions: Array<{ label: string; value: AgentProvider | 'auto' }>;
  setDraft: Dispatch<SetStateAction<AccessDraft>>;
  t: AppDictionary;
}

export function AgentAccessControls({
  activeAgentId,
  draft,
  grantOptions,
  providerOptions,
  setDraft,
  t,
}: AgentAccessControlsProps) {
  const runtimeProvider = draft.runtime.provider;
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
  ).filter((option) => getRuntimeSupportedEfforts(runtimeProvider, draft.runtime.model).includes(option.value as AgentEffort));
  const runtimeModelValue = runtimeModelOptions.some((option) => option.realModelName === draft.runtime.model)
    ? draft.runtime.model
    : runtimeModelOptions[0]?.realModelName ?? draft.runtime.model;
  const runtimeEffortValue = normalizeRuntimeEffortForModel(runtimeProvider, draft.runtime.model, draft.runtime.effort);
  const peerOptions = grantOptions.peerAgents.filter((peer) => peer.agentId !== activeAgentId);

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
              setDraft((current) => ({
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
              setDraft((current) => ({
                ...current,
                runtime: {
                  ...current.runtime,
                  model,
                  effort: normalizeRuntimeEffortForModel(current.runtime.provider, model, current.runtime.effort),
                },
              }));
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
              setDraft((current) => ({
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
            value={draft.permissionMode}
            onChange={(event) => {
              setDraft((current) => ({
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
            checked={draft.networkAccess}
            onChange={(event) => setDraft((current) => ({ ...current, networkAccess: event.target.checked }))}
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
                    checked={draft.appIds.includes(app.appId)}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        appIds: toggleId(current.appIds, app.appId, event.target.checked),
                      }));
                    }}
                  />
                )}
                label={renderAppAccessLabel(app, t)}
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
              <ToolAccessControl key={tool.id} draft={draft} setDraft={setDraft} t={t} tool={tool} />
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">{t.agents.noToolsAvailable}</Typography>
        )}
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{t.agents.connectionsAccess}</Typography>
        {grantOptions.connections.some((connection) => connection.actions.length > 0) ? (
          <Stack spacing={1}>
            {grantOptions.connections.map((connection) => (
              <ConnectionAccessControl
                key={connection.type}
                connection={connection}
                draft={draft}
                setDraft={setDraft}
                t={t}
              />
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">{t.agents.noConnectionsAvailable}</Typography>
        )}
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
          {t.locale === 'es' ? 'Agentes permitidos' : 'Allowed agents'}
        </Typography>
        {peerOptions.length > 0 ? (
          <Stack spacing={1}>
            {peerOptions.map((peer) => {
              const grant = draft.peerAgentGrants.find((item) => item.agentId === peer.agentId);
              return (
                <Paper key={peer.agentId} variant="outlined" sx={{ p: 1.25, borderRadius: 1 }}>
                  <Stack spacing={1}>
                    <FormControlLabel
                      control={(
                        <Checkbox
                          checked={Boolean(grant)}
                          onChange={(event) => {
                            setDraft((current) => ({
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
                          setDraft((current) => ({
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
}

function ToolAccessControl({
  draft,
  setDraft,
  t,
  tool,
}: {
  draft: AccessDraft;
  setDraft: Dispatch<SetStateAction<AccessDraft>>;
  t: AppDictionary;
  tool: PersonalAgentGrantOptionTool;
}) {
  const actionIds = tool.actions.map((action) => action.id);
  const selectedCount = actionIds.filter((id) => draft.toolIds.includes(id)).length;
  const allSelected = actionIds.length > 0 && selectedCount === actionIds.length;
  const partiallySelected = selectedCount > 0 && selectedCount < actionIds.length;
  const setToolChecked = (checked: boolean) => {
    setDraft((current) => ({
      ...current,
      toolIds: checked
        ? [...new Set([...current.toolIds, ...actionIds])]
        : current.toolIds.filter((id) => !actionIds.includes(id)),
    }));
  };

  return (
    <Accordion disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
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
                  checked={draft.toolIds.includes(action.id)}
                  disabled={!tool.configured}
                  onChange={(event) => {
                    setDraft((current) => ({
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
}

function ConnectionAccessControl({
  connection,
  draft,
  setDraft,
  t,
}: {
  connection: PersonalAgentGrantOptionConnection;
  draft: AccessDraft;
  setDraft: Dispatch<SetStateAction<AccessDraft>>;
  t: AppDictionary;
}) {
  const actionIds = connection.actions.map((action) => action.id as AgentToolId);
  const grant = draft.connectionGrants.find((item) => item.type === connection.type);
  const selectedActionIds = grant?.actions ?? [];
  const selectedCount = actionIds.filter((id) => selectedActionIds.includes(id)).length;
  const allSelected = actionIds.length > 0 && selectedCount === actionIds.length;
  const partiallySelected = selectedCount > 0 && selectedCount < actionIds.length;
  const selectedConnectionIds = grant?.connectionIds ?? [];
  const upsertConnectionGrant = (nextGrant: PersonalAgentConnectionGrant | null) => {
    setDraft((current) => ({
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
    <Accordion disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
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
}

function renderAppAccessLabel(app: PersonalAgentGrantOptionApp, t: AppDictionary) {
  const metadata = [
    app.description,
    appStatusLabel(app.status, t),
    app.appId,
  ].filter((item): item is string => Boolean(item));
  return (
    <Stack spacing={0.1} sx={{ minWidth: 0, py: 0.25 }}>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{app.name || app.appId}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {metadata.join(' · ')}
      </Typography>
    </Stack>
  );
}

function appStatusLabel(status: PersonalAgentGrantOptionApp['status'], t: AppDictionary): string | undefined {
  switch (status) {
    case 'installed':
      return t.actions.installed;
    case 'running':
      return t.actions.running;
    case 'installing':
      return t.actions.installing;
    case 'error':
      return t.actions.error;
    case 'conflict':
      return t.actions.conflict;
    case 'not_installed':
      return t.actions.available;
    default:
      return undefined;
  }
}
