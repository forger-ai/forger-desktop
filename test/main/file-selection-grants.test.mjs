import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { FileSelectionGrantStore } = require('../../dist-electron/main/file-selection-grants.js');
const { FileLibrary } = require('../../dist-electron/main/file-library.js');
const { registerFileLibraryIpcHandlers } = require('../../dist-electron/main/ipc/file-library-handlers.js');
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');

const tempRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

test('file selection grants are opaque, sender-bound, bounded, expiring, and single-use for import', async (t) => {
  const root = await tempRoot('file-grants');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const firstPath = path.join(root, 'first.txt');
  const secondPath = path.join(root, 'second.txt');
  await fs.writeFile(firstPath, 'first', 'utf8');
  await fs.writeFile(secondPath, 'second', 'utf8');
  let now = 1_000;
  const grants = new FileSelectionGrantStore({ ttlMs: 50, maxGrants: 1, now: () => now });

  const [first] = await grants.issueMany({ senderId: 7, files: [{ sourcePath: firstPath, staged: false }] });
  assert.match(first.grantId, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(first.grantId.includes(root), false);
  await assert.rejects(
    grants.leaseForImport(8, [first.grantId]),
    /file_selection_grant_sender_mismatch/,
  );
  await assert.rejects(
    grants.issueMany({ senderId: 7, files: [{ sourcePath: secondPath, staged: false }] }),
    /too_many_file_selection_grants/,
  );
  await assert.rejects(
    grants.leaseForImport(7, [first.grantId, first.grantId]),
    /duplicate_file_selection_grant/,
  );

  const lease = await grants.leaseForImport(7, [first.grantId]);
  const [opened] = await lease.openFiles();
  assert.equal(await opened.fileHandle.readFile('utf8'), 'first');
  await opened.fileHandle.close();
  await assert.rejects(grants.leaseForImport(7, [first.grantId]), /file_selection_grant_leased/);
  await lease.commit();
  await assert.rejects(grants.leaseForImport(7, [first.grantId]), /invalid_file_selection_grant/);

  const [expiring] = await grants.issueMany({ senderId: 7, files: [{ sourcePath: secondPath, staged: false }] });
  now += 51;
  await assert.rejects(grants.leaseForImport(7, [expiring.grantId]), /expired_file_selection_grant/);
});

test('expiration deletes only unchanged platform-staged files and never ordinary or replaced paths', async (t) => {
  const root = await tempRoot('file-grant-expiration');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const ordinaryPath = path.join(root, 'ordinary.txt');
  const stagedPath = path.join(root, 'staged.png');
  const replacedStagedPath = path.join(root, 'replaced-staged.png');
  const nextPath = path.join(root, 'next.txt');
  await fs.writeFile(ordinaryPath, 'ordinary', 'utf8');
  await fs.writeFile(stagedPath, 'staged', 'utf8');
  await fs.writeFile(replacedStagedPath, 'staged-before', 'utf8');
  await fs.writeFile(nextPath, 'next', 'utf8');
  const stagedRealPath = await fs.realpath(stagedPath);
  let now = 1_000;
  const cleaned = [];
  const grants = new FileSelectionGrantStore({
    maxGrants: 3,
    now: () => now,
    ttlMs: 50,
    cleanupExpiredStagedFiles: async (expired) => {
      cleaned.push(...expired.map((grant) => grant.sourcePath));
      await Promise.all(expired.map((grant) => fs.rm(grant.sourcePath, { force: true })));
    },
  });

  await grants.issueMany({
    senderId: 8,
    files: [
      { sourcePath: ordinaryPath, staged: false },
      { sourcePath: stagedPath, staged: true },
      { sourcePath: replacedStagedPath, staged: true },
    ],
  });
  await fs.rm(replacedStagedPath);
  await fs.writeFile(replacedStagedPath, 'replacement', 'utf8');
  now += 51;

  await grants.issueMany({ senderId: 8, files: [{ sourcePath: nextPath, staged: false }] });
  assert.deepEqual(cleaned, [stagedRealPath]);
  await assert.rejects(fs.stat(stagedPath), /ENOENT/);
  assert.equal(await fs.readFile(ordinaryPath, 'utf8'), 'ordinary');
  assert.equal(await fs.readFile(replacedStagedPath, 'utf8'), 'replacement');
});

test('expired staged grants clean up on lookup while active leases remain valid until rollback', async (t) => {
  const root = await tempRoot('file-grant-expired-lookup');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const lookupPath = path.join(root, 'lookup.png');
  const leasedPath = path.join(root, 'leased.png');
  const nextPath = path.join(root, 'next.txt');
  await fs.writeFile(lookupPath, 'lookup', 'utf8');
  await fs.writeFile(leasedPath, 'leased', 'utf8');
  await fs.writeFile(nextPath, 'next', 'utf8');
  let now = 10_000;
  const grants = new FileSelectionGrantStore({
    maxGrants: 2,
    now: () => now,
    ttlMs: 50,
    cleanupExpiredStagedFiles: async (expired) => {
      await Promise.all(expired.map((grant) => fs.rm(grant.sourcePath, { force: true })));
    },
  });

  const [lookup, leased] = await grants.issueMany({
    senderId: 9,
    files: [
      { sourcePath: lookupPath, staged: true },
      { sourcePath: leasedPath, staged: true },
    ],
  });
  const lease = await grants.leaseForImport(9, [leased.grantId]);
  now += 51;

  await assert.rejects(grants.leaseForImport(9, [lookup.grantId]), /expired_file_selection_grant/);
  await assert.rejects(fs.stat(lookupPath), /ENOENT/);
  await grants.issueMany({ senderId: 9, files: [{ sourcePath: nextPath, staged: false }] });
  assert.equal(await fs.readFile(leasedPath, 'utf8'), 'leased');
  const [opened] = await lease.openFiles();
  assert.equal(await opened.fileHandle.readFile('utf8'), 'leased');
  await opened.fileHandle.close();
  await lease.rollback();
  await assert.rejects(fs.stat(leasedPath), /ENOENT/);
});

test('expiration cleanup failures are contained and do not block grant issuance', async (t) => {
  const root = await tempRoot('file-grant-expiration-failure');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const stagedPath = path.join(root, 'staged.png');
  const nextPath = path.join(root, 'next.txt');
  await fs.writeFile(stagedPath, 'staged', 'utf8');
  await fs.writeFile(nextPath, 'next', 'utf8');
  let now = 100;
  let cleanupAttempts = 0;
  const grants = new FileSelectionGrantStore({
    maxGrants: 1,
    now: () => now,
    ttlMs: 10,
    cleanupExpiredStagedFiles: async () => {
      cleanupAttempts += 1;
      throw new Error('cleanup_failed');
    },
  });

  await grants.issueMany({ senderId: 10, files: [{ sourcePath: stagedPath, staged: true }] });
  now += 11;
  const [next] = await grants.issueMany({ senderId: 10, files: [{ sourcePath: nextPath, staged: false }] });
  assert.equal(typeof next.grantId, 'string');
  assert.equal(cleanupAttempts, 1);
  assert.equal(await fs.readFile(stagedPath, 'utf8'), 'staged');
});

test('file selection grants reject replaced files, changed symlinks, non-files, and invalid staged discards', async (t) => {
  const root = await tempRoot('file-grant-identity');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const replacedPath = path.join(root, 'replaced.txt');
  const nonFilePath = path.join(root, 'non-file.txt');
  const targetA = path.join(root, 'target-a.txt');
  const targetB = path.join(root, 'target-b.txt');
  const linkPath = path.join(root, 'selected-link.txt');
  await fs.writeFile(replacedPath, 'before', 'utf8');
  await fs.writeFile(nonFilePath, 'file', 'utf8');
  await fs.writeFile(targetA, 'a', 'utf8');
  await fs.writeFile(targetB, 'b', 'utf8');
  await fs.symlink(targetA, linkPath);
  const grants = new FileSelectionGrantStore();

  const [replaced, nonFile, symlink, ordinary] = await grants.issueMany({
    senderId: 11,
    files: [
      { sourcePath: replacedPath, staged: false },
      { sourcePath: nonFilePath, staged: false },
      { sourcePath: linkPath, staged: false },
      { sourcePath: targetA, staged: false },
    ],
  });

  await fs.rm(replacedPath);
  await fs.writeFile(replacedPath, 'after', 'utf8');
  await assert.rejects(grants.leaseForImport(11, [replaced.grantId]), /file_selection_changed/);

  await fs.rm(nonFilePath);
  await fs.mkdir(nonFilePath);
  await assert.rejects(grants.leaseForImport(11, [nonFile.grantId]), /file_selection_not_file/);

  await fs.rm(linkPath);
  await fs.symlink(targetB, linkPath);
  await assert.rejects(grants.leaseForImport(11, [symlink.grantId]), /file_selection_changed/);
  await assert.rejects(grants.leaseForImport(11, ['forged']), /invalid_file_selection_grant/);
  const released = await grants.release(11, [ordinary.grantId]);
  assert.deepEqual(released, []);
});

test('import leases roll back for retry, reject concurrent redemption, and reject replacement after descriptor open', async (t) => {
  const root = await tempRoot('file-grant-lease');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.txt');
  const dataRoot = path.join(root, 'data');
  const metadataRoot = path.join(root, 'metadata');
  await fs.writeFile(sourcePath, 'original', 'utf8');
  const grants = new FileSelectionGrantStore();
  const library = new FileLibrary(dataRoot, metadataRoot);
  const [grant] = await grants.issueMany({ senderId: 21, files: [{ sourcePath, staged: false }] });

  const firstLease = await grants.leaseForImport(21, [grant.grantId]);
  await assert.rejects(grants.leaseForImport(21, [grant.grantId]), /file_selection_grant_leased/);
  await firstLease.rollback();

  const retryLease = await grants.leaseForImport(21, [grant.grantId]);
  const opened = await retryLease.openFiles();
  await fs.rm(sourcePath);
  await fs.writeFile(sourcePath, 'replacement', 'utf8');
  await assert.rejects(library.importFiles({ sources: opened }), /file_selection_changed/);
  await Promise.all(opened.map((file) => file.fileHandle.close()));
  await retryLease.rollback();

  assert.deepEqual(await fs.readdir(dataRoot), []);
  await assert.rejects(grants.leaseForImport(21, [grant.grantId]), /file_selection_changed/);
});

test('FileLibrary removes copied files when its index write fails so a rolled-back grant retries cleanly', async (t) => {
  const root = await tempRoot('file-grant-index-retry');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.txt');
  const dataRoot = path.join(root, 'data');
  await fs.writeFile(sourcePath, 'retry me', 'utf8');
  const grants = new FileSelectionGrantStore();
  const library = new FileLibrary(dataRoot, path.join(root, 'metadata'));
  const originalWriteIndex = library.writeIndex.bind(library);
  let failIndexWrite = true;
  library.writeIndex = async (...args) => {
    if (failIndexWrite) {
      throw new Error('index_write_failed');
    }
    return await originalWriteIndex(...args);
  };
  const [grant] = await grants.issueMany({ senderId: 22, files: [{ sourcePath, staged: false }] });

  const failedLease = await grants.leaseForImport(22, [grant.grantId]);
  const failedSources = await failedLease.openFiles();
  await assert.rejects(library.importFiles({ sources: failedSources }), /index_write_failed/);
  await Promise.all(failedSources.map((file) => file.fileHandle.close()));
  await failedLease.rollback();
  assert.deepEqual(await fs.readdir(dataRoot), []);

  failIndexWrite = false;
  const retryLease = await grants.leaseForImport(22, [grant.grantId]);
  const retrySources = await retryLease.openFiles();
  const retried = await library.importFiles({ sources: retrySources });
  await Promise.all(retrySources.map((file) => file.fileHandle.close()));
  await retryLease.commit();
  assert.deepEqual(retried.map((file) => file.name), ['source.txt']);
  assert.equal(await fs.readFile(path.join(dataRoot, 'source.txt'), 'utf8'), 'retry me');
});

test('descriptor verification rejects in-place source mutation during an import before indexing the copy', async (t) => {
  const root = await tempRoot('file-grant-descriptor-mutation');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.txt');
  const dataRoot = path.join(root, 'data');
  await fs.writeFile(sourcePath, 'original', 'utf8');
  const grants = new FileSelectionGrantStore();
  const library = new FileLibrary(dataRoot, path.join(root, 'metadata'));
  const [grant] = await grants.issueMany({ senderId: 23, files: [{ sourcePath, staged: false }] });
  const lease = await grants.leaseForImport(23, [grant.grantId]);
  const opened = await lease.openFiles();

  await fs.writeFile(sourcePath, 'tampered', 'utf8');
  await assert.rejects(library.importFiles({ sources: opened }), /file_selection_changed/);
  await Promise.all(opened.map((file) => file.fileHandle.close()));
  await lease.rollback();
  assert.deepEqual(await fs.readdir(dataRoot), []);
});

test('releasing unused grants prevents exhaustion and only returns staged paths for platform cleanup', async (t) => {
  const root = await tempRoot('file-grant-release');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const normalPath = path.join(root, 'normal.txt');
  const stagedPath = path.join(root, 'staged.png');
  await fs.writeFile(normalPath, 'normal', 'utf8');
  await fs.writeFile(stagedPath, 'staged', 'utf8');
  const grants = new FileSelectionGrantStore({ maxGrants: 2 });

  for (let index = 0; index < 300; index += 1) {
    const [grant] = await grants.issueMany({ senderId: 31, files: [{ sourcePath: normalPath, staged: false }] });
    assert.deepEqual(await grants.release(31, [grant.grantId]), []);
  }
  const [normal, staged] = await grants.issueMany({
    senderId: 31,
    files: [{ sourcePath: normalPath, staged: false }, { sourcePath: stagedPath, staged: true }],
  });
  assert.deepEqual(await grants.release(31, [normal.grantId]), []);
  const stagedCleanup = await grants.release(31, [staged.grantId]);
  assert.deepEqual(stagedCleanup.map((file) => file.sourcePath), [await fs.realpath(stagedPath)]);
});

test('file IPC exposes metadata and grant IDs only, imports once, and discards only bound staged grants', async (t) => {
  const root = await tempRoot('file-grant-ipc');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'selected.csv');
  const outsidePath = path.join(root, 'outside.png');
  const dataRoot = path.join(root, 'data');
  const metadataRoot = path.join(root, 'metadata');
  await fs.writeFile(sourcePath, 'a,b\n1,2\n', 'utf8');
  await fs.writeFile(outsidePath, 'keep', 'utf8');
  const library = new FileLibrary(dataRoot, metadataRoot);
  const grants = new FileSelectionGrantStore();
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  registerFileLibraryIpcHandlers({
    IPC_CHANNELS,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [sourcePath] }) },
    getFileLibrary: () => library,
    ipcMain,
    getMainWindow: () => null,
    fileSelectionGrants: grants,
  });
  const sender = { sender: { id: 91 } };

  const [picked] = await handlers.get(IPC_CHANNELS.filesPickForChat)(sender);
  assert.deepEqual(Object.keys(picked).sort(), ['grantId', 'modifiedAt', 'name', 'sizeBytes', 'type']);
  assert.equal(picked.name, 'selected.csv');
  assert.equal(JSON.stringify(picked).includes(root), false);
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)({ sender: { id: 92 } }, { grantIds: [picked.grantId] }),
    /file_selection_grant_sender_mismatch/,
  );
  const imported = await handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [picked.grantId] });
  assert.equal(imported[0].relativePath, 'selected.csv');
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [picked.grantId] }),
    /invalid_file_selection_grant/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)(sender, { sourcePaths: [outsidePath] }),
    /invalid_file_selection_grant_input/,
  );

  const staged = await handlers.get(IPC_CHANNELS.filesStageForChat)(sender, {
    name: 'pasted',
    mimeType: 'image/png',
    dataBase64: Buffer.from('png').toString('base64'),
  });
  assert.equal(staged.staged, true);
  assert.equal(Object.hasOwn(staged, 'sourcePath'), false);
  await handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [staged.grantId] });
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [staged.grantId] }),
    /file_selection_grant_replayed/,
  );
  await handlers.get(IPC_CHANNELS.filesDiscardStagedForChat)(sender, { grantIds: [staged.grantId] });
  assert.deepEqual(await fs.readdir(path.join(metadataRoot, 'files', 'chat-staging')), []);
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesDiscardStagedForChat)(sender, { grantIds: ['forged'] }),
    /invalid_file_selection_grant/,
  );
  assert.equal(await fs.readFile(outsidePath, 'utf8'), 'keep');
});

