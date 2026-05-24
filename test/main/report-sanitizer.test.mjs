import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeReportPayload } = require('../../dist-electron/shared/report-sanitizer.js');

test('report sanitizer aliases Forger roots and redacts unknown personal paths and secrets', () => {
  const sanitized = sanitizeReportPayload({
    details: {
      appPath: '/Users/felipe/Forger/apps/finance-os/backend/app.py',
      dataPath: '/Users/felipe/Forger/data/imports/private.csv',
      unknownPath: '/Users/felipe/Desktop/random.pdf',
      windowsPath: 'C:\\Users\\Felipe\\Desktop\\random.pdf',
      bearer: 'Bearer sk-private-token-value',
      env: 'OPENAI_API_KEY=sk-private-token-value',
      email: 'felipe@example.com',
    },
    sensitiveDetails: {
      token: 'abc123456789',
      nested: { apiKey: 'secret-value' },
    },
  }, {
    roots: [
      { alias: 'FORGER_HOME/', path: '/Users/felipe/Forger' },
      { alias: 'FORGER_APPS/', path: '/Users/felipe/Forger/apps' },
      { alias: 'FORGER_APPS/finance-os/', path: '/Users/felipe/Forger/apps/finance-os' },
      { alias: 'FORGER_DATA/', path: '/Users/felipe/Forger/data' },
    ],
  });

  const text = JSON.stringify(sanitized);
  assert.match(sanitized.details.appPath, /^FORGER_APPS\/finance-os\//);
  assert.match(sanitized.details.dataPath, /^FORGER_DATA\//);
  assert.equal(text.includes('/Users/felipe/Desktop'), false);
  assert.equal(text.includes('C:\\Users\\Felipe\\Desktop'), false);
  assert.equal(text.includes('sk-private-token-value'), false);
  assert.equal(text.includes('felipe@example.com'), false);
  assert.equal(sanitized.sensitiveDetails.token, '[REDACTED]');
});
