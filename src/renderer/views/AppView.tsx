import { useEffect, useState } from 'react';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import StarRounded from '@mui/icons-material/StarRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import {
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { AppDetails, AppSecretsState, ForgerAccountSession, SubmitAppFeedbackInput, SubmitAppRatingInput } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { AppSecretsPanel } from '@renderer/components/AppSecretsDialog';

interface AppViewProps {
  details: AppDetails | null;
  openingAppIds: Set<string>;
  t: AppDictionary;
  categoryLabel: string;
  appSecretsState: AppSecretsState | null;
  secretsBusy: boolean;
  account: ForgerAccountSession;
  onBack: () => void;
  onInstall: (appId: string) => void;
  onUpdate: (appId: string) => void;
  onOpen: (appId: string) => void;
  onStop: (appId: string) => void;
  onRestoreUserVersion: (appId: string) => void;
  onResolveConflict: (appId: string) => void;
  onConnectSecret: (appSecretName: string, userSecretId: string) => Promise<void>;
  onDisconnectSecret: (appSecretName: string) => Promise<void>;
  onDelete: (appId: string) => void;
  onOpenAccount: () => void;
  onSubmitRating: (input: SubmitAppRatingInput) => Promise<{ success: boolean }>;
  onSubmitFeedback: (input: SubmitAppFeedbackInput) => Promise<{ success: boolean }>;
}

const initialsFromName = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

type AppViewTab = 'general' | 'history' | 'updates' | 'secrets';

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <Stack spacing={0.25}>
    <Typography variant="caption" color="text.secondary">
      {label}
    </Typography>
    <Typography variant="body2">{value}</Typography>
  </Stack>
);