test('file IPC rolls a failed import lease back, rejects concurrent use, and commits only after success', async (t) => {
  const root = await tempRoot('file-grant-ipc-lease');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'selected.txt');
  await fs.writeFile(sourcePath, 'selected', 'utf8');
  const baseLibrary = new FileLibrary(path.join(root, 'data'), path.join(root, 'metadata'));
  let importCalls = 0;
  let unblockImport;
  let importStarted;
  const importStartedPromise = new Promise((resolve) => { importStarted = resolve; });
  const blockedImport = new Promise((resolve) => { unblockImport = resolve; });
  const library = {
    pickFileInfo: (...args) => baseLibrary.pickFileInfo(...args),
    importFiles: async (input) => {
      importCalls += 1;
      if (importCalls === 1) {
        throw new Error('copy_failed');
      }
      if (importCalls === 2) {
        importStarted();
        await blockedImport;
      }
      return await baseLibrary.importFiles(input);
    },
  };
  const handlers = new Map();
  registerFileLibraryIpcHandlers({
    IPC_CHANNELS,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [sourcePath] }) },
    getFileLibrary: () => library,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getMainWindow: () => null,
  });
  const sender = { sender: { id: 101 } };
  const [picked] = await handlers.get(IPC_CHANNELS.filesPickForChat)(sender);

  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [picked.grantId] }),
    /copy_failed/,
  );
  const retry = handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [picked.grantId] });
  await importStartedPromise;
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [picked.grantId] }),
    /file_selection_grant_leased/,
  );
  unblockImport();
  assert.equal((await retry).length, 1);
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [picked.grantId] }),
    /invalid_file_selection_grant/,
  );
});

