import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileSelectionGrantStore } = require('../../dist-electron/main/file-selection-grants.js');

const fixture = async (t, name = 'file-grants-b21') => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.txt');
  await fs.writeFile(sourcePath, 'source', 'utf8');
  return { root, sourcePath };
};

test('FileSelectionGrantStore validates issuance and applies safe option defaults', async (t) => {
  const { root, sourcePath } = await fixture(t, 'forger-grants-b21-issue');
  let now = 100;
  const defaults = new FileSelectionGrantStore({ maxGrants: 0, now: () => now, ttlMs: 0 });
  await assert.rejects(defaults.issueMany({ senderId: 1.5, files: [] }), /invalid_file_selection_sender/);
  await assert.rejects(
    defaults.issueMany({ senderId: 1, files: [{ sourcePath: path.join(root, 'missing'), staged: false }] }),
    /file_selection_not_file/,
  );
  await assert.rejects(
    defaults.issueMany({ senderId: 1, files: [{ sourcePath: root, staged: false }] }),
    /file_selection_not_file/,
  );
  const [grant] = await defaults.issueMany({ senderId: 1, files: [{ name: ' renamed.txt ', sourcePath, staged: true }] });
  assert.equal(defaults.grants.get(grant.grantId).importName, 'renamed.txt');
  await assert.rejects(defaults.issueMany({ senderId: 1, files: [{ sourcePath, staged: false }] }), /too_many_file_selection_grants/);

  now = 102;
  await defaults.issueMany({ senderId: 1, files: [] });
  assert.equal(defaults.grants.size, 0);
});

test('FileSelectionGrantStore makes lease finalization idempotent and retryable after an open failure', async (t) => {
  const { sourcePath } = await fixture(t, 'forger-grants-b21-lease');
  const grants = new FileSelectionGrantStore();
  const [first, second] = await grants.issueMany({
    senderId: 2,
    files: [
      { sourcePath, staged: false },
      { sourcePath, staged: true },
    ],
  });
  const firstLease = await grants.leaseForImport(2, [first.grantId]);
  await assert.rejects(grants.release(2, [first.grantId]), /file_selection_grant_leased/);
  await firstLease.commit();
  await firstLease.commit();
  await assert.rejects(firstLease.openFiles(), /file_selection_lease_unavailable/);

  const secondLease = await grants.leaseForImport(2, [second.grantId]);
  await assert.rejects(grants.openLeaseFiles('wrong-lease', [second.grantId]), /file_selection_lease_unavailable/);
  const originalOpenLeaseFiles = grants.openLeaseFiles.bind(grants);
  let attempts = 0;
  grants.openLeaseFiles = async (...args) => {
    if (attempts++ === 0) throw new Error('open failed');
    return await originalOpenLeaseFiles(...args);
  };
  await assert.rejects(secondLease.openFiles(), /open failed/);
  const opened = await secondLease.openFiles();
  await Promise.all(opened.map(({ fileHandle }) => fileHandle.close()));
  await secondLease.rollback();
  await secondLease.rollback();
});

test('FileSelectionGrantStore handles stale and expired lease records without cross-lease mutation', async (t) => {
  const { sourcePath } = await fixture(t, 'forger-grants-b21-finish');
  let now = 100;
  const cleaned = [];
  const grants = new FileSelectionGrantStore({
    now: () => now,
    ttlMs: 10,
    cleanupExpiredStagedFiles: async (records) => cleaned.push(...records),
  });
  const [expired, replayed] = await grants.issueMany({
    senderId: 3,
    files: [{ sourcePath, staged: true }, { sourcePath, staged: true }],
  });
  const expiredLease = await grants.leaseForImport(3, [expired.grantId]);
  now = 111;
  await expiredLease.rollback();
  assert.equal(grants.grants.has(expired.grantId), false);
  assert.equal(cleaned.length, 1);

  grants.grants.get(replayed.grantId).expiresAt = 200;
  const replayLease = await grants.leaseForImport(3, [replayed.grantId]);
  await replayLease.commit();
  await assert.rejects(grants.leaseForImport(3, [replayed.grantId]), /file_selection_grant_replayed/);
  await grants.finishLease('wrong-lease', ['missing', replayed.grantId], true);
});

test('FileSelectionGrantStore closes partial descriptors and rejects changed descriptor identity', async (t) => {
  const { root, sourcePath } = await fixture(t, 'forger-grants-b21-descriptors');
  const secondPath = path.join(root, 'second.txt');
  await fs.writeFile(secondPath, 'second', 'utf8');
  const grants = new FileSelectionGrantStore();
  const issued = await grants.issueMany({ senderId: 4, files: [
    { sourcePath, staged: false },
    { sourcePath: secondPath, staged: false },
  ] });
  const lease = await grants.leaseForImport(4, issued.map(({ grantId }) => grantId));
  const originalOpen = fs.open;
  let firstHandle;
  let openCalls = 0;
  fs.open = async (...args) => {
    if (++openCalls === 2) throw new Error('open denied');
    firstHandle = await originalOpen(...args);
    return firstHandle;
  };
  t.after(() => { fs.open = originalOpen; });
  await assert.rejects(lease.openFiles(), /file_selection_changed/);
  await assert.rejects(firstHandle.stat(), /closed/);
  fs.open = originalOpen;

  const retry = await lease.openFiles();
  const first = retry[0];
  const originalStat = first.fileHandle.stat.bind(first.fileHandle);
  first.fileHandle.stat = async () => null;
  await assert.rejects(first.verify(), /file_selection_changed/);
  first.fileHandle.stat = originalStat;
  await Promise.all(retry.map(({ fileHandle }) => fileHandle.close()));
  await lease.rollback();
});

test('FileSelectionGrantStore rejects invalid ownership shapes and missing selected identities', async (t) => {
  const { sourcePath } = await fixture(t, 'forger-grants-b21-validation');
  const grants = new FileSelectionGrantStore();
  const [grant] = await grants.issueMany({ senderId: 5, files: [{ sourcePath, staged: true }] });
  await assert.rejects(grants.release(1.2, []), /invalid_file_selection_grant/);
  await assert.rejects(grants.release(5, null), /invalid_file_selection_grant/);
  await assert.rejects(grants.release(5, [null]), /invalid_file_selection_grant/);
  await assert.rejects(grants.release(5, ['']), /invalid_file_selection_grant/);

  await fs.rm(sourcePath);
  await assert.rejects(grants.leaseForImport(5, [grant.grantId]), /file_selection_not_file/);
  assert.deepEqual(await grants.revokeSender(5), []);
});

test('FileSelectionGrantStore rejects non-file and changed descriptors after opening', async (t) => {
  const { sourcePath } = await fixture(t, 'forger-grants-b21-open-validation');
  const grants = new FileSelectionGrantStore();
  const [grant] = await grants.issueMany({ senderId: 6, files: [{ sourcePath, staged: false }] });
  const lease = await grants.leaseForImport(6, [grant.grantId]);
  const originalOpen = fs.open;
  let closed = 0;
  fs.open = async () => ({
    close: async () => { closed += 1; throw new Error('close failed'); },
    stat: async () => null,
  });
  t.after(() => { fs.open = originalOpen; });
  await assert.rejects(lease.openFiles(), /file_selection_not_file/);
  assert.equal(closed, 1);

  fs.open = async () => {
    const handle = await originalOpen(sourcePath, 'r');
    return {
      close: () => handle.close(),
      stat: async () => ({ ...(await handle.stat({ bigint: true })), size: 999n, isFile: () => true }),
    };
  };
  await assert.rejects(lease.openFiles(), /file_selection_changed/);
});
