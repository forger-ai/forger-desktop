import { useEffect, useState } from 'react';
import LoginRounded from '@mui/icons-material/LoginRounded';
import LogoutRounded from '@mui/icons-material/LogoutRounded';
import PersonAddAltRounded from '@mui/icons-material/PersonAddAltRounded';
import GoogleIcon from '@mui/icons-material/Google';
import AppleIcon from '@mui/icons-material/Apple';
import EditRounded from '@mui/icons-material/EditRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import RateReviewRounded from '@mui/icons-material/RateReviewRounded';
import PeopleAltRounded from '@mui/icons-material/PeopleAltRounded';
import SmartphoneRounded from '@mui/icons-material/SmartphoneRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import countries from 'i18n-iso-countries';
import countriesEn from 'i18n-iso-countries/langs/en.json';
import countriesEs from 'i18n-iso-countries/langs/es.json';
import {
  Alert,
  Autocomplete,
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
  onGoogleLogin: () => Promise<void>;
  onAppleLogin: () => Promise<void>;
  onRegister: (input: ForgerAccountRegisterInput) => Promise<boolean>;
  onUpdateUsername: (username: string) => Promise<boolean>;
  onLogout: () => Promise<void>;
}

type CloudModalMode = 'intro' | 'login' | 'register';

countries.registerLocale(countriesEn);
countries.registerLocale(countriesEs);

const PRIORITY_COUNTRY_CODES = ['CL', 'PE', 'AR', 'CO', 'UY'];
const SOUTH_AMERICA_COUNTRY_CODES = ['BO', 'BR', 'EC', 'FK', 'GF', 'GY', 'PY', 'SR', 'VE'];

type CountryOption = {
  code: string;
  label: string;
};

const countrySortGroup = (code: string): number => {
  if (PRIORITY_COUNTRY_CODES.includes(code)) {
    return 0;
  }
  if (SOUTH_AMERICA_COUNTRY_CODES.includes(code)) {
    return 1;
  }
  return 2;
};

const countryOptions = (() => {
  const codes = Object.keys(countries.getAlpha2Codes());
  const displayNames = new Intl.DisplayNames([navigator.language], { type: 'region' });

  return codes
    .filter((code) => /^[A-Z]{2}$/.test(code))
    .map((code) => ({
      code,
      label: displayNames.of(code) ?? code,
    }))
    .sort((a, b) => {
      const groupDifference = countrySortGroup(a.code) - countrySortGroup(b.code);
      if (groupDifference !== 0) {
        return groupDifference;
      }

      const priorityDifference = PRIORITY_COUNTRY_CODES.indexOf(a.code) - PRIORITY_COUNTRY_CODES.indexOf(b.code);
      if (countrySortGroup(a.code) === 0 && priorityDifference !== 0) {
        return priorityDifference;
      }

      return a.label.localeCompare(b.label, navigator.language);
    });
})();

