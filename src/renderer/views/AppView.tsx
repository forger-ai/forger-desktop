import { useEffect, useState } from 'react';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import RestoreRounded from '@mui/icons-material/RestoreRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import StarRounded from '@mui/icons-material/StarRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import {
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Rating,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import type {
  AppDetails,
  AppPromptMutationResult,
  AppPromptRestoreInput,
  AppPromptReviewInput,
  AppPromptValidationResult,
  AppSecretsState,
  AgentProvider,
  AgentRuntime,
  ClaudeEffort,
  ClaudeModelOption,
  CodexModelOption,
  CodexReasoningEffort,
  DeveloperPathState,
  ForgerAccountSession,
  InstallAppResult,
  Settings,
  SubmitAppRatingInput,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { AppSecretsPanel } from '@renderer/components/AppSecretsDialog';
import { AppViewActions } from './app-view/AppViewActions';
import { PromptPreviewDialog, type PromptPreview } from './app-view/PromptPreviewDialog';

interface AppViewProps {
  details: AppDetails | null;
  openingAppIds: Set<string>;
  installProgress?: InstallAppResult;
  t: AppDictionary;
  categoryLabel: string;
  appSecretsState: AppSecretsState | null;
  secretsBusy: boolean;
  account: ForgerAccountSession;
  providerOptions: Array<{ label: string; value: AgentProvider | 'auto' }>;
  modelOptions: CodexModelOption[];
  reasoningOptions: { label: string; value: CodexReasoningEffort }[];
  claudeModelOptions: ClaudeModelOption[];
  claudeEffortOptions: { label: string; value: ClaudeEffort }[];
  codexDefaults: Settings['codexDefaults'];
  developerMode: Settings['developerMode'];
  onBack: () => void;
  onInstall: (appId: string) => void;
  onUpdate: (appId: string) => void;
  onOpen: (appId: string) => void;
  onStop: (appId: string) => void;
  onRestoreUserVersion: (appId: string) => void;
  onResolveConflict: (appId: string) => void;
  onStartLocalNetworkShare: (appId: string) => void;
  onStartRemoteNetworkShare: (appId: string) => void;
  onStopRemoteNetworkShare: (appId: string) => void;
  onUploadSocial: (appId: string) => void;
  onConnectSecret: (appSecretName: string, userSecretId: string) => Promise<void>;
  onDisconnectSecret: (appSecretName: string) => Promise<void>;
  onDelete: (appId: string) => void;
  onOpenAccount: () => void;
  onOpenProfile?: (username: string) => void;
  onSubmitRating: (input: SubmitAppRatingInput) => Promise<{ success: boolean }>;
  onUpdatePrompt: (input: AppPromptReviewInput) => Promise<AppPromptMutationResult>;
  onRestorePrompt: (input: AppPromptRestoreInput) => Promise<AppPromptMutationResult>;
}

const initialsFromName = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

type AppViewTab = 'general' | 'prompts' | 'reviews' | 'history' | 'updates' | 'secrets' | 'developer';

const promptReviewKey = (kind: string, id: string) => `${kind}:${id}`;

const promptTypeLabel = (kind: string) => {
  if (kind === 'agentPrompt') {
    return 'Agent prompt';
  }
  if (kind === 'agent') {
    return 'Agent';
  }
  return 'Template';
};

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <Stack spacing={0.25}>
    <Typography variant="caption" color="text.secondary">
      {label}
    </Typography>
    <Typography variant="body2">{value}</Typography>
  </Stack>
);

const PathPreview = ({ title, entries }: { title: string; entries: string[] }) => (
  <Stack spacing={0.5}>
    <Typography variant="caption" color="text.secondary">{title}</Typography>
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.default',
        maxHeight: 140,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'monospace',
        fontSize: 12,
      }}
    >
      {entries.length > 0 ? entries.join('\n') : '-'}
    </Box>
  </Stack>
);

