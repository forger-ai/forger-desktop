import assert from 'node:assert/strict';

export async function runTaskApiAcceptance({ taskId, request, restartBackend }) {
  if (taskId === 'template-01') {
    assert.deepEqual(await request('GET', '/api/desk'), { name: 'My local desk', storage: 'local' });
    return;
  }
  const first = await request('POST', '/api/notes', { title: 'Alpha preserved' }, 201);
  assert.equal(first.title, 'Alpha preserved'); assert.ok(first.id);
  const changed = await request('PUT', `/api/notes/${first.id}`, { title: 'Alpha updated' });
  assert.equal(changed.id, first.id); assert.equal(changed.title, 'Alpha updated');
  await request('PUT', '/api/notes/99999999', { title: 'Missing' }, 404);
  await request('DELETE', '/api/notes/99999999', undefined, 404);
  await request('POST', '/api/notes', { title: '   ' }, 422);
  await request('POST', '/api/notes', { title: '' }, 422);
  await request('POST', '/api/notes', { title: 'x'.repeat(121) }, 422);
  await restartBackend();
  assert.ok((await request('GET', '/api/notes')).some((note) => note.id === first.id && note.title === 'Alpha updated'));
  if (taskId === 'modify-01') {
    const second = await request('POST', '/api/notes', { title: 'Beta' }, 201);
    assert.deepEqual((await request('GET', '/api/notes?q=aLpHa')).map((note) => note.id), [first.id]);
    assert.equal((await request('GET', '/api/notes?q=')).length, 2);
    assert.deepEqual(await request('GET', '/api/notes?q=no-such-note'), []);
    await request('DELETE', `/api/notes/${second.id}`, undefined, 204);
  }
  if (taskId === 'crud-01') {
    const normalized = await request('POST', '/api/notes', { title: '  Trim me  ' }, 201);
    assert.equal(normalized.title, 'Trim me');
    assert.equal((await request('GET', '/api/notes')).find((note) => note.id === normalized.id)?.title, 'Trim me');
    const edited = await request('PUT', `/api/notes/${normalized.id}`, { title: '  Edited  ' });
    assert.equal(edited.id, normalized.id); assert.equal(edited.title, 'Edited');
    for (const title of ['', '   ', 'x'.repeat(121)]) {
      await request('PUT', `/api/notes/${normalized.id}`, { title }, 422);
      const notes = await request('GET', '/api/notes');
      assert.equal(notes.length, 2, 'An invalid update must not insert another row');
      assert.equal(notes.find((note) => note.id === normalized.id)?.title, 'Edited', 'An invalid update must preserve the existing title');
      assert.equal(notes.find((note) => note.id === first.id)?.title, 'Alpha updated');
    }
    await restartBackend();
    assert.equal((await request('GET', '/api/notes')).find((note) => note.id === normalized.id)?.title, 'Edited', 'The normalized update must persist across restart');
    await request('DELETE', `/api/notes/${normalized.id}`, undefined, 204);
  }
  if (taskId === 'bug-01') {
    const normalized = await request('POST', '/api/notes', { title: '  Trim me  ' }, 201);
    assert.equal(normalized.title, 'Trim me');
    assert.equal((await request('PUT', `/api/notes/${normalized.id}`, { title: '  Edited  ' })).title, 'Edited');
    await request('DELETE', `/api/notes/${normalized.id}`, undefined, 204);
  }
  if (taskId === 'multi-01') {
    assert.equal(first.archived, false);
    assert.equal((await request('PATCH', `/api/notes/${first.id}/archive`, { archived: true })).archived, true);
    assert.deepEqual(await request('GET', '/api/notes'), []);
    await restartBackend();
    const archived = await request('GET', '/api/notes?include_archived=true');
    assert.equal(archived.length, 1);
    assert.equal(archived[0].id, first.id); assert.equal(archived[0].title, 'Alpha updated');
    assert.equal(archived[0].archived, true, 'The archive flag must persist across restart');
    assert.deepEqual(await request('GET', '/api/notes'), [], 'Restart must not expose archived rows in the active list');
    assert.equal((await request('PATCH', `/api/notes/${first.id}/archive`, { archived: false })).archived, false);
    await restartBackend();
    for (const route of ['/api/notes', '/api/notes?include_archived=true']) {
      const restored = await request('GET', route);
      assert.equal(restored.length, 1);
      assert.equal(restored[0].id, first.id); assert.equal(restored[0].title, 'Alpha updated');
      assert.equal(restored[0].archived, false, 'The restored active state must persist across restart');
    }
    await request('PATCH', '/api/notes/99999999/archive', { archived: true }, 404);
  }
  await request('DELETE', `/api/notes/${first.id}`, undefined, 204);
  assert.deepEqual(await request('GET', '/api/notes'), []);
}