test('file IPC release revokes every grant, deletes only staged files, and revokes sender grants on destroy', async (t) => {
  const root = await tempRoot('file-grant-ipc-release');
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'selected.txt');
  const outsidePath = path.join(root, 'outside.txt');
  const metadataRoot = path.join(root, 'metadata');
  await fs.writeFile(sourcePath, 'selected', 'utf8');
  await fs.writeFile(outsidePath, 'outside', 'utf8');
  const library = new FileLibrary(path.join(root, 'data'), metadataRoot);
  const handlers = new Map();
  registerFileLibraryIpcHandlers({
    IPC_CHANNELS,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [sourcePath] }) },
    getFileLibrary: () => library,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getMainWindow: () => null,
  });
  const webContents = new EventEmitter();
  webContents.id = 201;
  const sender = { sender: webContents };
  const [normal] = await handlers.get(IPC_CHANNELS.filesPickForChat)(sender);
  const staged = await handlers.get(IPC_CHANNELS.filesStageForChat)(sender, {
    name: 'paste',
    mimeType: 'image/png',
    dataBase64: Buffer.from('png').toString('base64'),
  });
  await handlers.get(IPC_CHANNELS.filesReleaseSelections)(sender, { grantIds: [normal.grantId] });
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [normal.grantId] }),
    /invalid_file_selection_grant/,
  );
  assert.equal(await fs.readFile(sourcePath, 'utf8'), 'selected');

  webContents.emit('destroyed');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const stagedEntries = await fs.readdir(path.join(metadataRoot, 'files', 'chat-staging'));
    if (stagedEntries.length === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)(sender, { grantIds: [staged.grantId] }),
    /invalid_file_selection_grant/,
  );
  assert.deepEqual(await fs.readdir(path.join(metadataRoot, 'files', 'chat-staging')), []);
  assert.equal(await fs.readFile(outsidePath, 'utf8'), 'outside');
});

test('file picker resolves the current main window for every dialog', async () => {
  const firstWindow = { id: 'first', isDestroyed: () => false };
  const secondWindow = { id: 'second', isDestroyed: () => false };
  let currentWindow = firstWindow;
  const dialogParents = [];
  const handlers = new Map();
  registerFileLibraryIpcHandlers({
    IPC_CHANNELS,
    dialog: {
      showOpenDialog: async (...args) => {
        dialogParents.push(args[0]);
        return { canceled: true, filePaths: [] };
      },
    },
    getFileLibrary: () => ({}),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getMainWindow: () => currentWindow,
  });

  await handlers.get(IPC_CHANNELS.filesPickForChat)({ sender: { id: 301 } });
  currentWindow = secondWindow;
  await handlers.get(IPC_CHANNELS.filesPickForChat)({ sender: { id: 301 } });
  assert.deepEqual(dialogParents, [firstWindow, secondWindow]);
});
