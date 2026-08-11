import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  appendDesktopLog,
  sanitizeDesktopLogString,
} = require('../../dist-electron/main/desktop-logger.js');

test('DesktopLogger writes JSONL with service, event, stack traces, content, and redacted secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-desktop-logger-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const error = new Error('unexpected failure');

  await appendDesktopLog({
    metadataRoot: root,
    level: 'error',
    service: 'tool:whatsapp',
    event: 'official_tool:whatsapp_message_ingest_failed',
    message: 'message content is intentionally logged',
    context: {
      chatId: '569123@s.whatsapp.net',
      text: 'normal content',
      accessToken: 'secret-token',
      creds: { noiseKey: 'secret-key' },
    },
    error,
  });

  const raw = await readFile(join(root, 'logs', 'forger-desktop.jsonl'), 'utf8');
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.service, 'tool:whatsapp');
  assert.equal(entry.event, 'official_tool:whatsapp_message_ingest_failed');
  assert.equal(entry.message, 'message content is intentionally logged');
  assert.equal(entry.context.text, 'normal content');
  assert.equal(entry.context.accessToken, '[REDACTED]');
  assert.equal(entry.context.creds, '[REDACTED]');
  assert.equal(entry.error.message, 'unexpected failure');
  assert.match(entry.error.stack, /unexpected failure/);
});

test('DesktopLogger redacts secrets embedded in every string surface before truncating', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-desktop-logger-embedded-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const cause = new Error('cause remains useful: access_token=cause-secret');
  const error = new Error('request failed: Authorization: Bearer error-secret', { cause });
  const oversizedSecret = `api_key=${'s'.repeat(120_100)} keep-this-tail`;

  await appendDesktopLog({
    metadataRoot: root,
    level: 'error',
    service: 'backend-client',
    event: 'request_failed',
    message: [
      'Sync failed for account 42.',
      'Authorization: Bearer message-secret',
      'https://alice:url-password@example.com/path?api_key=query-secret&mode=safe',
      'Cookie: session=cookie-secret; theme=dark',
    ].join('\n'),
    context: {
      note: 'retry with token=embedded-secret after validation',
      prose: 'upload failed with Bearer standalone-secret but retry is possible',
      payload: '{"api_key":"json-secret","status":"useful"}',
      escapedPayload: 'request={\\"access_token\\":\\"escaped-secret\\"}',
      multilinePayload: 'request={"client_secret":"line one\nmultiline-secret"} status=useful',
      headers: 'X-Api-Key: header-secret',
      oversizedValue: oversizedSecret,
    },
    error,
  });

  const raw = await readFile(join(root, 'logs', 'forger-desktop.jsonl'), 'utf8');
  const entry = JSON.parse(raw.trim());
  const serialized = JSON.stringify(entry);
  for (const secret of [
    'message-secret',
    'url-password',
    'query-secret',
    'cookie-secret',
    'embedded-secret',
    'standalone-secret',
    'json-secret',
    'escaped-secret',
    'multiline-secret',
    'header-secret',
    'error-secret',
    'cause-secret',
  ]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(entry.message, /Sync failed for account 42\./);
  assert.match(entry.message, /Authorization: \[REDACTED\]/);
  assert.match(entry.message, /https:\/\/\[REDACTED\]@example\.com\/path\?api_key=\[REDACTED\]&mode=safe/);
  assert.match(entry.message, /Cookie: \[REDACTED\]/);
  assert.equal(entry.context.note, 'retry with token=[REDACTED] after validation');
  assert.equal(entry.context.prose, 'upload failed with Bearer [REDACTED] but retry is possible');
  assert.equal(entry.context.payload, '{"api_key":"[REDACTED]","status":"useful"}');
  assert.equal(entry.context.escapedPayload, 'request={\\"access_token\\":\\"[REDACTED]\\"}');
  assert.equal(entry.context.multilinePayload, 'request={"client_secret":"[REDACTED]"} status=useful');
  assert.equal(entry.context.headers, 'X-Api-Key: [REDACTED]');
  assert.equal(entry.context.oversizedValue, 'api_key=[REDACTED] keep-this-tail');
  assert.match(entry.error.message, /request failed: Authorization: \[REDACTED\]/);
  assert.match(entry.error.stack, /request failed: Authorization: \[REDACTED\]/);
  assert.match(entry.error.cause.message, /cause remains useful: access_token=\[REDACTED\]/);
  assert.match(entry.error.cause.stack, /cause remains useful: access_token=\[REDACTED\]/);
});

