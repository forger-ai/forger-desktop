import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readClaudeOAuthToken } = require('../../dist-electron/main/claude-oauth.js');

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

const withEnv = async (patch, operation) => {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const makeHome = async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-claude-oauth-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  return home;
};

const writeCredentialsFile = async (home, contents) => {
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', '.credentials.json'), contents, 'utf8');
};

// Creates a fake macOS `security` binary on an isolated PATH prefix so the test
// never touches the real login keychain. The stub records each invocation.
const makeSecurityStub = async (t, { payload = '', exitCode = 0 } = {}) => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-claude-keychain-bin-'));
  t.after(async () => {
    await fs.rm(bin, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(bin, 'payload.txt'), payload, 'utf8');
  const script = [
    '#!/bin/sh',
    `printf 'invoked %s\\n' "$*" >> "${bin}/invocations.log"`,
    `cat "${bin}/payload.txt"`,
    `exit ${exitCode}`,
    '',
  ].join('\n');
  await fs.writeFile(path.join(bin, 'security'), script, { mode: 0o755 });
  return {
    bin,
    invocations: async () => (await fs.readFile(path.join(bin, 'invocations.log'), 'utf8').catch(() => '')).trim(),
  };
};

test('macOS user with Claude Code keychain credentials gets the keychain access token', async (t) => {
  const home = await makeHome(t);
  const stub = await makeSecurityStub(t, {
    payload: JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token-1' } }),
  });
  // The credentials file holds a different token to prove the keychain wins.
  await writeCredentialsFile(home, JSON.stringify({ claudeAiOauth: { accessToken: 'file-token-1' } }));

  const token = await withEnv({ HOME: home, PATH: `${stub.bin}:${process.env.PATH ?? ''}` }, async () =>
    await withPlatform('darwin', async () => await readClaudeOAuthToken()));

  assert.equal(token, 'keychain-token-1');
  assert.match(await stub.invocations(), /find-generic-password -s Claude Code-credentials -w/);
});

test('macOS keychain entry without a usable token falls back to the credentials file', async (t) => {
  const home = await makeHome(t);
  const stub = await makeSecurityStub(t, {
    payload: JSON.stringify({ claudeAiOauth: { refreshToken: 'only-refresh' } }),
  });
  await writeCredentialsFile(home, JSON.stringify({ claudeAiOauth: { accessToken: 'file-token-2' } }));

  const token = await withEnv({ HOME: home, PATH: `${stub.bin}:${process.env.PATH ?? ''}` }, async () =>
    await withPlatform('darwin', async () => await readClaudeOAuthToken()));

  assert.equal(token, 'file-token-2');
});

test('macOS keychain read failure (missing entry) falls back to the credentials file', async (t) => {
  const home = await makeHome(t);
  const stub = await makeSecurityStub(t, { payload: '', exitCode: 44 });
  await writeCredentialsFile(home, JSON.stringify({ claudeAiOauth: { accessToken: 'file-token-3' } }));

  const token = await withEnv({ HOME: home, PATH: `${stub.bin}:${process.env.PATH ?? ''}` }, async () =>
    await withPlatform('darwin', async () => await readClaudeOAuthToken()));

  assert.equal(token, 'file-token-3');
  assert.match(await stub.invocations(), /find-generic-password/);
});

test('non-macOS platforms read the credentials file without consulting any keychain', async (t) => {
  const home = await makeHome(t);
  const stub = await makeSecurityStub(t, {
    payload: JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-should-not-be-used' } }),
  });
  await writeCredentialsFile(home, JSON.stringify({ claudeAiOauth: { accessToken: 'linux-file-token' } }));

  const token = await withEnv({ HOME: home, PATH: `${stub.bin}:${process.env.PATH ?? ''}` }, async () =>
    await withPlatform('linux', async () => await readClaudeOAuthToken()));

  assert.equal(token, 'linux-file-token');
  assert.equal(await stub.invocations(), '');
});

test('user who never connected Claude is reported as disconnected (no credentials file)', async (t) => {
  const home = await makeHome(t);

  const token = await withEnv({ HOME: home }, async () =>
    await withPlatform('linux', async () => await readClaudeOAuthToken()));

  assert.equal(token, null);
});

test('malformed or incomplete credential payloads report disconnected instead of crashing', async (t) => {
  const home = await makeHome(t);

  const cases = [
    'this is not json',
    '42',
    'null',
    JSON.stringify({ somethingElse: true }),
    JSON.stringify({ claudeAiOauth: 'not-an-object' }),
    JSON.stringify({ claudeAiOauth: { accessToken: '' } }),
    JSON.stringify({ claudeAiOauth: { accessToken: 12345 } }),
  ];
  for (const contents of cases) {
    await writeCredentialsFile(home, contents);
    const token = await withEnv({ HOME: home }, async () =>
      await withPlatform('linux', async () => await readClaudeOAuthToken()));
    assert.equal(token, null, `expected null token for payload: ${contents}`);
  }
});
