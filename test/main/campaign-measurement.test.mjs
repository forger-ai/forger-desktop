import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CampaignMeasurement } = require('../../dist-electron/main/campaign-measurement.js');
const { createCampaignCaptureTransport } = require('../../dist-electron/main/campaign-measurement-transport.js');
const CODE = 'ig_202609_paid_01';

async function harness(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-measurement-test-'));
  const calls = [];
  let now = Date.parse('2026-09-16T10:00:00Z');
  const options = { filePath: path.join(root, 'measurement.json'), enabled: true, environment: 'test',
    version: '0.5.18', platform: 'darwin', now: () => now,
    send: async (payload) => { calls.push(payload); return true; }, ...overrides };
  const manager = new CampaignMeasurement(options);
  t.after(async () => { manager.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { manager, calls, options, advance: (ms) => { now += ms; }, read: async () => JSON.parse(await fs.readFile(options.filePath, 'utf8')) };
}

test('fresh profiles send nothing and create no identifier before explicit consent, including decline', async (t) => {
  const h = await harness(t);
  assert.equal((await h.manager.initialize(false)).consent, 'undecided');
  await h.manager.flush();
  assert.deepEqual(h.calls, []);
  assert.equal((await h.read()).profileId, null);
  await h.manager.setConsent(false, CODE);
  await h.manager.recordFirstAppCreated();
  await h.manager.flush();
  assert.deepEqual(h.calls, []);
  assert.equal((await h.read()).profileId, null);
});

test('explicit consent captures only two minimal deduplicated events, with immutable campaign', async (t) => {
  const h = await harness(t);
  await h.manager.initialize(false);
  await h.manager.setConsent(true, CODE);
  await h.manager.flush();
  await h.manager.recordFirstAppCreated();
  await h.manager.recordFirstAppCreated();
  await h.manager.flush();
  assert.deepEqual(h.calls.map((e) => e.event), ['forger_campaign_first_open', 'forger_campaign_first_app_created']);
  assert.equal(h.calls[0].distinct_id, h.calls[1].distinct_id);
  for (const event of h.calls) {
    assert.deepEqual(Object.keys(event).sort(), ['distinct_id', 'event', 'properties', 'timestamp', 'uuid']);
    assert.deepEqual(event.properties, { campaign_code: CODE, surface: 'desktop', schema_version: 1,
      environment: 'test', version: '0.5.18', platform: 'darwin', $process_person_profile: false, $geoip_disable: true });
  }
  await assert.rejects(h.manager.setConsent(true, 'ig_202609_paid_02'), /campaign_locked/);
  await h.manager.setConsent(false);
  await h.manager.setConsent(true, CODE);
  await h.manager.flush();
  assert.equal(h.calls.length, 2);
});

test('existing or unknown profiles never become new acquisitions', async (t) => {
  for (const existing of [true, undefined, null, 'false']) {
    const h = await harness(t);
    await h.manager.initialize(existing);
    await h.manager.setConsent(true, CODE);
    await h.manager.recordFirstAppCreated();
    await h.manager.flush();
    assert.deepEqual(h.calls, []);
  }
});

test('first app made before consent is not backfilled or replaced by a later app', async (t) => {
  const h = await harness(t);
  await h.manager.initialize(false);
  await h.manager.recordFirstAppCreated();
  await h.manager.setConsent(true);
  await h.manager.recordFirstAppCreated();
  await h.manager.flush();
  assert.deepEqual(h.calls.map((e) => e.event), ['forger_campaign_first_open']);
  assert.equal(h.calls[0].properties.campaign_code, 'unattributed');
});

test('consent on a later launch does not backfill first open', async (t) => {
  const h = await harness(t);
  await h.manager.initialize(false);
  h.manager.close();
  const second = new CampaignMeasurement(h.options);
  t.after(() => second.close());
  await second.initialize(false);
  await second.setConsent(true, CODE);
  await second.recordFirstAppCreated();
  await second.flush();
  assert.deepEqual(h.calls, []);
});

test('offline outbox retries the same UUID, survives restart, and is bounded', async (t) => {
  const attempts = [];
  const h = await harness(t, { send: async (p) => { attempts.push(p); return false; } });
  await h.manager.initialize(false);
  await h.manager.setConsent(true, CODE);
  await h.manager.flush();
  await assert.rejects(h.manager.setConsent(true, 'ig_202609_paid_02'), /campaign_locked/);
  h.manager.close();
  const second = new CampaignMeasurement({ ...h.options, version: '9.0.0', platform: 'linux' });
  t.after(() => second.close());
  await second.initialize(false);
  for (let i = 0; i < 7; i += 1) { h.advance(3_600_000); await second.flush(); }
  assert.equal(attempts.length, 5);
  assert.equal(new Set(attempts.map((p) => p.uuid)).size, 1);
  for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
  assert.equal((await h.read()).outbox.length, 0);
});

test('revoke aborts an in-flight send and permanently clears pending events', async (t) => {
  let signal;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const h = await harness(t, { send: async (_p, abortSignal) => {
    signal = abortSignal; entered();
    return await new Promise((resolve) => abortSignal.addEventListener('abort', () => resolve(false), { once: true }));
  } });
  await h.manager.initialize(false);
  await h.manager.setConsent(true, CODE);
  const flushing = h.manager.flush();
  await started;
  await h.manager.setConsent(false);
  await flushing;
  assert.equal(signal.aborted, true);
  assert.equal((await h.read()).outbox.length, 0);
  assert.equal((await h.read()).profileId, null);
  assert.equal((await h.read()).newProfile, false);
  await h.manager.setConsent(true, CODE);
  await h.manager.recordFirstAppCreated();
  assert.equal((await h.read()).outbox.length, 0);
  assert.equal((await h.read()).profileId, null);
});

test('disabled builds, malformed state and arbitrary campaign strings fail closed', async (t) => {
  const h = await harness(t, { enabled: false });
  await h.manager.initialize(false);
  await h.manager.setConsent(true, CODE);
  await h.manager.flush();
  assert.deepEqual(h.calls, []);
  assert.equal((await h.read()).profileId, null);
  const fresh = await harness(t);
  await fresh.manager.initialize(false);
  for (const code of ['test@example.com', 'ig_202609_paid_01&email=x', {}, 'unknown']) {
    await assert.rejects(fresh.manager.setConsent(true, code), /invalid_campaign/);
  }
  await fs.writeFile(fresh.options.filePath, '{broken');
  const broken = new CampaignMeasurement(fresh.options);
  t.after(() => broken.close());
  assert.equal((await broken.initialize(false)).newProfile, false);
  await broken.setConsent(true, CODE);
  await broken.flush();
  assert.deepEqual(fresh.calls, []);
});

test('transport uses fixed host, no redirects or browser context, and no SDK properties', async () => {
  const requests = [];
  const transport = createCampaignCaptureTransport('phc_test', async (...args) => {
    requests.push(args); return { ok: true };
  });
  const payload = { event: 'forger_campaign_first_open', distinct_id: 'random', uuid: 'event', timestamp: 'time', properties: {} };
  assert.equal(await transport(payload, new AbortController().signal), true);
  assert.equal(requests[0][0], 'https://us.i.posthog.com/i/v0/e/');
  assert.equal(requests[0][1].redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0][1].body), { api_key: 'phc_test', ...payload });
  assert.deepEqual(requests[0][1].headers, { 'Content-Type': 'application/json' });
});

