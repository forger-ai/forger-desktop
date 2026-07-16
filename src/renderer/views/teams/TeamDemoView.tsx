import { useState, type FormEvent } from 'react';
import { Alert, Box, Button, Card, CardContent, Stack, TextField, Typography } from '@mui/material';
import type { TeamDemoRequestInput, TeamDemoRequestResult } from '@shared/types';
import type { Locale } from '@renderer/i18n';
import { getTeamDemoCopy } from './teamDemoCopy';

interface TeamDemoViewProps {
  locale: Locale;
  onRequestDemo: (input: TeamDemoRequestInput) => Promise<TeamDemoRequestResult>;
}

const emptyForm: TeamDemoRequestInput = { name: '', email: '', phone: '', useCase: '', website: '' };

export function TeamDemoView({ locale, onRequestDemo }: TeamDemoViewProps) {
  const t = getTeamDemoCopy(locale);
  const [form, setForm] = useState<TeamDemoRequestInput>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TeamDemoRequestResult | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      setResult(await onRequestDemo(form));
    } catch {
      setResult({ success: false, userMessage: t.error, technicalCode: 'team_demo_request_failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 1040, mx: 'auto', py: { xs: 1, md: 4 } }}>
      <Stack spacing={3}>
        <Stack spacing={1} sx={{ maxWidth: 760 }}>
          <Typography variant="overline" color="primary.main" fontWeight={700}>{t.eyebrow}</Typography>
          <Typography variant="h3">{t.heading}</Typography>
          <Typography variant="h6" color="text.secondary" fontWeight={400}>{t.body}</Typography>
        </Stack>

        <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' } }}>
          {t.capabilities.map(([title, description]) => (
            <Card key={title} variant="outlined">
              <CardContent>
                <Stack spacing={0.75}>
                  <Typography variant="subtitle1" fontWeight={700}>{title}</Typography>
                  <Typography variant="body2" color="text.secondary">{description}</Typography>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Box>

        <Card variant="outlined" sx={{ maxWidth: 760 }}>
          <CardContent>
            <Stack component="form" spacing={2} onSubmit={submit}>
              <Stack spacing={0.5}>
                <Typography variant="h5">{t.formTitle}</Typography>
                <Typography color="text.secondary">{t.formBody}</Typography>
              </Stack>
              <TextField required label={t.name} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
              <TextField required type="email" label={t.email} value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
              <TextField required type="tel" label={t.phone} value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} />
              <TextField required multiline minRows={4} label={t.useCase} value={form.useCase} onChange={(event) => setForm((current) => ({ ...current, useCase: event.target.value }))} />
              <TextField
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={form.website ?? ''}
                onChange={(event) => setForm((current) => ({ ...current, website: event.target.value }))}
                sx={{ position: 'absolute', left: -10000, width: 1, height: 1, overflow: 'hidden' }}
              />
              {result ? <Alert severity={result.success ? 'success' : 'error'}>{result.success ? t.success : result.userMessage ?? t.error}</Alert> : null}
              <Button type="submit" variant="contained" disabled={submitting} sx={{ alignSelf: 'flex-start' }}>
                {submitting ? t.submitting : t.submit}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    </Box>
  );
}
