import { Alert, Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import type {
  AgentToolPackageDefinition,
  AppSummary,
  OfficialToolSummary,
  PersonalAgent,
  PersonalAgentGrantOptionConnection,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { WorkflowEditor, type AppActionCatalogState, type ProviderOption } from './WorkflowEditor';
import { WorkflowParamsForm } from './WorkflowParamsForm';
import type { WorkflowDraft } from './workflow-draft';

export interface WorkflowGraphData {
  apps: AppSummary[];
  agents: PersonalAgent[];
  toolPackages: AgentToolPackageDefinition[];
  officialTools: OfficialToolSummary[];
  connectionOptions: PersonalAgentGrantOptionConnection[];
  providerOptions: ProviderOption[];
  outputSamples: Record<string, unknown>;
  savedNodeIds: ReadonlySet<string>;
  appActionCatalogs: Record<string, AppActionCatalogState>;
  loadAppActions: (appId: string, force?: boolean) => void;
}

/** Create view: name/description/schedule inline above the graph as the star. */
export function WorkflowEditorPage({ t, draft, onDraftChange, data, busy, banner, onClearBanner, onSave, onBack }: {
  t: AppDictionary;
  draft: WorkflowDraft;
  onDraftChange: (updater: (current: WorkflowDraft) => WorkflowDraft) => void;
  data: WorkflowGraphData;
  busy: boolean;
  banner: { severity: 'success' | 'error'; message: string } | null;
  onClearBanner: () => void;
  onSave: () => void;
  onBack: () => void;
}) {
  const copy = t.sections.workflows;
  return (
    <Stack sx={{ height: '100%', minHeight: 0 }} spacing={1.5}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexShrink: 0 }}>
        <Tooltip title={copy.back}>
          <IconButton size="small" onClick={onBack}><ArrowBackRounded /></IconButton>
        </Tooltip>
        <Typography variant="h5" sx={{ flex: 1 }}>{copy.createTitle}</Typography>
        <Button variant="contained" disabled={busy} onClick={onSave}>{copy.save}</Button>
      </Stack>
      {banner ? <Alert severity={banner.severity} onClose={onClearBanner} sx={{ flexShrink: 0 }}>{banner.message}</Alert> : null}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 1, flexShrink: 0 }}>
        <WorkflowParamsForm draft={draft} onChange={onDraftChange} t={t} />
      </Paper>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <WorkflowEditor
          draft={draft}
          onDraftChange={onDraftChange}
          apps={data.apps}
          agents={data.agents}
          toolPackages={data.toolPackages}
          officialTools={data.officialTools}
          connectionOptions={data.connectionOptions}
          providerOptions={data.providerOptions}
          outputSamples={data.outputSamples}
          savedNodeIds={data.savedNodeIds}
          appActionCatalogs={data.appActionCatalogs}
          loadAppActions={data.loadAppActions}
          t={t}
        />
      </Box>
    </Stack>
  );
}
