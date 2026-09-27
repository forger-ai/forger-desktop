import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { createLlmProviderRunService } = require('../../dist-electron/main/llm-provider/run-service.js');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const intent = { goal: 'Trim note titles', constraints: ['Keep existing behavior'], searchTerms: ['title', 'trim'] };
const completed = '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n';

async function fixture(t, respond) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-context-spec-'));
  await fs.mkdir(path.join(work, 'src'));
  await fs.writeFile(path.join(work, 'src', 'notes.py'), 'def title(value):\n    return value\n');
  const calls = [];
  const captures = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/chat') {
      const stage = calls.filter((entry) => entry.url === '/api/chat').length;
      if (respond && await respond({ req, res, body, stage, work })) return;
      res.end(JSON.stringify({
        model: 'test:small', done: true,
        message: { role: 'assistant', content: JSON.stringify(stage === 1 ? intent : { fileIds: ['f1'] }) },
        prompt_eval_count: 33, eval_count: 12, load_duration: 10, prompt_eval_duration: 20, eval_duration: 30,
      }));
      return;
    }
    res.end(JSON.stringify(req.url === '/api/tags'
      ? { models: [{ name: 'test:small', digest: 'a'.repeat(64) }] }
      : req.url === '/api/version' ? { version: '0.34.4' } : { capabilities: ['completion', 'tools'] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(work, { recursive: true, force: true });
  });
  const input = {
    surface: 'app_prompt_task', mode: 'task', runtime: { provider: 'codex', model: 'test:small', effort: 'none' },
    localInference: { runtime: 'ollama', endpoint: `http://127.0.0.1:${server.address().port}`, model: 'test:small',
      modelDigest: 'a'.repeat(64), contextWindow: 4096, contextStrategy: 'staged-v1' },
    workingDir: work, pathEntries: [], environment: {}, cliPath: '/fake/codex',
    prompt: 'Trim note titles. Preserve all previous behavior.\nUNICODE: español', timeoutMs: 2000,
    runCommandCapture: async (_command, _args, options) => {
      captures.push(options);
      return { code: 0, stdout: completed, stderr: '' };
    },
  };
  const service = createLlmProviderRunService({ enableExperimentalLocalInference: true,
    getCodexAuthenticated: async () => { throw new Error('Cloud auth must never be read'); } });
  return { input, service, calls, captures, work };
}

for (const strategy of [undefined, 'direct-v1']) {
  test(`direct context (${strategy ?? 'default'}) preserves the prompt and performs no preparation requests`, async (t) => {
    const f = await fixture(t);
    f.input.localInference.contextStrategy = strategy;
    const result = await f.service.run(f.input);
    assert.equal(f.captures[0].stdinText, f.input.prompt);
    assert.equal(result.localInference.contextPreparation, undefined);
    assert.deepEqual(f.calls.map((c) => c.url), ['/api/tags', '/api/show', '/api/version']);
  });
}

test('staged context uses the same pinned model, keeps the complete request and records bounded evidence', async (t) => {
  const f = await fixture(t);
  const result = await f.service.run(f.input);
  const chat = f.calls.filter((c) => c.url === '/api/chat');
  assert.equal(chat.length, 2);
  for (const { body } of chat) {
    assert.equal(body.model, 'test:small');
    assert.equal(body.stream, false);
    assert.equal(body.think, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.options.num_ctx, 4096);
    assert.equal(body.options.num_predict, 256);
    assert.deepEqual({ temperature: body.options.temperature, top_p: body.options.top_p, top_k: body.options.top_k, seed: body.options.seed },
      { temperature: 0.7, top_p: 0.8, top_k: 20, seed: 42 });
    assert.equal(body.format.type, 'object');
  }
  assert.ok(chat[0].body.messages[1].content.includes(JSON.stringify(f.input.prompt)));
  assert.ok(chat[1].body.messages[1].content.includes('src/notes.py'));
  assert.ok(!chat[1].body.messages[1].content.includes('def title'));
  const prompt = f.captures[0].stdinText;
  assert.ok(prompt.startsWith(f.input.prompt));
  assert.ok(prompt.includes('def title'));
  assert.match(prompt, /untrusted/i);
  const evidence = result.localInference.contextPreparation;
  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.originalPromptSha256, sha(f.input.prompt));
  assert.equal(evidence.effectivePromptSha256, sha(prompt));
  assert.equal(evidence.effectivePromptBytes, Buffer.byteLength(prompt));
  assert.deepEqual(evidence.selectedPaths, ['src/notes.py']);
  assert.equal(evidence.excerpts[0].sha256.length, 64);
  assert.equal(evidence.stages.length, 2);
  for (const stage of evidence.stages) {
    assert.equal(stage.status, 'completed');
    assert.equal(stage.inputTokens, null);
    assert.equal(stage.promptTokens, 33);
    assert.equal(stage.outputTokens, 12);
    assert.equal(stage.loadDurationNs, 10);
    assert.ok(stage.durationMs >= 0);
  }
  assert.ok(!JSON.stringify(evidence).includes('def title'), 'evidence never logs source text');
});

