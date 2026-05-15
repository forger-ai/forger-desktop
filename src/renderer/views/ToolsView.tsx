import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  OfficialToolSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { FORGER_PACKAGE_ID, GMAIL_PACKAGE_ID, GMAIL_TOOL_ID } from './tools/constants';
import { ForgerToolDetail } from './tools/ForgerToolDetail';
import { ForgerToolIcon, GmailIcon } from './tools/ToolIcons';
import { GmailToolDetail } from './tools/GmailToolDetail';
import { ToolRow } from './tools/ToolRow';
import { localizedPackageCopy } from './tools/tool-helpers';

interface ToolsViewProps {
  packages: AgentToolPackageDefinition[];
  settings: AgentToolSettings;
  officialTools: OfficialToolSummary[];
  busyToolId: string | null;
  busyOfficialToolId: string | null;
  errorMessage: string | null;
  errorTechnicalCode: string | null;
  t: AppDictionary;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
  onActivateOfficialTool: (toolId: string) => void;
  onConfigureOfficialTool: (toolId: string) => void;
  onDeactivateOfficialTool: (toolId: string) => void;
}

type SelectedTool = 'forger' | 'gmail' | null;

export function ToolsView({
  packages,
  settings,
  officialTools,
  busyToolId,
  busyOfficialToolId,
  errorMessage,
  errorTechnicalCode,
  t,
  onApprovalChange,
  onConfigureOfficialTool,
  onDeactivateOfficialTool,
}: ToolsViewProps) {
  const theme = useTheme();
  const [selectedTool, setSelectedTool] = useState<SelectedTool>(null);
  const [query, setQuery] = useState('');
  const [gmailAccountHelpOpen, setGmailAccountHelpOpen] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const showGmailAccountHelp = errorTechnicalCode === 'forger_account_required';
  const gmailAccountHelpDialog = (
    <Dialog open={gmailAccountHelpOpen} onClose={() => setGmailAccountHelpOpen(false)} maxWidth="sm" fullWidth>
      <DialogTitle>{t.sections.tools.gmailAccountRequiredTitle}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          {t.sections.tools.gmailAccountRequiredBody}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setGmailAccountHelpOpen(false)}>{t.actions.close}</Button>
      </DialogActions>
    </Dialog>
  );

  const forgerPackage = useMemo(
    () => packages.find((toolPackage) => toolPackage.id === FORGER_PACKAGE_ID)
      ?? packages.find((toolPackage) => toolPackage.id !== GMAIL_PACKAGE_ID)
      ?? null,
    [packages],
  );
  const gmailPackage = useMemo(
    () => packages.find((toolPackage) => toolPackage.id === GMAIL_PACKAGE_ID) ?? null,
    [packages],
  );
  const gmailTool = useMemo(
    () => officialTools.find((tool) => tool.id === GMAIL_TOOL_ID) ?? null,
    [officialTools],
  );

  const forgerCopy = forgerPackage
    ? localizedPackageCopy(t, forgerPackage)
    : t.sections.tools.packages.forger;
  const gmailDescription = gmailTool?.description
    ?? t.sections.tools.gmailDescription;
  const gmailConnected = Boolean(gmailTool?.configured);

  const visibleRows = useMemo(
    () => [
      {
        id: 'forger' as const,
        searchText: `${forgerCopy.name} ${forgerCopy.description}`,
      },
      {
        id: 'gmail' as const,
        searchText: `Gmail ${gmailDescription}`,
      },
    ].filter((row) => !normalizedQuery || row.searchText.toLowerCase().includes(normalizedQuery)),
    [forgerCopy.description, forgerCopy.name, gmailDescription, normalizedQuery],
  );

  if (selectedTool === 'forger') {
    return (
      <ForgerToolDetail
        mode={theme.palette.mode}
        title={forgerCopy.name}
        description={forgerCopy.description}
        toolPackage={forgerPackage}
        settings={settings}
        busyToolId={busyToolId}
        t={t}
        onBack={() => setSelectedTool(null)}
        onApprovalChange={onApprovalChange}
      />
    );
  }

  if (selectedTool === 'gmail') {
    return (
      <>
          <GmailToolDetail
            description={gmailDescription}
            connected={gmailConnected}
            toolPackage={gmailPackage}
          settings={settings}
          busyToolId={busyToolId}
          busyOfficialToolId={busyOfficialToolId}
          errorMessage={errorMessage}
          showAccountHelp={showGmailAccountHelp}
          t={t}
          onBack={() => setSelectedTool(null)}
          onConnect={() => onConfigureOfficialTool(GMAIL_TOOL_ID)}
          onDisconnect={() => onDeactivateOfficialTool(GMAIL_TOOL_ID)}
          onAccountHelp={() => setGmailAccountHelpOpen(true)}
          onApprovalChange={onApprovalChange}
        />
        {gmailAccountHelpDialog}
      </>
    );
  }

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.75}>
        <Typography variant="h3" fontWeight={750}>{t.sections.tools.title}</Typography>
        <Typography variant="body1" color="text.secondary">
          {t.sections.tools.subtitle}
        </Typography>
      </Stack>

      <TextField
        fullWidth
        placeholder={t.sections.tools.searchPlaceholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        inputProps={{ 'aria-label': t.sections.tools.searchPlaceholder }}
      />

      {errorMessage ? (
        <Alert
          severity="error"
          action={showGmailAccountHelp ? (
            <Button color="inherit" size="small" onClick={() => setGmailAccountHelpOpen(true)}>
              {t.sections.tools.gmailAccountRequiredHelp}
            </Button>
          ) : undefined}
        >
          {errorMessage}
        </Alert>
      ) : null}

      {gmailAccountHelpDialog}

      <Stack spacing={1}>
        {visibleRows.some((row) => row.id === 'forger') ? (
          <ToolRow
            icon={<ForgerToolIcon mode={theme.palette.mode} />}
            title={forgerCopy.name}
            description={forgerCopy.description}
            meta={forgerPackage ? t.sections.tools.packageToolCount(forgerPackage.tools.length) : t.sections.tools.builtIn}
            pill={<Chip size="small" label={t.sections.tools.builtIn} />}
            onClick={() => setSelectedTool('forger')}
          />
        ) : null}

        {visibleRows.some((row) => row.id === 'gmail') ? (
          <ToolRow
            icon={<GmailIcon />}
            title="Gmail"
            description={gmailDescription}
            meta={t.sections.tools.packageToolCount(gmailPackage?.tools.length ?? gmailTool?.actions.length ?? 4)}
            pill={(
              <Chip
                size="small"
                color={gmailConnected ? 'success' : 'default'}
                label={gmailConnected ? t.sections.tools.active : t.sections.tools.inactive}
              />
            )}
            onClick={() => setSelectedTool('gmail')}
          />
        ) : null}

        {visibleRows.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {t.sections.tools.emptySearch}
            </Typography>
          </Paper>
        ) : null}
      </Stack>
    </Stack>
  );
}
