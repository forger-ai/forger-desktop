import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateLocalConfig } = require('../../dist-electron/main/llm-provider/local/preflight.js');
const { createLlmProviderRunService } = require('../../dist-electron/main/llm-provider/run-service.js');
const valid = {
  runtime: 'ollama', endpoint: 'http://127.0.0.1:11434',
  model: 'synthetic:small', modelDigest: 'a'.repeat(64), contextWindow: 4096,
};

test('canonical loopback endpoint is accepted without network or model loading', () => {
  assert.equal(validateLocalConfig(valid), 'http://127.0.0.1:11434');
});

for (const endpoint of [
  'https://127.0.0.1:11434', 'http://localhost:11434', 'http://2130706433:11434',
  'http://127.0.0.1@evil.test', 'http://127.0.0.1:11434/path',
  'http://127.0.0.1:11434/?x=1', 'http://127.0.0.1:99999',
  'http://127.0.0.1:11434#fragment', 'http://127.0.0.1.evil.test:11434',
]) {
  test(`endpoint policy rejects ${endpoint} before any request`, () => {
    assert.throws(() => validateLocalConfig({ ...valid, endpoint }), /local_endpoint_invalid/);
  });
}

for (const change of [
  { runtime: 'remote' }, { model: 'candidate:cloud' }, { model: 'x\nmodel_provider=openai' },
  { modelDigest: 'abc' }, { contextWindow: 0 }, { contextWindow: 3.5 }, { contextWindow: 100000 },
  { agentProfile: 'latest' }, { agentProfile: null }, { agentProfile: '' },
  { agentProfile: { name: 'baseline-v1' } },
]) {
  test(`configuration policy rejects ${JSON.stringify(change)}`, () => {
    assert.throws(() => validateLocalConfig({ ...valid, ...change }), /local_configuration_invalid/);
  });
}

test('disabled local branch fails before auth, CLI discovery, or command execution', async () => {
  let sideEffects = 0;
  const unexpected = async () => { sideEffects++; throw new Error('unexpected side effect'); };
  const service = createLlmProviderRunService({
    getCodexAuthenticated: unexpected, getCodexCliPath: unexpected, resolveAuthProfile: unexpected,
  });
  await assert.rejects(service.run({
    localInference: valid, runtime: { provider: 'codex', model: valid.model },
    runCommandCapture: unexpected,
  }), /local_inference_disabled/);
  assert.equal(sideEffects, 0);
});


test('an explicit invalid local configuration cannot fall through to cloud authentication', async () => {
  let authReads = 0;
  const service = createLlmProviderRunService({
    enableExperimentalLocalInference: true,
    getCodexAuthenticated: async () => { authReads++; return true; },
  });
  await assert.rejects(service.run({
    localInference: null,
    runtime: { provider: 'codex', model: valid.model },
    surface: 'app_prompt_task', mode: 'task', environment: {},
  }), /local_model_mismatch/);
  assert.equal(authReads, 0);
});
