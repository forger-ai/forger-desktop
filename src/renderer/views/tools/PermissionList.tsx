import { Chip, Paper, Stack, Switch, Typography } from '@mui/material';
import type {
  AgentToolDefinition,
  AgentToolSettings,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { localizedToolCopy, requiresApproval, riskColor } from './tool-helpers';

export const PermissionList = ({
  tools,
  settings,
  busyToolId,
  t,
  onboardingTarget,
  onApprovalChange,
}: {
  tools: AgentToolDefinition[];
  settings: AgentToolSettings;
  busyToolId: string | null;
  t: AppDictionary;
  onboardingTarget?: string;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
}) => (
  <Stack spacing={1} data-onboarding-target={onboardingTarget}>
    {tools.map((tool) => {
      const localized = localizedToolCopy(t, tool);
      const approvalEnabled = requiresApproval(settings.approvals, tool);
      return (
        <Paper
          key={tool.id}
          variant="outlined"
          data-onboarding-target={`tool-permission-${tool.id}`}
          sx={{ p: 2, borderRadius: 1 }}
        >
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={2}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', md: 'center' }}
          >
            <Stack spacing={0.75} sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1" fontWeight={650}>{localized.name}</Typography>
              <Typography variant="body2" color="text.secondary">{localized.description}</Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip size="small" label={`${t.sections.tools.categoryLabel}: ${t.sections.tools.categories[tool.category]}`} />
                <Chip
                  size="small"
                  color={riskColor(tool.risk)}
                  variant="outlined"
                  label={`${t.sections.tools.riskLabel}: ${t.sections.tools.risks[tool.risk]}`}
                />
              </Stack>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
              <Chip
                size="small"
                color={approvalEnabled ? 'warning' : 'success'}
                label={approvalEnabled ? t.sections.tools.approvalOn : t.sections.tools.approvalOff}
              />
              <Switch
                checked={approvalEnabled}
                disabled={busyToolId === tool.id}
                onChange={(event) => onApprovalChange(tool.id, event.target.checked)}
                slotProps={{ input: { 'aria-label': t.sections.tools.approvalToggleLabel } }}
              />
            </Stack>
          </Stack>
        </Paper>
      );
    })}
  </Stack>
);
