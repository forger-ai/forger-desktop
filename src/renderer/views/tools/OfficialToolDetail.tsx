import { Alert, Button, Chip, Paper, Stack, TextField, Typography } from '@mui/material';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import ExtensionRounded from '@mui/icons-material/ExtensionRounded';
import { useState } from 'react';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  OfficialToolSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { PermissionList } from './PermissionList';

export const OfficialToolDetail = ({
  tool,
  toolPackage,
  settings,
  busyToolId,
  busyOfficialToolId,
  errorMessage,
  t,
  onBack,
  onConnect,
  onDisconnect,
  onApprovalChange,
}: {
  tool: OfficialToolSummary;
  toolPackage: AgentToolPackageDefinition | null;
  settings: AgentToolSettings;
  busyToolId: string | null;
  busyOfficialToolId: string | null;
  errorMessage: string | null;
  t: AppDictionary;
  onBack: () => void;
  onConnect: (secrets?: Record<string, string>) => void;
  onDisconnect: () => void;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
}) => {
  const connected = Boolean(tool.configured);
  const manualSecrets = tool.secrets.filter((secret) => secret.manual);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  return (
    <Stack spacing={1.5}>
      <Button variant="text" size="small" startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
        {t.sections.tools.title}
      </Button>
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', md: 'center' }}
        >
          <Stack direction="row" spacing={2} alignItems="center">
            <ExtensionRounded color="primary" sx={{ width: 44, height: 44, flexShrink: 0 }} />
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h6">{tool.name}</Typography>
                <Chip size="small" color={connected ? 'success' : 'default'} label={connected ? t.sections.tools.active : t.sections.tools.inactive} />
              </Stack>
              <Typography variant="body2" color="text.secondary">{tool.description}</Typography>
            </Stack>
          </Stack>
          {connected ? (
            <Button color="error" variant="outlined" disabled={busyOfficialToolId === tool.id} onClick={onDisconnect}>
              {t.sections.tools.disconnect}
            </Button>
          ) : manualSecrets.length === 0 ? (
            <Button variant="contained" disabled={busyOfficialToolId === tool.id} onClick={() => onConnect()}>
              {t.sections.tools.activateTool}
            </Button>
          ) : null}
        </Stack>
      </Paper>
      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
      {manualSecrets.length > 0 && !connected ? (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
          <Stack spacing={1.5}>
            <Typography variant="subtitle1" fontWeight={700}>{t.sections.tools.connectorSecretsTitle}</Typography>
            <Typography variant="body2" color="text.secondary">{t.sections.tools.connectorSecretsHelp}</Typography>
            {manualSecrets.map((secret) => (
              <Stack key={secret.name} spacing={0.5}>
                <TextField
                  size="small"
                  type="password"
                  label={secret.label}
                  value={secretValues[secret.name] ?? ''}
                  onChange={(event) => setSecretValues((current) => ({ ...current, [secret.name]: event.target.value }))}
                />
                <Typography variant="caption" color="text.secondary">{secret.usage}</Typography>
              </Stack>
            ))}
            <Button
              variant="contained"
              sx={{ alignSelf: 'flex-start' }}
              disabled={busyOfficialToolId === tool.id
                || manualSecrets.some((secret) => secret.required && !(secretValues[secret.name] ?? '').trim())}
              onClick={() => onConnect(secretValues)}
            >
              {t.sections.tools.connectorSecretsConnect}
            </Button>
          </Stack>
        </Paper>
      ) : null}
      {toolPackage ? (
        <PermissionList
          tools={toolPackage.tools}
          settings={settings}
          busyToolId={busyToolId}
          t={t}
          onboardingTarget={`official-tool-permissions-${tool.id}`}
          onApprovalChange={onApprovalChange}
        />
      ) : null}
    </Stack>
  );
};
