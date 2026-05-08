import { Alert, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  OfficialToolSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { GMAIL_TOOL_ID } from './constants';
import { GmailIcon } from './ToolIcons';
import { PermissionList } from './PermissionList';

export const GmailToolDetail = ({
  description,
  connected,
  tool,
  toolPackage,
  settings,
  busyToolId,
  busyOfficialToolId,
  t,
  onBack,
  onConnect,
  onDisconnect,
  onApprovalChange,
}: {
  description: string;
  connected: boolean;
  tool: OfficialToolSummary | null;
  toolPackage: AgentToolPackageDefinition | null;
  settings: AgentToolSettings;
  busyToolId: string | null;
  busyOfficialToolId: string | null;
  t: AppDictionary;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
}) => (
  <Stack spacing={1.5}>
    <Button variant="text" size="small" startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
      Tools
    </Button>
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', md: 'center' }}
      >
        <Stack direction="row" spacing={2} alignItems="center">
          <GmailIcon />
          <Stack spacing={0.5}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="h6">Gmail</Typography>
              <Chip size="small" color={connected ? 'success' : 'default'} label={connected ? 'Activada' : 'Desactivada'} />
            </Stack>
            <Typography variant="body2" color="text.secondary">{description}</Typography>
          </Stack>
        </Stack>
        {connected ? (
          <Button color="error" variant="outlined" disabled={busyOfficialToolId === GMAIL_TOOL_ID} onClick={onDisconnect}>
            Desconectar
          </Button>
        ) : (
          <Button variant="contained" disabled={busyOfficialToolId === GMAIL_TOOL_ID} onClick={onConnect}>
            Conectar Gmail
          </Button>
        )}
      </Stack>
      {tool?.error ? <Alert severity="warning" sx={{ mt: 2 }}>{tool.error}</Alert> : null}
    </Paper>
    {connected && toolPackage ? (
      <PermissionList
        tools={toolPackage.tools}
        settings={settings}
        busyToolId={busyToolId}
        t={t}
        onApprovalChange={onApprovalChange}
      />
    ) : null}
  </Stack>
);
