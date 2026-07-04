import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const loadClaudeOauth = () => require('../../dist-electron/main/claude-oauth.js');

const makeHome = async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-claude-oauth-home-'));
  t.after(async () => fs.rm(home, { recursive: true, force: true }));
  return home;
};

const writeCredentialsFile = async (home, contents) => {
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', '.credentials.json'), contents, 'utf8');
};

test('Claude OAuth token reader uses the absolute macOS security binary', async () => {
  const { readClaudeOAuthToken } = loadClaudeOauth();
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } }), '');
  };

  const token = await readClaudeOAuthToken({
    platform: 'darwin',
    execFile,
    securityPath: '/usr/bin/security',
  });

  assert.equal(token, 'keychain-token');
  assert.equal(calls[0].command, '/usr/bin/security');
  assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
});

test('Claude OAuth token reader falls back to PATH security only when the absolute binary is unavailable', async () => {
  const { readClaudeOAuthToken } = loadClaudeOauth();
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/security') {
      callback(Object.assign(new Error('missing security'), { code: 'ENOENT' }), '', '');
      return;
    }
    callback(null, JSON.stringify({ claudeAiOauth: { accessToken: 'path-token' } }), '');
  };

  const token = await readClaudeOAuthToken({
    platform: 'darwin',
    execFile,
  });

  assert.equal(token, 'path-token');
  assert.deepEqual(calls.map((call) => call.command), ['/usr/bin/security', 'security']);
});

test('Claude OAuth token reader falls back to credentials file when keychain read fails', async (t) => {
  const { readClaudeOAuthToken } = loadClaudeOauth();
  const home = await makeHome(t);
  await writeCredentialsFile(home, JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }));
  const execFile = (_command, _args, _options, callback) => {
    callback(Object.assign(new Error('missing keychain entry'), { code: 44 }), '', '');
  };

  const token = await readClaudeOAuthToken({
    platform: 'darwin',
    execFile,
    homeDir: () => home,
  });

  assert.equal(token, 'file-token');
});

test('Claude OAuth token reader ignores malformed credential payloads', async (t) => {
  const { readClaudeOAuthToken } = loadClaudeOauth();
  const home = await makeHome(t);
  await writeCredentialsFile(home, JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh-only' } }));

  const token = await readClaudeOAuthToken({
    platform: 'linux',
    homeDir: () => home,
  });

  assert.equal(token, null);
});
