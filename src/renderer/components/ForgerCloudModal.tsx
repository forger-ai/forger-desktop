import { useEffect, useState } from 'react';
import LoginRounded from '@mui/icons-material/LoginRounded';
import LogoutRounded from '@mui/icons-material/LogoutRounded';
import PersonAddAltRounded from '@mui/icons-material/PersonAddAltRounded';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  Tab,
  Tabs,
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

type AccountTab = 'login' | 'register';

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
  const [tab, setTab] = useState<AccountTab>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [country, setCountry] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<ForgerAccountRegisterInput['gender'] | ''>('');

  useEffect(() => {
    if (open) {
      setTab(account.authenticated ? 'login' : tab);
    }
  }, [account.authenticated, open, tab]);

  const submitLogin = () => {
    void onLogin(email, password);
  };

  const submitRegister = () => {
    void onRegister({
      firstName,
      lastName,
      email,
      password,
      country,
      age: age ? Number(age) : undefined,
      gender: gender || undefined,
    });
  };

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
              {t.cloud.body}
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
              <Tabs value={tab} onChange={(_event, next: AccountTab) => setTab(next)}>
                <Tab value="login" label={t.cloud.loginTab} icon={<LoginRounded />} iconPosition="start" />
                <Tab value="register" label={t.cloud.registerTab} icon={<PersonAddAltRounded />} iconPosition="start" />
              </Tabs>
              <Stack spacing={1.5}>
                {tab === 'register' ? (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField label={t.cloud.firstName} value={firstName} onChange={(event) => setFirstName(event.target.value)} fullWidth />
                    <TextField label={t.cloud.lastName} value={lastName} onChange={(event) => setLastName(event.target.value)} fullWidth />
                  </Stack>
                ) : null}
                <TextField label={t.settings.emailLabel} type="email" value={email} onChange={(event) => setEmail(event.target.value)} fullWidth />
                <TextField label={t.settings.passwordLabel} type="password" value={password} onChange={(event) => setPassword(event.target.value)} fullWidth />
                {tab === 'register' ? (
                  <>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                      <TextField label={t.cloud.country} value={country} onChange={(event) => setCountry(event.target.value)} fullWidth />
                      <TextField label={t.cloud.age} type="number" value={age} onChange={(event) => setAge(event.target.value)} fullWidth />
                    </Stack>
                    <TextField select label={t.cloud.gender} value={gender} onChange={(event) => setGender(event.target.value as ForgerAccountRegisterInput['gender'])} fullWidth>
                      <MenuItem value="">{t.cloud.preferNotToSay}</MenuItem>
                      <MenuItem value="male">{t.cloud.genders.male}</MenuItem>
                      <MenuItem value="female">{t.cloud.genders.female}</MenuItem>
                      <MenuItem value="other">{t.cloud.genders.other}</MenuItem>
                    </TextField>
                  </>
                ) : null}
              </Stack>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.secrets.close}</Button>
        {account.authenticated ? (
          <Button startIcon={<LogoutRounded />} onClick={() => void onLogout()} disabled={busy}>
            {t.cloud.logout}
          </Button>
        ) : tab === 'register' ? (
          <Button variant="contained" startIcon={<PersonAddAltRounded />} onClick={submitRegister} disabled={busy || !firstName.trim() || !email.trim() || !password.trim()}>
            {t.cloud.register}
          </Button>
        ) : (
          <Button variant="contained" startIcon={<LoginRounded />} onClick={submitLogin} disabled={busy || !email.trim() || !password.trim()}>
            {t.cloud.login}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
