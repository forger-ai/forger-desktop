import { useId, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, FormControlLabel, Stack, Typography } from '@mui/material';
import { CampaignMeasurementDetails } from './CampaignMeasurementPanel';
import type { WelcomeSharingState } from '@renderer/tour/useWelcomeSharing';

const copy = {
  en: {
    label: 'Share usage data without private information',
    more: 'Learn more…', less: 'Show less',
    settings: 'Sharing is optional. You can change this choice in Settings.',
    unavailable: 'Sharing is unavailable in this version. You can continue without sharing data.',
    loadFailed: 'We could not check your sharing preference. You can continue and review it in Settings.',
    error: 'Could not save your choice. Try again.',
    withoutSaving: 'Continue without saving',
  },
  es: {
    label: 'Compartir datos de uso sin información privada',
    more: 'Ver más…', less: 'Ver menos',
    settings: 'Compartir es opcional. Puedes cambiar esta elección en Configuración.',
    unavailable: 'Esta versión no permite compartir estos datos. Puedes continuar sin compartirlos.',
    loadFailed: 'No pudimos consultar tu preferencia. Puedes continuar y revisarla en Configuración.',
    error: 'No pudimos guardar tu elección. Intenta de nuevo.',
    withoutSaving: 'Continuar sin guardar',
  },
};

export function WelcomeSharingOption({ locale, sharing }: { locale: string; sharing: WelcomeSharingState }) {
  const t = copy[locale === 'es' ? 'es' : 'en'];
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <Stack spacing={0.5}>
    <FormControlLabel sx={{ m: 0, alignItems: 'flex-start' }}
      control={<Checkbox checked={sharing.checked} disabled={sharing.checkboxDisabled}
        onChange={(_, checked) => sharing.setChecked(checked)} sx={{ py: 0.5 }} />}
      label={<Typography variant="body2" sx={{ pt: 0.5 }}>{t.label}</Typography>} />
    <Button size="small" sx={{ alignSelf: 'flex-start', ml: 4 }}
      aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}>
      {expanded ? t.less : t.more}
    </Button>
    <Collapse in={expanded} unmountOnExit>
      <Stack id={detailsId} spacing={1.25} sx={{ pt: 1 }}>
        <CampaignMeasurementDetails locale={locale} />
        <Typography variant="body2" color="text.secondary">{t.settings}</Typography>
        {sharing.loadFailed ? <Typography variant="body2" color="text.secondary">{t.loadFailed}</Typography> : null}
        {sharing.unavailable ? <Typography variant="body2" color="text.secondary">{t.unavailable}</Typography> : null}
      </Stack>
    </Collapse>
    {sharing.saveFailed ? <Alert severity="error">
      {t.error}
      <Button size="small" color="inherit" onClick={sharing.continueWithoutSaving} sx={{ display: 'block', mt: 0.5 }}>
        {t.withoutSaving}
      </Button>
    </Alert> : null}
  </Stack>;
}