test('concurrent flushes share one send and successful retry removes exactly one event', async (t) => {
  const h = await harness(t);
  await h.manager.initialize(false); await h.manager.setConsent(true, CODE);
  await Promise.all([h.manager.flush(), h.manager.flush(), h.manager.flush()]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual((await h.read()).outbox, []);
});

test('withdrawal remains durable when either marker or main state write fails', async (t) => {
  for (const failMarker of [true, false]) {
    const h = await harness(t, { send: async () => false });
    await h.manager.initialize(false); await h.manager.setConsent(true, CODE);
    const originalWrite = fs.writeFile;
    const mocked = t.mock.method(fs, 'writeFile', async (file, ...args) => {
      if (file === `${h.options.filePath}.${failMarker ? 'withdrawn' : 'tmp'}`) throw new Error('simulated_disk_failure');
      return originalWrite(file, ...args);
    });
    assert.equal((await h.manager.setConsent(false)).consent, 'disabled');
    mocked.mock.restore();
    h.manager.close();
    const resumed = new CampaignMeasurement(h.options); t.after(() => resumed.close());
    assert.equal((await resumed.initialize(false)).consent, 'disabled');
    assert.equal((await resumed.getStatus()).newProfile, false);
    await resumed.setConsent(true, CODE); await resumed.recordFirstAppCreated(); await resumed.flush();
    assert.equal((await h.read()).profileId, null);
    assert.deepEqual((await h.read()).outbox, []);
  }
});

test('failed withdrawal persistence reports error but pauses this process and erases its pending state', async (t) => {
  const h = await harness(t);
  await h.manager.initialize(false); await h.manager.setConsent(true, CODE);
  const mocked = t.mock.method(fs, 'writeFile', async () => { throw new Error('read_only'); });
  await assert.rejects(h.manager.setConsent(false), /read_only/);
  await h.manager.flush();
  assert.deepEqual(h.calls, []);
  assert.equal((await h.manager.getStatus()).consent, 'disabled');
  mocked.mock.restore();
});

test('expired pending events are discarded without another network attempt', async (t) => {
  const h = await harness(t);
  await h.manager.initialize(false); await h.manager.setConsent(true, CODE);
  h.advance(8 * 24 * 60 * 60 * 1000);
  await h.manager.flush();
  assert.deepEqual(h.calls, []);
  assert.deepEqual((await h.read()).outbox, []);
});

test('durable withdrawal marker stops sending after stale-state cleanup fails and reports incomplete persistence', async (t) => {
  const h = await harness(t);
  await h.manager.initialize(false); await h.manager.setConsent(true, CODE);
  const write = fs.writeFile;
  const remove = fs.rm;
  const writeMock = t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (file === `${h.options.filePath}.tmp`) throw new Error('write_failed');
    return write(file, ...args);
  });
  const removeMock = t.mock.method(fs, 'rm', async (file, ...args) => {
    if (file === h.options.filePath) throw new Error('cleanup_failed');
    return remove(file, ...args);
  });
  await assert.rejects(h.manager.setConsent(false), /cleanup_failed/);
  await h.manager.flush(); assert.deepEqual(h.calls, []);
  writeMock.mock.restore(); removeMock.mock.restore();
  h.manager.close();
  const next = new CampaignMeasurement(h.options); t.after(() => next.close());
  assert.equal((await next.initialize(false)).consent, 'disabled');
  await next.flush(); assert.deepEqual(h.calls, []);
  assert.equal((await h.read()).profileId, null);
});

