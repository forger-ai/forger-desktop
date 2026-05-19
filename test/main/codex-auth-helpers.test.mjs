import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildCodexAuthEnvironment,
  classifyCodexAuthOutput,
  extractAllowedCodexAuthUrls,
} = require('../../dist-electron/main/codex-auth-helpers.js');

test('Codex auth environment includes CODEX_HOME, bundled Node, codex bin, and base PATH', () => {
  const env = buildCodexAuthEnvironment({
    codexHome: '/Users/test/Library/Application Support/forger-desktop/codex-home',
    codexCliPath: '/Users/test/Library/Application Support/forger-desktop/codex-cli/node_modules/.bin/codex',
    nodePathEntries: [
      '/Users/test/Library/Application Support/forger-desktop/runtimes/node/22/darwin_arm64/bin',
    ],
    baseEnv: { PATH: '/usr/local/bin:/usr/bin' },
    delimiter: ':',
  });

  assert.equal(env.CODEX_HOME, '/Users/test/Library/Application Support/forger-desktop/codex-home');
  assert.equal(
    env.PATH,
    [
      '/Users/test/Library/Application Support/forger-desktop/runtimes/node/22/darwin_arm64/bin',
      '/Users/test/Library/Application Support/forger-desktop/codex-cli/node_modules/.bin',
      '/usr/local/bin',
      '/usr/bin',
    ].join(':'),
  );
});

test('Codex auth environment keeps bundled Node even when Electron PATH is empty', () => {
  const env = buildCodexAuthEnvironment({
    codexHome: '/tmp/codex-home',
    codexCliPath: '/tmp/codex-cli/node_modules/.bin/codex',
    nodePathEntries: ['/tmp/runtimes/node/bin'],
    baseEnv: { PATH: '' },
    delimiter: ':',
  });

  assert.equal(env.PATH, '/tmp/runtimes/node/bin:/tmp/codex-cli/node_modules/.bin');
});

test('Codex auth URL extraction opens only OpenAI auth URLs', () => {
  const urls = extractAllowedCodexAuthUrls([
    'Visit https://auth.openai.com/oauth/authorize?client_id=abc&state=123.',
    'Ignore http://localhost:1455/auth/callback',
    'Ignore https://api.openai.com/oauth/authorize',
    'Ignore https://example.com/oauth/authorize',
  ].join('\n'));

  assert.deepEqual(urls, ['https://auth.openai.com/oauth/authorize?client_id=abc&state=123']);
});

test('Codex auth output classifies missing bundled Node and expired auth', () => {
  assert.equal(
    classifyCodexAuthOutput('', 'env: node: No such file or directory\n'),
    'codex_node_runtime_missing',
  );
  assert.equal(
    classifyCodexAuthOutput('', 'Failed to refresh token: 401 Unauthorized'),
    'codex_auth_expired',
  );
  assert.equal(classifyCodexAuthOutput('Logged in using ChatGPT', ''), undefined);
});

test('macOS Codex login path is direct spawn, not Terminal or generated command script', async () => {
  const source = await fs.readFile(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
  const macBranchStart = source.indexOf("if (process.platform === 'darwin') {", source.indexOf('const connectCodexAuth'));
  const winBranchStart = source.indexOf("if (process.platform === 'win32') {", macBranchStart);
  assert.notEqual(macBranchStart, -1);
  assert.notEqual(winBranchStart, -1);
  const macBranch = source.slice(macBranchStart, winBranchStart);

  assert.match(macBranch, /launchMacCodexLoginProcess/);
  assert.match(source, /spawn\(codexCliPath, \['login'\], \{/);
  assert.match(source, /shell: false/);
  assert.doesNotMatch(macBranch, /osascript|Terminal|do script|\.command|open -a Terminal/);
  assert.doesNotMatch(macBranch, /markProviderConnected\('codex'\)/);
});
