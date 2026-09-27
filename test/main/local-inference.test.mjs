import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLlmProviderRunService } = require('../../dist-electron/main/llm-provider/run-service.js');
const digest = 'a'.repeat(64);
const completed = '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n';

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (handler?.(req, res)) return;
    if (req.url === '/api/version') {
      res.end(JSON.stringify({ version: '0.34.4' }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/tags'
      ? { models: [{ name: 'test:small', digest }] }
      : { capabilities: ['completion', 'tools'] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-local-spec-'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(workingDir, { recursive: true, force: true });
  });
  let captures = 0;
  const input = {
    surface: 'app_prompt_task',
    mode: 'task',
    runtime: { provider: 'codex', model: 'test:small', effort: 'low' },
    localInference: {
      runtime: 'ollama',
      endpoint: `http://127.0.0.1:${server.address().port}`,
      model: 'test:small',
      modelDigest: digest,
      contextWindow: 4096,
    },
    workingDir,
    pathEntries: [],
    environment: {},
    prompt: 'Fix fixture',
    timeoutMs: 1000,
    cliPath: '/fake/codex',
    runCommandCapture: async (_command, _args, options) => {
      captures++;
      options.onStdout?.(completed);
      return { code: 0, stdout: completed, stderr: '' };
    },
  };
  const service = createLlmProviderRunService({
    enableExperimentalLocalInference: true,
    getCodexAuthenticated: async () => { throw Error('AUTH MUST NOT BE READ'); },
    resolveAuthProfile: async () => { throw Error('PROFILE MUST NOT BE READ'); },
  });
  return { input, service, requests, captures: () => captures };
}

test('local branch is disabled by default and never touches cloud authentication', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createLlmProviderRunService().run(f.input), /local_inference_disabled/);
  assert.equal(f.captures(), 0);
});

test('local task streams, bypasses auth and fixes provider configuration', async (t) => {
  const f = await fixture(t);
  const outputs = [];
  let home;
  const original = f.input.runCommandCapture;
  f.input.runCommandCapture = async (command, args, options) => {
    home = options.env.HOME;
    assert.notEqual(home, os.homedir());
    assert.equal(options.env.CODEX_HOME, path.join(home, '.codex'));
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.ok(args.indexOf('--ignore-user-config') > args.indexOf('exec'), 'ignore-user-config belongs to the exec subcommand');
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('model_provider="forger_local"'));
    assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
    assert.equal(options.stdinText, 'Fix fixture');
    return original(command, args, options);
  };
  f.input.onOutput = (stream, text) => outputs.push([stream, text]);
  const out = await f.service.run(f.input);
  assert.equal(out.assistantText, 'Done');
  assert.equal(f.captures(), 1);
  assert.equal(outputs.length, 1);
  assert.deepEqual(f.requests, ['/api/tags', '/api/show', '/api/version']);
  assert.deepEqual(out.localInference, {
    runtime: 'ollama', runtimeVersion: '0.34.4', model: 'test:small', modelDigest: digest,
    reportedCapabilities: ['completion', 'tools'], validatedCapabilities: [],
    requestedAgentContextWindow: 4096, effectiveRuntimeContext: null,
    effectiveRuntimeContextReason: 'Agent context budget does not establish effective Ollama num_ctx.',
    observedToolContracts: [],
    agentProfile: 'baseline-v1', requestedReasoning: null, appliedSettings: {}, contractSha256: null,
  });
  await assert.rejects(fs.access(home));
});

for (const agentProfile of [undefined, 'baseline-v1', 'single-agent-v1', 'single-agent-no-thinking-v1', 'compact-v1']) {
  test(`explicit profile settings and contract evidence: ${agentProfile ?? 'default'}`, async (t) => {
    const f = await fixture(t);
    f.input.localInference.agentProfile = agentProfile;
    const single = agentProfile !== undefined && agentProfile !== 'baseline-v1';
    const noThinking = ['single-agent-no-thinking-v1', 'compact-v1'].includes(agentProfile);
    let contractPath;
    let contractHash = null;
    f.input.runCommandCapture = async (_command, args, options) => {
      assert.equal(args.includes('features.multi_agent=false'), single);
      assert.equal(args.includes('model_reasoning_effort="none"'), noThinking);
      assert.equal(args.includes('model_supports_reasoning_summaries=true'), noThinking);
      assert.equal(args.includes('model_reasoning_summary="none"'), noThinking);
      assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
      assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.stdinText, f.input.prompt);
      const setting = args.find((arg) => arg.startsWith('model_instructions_file='));
      assert.equal(Boolean(setting), agentProfile === 'compact-v1');
      if (setting) {
        contractPath = JSON.parse(setting.slice(setting.indexOf('=') + 1));
        assert.equal(path.dirname(contractPath), options.env.HOME);
        const contract = await fs.readFile(contractPath);
        assert.ok(contract.length > 0 && contract.length < 6000);
        assert.equal((await fs.stat(contractPath)).mode & 0o777, 0o600);
        contractHash = createHash('sha256').update(contract).digest('hex');
        assert.ok(args.includes('include_permissions_instructions=true'));
      }
      return { code: 0, stdout: completed, stderr: '' };
    };
    const out = await f.service.run(f.input);
    assert.equal(out.localInference.agentProfile, agentProfile ?? 'baseline-v1');
    assert.equal(out.localInference.requestedReasoning, noThinking ? 'none' : null);
    assert.equal(out.localInference.contractSha256, contractHash);
    const expected = single ? { 'features.multi_agent': false } : {};
    if (noThinking) Object.assign(expected, {
      model_reasoning_effort: 'none', model_supports_reasoning_summaries: true, model_reasoning_summary: 'none',
    });
    if (contractPath) expected.include_permissions_instructions = true;
    assert.deepEqual(out.localInference.appliedSettings, expected);
    if (contractPath) {
      await assert.rejects(fs.access(contractPath));
      assert.ok(!JSON.stringify(out.localInference).includes(contractPath));
    }
  });
}

