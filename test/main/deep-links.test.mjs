import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { clearDistModule, createElectronAppMock, withMockedElectron } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { extractDeepLinkFromArgv, parseForgerUrl } = require('../../dist-electron/main/deep-links.js');

test('parseForgerUrl returns chat deep links with app and prompt payloads', () => {
  assert.deepEqual(parseForgerUrl('forger://chat'), {
    kind: 'chat',
    app: null,
    prompt: null,
    raw: 'forger://chat',
  });

  assert.deepEqual(parseForgerUrl('forger://chat?app=%20finance-os%20&prompt=Review%20this'), {
    kind: 'chat',
    app: 'finance-os',
    prompt: 'Review this',
    raw: 'forger://chat?app=%20finance-os%20&prompt=Review%20this',
  });
});

test('parseForgerUrl rejects non-Forger URLs and preserves unknown Forger links', () => {
  assert.equal(parseForgerUrl('https://forger.local/chat'), null);
  assert.equal(parseForgerUrl('not a url'), null);

  assert.deepEqual(parseForgerUrl('forger://settings?tab=account'), {
    kind: 'unknown',
    raw: 'forger://settings?tab=account',
  });
});

test('parseForgerUrl returns Social app deep links with codes or public ids', () => {
  assert.deepEqual(parseForgerUrl('forger://social/app?code=%20ABC123%20'), {
    kind: 'social-app',
    code: 'ABC123',
    id: null,
    raw: 'forger://social/app?code=%20ABC123%20',
  });

  assert.deepEqual(parseForgerUrl('forger://social/app?id=42'), {
    kind: 'social-app',
    code: null,
    id: 42,
    raw: 'forger://social/app?id=42',
  });

  assert.deepEqual(parseForgerUrl('forger://social/profile?username=%40ana'), {
    kind: 'unknown',
    raw: 'forger://social/profile?username=%40ana',
  });
});

test('extractDeepLinkFromArgv returns the first valid Forger link candidate', () => {
  assert.equal(extractDeepLinkFromArgv(['node', '.', 'https://example.com']), null);
  assert.equal(extractDeepLinkFromArgv(['node', '.', 42, 'forger://chat?app=finance-os']).app, 'finance-os');

  assert.deepEqual(
    extractDeepLinkFromArgv([
      '/Applications/Forger.app/Contents/MacOS/Forger',
      '--flag',
      'forger://chat?app=recipes',
      'forger://chat?app=finance-os',
    ]),
    {
      kind: 'chat',
      app: 'recipes',
      prompt: null,
      raw: 'forger://chat?app=recipes',
    },
  );
});

test('registerForgerProtocol registers packaged and dev protocol handlers', async () => {
  const originalDefaultApp = process.defaultApp;
  const originalArgv = process.argv;
  const electronApp = createElectronAppMock();

  try {
    await withMockedElectron({ app: electronApp, BrowserWindow: class {} }, async (mockedRequire) => {
      clearDistModule('main/deep-links.js');
      const { registerForgerProtocol } = mockedRequire('../../dist-electron/main/deep-links.js');

      process.defaultApp = false;
      registerForgerProtocol();
      assert.deepEqual(electronApp.protocolRegistrations.at(-1), ['forger']);

      process.defaultApp = true;
      process.argv = ['/Applications/Electron.app/Contents/MacOS/Electron', './dist-electron/main/index.js'];
      registerForgerProtocol();
      assert.equal(electronApp.protocolRegistrations.at(-1)[0], 'forger');
      assert.equal(electronApp.protocolRegistrations.at(-1)[1], process.execPath);
      assert.ok(electronApp.protocolRegistrations.at(-1)[2][0].endsWith('dist-electron/main/index.js'));

      process.argv = ['/Applications/Electron.app/Contents/MacOS/Electron'];
      registerForgerProtocol();
      assert.deepEqual(electronApp.protocolRegistrations.at(-1), ['forger']);
    });
  } finally {
    process.defaultApp = originalDefaultApp;
    process.argv = originalArgv;
  }
});

test('focusWindow restores usable windows and ignores missing or destroyed targets', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const electronApp = createElectronAppMock();
  const calls = [];

  try {
    await withMockedElectron({ app: electronApp, BrowserWindow: class {} }, async (mockedRequire) => {
      clearDistModule('main/deep-links.js');
      const { focusWindow } = mockedRequire('../../dist-electron/main/deep-links.js');

      focusWindow(null);
      focusWindow({ isDestroyed: () => true });
      assert.deepEqual(calls, []);

      Object.defineProperty(process, 'platform', { value: 'darwin' });
      focusWindow({
        isDestroyed: () => false,
        isMinimized: () => true,
        restore: () => calls.push('restore'),
        show: () => calls.push('show'),
        focus: () => calls.push('focus'),
      });
    });
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
  assert.deepEqual(electronApp.focusedWith, [{ steal: true }]);
});
