import BackupRounded from '@mui/icons-material/BackupRounded';
import DeleteRounded from '@mui/icons-material/DeleteRounded';
import RestoreRounded from '@mui/icons-material/RestoreRounded';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMemo, useState } from 'react';
import type { AppBackupReason, AppBackupSummary, AppSummary } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface BackupsViewProps {
  backups: AppBackupSummary[];
  apps: AppSummary[];
  busy: boolean;
  t: AppDictionary;
  onCreateBackup: (appId: string) => void;
  onDeleteBackup: (backup: AppBackupSummary) => void;
  onRestoreBackup: (backup: AppBackupSummary) => void;
}

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unitIndex === 0 ? 0 : 1 })} ${units[unitIndex]}`;
};

export function BackupsView({
  backups,
  apps,
  busy,
  t,
  onCreateBackup,
  onDeleteBackup,
  onRestoreBackup,
}: BackupsViewProps) {
  const backupApps = useMemo(
    () => apps.filter((app) => app.status === 'installed' || app.status === 'running' || app.status === 'error' || app.status === 'conflict'),
    [apps],
  );
  const [selectedAppId, setSelectedAppId] = useState(backupApps[0]?.id ?? '');
  const activeAppId = backupApps.some((app) => app.id === selectedAppId)
    ? selectedAppId
    : backupApps[0]?.id || '';
  const labels = t.sections.backups;
  const reasonLabels: Record<AppBackupReason, string> = labels.reasonLabels;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        justifyContent="space-between"
      >
        <Box>
          <Typography variant="h4">{labels.title}</Typography>
          <Typography color="text.secondary">{labels.subtitle}</Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} alignItems={{ xs: 'stretch', sm: 'center' }}>
          {backupApps.length > 1 ? (
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel>{labels.appLabel}</InputLabel>
              <Select
                value={activeAppId}
                label={labels.appLabel}
                onChange={(event) => setSelectedAppId(event.target.value)}
              >
                {backupApps.map((app) => (
                  <MenuItem key={app.id} value={app.id}>
                    {app.name ?? app.id}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}
          <Button
            variant="contained"
            startIcon={<BackupRounded />}
            disabled={busy || !activeAppId}
            onClick={() => onCreateBackup(activeAppId)}
          >
            {labels.create}
          </Button>
        </Stack>
      </Stack>

      {backupApps.length === 0 ? (
        <Alert severity="info">{labels.noApps}</Alert>
      ) : null}

      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{labels.app}</TableCell>
              <TableCell>{labels.version}</TableCell>
              <TableCell>{labels.createdAt}</TableCell>
              <TableCell>{labels.reason}</TableCell>
              <TableCell align="right">{labels.files}</TableCell>
              <TableCell align="right">{labels.size}</TableCell>
              <TableCell align="right">{labels.actions}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {backups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography color="text.secondary">{labels.empty}</Typography>
                </TableCell>
              </TableRow>
            ) : backups.map((backup) => {
              const app = apps.find((candidate) => candidate.id === backup.appId);
              const isRunning = app?.status === 'running';
              return (
                <TableRow key={`${backup.appId}:${backup.backupId}`} hover>
                  <TableCell>{backup.appName || app?.name || backup.appId}</TableCell>
                  <TableCell>{backup.appVersion || '-'}</TableCell>
                  <TableCell>{new Date(backup.createdAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined" label={reasonLabels[backup.reason] ?? backup.reason} />
                  </TableCell>
                  <TableCell align="right">{backup.fileCount.toLocaleString()}</TableCell>
                  <TableCell align="right">{formatBytes(backup.totalBytes)}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      <Tooltip title={isRunning ? labels.stopBeforeRestore : labels.restore}>
                        <span>
                          <IconButton
                            size="small"
                            disabled={busy || isRunning}
                            onClick={() => onRestoreBackup(backup)}
                            aria-label={labels.restore}
                          >
                            <RestoreRounded fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={labels.delete}>
                        <span>
                          <IconButton
                            size="small"
                            disabled={busy}
                            onClick={() => onDeleteBackup(backup)}
                            aria-label={labels.delete}
                          >
                            <DeleteRounded fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