for (const cancelled of [false, true]) {
  test(`observed local metadata survives ${cancelled ? 'cancel' : 'timeout'} normalization`, async (t) => {
    const f = await fixture(t);
    f.input.localInference.agentProfile = 'single-agent-v1';
    f.input.timeoutMs = cancelled ? 1000 : 250;
    const controller = new AbortController();
    f.input.signal = controller.signal;
    f.input.runCommandCapture = async () => {
      if (cancelled) controller.abort();
      return await new Promise(() => {});
    };
    await assert.rejects(f.service.run(f.input), (error) => {
      assert.equal(error.message, cancelled ? 'local_cancelled' : 'local_timeout');
      assert.equal(error.localInference.runtimeVersion, '0.34.4');
      assert.equal(error.localInference.agentProfile, 'single-agent-v1');
      assert.deepEqual(error.localInference.observedToolContracts, []);
      return true;
    });
  });
}

test('post-preflight CLI setup failure preserves only established runtime evidence', async (t) => {
  const f = await fixture(t);
  f.input.pathEntries = null;
  await assert.rejects(f.service.run(f.input), (error) => {
    assert.equal(error.localInference.runtimeVersion, '0.34.4');
    assert.equal(error.localInference.modelDigest, digest);
    assert.equal(error.localInference.agentProfile, undefined, 'profile settings were not prepared');
    return true;
  });
  assert.equal(f.captures(), 0);
});