export function AppView({
  details,
  openingAppIds,
  t,
  categoryLabel,
  appSecretsState,
  secretsBusy,
  account,
  onBack,
  onInstall,
  onUpdate,
  onOpen,
  onStop,
  onRestoreUserVersion,
  onResolveConflict,
  onConnectSecret,
  onDisconnectSecret,
  onDelete,
  onOpenAccount,
  onSubmitRating,
  onSubmitFeedback,
}: AppViewProps) {
  const [activeTab, setActiveTab] = useState<AppViewTab>('general');
  const currentUserRating = details?.app && 'currentUserRating' in details.app ? details.app.currentUserRating : undefined;
  const [ratingScore, setRatingScore] = useState<number>(currentUserRating?.score ?? 5);
  const [ratingComment, setRatingComment] = useState(currentUserRating?.comment ?? '');
  const [feedbackKind, setFeedbackKind] = useState<SubmitAppFeedbackInput['kind']>('other');
  const [feedbackBody, setFeedbackBody] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  useEffect(() => {
    setRatingScore(currentUserRating?.score ?? 5);
    setRatingComment(currentUserRating?.comment ?? '');
  }, [currentUserRating?.comment, currentUserRating?.score]);

  if (!details) {
    return (
      <Stack spacing={2}>
        <Button startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
          {t.actions.back}
        </Button>
        <Typography color="text.secondary">{t.appView.notFound}</Typography>
      </Stack>
    );
  }

  const appId = details.app.id;
  const appName = details.app.name ?? appId;
  const isRunning = details.status === 'running';
  const hasError = details.status === 'error';
  const hasConflict = details.status === 'conflict';
  const isOpening = openingAppIds.has(appId);
  const capabilities = 'capabilities' in details.app ? details.app.capabilities ?? [] : [];
  const averageRating = 'averageRating' in details.app ? details.app.averageRating : undefined;
  const ratingsCount = 'ratingsCount' in details.app ? details.app.ratingsCount ?? 0 : 0;
  const recentRatings = 'recentRatings' in details.app ? details.app.recentRatings ?? [] : [];
  const promptTemplates = details.promptTemplates ?? [];

  const actions = (
    <Stack direction="row" spacing={1.25} useFlexGap flexWrap="wrap">
      {!details.installed ? (
        <Button variant="contained" startIcon={<DownloadRounded />} onClick={() => onInstall(appId)}>
          {t.actions.install}
        </Button>
      ) : hasConflict ? (
        <>
          <Button variant="contained" color="warning" startIcon={<SystemUpdateAltRounded />} onClick={() => onResolveConflict(appId)}>
            {t.actions.resolveWithForger}
          </Button>
          <Button variant="outlined" onClick={() => onRestoreUserVersion(appId)}>
            {t.actions.restoreUserVersion}
          </Button>
        </>
      ) : isRunning ? (
        <Button variant="contained" color="warning" startIcon={<StopCircleRounded />} onClick={() => onStop(appId)}>
          {t.actions.stop}
        </Button>
      ) : details.updateAvailable ? (
        <Button variant="contained" startIcon={<SystemUpdateAltRounded />} onClick={() => onUpdate(appId)}>
          {t.actions.update}
        </Button>
      ) : (
        <Button
          variant="contained"
          startIcon={isOpening ? <CircularProgress color="inherit" size={16} /> : <LaunchRounded />}
          disabled={isOpening}
          aria-busy={isOpening}
          onClick={() => onOpen(appId)}
        >
          {isOpening ? t.actions.opening : t.actions.open}
        </Button>
      )}
      {details.installed ? (
        <Button variant="outlined" color="error" startIcon={<DeleteOutlineRounded />} onClick={() => onDelete(appId)}>
          {t.actions.delete}
        </Button>
      ) : null}
      {hasError ? (
        <Tooltip title={t.actions.comingSoon}>
          <span>
            <Button disabled>{t.actions.askForgerHelp}</Button>
          </span>
        </Tooltip>
      ) : null}
    </Stack>
  );

  const historyContent = (
    <Stack spacing={1}>
      <Typography variant="h5">{t.appView.historyTitle}</Typography>
      {details.operations.length === 0 ? (
        <Typography color="text.secondary">{t.appView.noHistory}</Typography>
      ) : (
        <Stack spacing={1.25}>
          {details.operations.map((operation) => (
            <Box key={operation.operationId} sx={{ borderLeft: '3px solid', borderColor: operation.revertedAt ? 'divider' : 'primary.main', pl: 1.5 }}>
              <Typography fontWeight={600}>{operation.title}</Typography>
              <Typography variant="body2" color="text.secondary">{operation.summary}</Typography>
              <Typography variant="caption" color="text.secondary">
                {new Date(operation.createdAt).toLocaleString()}
                {operation.revertedAt ? ` · ${t.appView.reverted}` : ''}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );

  const updatesContent = (
    <Stack spacing={1}>
      <Typography variant="h5">{t.appView.updatesTitle}</Typography>
      {hasConflict ? <Typography color="error.main">{t.appView.conflictBody}</Typography> : null}
      <Typography color="text.secondary">{t.appView.updatesBody}</Typography>
      {details.changelog ? (
        <Box sx={{ borderLeft: '3px solid', borderColor: 'warning.main', pl: 1.5 }}>
          <Typography fontWeight={600}>{details.changelog.summary ?? t.appView.updateAvailable(details.changelog.version)}</Typography>
          {details.changelog.changes.length > 0 ? (
            <Stack component="ul" sx={{ m: 0, pl: 2 }}>
              {details.changelog.changes.map((change) => (
                <Typography component="li" variant="body2" color="text.secondary" key={change}>
                  {change}
                </Typography>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">{t.appView.updateNoChangelog}</Typography>
          )}
        </Box>
      ) : null}
    </Stack>
  );

  const secretsContent = (
    <Stack spacing={1.5}>
      <Typography variant="h5">{t.secrets.title}</Typography>
      <Typography color="text.secondary">{t.appView.secretsBody}</Typography>
      {details.installed ? (
        <AppSecretsPanel
          state={appSecretsState}
          busy={secretsBusy}
          t={t}
          onConnectSecret={onConnectSecret}
          onDisconnectSecret={onDisconnectSecret}
        />
      ) : (
        <Typography color="text.secondary">{t.appView.secretsInstallRequired}</Typography>
      )}
    </Stack>
  );

  const generalContent = (
    <Stack spacing={2.5}>
      <Stack spacing={1}>
        <Typography variant="h5">{t.appView.generalTitle}</Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 820 }}>
          {details.app.description}
        </Typography>
      </Stack>
      {capabilities.length > 0 ? (
        <Stack spacing={1.5}>
          <Typography variant="h5">{t.appView.capabilitiesTitle}</Typography>
          <Box
            sx={{
              display: 'grid',
              gap: 1.25,
              gridTemplateColumns: {
                xs: '1fr',
                md: 'repeat(2, minmax(0, 1fr))',
              },
            }}
          >
            {capabilities.map((capability) => (
              <Box
                key={capability.id}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                  p: 1.5,
                  display: 'grid',
                  gridTemplateColumns: '28px minmax(0, 1fr)',
                  gap: 1,
                }}
              >
                <CheckCircleOutlineRounded color="primary" fontSize="small" />
                <Stack spacing={0.35} sx={{ minWidth: 0 }}>
                  <Typography fontWeight={700}>{capability.title}</Typography>
                  {capability.description ? (
                    <Typography variant="body2" color="text.secondary">
                      {capability.description}
                    </Typography>
                  ) : null}
                </Stack>
              </Box>
            ))}
          </Box>
        </Stack>
      ) : null}
      {promptTemplates.length > 0 ? (
        <Stack spacing={1.5}>
          <Typography variant="h5">{t.appView.promptTemplatesTitle}</Typography>
          <Box
            sx={{
              display: 'grid',
              gap: 1.25,
              gridTemplateColumns: {
                xs: '1fr',
                md: 'repeat(2, minmax(0, 1fr))',
              },
            }}
          >
            {promptTemplates.map((template) => (
              <Box
                key={template.id}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                  p: 1.5,
                  display: 'grid',
                  gridTemplateColumns: '28px minmax(0, 1fr)',
                  gap: 1,
                }}
              >
                <AutoAwesomeRounded color="primary" fontSize="small" />
                <Stack spacing={0.35} sx={{ minWidth: 0 }}>
                  <Typography fontWeight={700}>{template.title}</Typography>
                  {template.description ? (
                    <Typography variant="body2" color="text.secondary">
                      {template.description}
                    </Typography>
                  ) : null}
                </Stack>
              </Box>
            ))}
          </Box>
        </Stack>
      ) : null}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' },
          gap: 2,
        }}
      >
        <DetailRow label={t.appView.nameLabel} value={appName} />
        <DetailRow label={t.appView.categoryLabel} value={categoryLabel} />
        <DetailRow
          label={t.appView.statusLabel}
          value={details.installed ? (isRunning ? t.actions.running : hasConflict ? t.actions.conflict : hasError ? t.actions.error : t.actions.installed) : t.actions.available}
        />
        <DetailRow label={t.appView.installedVersion} value={details.version ?? '-'} />
        <DetailRow label={t.appView.availableVersion} value={details.latestVersion ?? details.version ?? '-'} />
        <DetailRow label={t.appView.installedAtLabel} value={details.installedAt ? new Date(details.installedAt).toLocaleString() : '-'} />
      </Box>
      {details.changelog ? (
        <Box sx={{ borderLeft: '3px solid', borderColor: 'warning.main', pl: 1.5 }}>
          <Typography fontWeight={600}>{details.changelog.summary ?? t.appView.updateAvailable(details.changelog.version)}</Typography>
          {details.changelog.changes.length > 0 ? (
            <Stack component="ul" sx={{ m: 0, pl: 2 }}>
              {details.changelog.changes.map((change) => (
                <Typography component="li" variant="body2" color="text.secondary" key={change}>
                  {change}
                </Typography>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">{t.appView.updateNoChangelog}</Typography>
          )}
        </Box>
      ) : null}
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center">
          <StarRounded color={averageRating ? 'warning' : 'disabled'} />
          <Typography variant="h5">{t.appView.reviewsTitle}</Typography>
          <Typography color="text.secondary">
            {averageRating ? t.appView.ratingSummary(averageRating, ratingsCount) : t.appView.noRatings}
          </Typography>
        </Stack>
        {account.authenticated && account.user?.confirmed ? (
          <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1.5, bgcolor: 'background.paper' }}>
            <Stack spacing={1.25}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
                <TextField
                  select
                  label={t.appView.ratingLabel}
                  value={ratingScore}
                  onChange={(event) => setRatingScore(Number(event.target.value))}
                  sx={{ minWidth: 140 }}
                >
                  {[1, 2, 3, 4, 5].map((score) => (
                    <MenuItem key={score} value={score}>{score}</MenuItem>
                  ))}
                </TextField>
                <TextField
                  label={t.appView.reviewCommentLabel}
                  value={ratingComment}
                  onChange={(event) => setRatingComment(event.target.value)}
                  fullWidth
                  multiline
                  minRows={2}
                />
              </Stack>
              <Button
                variant="contained"
                startIcon={<StarRounded />}
                disabled={reviewBusy}
                onClick={() => {
                  setReviewBusy(true);
                  void onSubmitRating({ appId, score: ratingScore, comment: ratingComment }).finally(() => setReviewBusy(false));
                }}
                sx={{ alignSelf: 'flex-start' }}
              >
                {t.appView.saveReview}
              </Button>
            </Stack>
          </Box>
        ) : (
          <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1.5, bgcolor: 'background.paper' }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} alignItems={{ xs: 'stretch', sm: 'center' }}>
              <Typography color="text.secondary" sx={{ flex: 1 }}>
                {t.appView.signInToReview}
              </Typography>
              <Button variant="outlined" onClick={onOpenAccount}>{t.cloud.login}</Button>
            </Stack>
          </Box>
        )}
        {recentRatings.length > 0 ? (
          <Stack spacing={1}>
            {recentRatings.map((rating) => (
              <Box key={rating.id} sx={{ borderLeft: '3px solid', borderColor: 'warning.main', pl: 1.5 }}>
                <Typography fontWeight={700}>
                  {rating.score}/5 · {rating.user?.firstName ?? t.appView.reviewUserFallback}
                </Typography>
                {rating.comment ? <Typography variant="body2" color="text.secondary">{rating.comment}</Typography> : null}
                {rating.forgerResponse ? (
                  <Typography variant="body2" sx={{ mt: 0.75 }}>
                    {t.appView.forgerResponse}: {rating.forgerResponse}
                  </Typography>
                ) : null}
              </Box>
            ))}
          </Stack>
        ) : null}
      </Stack>
      <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1.5, bgcolor: 'background.paper' }}>
        <Stack spacing={1.25}>
          <Typography variant="h5">{t.appView.feedbackTitle}</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
            <TextField select label={t.appView.feedbackKind} value={feedbackKind} onChange={(event) => setFeedbackKind(event.target.value as SubmitAppFeedbackInput['kind'])} sx={{ minWidth: 170 }}>
              <MenuItem value="bug">{t.appView.feedbackKinds.bug}</MenuItem>
              <MenuItem value="idea">{t.appView.feedbackKinds.idea}</MenuItem>
              <MenuItem value="support">{t.appView.feedbackKinds.support}</MenuItem>
              <MenuItem value="other">{t.appView.feedbackKinds.other}</MenuItem>
            </TextField>
            <TextField label={t.appView.feedbackBody} value={feedbackBody} onChange={(event) => setFeedbackBody(event.target.value)} fullWidth multiline minRows={2} />
          </Stack>
          <Button
            variant="outlined"
            disabled={!feedbackBody.trim()}
            onClick={() => {
              const body = feedbackBody;
              setFeedbackBody('');
              void onSubmitFeedback({ appId, kind: feedbackKind, body });
            }}
            sx={{ alignSelf: 'flex-start' }}
          >
            {t.appView.sendFeedback}
          </Button>
        </Stack>
      </Box>
      {!details.installed ? (
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            minHeight: 220,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'background.paper',
          }}
        >
          <Typography color="text.secondary">{t.appView.screenshotsPlaceholder}</Typography>
        </Box>
      ) : null}
    </Stack>
  );

  return (
    <Stack spacing={3}>
      <Button startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
        {t.actions.back}
      </Button>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems={{ xs: 'flex-start', md: 'center' }}>
        <Avatar sx={{ width: 84, height: 84, bgcolor: 'secondary.main', color: 'secondary.contrastText', fontSize: 28, fontWeight: 700 }}>
          {initialsFromName(appName)}
        </Avatar>
        <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
            <Typography variant="h3">{appName}</Typography>
            <Chip label={categoryLabel} />
            <Chip
              color={details.installed ? (hasError || hasConflict ? 'error' : isRunning ? 'info' : details.updateAvailable ? 'warning' : 'success') : 'default'}
              label={details.installed ? (isRunning ? t.actions.running : hasConflict ? t.actions.conflict : hasError ? t.actions.error : details.updateAvailable && details.latestVersion ? t.appView.updateAvailable(details.latestVersion) : t.actions.installed) : t.actions.available}
            />
          </Stack>
          <Typography color="text.secondary" sx={{ maxWidth: 760 }}>
            {details.app.description}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {details.installed
              ? `${t.appView.installedVersion}: ${details.version ?? '-'}`
              : `${t.appView.availableVersion}: ${details.latestVersion ?? details.version ?? '-'}`}
          </Typography>
        </Stack>
      </Stack>

      {actions}

      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Tabs
          value={activeTab}
          onChange={(_event, nextValue: AppViewTab) => setActiveTab(nextValue)}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab value="general" label={t.appView.tabs.general} />
          <Tab value="history" label={t.appView.tabs.history} />
          <Tab value="updates" label={t.appView.tabs.updates} />
          <Tab value="secrets" label={t.appView.tabs.secrets} />
        </Tabs>
      </Box>

      {activeTab === 'general' ? (
        generalContent
      ) : null}
      {activeTab === 'history' ? historyContent : null}
      {activeTab === 'updates' ? updatesContent : null}
      {activeTab === 'secrets' ? secretsContent : null}
    </Stack>
  );
}