test('capture transport treats rejection, non-success, and abort as non-delivery', async () => {
  const payload = { event: 'forger_campaign_first_open', distinct_id: 'random', uuid: 'event', timestamp: 'time', properties: {} };
  for (const fetcher of [async () => ({ ok: false }), async () => { throw new Error('offline'); }]) {
    assert.equal(await createCampaignCaptureTransport('phc_test', fetcher)(payload, new AbortController().signal), false);
  }
  const abort = new AbortController(); abort.abort();
  const transport = createCampaignCaptureTransport('phc_test', async (_url, options) => {
    assert.equal(options.signal.aborted, true); throw new Error('aborted');
  });
  assert.equal(await transport(payload, abort.signal), false);
});

test('malformed, oversized, invalid and duplicate stored events fail closed instead of being transmitted', async (t) => {
  const h = await harness(t);
  await h.manager.initialize(false); await h.manager.setConsent(true, CODE); h.manager.close();
  const valid = await h.read();
  const brokenStates = [
    ' '.repeat(16_385), '{}',
    JSON.stringify({ ...valid, outbox: [{ ...valid.outbox[0], event: 'private_content' }] }),
    JSON.stringify({ ...valid, outbox: [valid.outbox[0], valid.outbox[0]] }),
  ];
  for (const raw of brokenStates) {
    await fs.writeFile(h.options.filePath, raw);
    const next = new CampaignMeasurement(h.options); t.after(() => next.close());
    assert.equal((await next.initialize(false)).newProfile, false);
    await next.flush();
  }
  assert.deepEqual(h.calls, []);
});

test('inaccessible withdrawal evidence fails closed even when renderer reports a new profile', async (t) => {
  const h = await harness(t);
  const stat = fs.stat;
  const mocked = t.mock.method(fs, 'stat', async (file, ...args) => {
    if (file === `${h.options.filePath}.withdrawn`) throw Object.assign(new Error('inaccessible'), { code: 'EACCES' });
    return stat(file, ...args);
  });
  const status = await h.manager.initialize(false);
  mocked.mock.restore();
  assert.equal(status.newProfile, false); assert.equal(status.consent, 'disabled');
});

