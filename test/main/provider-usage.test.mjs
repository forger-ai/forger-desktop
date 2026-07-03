import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const loadProviderUsage = () => require('../../dist-electron/main/provider-usage.js');

const makeDeps = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-provider-usage-'));
  const deps = {
    fs,
    path,
    codexUsageDashboardUrl: 'https://platform.openai.com/usage',
    getCodexAuthStatus: async () => ({ authenticated: false, installed: true, authFilePath: '', codexHome: '' }),
    getClaudeAuthStatus: async () => ({ authenticated: false, installed: true, source: 'managed' }),
    getAntigravityAuthStatus: async () => ({ authenticated: false, installed: true, source: 'managed' }),
    failureDiagnostic: (error, fallbackCode) => ({
      technicalCode: error instanceof Error ? error.message : fallbackCode,
    }),
    homeDir: () => root,
    claudeAuditRoots: () => [path.join(root, 'claude-audits')],
    ...overrides,
  };
  return { root, deps };
};

test('provider usage normalizes Codex 5h and weekly rate limit windows including secondary buckets', async (t) => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const fiveHourReset = Math.floor(Date.now() / 1000) + 60 * 60;
  const weeklyReset = Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60;
  const { root, deps } = await makeDeps({
    getCodexAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      authFilePath: '',
      codexHome: '',
      rateLimits: {
        checkedAt: '2026-07-03T12:00:00.000Z',
        buckets: [
          {
            limitId: 'codex',
            limitName: 'Codex usage',
            primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: fiveHourReset },
            secondary: { usedPercent: 51, windowDurationMins: 10080, resetsAt: weeklyReset },
          },
        ],
      },
    }),
  });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const result = await getAgentProviderUsage(deps);

  assert.equal(result.success, true);
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].provider, 'codex');
  assert.equal(result.providers[0].unavailableReason, undefined);
  assert.deepEqual(result.providers[0].windows.map((entry) => ({
    kind: entry.kind,
    label: entry.label,
    usedPercent: entry.usedPercent,
    remainingPercent: entry.remainingPercent,
    resetsAt: entry.resetsAt,
    source: entry.source,
  })), [
    { kind: 'five_hour', label: '5h', usedPercent: 8, remainingPercent: 92, resetsAt: fiveHourReset, source: 'codex_rate_limits' },
    { kind: 'weekly', label: 'Weekly', usedPercent: 51, remainingPercent: 49, resetsAt: weeklyReset, source: 'codex_rate_limits' },
  ]);
});

test('provider usage ignores stale Codex and Claude reset windows', async () => {
  const { normalizeCodexUsageWindows, parseClaudeUsageWindowsFromJsonl } = loadProviderUsage();
  const staleReset = Math.floor(Date.now() / 1000) - 60 * 60;

  assert.deepEqual(normalizeCodexUsageWindows({
    installed: true,
    authenticated: true,
    authFilePath: '',
    codexHome: '',
    rateLimits: {
      checkedAt: new Date().toISOString(),
      buckets: [
        { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: staleReset } },
      ],
    },
  }), []);

  assert.deepEqual(parseClaudeUsageWindowsFromJsonl(JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.4, resetsAt: staleReset },
    _audit_timestamp: new Date().toISOString(),
  })), []);
});

test('provider usage keeps Codex connected with a dashboard fallback when rate limits are missing', async (t) => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const { root, deps } = await makeDeps({
    getCodexAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      authFilePath: '',
      codexHome: '',
    }),
  });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const result = await getAgentProviderUsage(deps);

  assert.equal(result.providers[0].provider, 'codex');
  assert.deepEqual(result.providers[0].windows, []);
  assert.equal(result.providers[0].unavailableReason, 'not_available');
  assert.equal(result.providers[0].externalUrl, 'https://platform.openai.com/usage');
});

test('provider usage parses latest Claude rate limit audit windows and ignores malformed JSONL', async (t) => {
  const { getAgentProviderUsage, parseClaudeUsageWindowsFromJsonl } = loadProviderUsage();
  const futureFiveHourReset = Math.floor(Date.now() / 1000) + 3 * 60 * 60;
  const laterFiveHourReset = futureFiveHourReset + 20 * 60;
  const futureWeeklyReset = Math.floor(Date.now() / 1000) + 4 * 24 * 60 * 60;
  const text = [
    '{broken',
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.6, resetsAt: futureFiveHourReset },
      _audit_timestamp: '2026-07-03T12:00:00.000Z',
    }),
    JSON.stringify({
      type: 'rate_limit_event',
      rateLimitInfo: { status: 'allowed_warning', rateLimitType: 'weekly_limit', utilization: 0.31, resetsAt: futureWeeklyReset },
      _audit_timestamp: '2026-07-03T12:01:00.000Z',
    }),
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: laterFiveHourReset },
      _audit_timestamp: '2026-07-03T12:02:00.000Z',
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeUsageWindowsFromJsonl(text).map((entry) => ({
    kind: entry.kind,
    usedPercent: entry.usedPercent,
    remainingPercent: entry.remainingPercent,
    resetsAt: entry.resetsAt,
  })), [
    { kind: 'five_hour', usedPercent: 60, remainingPercent: 40, resetsAt: futureFiveHourReset },
    { kind: 'weekly', usedPercent: 31, remainingPercent: 69, resetsAt: futureWeeklyReset },
  ]);

  const { root, deps } = await makeDeps({
    getClaudeAuthStatus: async () => ({ installed: true, authenticated: true, source: 'managed' }),
  });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const auditDir = path.join(root, 'claude-audits', 'session');
  await fs.mkdir(auditDir, { recursive: true });
  await fs.writeFile(path.join(auditDir, 'audit.jsonl'), text, 'utf8');

  const result = await getAgentProviderUsage(deps);
  const claude = result.providers.find((entry) => entry.provider === 'claude');

  assert.equal(claude?.unavailableReason, undefined);
  assert.equal(claude?.windows[0].kind, 'five_hour');
  assert.equal(claude?.windows[0].remainingPercent, 40);
  assert.equal(claude?.externalUrl, 'https://claude.ai/settings/usage');
});

