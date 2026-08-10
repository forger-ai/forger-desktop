import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');

const copyEnvironmentValue = (target: NodeJS.ProcessEnv, name: string): void => {
  const value = process.env[name];
  if (value !== undefined) target[name] = value;
};

const buildIsolatedEnvironment = (profileRoot: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'XDG_CURRENT_DESKTOP',
    'TMPDIR',
    'TMP',
    'TEMP',
    'CI',
    'GITHUB_ACTIONS',
  ]) {
    copyEnvironmentValue(environment, name);
  }

  const isolatedHome = path.join(profileRoot, 'home');
  const isolatedAppData = path.join(profileRoot, 'os-app-data');
  environment.HOME = isolatedHome;
  environment.USERPROFILE = isolatedHome;
  environment.APPDATA = isolatedAppData;
  environment.LOCALAPPDATA = isolatedAppData;
  environment.NODE_ENV = 'test';
  environment.FORGER_E2E_PROFILE_ROOT = profileRoot;
  environment.FORGER_BACKEND_URL = 'http://127.0.0.1:9';
  environment.NO_PROXY = '*';
  environment.HTTP_PROXY = '';
  environment.HTTPS_PROXY = '';
  return environment;
};

const waitForDesktopWindow = async (electronApp: ElectronApplication): Promise<Page> => {
  let desktopWindow: Page | undefined;
  await expect.poll(async () => {
    for (const candidate of electronApp.windows()) {
      const hasForgerBridge = await candidate
        .evaluate(() => typeof window.forger === 'object' && window.forger !== null)
        .catch(() => false);
      if (hasForgerBridge) {
        desktopWindow = candidate;
        return true;
      }
    }
    return false;
  }, { timeout: 30_000, message: 'the real Desktop renderer should load with its preload bridge' }).toBe(true);

  if (!desktopWindow) throw new Error('desktop_window_not_found');
  return desktopWindow;
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};

test('real Electron startup preserves renderer isolation and denies uncontrolled child windows', async () => {
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'forger-electron-smoke-'));
  await Promise.all([
    mkdir(path.join(profileRoot, 'home'), { recursive: true }),
    mkdir(path.join(profileRoot, 'os-app-data'), { recursive: true }),
  ]);

  let electronApp: ElectronApplication | null = null;
  try {
    electronApp = await electron.launch({
      args: [repoRoot, '--disable-background-networking'],
      cwd: repoRoot,
      env: buildIsolatedEnvironment(profileRoot),
      timeout: 30_000,
    });
    const page = await waitForDesktopWindow(electronApp);

    const runtimeProfile = await electronApp.evaluate(({ app }) => ({
      isPackaged: app.isPackaged,
      userData: app.getPath('userData'),
    }));
    expect(runtimeProfile).toEqual({
      isPackaged: false,
      userData: path.join(profileRoot, 'user-data'),
    });

    for (const relativePath of ['workspace', 'workspace/apps', 'workspace/data', 'workspace/backups', 'workspace/.forger']) {
      await expect.poll(() => pathExists(path.join(profileRoot, relativePath))).toBe(true);
    }

    const browserWindow = await electronApp.browserWindow(page);
    const webPreferences = await browserWindow.evaluate((window) => window.webContents.getLastWebPreferences());
    expect(webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });

    const rendererGlobals = await page.evaluate(() => ({
      require: typeof (globalThis as typeof globalThis & { require?: unknown }).require,
      process: typeof (globalThis as typeof globalThis & { process?: unknown }).process,
      module: typeof (globalThis as typeof globalThis & { module?: unknown }).module,
      Buffer: typeof (globalThis as typeof globalThis & { Buffer?: unknown }).Buffer,
      __dirname: typeof (globalThis as typeof globalThis & { __dirname?: unknown }).__dirname,
      __filename: typeof (globalThis as typeof globalThis & { __filename?: unknown }).__filename,
    }));
    expect(rendererGlobals).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      Buffer: 'undefined',
      __dirname: 'undefined',
      __filename: 'undefined',
    });

    const preloadSurface = await page.evaluate(() => {
      const entries = Object.entries(window.forger);
      return {
        keyCount: entries.length,
        nonFunctionKeys: entries.filter(([, value]) => typeof value !== 'function').map(([key]) => key),
      };
    });
    expect(preloadSurface.keyCount).toBeGreaterThan(0);
    expect(preloadSurface.nonFunctionKeys).toEqual([]);

    await electronApp.evaluate(({ shell }) => {
      const shellCalls: Array<{ kind: 'external' | 'path'; value: string }> = [];
      (globalThis as typeof globalThis & { __forgerE2eShellCalls?: typeof shellCalls }).__forgerE2eShellCalls = shellCalls;
      shell.openExternal = async (url: string) => {
        shellCalls.push({ kind: 'external', value: url });
      };
      shell.openPath = async (targetPath: string) => {
        shellCalls.push({ kind: 'path', value: targetPath });
        return '';
      };
    });

    const initialWindowCount = electronApp.windows().length;
    const unexpectedWindow = electronApp.waitForEvent('window', { timeout: 1_000 }).then(() => true, () => false);
    const openReturnedNull = await page.evaluate(() => window.open('about:blank', 'uncontrolled-e2e-child') === null);
    expect(openReturnedNull).toBe(true);
    expect(await unexpectedWindow).toBe(false);
    expect(electronApp.windows()).toHaveLength(initialWindowCount);
    const shellCalls = await electronApp.evaluate(() => (
      (globalThis as typeof globalThis & { __forgerE2eShellCalls?: unknown[] }).__forgerE2eShellCalls ?? []
    ));
    expect(shellCalls).toEqual([]);
  } catch (error) {
    const windowUrls = electronApp?.windows().map((window) => window.url()) ?? [];
    const startupLog = await readFile(
      path.join(profileRoot, 'workspace', '.forger', 'logs', 'forger-desktop.jsonl'),
      'utf8',
    ).catch(() => 'startup log unavailable');
    console.error('Electron smoke diagnostics', {
      windowUrls,
      startupLogTail: startupLog.split('\n').slice(-12).join('\n'),
    });
    throw error;
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    expect(await pathExists(profileRoot)).toBe(false);
  }
});
