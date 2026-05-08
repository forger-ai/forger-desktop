import { useEffect, useState } from 'react';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import RestoreRounded from '@mui/icons-material/RestoreRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import StarRounded from '@mui/icons-material/StarRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import {
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Rating,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type {
  AppCapability,
  AppDetails,
  AppPromptMutationResult,
  AppPromptRestoreInput,
  AppPromptReviewInput,
  AppPromptValidationResult,
  AppSecretsState,
  ForgerAccountSession,
  SubmitAppFeedbackInput,
  SubmitAppRatingInput,
} from '@shared/types';
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
  onUpdatePrompt: (input: AppPromptReviewInput) => Promise<AppPromptMutationResult>;
  onRestorePrompt: (input: AppPromptRestoreInput) => Promise<AppPromptMutationResult>;
}

const initialsFromName = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

type AppViewTab = 'general' | 'prompts' | 'reviews' | 'history' | 'updates' | 'secrets';
type PromptPreview = { title: string; description?: string; prompt: string } | null;

const promptReviewKey = (kind: string, id: string) => `${kind}:${id}`;

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
  onUpdatePrompt,
  onRestorePrompt,
}: AppViewProps) {
  const [activeTab, setActiveTab] = useState<AppViewTab>('general');
  const promptReviewsForState = details?.promptReviews ?? [];
  const [selectedPromptKey, setSelectedPromptKey] = useState<string | null>(null);
  const selectedPrompt = promptReviewsForState.find((prompt) => promptReviewKey(prompt.kind, prompt.id) === selectedPromptKey) ?? null;
  const [promptDraft, setPromptDraft] = useState('');
  const [promptValidation, setPromptValidation] = useState<AppPromptValidationResult | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);
  const currentUserRating = details?.app && 'currentUserRating' in details.app ? details.app.currentUserRating : undefined;
  const [ratingScore, setRatingScore] = useState<number>(currentUserRating?.score ?? 5);
  const [ratingComment, setRatingComment] = useState(currentUserRating?.comment ?? '');
  const [feedbackKind, setFeedbackKind] = useState<SubmitAppFeedbackInput['kind']>('other');
  const [feedbackBody, setFeedbackBody] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewEditorOpen, setReviewEditorOpen] = useState(false);
  const [promptPreview, setPromptPreview] = useState<PromptPreview>(null);

  useEffect(() => {
    setRatingScore(currentUserRating?.score ?? 5);
    setRatingComment(currentUserRating?.comment ?? '');
  }, [currentUserRating?.comment, currentUserRating?.score]);

  useEffect(() => {
    if (!details || promptReviewsForState.length === 0) {
      setSelectedPromptKey(null);
      return;
    }
    const currentStillExists = promptReviewsForState.some((prompt) => promptReviewKey(prompt.kind, prompt.id) === selectedPromptKey);
    if (!currentStillExists) {
      const firstPrompt = promptReviewsForState[0];
      setSelectedPromptKey(promptReviewKey(firstPrompt.kind, firstPrompt.id));
    }
  }, [details, promptReviewsForState, selectedPromptKey]);

  useEffect(() => {
    if (!selectedPrompt) {
      setPromptDraft('');
      setPromptValidation(null);
      return;
    }
    setPromptDraft(selectedPrompt.overridePrompt ?? selectedPrompt.prompt);
    setPromptValidation(selectedPrompt.validation);
  }, [selectedPrompt]);

  useEffect(() => {
    if (!details || !selectedPrompt) {
      return undefined;
    }
    const handle = window.setTimeout(() => {
      void window.forger.validateAppPrompt({
        appId: details.app.id,
        kind: selectedPrompt.kind,
        id: selectedPrompt.id,
        prompt: promptDraft,
      }).then(setPromptValidation).catch(() => {
        setPromptValidation({
          valid: false,
          errors: [t.appView.promptErrorFallback],
          missingVariables: [],
          extraVariables: [],
        });
      });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [details, selectedPrompt, promptDraft, t.appView.promptErrorFallback]);

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
  const iconUrl = details.app.iconUrl;
  const isRunning = details.status === 'running';
  const hasError = details.status === 'error';
  const hasConflict = details.status === 'conflict';
  const isOpening = openingAppIds.has(appId);
  const capabilities = 'capabilities' in details.app ? details.app.capabilities ?? [] : [];
  const capabilityTranslations = t.appCapabilities as Record<string, Pick<AppCapability, 'title' | 'description'> | undefined>;
  const localizedCapabilities = capabilities.map((capability) => {
    const localized = capabilityTranslations[capability.id];
    return {
      ...capability,
      title: localized?.title ?? capability.title ?? capability.id,
      description: localized?.description ?? capability.description,
    };
  });
  const averageRating = 'averageRating' in details.app ? details.app.averageRating : undefined;
  const ratingsCount = 'ratingsCount' in details.app ? details.app.ratingsCount ?? 0 : 0;
  const recentRatings = 'recentRatings' in details.app ? details.app.recentRatings ?? [] : [];
  const promptTemplates = details.promptTemplates ?? [];
  const agents = details.agents ?? [];
  const promptReviews = details.promptReviews ?? [];
  const localChanges = details.localChanges ?? [];

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
      ) : (
        <>
          <Button
            variant="contained"
            startIcon={isOpening ? <CircularProgress color="inherit" size={16} /> : <LaunchRounded />}
            disabled={isOpening}
            aria-busy={isOpening}
            onClick={() => onOpen(appId)}
          >
            {isOpening ? t.actions.opening : t.actions.open}
          </Button>
          {details.updateAvailable ? (
            <Button variant="outlined" startIcon={<SystemUpdateAltRounded />} onClick={() => onUpdate(appId)}>
              {t.actions.update}
            </Button>
          ) : null}
        </>
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
      {details.operations.length === 0 && localChanges.length === 0 ? (
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
      {localChanges.length > 0 ? (
        <Stack spacing={1.25}>
          <Typography variant="h6">{t.appView.localChangesTitle}</Typography>
          {localChanges.map((change) => (
            <Box key={change.id} sx={{ borderLeft: '3px solid', borderColor: 'info.main', pl: 1.5 }}>
              <Typography fontWeight={600}>{change.title}</Typography>
              {change.createdAt ? (
                <Typography variant="caption" color="text.secondary">
                  {new Date(change.createdAt).toLocaleString()}
                </Typography>
              ) : null}
            </Box>
          ))}
        </Stack>
      ) : null}
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

  const promptErrors = promptValidation?.errors ?? [];
  const promptsContent = (
    <Stack spacing={1.5}>
      <Stack spacing={0.5}>
        <Typography variant="h5">{t.appView.promptsTitle}</Typography>
        <Typography color="text.secondary">{t.appView.promptsBody}</Typography>
      </Stack>
      {promptReviews.length === 0 ? (
        <Typography color="text.secondary">{t.appView.promptEmpty}</Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'minmax(240px, 340px) minmax(0, 1fr)' },
            gap: 1.5,
          }}
        >
          <Stack spacing={1}>
            {promptReviews.map((prompt) => {
              const key = promptReviewKey(prompt.kind, prompt.id);
              const selected = key === selectedPromptKey;
              return (
                <Box
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedPromptKey(key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedPromptKey(key);
                    }
                  }}
                  sx={{
                    border: '1px solid',
                    borderColor: selected ? 'primary.main' : 'divider',
                    bgcolor: selected ? 'action.selected' : 'background.paper',
                    p: 1.25,
                    cursor: 'pointer',
                  }}
                >
                  <Stack spacing={0.75}>
                    <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap flexWrap="wrap">
                      <Chip size="small" label={prompt.kind === 'agent' ? t.appView.promptTypeAgent : t.appView.promptTypeTemplate} />
                      {prompt.edited ? <Chip size="small" color="primary" label={t.appView.promptEdited} /> : null}
                      {prompt.overrideInvalid ? <Chip size="small" color="warning" label={t.appView.promptNeedsReview} /> : null}
                    </Stack>
                    <Typography fontWeight={700}>{prompt.title}</Typography>
                    {prompt.description ? (
                      <Typography variant="body2" color="text.secondary">
                        {prompt.description}
                      </Typography>
                    ) : null}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
          {selectedPrompt ? (
            <Stack spacing={1.25}>
              {selectedPrompt.overrideInvalid ? (
                <Box sx={{ border: '1px solid', borderColor: 'warning.main', bgcolor: 'warning.light', color: 'warning.contrastText', p: 1.25 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <WarningAmberRounded fontSize="small" />
                    <Typography variant="body2">{t.appView.promptNeedsReview}</Typography>
                  </Stack>
                </Box>
              ) : null}
              <TextField
                label={t.appView.promptEditorLabel}
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
                fullWidth
                multiline
                minRows={14}
                inputProps={{ spellCheck: false }}
                sx={{
                  '& textarea': {
                    fontFamily: 'monospace',
                    fontSize: 13,
                    lineHeight: 1.55,
                  },
                }}
              />
              {promptErrors.length > 0 ? (
                <Box sx={{ border: '1px solid', borderColor: 'error.main', p: 1.25 }}>
                  <Stack component="ul" sx={{ m: 0, pl: 2 }}>
                    {promptErrors.map((error) => (
                      <Typography component="li" variant="body2" color="error.main" key={error}>
                        {error}
                      </Typography>
                    ))}
                  </Stack>
                </Box>
              ) : null}
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                <Button
                  variant="contained"
                  startIcon={promptBusy ? <CircularProgress color="inherit" size={16} /> : <SaveRounded />}
                  disabled={promptBusy || !promptValidation?.valid}
                  onClick={() => {
                    setPromptBusy(true);
                    void onUpdatePrompt({
                      appId,
                      kind: selectedPrompt.kind,
                      id: selectedPrompt.id,
                      prompt: promptDraft,
                    }).finally(() => setPromptBusy(false));
                  }}
                >
                  {t.appView.promptSave}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<RestoreRounded />}
                  disabled={promptBusy || !selectedPrompt.edited}
                  onClick={() => {
                    setPromptBusy(true);
                    void onRestorePrompt({
                      appId,
                      kind: selectedPrompt.kind,
                      id: selectedPrompt.id,
                    }).finally(() => setPromptBusy(false));
                  }}
                >
                  {t.appView.promptRestore}
                </Button>
              </Stack>
              <Stack spacing={0.75}>
                <Typography variant="caption" color="text.secondary">
                  {t.appView.promptOriginalLabel}
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1.25,
                    border: '1px solid',
                    borderColor: 'divider',
                    bgcolor: 'background.default',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'monospace',
                    fontSize: 12,
                    lineHeight: 1.5,
                    maxHeight: 260,
                    overflow: 'auto',
                  }}
                >
                  {selectedPrompt.originalPrompt}
                </Box>
              </Stack>
            </Stack>
          ) : null}
        </Box>
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
      {localizedCapabilities.length > 0 ? (
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
            {localizedCapabilities.map((capability) => (
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
                role="button"
                tabIndex={0}
                onClick={() => setPromptPreview({ title: template.title, description: template.description, prompt: template.prompt })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setPromptPreview({ title: template.title, description: template.description, prompt: template.prompt });
                  }
                }}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                  p: 1.5,
                  display: 'grid',
                  gridTemplateColumns: '28px minmax(0, 1fr)',
                  gap: 1,
                  cursor: 'pointer',
                  transition: 'border-color 120ms ease, background-color 120ms ease',
                  '&:hover': {
                    borderColor: 'primary.main',
                    bgcolor: 'action.hover',
                  },
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
      {agents.length > 0 ? (
        <Stack spacing={1.5}>
          <Typography variant="h5">{t.appView.agentsTitle}</Typography>
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
            {agents.map((agent) => (
              <Box
                key={agent.id}
                role="button"
                tabIndex={0}
                onClick={() => setPromptPreview({ title: agent.title, description: agent.description, prompt: agent.initialPrompt })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setPromptPreview({ title: agent.title, description: agent.description, prompt: agent.initialPrompt });
                  }
                }}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                  p: 1.5,
                  display: 'grid',
                  gridTemplateColumns: '28px minmax(0, 1fr)',
                  gap: 1,
                  cursor: 'pointer',
                  transition: 'border-color 120ms ease, background-color 120ms ease',
                  '&:hover': {
                    borderColor: 'primary.main',
                    bgcolor: 'action.hover',
                  },
                }}
              >
                <AutoAwesomeRounded color="primary" fontSize="small" />
                <Stack spacing={0.35} sx={{ minWidth: 0 }}>
                  <Typography fontWeight={700}>{agent.title}</Typography>
                  {agent.description ? (
                    <Typography variant="body2" color="text.secondary">
                      {agent.description}
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
    </Stack>
  );

  const reviewsContent = (
    <Stack spacing={2.5}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
        <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Rating value={averageRating ?? 0} precision={0.5} readOnly size="small" />
            <Typography color="text.secondary">
              {averageRating ? t.appView.ratingSummary(averageRating, ratingsCount) : t.appView.noRatings}
            </Typography>
          </Stack>
        </Stack>
        {account.authenticated && account.user?.confirmed ? (
          <Button
            variant={reviewEditorOpen ? 'outlined' : 'contained'}
            startIcon={<StarRounded />}
            onClick={() => setReviewEditorOpen((open) => !open)}
          >
            {reviewEditorOpen ? t.actions.close : currentUserRating ? t.appView.editReview : t.appView.createReview}
          </Button>
        ) : (
          <Button variant="outlined" onClick={onOpenAccount}>{t.cloud.login}</Button>
        )}
      </Stack>

      {account.authenticated && account.user?.confirmed && reviewEditorOpen ? (
        <Box sx={{ border: '1px solid', borderColor: 'divider', p: 2, bgcolor: 'background.paper' }}>
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'flex-start', sm: 'center' }}>
              <Typography variant="body2" color="text.secondary">{t.appView.ratingLabel}</Typography>
              <Rating
                value={ratingScore}
                onChange={(_event, value) => setRatingScore(value ?? ratingScore)}
                max={5}
                size="large"
              />
              <Typography fontWeight={700}>{ratingScore}/5</Typography>
            </Stack>
            <TextField
              label={t.appView.reviewCommentLabel}
              value={ratingComment}
              onChange={(event) => setRatingComment(event.target.value)}
              fullWidth
              multiline
              minRows={3}
            />
            <Button
              variant="contained"
              startIcon={<StarRounded />}
              disabled={reviewBusy}
              onClick={() => {
                setReviewBusy(true);
                void onSubmitRating({ appId, score: ratingScore, comment: ratingComment })
                  .then((result) => {
                    if (result.success) {
                      setReviewEditorOpen(false);
                    }
                  })
                  .finally(() => setReviewBusy(false));
              }}
              sx={{ alignSelf: 'flex-start' }}
            >
              {t.appView.saveReview}
            </Button>
          </Stack>
        </Box>
      ) : null}

      {!account.authenticated || !account.user?.confirmed ? (
        <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1.5, bgcolor: 'background.paper' }}>
          <Typography color="text.secondary">{t.appView.signInToReview}</Typography>
        </Box>
      ) : null}

      {recentRatings.length > 0 ? (
        <Stack spacing={1.25}>
          {recentRatings.map((rating) => (
            <Box
              key={rating.id}
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.paper',
                p: 1.5,
              }}
            >
              <Stack spacing={0.75}>
                <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                  <Rating value={rating.score} readOnly size="small" />
                  <Typography fontWeight={700}>{rating.user?.firstName ?? t.appView.reviewUserFallback}</Typography>
                </Stack>
                {rating.comment ? <Typography color="text.secondary">{rating.comment}</Typography> : null}
                {rating.forgerResponse ? (
                  <Box sx={{ borderLeft: '3px solid', borderColor: 'primary.main', pl: 1.25 }}>
                    <Typography variant="body2" fontWeight={700}>{t.appView.forgerResponse}</Typography>
                    <Typography variant="body2" color="text.secondary">{rating.forgerResponse}</Typography>
                  </Box>
                ) : null}
              </Stack>
            </Box>
          ))}
        </Stack>
      ) : (
        <Typography color="text.secondary">{t.appView.noRatings}</Typography>
      )}

      <Box sx={{ border: '1px solid', borderColor: 'divider', p: 2, bgcolor: 'background.paper' }}>
        <Stack spacing={1.5}>
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
    </Stack>
  );

  return (
    <Stack spacing={3}>
      <Button startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
        {t.actions.back}
      </Button>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems={{ xs: 'flex-start', md: 'center' }}>
        <Avatar
          src={iconUrl}
          alt={appName}
          variant="rounded"
          sx={{
            width: 84,
            height: 84,
            borderRadius: 3,
            bgcolor: iconUrl ? 'transparent' : 'secondary.main',
            color: 'secondary.contrastText',
            fontSize: 28,
            fontWeight: 700,
            '& .MuiAvatar-img': {
              objectFit: 'cover',
            },
          }}
        >
          {iconUrl ? null : initialsFromName(appName)}
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
          <Stack direction="row" spacing={1} alignItems="center">
            <Rating value={averageRating ?? 0} precision={0.5} readOnly size="small" />
            <Typography variant="body2" color="text.secondary">
              {averageRating ? t.appView.ratingSummary(averageRating, ratingsCount) : t.appView.noRatings}
            </Typography>
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
          <Tab value="prompts" label={t.appView.tabs.prompts} />
          <Tab value="reviews" label={t.appView.tabs.reviews} />
          <Tab value="history" label={t.appView.tabs.history} />
          <Tab value="updates" label={t.appView.tabs.updates} />
          <Tab value="secrets" label={t.appView.tabs.secrets} />
        </Tabs>
      </Box>

      {activeTab === 'general' ? (
        generalContent
      ) : null}
      {activeTab === 'prompts' ? promptsContent : null}
      {activeTab === 'reviews' ? reviewsContent : null}
      {activeTab === 'history' ? historyContent : null}
      {activeTab === 'updates' ? updatesContent : null}
      {activeTab === 'secrets' ? secretsContent : null}
      <Dialog open={promptPreview !== null} onClose={() => setPromptPreview(null)} fullWidth maxWidth="md">
        <DialogTitle>{promptPreview?.title}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            {promptPreview?.description ? (
              <Typography color="text.secondary">{promptPreview.description}</Typography>
            ) : null}
            <Typography variant="caption" color="text.secondary">
              {t.appView.promptPreviewLabel}
            </Typography>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.default',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'monospace',
                fontSize: 13,
                lineHeight: 1.55,
              }}
            >
              {promptPreview?.prompt}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPromptPreview(null)}>{t.actions.close}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
