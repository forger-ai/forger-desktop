import { useId, useMemo, useState } from 'react';
import FeedbackRounded from '@mui/icons-material/FeedbackRounded';
import {
  Alert,
  Button,
  Card,
  CardContent,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { CatalogApp, FailureDiagnosticFields, SubmitProductFeedbackInput } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface FeedbackViewProps {
  apps: CatalogApp[];
  t: AppDictionary;
  desktopVersion?: string;
  onSubmitFeedback: (input: SubmitProductFeedbackInput) => Promise<{ success: boolean } & FailureDiagnosticFields>;
}

export function FeedbackView({ apps, t, desktopVersion, onSubmitFeedback }: FeedbackViewProps) {
  const targetLabelId = useId();
  const appLabelId = useId();
  const kindLabelId = useId();
  const appOptions = useMemo(
    () => apps.filter((app) => app.status !== 'not_installed' || app.catalogStatus === 'beta' || app.catalogStatus === 'production' || app.catalogStatus === 'coming'),
    [apps],
  );
  const [target, setTarget] = useState<'forger' | 'app'>('forger');
  const [appId, setAppId] = useState(appOptions[0]?.id ?? '');
  const [kind, setKind] = useState<SubmitProductFeedbackInput['kind']>('other');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const selectedApp = appOptions.find((app) => app.id === appId);
  const bodyInvalid = body.trim().length === 0;
  const appTargetInvalid = target === 'app' && !appId;

  const submit = async () => {
    setBusy(true);
    try {
      const result = await onSubmitFeedback({
        target,
        appId: target === 'app' ? appId : undefined,
        kind,
        body: body.trim(),
        surface: 'feedback',
        platform: navigator.platform,
        desktopVersion,
        appVersionLabel: target === 'app' ? selectedApp?.latestVersion ?? selectedApp?.version : undefined,
      });
      if (result.success) {
        setSubmitted(true);
        setBody('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={2.5} data-onboarding-target="feedback-view">
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.feedback.title}</Typography>
        <Typography color="text.secondary">{t.sections.feedback.subtitle}</Typography>
      </Stack>

      {submitted ? <Alert severity="success">{t.sections.feedback.sent}</Alert> : null}

      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1.25} alignItems="center">
              <FeedbackRounded color="primary" />
              <Typography variant="h6">{t.sections.feedback.formTitle}</Typography>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <FormControl size="small" fullWidth>
                <InputLabel id={targetLabelId}>{t.sections.feedback.targetLabel}</InputLabel>
                <Select
                  labelId={targetLabelId}
                  label={t.sections.feedback.targetLabel}
                  value={target}
                  onChange={(event) => {
                    setTarget(event.target.value as 'forger' | 'app');
                    setSubmitted(false);
                  }}
                >
                  <MenuItem value="forger">{t.sections.feedback.targets.forger}</MenuItem>
                  <MenuItem value="app">{t.sections.feedback.targets.app}</MenuItem>
                </Select>
              </FormControl>
              {target === 'app' ? (
                <FormControl size="small" fullWidth>
                  <InputLabel id={appLabelId}>{t.sections.feedback.appLabel}</InputLabel>
                  <Select
                    labelId={appLabelId}
                    label={t.sections.feedback.appLabel}
                    value={appId}
                    onChange={(event) => {
                      setAppId(event.target.value);
                      setSubmitted(false);
                    }}
                  >
                    {appOptions.map((app) => (
                      <MenuItem value={app.id} key={app.id}>
                        {app.name ?? app.id}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              ) : null}
            </Stack>
            <FormControl size="small" fullWidth>
              <InputLabel id={kindLabelId}>{t.sections.feedback.kindLabel}</InputLabel>
              <Select
                labelId={kindLabelId}
                label={t.sections.feedback.kindLabel}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as SubmitProductFeedbackInput['kind']);
                  setSubmitted(false);
                }}
              >
                <MenuItem value="error">{t.sections.feedback.kinds.error}</MenuItem>
                <MenuItem value="confusing">{t.sections.feedback.kinds.confusing}</MenuItem>
                <MenuItem value="feature_request">{t.sections.feedback.kinds.featureRequest}</MenuItem>
                <MenuItem value="would_use_if">{t.sections.feedback.kinds.wouldUseIf}</MenuItem>
                <MenuItem value="would_not_use_because">{t.sections.feedback.kinds.wouldNotUseBecause}</MenuItem>
                <MenuItem value="other">{t.sections.feedback.kinds.other}</MenuItem>
              </Select>
            </FormControl>
            <TextField
              label={t.sections.feedback.bodyLabel}
              value={body}
              onChange={(event) => {
                setSubmitted(false);
                setBody(event.target.value);
              }}
              fullWidth
              multiline
              minRows={5}
              helperText={t.sections.feedback.bodyHelper}
            />
            <Button
              variant="contained"
              disabled={bodyInvalid || appTargetInvalid || busy}
              onClick={() => void submit()}
              sx={{ alignSelf: 'flex-start' }}
            >
              {busy ? t.sections.feedback.sending : t.sections.feedback.send}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
