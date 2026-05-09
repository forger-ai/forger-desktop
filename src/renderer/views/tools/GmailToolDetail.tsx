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
  errorMessage,
  showAccountHelp,
  t,
  onBack,
  onConnect,
  onDisconnect,
  onAccountHelp,
  onApprovalChange,
}: {
  description: string;
  connected: boolean;
  tool: OfficialToolSummary | null;
  toolPackage: AgentToolPackageDefinition | null;
  settings: AgentToolSettings;
  busyToolId: string | null;
  busyOfficialToolId: string | null;
  errorMessage: string | null;
  showAccountHelp: boolean;
  t: AppDictionary;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onAccountHelp: () => void;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
}) => (
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
          <GmailIcon />
          <Stack spacing={0.5}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="h6">Gmail</Typography>
              <Chip size="small" color={connected ? 'success' : 'default'} label={connected ? t.sections.tools.active : t.sections.tools.inactive} />
            </Stack>
            <Typography variant="body2" color="text.secondary">{description}</Typography>
          </Stack>
        </Stack>
        {connected ? (
          <Button color="error" variant="outlined" disabled={busyOfficialToolId === GMAIL_TOOL_ID} onClick={onDisconnect}>
            {t.sections.tools.disconnect}
          </Button>
        ) : (
          <Button variant="contained" disabled={busyOfficialToolId === GMAIL_TOOL_ID} onClick={onConnect}>
            {t.sections.tools.connectGmail}
          </Button>
        )}
      </Stack>
    </Paper>
    {errorMessage ? (
      <Alert
        severity="error"
        action={showAccountHelp ? (
          <Button color="inherit" size="small" onClick={onAccountHelp}>
            {t.sections.tools.gmailAccountRequiredHelp}
          </Button>
        ) : undefined}
      >
        {errorMessage}
      </Alert>
    ) : null}
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
