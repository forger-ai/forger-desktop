import assert from 'node:assert/strict';
import test from 'node:test';

const { sanitizeReportPayload } = await import('../../dist-electron/shared/report-sanitizer.js');

test('report sanitization is idempotent across primitive and adversarial diagnostic values', () => {
  assert.equal(sanitizeReportPayload(null), null);
  assert.equal(sanitizeReportPayload(42), 42);
  assert.equal(sanitizeReportPayload(false), false);
  assert.equal(sanitizeReportPayload(Symbol.for('diagnostic')), 'Symbol(diagnostic)');

  const input = {
    apiToken: null,
    passwords: ['one', 'two'],
    credentials: { username: 'ada', password: 'private' },
    cookie: 123,
    safe: [null, 1, true, 'visible'],
  };
  const once = sanitizeReportPayload(input);
  assert.deepEqual(once, {
    apiToken: null,
    passwords: ['[REDACTED]', '[REDACTED]'],
    credentials: { username: '[REDACTED]', password: '[REDACTED]' },
    cookie: '[REDACTED]',
    safe: [null, 1, true, 'visible'],
  });
  assert.deepEqual(sanitizeReportPayload(once), once);
});

test('report sanitization handles empty roots, aliases, Windows separators, and truncation', () => {
  const sanitized = sanitizeReportPayload('prefix C:\\Private\\Root\\file.txt suffix', {
    roots: [
      { alias: '', path: '/ignored' },
      { alias: 'IGNORED', path: null },
      { alias: 'EMPTY', path: '   ///' },
      { alias: 'ROOT', path: 'C:\\Private\\Root\\' },
    ],
    maxStringLength: 12,
  });
  assert.equal(sanitized, 'e.txt suffix\n[TRUNCATED_FROM_START]');

  const aliased = sanitizeReportPayload('C:\\Private\\Root\\nested and C:/Private/Root/other', {
    roots: [{ alias: 'ROOT/', path: 'C:\\Private\\Root' }],
  });
  assert.equal(aliased, 'ROOT/nested and ROOT/other');
});

test('report sanitization redacts encoded secret forms without changing safe Forger homes', () => {
  const privateKey = '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----';
  const sanitized = sanitizeReportPayload([
    privateKey,
    `'token': 'secret-value'`,
    'Set-Cookie: session=private-value',
    'https://name:password@example.test/?client_secret=private&ok=yes',
    '/home/ada/Documents/file.txt',
    '/home/ada/Forger/apps/demo/file.txt',
    '/Users/ada/Forger-dev/apps/demo/file.txt',
  ]);
  assert.deepEqual(sanitized, [
    '[REDACTED]',
    `'token': "[REDACTED]"`,
    'Set-Cookie: [REDACTED]',
    'https://[REDACTED]:[REDACTED]@example.test/?client_secret=[REDACTED]&ok=yes',
    '[REDACTED_PATH]/Documents/file.txt',
    '/home/ada/Forger/apps/demo/file.txt',
    '/Users/ada/Forger-dev/apps/demo/file.txt',
  ]);
});
