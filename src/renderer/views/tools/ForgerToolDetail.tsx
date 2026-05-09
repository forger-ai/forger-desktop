import { Button, Chip, Paper, Stack, Typography } from '@mui/material';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { ForgerToolIcon } from './ToolIcons';
import { PermissionList } from './PermissionList';

export const ForgerToolDetail = ({
  mode,
  title,
  description,
  toolPackage,
  settings,
  busyToolId,
  t,
  onBack,
  onApprovalChange,
}: {
  mode: 'light' | 'dark';
  title: string;
  description: string;
  toolPackage: AgentToolPackageDefinition | null;
  settings: AgentToolSettings;
  busyToolId: string | null;
  t: AppDictionary;
  onBack: () => void;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
}) => (
  <Stack spacing={1.5}>
    <Button variant="text" size="small" startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
      {t.sections.tools.title}
    </Button>
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Stack direction="row" spacing={2} alignItems="center">
        <ForgerToolIcon mode={mode} size={48} />
        <Stack spacing={0.5}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h6">{title}</Typography>
            <Chip size="small" color="default" label={t.sections.tools.builtIn} />
          </Stack>
          <Typography variant="body2" color="text.secondary">{description}</Typography>
        </Stack>
      </Stack>
    </Paper>
    {toolPackage ? (
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