for (const [name, content, message] of [
  ['malformed JSON', 'not json', 'local_context_invalid_response'],
  ['wrong intent schema', JSON.stringify({ goal: 'x', constraints: 'x', searchTerms: [] }), 'local_context_invalid_intent'],
  ['extra intent instruction', JSON.stringify({ ...intent, command: 'rm -rf /' }), 'local_context_invalid_intent'],
]) {
  test(`${name} fails explicitly with metadata before the CLI`, async (t) => {
    const f = await fixture(t, ({ res }) => {
      res.end(JSON.stringify({ done: true, message: { content } }));
      return true;
    });
    await assert.rejects(f.service.run(f.input), (error) => {
      assert.equal(error.message, message);
      assert.equal(error.localInference.contextPreparation.status, 'failed');
      assert.equal(error.localInference.contextPreparation.stages[0].status, 'failed');
      assert.ok(error.localInference.contextPreparation.durationMs >= 0);
      assert.equal(error.localInference.contextPreparation.effectivePromptSha256, null);
      return true;
    });
    assert.equal(f.captures.length, 0);
    assert.equal(f.calls.filter((c) => c.url === '/api/chat').length, 1);
  });
}

for (const selected of [['../../outside.py'], ['f999'], ['f1', 'f1'], ['f1', 'f2', 'f3', 'f4']]) {
  test(`selection must use at most three distinct existing IDs: ${JSON.stringify(selected)}`, async (t) => {
    const f = await fixture(t, ({ res, stage }) => {
      if (stage === 1) return false;
      res.end(JSON.stringify({ done: true, message: { content: JSON.stringify({ fileIds: selected }) } }));
      return true;
    });
    await assert.rejects(f.service.run(f.input), /local_context_invalid_selection/);
    assert.equal(f.captures.length, 0);
  });
}

for (const [name, reply, error] of [
  ['redirect', (res) => { res.writeHead(307, { location: 'http://example.com' }); res.end(); }, 'local_context_http'],
  ['http error', (res) => { res.writeHead(500); res.end(); }, 'local_context_http'],
  ['unfinished response', (res) => res.end(JSON.stringify({ done: false, message: { content: JSON.stringify(intent) } })), 'local_context_invalid_response'],
  ['oversize response', (res) => res.end('x'.repeat(128 * 1024 + 1)), 'local_context_response_too_large'],
]) {
  test(`${name} does not retry or invoke the CLI`, async (t) => {
    const f = await fixture(t, ({ res }) => { reply(res); return true; });
    await assert.rejects(f.service.run(f.input), new RegExp(error));
    assert.equal(f.calls.filter((c) => c.url === '/api/chat').length, 1);
    assert.equal(f.captures.length, 0);
  });
}

for (const cancelled of [false, true]) {
  test(`staged ${cancelled ? 'cancellation' : 'global timeout'} preserves failed-stage evidence`, async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, () => {
      if (cancelled) controller.abort();
      return true;
    });
    f.input.signal = controller.signal;
    f.input.timeoutMs = cancelled ? 2000 : 100;
    await assert.rejects(f.service.run(f.input), (error) => {
      assert.equal(error.message, cancelled ? 'local_cancelled' : 'local_timeout');
      assert.equal(error.localInference.contextPreparation.status, 'failed');
      assert.equal(error.localInference.contextPreparation.stages[0].status, 'failed');
      return true;
    });
    assert.equal(f.captures.length, 0);
  });
}