test('DesktopLogger consumes quoted secret values with escaped quotes and backslashes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-desktop-logger-escaped-quotes-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const adversarial = String.raw`safe-before {\"token\":\"abc\\\"LEAK\"} safe-after`;
  const plainJson = String.raw`plain-before {"password":"secret\"LEAK-PLAIN","status":"safe"} plain-after`;
  const trailingBackslash = String.raw`path={"api_key":"LEAK-PATH\\","status":"safe"} done`;
  const bareQuoted = String.raw`bare-before token="abc\"LEAK-BARE" bare-after`;
  const escapedBareQuoted = String.raw`escaped-before token=\"abc\\\"LEAK-ESCAPED-BARE\" escaped-after`;
  const malformed = String.raw`malformed-before {\"client_secret\":\"LEAK-MALFORMED`;
  const malformedEncoding = String.raw`invalid-prefix token=\\"LEAK-INVALID`;
  const expectedAdversarial = String.raw`safe-before {\"token\":\"[REDACTED]\"} safe-after`;

  assert.equal(sanitizeDesktopLogString(adversarial), expectedAdversarial);
  assert.equal(sanitizeDesktopLogString(expectedAdversarial), expectedAdversarial, 'redaction is idempotent');
  assert.equal(
    sanitizeDesktopLogString(plainJson),
    String.raw`plain-before {"password":"[REDACTED]","status":"safe"} plain-after`,
  );
  assert.equal(
    sanitizeDesktopLogString(trailingBackslash),
    String.raw`path={"api_key":"[REDACTED]","status":"safe"} done`,
  );
  assert.equal(
    sanitizeDesktopLogString(bareQuoted),
    String.raw`bare-before token="[REDACTED]" bare-after`,
  );
  assert.equal(
    sanitizeDesktopLogString(escapedBareQuoted),
    String.raw`escaped-before token=\"[REDACTED]\" escaped-after`,
  );
  assert.equal(
    sanitizeDesktopLogString(malformed),
    String.raw`malformed-before {\"client_secret\":\"[REDACTED]`,
    'an unterminated sensitive value fails closed',
  );
  assert.equal(sanitizeDesktopLogString(malformedEncoding), 'invalid-prefix token=[REDACTED]');
  assert.equal(
    sanitizeDesktopLogString('{"author":"Ada","token":"LEAK-AUTHOR-CASE"}'),
    '{"author":"Ada","token":"[REDACTED]"}',
    'a safe key containing the letters auth is preserved',
  );

  await appendDesktopLog({
    metadataRoot: root,
    level: 'error',
    service: 'backend-client',
    event: adversarial,
    message: adversarial,
    context: {
      adjacentSafeProse: adversarial,
      nested: { detail: adversarial },
      malformed,
    },
    error: new Error(`request failed: ${adversarial}`),
  });

  const raw = await readFile(join(root, 'logs', 'forger-desktop.jsonl'), 'utf8');
  const entry = JSON.parse(raw.trim());
  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes('LEAK'), false);
  assert.equal(entry.event, expectedAdversarial);
  assert.equal(entry.message, expectedAdversarial);
  assert.equal(entry.context.adjacentSafeProse, expectedAdversarial);
  assert.equal(entry.context.nested.detail, expectedAdversarial);
  assert.equal(entry.context.malformed, String.raw`malformed-before {\"client_secret\":\"[REDACTED]`);
  assert.match(entry.error.message, /safe-before/);
  assert.match(entry.error.message, /safe-after/);
});

