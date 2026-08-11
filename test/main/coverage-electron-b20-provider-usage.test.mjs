import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const loadProviderUsage = () => require('../../dist-electron/main/provider-usage.js');

const disconnected = {
  codex: async () => ({ authenticated: false }),
  claude: async () => ({ authenticated: false }),
  antigravity: async () => ({ authenticated: false }),
};

const makeDeps = (overrides = {}) => ({
  fs,
  path,
  codexUsageDashboardUrl: 'https://platform.openai.com/usage',
  getCodexAuthStatus: disconnected.codex,
  getClaudeAuthStatus: disconnected.claude,
  getAntigravityAuthStatus: disconnected.antigravity,
  failureDiagnostic: (_error, fallbackCode) => ({ technicalCode: fallbackCode }),
  ...overrides,
});

test('Given named Codex buckets, when windows lack canonical durations, then their public usage windows remain normalized and deduplicated', () => {
  const { normalizeCodexUsageWindows } = loadProviderUsage();
  const future = Math.floor(Date.now() / 1000) + 3_600;
  const status = {
    authenticated: true,
    rateLimits: {
      primary: {
        limitId: 'primary-id',
        limitName: 'five hour allowance',
        primary: { usedPercent: -20, resetsAt: future },
        secondary: { usedPercent: 140, windowDurationMins: 10_000 },
      },
      buckets: [
        {
          limitId: 'primary-id',
          limitName: 'duplicate 5h',
          primary: { usedPercent: 99 },
        },
        {
          limitId: 'weekly-limit',
          limitName: '7 day quota',
          primary: { resetsAt: future },
        },
        {
          limitId: 'unknown',
          primary: { usedPercent: 50, windowDurationMins: 42 },
        },
      ],
    },
  };

  assert.deepEqual(normalizeCodexUsageWindows(status), [
    {
      kind: 'five_hour',
      label: '5h',
      source: 'codex_rate_limits',
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: future,
    },
    {
      kind: 'weekly',
      label: 'Weekly',
      source: 'codex_rate_limits',
      usedPercent: 100,
      remainingPercent: 0,
    },
  ]);

  assert.deepEqual(normalizeCodexUsageWindows({
    authenticated: true,
    rateLimits: {
      buckets: [
        { limitName: '5H', primary: { usedPercent: 10 } },
        { limitName: 'week', primary: { usedPercent: 20 } },
      ],
    },
  }).map(({ kind }) => kind), ['five_hour', 'weekly']);

  assert.deepEqual(normalizeCodexUsageWindows({
    authenticated: true,
    rateLimits: {
      buckets: [
        { limitName: 'unnamed', primary: { windowDurationMins: 300 }, secondary: {} },
        { limitName: 'unnamed', primary: { windowDurationMins: 10_000 }, secondary: {} },
        { limitName: 'unnamed', primary: { windowDurationMins: 200 }, secondary: {} },
        { limitName: 'unnamed', primary: { windowDurationMins: 400 }, secondary: {} },
        { limitName: 'unnamed', primary: { windowDurationMins: 8_000 }, secondary: {} },
        { limitName: 'unnamed', primary: { windowDurationMins: 12_000 }, secondary: {} },
      ],
    },
  }).map(({ kind }) => kind), ['five_hour', 'weekly']);

  assert.deepEqual(normalizeCodexUsageWindows({
    authenticated: true,
    rateLimits: { buckets: [{ limitName: '5 hour allowance', primary: { resetsAt: future } }] },
  }), [{ kind: 'five_hour', label: '5h', source: 'codex_rate_limits', resetsAt: future }]);
});