test('inventory omits symlinks, secrets, tests, dependencies, hidden files and non-code', async (t) => {
  const f = await fixture(t);
  for (const name of ['tests', 'node_modules', 'evaluator', '.git', 'secrets']) {
    await fs.mkdir(path.join(f.work, name));
    await fs.writeFile(path.join(f.work, name, 'leak.py'), 'PRIVATE CONTENT');
  }
  await fs.writeFile(path.join(f.work, '.env.py'), 'SECRET');
  await fs.writeFile(path.join(f.work, 'credentials.ts'), 'SECRET');
  await fs.writeFile(path.join(f.work, 'AGENTS.md'), 'PRIVATE');
  await fs.symlink(path.join(f.work, 'src'), path.join(f.work, 'linked'));
  await fs.symlink(path.join(f.work, 'src', 'notes.py'), path.join(f.work, 'linked.py'));
  const result = await f.service.run(f.input);
  assert.deepEqual(result.localInference.contextPreparation.inventory.paths, ['src/notes.py']);
  assert.ok(!JSON.stringify(f.calls).includes('PRIVATE'));
});

test('replaced selected file is rejected instead of following a symlink', async (t) => {
  const f = await fixture(t, async ({ stage, work }) => {
    if (stage === 1) return false;
    await fs.rename(path.join(work, 'src', 'notes.py'), path.join(work, 'other.py'));
    await fs.symlink(path.join(work, 'other.py'), path.join(work, 'src', 'notes.py'));
    return false;
  });
  await assert.rejects(f.service.run(f.input), /local_context_file_changed/);
  assert.equal(f.captures.length, 0);
});

test('excerpts have explicit byte and line caps and secret content is rejected', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.work, 'src', 'notes.py'), Array.from({ length: 500 }, (_, i) => `# title ${i} ${'á'.repeat(100)}`).join('\n'));
  const result = await f.service.run(f.input);
  const evidence = result.localInference.contextPreparation;
  assert.ok(evidence.excerpts.reduce((total, e) => total + e.bytes, 0) <= 8192);
  assert.ok(evidence.excerpts.every((e) => e.lines <= 120 && e.truncated));
  await fs.writeFile(path.join(f.work, 'src', 'notes.py'), 'API_KEY = "sensitive_value"\n');
  f.calls.length = 0;
  await assert.rejects(f.service.run(f.input), /local_context_sensitive_content/);
  assert.equal(f.captures.length, 1);
});

test('unknown strategy fails before runtime or CLI access', async (t) => {
  const f = await fixture(t);
  f.input.localInference.contextStrategy = 'invented';
  await assert.rejects(f.service.run(f.input), /local_context_strategy_invalid/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.captures.length, 0);
});

test('stage deadline is 30 seconds even when the overall budget is longer', async (t) => {
  const f = await fixture(t, () => { t.mock.timers.tick(30001); return true; });
  f.input.timeoutMs = 90000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(f.service.run(f.input), (error) => {
    assert.equal(error.message, 'local_context_timeout');
    assert.equal(error.localInference.contextPreparation.stages[0].error, 'local_context_timeout');
    return true;
  });
  assert.equal(f.captures.length, 0);
});

test('runtime model identity mismatch and missing completion cannot reach the CLI', async (t) => {
  const f = await fixture(t, ({ res }) => {
    res.end(JSON.stringify({ model: 'different:model', done: true, message: { content: JSON.stringify(intent) } }));
    return true;
  });
  await assert.rejects(f.service.run(f.input), /local_context_invalid_response/);
  assert.equal(f.captures.length, 0);
});

test('oversize original requests fail explicitly, without truncating the request or calling the CLI', async (t) => {
  const f = await fixture(t);
  f.input.prompt = 'x'.repeat(128 * 1024);
  await assert.rejects(f.service.run(f.input), (error) => {
    assert.equal(error.message, 'local_context_request_too_large');
    assert.equal(error.localInference.contextPreparation.originalPromptSha256, sha(f.input.prompt));
    assert.equal(error.localInference.contextPreparation.stages[0].inputTokens, null);
    return true;
  });
  assert.equal(f.calls.filter((c) => c.url === '/api/chat').length, 0);
  assert.equal(f.captures.length, 0);
});