for (const unsupported of [false, true]) {
  test(`local service preserves observed tool inventory on ${unsupported ? 'failure' : 'success'}`, async (t) => {
    const f = await fixture(t, (req, res) => {
      if (req.url !== '/v1/responses') return false;
      res.end('{}');
      return true;
    });
    let failureEvent;
    f.input.onEvent = (event) => { if (event.type === 'failed') failureEvent = event; };
    f.input.runCommandCapture = async (_command, args, options) => {
      const setting = args.find((arg) => arg.startsWith('model_providers.forger_local.base_url='));
      const baseUrl = JSON.parse(setting.slice(setting.indexOf('=') + 1));
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.env.FORGER_LOCAL_GATEWAY_TOKEN}` },
        body: JSON.stringify({
          model: 'test:small', input: 'PRIVATE PROMPT',
          tools: [{ type: 'namespace', name: 'functions', tools: [{
            type: unsupported ? 'custom' : 'function', name: 'exec_command',
          }] }],
        }),
      });
      assert.equal(response.status, unsupported ? 400 : 200);
      return { code: unsupported ? 1 : 0, stdout: completed, stderr: '' };
    };
    let evidence;
    if (unsupported) {
      await assert.rejects(f.service.run(f.input), (error) => {
        evidence = error.localInference;
        return error.message === 'local_cli_failed';
      });
      assert.equal(failureEvent.error.localInference, evidence);
      assert.ok(!f.requests.includes('/v1/responses'));
    } else {
      evidence = (await f.service.run(f.input)).localInference;
      assert.ok(f.requests.includes('/v1/responses'));
    }
    assert.deepEqual(evidence.observedToolContracts, [
      { type: 'namespace', name: 'functions', namespace: '' },
      { type: unsupported ? 'custom' : 'function', name: 'exec_command', namespace: 'functions' },
    ]);
    assert.deepEqual(evidence.validatedCapabilities, []);
  });
}

for (const endpoint of [
  'https://127.0.0.1:11434',
  'http://localhost:11434',
  'http://2130706433:11434',
  'http://127.0.0.1@evil.test',
  'http://127.0.0.1:11434/path',
  'http://127.0.0.1:11434/?x=1',
]) {
  test(`reject endpoint ${endpoint}`, async (t) => {
    const f = await fixture(t);
    f.input.localInference.endpoint = endpoint;
    await assert.rejects(f.service.run(f.input), /local_endpoint_invalid/);
    assert.equal(f.captures(), 0);
  });
}

for (const [name, handler, error] of [
  ['model missing', (_req, res) => {
    res.end(JSON.stringify({ models: [] }));
    return true;
  }, 'local_model_missing'],
  ['digest changed', (_req, res) => {
    res.end(JSON.stringify({ models: [{ name: 'test:small', digest: 'b'.repeat(64) }] }));
    return true;
  }, 'local_model_digest_mismatch'],
  ['cloud backing', (req, res) => {
    if (req.url !== '/api/show') return false;
    res.end(JSON.stringify({ remote_model: 'remote', capabilities: ['completion', 'tools'] }));
    return true;
  }, 'local_model_remote'],
  ['missing tools', (req, res) => {
    if (req.url !== '/api/show') return false;
    res.end(JSON.stringify({ capabilities: ['completion'] }));
    return true;
  }, 'local_capabilities_missing'],
  ['redirect', (_req, res) => {
    res.writeHead(302, { location: 'http://example.com' });
    res.end();
    return true;
  }, 'local_runtime_http'],
  ['invalid json', (_req, res) => {
    res.end('oops');
    return true;
  }, 'local_runtime_invalid_response'],
  ['unverifiable runtime version', (req, res) => {
    if (req.url !== '/api/version') return false;
    res.end(JSON.stringify({ version: 'latest' }));
    return true;
  }, 'local_runtime_invalid_response'],
]) {
  test(name, async (t) => {
    const f = await fixture(t, handler);
    await assert.rejects(f.service.run(f.input), new RegExp(error));
    assert.equal(f.captures(), 0);
  });
}

for (const change of [
  { runtime: { provider: 'claude', model: 'test:small' } },
  { mode: 'chat' },
  { surface: 'desktop_chat' },
  { networkAccess: true },
  { runtime: { provider: 'codex', model: 'other' } },
  { runtime: { provider: 'codex', model: 'test:small', authProfileId: 'secret' } },
  { addDirs: ['/tmp'] },
  { mcpServers: [{ name: 'x' }] },
  { environment: { OPENAI_API_KEY: 'secret' } },
]) {
  test(`reject unsupported scope ${JSON.stringify(change)}`, async (t) => {
    const f = await fixture(t);
    Object.assign(f.input, change);
    await assert.rejects(f.service.run(f.input), /local_/);
    assert.equal(f.captures(), 0);
  });
}

test('project config cannot redirect local task', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.input.workingDir, '.codex'));
  await fs.writeFile(path.join(f.input.workingDir, '.codex', 'config.toml'), 'model_provider="openai"');
  await assert.rejects(f.service.run(f.input), /local_project_config_unsupported/);
  assert.equal(f.captures(), 0);
});

test('absolute timeout and cancellation do not retry or fallback', async (t) => {
  const f = await fixture(t);
  f.input.timeoutMs = 30;
  f.input.runCommandCapture = () => new Promise(() => {});
  await assert.rejects(f.service.run(f.input), /local_timeout/);
  const controller = new AbortController();
  f.input.signal = controller.signal;
  f.input.timeoutMs = 500;
  const running = f.service.run(f.input);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, /local_cancelled/);
});

test('failed local CLI returns error without cloud fallback', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.input.runCommandCapture = async () => {
    calls++;
    return { code: 1, stdout: '', stderr: 'unsupported model' };
  };
  await assert.rejects(f.service.run(f.input), /local_cli_failed/);
  assert.equal(calls, 1);
});

test('stalled preflight is included in total budget and cancellation', async (t) => {
  const f = await fixture(t, () => true);
  f.input.timeoutMs = 50;
  await assert.rejects(f.service.run(f.input), (error) => {
    assert.equal(error.message, 'local_timeout');
    assert.equal(error.localInference, undefined, 'preflight did not establish runtime metadata');
    return true;
  });
  assert.equal(f.captures(), 0);
  const controller = new AbortController();
  f.input.signal = controller.signal;
  f.input.timeoutMs = 1000;
  const pending = f.service.run(f.input);
  controller.abort();
  await assert.rejects(pending, /local_cancelled/);
});

test('digest prefix representation preserves exact digest identity', async (t) => {
  const f = await fixture(t);
  f.input.localInference.modelDigest = `sha256:${digest}`;
  assert.equal((await f.service.run(f.input)).assistantText, 'Done');
});
