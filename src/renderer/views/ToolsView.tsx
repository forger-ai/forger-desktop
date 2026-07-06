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
import ExtensionRounded from '@mui/icons-material/ExtensionRounded';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  OfficialToolRuntimeEvent,
  OfficialToolSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { FORGER_PACKAGE_ID, GMAIL_PACKAGE_ID, officialToolPackageId } from './tools/constants';
import { ForgerToolDetail } from './tools/ForgerToolDetail';
import { ForgerToolIcon } from './tools/ToolIcons';
import { OfficialToolDetail } from './tools/OfficialToolDetail';
import { ToolRow } from './tools/ToolRow';
import { localizedPackageCopy } from './tools/tool-helpers';

interface ToolsViewProps {
  packages: AgentToolPackageDefinition[];
  settings: AgentToolSettings;
  officialTools: OfficialToolSummary[];
  selectedTool: SelectedTool;
  busyToolId: string | null;
  busyOfficialToolId: string | null;
  errorMessage: string | null;
  errorTechnicalCode: string | null;
  t: AppDictionary;
  onSelectedToolChange: (tool: SelectedTool) => void;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
  onActivateOfficialTool: (toolId: string) => void;
  onConfigureOfficialTool: (toolId: string, secrets?: Record<string, string>) => void;
  onStartWhatsAppPairing: (method: 'qr' | 'pairing_code', phoneNumber?: string) => Promise<import('@shared/types').CallOfficialToolResult>;
  onGetWhatsAppStatus: () => Promise<import('@shared/types').CallOfficialToolResult>;
  onOfficialToolEvent: (listener: (event: OfficialToolRuntimeEvent) => void) => () => void;
  onDeactivateOfficialTool: (toolId: string) => void;
  onOpenConnections: () => void;
}

export type SelectedTool = string | null;

