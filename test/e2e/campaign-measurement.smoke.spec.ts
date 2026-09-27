import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('real Desktop keeps campaign permission optional and handles campaign links without enabling measurement', async () => {
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'forger-campaign-smoke-'));
  const isolatedHome = path.join(profileRoot, 'home');
  const isolatedAppData = path.join(profileRoot, 'os-app-data');
  await Promise.all([mkdir(isolatedHome), mkdir(isolatedAppData)]);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'DISPLAY', 'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP',
    'TMPDIR', 'TMP', 'TEMP', 'CI', 'GITHUB_ACTIONS']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, {
    HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: isolatedAppData, LOCALAPPDATA: isolatedAppData,
    NODE_ENV: 'test', FORGER_E2E_PROFILE_ROOT: profileRoot, FORGER_BACKEND_URL: 'http://127.0.0.1:9',
    NO_PROXY: '*', HTTP_PROXY: '', HTTPS_PROXY: '',
  });
  let application: ElectronApplication | undefined;
  try {
    const repoRoot = path.resolve(__dirname, '..', '..');
    application = await electron.launch({ args: [repoRoot, '--disable-background-networking'], cwd: repoRoot, env: environment });
    let desktopPage: Page | undefined;
    await expect.poll(async () => {
      for (const candidate of application!.windows()) {
        if (await candidate.evaluate(() => typeof window.forger?.getCampaignMeasurementStatus === 'function').catch(() => false)) {
          desktopPage = candidate;
          return true;
        }
      }
      return false;
    }, { timeout: 30_000 }).toBe(true);
    if (!desktopPage) throw new Error('desktop_window_not_found');
    const page = desktopPage;
    const status = () => page.evaluate(() => window.forger.getCampaignMeasurementStatus());
    await expect(page.getByText(/^(Optional measurement|Medición opcional)$/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Allow measurement|Permitir medición)$/ }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: /^(No thanks|No, gracias)$/ }).first()).toBeEnabled();
    expect(await status()).toMatchObject({ available: false, consent: 'undecided', campaignCode: null });

    const sendLink = (url: string) => application!.evaluate(({ app }, value) => {
      app.emit('open-url', { preventDefault() {} }, value);
    }, url);
    await sendLink('forger://campaign?code=ig_202609_paid_01');
    const campaignDialog = page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: /Campaign code|Código de campaña/ }) }).last();
    await expect(campaignDialog.getByRole('textbox', { name: /Campaign code|Código de campaña/ })).toHaveValue('ig_202609_paid_01');
    await expect(campaignDialog.getByText(/disabled in development and test builds|desactivada en versiones de desarrollo y pruebas/)).toBeVisible();
    expect(await status()).toMatchObject({ available: false, consent: 'undecided', campaignCode: null });
    await campaignDialog.getByRole('button', { name: /^(Continue|Continuar)$/ }).click();
    await expect(campaignDialog).not.toBeVisible();

    await sendLink('forger://campaign?code=ig_202609_paid_01&unexpected=value');
    await expect(page.getByRole('textbox', { name: /Campaign code|Código de campaña/ }).first()).toHaveValue('');
    expect(await status()).toMatchObject({ consent: 'undecided', campaignCode: null });
    await expect(campaignDialog).not.toBeVisible();

    await page.getByRole('button', { name: /^(Skip tutorial|Omitir tutorial|Saltar tutorial)$/ }).click();
    await page.getByRole('button', { name: /^(Settings|Configuración)$/ }).click();
    await page.getByText(/^(Privacy and security|Privacidad y seguridad)$/).click();
    await expect(page.getByText(/^(Optional measurement|Medición opcional)$/)).toBeVisible();
    await page.getByRole('button', { name: /^(No thanks|No, gracias)$/ }).click();
    expect(await status()).toMatchObject({ available: false, consent: 'disabled', campaignCode: null });
  } finally {
    await application?.close().catch(() => undefined);
    await rm(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