export function ForgerCloudModal({
  open,
  t,
  account,
  busy,
  message,
  onClose,
  onLogin,
  onGoogleLogin,
  onAppleLogin,
  onRegister,
  onUpdateUsername,
  onLogout,
}: ForgerCloudModalProps) {
  const theme = useTheme();
  const [mode, setMode] = useState<CloudModalMode>('intro');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [country, setCountry] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<ForgerAccountRegisterInput['gender'] | ''>('');
  const [profileUsername, setProfileUsername] = useState('');
  const [editingUsername, setEditingUsername] = useState(false);

  useEffect(() => {
    if (open) {
      setMode(account.authenticated ? 'intro' : mode);
      if (account.user?.username) {
        setProfileUsername(account.user.username);
      }
      setEditingUsername(false);
    }
  }, [account.authenticated, account.user?.username, mode, open]);

  const submitLogin = () => {
    void onLogin(email, password);
  };

  const updateAge = (value: string) => {
    setAge(value.replace(/\D/g, '').slice(0, 3));
  };

  const submitRegister = async () => {
    const success = await onRegister({
      firstName,
      lastName,
      username,
      email,
      password,
      country: country || undefined,
      age: age ? Number(age) : undefined,
      gender: gender || undefined,
    });

    if (success) {
      setPassword('');
      setMode('login');
    }
  };

  const submitUsernameUpdate = async () => {
    const success = await onUpdateUsername(profileUsername);
    if (success) {
      setEditingUsername(false);
    }
  };

  const openExternalLink = (url: string) => {
    void window.forger.openExternalUrl(url);
  };

  const selectedCountry = countryOptions.find((option) => option.code === country) ?? null;
  const usernameAvailableAt = account.user?.usernameChangeAvailableAt ? new Date(account.user.usernameChangeAvailableAt) : null;
  const usernameChangeBlocked = Boolean(usernameAvailableAt && usernameAvailableAt.getTime() > Date.now());
  const usernameAvailableLabel = usernameAvailableAt && !Number.isNaN(usernameAvailableAt.getTime())
    ? usernameAvailableAt.toLocaleDateString('es-CL', { dateStyle: 'medium' })
    : null;

  const renderCountryOption = (code: string, label: string) => (
    <Stack component="span" direction="row" spacing={1} alignItems="center">
      <Box
        component="span"
        className={`fi fi-${code.toLowerCase()}`}
        sx={{ width: 22, height: 16, borderRadius: 0.25, boxShadow: '0 0 0 1px rgba(0,0,0,0.16)' }}
      />
      <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</Box>
    </Stack>
  );

  const cloudCards = [
    { icon: <RateReviewRounded color="primary" />, title: t.cloud.cards.reviews.title, body: t.cloud.cards.reviews.body },
    { icon: <PeopleAltRounded color="primary" />, title: t.cloud.cards.feedback.title, body: t.cloud.cards.feedback.body },
    { icon: <SmartphoneRounded color="primary" />, title: t.cloud.cards.sync.title, body: t.cloud.cards.sync.body },
  ];
  const formTitle = mode === 'login' ? t.cloud.loginTitle : mode === 'register' ? t.cloud.registerTitle : null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ position: 'relative', px: 4, pt: 4, pb: 3 }}>
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
        <Stack spacing={0.25} alignItems="center" textAlign="center">
          <Stack direction="row" spacing={0.75} alignItems="center" justifyContent="center">
            <Box
              component="img"
              src={theme.palette.mode === 'dark' ? iconDark : iconLight}
              alt="Forger"
              sx={{ width: 32, height: 32 }}
            />
            <Stack direction="row" spacing={0.1} alignItems="baseline">
              <Typography
                component="span"
                sx={{ fontFamily: 'Poppins, sans-serif', fontSize: 25, fontWeight: 800, letterSpacing: '0.1em' }}
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
      <DialogContent sx={{ px: 4, pt: 0, pb: account.authenticated ? 2 : 3 }}>
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
            <Stack spacing={1.5} alignItems="center" textAlign="center" sx={{ width: 'min(100%, 420px)' }}>
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
              <Stack spacing={1} alignItems="center" sx={{ width: '100%' }}>
                {editingUsername ? (
                  <Stack spacing={1} sx={{ width: '100%' }}>
                    <TextField
                      label={t.cloud.username}
                      value={profileUsername}
                      onChange={(event) => setProfileUsername(event.target.value)}
                      placeholder={t.cloud.usernamePlaceholder}
                      helperText={usernameChangeBlocked && usernameAvailableLabel ? `Disponible desde el ${usernameAvailableLabel}.` : t.cloud.usernameHelp}
                      disabled={busy}
                      fullWidth
                    />
                    <Stack direction="row" spacing={1} justifyContent="center">
                      <Button
                        variant="contained"
                        size="small"
                        startIcon={<SaveRounded />}
                        onClick={() => void submitUsernameUpdate()}
                        disabled={busy || usernameChangeBlocked || !profileUsername.trim()}
                      >
                        {t.cloud.saveUsername}
                      </Button>
                      <Button
                        variant="text"
                        size="small"
                        onClick={() => {
                          setProfileUsername(account.user?.username ?? '');
                          setEditingUsername(false);
                        }}
                        disabled={busy}
                      >
                        {t.cloud.cancelUsername}
                      </Button>
                    </Stack>
                  </Stack>
                ) : (
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="center">
                    <Typography color="text.secondary">@{account.user.username}</Typography>
                    <Button
                      variant="text"
                      size="small"
                      startIcon={<EditRounded />}
                      onClick={() => setEditingUsername(true)}
                      disabled={busy || usernameChangeBlocked}
                    >
                      {t.cloud.changeUsername}
                    </Button>
                  </Stack>
                )}
              </Stack>
              {usernameChangeBlocked && usernameAvailableLabel ? (
                <Typography variant="caption" color="text.secondary">
                  Puedes cambiar tu username desde el {usernameAvailableLabel}.
                </Typography>
              ) : null}
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
                  <Stack spacing={1.25} alignItems="center">
                    <Button variant="outlined" size="large" onClick={() => void onGoogleLogin()} startIcon={<GoogleIcon />} disabled={busy} sx={{ minWidth: 260 }}>
                      {t.cloud.googleLogin}
                    </Button>
                    <Button variant="outlined" size="large" onClick={() => void onAppleLogin()} startIcon={<AppleIcon />} disabled={busy} sx={{ minWidth: 260 }}>
                      {t.cloud.appleLogin}
                    </Button>
                    <Divider flexItem>{t.cloud.or}</Divider>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} justifyContent="center" sx={{ width: '100%' }}>
                      <Button variant="contained" size="large" onClick={() => setMode('login')} startIcon={<LoginRounded />}>
                        {t.cloud.login}
                      </Button>
                      <Button variant="outlined" size="large" onClick={() => setMode('register')} startIcon={<PersonAddAltRounded />}>
                        {t.cloud.register}
                      </Button>
                    </Stack>
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
                  <Button variant="outlined" startIcon={<GoogleIcon />} onClick={() => void onGoogleLogin()} disabled={busy} fullWidth>
                    {t.cloud.googleLogin}
                  </Button>
                  <Button variant="outlined" startIcon={<AppleIcon />} onClick={() => void onAppleLogin()} disabled={busy} fullWidth>
                    {t.cloud.appleLogin}
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
                  <TextField
                    label={t.cloud.username}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={t.cloud.usernamePlaceholder}
                    helperText={t.cloud.usernameHelp}
                    fullWidth
                  />
                  <TextField label={t.settings.emailLabel} type="email" value={email} onChange={(event) => setEmail(event.target.value)} fullWidth />
                  <TextField label={t.settings.passwordLabel} type="password" value={password} onChange={(event) => setPassword(event.target.value)} fullWidth />
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <Autocomplete<CountryOption>
                      value={selectedCountry}
                      options={countryOptions}
                      autoHighlight
                      clearOnEscape
                      getOptionLabel={(option) => option.label}
                      isOptionEqualToValue={(option, value) => option.code === value.code}
                      onChange={(_event, option) => setCountry(option?.code ?? '')}
                      renderOption={(props, option) => (
                        <Box component="li" {...props} key={option.code}>
                          {renderCountryOption(option.code, option.label)}
                        </Box>
                      )}
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          label={t.cloud.country}
                          placeholder={t.cloud.countryAuto}
                        />
                      )}
                      fullWidth
                    />
                    <TextField
                      label={t.cloud.age}
                      value={age}
                      onChange={(event) => updateAge(event.target.value)}
                      slotProps={{
                        htmlInput: {
                          inputMode: 'numeric',
                          pattern: '[0-9]*',
                        },
                      }}
                      fullWidth
                    />
                  </Stack>
                  <TextField select label={t.cloud.gender} value={gender} onChange={(event) => setGender(event.target.value as ForgerAccountRegisterInput['gender'])} fullWidth>
                    <MenuItem value="">{t.cloud.preferNotToSay}</MenuItem>
                    <MenuItem value="male">{t.cloud.genders.male}</MenuItem>
                    <MenuItem value="female">{t.cloud.genders.female}</MenuItem>
                    <MenuItem value="other">{t.cloud.genders.other}</MenuItem>
                  </TextField>
                  <Button variant="contained" startIcon={<PersonAddAltRounded />} onClick={submitRegister} disabled={busy || !firstName.trim() || !username.trim() || !email.trim() || !password.trim()} fullWidth>
                    {t.cloud.register}
                  </Button>
                  <Button variant="outlined" startIcon={<GoogleIcon />} onClick={() => void onGoogleLogin()} disabled={busy} fullWidth>
                    {t.cloud.googleLogin}
                  </Button>
                  <Button variant="outlined" startIcon={<AppleIcon />} onClick={() => void onAppleLogin()} disabled={busy} fullWidth>
                    {t.cloud.appleLogin}
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
