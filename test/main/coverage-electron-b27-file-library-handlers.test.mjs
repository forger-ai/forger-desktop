import assert from 'node:assert/strict';
import test from 'node:test';

const { registerFileLibraryIpcHandlers } = await import('../../dist-electron/main/ipc/file-library-handlers.js');
const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');

const register = ({ dialog, library, grants, mainWindow = null }) => {
  const handlers = new Map();
  registerFileLibraryIpcHandlers({
    IPC_CHANNELS,
    dialog,
    getFileLibrary: () => library,
    getMainWindow: () => mainWindow,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    fileSelectionGrants: grants,
  });
  return handlers;
};

test('file selection IPC rejects requests without a stable WebContents identity', async () => {
  const handlers = register({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/picked.txt'] }) },
    library: { pickFileInfo: async () => [{ name: 'picked.txt', sourcePath: '/picked.txt' }] },
    grants: { issueMany: async () => assert.fail('identity is checked before issuing grants') },
  });
  for (const event of [null, {}, { sender: {} }, { sender: { id: 1.5 } }]) {
    await assert.rejects(handlers.get(IPC_CHANNELS.filesPickForChat)(event), /invalid_file_selection_sender/);
  }
});

test('file selection IPC revokes an already-destroyed sender and cleans staged files', async () => {
  let completeCleanup;
  const cleanupComplete = new Promise((resolve) => { completeCleanup = resolve; });
  const discarded = [];
  const grants = {
    issueMany: async () => [{ grantId: 'grant' }],
    revokeSender: async (senderId) => {
      assert.equal(senderId, 12);
      return [{ sourcePath: '/staged.txt', staged: true }];
    },
  };
  const handlers = register({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/picked.txt'] }) },
    library: {
      pickFileInfo: async () => [{ name: 'picked.txt', sourcePath: '/picked.txt', sizeBytes: 1 }],
      discardStagedFilesForChat: async (input) => {
        discarded.push(input);
        completeCleanup();
      },
    },
    grants,
  });
  const picked = await handlers.get(IPC_CHANNELS.filesPickForChat)({
    sender: { id: 12, isDestroyed: () => true },
  });
  assert.deepEqual(picked, [{ name: 'picked.txt', sizeBytes: 1, grantId: 'grant' }]);
  await cleanupComplete;
  assert.deepEqual(discarded, [{ sourcePaths: ['/staged.txt'] }]);
});

test('file staging rolls back staged data when grant creation fails, including cleanup failure', async () => {
  const handlers = register({
    dialog: {},
    library: {
      stageFileForChat: async () => ({ name: 'paste.png', sourcePath: '/staged.png', staged: true }),
      discardStagedFilesForChat: async () => { throw new Error('cleanup_failed'); },
    },
    grants: { issueMany: async () => { throw new Error('grant_failed'); } },
  });
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesStageForChat)({ sender: { id: 7 } }, { dataBase64: 'a' }),
    /grant_failed/,
  );
});

test('file import rolls a lease back when opening selections fails and has no handles to close', async () => {
  let rolledBack = false;
  const handlers = register({
    dialog: {},
    library: {},
    grants: {
      leaseForImport: async () => ({
        openFiles: async () => { throw new Error('open_failed'); },
        rollback: async () => { rolledBack = true; },
      }),
    },
  });
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)({ sender: { id: 8 } }, { grantIds: [] }),
    /open_failed/,
  );
  assert.equal(rolledBack, true);
});

test('file import still closes opened handles when rollback itself fails', async () => {
  let closed = false;
  const handlers = register({
    dialog: {},
    library: { importFiles: async () => { throw new Error('import_failed'); } },
    grants: {
      leaseForImport: async () => ({
        openFiles: async () => [{ fileHandle: { close: async () => { closed = true; } } }],
        rollback: async () => { throw new Error('rollback_failed'); },
      }),
    },
  });
  await assert.rejects(
    handlers.get(IPC_CHANNELS.filesImport)({ sender: { id: 9 } }, { grantIds: [] }),
    /rollback_failed/,
  );
  assert.equal(closed, true);
});