test('invalid consent types are rejected and unexpected release metadata is never sent verbatim', async (t) => {
  const h = await harness(t, { version: 'local-private-path', platform: 'personal-device-name' });
  await h.manager.initialize(false);
  await assert.rejects(h.manager.setConsent('true', CODE), /invalid_consent/);
  await h.manager.setConsent(true, CODE); await h.manager.flush();
  assert.equal(h.calls[0].properties.version, 'unknown');
  assert.equal(h.calls[0].properties.platform, 'unknown');
});

test('failure to persist opt-in or first creation never sends that pending event', async (t) => {
  for (const firstApp of [false, true]) {
    const h = await harness(t);
    await h.manager.initialize(false);
    if (firstApp) { await h.manager.setConsent(true, CODE); await h.manager.flush(); }
    const mocked = t.mock.method(fs, 'writeFile', async () => { throw new Error('write_failed'); });
    await assert.rejects(firstApp ? h.manager.recordFirstAppCreated() : h.manager.setConsent(true, CODE), /write_failed/);
    await h.manager.flush();
    assert.equal(h.calls.length, firstApp ? 1 : 0);
    assert.equal((await h.manager.getStatus()).consent, 'disabled');
    mocked.mock.restore();
  }
});

test('withdrawal and quit also abort a request whose transport settles only after cancellation', async (t) => {
  for (const quit of [false, true]) {
    let started;
    let finish;
    let signal;
    const entered = new Promise((resolve) => { started = resolve; });
    const h = await harness(t, { send: async (_p, requestSignal) => {
      signal = requestSignal; started(); return await new Promise((resolve) => { finish = resolve; });
    } });
    await h.manager.initialize(false); await h.manager.setConsent(true, CODE);
    const sending = h.manager.flush(); await entered;
    if (quit) h.manager.close(); else await h.manager.setConsent(false);
    assert.equal(signal.aborted, true);
    finish(false); await sending;
  }
});

test('throwing transports are contained and retain the original event for bounded retry', async (t) => {
  const h = await harness(t, { send: async () => { throw new Error('network down'); } });
  await h.manager.initialize(false); await h.manager.setConsent(true, CODE); await h.manager.flush();
  assert.equal((await h.read()).outbox[0].attempts, 1);
});

test('first creation persistence failure plus restart never mislabels a later app as first', async (t) => {
  const h = await harness(t);
  await h.manager.initialize(false); await h.manager.setConsent(true, CODE); await h.manager.flush();
  const write = t.mock.method(fs, 'writeFile', async () => { throw new Error('disk_unavailable'); });
  await assert.rejects(h.manager.recordFirstAppCreated(), /disk_unavailable/);
  write.mock.restore(); h.manager.close();
  const resumed = new CampaignMeasurement(h.options); t.after(() => resumed.close());
  await resumed.initialize(true, true); // Existing app comes from main's registry, never renderer input.
  await resumed.recordFirstAppCreated(); await resumed.flush();
  assert.deepEqual(h.calls.map((entry) => entry.event), ['forger_campaign_first_open']);
});

test('production-default clock timestamps consent without a supplied clock', async (t) => {
  const h = await harness(t, { now: undefined });
  await h.manager.initialize(false); await h.manager.setConsent(true, CODE); await h.manager.flush();
  assert.ok(Math.abs(Date.now() - Date.parse(h.calls[0].timestamp)) < 5_000);
});

test('creation persistence failure aborts an earlier in-flight event as well as clearing its own event', async (t) => {
  let entered;
  let finish;
  let signal;
  const started = new Promise((resolve) => { entered = resolve; });
  const h = await harness(t, { send: async (_p, requestSignal) => {
    signal = requestSignal; entered(); return await new Promise((resolve) => { finish = resolve; });
  } });
  await h.manager.initialize(false); await h.manager.setConsent(true, CODE);
  const sending = h.manager.flush(); await started;
  const write = t.mock.method(fs, 'writeFile', async () => { throw new Error('write_failed'); });
  await assert.rejects(h.manager.recordFirstAppCreated(), /write_failed/);
  assert.equal(signal.aborted, true);
  write.mock.restore(); finish(false); await sending;
  assert.equal((await h.read()).profileId, null);
  assert.deepEqual((await h.read()).outbox, []);
});
