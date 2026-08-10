import BackupRounded from '@mui/icons-material/BackupRounded';
import CloudDownloadRounded from '@mui/icons-material/CloudDownloadRounded';
import CloudUploadRounded from '@mui/icons-material/CloudUploadRounded';
import DeleteRounded from '@mui/icons-material/DeleteRounded';
import RestoreRounded from '@mui/icons-material/RestoreRounded';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import type {
  AppBackupReason,
  AppBackupSummary,
  AppSummary,
  CloudSyncSettings,
  ForgerAccountSession,
  RemoteAppBackupSummary,
  RemoteBackupsUsage,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface BackupsViewProps {
  backups: AppBackupSummary[];
  remoteBackups: RemoteAppBackupSummary[];
  remoteBackupsUsage: RemoteBackupsUsage;
  apps: AppSummary[];
  account: ForgerAccountSession;
  cloudSyncSettings: CloudSyncSettings;
  busy: boolean;
  t: AppDictionary;
  onCreateBackup: (appId: string) => void;
  onSyncNow: (appId: string) => void;
  onDeleteBackup: (backup: AppBackupSummary) => void;
  onDeleteSelectedBackups: (backups: AppBackupSummary[]) => boolean | Promise<boolean>;
  onDeleteRemoteBackup: (backup: RemoteAppBackupSummary) => void;
  onRestoreBackup: (backup: AppBackupSummary) => void;
  onRestoreRemoteBackup: (backup: RemoteAppBackupSummary) => void;
  onSetAutoSync: (appId: string, autoSync: boolean) => void;
  onRequireCloud: () => void;
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
  remoteBackups,
  remoteBackupsUsage,
  apps,
  account,
  cloudSyncSettings,
  busy,
  t,
  onCreateBackup,
  onSyncNow,
  onDeleteBackup,
  onDeleteSelectedBackups,
  onDeleteRemoteBackup,
  onRestoreBackup,
  onRestoreRemoteBackup,
  onSetAutoSync,
  onRequireCloud,
}: BackupsViewProps) {
  const backupApps = useMemo(
    () => apps.filter((app) => app.status === 'installed' || app.status === 'running' || app.status === 'error' || app.status === 'conflict'),
    [apps],
  );
  const [localAppId, setLocalAppId] = useState(backupApps[0]?.id ?? '');
  const [cloudAppId, setCloudAppId] = useState(backupApps[0]?.id ?? '');
  const [activeTab, setActiveTab] = useState<'local' | 'cloud'>('local');
  const [selectedLocalBackupKeys, setSelectedLocalBackupKeys] = useState<Set<string>>(() => new Set());
  const activeLocalAppId = backupApps.some((app) => app.id === localAppId)
    ? localAppId
    : backupApps[0]?.id || '';
  const activeCloudAppId = backupApps.some((app) => app.id === cloudAppId)
    ? cloudAppId
    : backupApps[0]?.id || '';
  const labels = t.sections.backups;
  const reasonLabels: Record<AppBackupReason, string> = labels.reasonLabels;
  const cloudAllowed = Boolean(account.authenticated);
  const activeAutoSync = Boolean(activeCloudAppId && cloudSyncSettings.appSync[activeCloudAppId]?.autoSync);
  const usagePercent = remoteBackupsUsage.limitBytes > 0
    ? Math.min(100, (remoteBackupsUsage.usedBytes / remoteBackupsUsage.limitBytes) * 100)
    : 0;
  const localAppBackups = backups.filter((backup) => backup.appId === activeLocalAppId);
  const cloudAppBackups = remoteBackups.filter((backup) => backup.appId === activeCloudAppId);
  const backupKey = (backup: AppBackupSummary) => `${backup.appId}:${backup.backupId}`;
  const selectedLocalBackups = localAppBackups.filter((backup) => selectedLocalBackupKeys.has(backupKey(backup)));
  const selectedLocalSize = selectedLocalBackups.reduce((sum, backup) => sum + backup.totalBytes, 0);
  const selectedLocalCount = selectedLocalBackups.length;
  const allLocalSelected = localAppBackups.length > 0 && selectedLocalCount === localAppBackups.length;
  const someLocalSelected = selectedLocalCount > 0 && !allLocalSelected;
  const oldAutomaticLocalBackups = useMemo(() => {
    const automaticBackupsByApp = new Map<string, AppBackupSummary[]>();
    for (const backup of localAppBackups) {
      if (backup.reason !== 'update' && backup.reason !== 'pre_restore') {
        continue;
      }
      const appBackups = automaticBackupsByApp.get(backup.appId) ?? [];
      appBackups.push(backup);
      automaticBackupsByApp.set(backup.appId, appBackups);
    }

    const oldAutomaticBackups: AppBackupSummary[] = [];
    for (const appBackups of automaticBackupsByApp.values()) {
      const sorted = [...appBackups].sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      });
      oldAutomaticBackups.push(...sorted.slice(2));
    }
    return oldAutomaticBackups;
  }, [localAppBackups]);
  const latestLocalBackup = localAppBackups[0];
  const latestCloudBackup = cloudAppBackups[0];
  const cloudApp = apps.find((app) => app.id === activeCloudAppId);
  const cloudAppRunning = cloudApp?.status === 'running';
  useEffect(() => {
    setSelectedLocalBackupKeys(new Set());
  }, [activeLocalAppId]);
  const runCloudAction = (action: () => void) => {
    if (!cloudAllowed) {
      onRequireCloud();
      return;
    }
    action();
  };
  const setLocalSelection = (backupsToSelect: AppBackupSummary[]) => {
    setSelectedLocalBackupKeys(new Set(backupsToSelect.map(backupKey)));
  };
  const toggleLocalBackup = (backup: AppBackupSummary, checked: boolean) => {
    setSelectedLocalBackupKeys((current) => {
      const next = new Set(current);
      const key = backupKey(backup);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };
  const selectOldAutomaticBackups = () => {
    setLocalSelection(oldAutomaticLocalBackups);
  };
  const handleDeleteSelectedLocalBackups = async () => {
    const deleted = await onDeleteSelectedBackups(selectedLocalBackups);
    if (deleted) {
      setLocalSelection([]);
    }
  };
  const renderAppSelect = (value: string, onChange: (appId: string) => void, id: string) => (
    <FormControl size="small" sx={{ minWidth: 240 }}>
      <InputLabel id={`${id}-label`}>{labels.appLabel}</InputLabel>
      <Select
        id={id}
        labelId={`${id}-label`}
        value={value}
        label={labels.appLabel}
        onChange={(event) => onChange(event.target.value)}
      >
        {backupApps.map((app) => (
          <MenuItem key={app.id} value={app.id}>
            {app.name ?? app.id}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );

  return (
    <Stack spacing={3}>
      <Stack spacing={0.5}>
        <Box>
          <Typography variant="h4">{labels.title}</Typography>
          <Typography color="text.secondary">{labels.subtitle}</Typography>
        </Box>
      </Stack>

      {backupApps.length === 0 ? (
        <Alert severity="info">{labels.noApps}</Alert>
      ) : null}

      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <Tabs
          value={activeTab}
          onChange={(_event, value: 'local' | 'cloud') => setActiveTab(value)}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab value="local" label={labels.localTitle} />
          <Tab value="cloud" label={labels.cloudTitle} />
        </Tabs>
      </Paper>

      {activeTab === 'local' ? (
      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          alignItems={{ xs: 'stretch', md: 'center' }}
          justifyContent="space-between"
          sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}
        >
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>{labels.localTitle}</Typography>
            <Typography variant="body2" color="text.secondary">{labels.localSubtitle}</Typography>
            <Typography variant="caption" color="text.secondary">
              {latestLocalBackup
                ? labels.lastLocalBackup(new Date(latestLocalBackup.createdAt).toLocaleString(), formatBytes(latestLocalBackup.totalBytes))
                : labels.noLocalBackupForApp}
            </Typography>
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
            {renderAppSelect(activeLocalAppId, setLocalAppId, 'local-backup-app')}
            <Button
              variant="contained"
              startIcon={<BackupRounded />}
              disabled={busy || !activeLocalAppId}
              onClick={() => onCreateBackup(activeLocalAppId)}
            >
              {labels.createLocal}
            </Button>
          </Stack>
        </Stack>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1}
          alignItems={{ xs: 'stretch', md: 'center' }}
          justifyContent="space-between"
          sx={{ px: 2, py: 1.25, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'action.hover' }}
        >
          <Typography variant="body2" color="text.secondary">
            {labels.selectedLocalBackups(selectedLocalCount, formatBytes(selectedLocalSize))}
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button
              size="small"
              variant="outlined"
              disabled={busy || oldAutomaticLocalBackups.length === 0}
              onClick={selectOldAutomaticBackups}
            >
              {labels.selectOldAutomatic}
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={busy || selectedLocalCount === 0}
              onClick={() => setLocalSelection([])}
            >
              {labels.clearSelection}
            </Button>
            <Button
              size="small"
              color="error"
              variant="contained"
              startIcon={<DeleteRounded />}
              disabled={busy || selectedLocalCount === 0}
              onClick={() => void handleDeleteSelectedLocalBackups()}
            >
              {labels.deleteSelected}
            </Button>
          </Stack>
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  size="small"
                  checked={allLocalSelected}
                  indeterminate={someLocalSelected}
                  disabled={busy || localAppBackups.length === 0}
                  onChange={(event) => setLocalSelection(event.target.checked ? localAppBackups : [])}
                  inputProps={{ 'aria-label': labels.selectAllLocalBackups }}
                />
              </TableCell>
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
            {localAppBackups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <Typography color="text.secondary">{labels.empty}</Typography>
                </TableCell>
              </TableRow>
            ) : localAppBackups.map((backup) => {
              const app = apps.find((candidate) => candidate.id === backup.appId);
              const isRunning = app?.status === 'running';
              const key = backupKey(backup);
              return (
                <TableRow key={key} hover selected={selectedLocalBackupKeys.has(key)}>
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={selectedLocalBackupKeys.has(key)}
                      disabled={busy}
                      onChange={(event) => toggleLocalBackup(backup, event.target.checked)}
                      inputProps={{ 'aria-label': labels.selectLocalBackup(backup.appName || app?.name || backup.appId) }}
                    />
                  </TableCell>
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
      ) : null}

      {activeTab === 'cloud' ? (
      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          alignItems={{ xs: 'stretch', md: 'center' }}
          justifyContent="space-between"
          sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}
        >
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>{labels.cloudTitle}</Typography>
            <Typography variant="body2" color="text.secondary">{labels.cloudSubtitle}</Typography>
            <Stack spacing={0.75} sx={{ mt: 1, maxWidth: 420 }}>
              <LinearProgress variant="determinate" value={usagePercent} />
              <Typography variant="caption" color="text.secondary">
                {labels.cloudUsage(
                  formatBytes(remoteBackupsUsage.usedBytes),
                  formatBytes(remoteBackupsUsage.limitBytes),
                  remoteBackupsUsage.backupCount,
                  remoteBackupsUsage.backupCountLimit,
                )}
              </Typography>
            </Stack>
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
            {renderAppSelect(activeCloudAppId, setCloudAppId, 'cloud-backup-app')}
            <Tooltip title={labels.autoSyncTooltip} describeChild>
              <FormControlLabel
                control={
                  <Switch
                    checked={activeAutoSync}
                    disabled={busy || !activeCloudAppId}
                    onChange={(event) => runCloudAction(() => onSetAutoSync(activeCloudAppId, event.target.checked))}
                  />
                }
                label={labels.autoSync}
              />
            </Tooltip>
            <Button
              variant="contained"
              startIcon={<CloudUploadRounded />}
              disabled={busy || !activeCloudAppId}
              onClick={() => runCloudAction(() => onSyncNow(activeCloudAppId))}
            >
              {labels.updateCloud}
            </Button>
            <Button
              variant="outlined"
              startIcon={<CloudDownloadRounded />}
              disabled={busy || !latestCloudBackup || cloudAppRunning}
              onClick={() => latestCloudBackup && runCloudAction(() => onRestoreRemoteBackup(latestCloudBackup))}
            >
              {labels.restoreFromCloud}
            </Button>
          </Stack>
        </Stack>
        {!cloudAllowed ? (
          <Alert severity="info" sx={{ borderRadius: 0 }}>{labels.cloudLocked}</Alert>
        ) : null}
        <Stack spacing={1.25} sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }}>
            <Chip
              size="small"
              color={latestCloudBackup ? 'success' : 'default'}
              label={latestCloudBackup
                ? labels.cloudSyncedAt(new Date(latestCloudBackup.createdAt).toLocaleString())
                : labels.cloudNotSynced}
            />
            {activeAutoSync ? <Chip size="small" variant="outlined" label={labels.autoSyncActive} /> : null}
          </Stack>
          <Alert severity="warning" variant="outlined">{labels.noMergeWarning}</Alert>
        </Stack>
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
            {cloudAppBackups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography color="text.secondary">{labels.cloudEmpty}</Typography>
                </TableCell>
              </TableRow>
            ) : cloudAppBackups.map((backup) => {
              const app = apps.find((candidate) => candidate.id === backup.appId);
              const isRunning = app?.status === 'running';
              return (
                <TableRow key={`remote:${backup.id}`} hover>
                  <TableCell>{backup.appName || app?.name || backup.appId}</TableCell>
                  <TableCell>{backup.appVersion || '-'}</TableCell>
                  <TableCell>{new Date(backup.createdAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={backup.backupType === 'sync_snapshot' ? labels.syncSnapshot : labels.cloudBackup}
                    />
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
                            onClick={() => onRestoreRemoteBackup(backup)}
                            aria-label={labels.restore}
                          >
                            <CloudDownloadRounded fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={labels.delete}>
                        <span>
                          <IconButton
                            size="small"
                            disabled={busy}
                            onClick={() => onDeleteRemoteBackup(backup)}
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
      ) : null}
    </Stack>
  );
}
