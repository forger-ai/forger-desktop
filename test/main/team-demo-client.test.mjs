import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('Personal Desktop submits the public Teams demo request with the accepted source', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ id: 42 }), { status: 202 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { TeamDemoClient } = require('../../dist-electron/main/forger-backend/team-demo-client.js');
  const client = new TeamDemoClient({ backendBaseUrl: 'https://forger.test', token: () => undefined });
  const result = await client.request({
    name: 'Ana Pérez',
    email: 'ana@example.com',
    phone: '+56 9 1234 5678',
    useCase: 'Crear herramientas internas',
    website: '',
  });

  assert.deepEqual(result, { id: 42, success: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://forger.test/api/team_demo_requests');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    contact_name: 'Ana Pérez',
    email: 'ana@example.com',
    phone: '+56 9 1234 5678',
    use_case: 'Crear herramientas internas',
    website: '',
    source: 'desktop_personal',
  });
});

test('Personal Desktop treats only HTTP 202 as a successful demo request', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ accepted: true }), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const { TeamDemoClient } = require('../../dist-electron/main/forger-backend/team-demo-client.js');
  const client = new TeamDemoClient({ backendBaseUrl: 'https://forger.test', token: () => 'optional-token' });
  const result = await client.request({ name: 'Ana', email: 'ana@example.com', phone: '123', useCase: 'Apps' });

  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'team_demo_request_failed_200');
});
