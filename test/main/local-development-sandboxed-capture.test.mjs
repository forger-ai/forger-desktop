import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createNetworkSandboxedCapture, extractGatewayPort } from '../../scripts/local-development/sandboxed-capture.mjs';

const args = ['--config', 'model_provider="forger_local"', '--config', 'model_providers.forger_local.base_url="http://127.0.0.1:43210/v1"', 'exec', '--ignore-user-config'];

test('evaluation wrapper derives one canonical numeric loopback gateway only', () => {
  assert.equal(extractGatewayPort(args), 43210);
  for (const invalid of [
    [], [...args, '--config', 'model_providers.forger_local.base_url="http://127.0.0.1:1234/v1"'],
    ['--config', 'model_providers.forger_local.base_url="https://127.0.0.1:1234/v1"'],
    ['--config', 'model_providers.forger_local.base_url="http://localhost:1234/v1"'],
    ['--config', 'model_providers.forger_local.base_url="http://127.0.0.1:99999/v1"'],
  ]) assert.throws(() => extractGatewayPort(invalid), /gateway/);
});

test('non-macOS evaluation fails closed without spawning', async () => {
  const capture = createNetworkSandboxedCapture({ platform: 'linux', capture: () => assert.fail('must not run') });
  await assert.rejects(capture('/synthetic/codex', args, { cwd: '/tmp' }), /requires_macos/);
});

test('wrapper passes existing capture callbacks and cleans its policy after successful execution', async () => {
  let policyPath;
  let observed;
  const options = { cwd: '/tmp', timeoutMs: 1000, env: { FORGER_LOCAL_GATEWAY_TOKEN: 'synthetic-secret' }, onStdout: () => {} };
  const capture = createNetworkSandboxedCapture({
    platform: 'darwin',
    onProfile: (value) => { observed = value; },
    capture: async (command, wrapped, forwarded) => {
      assert.equal(command, '/usr/bin/sandbox-exec');
      assert.equal(wrapped[0], '-f');
      policyPath = wrapped[1];
      assert.deepEqual(wrapped.slice(2), ['/synthetic/codex', ...args]);
      assert.equal(forwarded, options);
      const policy = await fs.readFile(policyPath, 'utf8');
      assert.ok(policy.includes('localhost:43210'));
      assert.ok(!policy.includes('synthetic-secret'));
      return { code: 0, stdout: 'done', stderr: '' };
    },
  });
  assert.equal((await capture('/synthetic/codex', args, options)).stdout, 'done');
  assert.equal(observed.allowedGatewayPort, 43210);
  assert.equal(observed.status, 'configured_not_verified');
  assert.match(observed.profileSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.access(policyPath));
});

test('capture errors are preserved and temporary policy is removed', async () => {
  let policyPath;
  const capture = createNetworkSandboxedCapture({
    platform: 'darwin', capture: async (_command, wrapped) => { policyPath = wrapped[1]; throw new Error('synthetic-runtime-failure'); },
  });
  await assert.rejects(capture('/synthetic/codex', args, { cwd: '/tmp' }), /synthetic-runtime-failure/);
  await assert.rejects(fs.access(policyPath));
});
