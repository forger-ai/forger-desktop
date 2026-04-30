import { useEffect, useState } from 'react';
import LoginRounded from '@mui/icons-material/LoginRounded';
import LogoutRounded from '@mui/icons-material/LogoutRounded';
import PersonAddAltRounded from '@mui/icons-material/PersonAddAltRounded';
import RateReviewRounded from '@mui/icons-material/RateReviewRounded';
import CloudSyncRounded from '@mui/icons-material/CloudSyncRounded';
import FeedbackRounded from '@mui/icons-material/FeedbackRounded';
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
  Link,
  MenuItem,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
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

const flagFromCountryCode = (countryCode: string): string => {
  const normalized = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return '';
  }
  return normalized
    .split('')
    .map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0)))
    .join('');
};

const countryOptions = (() => {
  const intlWithSupportedValues = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  const codes = typeof intlWithSupportedValues.supportedValuesOf === 'function'
    ? intlWithSupportedValues.supportedValuesOf('region')
    : FALLBACK_COUNTRY_CODES;
  const displayNames = new Intl.DisplayNames([navigator.language], { type: 'region' });

  return codes
    .filter((code) => /^[A-Z]{2}$/.test(code))
    .map((code) => ({
      code,
      label: displayNames.of(code) ?? code,
      flag: flagFromCountryCode(code),
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

  const cloudCards = [
    { icon: <RateReviewRounded color="primary" />, title: t.cloud.cards.reviews.title, body: t.cloud.cards.reviews.body },
    { icon: <FeedbackRounded color="primary" />, title: t.cloud.cards.feedback.title, body: t.cloud.cards.feedback.body },
    { icon: <CloudSyncRounded color="primary" />, title: t.cloud.cards.sync.title, body: t.cloud.cards.sync.body },
  ];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1.5} alignItems="center">
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
          <Stack>
            <Typography variant="h5">{t.cloud.title}</Typography>
            <Typography variant="body2" color="text.secondary">
              {mode === 'intro' ? t.cloud.body : mode === 'login' ? t.cloud.loginTitle : t.cloud.registerTitle}
            </Typography>
          </Stack>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {message ? <Alert severity={account.authenticated ? 'success' : 'info'}>{message}</Alert> : null}
          {account.authenticated && account.user ? (
            <Stack spacing={1.5}>
              <Typography fontWeight={700}>{t.cloud.signedInAs(account.user.email)}</Typography>
              <Typography color="text.secondary">
                {account.user.confirmed ? t.cloud.confirmed : t.cloud.confirmationRequired}
              </Typography>
            </Stack>
          ) : (
            <>
              {mode === 'intro' ? (
                <Stack spacing={2}>
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
                  <Button variant="contained" size="large" onClick={() => setMode('login')} startIcon={<LoginRounded />} sx={{ alignSelf: 'center' }}>
                    {t.cloud.loginOrRegister}
                  </Button>
                </Stack>
              ) : null}

              {mode === 'login' ? (
                <Stack spacing={1.5} sx={{ maxWidth: 360, mx: 'auto', width: '100%' }}>
                  <TextField label={t.settings.emailLabel} type="email" value={email} onChange={(event) => setEmail(event.target.value)} fullWidth />
                  <TextField label={t.settings.passwordLabel} type="password" value={password} onChange={(event) => setPassword(event.target.value)} fullWidth />
                  <Button variant="contained" startIcon={<LoginRounded />} onClick={submitLogin} disabled={busy || !email.trim() || !password.trim()} fullWidth>
                    {t.cloud.login}
                  </Button>
                  <Divider>{t.cloud.noAccount}</Divider>
                  <Button variant="text" onClick={() => setMode('register')}>
                    {t.cloud.register}
                  </Button>
                </Stack>
              ) : null}

              {mode === 'register' ? (
                <Stack spacing={1.5}>
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
                          {option.flag} {option.label}
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
            <Link href={t.cloud.privacyUrl} target="_blank" rel="noreferrer" underline="hover" variant="caption">
              {t.cloud.privacyLink}
            </Link>
            <Link href={t.cloud.termsUrl} target="_blank" rel="noreferrer" underline="hover" variant="caption">
              {t.cloud.termsLink}
            </Link>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.secrets.close}</Button>
        {account.authenticated ? (
          <Button startIcon={<LogoutRounded />} onClick={() => void onLogout()} disabled={busy}>
            {t.cloud.logout}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
