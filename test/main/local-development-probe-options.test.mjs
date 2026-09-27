import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProbeOptions } from '../../scripts/local-development/probe-codex-options.mjs';

test('protocol smoke explicitly enables outer network sandbox while preserving the default smoke', () => {
  assert.deepEqual(parseProbeOptions(['/synthetic/codex']), {
    cliPath: '/synthetic/codex', networkSandbox: false, redirectCheck: false, redirectStatus: 307, agentProfile: 'baseline-v1',
  });
  assert.deepEqual(parseProbeOptions(['/synthetic/codex', '--network-sandbox']), {
    cliPath: '/synthetic/codex', networkSandbox: true, redirectCheck: false, redirectStatus: 307, agentProfile: 'baseline-v1',
  });
});

test('each explicit agent profile composes with existing probe flags', () => {
  for (const agentProfile of ['baseline-v1', 'single-agent-v1', 'single-agent-no-thinking-v1', 'compact-v1']) {
    for (const profileArgs of [['--agent-profile', agentProfile], [`--agent-profile=${agentProfile}`]]) {
      const options = parseProbeOptions(['/synthetic/codex', '--redirect-check', ...profileArgs, '--network-sandbox']);
      assert.equal(options.agentProfile, agentProfile);
      assert.equal(options.redirectCheck, true);
      assert.equal(options.networkSandbox, true);
    }
  }
});

test('network sandbox and redirect scenarios compose in either flag order', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const flags of [['--network-sandbox', `--redirect-check=${status}`], [`--redirect-check=${status}`, '--network-sandbox']]) {
      const options = parseProbeOptions(['/synthetic/codex', ...flags]);
      assert.equal(options.networkSandbox, true);
      assert.equal(options.redirectCheck, true);
      assert.equal(options.redirectStatus, status);
    }
  }
  assert.equal(parseProbeOptions(['/synthetic/codex', '--redirect-check']).redirectStatus, 307);
});

test('invalid or duplicate flags fail before launching CLI or servers', () => {
  for (const args of [[], ['relative'], ['/synthetic/codex', '--unknown'], ['/synthetic/codex', '--network-sandbox', '--network-sandbox'], ['/synthetic/codex', '--redirect-check', '--redirect-check=307'], ['/synthetic/codex', '--redirect-check=200'], ['/synthetic/codex', '--agent-profile'], ['/synthetic/codex', '--agent-profile='], ['/synthetic/codex', '--agent-profile', 'automatic'], ['/synthetic/codex', '--agent-profile', '--network-sandbox'], ['/synthetic/codex', '--agent-profile', 'baseline-v1', '--agent-profile=compact-v1']]) {
    assert.throws(() => parseProbeOptions(args), /Usage:/);
  }
});