test('Given mixed Claude audit records, when parsing JSONL, then malformed, unknown, stale, and less useful observations are ignored', () => {
  const { parseClaudeUsageWindowsFromJsonl } = loadProviderUsage();
  const future = Math.floor(Date.now() / 1000) + 3_600;
  const stale = Math.floor(Date.now() / 1000) - 3_600;
  const records = [
    'plain text',
    '{"rate_limit_event":',
    JSON.stringify(['rate_limit_event']),
    JSON.stringify({ type: 'other', rate_limit_info: { rateLimitType: '5h' }, marker: 'rate_limit_event' }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: [] }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 5 } }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'monthly' } }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: '5-hour', utilization: Number.NaN } }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: '5_hour', utilization: 0.2, resetsAt: stale } }),
    JSON.stringify({ type: 'rate_limit_event', rateLimitInfo: { rateLimitType: '5h', resetsAt: future }, _audit_timestamp: 'bad-date' }),
    JSON.stringify({ type: 'rate_limit_event', rateLimitInfo: { rateLimitType: 'five hour', utilization: 0.3, resetsAt: future }, _audit_timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'rate_limit_event', rateLimitInfo: { rateLimitType: 'five_hour', utilization: 0.4, resetsAt: future }, _audit_timestamp: '2025-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'rate_limit_event', rateLimitInfo: { rateLimitType: '7d', utilization: 1.5, resetsAt: Number.POSITIVE_INFINITY } }),
    JSON.stringify({ type: 'rate_limit_event', rateLimitInfo: { rateLimitType: 'weekly', utilization: -1, resetsAt: future }, _audit_timestamp: '2026-01-02T00:00:00.000Z' }),
  ];

  assert.deepEqual(parseClaudeUsageWindowsFromJsonl(records.join('\n')), [
    {
      kind: 'five_hour',
      label: '5h',
      source: 'claude_audit',
      usedPercent: 30,
      remainingPercent: 70,
      resetsAt: future,
    },
    {
      kind: 'weekly',
      label: 'Weekly',
      source: 'claude_audit',
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: future,
    },
  ]);
});

test('Given Claude API payload variants, when parsing usage, then epoch units, invalid reset values, and missing windows are handled safely', () => {
  const { parseClaudeUsageWindowsFromApi } = loadProviderUsage();
  const futureSeconds = Math.floor(Date.now() / 1000) + 3_600;

  assert.deepEqual(parseClaudeUsageWindowsFromApi({
    five_hour: { utilization: 17.6, resetsAt: futureSeconds * 1_000 },
    seven_day: { utilization: 50, resets_at: 'invalid-date' },
  }), [
    {
      kind: 'five_hour',
      label: '5h',
      source: 'claude_api',
      usedPercent: 18,
      remainingPercent: 82,
      resetsAt: futureSeconds,
    },
    {
      kind: 'weekly',
      label: 'Weekly',
      source: 'claude_api',
      usedPercent: 50,
      remainingPercent: 50,
    },
  ]);
  assert.deepEqual(parseClaudeUsageWindowsFromApi({ five_hour: [] }), []);
  assert.deepEqual(parseClaudeUsageWindowsFromApi({ five_hour: { utilization: Number.POSITIVE_INFINITY } }), []);
});

test('Given the default Claude audit locations, when OAuth is unavailable, then nested local audits are discovered and handles are closed', async (t) => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-provider-b20-default-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const auditDir = path.join(root, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions', 'nested');
  await fs.mkdir(auditDir, { recursive: true });
  const future = Math.floor(Date.now() / 1000) + 3_600;
  await fs.writeFile(path.join(auditDir, 'audit.jsonl'), JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { rateLimitType: '5h', utilization: 0.45, resetsAt: future },
  }));

  const events = [];
  const result = await getAgentProviderUsage(makeDeps({
    homeDir: () => root,
    getClaudeAuthStatus: async () => ({ authenticated: true }),
    appendLog: async (event) => events.push(event),
  }));

  assert.equal(result.providers[0].windows[0].usedPercent, 45);
  assert.deepEqual(events, ['provider_usage:claude_oauth_reader_missing']);
});

test('Given many or deeply nested Claude audits, when scanning, then discovery stays bounded and unreadable files remain harmless', async () => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const entries = Array.from({ length: 81 }, (_, index) => ({
    name: `audit-${String(index).padStart(2, '0')}.jsonl`,
    isDirectory: () => false,
    isFile: () => true,
  }));
  const deepEntry = { name: 'next', isDirectory: () => true, isFile: () => false };
  const opened = [];
  const fakeFs = {
    readdir: async (dir) => dir === '/many' ? entries : [deepEntry],
    stat: async (filePath) => {
      if (filePath.endsWith('audit-00.jsonl')) throw new Error('removed');
      return { size: 0, mtimeMs: Number(filePath.match(/(\d+)\.jsonl$/)?.[1] ?? 0) };
    },
    open: async (filePath) => {
      opened.push(filePath);
      throw new Error('unreadable');
    },
  };

  const result = await getAgentProviderUsage(makeDeps({
    fs: fakeFs,
    getClaudeAuthStatus: async () => ({ authenticated: true }),
    readClaudeOAuthToken: async () => null,
    claudeAuditRoots: () => ['/deep', '/many'],
  }));

  assert.equal(result.providers[0].unavailableReason, 'no_recent_usage');
  assert.equal(opened.length, 79);
});