test('DesktopLogger recognizes compound credential keys without redacting safe semantic neighbors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-desktop-logger-compound-keys-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const plainJson = [
    'plain={"author":"Ada","authority":"local","authorizationStatus":"connected",',
    '"githubToken":"LEAK-GITHUB","oauth_token":"LEAK-OAUTH",',
    '"session-token":"LEAK-SESSION","stripeSecretKey":"LEAK-STRIPE",',
    '"database_password":"LEAK-DATABASE"} plain-safe',
  ].join('');
  const escapedJson = String.raw`escaped={\"github_token\":\"LEAK-ESCAPED-GITHUB\",\"oauthToken\":\"LEAK-ESCAPED-OAUTH\",\"authorizationStatus\":\"ready\"} escaped-safe`;
  const assignments = [
    'githubToken=LEAK-ASSIGN-GITHUB',
    'oauth-token=LEAK-ASSIGN-OAUTH',
    'session_token=LEAK-ASSIGN-SESSION',
    'stripe_secret_key=LEAK-ASSIGN-STRIPE',
    'databasePassword=LEAK-ASSIGN-DATABASE',
    'tokenValue=LEAK-ASSIGN-TOKEN-VALUE',
    'passwordHash=LEAK-ASSIGN-PASSWORD-HASH',
    'privateKeyPem=LEAK-ASSIGN-PRIVATE-KEY',
    'author=Ada',
    'authority=local',
    'authorizationStatus=connected',
  ].join(' ');

  const sanitizedPlain = sanitizeDesktopLogString(plainJson);
  assert.equal(
    sanitizedPlain,
    'plain={"author":"Ada","authority":"local","authorizationStatus":"connected",'
      + '"githubToken":"[REDACTED]","oauth_token":"[REDACTED]",'
      + '"session-token":"[REDACTED]","stripeSecretKey":"[REDACTED]",'
      + '"database_password":"[REDACTED]"} plain-safe',
  );
  assert.equal(
    sanitizeDesktopLogString(escapedJson),
    String.raw`escaped={\"github_token\":\"[REDACTED]\",\"oauthToken\":\"[REDACTED]\",\"authorizationStatus\":\"ready\"} escaped-safe`,
  );
  assert.equal(
    sanitizeDesktopLogString(assignments),
    [
      'githubToken=[REDACTED]',
      'oauth-token=[REDACTED]',
      'session_token=[REDACTED]',
      'stripe_secret_key=[REDACTED]',
      'databasePassword=[REDACTED]',
      'tokenValue=[REDACTED]',
      'passwordHash=[REDACTED]',
      'privateKeyPem=[REDACTED]',
      'author=Ada',
      'authority=local',
      'authorizationStatus=connected',
    ].join(' '),
  );

  await appendDesktopLog({
    metadataRoot: root,
    service: 'backend-client',
    event: 'compound_key_test',
    message: plainJson,
    context: {
      safeWords: { author: 'Ada', authority: 'local', authorizationStatus: 'connected' },
      compoundValues: {
        githubToken: 'LEAK-STRUCTURED-GITHUB',
        stripeSecretKey: 'LEAK-STRUCTURED-STRIPE',
        databasePassword: 'LEAK-STRUCTURED-DATABASE',
      },
    },
  });

  const entry = JSON.parse((await readFile(join(root, 'logs', 'forger-desktop.jsonl'), 'utf8')).trim());
  assert.equal(JSON.stringify(entry).includes('LEAK'), false);
  assert.deepEqual(entry.context.safeWords, {
    author: 'Ada',
    authority: 'local',
    authorizationStatus: 'connected',
  });
  assert.deepEqual(entry.context.compoundValues, {
    githubToken: '[REDACTED]',
    stripeSecretKey: '[REDACTED]',
    databasePassword: '[REDACTED]',
  });
});
