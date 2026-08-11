import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  createProviderQuotaError,
  detectProviderModelUnsupportedError,
  detectProviderQuotaError,
} = require('../../dist-electron/main/llm-provider/provider-errors.js');
const {
  buildFailureDiagnostic,
  isStableTechnicalCode,
  normalizeErrorReportDiagnostic,
} = require('../../dist-electron/shared/error-diagnostics.js');
const {
  DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MINUTES,
  normalizeProviderInactivityTimeoutMinutes,
  providerInactivityTimeoutMinutesToMs,
} = require('../../dist-electron/shared/provider-timeouts.js');

test('provider inactivity timeout normalization accepts only supported finite options', () => {
  assert.equal(DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MINUTES, 240);
  assert.equal(normalizeProviderInactivityTimeoutMinutes(undefined), 240);
  assert.equal(normalizeProviderInactivityTimeoutMinutes('30', 30), 30);
  assert.equal(normalizeProviderInactivityTimeoutMinutes(Number.POSITIVE_INFINITY, 60), 60);
  assert.equal(normalizeProviderInactivityTimeoutMinutes(29.6), 30);
  assert.equal(normalizeProviderInactivityTimeoutMinutes(31, 120), 120);
  assert.equal(normalizeProviderInactivityTimeoutMinutes(31, 17), 240);
  assert.equal(normalizeProviderInactivityTimeoutMinutes(31, Number.NaN), 240);
  assert.equal(normalizeProviderInactivityTimeoutMinutes(0), 0);
  assert.equal(providerInactivityTimeoutMinutesToMs(60), 3_600_000);
});

test('provider quota errors recognize provider-specific formats and safe reset hints', () => {
  assert.equal(detectProviderQuotaError('codex', undefined, ' '), null);
  assert.equal(detectProviderQuotaError('codex', 'ordinary failure'), null);
  assert.equal(detectProviderQuotaError('antigravity', 'ordinary failure'), null);

  assert.deepEqual(detectProviderQuotaError('antigravity', 'RESOURCE_EXHAUSTED. Resets in 30 minutes.'), {
    chatCode: 'quota_exceeded',
    message: 'Google Antigravity quota exceeded; resets 30 minutes',
  });
  assert.deepEqual(detectProviderQuotaError('codex', 'rate limit reached; reset at 4pm.'), {
    chatCode: 'quota_exceeded',
    message: 'Codex quota exceeded; resets 4pm',
  });
  assert.deepEqual(detectProviderQuotaError('claude', '"error":"rate_limit"; resets tomorrow.'), {
    chatCode: 'quota_exceeded',
    message: 'Claude Code quota exceeded; resets tomorrow',
  });
  assert.deepEqual(detectProviderQuotaError('claude', '{"api_error_status":429}'), {
    chatCode: 'quota_exceeded',
    message: 'Claude Code quota exceeded',
  });
  assert.deepEqual(detectProviderQuotaError('claude', '{"type":"rate_limit_event","status":"rejected"}'), {
    chatCode: 'quota_exceeded',
    message: 'Claude Code quota exceeded',
  });

  const error = createProviderQuotaError({ chatCode: 'quota_exceeded', message: 'Limit reached' });
  assert.equal(error.message, 'Limit reached');
  assert.equal(error.chatCode, 'quota_exceeded');
});

test('unsupported-model detection normalizes documented provider message forms', () => {
  assert.equal(detectProviderModelUnsupportedError('codex', undefined, ''), null);
  assert.equal(detectProviderModelUnsupportedError('codex', 'model gpt-5.2 is available'), null);
  assert.equal(detectProviderModelUnsupportedError('codex', 'unsupported operation'), null);
  assert.equal(detectProviderModelUnsupportedError('codex', 'model is unsupported'), null);

  assert.deepEqual(detectProviderModelUnsupportedError('codex', "The 'gpt-future' model is not supported"), {
    chatCode: 'model_unsupported',
    message: 'Codex model unsupported: gpt-future',
    model: 'gpt-future',
  });
  assert.deepEqual(detectProviderModelUnsupportedError('claude', 'model `claude-next` is not supported'), {
    chatCode: 'model_unsupported',
    message: 'Claude Code model unsupported: claude-next',
    model: 'claude-next',
  });
  assert.deepEqual(detectProviderModelUnsupportedError('antigravity', 'model gemini.next unsupported'), {
    chatCode: 'model_unsupported',
    message: 'Google Antigravity model unsupported: gemini.next',
    model: 'gemini.next',
  });
});

test('stable diagnostic codes reject volatile command output and malformed identifiers', () => {
  assert.equal(isStableTechnicalCode(undefined), false);
  assert.equal(isStableTechnicalCode(''), false);
  assert.equal(isStableTechnicalCode('command_failed_1'), false);
  assert.equal(isStableTechnicalCode('command_failed_null'), false);
  assert.equal(isStableTechnicalCode('A'.repeat(121)), false);
  assert.equal(isStableTechnicalCode('Bad Code'), false);
  assert.equal(isStableTechnicalCode('runtime_error:ENOENT'), true);
});