test('provider usage returns Claude and Antigravity fallbacks when no reliable usage source exists', async (t) => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const { root, deps } = await makeDeps({
    getClaudeAuthStatus: async () => ({ installed: true, authenticated: true, source: 'managed' }),
    getAntigravityAuthStatus: async () => ({ installed: true, authenticated: true, source: 'managed' }),
  });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const result = await getAgentProviderUsage(deps);
  const claude = result.providers.find((entry) => entry.provider === 'claude');
  const antigravity = result.providers.find((entry) => entry.provider === 'antigravity');

  assert.deepEqual(claude?.windows, []);
  assert.equal(claude?.unavailableReason, 'no_recent_usage');
  assert.equal(claude?.externalUrl, 'https://claude.ai/settings/usage');
  assert.deepEqual(antigravity?.windows, []);
  assert.equal(antigravity?.unavailableReason, 'not_available');
  assert.equal(antigravity?.externalUrl, 'https://gemini.google.com/usage');
  assert.equal(JSON.stringify(result).includes('/docs/'), false);
  assert.equal(JSON.stringify(result).includes('quotas'), false);
});

test('provider usage reads live Claude windows from the OAuth usage endpoint', async (t) => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const resetsAt = Math.floor(Date.now() / 1000) + 60 * 60;
  const { root, deps } = await makeDeps({
    getClaudeAuthStatus: async () => ({ installed: true, authenticated: true, source: 'managed' }),
    readClaudeOAuthToken: async () => 'token-123',
    fetchClaudeUsagePayload: async (token) => {
      assert.equal(token, 'token-123');
      return {
        five_hour: { utilization: 34, resets_at: new Date(resetsAt * 1000).toISOString() },
        seven_day: { utilization: 71.4, resets_at: resetsAt + 4 * 24 * 60 * 60 },
      };
    },
  });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const result = await getAgentProviderUsage(deps);
  const claude = result.providers.find((entry) => entry.provider === 'claude');

  assert.equal(claude?.unavailableReason, undefined);
  assert.equal(claude?.windows.length, 2);
  const fiveHour = claude.windows.find((window) => window.kind === 'five_hour');
  const weekly = claude.windows.find((window) => window.kind === 'weekly');
  assert.equal(fiveHour?.source, 'claude_api');
  assert.equal(fiveHour?.usedPercent, 34);
  assert.equal(fiveHour?.remainingPercent, 66);
  assert.equal(fiveHour?.resetsAt, resetsAt);
  assert.equal(weekly?.usedPercent, 71);
  assert.equal(weekly?.remainingPercent, 29);
});

test('provider usage falls back to Claude audit files when the OAuth endpoint has no data', async (t) => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const resetsAt = Math.floor(Date.now() / 1000) + 60 * 60;
  const { root, deps } = await makeDeps({
    getClaudeAuthStatus: async () => ({ installed: true, authenticated: true, source: 'managed' }),
    readClaudeOAuthToken: async () => 'token-123',
    fetchClaudeUsagePayload: async () => null,
  });
  const auditDir = path.join(root, 'claude-audits');
  await fs.mkdir(auditDir, { recursive: true });
  await fs.writeFile(
    path.join(auditDir, 'audit.jsonl'),
    `${JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.25, resetsAt },
      _audit_timestamp: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const result = await getAgentProviderUsage(deps);
  const claude = result.providers.find((entry) => entry.provider === 'claude');

  assert.equal(claude?.windows.length, 1);
  assert.equal(claude?.windows[0]?.source, 'claude_audit');
  assert.equal(claude?.windows[0]?.usedPercent, 25);
});

test('parseClaudeUsageWindowsFromApi ignores malformed payloads and stale resets', async () => {
  const { parseClaudeUsageWindowsFromApi } = loadProviderUsage();
  const staleReset = Math.floor(Date.now() / 1000) - 60 * 60;

  assert.deepEqual(parseClaudeUsageWindowsFromApi(null), []);
  assert.deepEqual(parseClaudeUsageWindowsFromApi('nope'), []);
  assert.deepEqual(parseClaudeUsageWindowsFromApi({ five_hour: { utilization: 'high' } }), []);
  assert.deepEqual(parseClaudeUsageWindowsFromApi({ five_hour: { utilization: 20, resets_at: staleReset } }), []);

  const windows = parseClaudeUsageWindowsFromApi({ seven_day: { utilization: 150 } });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'weekly');
  assert.equal(windows[0].usedPercent, 100);
  assert.equal(windows[0].remainingPercent, 0);
});

test('provider usage safe wrapper returns diagnostics without raw provider details', async (t) => {
  const { getAgentProviderUsageSafely } = loadProviderUsage();
  const { root, deps } = await makeDeps({
    getCodexAuthStatus: async () => {
      throw new Error('/Users/example/private/path');
    },
    getClaudeAuthStatus: async () => {
      throw new Error('claude private output');
    },
    getAntigravityAuthStatus: async () => {
      throw new Error('agy private output');
    },
    failureDiagnostic: (_error, fallbackCode) => ({ technicalCode: fallbackCode }),
  });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const result = await getAgentProviderUsageSafely(deps);

  assert.equal(result.success, true);
  assert.deepEqual(result.providers, []);
  assert.equal(JSON.stringify(result).includes('/Users/example'), false);
});