export function ToolsView({
  packages,
  settings,
  officialTools,
  selectedTool,
  busyToolId,
  busyOfficialToolId,
  errorMessage,
  errorTechnicalCode,
  t,
  onSelectedToolChange,
  onApprovalChange,
  onConfigureOfficialTool,
  onStartWhatsAppPairing,
  onGetWhatsAppStatus,
  onOfficialToolEvent,
  onDeactivateOfficialTool,
  onOpenConnections,
}: ToolsViewProps) {
  const theme = useTheme();
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
  const forgerOwnedOfficialTools = useMemo(
    () => officialTools.filter((tool) => !tool.connectionBacked && !tool.hidden),
    [officialTools],
  );
  const movedConnectionTools = useMemo(
    () => officialTools.filter((tool) => tool.connectionBacked && tool.configured),
    [officialTools],
  );
  const officialToolById = useMemo(
    () => new Map(forgerOwnedOfficialTools.map((tool) => [tool.id, tool])),
    [forgerOwnedOfficialTools],
  );

  const forgerCopy = forgerPackage
    ? localizedPackageCopy(t, forgerPackage)
    : t.sections.tools.packages.forger;
  const visibleRows = useMemo(
    () => [
      {
        id: FORGER_PACKAGE_ID,
        searchText: `${forgerCopy.name} ${forgerCopy.description}`,
      },
      ...forgerOwnedOfficialTools.map((tool) => ({
        id: tool.id,
        searchText: `${tool.name} ${tool.description}`,
      })),
    ].filter((row) => !normalizedQuery || row.searchText.toLowerCase().includes(normalizedQuery)),
    [forgerCopy.description, forgerCopy.name, normalizedQuery, forgerOwnedOfficialTools],
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
        onBack={() => onSelectedToolChange(null)}
        onApprovalChange={onApprovalChange}
      />
    );
  }

  const selectedOfficialTool = selectedTool ? officialToolById.get(selectedTool) ?? null : null;
  if (selectedTool && !selectedOfficialTool && movedConnectionTools.some((tool) => tool.id === selectedTool)) {
    return (
      <Stack spacing={2}>
        <Button variant="text" onClick={() => onSelectedToolChange(null)} sx={{ alignSelf: 'flex-start' }}>
          {t.actions.back}
        </Button>
        <Alert
          severity="info"
          action={<Button color="inherit" size="small" onClick={onOpenConnections}>{t.sections.tools.openConnections}</Button>}
        >
          <Typography fontWeight={700}>{t.sections.tools.movedToConnectionsTitle}</Typography>
          <Typography variant="body2">{t.sections.tools.movedToConnectionsBody}</Typography>
        </Alert>
      </Stack>
    );
  }
  if (selectedOfficialTool) {
    const selectedOfficialPackage = packages.find((toolPackage) => toolPackage.id === officialToolPackageId(selectedOfficialTool.id)) ?? null;
    return (
      <OfficialToolDetail
        tool={selectedOfficialTool}
        toolPackage={selectedOfficialPackage}
        settings={settings}
        busyToolId={busyToolId}
        busyOfficialToolId={busyOfficialToolId}
        errorMessage={errorMessage}
        t={t}
        onBack={() => onSelectedToolChange(null)}
        onConnect={(secrets) => onConfigureOfficialTool(selectedOfficialTool.id, secrets)}
        onDisconnect={() => onDeactivateOfficialTool(selectedOfficialTool.id)}
        onStartWhatsAppPairing={selectedOfficialTool.id === 'whatsapp' ? onStartWhatsAppPairing : undefined}
        onGetWhatsAppStatus={selectedOfficialTool.id === 'whatsapp' ? onGetWhatsAppStatus : undefined}
        onOfficialToolEvent={selectedOfficialTool.id === 'whatsapp' ? onOfficialToolEvent : undefined}
        onApprovalChange={onApprovalChange}
      />
    );
  }

  return (
    <Stack spacing={2.5} data-onboarding-target="tools-list">
      <Stack spacing={0.75}>
        <Typography variant="h3" fontWeight={750}>{t.sections.tools.title}</Typography>
        <Typography variant="body1" color="text.secondary">
          {t.sections.tools.subtitle}
        </Typography>
      </Stack>

      <TextField
        fullWidth
        data-onboarding-target="tools-search"
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

      {movedConnectionTools.length > 0 ? (
        <Alert
          severity="info"
          action={<Button color="inherit" size="small" onClick={onOpenConnections}>{t.sections.tools.openConnections}</Button>}
        >
          <Typography fontWeight={700}>{t.sections.tools.movedToConnectionsTitle}</Typography>
          <Typography variant="body2">{t.sections.tools.movedToConnectionsBody}</Typography>
        </Alert>
      ) : null}

      <Stack spacing={1}>
        {visibleRows.some((row) => row.id === 'forger') ? (
          <ToolRow
            icon={<ForgerToolIcon mode={theme.palette.mode} />}
            title={forgerCopy.name}
            description={forgerCopy.description}
            meta={forgerPackage ? t.sections.tools.packageToolCount(forgerPackage.tools.length) : t.sections.tools.builtIn}
            pill={<Chip size="small" label={t.sections.tools.builtIn} />}
            onboardingTarget="tool-row-forger"
            onClick={() => onSelectedToolChange('forger')}
          />
        ) : null}

        {forgerOwnedOfficialTools.filter((tool) => visibleRows.some((row) => row.id === tool.id)).map((tool) => {
          const toolPackage = packages.find((candidate) => candidate.id === officialToolPackageId(tool.id));
          return (
            <ToolRow
              key={tool.id}
              icon={<ExtensionRounded color="primary" sx={{ width: 44, height: 44, flexShrink: 0 }} />}
              title={tool.name}
              description={tool.description}
              meta={t.sections.tools.packageToolCount(toolPackage?.tools.length ?? tool.actions.length)}
              pill={(
                <Chip
                  size="small"
                  color={tool.configured ? 'success' : 'default'}
                  label={tool.configured ? t.sections.tools.active : t.sections.tools.inactive}
                />
              )}
              onboardingTarget={`tool-row-${tool.id}`}
              onClick={() => onSelectedToolChange(tool.id)}
            />
          );
        })}

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