test('an empty inventory and empty selection remain valid, without guessed context', async (t) => {
  const f = await fixture(t, ({ stage, res }) => {
    if (stage === 1) return false;
    res.end(JSON.stringify({ done: true, done_reason: 'length', message: { content: '{"fileIds":[]}', tool_calls: [] } }));
    return true;
  });
  await fs.rm(path.join(f.work, 'src', 'notes.py'));
  const result = await f.service.run(f.input);
  assert.deepEqual(result.localInference.contextPreparation.selectedPaths, []);
  assert.deepEqual(result.localInference.contextPreparation.excerpts, []);
  assert.equal(result.localInference.contextPreparation.stages[1].doneReason, 'length');
  assert.equal(result.localInference.contextPreparation.stages[1].promptTokens, null);
});

test('inventory caps discovery to eighty code paths and six KiB of serialized paths', async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(f.work, 'src', `item_${i}.py`), '# source')));
  const result = await f.service.run(f.input);
  const { inventory } = result.localInference.contextPreparation;
  assert.equal(inventory.paths.length, 80);
  assert.ok(inventory.bytes <= 6144);
  assert.equal(inventory.truncated, true);
});

for (const replacementTiming of ['before-validation', 'during-open']) {
  test(`a selected file replaced by a FIFO ${replacementTiming} fails without blocking cancellation`, { skip: process.platform === 'win32' }, async (t) => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-context-fifo-'));
    await fs.writeFile(path.join(workingDir, 'source.py'), '# code');
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    // A separate process and external deadline keep the regression test safe even if open() blocks a worker thread.
    const probe = `
      const fs = require('node:fs/promises');
      const { execFileSync } = require('node:child_process');
      const path = require('node:path');
      const { inventoryContextFiles, readContextExcerpt } = require(process.argv[1]);
      (async () => {
        const inventory = await inventoryContextFiles(process.argv[2]);
        const target = path.join(inventory.root, 'source.py');
        const replace = async () => { await fs.unlink(target); execFileSync('mkfifo', [target]); };
        if (process.argv[3] === 'before-validation') await replace();
        else {
          const originalOpen = fs.open;
          fs.open = async (...args) => { await replace(); return originalOpen(...args); };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 100);
        try {
          await readContextExcerpt(inventory.root, inventory.files[0], [], 8192, controller.signal);
          throw new Error('unexpected-success');
        } catch (error) {
          if (error.message !== 'local_context_file_changed') throw error;
          process.stdout.write(error.message);
        } finally { clearTimeout(timer); }
      })().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
    `;
    const result = await promisify(execFile)(process.execPath, ['-e', probe,
      require.resolve('../../dist-electron/main/llm-provider/local/context-files.js'), workingDir, replacementTiming],
    { timeout: 2000, killSignal: 'SIGKILL' });
    assert.equal(result.stdout, 'local_context_file_changed');
  });
}

test('staged-request-v2 prepares the literal functional request without benchmark boilerplate', async (t) => {
  const f = await fixture(t);
  const request = '  Recorta títulos de notas.\nConserva acentos: á, é y ñ.  ';
  const boilerplate = 'BENCHMARK_BOILERPLATE: evaluación sintética, preserve tests, no Internet.';
  f.input.prompt = `${boilerplate}\n\n${request}\n\nFINAL_SAFETY_POLICY`;
  f.input.localInference.contextStrategy = 'staged-request-v2';
  f.input.localContextRequest = request;
  const result = await f.service.run(f.input);
  const chats = f.calls.filter((call) => call.url === '/api/chat');
  assert.equal(chats.length, 2);
  for (const chat of chats) {
    const data = JSON.parse(chat.body.messages[1].content);
    assert.equal(data.originalRequest, request);
    assert.ok(!JSON.stringify(chat.body).includes('BENCHMARK_BOILERPLATE'));
    assert.ok(!JSON.stringify(chat.body).includes('FINAL_SAFETY_POLICY'));
    assert.equal(chat.body.options.num_predict, 256);
    assert.equal(chat.body.options.num_ctx, 4096);
    assert.equal(chat.body.options.seed, 42);
  }
  assert.deepEqual(JSON.parse(chats[1].body.messages[1].content).tentativeIntent, intent);
  assert.ok(f.captures[0].stdinText.startsWith(f.input.prompt));
  const evidence = result.localInference.contextPreparation;
  assert.equal(evidence.strategy, 'staged-request-v2');
  assert.equal(evidence.requestSha256, sha(request));
  assert.equal(evidence.requestBytes, Buffer.byteLength(request));
  assert.equal(evidence.requestOffsetBytes, Buffer.byteLength(`${boilerplate}\n\n`));
  assert.equal(evidence.originalPromptSha256, sha(f.input.prompt));
  assert.equal(evidence.effectivePromptSha256, sha(f.captures[0].stdinText));
});