test('Given the built-in Claude OAuth client, when the endpoint responds, then it sends authorized bounded requests without exposing the token', async (t) => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({ five_hour: { utilization: 25 } }),
    };
  };

  const result = await getAgentProviderUsage(makeDeps({
    getClaudeAuthStatus: async () => ({ authenticated: true }),
    readClaudeOAuthToken: async () => 'super-secret-token',
    claudeAuditRoots: () => [],
  }));

  assert.equal(result.providers[0].windows[0].usedPercent, 25);
  assert.equal(requests[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer super-secret-token');
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);

  globalThis.fetch = async () => ({ ok: false });
  const unavailable = await getAgentProviderUsage(makeDeps({
    getClaudeAuthStatus: async () => ({ authenticated: true }),
    readClaudeOAuthToken: async () => 'super-secret-token',
    claudeAuditRoots: () => [],
  }));
  assert.equal(unavailable.providers[0].unavailableReason, 'no_recent_usage');
});

test('Given no audit path overrides, when the default home is used and its roots are absent, then Claude remains available without usage data', async () => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const missingFs = {
    readdir: async () => { throw new Error('missing'); },
  };

  const result = await getAgentProviderUsage(makeDeps({
    fs: missingFs,
    getClaudeAuthStatus: async () => ({ authenticated: true }),
  }));

  assert.equal(result.providers[0].unavailableReason, 'no_recent_usage');
});

test('Given OAuth reader, transport, and audit failures, when Claude usage is requested, then the public result is safe and diagnostic', async () => {
  const { getAgentProviderUsage } = loadProviderUsage();
  const events = [];
  const readerFailure = await getAgentProviderUsage(makeDeps({
    getClaudeAuthStatus: async () => ({ authenticated: true }),
    readClaudeOAuthToken: async () => { throw new Error('secret reader failure'); },
    claudeAuditRoots: () => [],
    appendLog: async (event, context) => events.push({ event, context }),
  }));
  assert.equal(readerFailure.providers[0].unavailableReason, 'no_recent_usage');

  const transportFailure = await getAgentProviderUsage(makeDeps({
    getClaudeAuthStatus: async () => ({ authenticated: true }),
    readClaudeOAuthToken: async () => 'secret',
    fetchClaudeUsagePayload: async () => { throw new Error('network failure'); },
    claudeAuditRoots: () => [],
    appendLog: async (event, context) => events.push({ event, context }),
  }));
  assert.equal(transportFailure.providers[0].unavailableReason, 'no_recent_usage');

  const auditFailure = await getAgentProviderUsage(makeDeps({
    getClaudeAuthStatus: async () => ({ authenticated: true }),
    readClaudeOAuthToken: async () => 'secret',
    fetchClaudeUsagePayload: async () => null,
    claudeAuditRoots: () => { throw new Error('private audit path'); },
  }));
  assert.equal(auditFailure.providers[0].unavailableReason, 'read_failed');
  assert.equal(JSON.stringify({ readerFailure, transportFailure, auditFailure, events }).includes('secret reader failure'), false);
});

test('Given an unexpected dependency failure, when using the safe wrapper, then a redacted failure contract is returned', async () => {
  const { getAgentProviderUsageSafely } = loadProviderUsage();
  const deps = makeDeps({
    getCodexAuthStatus: async () => ({ authenticated: true }),
    failureDiagnostic: (error, fallbackCode) => ({
      technicalCode: fallbackCode,
      technicalMessage: error instanceof Error ? 'redacted dependency failure' : 'unknown',
    }),
  });
  Object.defineProperty(deps, 'codexUsageDashboardUrl', {
    get: () => { throw new Error('/private/provider/path'); },
  });

  const result = await getAgentProviderUsageSafely(deps);

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'provider_usage_failed');
  assert.equal(result.technicalMessage, 'redacted dependency failure');
  assert.equal(JSON.stringify(result).includes('/private/provider/path'), false);
});
