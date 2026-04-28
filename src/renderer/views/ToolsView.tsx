import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';
import type {
  AgentToolApprovalSettings,
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  AppSecretsState,
  OfficialToolSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import iconDark from '@renderer/assets/icon-dark.svg';
import iconLight from '@renderer/assets/icon-light.svg';

interface ToolsViewProps {
  packages: AgentToolPackageDefinition[];
  officialTools: OfficialToolSummary[];
  settings: AgentToolSettings;
  busyToolId: string | null;
  busyOfficialToolId: string | null;
  secretsByToolId: Record<string, AppSecretsState>;
  errorMessage: string | null;
  t: AppDictionary;
  onInstallOfficialTool: (toolId: string) => void;
  onLoadOfficialToolSecrets: (toolId: string) => void;
  onConnectOfficialToolSecret: (toolId: string, secretName: string, userSecretId: string) => void;
  onDisconnectOfficialToolSecret: (toolId: string, secretName: string) => void;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
}

const riskColor = (risk: AgentToolDefinition['risk']) => {
  if (risk === 'alto') return 'error';
  if (risk === 'medio') return 'warning';
  return 'success';
};

const requiresApproval = (
  approvals: Partial<AgentToolApprovalSettings>,
  tool: AgentToolDefinition,
): boolean => approvals[tool.id] ?? tool.defaultRequiresApproval;

const packageIconSrc = (_mode: 'light' | 'dark'): string => (_mode === 'dark' ? iconDark : iconLight);

const localizedPackageCopy = (
  t: AppDictionary,
  toolPackage: AgentToolPackageDefinition,
): { name: string; description: string } => {
  const packages = t.sections.tools.packages as Record<string, { name: string; description: string }>;
  return packages[toolPackage.id] ?? {
    name: toolPackage.name,
    description: toolPackage.description,
  };
};

export function ToolsView({
  packages,
  officialTools,
  settings,
  busyToolId,
  busyOfficialToolId,
  secretsByToolId,
  errorMessage,
  t,
  onInstallOfficialTool,
  onLoadOfficialToolSecrets,
  onConnectOfficialToolSecret,
  onDisconnectOfficialToolSecret,
  onApprovalChange,
}: ToolsViewProps) {
  const theme = useTheme();
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const selectedOfficialTool = useMemo(
    () => officialTools.find((tool) => tool.id === selectedToolId) ?? null,
    [officialTools, selectedToolId],
  );
  const selectedPackage = useMemo(
    () => packages.find((toolPackage) => toolPackage.id === selectedToolId) ?? null,
    [packages, selectedToolId],
  );
  const filteredTools = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return officialTools;
    }
    return officialTools.filter((tool) =>
      [tool.name, tool.description, tool.status, tool.runtime].join(' ').toLowerCase().includes(normalized),
    );
  }, [officialTools, query]);

  useEffect(() => {
    if (selectedOfficialTool?.status === 'installed' && !secretsByToolId[selectedOfficialTool.id]) {
      onLoadOfficialToolSecrets(selectedOfficialTool.id);
    }
  }, [onLoadOfficialToolSecrets, secretsByToolId, selectedOfficialTool]);

  const renderPackageList = () => (
    <Stack spacing={1}>
      {filteredTools.map((tool) => {
        const agentPackage = packages.find((candidate) => candidate.id === tool.id);
        return (
          <Paper
            key={tool.id}
            variant="outlined"
            onClick={() => setSelectedToolId(tool.id)}
            sx={{
              p: 2,
              borderRadius: 1,
              cursor: 'pointer',
              '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
            }}
          >
            <Stack direction="row" spacing={2} alignItems="center">
              <Box
                component="img"
                src={packageIconSrc(theme.palette.mode)}
                alt=""
                sx={{ width: 44, height: 44, flexShrink: 0 }}
              />
              <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="subtitle1" fontWeight={700}>
                  {tool.name}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {tool.description}
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Chip size="small" label={t.sections.tools.statuses[tool.status]} />
                  <Chip size="small" variant="outlined" label={t.sections.tools.runtimeLabel(tool.runtime)} />
                  <Typography variant="caption" color="text.secondary">
                    {t.sections.tools.packageToolCount(agentPackage?.tools.length ?? tool.actions.length)}
                  </Typography>
                </Stack>
              </Stack>
              <ChevronRightRounded color="action" />
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );

  const renderSecretConnections = (tool: OfficialToolSummary) => {
    if (tool.status !== 'installed') {
      return null;
    }
    const state = secretsByToolId[tool.id];
    if (!state || state.appSecrets.length === 0) {
      return null;
    }

    return (
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">{t.sections.tools.secretsTitle}</Typography>
          {state.appSecrets.map((connection) => (
            <Stack
              key={connection.appSecret.name}
              direction={{ xs: 'column', md: 'row' }}
              spacing={1.5}
              alignItems={{ xs: 'stretch', md: 'center' }}
              justifyContent="space-between"
            >
              <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={650}>
                  {connection.appSecret.label ?? connection.appSecret.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {connection.appSecret.usage}
                </Typography>
              </Stack>
              <FormControl size="small" sx={{ minWidth: 260 }}>
                <InputLabel>{t.sections.tools.secretSelectLabel}</InputLabel>
                <Select
                  value={connection.userSecretId ?? ''}
                  label={t.sections.tools.secretSelectLabel}
                  disabled={busyOfficialToolId === tool.id}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value) {
                      onConnectOfficialToolSecret(tool.id, connection.appSecret.name, value);
                    } else {
                      onDisconnectOfficialToolSecret(tool.id, connection.appSecret.name);
                    }
                  }}
                >
                  <MenuItem value="">{t.sections.tools.secretNotConnected}</MenuItem>
                  {state.userSecrets.map((secret) => (
                    <MenuItem key={secret.id} value={secret.id}>
                      {secret.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
          ))}
        </Stack>
      </Paper>
    );
  };

  const renderAgentTools = (toolPackage: AgentToolPackageDefinition, integrated: boolean) => {
    const localizedPackage = localizedPackageCopy(t, toolPackage);
    return (
      <Stack spacing={1.5}>
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <Box
              component="img"
              src={packageIconSrc(theme.palette.mode)}
              alt=""
              sx={{ width: 48, height: 48, flexShrink: 0 }}
            />
            <Stack spacing={0.5}>
              <Typography variant="h6">{localizedPackage.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {localizedPackage.description}
              </Typography>
            </Stack>
          </Stack>
        </Paper>

        {toolPackage.tools.map((tool) => {
          const definitions = t.sections.tools.definitions as Record<string, { name: string; description: string }>;
          const localized = definitions[tool.id] ?? {
            name: tool.name,
            description: tool.description,
          };
          const approvalEnabled = requiresApproval(settings.approvals, tool);
          return (
            <Paper key={tool.id} variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                spacing={2}
                justifyContent="space-between"
                alignItems={{ xs: 'flex-start', md: 'flex-start' }}
              >
                <Stack spacing={0.75} sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle1" fontWeight={650}>
                    {localized.name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {localized.description}
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Chip
                      size="small"
                      label={`${t.sections.tools.categoryLabel}: ${t.sections.tools.categories[tool.category]}`}
                    />
                    <Chip
                      size="small"
                      color={riskColor(tool.risk)}
                      variant="outlined"
                      label={`${t.sections.tools.riskLabel}: ${t.sections.tools.risks[tool.risk]}`}
                    />
                  </Stack>
                </Stack>

                <Stack spacing={0.75} alignItems={{ xs: 'flex-start', md: 'flex-end' }} sx={{ flexShrink: 0 }}>
                  <Chip
                    size="small"
                    color={integrated ? 'success' : approvalEnabled ? 'warning' : 'success'}
                    label={integrated ? t.sections.tools.integratedLocked : approvalEnabled ? t.sections.tools.approvalOn : t.sections.tools.approvalOff}
                  />
                  <Switch
                    checked={approvalEnabled}
                    disabled={integrated || busyToolId === tool.id}
                    onChange={(event) => onApprovalChange(tool.id, event.target.checked)}
                    inputProps={{ 'aria-label': t.sections.tools.approvalToggleLabel }}
                  />
                </Stack>
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    );
  };

  const renderToolDetails = (tool: OfficialToolSummary) => {
    const agentPackage = selectedPackage;
    return (
      <Stack spacing={1.5}>
        <Button
          variant="text"
          size="small"
          startIcon={<ArrowBackRounded />}
          onClick={() => setSelectedToolId(null)}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t.sections.tools.backToPackages}
        </Button>

        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ xs: 'flex-start', md: 'center' }}>
            <Box
              component="img"
              src={packageIconSrc(theme.palette.mode)}
              alt=""
              sx={{ width: 48, height: 48, flexShrink: 0 }}
            />
            <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h6">{tool.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {tool.description}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip size="small" label={t.sections.tools.statuses[tool.status]} />
                <Chip size="small" variant="outlined" label={t.sections.tools.runtimeLabel(tool.runtime)} />
              </Stack>
            </Stack>
            {tool.status === 'available' ? (
              <Button
                variant="contained"
                disabled={busyOfficialToolId === tool.id}
                onClick={() => onInstallOfficialTool(tool.id)}
              >
                {busyOfficialToolId === tool.id ? t.sections.tools.installing : t.sections.tools.install}
              </Button>
            ) : null}
            {tool.status === 'integrated' ? <Chip color="success" label={t.sections.tools.integratedLocked} /> : null}
          </Stack>
        </Paper>

        {tool.documentation ? (
          <Alert severity={tool.technicalBlocker ? 'warning' : 'info'}>{tool.documentation}</Alert>
        ) : null}

        {renderSecretConnections(tool)}

        {agentPackage ? renderAgentTools(agentPackage, tool.status === 'integrated') : (
          <Stack spacing={1}>
            <Typography variant="subtitle2">{t.sections.tools.actionsTitle}</Typography>
            {tool.actions.map((action) => (
              <Paper key={action.id} variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
                <Stack spacing={0.75}>
                  <Typography variant="subtitle1" fontWeight={650}>
                    {action.name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {action.description}
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Chip
                      size="small"
                      label={`${t.sections.tools.categoryLabel}: ${t.sections.tools.categories[action.category]}`}
                    />
                    <Chip
                      size="small"
                      color={riskColor(action.risk)}
                      variant="outlined"
                      label={`${t.sections.tools.riskLabel}: ${t.sections.tools.risks[action.risk]}`}
                    />
                  </Stack>
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>
    );
  };

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.tools.title}</Typography>
        <Typography color="text.secondary">{t.sections.tools.subtitle}</Typography>
      </Stack>

      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}

      <TextField
        size="small"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t.sections.tools.searchPlaceholder}
      />

      {officialTools.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography color="text.secondary">{t.sections.tools.empty}</Typography>
        </Paper>
      ) : selectedOfficialTool ? (
        renderToolDetails(selectedOfficialTool)
      ) : (
        renderPackageList()
      )}
    </Stack>
  );
}
