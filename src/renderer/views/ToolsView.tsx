import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Switch,
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
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import iconDark from '@renderer/assets/icon-dark.svg';
import iconLight from '@renderer/assets/icon-light.svg';

interface ToolsViewProps {
  packages: AgentToolPackageDefinition[];
  settings: AgentToolSettings;
  busyToolId: string | null;
  errorMessage: string | null;
  t: AppDictionary;
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

const packageIconSrc = (toolPackage: AgentToolPackageDefinition, mode: 'light' | 'dark'): string => {
  if (toolPackage.icon === 'forger') {
    return mode === 'dark' ? iconDark : iconLight;
  }
  return mode === 'dark' ? iconDark : iconLight;
};

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
  settings,
  busyToolId,
  errorMessage,
  t,
  onApprovalChange,
}: ToolsViewProps) {
  const theme = useTheme();
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const selectedPackage = useMemo(
    () => packages.find((toolPackage) => toolPackage.id === selectedPackageId) ?? null,
    [packages, selectedPackageId],
  );

  const renderPackageList = () => (
    <Stack spacing={1}>
      {packages.map((toolPackage) => {
        const localized = localizedPackageCopy(t, toolPackage);
        return (
          <Paper
            key={toolPackage.id}
            variant="outlined"
            onClick={() => setSelectedPackageId(toolPackage.id)}
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
                src={packageIconSrc(toolPackage, theme.palette.mode)}
                alt=""
                sx={{ width: 44, height: 44, flexShrink: 0 }}
              />
              <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="subtitle1" fontWeight={700}>
                  {localized.name}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {localized.description}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t.sections.tools.packageToolCount(toolPackage.tools.length)}
                </Typography>
              </Stack>
              <ChevronRightRounded color="action" />
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );

  const renderToolList = (toolPackage: AgentToolPackageDefinition) => {
    const localizedPackage = localizedPackageCopy(t, toolPackage);

    return (
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Button
            variant="text"
            size="small"
            startIcon={<ArrowBackRounded />}
            onClick={() => setSelectedPackageId(null)}
          >
            {t.sections.tools.backToPackages}
          </Button>
        </Stack>

        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <Box
              component="img"
              src={packageIconSrc(toolPackage, theme.palette.mode)}
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
          const localized = t.sections.tools.definitions[tool.id] ?? {
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
                    color={approvalEnabled ? 'warning' : 'success'}
                    label={approvalEnabled ? t.sections.tools.approvalOn : t.sections.tools.approvalOff}
                  />
                  <Switch
                    checked={approvalEnabled}
                    disabled={busyToolId === tool.id}
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

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.tools.title}</Typography>
        <Typography color="text.secondary">{t.sections.tools.subtitle}</Typography>
      </Stack>

      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}

      {packages.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography color="text.secondary">{t.sections.tools.empty}</Typography>
        </Paper>
      ) : selectedPackage ? (
        renderToolList(selectedPackage)
      ) : (
        renderPackageList()
      )}
    </Stack>
  );
}
