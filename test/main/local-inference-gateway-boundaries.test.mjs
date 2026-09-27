import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createLocalInferenceGateway } = require('../../dist-electron/main/llm-provider/local/gateway.js');

test('a runtime disconnect before headers returns a safe failure and does not poison the next local request', async (t) => {
  let calls = 0;
  const runtime = http.createServer((request, response) => {
    calls += 1;
    if (calls === 1) {
      request.socket.destroy();
      return;
    }
    response.end(JSON.stringify({ output: 'recovered' }));
  });
  await new Promise((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const gateway = await createLocalInferenceGateway({
    endpoint: `http://127.0.0.1:${runtime.address().port}`,
    model: 'fixture:small',
    timeoutMs: 3000,
  });
  t.after(async () => {
    await gateway.close();
    runtime.closeAllConnections();
    await new Promise((resolve) => runtime.close(resolve));
  });
  const request = () => fetch(`${gateway.baseUrl}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture:small', input: 'synthetic request' }),
  });

  const failed = await request();
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'local_gateway_rejected' });
  const recovered = await request();
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { output: 'recovered' });
  assert.equal(calls, 2);
});
