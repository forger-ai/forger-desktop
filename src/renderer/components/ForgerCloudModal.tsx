import { useEffect, useState } from 'react';
import LoginRounded from '@mui/icons-material/LoginRounded';
import LogoutRounded from '@mui/icons-material/LogoutRounded';
import PersonAddAltRounded from '@mui/icons-material/PersonAddAltRounded';
import RateReviewRounded from '@mui/icons-material/RateReviewRounded';
import CloudSyncRounded from '@mui/icons-material/CloudSyncRounded';
import FeedbackRounded from '@mui/icons-material/FeedbackRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Link,
  MenuItem,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import 'flag-icons/css/flag-icons.min.css';
import type { ForgerAccountRegisterInput, ForgerAccountSession } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import iconDark from '@renderer/assets/icon-dark.svg';
import iconLight from '@renderer/assets/icon-light.svg';

interface ForgerCloudModalProps {
  open: boolean;
  t: AppDictionary;
  account: ForgerAccountSession;
  busy: boolean;
  message?: string | null;
  onClose: () => void;
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (input: ForgerAccountRegisterInput) => Promise<void>;
  onLogout: () => Promise<void>;
}

type CloudModalMode = 'intro' | 'login' | 'register';

const FALLBACK_COUNTRY_CODES = ['CL', 'US', 'AR', 'BR', 'MX', 'CO', 'PE', 'ES', 'UY', 'GB', 'CA'];

const getSupportedRegionCodes = (): string[] => {
  const intlWithSupportedValues = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };

  if (typeof intlWithSupportedValues.supportedValuesOf !== 'function') {
    return FALLBACK_COUNTRY_CODES;
  }

  try {
    return intlWithSupportedValues.supportedValuesOf('region');
  } catch {
    return FALLBACK_COUNTRY_CODES;
  }
};