export function AppView({
  details,
  openingAppIds,
  installProgress,
  t,
  categoryLabel,
  appSecretsState,
  secretsBusy,
  account,
  providerOptions,
  modelOptions,
  reasoningOptions,
  claudeModelOptions,
  claudeEffortOptions,
  codexDefaults,
  developerMode,
  onBack,
  onInstall,
  onUpdate,
  onOpen,
  onStop,
  onRestoreUserVersion,
  onResolveConflict,
  onStartLocalNetworkShare,
  onStartRemoteNetworkShare,
  onStopRemoteNetworkShare,
  onUploadSocial,
  onConnectSecret,
  onDisconnectSecret,
  onDelete,
  onOpenAccount,
  onOpenProfile,
  onSubmitRating,
  onUpdatePrompt,
  onRestorePrompt,
}: AppViewProps) {
  const [activeTab, setActiveTab] = useState<AppViewTab>('general');
  const promptReviewsForState = details?.promptReviews ?? [];
  const [selectedPromptKey, setSelectedPromptKey] = useState<string | null>(null);
  const selectedPrompt = promptReviewsForState.find((prompt) => promptReviewKey(prompt.kind, prompt.id) === selectedPromptKey) ?? null;
  const [promptDraft, setPromptDraft] = useState('');
  const [promptRuntimeDraft, setPromptRuntimeDraft] = useState<AgentRuntime>({
    provider: 'codex',
    model: codexDefaults.model,
    effort: codexDefaults.reasoningEffort,
  });
  const [promptValidation, setPromptValidation] = useState<AppPromptValidationResult | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);
  const currentUserRating = details?.app && 'currentUserRating' in details.app ? details.app.currentUserRating : undefined;
  const [ratingScore, setRatingScore] = useState<number>(currentUserRating?.score ?? 5);
  const [ratingComment, setRatingComment] = useState(currentUserRating?.comment ?? '');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewEditorOpen, setReviewEditorOpen] = useState(false);
  const [promptPreview, setPromptPreview] = useState<PromptPreview>(null);
  const [developerPathState, setDeveloperPathState] = useState<DeveloperPathState | null>(null);
  const [developerPathDraft, setDeveloperPathDraft] = useState('');
  const [developerBusy, setDeveloperBusy] = useState(false);
  const [developerError, setDeveloperError] = useState('');

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
    setPromptRuntimeDraft(selectedPrompt.overrideRuntime ?? selectedPrompt.runtime);
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

  useEffect(() => {
    if (!details?.installed || !developerMode.enabled) {
      setDeveloperPathState(null);
      setDeveloperPathDraft('');
      return undefined;
    }
    let cancelled = false;
    void window.forger.getDeveloperPathState(details.app.id).then((state) => {
      if (!cancelled) {
        setDeveloperPathState(state);
        setDeveloperPathDraft(state.appPathEntries.join('\n'));
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [details?.app.id, details?.installed, developerMode.enabled]);

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
  const isInstalling = details.status === 'installing' || Boolean(installProgress);
  const isOpening = openingAppIds.has(appId);
  const averageRating = 'averageRating' in details.app ? details.app.averageRating : undefined;
  const ratingsCount = 'ratingsCount' in details.app ? details.app.ratingsCount ?? 0 : 0;
  const recentRatings = 'recentRatings' in details.app ? details.app.recentRatings ?? [] : [];
  const promptTemplates = details.promptTemplates ?? [];
  const agents = details.agents ?? [];
  const promptReviews = details.promptReviews ?? [];
  const localChanges = details.localChanges ?? [];

  const actions = (
    <AppViewActions
      appId={appId}
      details={details}
      installProgress={installProgress}
      isOpening={isOpening}
      t={t}
      onInstall={onInstall}
      onUpdate={onUpdate}
      onOpen={onOpen}
      onStop={onStop}
      onRestoreUserVersion={onRestoreUserVersion}
      onResolveConflict={onResolveConflict}
      onDelete={onDelete}
      onStartLocalNetworkShare={onStartLocalNetworkShare}
      onStartRemoteNetworkShare={onStartRemoteNetworkShare}
      onStopRemoteNetworkShare={onStopRemoteNetworkShare}
      onUploadSocial={onUploadSocial}
    />
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
  const selectedPromptRuntimeFallback = selectedPrompt?.originalRuntime ?? {
    provider: 'codex' as const,
    model: selectedPrompt?.originalModel ?? codexDefaults.model,
    effort: selectedPrompt?.originalReasoningEffort ?? codexDefaults.reasoningEffort,
  };
  const runtimeEdited = Boolean(
    selectedPrompt
      && (
        promptRuntimeDraft.provider !== selectedPromptRuntimeFallback.provider
        || promptRuntimeDraft.model !== selectedPromptRuntimeFallback.model
        || promptRuntimeDraft.effort !== selectedPromptRuntimeFallback.effort
        || (promptRuntimeDraft.permissionMode ?? 'safe') !== (selectedPromptRuntimeFallback.permissionMode ?? 'safe')
      ),
  );
  const selectedPromptRuntimeSource = selectedPrompt?.runtimeSource === 'override'
    ? t.appView.promptSettingCustom
    : selectedPrompt?.runtimeSource === 'manifest'
      ? t.appView.promptSettingApp
      : t.appView.promptSettingGlobal;
  const promptModelOptions = promptRuntimeDraft.provider === 'claude' ? claudeModelOptions : modelOptions;
  const promptEffortOptions = promptRuntimeDraft.provider === 'claude' ? claudeEffortOptions : reasoningOptions;
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
                      <Chip size="small" label={promptTypeLabel(prompt.kind)} />
                      {prompt.promptKind ? <Chip size="small" variant="outlined" label={prompt.promptKind} /> : null}
                      <Chip size="small" variant="outlined" label={`${prompt.runtime.provider} · ${prompt.runtime.model} · ${prompt.runtime.effort}`} />
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
              {selectedPrompt.kind === 'agentPrompt' ? (
                <Box sx={{ border: '1px solid', borderColor: 'divider', p: 1.25, bgcolor: 'background.paper' }}>
                  <Stack spacing={0.75}>
                    {selectedPrompt.sourcePath ? (
                      <Typography variant="caption" color="text.secondary">
                        {selectedPrompt.sourcePath}
                      </Typography>
                    ) : null}
                    {selectedPrompt.declaredVariables && selectedPrompt.declaredVariables.length > 0 ? (
                      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                        {selectedPrompt.declaredVariables.map((variable) => (
                          <Chip key={variable} size="small" variant="outlined" label={variable} />
                        ))}
                      </Stack>
                    ) : null}
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
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '0.75fr minmax(0, 1fr) 0.75fr' },
                  gap: 1,
                }}
              >
                <TextField
                  select
                  size="small"
                  label={t.appView.promptProviderLabel}
                  value={promptRuntimeDraft.provider}
                  onChange={(event) => {
                    const provider = event.target.value as AgentProvider;
                    const options = provider === 'claude' ? claudeModelOptions : modelOptions;
                    const nextModel = options[0]?.realModelName ?? promptRuntimeDraft.model;
                    const nextEffort = provider === 'claude'
                      ? (claudeModelOptions[0]?.defaultEffort ?? 'medium')
                      : (modelOptions[0]?.defaultReasoningEffort ?? 'medium');
                    setPromptRuntimeDraft((current) => ({ provider, model: nextModel, effort: nextEffort, permissionMode: current.permissionMode }));
                  }}
                  helperText={runtimeEdited ? t.appView.promptSettingCustom : selectedPromptRuntimeSource}
                  fullWidth
                >
                  {providerOptions.filter((option) => option.value !== 'auto').map((option) => (
                    <MenuItem value={option.value} key={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  size="small"
                  label={t.appView.promptModelLabel}
                  value={promptRuntimeDraft.model}
                  onChange={(event) => setPromptRuntimeDraft((current) => ({ ...current, model: event.target.value }))}
                  helperText={t.appView.promptRuntimeHelper}
                  fullWidth
                >
                  {promptModelOptions.map((option) => (
                    <MenuItem value={option.realModelName} key={option.realModelName}>
                      {option.displayModelName}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  size="small"
                  label={t.appView.promptThinkingLabel}
                  value={promptRuntimeDraft.effort}
                  onChange={(event) => setPromptRuntimeDraft((current) => ({ ...current, effort: event.target.value as AgentRuntime['effort'] }))}
                  helperText={runtimeEdited ? t.appView.promptSettingCustom : selectedPromptRuntimeSource}
                  fullWidth
                >
                  {promptEffortOptions.map((option) => (
                    <MenuItem value={option.value} key={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              </Box>
              <FormControlLabel
                control={
                  <Switch
                    checked={(promptRuntimeDraft.permissionMode ?? 'safe') === 'unsafe'}
                    onChange={(event) => setPromptRuntimeDraft((current) => ({
                      ...current,
                      permissionMode: event.target.checked ? 'unsafe' : 'safe',
                    }))}
                  />
                }
                label={t.appView.promptPermissionLabel}
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
                      runtime: runtimeEdited ? promptRuntimeDraft : null,
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
                  {rating.user?.username && onOpenProfile ? (
                    <Button size="small" onClick={() => onOpenProfile(rating.user!.username!)}>
                      Ver perfil
                    </Button>
                  ) : null}
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
    </Stack>
  );

  const saveAppDeveloperPaths = async () => {
    setDeveloperBusy(true);
    setDeveloperError('');
    try {
      const state = await window.forger.updateAppDeveloperSettings({
        appId,
        pathEntries: developerPathDraft.split('\n'),
      });
      setDeveloperPathState(state);
      setDeveloperPathDraft(state.appPathEntries.join('\n'));
    } catch (error) {
      setDeveloperError(error instanceof Error ? error.message : t.settings.developerPathSaveError);
    } finally {
      setDeveloperBusy(false);
    }
  };

  const developerContent = (
    <Stack spacing={1.5}>
      <Stack spacing={0.5}>
        <Typography variant="h5">{t.settings.developerModeTitle}</Typography>
        <Typography color="text.secondary">{t.settings.developerModeDescription}</Typography>
      </Stack>
      <TextField
        label={t.settings.developerAppPathTitle}
        value={developerPathDraft}
        onChange={(event) => setDeveloperPathDraft(event.target.value)}
        fullWidth
        multiline
        minRows={4}
        helperText={t.settings.developerPathEntriesHelp}
        inputProps={{ spellCheck: false }}
        sx={{ '& textarea': { fontFamily: 'monospace', fontSize: 13 } }}
      />
      {developerError ? <Typography color="error.main" variant="body2">{developerError}</Typography> : null}
      <Button
        variant="outlined"
        disabled={developerBusy}
        onClick={() => void saveAppDeveloperPaths()}
        sx={{ alignSelf: 'flex-start' }}
      >
        {t.settings.developerPathSave}
      </Button>
      {developerPathState ? (
        <Stack spacing={1}>
          <PathPreview title={t.settings.developerRuntimePathTitle} entries={developerPathState.runtimePathEntries} />
          <PathPreview title={t.settings.developerGlobalPathTitle} entries={developerPathState.globalPathEntries} />
          <PathPreview title={t.settings.developerAppPathTitle} entries={developerPathState.appPathEntries} />
          <PathPreview title={t.settings.developerSystemPathTitle} entries={developerPathState.systemPathEntries} />
          <PathPreview title={t.settings.developerEffectivePathTitle} entries={developerPathState.effectivePathEntries} />
        </Stack>
      ) : null}
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
              color={isInstalling ? 'warning' : details.installed ? (hasError || hasConflict ? 'error' : isRunning ? 'info' : details.updateAvailable ? 'warning' : 'success') : 'default'}
              label={isInstalling ? t.actions.installing : details.installed ? (isRunning ? t.actions.running : hasConflict ? t.actions.conflict : hasError ? t.actions.error : details.updateAvailable && details.latestVersion ? t.appView.updateAvailable(details.latestVersion) : t.actions.installed) : t.actions.available}
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

      {isInstalling && installProgress ? (
        <Stack spacing={0.75} sx={{ maxWidth: 520 }}>
          <LinearProgress
            variant={typeof installProgress.progress === 'number' ? 'determinate' : 'indeterminate'}
            value={Math.min(Math.max(installProgress.progress ?? 0, 0), 100)}
            sx={{ height: 6, borderRadius: 999 }}
          />
          <Typography variant="body2" color="text.secondary">
            {installProgress.userMessage}
          </Typography>
        </Stack>
      ) : null}

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
          {developerMode.enabled && details.installed ? <Tab value="developer" label={t.settings.developerModeTitle} /> : null}
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
      {activeTab === 'developer' && developerMode.enabled && details.installed ? developerContent : null}
      <PromptPreviewDialog preview={promptPreview} t={t} onClose={() => setPromptPreview(null)} />
    </Stack>
  );
}
