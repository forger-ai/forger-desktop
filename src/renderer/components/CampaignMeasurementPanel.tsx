import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import { isCampaignCode, type CampaignCode, type CampaignMeasurementStatus } from '@shared/campaign-measurement';
import { initializeCampaignMeasurement, MEASUREMENT_CHANGED_EVENT, MEASUREMENT_LINK_EVENT } from '@renderer/campaign-measurement';

const copy = {
  en: {
    title: 'Optional measurement',
    body: 'If you allow it, Forger sends your campaign source, first open and first app creation to PostHog, with a random profile identifier and your Forger version/platform. No files, chats, app content or email addresses. Forger works the same if you decline.',
    eligibility: 'Only new profiles that opt in during their first session are counted. Earlier activity is not sent. Website permission does not enable this setting.',
    code: 'Campaign code (optional)', codeHelp: 'Add the optional campaign code before allowing measurement.', allow: 'Allow measurement', decline: 'No thanks', off: 'Turn off measurement',
    enabled: 'Measurement is enabled. This does not confirm that any measurement has been received.',
    disabled: 'Measurement is off. This profile will not be counted as a new acquisition after declining or withdrawing.',
    withdrawal: 'Turning this off stops future sending and clears unsent measurements and the local random identifier. It does not delete data already sent.',
    locked: 'The campaign source is already fixed. A later code cannot change earlier measurements.',
    invalid: 'This campaign code is not recognized. Use the code shown on the Forger campaign page, or leave it empty.',
    error: 'Could not save the choice. If you turned measurement off, sending is paused for this session. Retry before closing Forger to save withdrawal.',
    unavailable: 'Measurement is disabled in development and test builds.', close: 'Continue',
  },
  es: {
    title: 'Medición opcional',
    body: 'Si aceptas, Forger envía a PostHog la campaña de origen, primera apertura y primera app creada, con un identificador aleatorio del perfil y la versión/plataforma de Forger. Sin archivos, chats, contenido de apps ni correos. Forger funciona igual si rechazas.',
    eligibility: 'Solo contamos perfiles nuevos que aceptan durante su primera sesión. No enviamos actividad anterior. El permiso de la web no activa esta opción.',
    code: 'Código de campaña (opcional)', codeHelp: 'Agrega el código opcional antes de permitir la medición.', allow: 'Permitir medición', decline: 'No, gracias', off: 'Desactivar medición',
    enabled: 'La medición está activada. Esto no confirma que se haya recibido ninguna medición.',
    disabled: 'La medición está desactivada. Este perfil no se contará como una adquisición nueva después de rechazar o retirar el permiso.',
    withdrawal: 'Al desactivarla dejamos de enviar y borramos las mediciones pendientes y el identificador aleatorio local. No se eliminan los datos ya enviados.',
    locked: 'El origen de la campaña ya está fijado. Un código posterior no modifica las mediciones anteriores.',
    invalid: 'No reconocemos este código. Usa el código de la página de campaña de Forger o deja el campo vacío.',
    error: 'No pudimos guardar la elección. Si desactivaste la medición, el envío está pausado durante esta sesión. Reintenta antes de cerrar Forger para guardar la retirada.',
    unavailable: 'La medición está desactivada en versiones de desarrollo y pruebas.', close: 'Continuar',
  },
};

export function CampaignMeasurementPanel({ locale, initialCode }: { locale: string; initialCode?: CampaignCode }) {
  const t = copy[locale === 'es' ? 'es' : 'en'];
  const [status, setStatus] = useState<CampaignMeasurementStatus | null>(null);
  const [code, setCode] = useState(initialCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const update = (value: CampaignMeasurementStatus) => {
      if (!live) return;
      setStatus(value);
      if (value.attributionLocked) setCode(value.campaignCode ?? '');
      else if (value.campaignCode) setCode(value.campaignCode);
    };
    void initializeCampaignMeasurement().then(update).catch(() => { if (live) setError(t.error); });
    const refresh = () => { void window.forger.getCampaignMeasurementStatus().then(update).catch(() => undefined); };
    window.addEventListener(MEASUREMENT_CHANGED_EVENT, refresh);
    return () => { live = false; window.removeEventListener(MEASUREMENT_CHANGED_EVENT, refresh); };
  }, [t.error]);
  const choose = async (enabled: boolean) => {
    if (enabled && code && !isCampaignCode(code)) { setError(t.invalid); return; }
    setBusy(true); setError('');
    try {
      const value = await window.forger.setCampaignMeasurementConsent(enabled
        ? { enabled, campaignCode: isCampaignCode(code) ? code : null } : { enabled });
      setStatus(value);
      window.dispatchEvent(new Event(MEASUREMENT_CHANGED_EVENT));
    } catch { setError(t.error); }
    finally { setBusy(false); }
  };
  return <Stack spacing={1.25}>
    <Typography variant="h6">{t.title}</Typography>
    <Typography variant="body2" color="text.secondary">{t.body}</Typography>
    <Typography variant="body2" color="text.secondary">{t.eligibility}</Typography>
    <Typography variant="caption" color="text.secondary">{t.withdrawal}</Typography>
    {status && !status.available ? <Alert severity="info">{t.unavailable}</Alert> : null}
    {status?.consent === 'enabled' ? <Alert severity="info">{t.enabled}</Alert> : null}
    {status?.consent === 'disabled' ? <Alert severity="info">{t.disabled}</Alert> : null}
    <TextField size="small" label={t.code} helperText={t.codeHelp} value={code} onChange={(event) => setCode(event.target.value)}
      disabled={busy || !status?.available || status.attributionLocked} inputProps={{ maxLength: 32, autoComplete: 'off' }} />
    {status?.attributionLocked ? <Typography variant="caption">{t.locked}</Typography> : null}
    {error ? <Alert severity="error">{error}</Alert> : null}
    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
      {status?.consent === 'enabled'
        ? <Button variant="outlined" disabled={busy} onClick={() => void choose(false)}>{t.off}</Button>
        : <>
          <Button variant="outlined" disabled={busy || !status} onClick={() => void choose(false)}>{t.decline}</Button>
          <Button variant="outlined" disabled={busy || !status?.available} onClick={() => void choose(true)}>{t.allow}</Button>
        </>}
    </Stack>
  </Stack>;
}

export function CampaignMeasurementDialog({ locale }: { locale: string }) {
  const [code, setCode] = useState<CampaignCode | null>(null);
  const t = copy[locale === 'es' ? 'es' : 'en'];
  useEffect(() => {
    const receive = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (isCampaignCode(value)) setCode(value);
    };
    window.addEventListener(MEASUREMENT_LINK_EVENT, receive);
    return () => window.removeEventListener(MEASUREMENT_LINK_EVENT, receive);
  }, []);
  return <Dialog open={code !== null} onClose={() => setCode(null)} fullWidth maxWidth="sm" sx={{ zIndex: 1600 }}>
    <DialogTitle>{t.title}</DialogTitle>
    <DialogContent>{code ? <CampaignMeasurementPanel key={code} locale={locale} initialCode={code} /> : null}
      <Button onClick={() => setCode(null)} sx={{ mt: 2 }}>{t.close}</Button>
    </DialogContent>
  </Dialog>;
}