const countryOptions = (() => {
  const codes = getSupportedRegionCodes();
  const displayNames = new Intl.DisplayNames([navigator.language], { type: 'region' });

  return codes
    .filter((code) => /^[A-Z]{2}$/.test(code))
    .map((code) => ({
      code,
      label: displayNames.of(code) ?? code,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, navigator.language));
})();

export function ForgerCloudModal({
  open,
  t,
  account,
  busy,
  message,
  onClose,
  onLogin,
  onRegister,
  onLogout,
}: ForgerCloudModalProps) {
  const theme = useTheme();
  const [mode, setMode] = useState<CloudModalMode>('intro');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [country, setCountry] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<ForgerAccountRegisterInput['gender'] | ''>('');

  useEffect(() => {
    if (open) {
      setMode(account.authenticated ? 'intro' : mode);
    }
  }, [account.authenticated, mode, open]);

  const submitLogin = () => {
    void onLogin(email, password);
  };

  const submitRegister = () => {
    void onRegister({
      firstName,
      lastName,
      email,
      password,
      country: country || undefined,
      age: age ? Number(age) : undefined,
      gender: gender || undefined,
    });
  };

  const openExternalLink = (url: string) => {
    void window.forger.openExternalUrl(url);
  };

  const renderCountryOption = (code: string, label: string) => (
    <Stack component="span" direction="row" spacing={1} alignItems="center">
      <Box
        component="span"
        className={`fi fi-${code.toLowerCase()}`}
        sx={{ width: 22, height: 16, borderRadius: 0.25, boxShadow: '0 0 0 1px rgba(0,0,0,0.16)' }}
      />
      <span>{label}</span>
    </Stack>
  );

  const cloudCards = [
    { icon: <RateReviewRounded color="primary" />, title: t.cloud.cards.reviews.title, body: t.cloud.cards.reviews.body },
    { icon: <FeedbackRounded color="primary" />, title: t.cloud.cards.feedback.title, body: t.cloud.cards.feedback.body },
    { icon: <CloudSyncRounded color="primary" />, title: t.cloud.cards.sync.title, body: t.cloud.cards.sync.body },
  ];
  const formTitle = mode === 'login' ? t.cloud.loginTitle : mode === 'register' ? t.cloud.registerTitle : null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ position: 'relative', px: 4, pt: 4, pb: 0.5 }}>
        <IconButton
          aria-label={t.actions.close}
          onClick={onClose}
          size="small"
          sx={{
            position: 'absolute',
            right: 12,
            top: 12,
            color: 'text.secondary',
            '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
          }}
        >
          <CloseRounded fontSize="small" />
        </IconButton>
        <Stack spacing={0.5} alignItems="center" textAlign="center">
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="center">
            <Box
              component="img"
              src={theme.palette.mode === 'dark' ? iconDark : iconLight}
              alt="Forger"
              sx={{ width: 32, height: 32 }}
            />
            <Stack direction="row" spacing={0.5} alignItems="baseline">
              <Typography
                component="span"
                sx={{ fontFamily: 'Poppins, sans-serif', fontSize: 25, fontWeight: 800, letterSpacing: '0.18em' }}
              >
                FORGER
              </Typography>
              <Typography
                component="span"
                color="text.secondary"
                sx={{ fontFamily: 'Poppins, sans-serif', fontSize: 14, fontWeight: 700 }}
              >
                Cloud
              </Typography>
            </Stack>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {t.cloud.tagline}
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ px: 4, pb: account.authenticated ? 2 : 3 }}>
        <Stack
          spacing={2}
          alignItems="center"
          sx={{
            minHeight: mode === 'login' ? 430 : undefined,
            justifyContent: mode === 'login' ? 'center' : undefined,
          }}
        >
          {message ? <Alert severity={account.authenticated ? 'success' : 'info'}>{message}</Alert> : null}
          {account.authenticated && account.user ? (
            <Stack spacing={1.5} alignItems="center" textAlign="center">
              <Avatar
                sx={{
                  width: 54,
                  height: 54,
                  bgcolor: 'background.paper',
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box
                  component="img"
                  src={theme.palette.mode === 'dark' ? iconDark : iconLight}
                  alt="Forger"
                  sx={{ width: 34, height: 34 }}
                />
              </Avatar>
              <Typography fontWeight={700}>{t.cloud.signedInAs(account.user.email)}</Typography>
              <Typography color="text.secondary">
                {account.user.confirmed ? t.cloud.confirmed : t.cloud.confirmationRequired}
              </Typography>
            </Stack>
          ) : (
            <>
              {mode === 'intro' ? (
                <Stack spacing={2.5}>
                  <Box
                    sx={{
                      display: 'grid',
                      gap: 1.25,
                      gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
                    }}
                  >
                    {cloudCards.map((card) => (
                      <Box
                        key={card.title}
                        sx={{
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1,
                          p: 1.5,
                          bgcolor: 'background.paper',
                        }}
                      >
                        <Stack spacing={1}>
                          {card.icon}
                          <Typography fontWeight={700}>{card.title}</Typography>
                          <Typography variant="body2" color="text.secondary">{card.body}</Typography>
                        </Stack>
                      </Box>
                    ))}
                  </Box>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} justifyContent="center">
                    <Button variant="contained" size="large" onClick={() => setMode('login')} startIcon={<LoginRounded />}>
                      {t.cloud.login}
                    </Button>
                    <Button variant="outlined" size="large" onClick={() => setMode('register')} startIcon={<PersonAddAltRounded />}>
                      {t.cloud.register}
                    </Button>
                  </Stack>
                </Stack>
              ) : null}

              {mode === 'login' ? (
                <Stack spacing={1.5} alignItems="center" sx={{ width: 'min(100%, 420px)' }}>
                  {formTitle ? (
                    <Typography variant="h6" color="text.primary" textAlign="center" sx={{ mb: 0.5 }}>
                      {formTitle}
                    </Typography>
                  ) : null}
                  <TextField label={t.settings.emailLabel} type="email" value={email} onChange={(event) => setEmail(event.target.value)} fullWidth />
                  <TextField label={t.settings.passwordLabel} type="password" value={password} onChange={(event) => setPassword(event.target.value)} fullWidth />
                  <Button variant="contained" startIcon={<LoginRounded />} onClick={submitLogin} disabled={busy || !email.trim() || !password.trim()} fullWidth>
                    {t.cloud.login}
                  </Button>
                  <Divider flexItem>{t.cloud.noAccount}</Divider>
                  <Button variant="text" onClick={() => setMode('register')}>
                    {t.cloud.register}
                  </Button>
                </Stack>
              ) : null}

              {mode === 'register' ? (
                <Stack spacing={1.5} sx={{ width: 'min(100%, 520px)' }}>
                  {formTitle ? (
                    <Typography variant="h6" color="text.primary" textAlign="center" sx={{ mb: 0.5 }}>
                      {formTitle}
                    </Typography>
                  ) : null}
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField label={t.cloud.firstName} value={firstName} onChange={(event) => setFirstName(event.target.value)} fullWidth />
                    <TextField label={t.cloud.lastName} value={lastName} onChange={(event) => setLastName(event.target.value)} fullWidth />
                  </Stack>
                  <TextField label={t.settings.emailLabel} type="email" value={email} onChange={(event) => setEmail(event.target.value)} fullWidth />
                  <TextField label={t.settings.passwordLabel} type="password" value={password} onChange={(event) => setPassword(event.target.value)} fullWidth />
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField select label={t.cloud.country} value={country} onChange={(event) => setCountry(event.target.value)} fullWidth>
                      <MenuItem value="">{t.cloud.countryAuto}</MenuItem>
                      {countryOptions.map((option) => (
                        <MenuItem key={option.code} value={option.code}>
                          {renderCountryOption(option.code, option.label)}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField label={t.cloud.age} type="number" value={age} onChange={(event) => setAge(event.target.value)} fullWidth />
                  </Stack>
                  <TextField select label={t.cloud.gender} value={gender} onChange={(event) => setGender(event.target.value as ForgerAccountRegisterInput['gender'])} fullWidth>
                    <MenuItem value="">{t.cloud.preferNotToSay}</MenuItem>
                    <MenuItem value="male">{t.cloud.genders.male}</MenuItem>
                    <MenuItem value="female">{t.cloud.genders.female}</MenuItem>
                    <MenuItem value="other">{t.cloud.genders.other}</MenuItem>
                  </TextField>
                  <Button variant="contained" startIcon={<PersonAddAltRounded />} onClick={submitRegister} disabled={busy || !firstName.trim() || !email.trim() || !password.trim()} fullWidth>
                    {t.cloud.register}
                  </Button>
                  <Divider>{t.cloud.hasAccount}</Divider>
                  <Button variant="text" onClick={() => setMode('login')}>
                    {t.cloud.login}
                  </Button>
                </Stack>
              ) : null}
            </>
          )}
          <Stack direction="row" spacing={1.5} justifyContent="center" sx={{ pt: 1 }}>
            <Link component="button" type="button" onClick={() => openExternalLink(t.cloud.privacyUrl)} underline="hover" variant="caption">
              <Stack component="span" direction="row" spacing={0.5} alignItems="center">
                <span>{t.cloud.privacyLink}</span>
                <OpenInNewRounded sx={{ fontSize: 14 }} />
              </Stack>
            </Link>
            <Link component="button" type="button" onClick={() => openExternalLink(t.cloud.termsUrl)} underline="hover" variant="caption">
              <Stack component="span" direction="row" spacing={0.5} alignItems="center">
                <span>{t.cloud.termsLink}</span>
                <OpenInNewRounded sx={{ fontSize: 14 }} />
              </Stack>
            </Link>
          </Stack>
        </Stack>
      </DialogContent>
      {account.authenticated ? (
        <DialogActions sx={{ px: 4, pb: 3, justifyContent: 'center' }}>
          <Button startIcon={<LogoutRounded />} onClick={() => void onLogout()} disabled={busy}>
            {t.cloud.logout}
          </Button>
        </DialogActions>
      ) : null}
    </Dialog>
  );
}
