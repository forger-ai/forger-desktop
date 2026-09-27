import assert from 'node:assert/strict';

export async function searchWithObservedRequest(page, term) {
  // Listen before input changes to catch immediate requests as well as debounce.
  // Case normalization and omitting an empty q preserve the requested semantics.
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return candidate.request().method() === 'GET' && candidate.status() === 200
      && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.port === '8000' && url.pathname === '/api/notes'
      && (url.searchParams.get('q') ?? '').toLowerCase() === term.toLowerCase();
  }, { timeout: 10000 });
  await Promise.all([response, page.getByLabel('Search', { exact: true }).fill(term)]);
}

export async function runBrowserTaskAcceptance({ taskId, page }) {
  if (taskId === 'template-01') {
    await page.getByRole('heading', { name: 'My local desk', exact: true }).waitFor();
    await page.getByText('0', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('1', { exact: true }).waitFor();
  } else {
    await page.getByLabel('Note title', { exact: true }).fill('Browser note');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    let row = page.getByRole('listitem').filter({ hasText: 'Browser note' });
    await row.waitFor();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Note title', { exact: true }).fill('Browser edited');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    row = page.getByRole('listitem').filter({ hasText: 'Browser edited' });
    await row.waitFor();
    if (taskId === 'modify-01') {
      await searchWithObservedRequest(page, 'no-matching-note');
      await row.waitFor({ state: 'hidden' });
      await searchWithObservedRequest(page, 'BROWSER');
      await row.waitFor();
      const search = page.getByLabel('Search', { exact: true });
      assert.equal(await search.inputValue(), 'BROWSER');
      await row.getByRole('button', { name: 'Edit', exact: true }).click();
      assert.equal(await search.inputValue(), 'BROWSER', 'Editing a filtered result must preserve the active query');
      await page.getByLabel('Note title', { exact: true }).fill('Browser filtered edit');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      row = page.getByRole('listitem').filter({ hasText: 'Browser filtered edit' });
      await row.waitFor();
      assert.equal(await search.inputValue(), 'BROWSER');
      await row.getByRole('button', { name: 'Delete', exact: true }).click();
      await row.waitFor({ state: 'hidden' });
      assert.equal(await search.inputValue(), 'BROWSER', 'Deleting a filtered result must preserve the active query');
      await searchWithObservedRequest(page, '');
      await row.waitFor({ state: 'hidden' });
      return;
    }
    if (taskId === 'multi-01') {
      await row.getByRole('button', { name: 'Archive', exact: true }).click();
      await row.waitFor({ state: 'hidden' });
      await page.getByLabel('Show archived', { exact: true }).check();
      await row.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByLabel('Show archived', { exact: true }).uncheck();
      await row.waitFor();
    }
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await row.waitFor({ state: 'hidden' });
  }
}