for (const [request, error] of [
  [undefined, 'local_context_request_required'],
  ['', 'local_context_request_invalid'],
  ['   \n ', 'local_context_request_invalid'],
  [42, 'local_context_request_invalid'],
  ['A different instruction', 'local_context_request_not_literal'],
  ['Trim note titles. Preserve all previous behavior.\nUNICODE: espan\u0303ol', 'local_context_request_not_literal'],
]) {
  test(`staged-request-v2 rejects ${JSON.stringify(request)} before HTTP or the CLI`, async (t) => {
    const f = await fixture(t);
    f.input.localInference.contextStrategy = 'staged-request-v2';
    f.input.localContextRequest = request;
    await assert.rejects(f.service.run(f.input), new RegExp(error));
    assert.equal(f.calls.length, 0);
    assert.equal(f.captures.length, 0);
  });
}

for (const strategy of ['direct-v1', 'staged-v1']) {
  test(`${strategy} retains its request behavior when given a literal functional request`, async (t) => {
    const f = await fixture(t);
    f.input.localInference.contextStrategy = strategy;
    f.input.localContextRequest = 'Trim note titles.';
    const result = await f.service.run(f.input);
    const chats = f.calls.filter((call) => call.url === '/api/chat');
    if (strategy === 'direct-v1') {
      assert.equal(chats.length, 0);
      assert.equal(f.captures[0].stdinText, f.input.prompt);
      assert.equal(result.localInference.contextPreparation, undefined);
    } else {
      assert.equal(chats.length, 2);
      assert.equal(JSON.parse(chats[0].body.messages[1].content).originalRequest, f.input.prompt);
      assert.equal(JSON.parse(chats[1].body.messages[1].content).originalRequest, undefined);
      assert.equal(result.localInference.contextPreparation.strategy, 'staged-v1');
      assert.equal(result.localInference.contextPreparation.requestSha256, undefined);
    }
    f.input.localContextRequest = 'not present in original prompt';
    f.calls.length = 0;
    await assert.rejects(f.service.run(f.input), /local_context_request_not_literal/);
    assert.equal(f.calls.length, 0);
  });
}

test('a functional context request without local inference fails before cloud authentication', async (t) => {
  const f = await fixture(t);
  f.input.localInference = undefined;
  f.input.localContextRequest = 'Trim note titles.';
  await assert.rejects(f.service.run(f.input), /local_context_request_scope_unsupported/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.captures.length, 0);
});

test('staged-request-v2 preserves literal-request evidence when a preparation call fails', async (t) => {
  const f = await fixture(t, ({ res }) => { res.writeHead(500); res.end(); return true; });
  f.input.localInference.contextStrategy = 'staged-request-v2';
  f.input.localContextRequest = 'Trim note titles.';
  await assert.rejects(f.service.run(f.input), (error) => {
    assert.equal(error.message, 'local_context_http');
    const evidence = error.localInference.contextPreparation;
    assert.equal(evidence.strategy, 'staged-request-v2');
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.requestSha256, sha(f.input.localContextRequest));
    assert.equal(evidence.originalPromptSha256, sha(f.input.prompt));
    assert.equal(evidence.effectivePromptSha256, null);
    assert.equal(evidence.stages[0].status, 'failed');
    return true;
  });
  assert.equal(f.captures.length, 0);
});
