import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

// A controlled HTTP service tests the evaluator's rejection rules. It is not
// an application or model benchmark; Docker controls exercise the real stack.
async function controlledNotes(fault, run) {
  let disk = []; let rows = []; let nextId = 1; let restarts = 0;
  const calls = [];
  const persist = () => { disk = structuredClone(rows); };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: request.method, path: request.url, body });
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(status === 204 ? undefined : JSON.stringify(value)); };
    if (request.method === 'GET') {
      let selected = rows.filter((note) => url.searchParams.get('include_archived') === 'true' || !note.archived);
      if (url.searchParams.has('q')) selected = selected.filter((note) => note.title.toLowerCase().includes(url.searchParams.get('q').toLowerCase()));
      send(200, selected); return;
    }
    const id = Number(url.pathname.split('/')[3]);
    const note = rows.find((row) => row.id === id);
    if (request.method !== 'POST' && !note) { send(404, { detail: 'missing' }); return; }
    if (request.method === 'PATCH') {
      note.archived = body.archived;
      if (!((fault === 'archive_not_persisted' && body.archived) || (fault === 'restore_not_persisted' && !body.archived))) persist();
      send(200, note); return;
    }
    if (request.method === 'DELETE') { rows = rows.filter((row) => row.id !== id); persist(); send(204); return; }
    const invalid = typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120;
    if (invalid && !(fault === 'invalid_put_accepted' && request.method === 'PUT')) {
      if (fault === 'invalid_put_corrupts' && request.method === 'PUT') { note.title = 'corrupted'; persist(); }
      send(422, { detail: 'invalid title' }); return;
    }
    const noTrim = fault === `untrimmed_${request.method.toLowerCase()}`;
    const title = noTrim ? body.title : body.title.trim();
    if (request.method === 'POST') {
      const created = { id: nextId++, title, archived: false }; rows.push(created); persist(); send(201, created);
    } else { note.title = title; persist(); send(200, note); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const request = async (method, route, body, expected = 200) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}), signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, expected, `${method} ${route}`);
      return expected === 204 ? null : await response.json();
    };
    const restartBackend = async () => { rows = structuredClone(disk); restarts += 1; };
    await run({ request, restartBackend, calls, restartCount: () => restarts });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('CRUD acceptance rejects untrimmed persisted POST/PUT values and invalid PUTs, including hidden mutation on 422', async () => {
  const { runTaskApiAcceptance } = await import('../../benchmarks/local-development/evaluator/api-acceptance.mjs');
  await controlledNotes(undefined, async (service) => {
    await runTaskApiAcceptance({ taskId: 'crud-01', ...service });
    assert.ok(service.calls.some((call) => call.method === 'PUT' && call.body?.title === '   '));
    assert.ok(service.calls.some((call) => call.method === 'PUT' && call.body?.title?.length === 121));
    assert.ok(service.restartCount() >= 2);
  });
  for (const fault of ['untrimmed_post', 'untrimmed_put', 'invalid_put_accepted', 'invalid_put_corrupts']) {
    await controlledNotes(fault, async (service) => { await assert.rejects(runTaskApiAcceptance({ taskId: 'crud-01', ...service }), { name: 'AssertionError' }, fault); });
  }
});

test('archive acceptance requires both archive and restore state to survive restart with original content and id', async () => {
  const { runTaskApiAcceptance } = await import('../../benchmarks/local-development/evaluator/api-acceptance.mjs');
  await controlledNotes(undefined, async (service) => { await runTaskApiAcceptance({ taskId: 'multi-01', ...service }); assert.equal(service.restartCount(), 3); });
  for (const fault of ['archive_not_persisted', 'restore_not_persisted']) {
    await controlledNotes(fault, async (service) => { await assert.rejects(runTaskApiAcceptance({ taskId: 'multi-01', ...service }), { name: 'AssertionError' }, fault); });
  }
});

test('search acceptance preserves existing API search and trimming bug contracts', async () => {
  const { runTaskApiAcceptance } = await import('../../benchmarks/local-development/evaluator/api-acceptance.mjs');
  for (const taskId of ['modify-01', 'bug-01']) await controlledNotes(undefined, async (service) => runTaskApiAcceptance({ taskId, ...service }));
  await controlledNotes('untrimmed_put', async (service) => { await assert.rejects(runTaskApiAcceptance({ taskId: 'bug-01', ...service }), { name: 'AssertionError' }); });
});

test('browser search waits for a successful matching-q GET before checking the filtered UI', async () => {
  const { searchWithObservedRequest } = await import('../../benchmarks/local-development/evaluator/browser-acceptance.mjs');
  const response = (url, method = 'GET', status = 200) => ({ url: () => url, request: () => ({ method: () => method }), status: () => status });
  let predicate; const events = [];
  const page = {
    waitForResponse: (filter) => { predicate = filter; events.push('listen'); return Promise.resolve(response('http://127.0.0.1:8000/api/notes?q=BROWSER')); },
    getByLabel: (label) => { assert.equal(label, 'Search'); return { fill: async (value) => { events.push(`fill:${value}`); } }; },
  };
  await searchWithObservedRequest(page, 'BROWSER');
  assert.deepEqual(events, ['listen', 'fill:BROWSER']);
  assert.equal(predicate(response('http://127.0.0.1:8000/api/notes?q=BROWSER')), true);
  assert.equal(predicate(response('http://127.0.0.1:8000/api/notes?q=browser')), true);
  assert.equal(predicate(response('http://127.0.0.1:8000/api/notes')), false);
  assert.equal(predicate(response('https://remote.example/api/notes?q=BROWSER')), false);
  assert.equal(predicate(response('http://127.0.0.1:8000/api/notes?q=BROWSER', 'POST')), false);
  assert.equal(predicate(response('http://127.0.0.1:8000/api/notes?q=BROWSER', 'GET', 500)), false);
  await assert.rejects(searchWithObservedRequest({ ...page, waitForResponse: () => Promise.reject(new Error('no q request observed')) }, 'BROWSER'), /no q request observed/);
});