test('failure diagnostics classify runtime, auth, memory, timeout, disk, and command failures', () => {
  const classifications = [
    ['env: node: No such file or directory', 'codex_node_runtime_missing'],
    ['runtime_node_executable_not_found', 'runtime_node_executable_not_found'],
    ['401 Unauthorized: Failed to refresh token', 'codex_auth_expired'],
    ['Fatal process out of memory; Failed to reserve virtual memory for CodeRange', 'node_fatal_oom_code_range'],
    ['CommandTimeoutError after 10 seconds', 'command_timeout'],
    ['ENOSPC: no space left on device', 'disk_space_unavailable'],
    ['antigravity Remove-Item failed because file is being used by another process', 'antigravity_cli_install_concurrent_file_lock'],
    ['command_failed_17: process exited', 'command_failed'],
    ['command_failed_null: process ended', 'command_failed'],
    ['ENOTEMPTY: directory not empty', 'filesystem_enotempty'],
  ];
  for (const [rawError, expected] of classifications) {
    const diagnostic = buildFailureDiagnostic({ fallbackCode: 'fallback_error', rawError });
    assert.equal(diagnostic.technicalCode, expected);
    assert.equal(diagnostic.details.classifier, expected);
  }
  assert.equal(buildFailureDiagnostic({ fallbackCode: 'invalid fallback!' }).technicalCode, 'desktop_error');
  assert.equal(buildFailureDiagnostic({ fallbackCode: 'safe_fallback' }).technicalCode, 'safe_fallback');
});

test('failure diagnostics separate public command metadata from sensitive execution data', () => {
  const error = Object.assign(new Error('failed'), {
    details: { operation: 'clone', empty: '' },
    exitCode: 2,
    signal: 'SIGTERM',
    command: 'git',
    args: ['clone', 'secret'],
    cwd: '/private/work',
    timeoutMs: 100,
    stdout: 'output',
    stderr: 'ENOSPC',
  });
  error.stack = 'Error: failed\n at runner';
  const diagnostic = buildFailureDiagnostic({
    fallbackCode: 'fallback_error',
    technicalCode: 'command_failed_2',
    error,
    details: { requestId: 'request-1', omitted: undefined },
    sensitiveDetails: { token: 'secret', omitted: '' },
  });

  assert.equal(diagnostic.technicalCode, 'disk_space_unavailable');
  assert.deepEqual(diagnostic.details, {
    requestId: 'request-1',
    classifier: 'disk_space_unavailable',
    operation: 'clone',
    exitCode: 2,
    signal: 'SIGTERM',
  });
  assert.equal(diagnostic.sensitiveDetails.token, 'secret');
  assert.equal(diagnostic.sensitiveDetails.rawTechnicalCode, 'command_failed_2');
  assert.equal(diagnostic.sensitiveDetails.rawError, undefined);
  assert.equal(diagnostic.sensitiveDetails.stack, error.stack);
  assert.equal(diagnostic.sensitiveDetails.command, 'git');
  assert.deepEqual(diagnostic.sensitiveDetails.args, ['clone', 'secret']);
  assert.equal(diagnostic.sensitiveDetails.cwd, '/private/work');
  assert.equal(diagnostic.sensitiveDetails.timeoutMs, 100);
  assert.equal(diagnostic.sensitiveDetails.stdout, 'output');
  assert.equal(diagnostic.sensitiveDetails.stderr, 'ENOSPC');

  const stable = buildFailureDiagnostic({
    fallbackCode: 'fallback_error',
    technicalCode: 'already_stable',
    rawError: 'already_stable',
    error: 'string failure',
  });
  assert.equal(stable.technicalCode, 'already_stable');
  assert.equal(stable.sensitiveDetails, undefined);
});

test('flatten diagnostics publish only basenames and normalize report fallbacks', () => {
  const flatten = buildFailureDiagnostic({
    fallbackCode: 'install_failed',
    rawError: "flattenSingleTopLevelDirectory EPERM rename 'C:\\private\\source' -> '/secret/target'",
  });
  assert.deepEqual(flatten.details, {
    classifier: 'install_extract_flatten_failed',
    operation: 'flatten',
    errorCode: 'EPERM',
    sourceName: 'source',
    targetName: 'target',
  });
  const flattenWithoutRename = buildFailureDiagnostic({
    fallbackCode: 'install_failed',
    rawError: 'flatten:move_fallback EACCES',
  });
  assert.deepEqual(flattenWithoutRename.details, {
    classifier: 'install_extract_flatten_failed',
    operation: 'flatten',
  });
  const flattenRootNames = buildFailureDiagnostic({
    fallbackCode: 'install_failed',
    rawError: "flattenSingleTopLevelDirectory EEXIST rename '/' -> '\\\\'",
  });
  assert.equal(flattenRootNames.details.sourceName, '/');
  assert.equal(flattenRootNames.details.targetName, '\\\\');

  const recordWithoutDetailsOrOutput = buildFailureDiagnostic({
    fallbackCode: 'fallback_error',
    error: { exitCode: 0 },
  });
  assert.deepEqual(recordWithoutDetailsOrOutput.details, { exitCode: 0 });

  const stable = { source: 'Desktop', operation: 'Save', technicalCode: 'stable_error', details: { keep: true } };
  assert.equal(normalizeErrorReportDiagnostic(stable), stable);
  const missing = { source: 'Desktop', operation: 'Save' };
  assert.equal(normalizeErrorReportDiagnostic(missing), missing);
  assert.deepEqual(normalizeErrorReportDiagnostic({
    source: 'Agent Runtime',
    operation: 'Install App!',
    technicalCode: 'command_failed_3',
    details: { keep: true },
    sensitiveDetails: { private: true },
  }), {
    source: 'Agent Runtime',
    operation: 'Install App!',
    technicalCode: 'command_failed',
    details: { keep: true, exitCode: '3', classifier: 'command_failed' },
    sensitiveDetails: { private: true, rawTechnicalCode: 'command_failed_3' },
  });
  assert.equal(normalizeErrorReportDiagnostic({ technicalCode: 'bad value' }).technicalCode, 'desktop_error_failed');
});
