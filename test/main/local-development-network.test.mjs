import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyNetworkCase, buildNetworkProfile, runNetworkCanary } from '../../scripts/local-development/network-canary.mjs';

test('only permission denial and zero receiver bytes prove a denied network attempt', () => {
  for (const errorCode of ['EPERM', 'EACCES']) {
    assert.equal(classifyNetworkCase({ mode: 'restricted', allowed: false, received: false, attempt: { errorCode } }), 'denied');
  }
  for (const errorCode of ['ETIMEDOUT', 'ECONNREFUSED', 'ENOENT', 'UNKNOWN']) {
    assert.equal(classifyNetworkCase({ mode: 'restricted', allowed: false, received: false, attempt: { errorCode } }), 'blocked');
  }
  assert.equal(classifyNetworkCase({ mode: 'restricted', allowed: false, received: true, attempt: { errorCode: 'EPERM' } }), 'leaked');
  assert.equal(classifyNetworkCase({ mode: 'restricted', allowed: false, received: false, attempt: { connected: true } }), 'inconclusive');
});

test('baseline and explicitly allowed routes require acknowledged supervisor receipt', () => {
  assert.equal(classifyNetworkCase({ mode: 'baseline', received: true, attempt: { acknowledged: true } }), 'reachable');
  assert.equal(classifyNetworkCase({ mode: 'baseline', received: false, attempt: { acknowledged: true } }), 'blocked');
  assert.equal(classifyNetworkCase({ mode: 'restricted', allowed: true, received: true, attempt: { acknowledged: true } }), 'reachable');
});

test('network profile allows only a numeric loopback port and rejects injected rules', () => {
  const profile = buildNetworkProfile(12345);
  assert.ok(profile.includes('(deny network*)'));
  assert.ok(profile.includes('(remote tcp "localhost:12345")'));
  for (const port of [0, 65536, NaN, '123)(allow default)']) assert.throws(() => buildNetworkProfile(port), /port/);
});

test('real baseline checks local protocols and descendants without external destinations', async () => {
  const result = await runNetworkCanary({ baselineOnly: true, timeoutMs: 1000, depths: [0, 1, 2] });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.nodeVersion, process.version);
  assert.match(result.scriptSha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof result.osRelease, 'string');
  assert.equal(result.externalTrafficAttempted, false);
  assert.equal(result.codexProcessTested, false);
  assert.equal(result.ollamaProcessTested, false);
  assert.ok(result.cases.length >= 15);
  // Unsupported IPv6/Unix or an outer sandbox are recorded as blocked, never as a privacy pass.
  for (const entry of result.cases) {
    assert.ok(['reachable', 'blocked'].includes(entry.outcome));
    if (entry.outcome === 'reachable') assert.equal(entry.receiverObservedNonce, true);
  }
  assert.ok(result.cases.some((entry) => entry.depth === 2));
});
