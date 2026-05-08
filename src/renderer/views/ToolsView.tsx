import { useMemo, useState } from 'react';
import { Alert, Chip, Paper, Stack, TextField, Typography, useTheme } from '@mui/material';
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
  t,
  onApprovalChange,
  onConfigureOfficialTool,
  onDeactivateOfficialTool,
}: ToolsViewProps) {
  const theme = useTheme();
  const [selectedTool, setSelectedTool] = useState<SelectedTool>(null);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();

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
    : { name: 'Forger tools', description: 'Built-in tools included with Forger.' };
  const gmailDescription = gmailTool?.description
    ?? 'Herramienta oficial para buscar, leer y enviar correos de Gmail.';
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
      <GmailToolDetail
        description={gmailDescription}
        connected={gmailConnected}
        tool={gmailTool}
        toolPackage={gmailPackage}
        settings={settings}
        busyToolId={busyToolId}
        busyOfficialToolId={busyOfficialToolId}
        t={t}
        onBack={() => setSelectedTool(null)}
        onConnect={() => onConfigureOfficialTool(GMAIL_TOOL_ID)}
        onDisconnect={() => onDeactivateOfficialTool(GMAIL_TOOL_ID)}
        onApprovalChange={onApprovalChange}
      />
    );
  }

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.75}>
        <Typography variant="h3" fontWeight={750}>Tools</Typography>
        <Typography variant="body1" color="text.secondary">
          Manage the tools Forger can use for you.
        </Typography>
      </Stack>

      <TextField
        fullWidth
        placeholder="Buscar herramientas"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        inputProps={{ 'aria-label': 'Buscar herramientas' }}
      />

      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}

      <Stack spacing={1}>
        {visibleRows.some((row) => row.id === 'forger') ? (
          <ToolRow
            icon={<ForgerToolIcon mode={theme.palette.mode} />}
            title={forgerCopy.name}
            description={forgerCopy.description}
            meta={forgerPackage ? t.sections.tools.packageToolCount(forgerPackage.tools.length) : 'Built in'}
            pill={<Chip size="small" label="Built in" />}
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
                label={gmailConnected ? 'Activada' : 'Desactivada'}
              />
            )}
            onClick={() => setSelectedTool('gmail')}
          />
        ) : null}

        {visibleRows.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
            <Typography variant="body2" color="text.secondary">
              No hay herramientas para esta busqueda.
            </Typography>
          </Paper>
        ) : null}
      </Stack>
    </Stack>
  );
}
