import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

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

test('extractDeepLinkFromArgv returns the first valid Forger link candidate', () => {
  assert.equal(extractDeepLinkFromArgv(['node', '.', 'https://example.com']), null);

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
