import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildEffectiveDeveloperPathEntries,
  normalizeDeveloperPathEntries,
  splitPathEntries,
} = require('../../dist-electron/main/runtime/developer-paths.js');
const { mergePathEntries } = require('../../dist-electron/main/runtime/process-spawn.js');
const { INTERNAL_TOOL_MODULES } = require('../../dist-electron/main/tools/index.js');

test('developer path helpers reject non-lists, non-strings, absent system paths, and absent app overrides', () => {
  const pathModule = require('node:path');
  assert.deepEqual(normalizeDeveloperPathEntries({}, pathModule), []);
  assert.deepEqual(normalizeDeveloperPathEntries([null, 7, {}, '/valid'], pathModule), ['/valid']);
  assert.deepEqual(splitPathEntries(undefined, ':'), []);
  assert.deepEqual(buildEffectiveDeveloperPathEntries({
    enabled: true,
    runtimePathEntries: ['/runtime'],
    globalPathEntries: ['/global'],
    systemPath: undefined,
    delimiter: ':',
  }), ['/runtime', '/global']);
});

test('process environment merging respects absent and case-insensitive PATH keys', () => {
  assert.deepEqual(mergePathEntries({}, ['/runtime'], ':'), { PATH: '/runtime' });
  assert.deepEqual(mergePathEntries({ Path: '/system', PATH: '/shadow', OTHER: 'yes' }, ['/runtime'], ':'), {
    Path: '/runtime:/system',
    OTHER: 'yes',
  });
});

test('optional SQLite loader returns null when the native dependency cannot load', () => {
  const modulePath = require.resolve('../../dist-electron/main/runtime/optional-better-sqlite.js');
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function loadWithoutSqlite(request, parent, isMain) {
    if (request === 'better-sqlite3') {
      throw new Error('native addon unavailable');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { loadOptionalBetterSqlite } = require(modulePath);
    assert.equal(loadOptionalBetterSqlite(), null);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
});

test('tool barrels expose the internal registry and every public OAuth contract', () => {
  assert.deepEqual(INTERNAL_TOOL_MODULES.map((module) => module.definition.id), ['forger_chrome_extension']);
  const selfOAuth = require('../../dist-electron/main/tools/self-oauth.js');
  const expected = [
    'OAUTH_ACCESS_TOKEN_EXPIRES_AT_SECRET',
    'OAUTH_ACCESS_TOKEN_SECRET',
    'OAUTH_CLIENT_ID_SECRET',
    'OAUTH_CLIENT_SECRET_SECRET',
    'OAUTH_REFRESH_TOKEN_SECRET',
    'OAUTH_SCOPE_SECRET',
    'OAuthConnectionError',
    'getStoredOAuthAccessToken',
    'runGitHubDeviceOAuthFlow',
    'runLoopbackOAuthFlow',
  ];
  assert.deepEqual(Object.keys(selfOAuth).sort(), expected.sort());
  for (const exported of expected) {
    assert.notEqual(selfOAuth[exported], undefined, exported);
  }
});
