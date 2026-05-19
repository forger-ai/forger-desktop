import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AuthConnectAttemptTracker } = require('../../dist-electron/shared/auth-connect-attempts.js');

test('closing a provider modal cancels the active polling attempt and clears busy provider', () => {
  const tracker = new AuthConnectAttemptTracker();
  const codexAttempt = tracker.begin('codex');

  assert.equal(tracker.busyProvider, 'codex');
  assert.equal(tracker.isActive(codexAttempt), true);

  const canceled = tracker.cancel('codex');

  assert.equal(canceled, codexAttempt);
  assert.equal(codexAttempt.canceled, true);
  assert.equal(tracker.busyProvider, null);
  assert.equal(tracker.isActive(codexAttempt), false);
});

test('late results from a canceled attempt do not finish a new provider attempt', () => {
  const tracker = new AuthConnectAttemptTracker();
  const codexAttempt = tracker.begin('codex');
  tracker.cancel('codex');
  const claudeAttempt = tracker.begin('claude');

  assert.equal(tracker.finish(codexAttempt), null);
  assert.equal(tracker.busyProvider, 'claude');
  assert.equal(tracker.isActive(claudeAttempt), true);
});

test('a new connect attempt after cancellation is active normally', () => {
  const tracker = new AuthConnectAttemptTracker();
  const first = tracker.begin('codex');
  tracker.cancel('codex');

  const second = tracker.begin('codex');

  assert.notEqual(first.id, second.id);
  assert.equal(tracker.busyProvider, 'codex');
  assert.equal(tracker.isActive(first), false);
  assert.equal(tracker.isActive(second), true);
});
