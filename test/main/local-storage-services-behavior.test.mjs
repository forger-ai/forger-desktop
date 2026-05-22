/* eslint-disable max-lines */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const nodeFs = require('node:fs');
const execFileAsync = promisify(execFile);
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8').replace(/^sealed:/, ''),
    },
    shell: {
      openPath: async () => '',
    },
  },
};
const electronSafeStorage = require.cache[electronPath].exports.safeStorage;
const originalEncryptionAvailable = electronSafeStorage.isEncryptionAvailable;

const { BackupsManager } = require('../../dist-electron/main/backups-manager.js');
const { FileLibrary } = require('../../dist-electron/main/file-library.js');
const { SecretsStore, appSecretEnvName } = require('../../dist-electron/main/secrets-store.js');
const { DesktopUpdater } = require('../../dist-electron/main/desktop-updater.js');
const { DevCatalogService, __testDevCatalogInternals } = require('../../dist-electron/main/dev-catalog-service.js');
const { ForgerAccountStore, normalizeForgerAccountUser, publicForgerAccount } = require('../../dist-electron/main/forger-account-store.js');
const { OfficialToolsService, normalizeAppToolDeclarations } = require('../../dist-electron/main/official-tools-service.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

test('BackupsManager backs up manifest-declared persistent files and restores only inside the install root', async (t) => {
  const root = await tmpRoot('backups');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'metadata', 'backups');
  await fs.mkdir(path.join(installDir, 'backend', 'data'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'custom-data'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'before-db', 'utf8');
  await fs.writeFile(path.join(installDir, 'custom-data', 'notes.txt'), 'before-notes', 'utf8');
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    services: [
      {
        name: 'backend',
        context: './backend',
        volumes: [{ source: 'custom-data', persist: true }, { source: '../outside', persist: true }],
        environment: { DATABASE_URL: 'sqlite:///{app_root}/backend/data/app.sqlite3' },
      },
    ],
  }), 'utf8');
  const appRecord = {
    appId: 'demo-app',
    name: 'Demo App',
    version: '1.0.0',
    installDir,
  };
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: () => appRecord,
    isAppRunning: () => false,
  });

  const created = await manager.createBackup({ appId: 'demo-app', reason: 'manual' });
  assert.equal(created.success, true);
  assert.equal(created.backup.fileCount, 2);
  assert.deepEqual(
    created.backup.files.map((file) => file.sourceRelativePath).sort(),
    ['backend/data/app.sqlite3', 'custom-data/notes.txt'],
  );

  await fs.writeFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'after-db', 'utf8');
  await fs.writeFile(path.join(installDir, 'custom-data', 'notes.txt'), 'after-notes', 'utf8');
  const restored = await manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId });

  assert.equal(restored.success, true);
  assert.equal(await fs.readFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'utf8'), 'before-db');
  assert.equal(await fs.readFile(path.join(installDir, 'custom-data', 'notes.txt'), 'utf8'), 'before-notes');
  assert.equal(await fs.stat(path.join(root, 'outside')).catch(() => null), null);
});

test('BackupsManager refuses to restore while an app is running', async (t) => {
  const root = await tmpRoot('backups-running');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  await fs.mkdir(path.join(installDir, 'backend', 'data'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'db', 'utf8');
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot: path.join(root, 'metadata', 'backups'),
    listInstalledApps: () => [appRecord],
    getInstalledApp: () => appRecord,
    isAppRunning: () => true,
  });
  const created = await manager.createBackup({ appId: 'demo-app' });

  const restored = await manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId });

  assert.equal(restored.success, false);
  assert.equal(restored.technicalCode, 'app_running');
});

test('BackupsManager lists, deletes, verifies checksums, and restores backup directories safely', async (t) => {
  const root = await tmpRoot('backups-integrity');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'metadata', 'backups');
  const events = [];
  await fs.mkdir(path.join(installDir, 'backend', 'data'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'original-db', 'utf8');
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: (appId) => (appId === 'demo-app' ? appRecord : undefined),
    isAppRunning: () => false,
    log: async (event, payload) => events.push([event, payload]),
  });

  const created = await manager.createBackup({ appId: 'demo-app', reason: 'manual' });
  const backupDir = manager.backupDirectory('demo-app', created.backup.backupId);
  const listed = await manager.listBackups();

  assert.equal(listed.length, 1);
  assert.equal(listed[0].backupId, created.backup.backupId);
  assert.equal(manager.backupDirectory('demo-app', '../bad'), null);
  assert.deepEqual(await manager.deleteBackup({ appId: 'demo-app', backupId: '../bad' }), {
    success: false,
    userMessage: 'No pudimos encontrar ese respaldo.',
    technicalCode: 'invalid_backup_id',
  });
  assert.deepEqual(await manager.deleteBackup({ appId: 'demo-app', backupId: 'missing' }), {
    success: false,
    userMessage: 'No pudimos encontrar ese respaldo.',
    technicalCode: 'backup_not_found',
  });
  assert.equal(events[0][0], 'backup:created');

  await fs.writeFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'changed-db', 'utf8');
  const restored = await manager.restoreBackupDirectory({ appId: 'demo-app', backupDir });
  assert.equal(restored.success, true);
  assert.equal(await fs.readFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'utf8'), 'original-db');

  const corrupt = await manager.createBackup({ appId: 'demo-app', reason: 'manual' });
  const corruptFile = path.join(
    backupsRoot,
    'demo-app',
    corrupt.backup.backupId,
    corrupt.backup.files[0].backupRelativePath,
  );
  await fs.writeFile(corruptFile, 'tampered-db', 'utf8');
  await assert.rejects(
    manager.restoreBackup({ appId: 'demo-app', backupId: corrupt.backup.backupId }),
    /backup_file_mismatch|backup_checksum_mismatch/,
  );

  const deleted = await manager.deleteBackup({ appId: 'demo-app', backupId: created.backup.backupId });
  assert.equal(deleted.success, true);
  assert.equal(await fs.stat(backupDir).catch(() => null), null);
});

test('BackupsManager rejects malformed metadata and collects docker-style sqlite paths without workspace access', async (t) => {
  const root = await tmpRoot('backups-malformed');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'metadata', 'backups');
  await fs.mkdir(path.join(installDir, 'backend', 'data'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'backend', 'data', 'docker.sqlite'), 'docker-db', 'utf8');
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    services: [
      {
        context: './backend',
        volumes: [{ source: 42, persist: true }, { source: 'backend/data', persist: false }],
        environment: { DATABASE_URL: 'sqlite:////app/data/docker.sqlite' },
      },
      { environment: { DATABASE_URL: 'postgres://ignored' } },
    ],
  }), 'utf8');
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: (appId) => (appId === 'demo-app' ? appRecord : undefined),
    isAppRunning: () => false,
  });

  assert.equal((await manager.createBackup({ appId: 'missing' })).technicalCode, 'app_not_installed');
  assert.equal((await manager.restoreBackup({ appId: 'missing', backupId: 'b1' })).technicalCode, 'app_not_installed');
  assert.equal((await manager.restoreBackupDirectory({ appId: 'missing', backupDir: root })).technicalCode, 'app_not_installed');

  const created = await manager.createBackup({ appId: 'demo-app', reason: 'manual' });
  assert.deepEqual(created.backup.files.map((file) => file.sourceRelativePath), ['backend/data/docker.sqlite']);
  const backupDir = manager.backupDirectory('demo-app', created.backup.backupId);
  const metadataPath = path.join(backupDir, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));

  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, appId: 'other-app' }), 'utf8');
  await assert.rejects(
    manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId }),
    /invalid_backup_metadata/,
  );

  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, files: [{ ...metadata.files[0], backupRelativePath: '../escape' }] }), 'utf8');
  await assert.rejects(
    manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId }),
    /invalid_backup_metadata_path/,
  );

  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, schemaVersion: 2 }), 'utf8');
  await assert.rejects(
    manager.restoreBackupDirectory({ appId: 'demo-app', backupDir }),
    /invalid_backup_metadata/,
  );

  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, appId: 'other-app' }), 'utf8');
  await assert.rejects(
    manager.restoreBackupDirectory({ appId: 'demo-app', backupDir }),
    /remote_backup_app_mismatch/,
  );

  await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
  let remoteCalls = 0;
  const missingDuringRemotePreRestore = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: (appId) => (appId === 'demo-app' && ++remoteCalls === 1 ? appRecord : undefined),
    isAppRunning: () => false,
  });
  const remotePreRestore = await missingDuringRemotePreRestore.restoreBackupDirectory({ appId: 'demo-app', backupDir });
  assert.equal(remotePreRestore.success, false);
  assert.equal(remotePreRestore.technicalCode, 'app_not_installed');

  await fs.writeFile(metadataPath, JSON.stringify({
    ...metadata,
    files: [{ ...metadata.files[0], backupRelativePath: path.join(root, 'outside-copy') }],
  }), 'utf8');
  await assert.rejects(
    manager.restoreBackupDirectory({ appId: 'demo-app', backupDir }),
    /unsafe_backup_file_path/,
  );
});

test('BackupsManager handles apps without data files and ignores runtime-only filesystem entries', async (t) => {
  const root = await tmpRoot('backups-empty');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'empty-app');
  await fs.mkdir(path.join(installDir, 'backend', 'data', '.git'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'backend', 'data', '.DS_Store'), 'metadata', 'utf8');
  await fs.writeFile(path.join(installDir, 'backend', 'data', '.gitkeep'), '', 'utf8');
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({ services: [{ volumes: [{ source: './backend/data/', persist: true }] }] }), 'utf8');
  const appRecord = { appId: 'empty-app', name: 'Empty App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot: path.join(root, 'metadata', 'backups'),
    listInstalledApps: () => [appRecord],
    getInstalledApp: () => appRecord,
    isAppRunning: () => false,
  });

  const created = await manager.createBackup({ appId: 'empty-app' });
  assert.equal(created.success, true);
  assert.equal(created.backup.fileCount, 0);
  assert.match(created.userMessage, /sin archivos/);
  assert.deepEqual(await manager.listBackups('missing-app'), []);

  const noManifestRecord = { appId: 'no-manifest', name: 'No Manifest', version: '1.0.0', installDir: path.join(root, 'apps', 'no-manifest') };
  await fs.mkdir(noManifestRecord.installDir, { recursive: true });
  const noManifestManager = new BackupsManager({
    backupsRoot: path.join(root, 'metadata', 'backups'),
    listInstalledApps: () => [noManifestRecord],
    getInstalledApp: () => noManifestRecord,
    isAppRunning: () => false,
  });
  assert.equal((await noManifestManager.createBackup({ appId: 'no-manifest' })).backup.fileCount, 0);
});

test('BackupsManager handles malformed manifests, app-running remote restore, and missing pre-restore records', async (t) => {
  const root = await tmpRoot('backups-extra-edges');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'metadata', 'backups');
  await fs.mkdir(path.join(installDir, 'backend', 'data'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'db', 'utf8');
  await fs.writeFile(path.join(installDir, 'manifest.json'), '{bad json', 'utf8');
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: (appId) => (appId === 'demo-app' ? appRecord : undefined),
    isAppRunning: () => false,
  });
  await fs.mkdir(path.join(backupsRoot, 'demo-app'), { recursive: true });
  await fs.writeFile(path.join(backupsRoot, 'demo-app', 'not-a-backup.txt'), 'ignore', 'utf8');

  const created = await manager.createBackup({ appId: 'demo-app' });
  assert.equal(created.success, true);
  assert.deepEqual(created.backup.files.map((file) => file.sourceRelativePath), ['backend/data/app.sqlite3']);
  assert.equal((await manager.listBackups('demo-app')).length, 1);

  const runningManager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: () => appRecord,
    isAppRunning: () => true,
  });
  assert.equal((await runningManager.restoreBackupDirectory({
    appId: 'demo-app',
    backupDir: manager.backupDirectory('demo-app', created.backup.backupId),
  })).technicalCode, 'app_running');

  const missingDuringPreRestore = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: (appId) => (appId === 'demo-app' ? appRecord : undefined),
    isAppRunning: () => false,
  });
  let calls = 0;
  missingDuringPreRestore.getInstalledApp = () => (++calls === 1 ? appRecord : undefined);
  const restored = await missingDuringPreRestore.restoreBackup({
    appId: 'demo-app',
    backupId: created.backup.backupId,
  });
  assert.equal(restored.success, false);
  assert.equal(restored.technicalCode, 'app_not_installed');
});

test('BackupsManager covers unsafe restore metadata, skipped paths, and non-file backup entries', async (t) => {
  const root = await tmpRoot('backups-fourth-wave');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'metadata', 'backups');
  const events = [];
  await fs.mkdir(path.join(installDir, 'backend', 'data'), { recursive: true });
  await fs.writeFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'db', 'utf8');
  await fs.writeFile(path.join(installDir, 'outside-source.txt'), 'skip me', 'utf8');
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    services: [
      {
        volumes: [
          { source: '/outside-root', persist: true },
          { source: 'backend/data', persist: true },
        ],
      },
    ],
  }), 'utf8');
  const fifoPath = path.join(installDir, 'backend', 'data', 'runtime.pipe');
  await execFileAsync('mkfifo', [fifoPath]);
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: (appId) => (appId === 'demo-app' ? appRecord : undefined),
    isAppRunning: () => false,
    log: async (event, payload) => events.push([event, payload]),
  });

  const originalCollectPersistentFiles = manager.collectPersistentFiles.bind(manager);
  manager.collectPersistentFiles = async (record) => [
    path.join(root, 'outside-source.txt'),
    ...await originalCollectPersistentFiles(record),
  ];
  const created = await manager.createBackup({ appId: 'demo-app' });
  assert.equal(created.success, true);
  assert.deepEqual(created.backup.files.map((file) => file.sourceRelativePath), ['backend/data/app.sqlite3']);

  await fs.writeFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'changed', 'utf8');
  const restored = await manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId });
  assert.equal(restored.success, true);
  assert.equal(await fs.readFile(path.join(installDir, 'backend', 'data', 'app.sqlite3'), 'utf8'), 'db');
  assert.ok(events.some(([event]) => event === 'backup:restored'));

  await assert.rejects(
    () => manager.restoreBackup({ appId: 'demo-app', backupId: '../bad' }),
    /invalid_backup_id/,
  );

  const backupDir = manager.backupDirectory('demo-app', created.backup.backupId);
  const metadataPath = path.join(backupDir, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  await fs.writeFile(metadataPath, JSON.stringify({
    ...metadata,
    files: [{ ...metadata.files[0], sourceRelativePath: '../escape' }],
  }), 'utf8');
  await assert.rejects(
    () => manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId }),
    /invalid_backup_metadata_path/,
  );

  await fs.writeFile(metadataPath, JSON.stringify({
    ...metadata,
    files: [{ ...metadata.files[0], sourceRelativePath: path.join(root, 'outside-target.sqlite') }],
  }), 'utf8');
  await assert.rejects(
    () => manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId }),
    /unsafe_backup_restore_path/,
  );

  await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
  const backedUpFile = path.join(backupDir, metadata.files[0].backupRelativePath);
  await fs.rm(backedUpFile, { force: true });
  await fs.mkdir(backedUpFile, { recursive: true });
  await assert.rejects(
    () => manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId }),
    /backup_file_mismatch/,
  );

  await fs.rm(backedUpFile, { recursive: true, force: true });
  await fs.writeFile(backedUpFile, 'db', 'utf8');
  await fs.writeFile(metadataPath, JSON.stringify({
    ...metadata,
    files: [{ ...metadata.files[0], sourceRelativePath: '../escape' }],
  }), 'utf8');
  await assert.rejects(
    () => manager.restoreBackupDirectory({ appId: 'demo-app', backupDir }),
    /invalid_backup_metadata_path/,
  );

  await fs.writeFile(metadataPath, JSON.stringify({
    ...metadata,
    files: [{ ...metadata.files[0], sourceRelativePath: path.join(root, 'outside-target.sqlite') }],
  }), 'utf8');
  await assert.rejects(
    () => manager.restoreBackupDirectory({ appId: 'demo-app', backupDir }),
    /unsafe_backup_restore_path/,
  );
});

test('FileLibrary imports, stages, moves, and discards files inside temp roots only', async (t) => {
  const root = await tmpRoot('file-library');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataRoot = path.join(root, 'data');
  const metadataRoot = path.join(root, 'metadata');
  const source = path.join(root, 'source.csv');
  const outside = path.join(root, 'outside.png');
  await fs.writeFile(source, 'a,b\n1,2\n', 'utf8');
  await fs.writeFile(outside, 'keep', 'utf8');
  const library = new FileLibrary(dataRoot, metadataRoot);

  const category = await library.createCategory({ name: 'Finance Reports' });
  const imported = await library.importFiles({ appId: 'demo-app', sourcePaths: [source], categoryPath: category.path });
  const staged = await library.stageFileForChat({
    name: '../paste',
    mimeType: 'image/png',
    dataBase64: Buffer.from('png-bytes').toString('base64'),
  });
  await library.discardStagedFilesForChat({ sourcePaths: [staged.sourcePath, outside] });
  const moved = await library.moveFiles({ fileIds: [imported[0].id], categoryPath: '' });

  assert.equal(category.path, 'Finance Reports');
  assert.equal(imported.length, 1);
  assert.equal(imported[0].relativePath, 'Finance Reports/source.csv');
  assert.equal(moved[0].relativePath, 'source.csv');
  assert.equal(await fs.stat(staged.sourcePath).catch(() => null), null);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
  assert.equal((await library.list({ type: 'spreadsheet' })).length, 1);
});

test('FileLibrary handles category, rename, query, delete, and staged cleanup edge paths', async (t) => {
  const root = await tmpRoot('file-library-lifecycle');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataRoot = path.join(root, 'data');
  const metadataRoot = path.join(root, 'metadata');
  const indexPath = path.join(metadataRoot, 'files', 'index.json');
  const source = path.join(root, 'report.csv');
  const secondSource = path.join(root, 'notes.txt');
  await fs.writeFile(source, 'a,b\n1,2\n', 'utf8');
  await fs.writeFile(secondSource, 'hello', 'utf8');
  const library = new FileLibrary(dataRoot, metadataRoot);

  await assert.rejects(
    library.stageFileForChat({ name: 'bad', mimeType: 'text/plain', dataBase64: Buffer.from('x').toString('base64') }),
    /unsupported_chat_image_type/,
  );
  await assert.rejects(
    library.stageFileForChat({ name: 'huge', mimeType: 'image/png', dataBase64: Buffer.alloc((20 * 1024 * 1024) + 1).toString('base64') }),
    /chat_image_too_large/,
  );
  await assert.rejects(
    library.stageFileForChat({ mimeType: ' IMAGE/PNG ', dataBase64: '' }),
    /chat_image_too_large/,
  );
  await assert.rejects(
    library.createCategory({ name: '...' }),
    /invalid_category_name/,
  );

  const category = await library.createCategory({ name: 'Reports' });
  const imported = await library.importFiles({ appId: 'demo-app', sourcePaths: [source, path.join(root, 'missing.csv'), dataRoot], categoryPath: category.path });
  const rootImported = await library.importFiles({ appId: 'demo-app', sourcePaths: [secondSource], categoryPath: '' });
  const ignoredMove = await library.moveFiles({ fileIds: ['missing-id'], categoryPath: '' });
  assert.deepEqual(ignoredMove, []);
  const picked = await library.pickFileInfo([source, path.join(root, 'missing.csv'), dataRoot]);
  assert.deepEqual(picked.map((file) => file.name), ['report.csv']);
  assert.deepEqual((await library.listCategories()).map((item) => item.path), ['Reports']);
  assert.deepEqual((await library.list({ query: 'report' })).map((file) => file.name), ['report.csv']);
  assert.deepEqual((await library.list({ categoryPath: '__root' })).map((file) => file.name), ['notes.txt']);
  assert.deepEqual(await library.list({ categoryPath: 'Other' }), []);
  assert.deepEqual(await library.list({ type: 'pdf' }), []);
  assert.deepEqual((await library.list({ sortBy: 'sizeBytes', sortDirection: 'asc' })).map((file) => file.name), ['notes.txt', 'report.csv']);

  const selected = await library.getFilesByIds([imported[0].id, 'missing'], 'mentioned');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].source, 'mentioned');
  assert.equal(selected[0].absolutePath.endsWith(path.join('Reports', 'report.csv')), true);

  const nonEmptyDelete = await library.deleteCategory({ categoryPath: category.path, mode: 'emptyOnly' });
  assert.equal(nonEmptyDelete.success, false);
  assert.equal(nonEmptyDelete.technicalCode, 'category_not_empty');

  await fs.rm(await selected[0].absolutePath, { force: true });
  const staleDelete = await library.deleteCategory({ categoryPath: category.path, mode: 'emptyOnly' });
  assert.equal(staleDelete.success, true);
  await fs.mkdir(path.join(dataRoot, 'Reports'), { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'Reports', '.DS_Store'), 'drop', 'utf8');
  await fs.writeFile(path.join(dataRoot, 'Reports', 'untracked.txt'), 'user file', 'utf8');
  const indexedWithRootFile = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  await fs.writeFile(indexPath, JSON.stringify({
    ...indexedWithRootFile,
    files: [...indexedWithRootFile.files, {
      id: 'stale',
      name: 'stale.csv',
      relativePath: 'Reports/stale.csv',
      categoryPath: 'Reports',
      sizeBytes: 1,
      uploadedAt: '2026-05-21T00:00:00.000Z',
      modifiedAt: '2026-05-21T00:00:00.000Z',
      type: 'spreadsheet',
      appId: 'demo-app',
    }],
  }), 'utf8');
  const untrackedDelete = await library.deleteCategory({ categoryPath: 'Reports', mode: 'emptyOnly' });
  assert.equal(untrackedDelete.technicalCode, 'category_not_empty');
  assert.deepEqual(JSON.parse(await fs.readFile(indexPath, 'utf8')).files.map((file) => file.relativePath), ['notes.txt']);

  await fs.rm(path.join(dataRoot, 'Reports', 'untracked.txt'), { force: true });
  const importedAgain = await library.importFiles({ appId: 'demo-app', sourcePaths: [source], categoryPath: category.path });
  const indexedBeforeRename = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  await fs.writeFile(indexPath, JSON.stringify({
    ...indexedBeforeRename,
    categories: [
      { path: 'Reports', name: 'Reports', parentPath: '', createdAt: '2026-05-21T00:00:00.000Z', modifiedAt: '2026-05-21T00:00:00.000Z' },
      { path: 'Reports/Old', name: 'Old', parentPath: 'Reports', createdAt: '2026-05-21T00:00:00.000Z', modifiedAt: '2026-05-21T00:00:00.000Z' },
      { path: 'Reports/Old', name: 'Duplicate', parentPath: 'Reports', createdAt: '2026-05-21T00:00:00.000Z', modifiedAt: '2026-05-21T00:00:00.000Z' },
    ],
  }), 'utf8');
  const renamedCategory = await library.renameCategory({ categoryPath: category.path, newName: 'Archive' });
  assert.equal(renamedCategory.success, true);
  const indexedAfterRename = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  assert.deepEqual(indexedAfterRename.categories.map((item) => item.path), ['Archive', 'Archive/Old']);
  const renamedFile = await library.renameFile({ fileId: importedAgain[0].id, name: 'year-end' });
  assert.equal(renamedFile.name, 'year-end.csv');
  assert.equal(renamedFile.relativePath, 'Archive/year-end.csv');
  await assert.rejects(library.renameFile({ fileId: 'missing', name: 'nope' }), /file_not_found/);

  await library.deleteFiles({ fileIds: [importedAgain[0].id, rootImported[0].id] });
  assert.deepEqual(await library.list(), []);
  assert.equal((await library.renameCategory({ categoryPath: 'Archive', newName: '...' })).technicalCode, 'invalid_category');
  assert.equal((await library.deleteCategory({ categoryPath: '', mode: 'emptyOnly' })).technicalCode, 'invalid_category');
  const emptyDelete = await library.deleteCategory({ categoryPath: 'Archive', mode: 'emptyOnly' });
  assert.equal(emptyDelete.success, true);
  assert.equal((await library.deleteCategory({ categoryPath: 'Archive', mode: 'recursive' })).technicalCode, 'invalid_category');

  const extImport = await library.importFiles({ appId: 'demo-app', sourcePaths: [secondSource], categoryPath: '' });
  const renamedWithExt = await library.renameFile({ fileId: extImport[0].id, name: 'notes-renamed.md' });
  assert.equal(renamedWithExt.name, 'notes-renamed.md');
  assert.equal(renamedWithExt.categoryPath, '');
  await library.deleteFiles({ fileIds: [renamedWithExt.id] });

  const staged = await library.stageFileForChat({
    name: 'old paste',
    mimeType: 'image/png',
    dataBase64: Buffer.from('png-bytes').toString('base64'),
  });
  const unnamed = await library.stageFileForChat({
    mimeType: 'image/webp',
    dataBase64: Buffer.from('webp-bytes').toString('base64'),
  });
  assert.ok(unnamed.name.endsWith('imagen pegada.webp'));
  const staleTime = new Date(Date.now() - 10_000);
  await fs.utimes(staged.sourcePath, staleTime, staleTime);
  await fs.utimes(unnamed.sourcePath, staleTime, staleTime);
  await fs.mkdir(path.join(metadataRoot, 'files', 'chat-staging', 'nested'), { recursive: true });
  await library.cleanupStagedFilesForChat(1);
  assert.equal(await fs.stat(staged.sourcePath).catch(() => null), null);
  assert.equal(await fs.stat(unnamed.sourcePath).catch(() => null), null);
  assert.ok(await fs.stat(path.join(metadataRoot, 'files', 'chat-staging', 'nested')));
});

test('FileLibrary recovers malformed indexes, ignores nested categories, and resolves duplicate names', async (t) => {
  const root = await tmpRoot('file-library-index');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataRoot = path.join(root, 'data');
  const metadataRoot = path.join(root, 'metadata');
  await fs.mkdir(path.join(metadataRoot, 'files'), { recursive: true });
  await fs.writeFile(path.join(metadataRoot, 'files', 'index.json'), '{bad json', 'utf8');
  await fs.mkdir(path.join(dataRoot, 'Top', 'Nested'), { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'Top', 'Nested', 'deep.txt'), 'deep', 'utf8');
  await fs.symlink(path.join(root, 'report.csv'), path.join(dataRoot, 'Top', 'linked-report.csv'));
  const source = path.join(root, 'report.csv');
  const emptyNameSource = path.join(root, '...');
  await fs.writeFile(source, 'a,b\n1,2\n', 'utf8');
  await fs.writeFile(emptyNameSource, 'empty name', 'utf8');
  const library = new FileLibrary(dataRoot, metadataRoot);

  assert.deepEqual((await library.listCategories()).map((category) => category.path), ['Top']);
  const imported = await library.importFiles({ appId: 'demo-app', sourcePaths: [source, source, emptyNameSource], categoryPath: 'Top' });

  assert.deepEqual(imported.map((file) => file.relativePath), ['Top/report.csv', 'Top/report (2).csv', 'Top/archivo']);
  assert.deepEqual((await library.list({ categoryPath: 'Top', sortBy: 'name', sortDirection: 'asc' })).map((file) => file.name), [
    'archivo',
    'report 2.csv',
    'report.csv',
  ]);

  await fs.writeFile(path.join(metadataRoot, 'files', 'index.json'), JSON.stringify({ files: {}, categories: 'bad' }), 'utf8');
  assert.equal((await library.list()).length, 3);
});

test('FileLibrary tolerates files disappearing while scanning disk', async (t) => {
  const root = await tmpRoot('file-library-scan-race');
  const originalStat = fs.stat;
  t.after(async () => {
    fs.stat = originalStat;
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataRoot = path.join(root, 'data');
  const metadataRoot = path.join(root, 'metadata');
  const vanishing = path.join(dataRoot, 'vanishing.txt');
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(vanishing, 'gone', 'utf8');
  fs.stat = async (target, options) => {
    if (String(target).endsWith('vanishing.txt')) {
      throw new Error('file disappeared');
    }
    return await originalStat(target, options);
  };

  const library = new FileLibrary(dataRoot, metadataRoot);

  const resolvedMissingParent = await library.resolveDataPath('Missing Parent/file.txt');
  assert.equal(path.basename(resolvedMissingParent), 'file.txt');
  assert.equal(await fs.realpath(path.dirname(resolvedMissingParent)), await fs.realpath(path.join(dataRoot, 'Missing Parent')));
  assert.deepEqual(await library.list(), []);
});

test('FileLibrary rejects category symlink escapes before importing or moving files outside the data root', async (t) => {
  const root = await tmpRoot('file-library-symlink');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataRoot = path.join(root, 'data');
  const metadataRoot = path.join(root, 'metadata');
  const outsideRoot = path.join(root, 'outside');
  const source = path.join(root, 'source.csv');
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.symlink(outsideRoot, path.join(dataRoot, 'Linked'));
  await fs.writeFile(source, 'a,b\n1,2\n', 'utf8');
  const library = new FileLibrary(dataRoot, metadataRoot);

  await assert.rejects(
    library.importFiles({ appId: 'demo-app', sourcePaths: [source], categoryPath: 'Linked' }),
    /path_outside_data_root/,
  );
  assert.deepEqual(await fs.readdir(outsideRoot), []);
});

test('SecretsStore stores user secrets, resolves manifest env names, and reports missing required app secrets', async (t) => {
  const root = await tmpRoot('secrets');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new SecretsStore(root);
  assert.equal(appSecretEnvName('OpenAI API key'), 'OPENAI_API_KEY');
  assert.equal(appSecretEnvName('!!!'), '');

  const created = await store.createUserSecret({ name: 'Primary token', value: 'secret-value' });
  assert.equal(created.success, true);
  const [secret] = await store.listUserSecrets();
  await store.connectAppSecret('demo-app', 'OpenAI API key', secret.id);

  const resolved = await store.resolveAppEnv('demo-app', [
    { name: 'OpenAI API key', label: 'OpenAI key', required: true },
    { name: 'Anthropic key', label: 'Claude key', required: true },
  ]);

  assert.deepEqual(resolved.env, { OPENAI_API_KEY: 'secret-value' });
  assert.deepEqual(resolved.secretValues, ['secret-value']);
  assert.deepEqual(resolved.missingRequired.map((secretDeclaration) => secretDeclaration.name), ['Anthropic key']);
});

test('SecretsStore validates mutations, cleans mappings, handles tool secrets, and reports vault/encryption failures', async (t) => {
  const root = await tmpRoot('secrets-mutations');
  t.after(async () => {
    electronSafeStorage.isEncryptionAvailable = originalEncryptionAvailable;
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new SecretsStore(root);

  assert.equal((await store.createUserSecret({ name: ' ', value: 'x' })).technicalCode, 'secret_name_required');
  assert.equal((await store.createUserSecret({ name: 'Token', value: '' })).technicalCode, 'secret_value_required');
  const created = await store.createUserSecret({ name: 'Token', value: 'first' });
  const [secret] = await store.listUserSecrets();
  assert.equal(created.success, true);
  assert.equal((await store.updateUserSecret({ id: 'missing', name: 'Token', value: 'x' })).technicalCode, 'secret_not_found');
  assert.equal((await store.updateUserSecret({ id: secret.id, name: '', value: 'x' })).technicalCode, 'secret_name_required');
  assert.equal((await store.updateUserSecret({ id: secret.id, name: 'Token 2', value: '' })).technicalCode, 'secret_value_required');
  assert.equal((await store.updateUserSecret({ id: secret.id, name: 'Token 2', value: 'second' })).success, true);
  assert.equal((await store.listUserSecrets())[0].name, 'Token 2');
  assert.equal((await store.deleteUserSecret('missing')).technicalCode, 'secret_not_found');
  assert.equal((await store.connectAppSecret('demo-app', 'API key', 'missing')).technicalCode, 'secret_not_found');
  assert.equal((await store.connectAppSecret('', 'API key', secret.id)).technicalCode, 'invalid_app_secret_mapping');

  await store.connectAppSecret('demo-app', 'API key', secret.id);
  await store.connectAppSecret('demo-app', 'Secondary key', secret.id);
  assert.equal(await store.getMappedSecretId('demo-app', 'API key'), secret.id);
  await store.disconnectAppSecret('demo-app', 'API key');
  assert.equal(await store.getMappedSecretId('demo-app', 'API key'), undefined);
  assert.equal((await store.disconnectAppSecret('demo-app', 'Missing key')).success, true);
  assert.equal((await store.disconnectAppSecret('missing-app', 'Missing key')).success, true);
  await store.connectAppSecret('demo-app', 'API key', secret.id);
  assert.equal((await store.deleteUserSecret(secret.id)).success, true);
  assert.equal(await store.getMappedSecretId('demo-app', 'API key'), undefined);

  assert.equal((await store.setToolSecret('', 'token', 'x')).technicalCode, 'invalid_tool_secret');
  assert.equal((await store.setToolSecret('gmail', 'token', '')).technicalCode, 'invalid_tool_secret');
  assert.equal((await store.setToolSecret('gmail', 'token', 'tool-secret')).success, true);
  assert.equal(await store.hasToolSecret('gmail', 'token'), true);
  assert.equal(await store.getToolSecret('gmail', 'token'), 'tool-secret');
  assert.equal(await store.getToolSecret('gmail', 'missing'), null);
  assert.equal((await store.deleteToolSecrets('gmail')).success, true);
  assert.equal(await store.hasToolSecret('gmail', 'token'), false);

  electronSafeStorage.isEncryptionAvailable = () => false;
  const unavailableStore = new SecretsStore(path.join(root, 'unavailable'));
  assert.equal((await unavailableStore.createUserSecret({ name: 'Token', value: 'secret' })).technicalCode, 'secrets_encryption_unavailable');

  const invalidRoot = path.join(root, 'invalid-vault');
  await fs.mkdir(invalidRoot, { recursive: true });
  await fs.writeFile(path.join(invalidRoot, 'secrets.vault.json'), '{not-json', 'utf8');
  const invalidStore = new SecretsStore(invalidRoot);
  await assert.rejects(invalidStore.listUserSecrets(), /secrets_vault_invalid/);
  assert.equal((await invalidStore.createUserSecret({ name: 'Token', value: 'secret' })).technicalCode, 'secrets_vault_unavailable');
  assert.equal((await invalidStore.updateUserSecret({ id: 'missing', name: 'Token' })).technicalCode, 'secrets_vault_unavailable');
  assert.equal((await invalidStore.deleteUserSecret('missing')).technicalCode, 'secrets_vault_unavailable');
  assert.equal((await invalidStore.connectAppSecret('demo-app', 'API key', 'missing')).technicalCode, 'secrets_vault_unavailable');
  assert.equal((await invalidStore.disconnectAppSecret('demo-app', 'API key')).technicalCode, 'secrets_vault_unavailable');
  assert.equal((await invalidStore.deleteToolSecrets('gmail')).technicalCode, 'secrets_vault_unavailable');
});

test('SecretsStore preserves legacy vaults, reports unsupported algorithms, and handles cached loads', async (t) => {
  const root = await tmpRoot('secrets-legacy');
  t.after(async () => {
    electronSafeStorage.isEncryptionAvailable = originalEncryptionAvailable;
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new SecretsStore(root);
  assert.deepEqual(await store.listUserSecrets(), []);
  const created = await store.createUserSecret({ name: 'Token', value: 'first' });
  assert.equal(created.success, true);
  const [secret] = await store.listUserSecrets();
  assert.equal((await store.updateUserSecret({ id: secret.id, name: 'Renamed' })).success, true);
  assert.equal((await store.setToolSecret('gmail', 'token', 'tool-secret')).success, true);

  const vaultPath = path.join(root, 'secrets.vault.json');
  const vault = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
  delete vault.toolSecrets;
  await fs.writeFile(vaultPath, JSON.stringify(vault), 'utf8');
  const legacyStore = new SecretsStore(root);
  assert.equal(await legacyStore.getToolSecret('gmail', 'token'), null);

  vault.toolSecrets = {
    gmail: {
      token: { algorithm: 'other', ciphertext: Buffer.from('sealed:x').toString('base64') },
    },
  };
  vault.secrets[secret.id].encryptedValue = { algorithm: 'other', ciphertext: Buffer.from('sealed:first').toString('base64') };
  vault.appMappings = {
    'demo-app': {
      Unsupported: secret.id,
    },
  };
  await fs.writeFile(vaultPath, JSON.stringify(vault), 'utf8');
  const unsupportedStore = new SecretsStore(root);
  await assert.rejects(unsupportedStore.getToolSecret('gmail', 'token'), /secrets_vault_unsupported_algorithm/);
  await assert.rejects(
    unsupportedStore.resolveAppEnv('demo-app', [{ name: 'Unsupported', required: true }]),
    /secrets_vault_unsupported_algorithm/,
  );

  electronSafeStorage.isEncryptionAvailable = () => false;
  assert.equal((await unsupportedStore.setToolSecret('gmail', 'token', 'x')).technicalCode, 'secrets_encryption_unavailable');
  assert.deepEqual(await unsupportedStore.resolveAppEnv('demo-app', [{ name: 'Missing', required: false }]), {
    env: {},
    missingRequired: [],
    secretValues: [],
  });
});

test('SecretsStore handles invalid vault shapes, read failures, non-string names, and optional encrypted misses', async (t) => {
  const root = await tmpRoot('secrets-extra-edges');
  t.after(async () => {
    electronSafeStorage.isEncryptionAvailable = originalEncryptionAvailable;
    await fs.rm(root, { recursive: true, force: true });
  });

  const invalidShapeRoot = path.join(root, 'invalid-shape');
  await fs.mkdir(invalidShapeRoot, { recursive: true });
  await fs.writeFile(path.join(invalidShapeRoot, 'secrets.vault.json'), JSON.stringify([]), 'utf8');
  const invalidShapeStore = new SecretsStore(invalidShapeRoot);
  await assert.rejects(invalidShapeStore.listUserSecrets(), /secrets_vault_invalid/);

  const unreadablePath = path.join(root, 'not-a-directory');
  await fs.writeFile(unreadablePath, 'file', 'utf8');
  const unavailableStore = new SecretsStore(unreadablePath);
  assert.equal((await unavailableStore.createUserSecret({ name: 'Token', value: 'secret' })).technicalCode, 'secrets_vault_unavailable');

  const failingStore = new SecretsStore(path.join(root, 'failing'));
  failingStore.load = async () => {
    throw new Error('unexpected_disk_failure');
  };
  await assert.rejects(
    failingStore.createUserSecret({ name: 'Token', value: 'secret' }),
    /unexpected_disk_failure/,
  );

  const store = new SecretsStore(path.join(root, 'valid'));
  assert.equal(appSecretEnvName('  weird secret name!!!  '), 'WEIRD_SECRET_NAME');
  assert.equal((await store.createUserSecret({ name: 123, value: 'x' })).technicalCode, 'secret_name_required');
  const created = await store.createUserSecret({ name: 'Token', value: 'first' });
  assert.equal(created.success, true);
  const [secret] = await store.listUserSecrets();
  assert.equal((await store.updateUserSecret({ id: secret.id, name: 'Token Renamed' })).success, true);
  assert.equal((await store.connectAppSecret('demo-app', 123, secret.id)).technicalCode, 'invalid_app_secret_mapping');
  assert.equal((await store.setToolSecret('gmail', '', 'x')).technicalCode, 'invalid_tool_secret');

  await store.connectAppSecret('demo-app', 'Optional key', secret.id);
  electronSafeStorage.isEncryptionAvailable = () => false;
  assert.deepEqual(await store.resolveAppEnv('demo-app', [{ name: 'Optional key', required: true }]), {
    env: {},
    missingRequired: [{ name: 'Optional key', required: true }],
    secretValues: [],
  });
  assert.deepEqual(await store.resolveAppEnv('demo-app', [{ name: 'Optional key', required: false }]), {
    env: {},
    missingRequired: [],
    secretValues: [],
  });
});

test('ForgerAccountStore normalizes persisted sessions and exposes only public account state', async (t) => {
  const root = await tmpRoot('account-store');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new ForgerAccountStore(path.join(root, 'account.json'));

  assert.deepEqual(await store.load(), { authenticated: false });
  assert.equal(normalizeForgerAccountUser({ id: 'bad', email: 'person@example.com' }), undefined);
  assert.equal(normalizeForgerAccountUser({ id: 1, email: '' }), undefined);

  await store.save({
    authenticated: true,
    confirmationRequired: true,
    token: 'secret-token',
    user: {
      id: '7',
      email: 'person@example.com',
      username: 'person',
      first_name: 'Ada',
      lastName: 'Lovelace',
      confirmed: true,
      subscription_tier: 'demo',
      username_changed_at: '2026-05-01T00:00:00Z',
      usernameChangeAvailableAt: '2026-05-31T00:00:00Z',
    },
  });

  const loaded = await store.load();
  assert.equal(loaded.authenticated, true);
  assert.equal(loaded.confirmationRequired, true);
  assert.equal(loaded.user.firstName, 'Ada');
  assert.equal(loaded.user.lastName, 'Lovelace');
  assert.equal(loaded.user.subscriptionTier, 'demo');
  assert.deepEqual(publicForgerAccount(loaded), {
    authenticated: true,
    confirmationRequired: true,
    user: loaded.user,
  });
  assert.equal(publicForgerAccount({ authenticated: true, user: loaded.user }).authenticated, false);

  await store.clear();
  assert.deepEqual(await store.load(), { authenticated: false });
});

test('OfficialToolsService persists app grants and keeps unavailable Gmail actions safe', async (t) => {
  const root = await tmpRoot('official-tools');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const secretsStore = new SecretsStore(root);
  const declarations = normalizeAppToolDeclarations({
    required: [
      { toolId: 'gmail', reason: 'Necesita leer correo', actions: ['gmail.search_messages', 'gmail.connection.status', '', 7] },
      { toolId: 'gmail', reason: 'Duplicado ignorado', actions: ['gmail.send_email'] },
    ],
    optional: [
      { toolId: 'gmail', reason: 'Puede enviar correo', actions: ['gmail.send_email'] },
      { toolId: '', reason: 'Sin herramienta', actions: ['gmail.send_email'] },
      { toolId: 'gmail', reason: '', actions: ['gmail.send_email'] },
    ],
  });
  assert.deepEqual(declarations.required, [{
    toolId: 'gmail',
    reason: 'Necesita leer correo',
    actions: ['gmail.search_messages', 'gmail.connection.status'],
  }]);

  const service = new OfficialToolsService({
    metadataRoot: root,
    secretsStore,
    getFreePort: async () => 1234,
    openExternalUrl: async () => {
      throw new Error('browser_blocked');
    },
    isForgerAccountAuthenticated: () => false,
    getGmailOAuthClientId: async () => 'gmail-client',
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
    getAppToolDeclarations: async (appId) => {
      if (appId === 'finance-os') {
        return {
          appName: 'Finance OS',
          required: declarations.required,
          optional: [],
          agents: [{ id: 'assistant', title: 'Assistant', initialPrompt: 'Help' }],
          promptTemplates: [{ id: 'review', title: 'Review', prompt: 'Review data' }],
        };
      }
      if (appId === 'mailer') {
        return {
          appName: 'Mailer',
          required: [],
          optional: declarations.optional,
          agents: [],
          promptTemplates: [],
        };
      }
      return null;
    },
  });

  assert.equal((await service.activate('missing-tool')).technicalCode, 'tool_not_found');
  assert.equal((await service.configure({ toolId: 'missing-tool' })).technicalCode, 'tool_not_found');
  assert.equal(await service.getInstallGate('missing-app'), null);
  assert.equal((await service.callFromAgent({
    toolId: 'missing-tool',
    actionId: 'missing.action',
  })).technicalCode, 'tool_not_found');
  assert.equal((await service.callFromAgent({
    toolId: 'gmail',
    actionId: 'gmail.search_messages',
  })).technicalCode, 'tool_not_active');
  assert.equal((await service.callFromAgent({
    toolId: 'gmail',
    actionId: 'gmail.search_messages',
  }, { requireAppGrant: true })).technicalCode, 'app_tools_not_declared');
  assert.equal((await service.callFromAgent({
    toolId: 'gmail',
    actionId: 'gmail.search_messages',
  }, { requireAppGrant: true, appId: 'missing-app' })).technicalCode, 'app_tools_not_declared');
  assert.equal((await service.callFromAgent({
    toolId: 'gmail',
    actionId: 'gmail.search_messages',
  }, { requireAppGrant: true, appId: 'mailer' })).technicalCode, 'app_tool_permission_denied');
  assert.equal((await service.callFromAgent({
    toolId: 'gmail',
    actionId: 'gmail.read_thread',
  }, { requireAppGrant: true, appId: 'finance-os' })).technicalCode, 'app_tool_action_not_declared');
  assert.equal((await service.callFromAgent({
    toolId: 'missing-tool',
    actionId: 'missing.action',
  }, { requireAppGrant: true, appId: 'finance-os' })).technicalCode, 'app_tool_not_declared');

  const activated = await service.activate('gmail', 'en');
  assert.equal(activated.success, true);
  assert.equal(activated.tool.status, 'installed');

  const requiredGate = await service.getInstallGate('finance-os', 'en');
  assert.equal(requiredGate.required[0].available, true);
  assert.equal(requiredGate.required[0].configured, false);
  assert.equal(requiredGate.canInstall, false);
  assert.deepEqual(requiredGate.agents.map((agent) => agent.id), ['assistant']);
  assert.deepEqual([...await service.listAgentActionIdsForApp('finance-os')], ['gmail.search_messages', 'gmail.connection.status']);

  const optionalBeforeGrant = await service.getInstallGate('mailer');
  assert.equal(optionalBeforeGrant.optional[0].granted, false);
  assert.deepEqual(await service.listToolsForApp('mailer'), []);
  await service.setAppToolGrant({ appId: 'mailer', toolId: 'gmail', granted: true });
  assert.equal((await service.getInstallGate('mailer')).optional[0].granted, true);
  assert.deepEqual((await service.listToolsForApp('mailer')).map((tool) => tool.id), ['gmail']);

  const status = await service.callFromApp('finance-os', {
    toolId: 'gmail',
    actionId: 'gmail.connection.status',
  });
  assert.deepEqual(status, { success: true, data: { connected: false } });
  assert.equal((await service.callFromApp('finance-os', {
    toolId: 'gmail',
    actionId: 'gmail.send_email',
  })).technicalCode, 'app_tool_action_not_declared');
  assert.equal((await service.callFromApp('unknown-app', {
    toolId: 'gmail',
    actionId: 'gmail.connection.status',
  })).technicalCode, 'app_tools_not_declared');
  assert.equal((await service.callFromAgent({
    toolId: 'gmail',
    actionId: 'gmail.search_messages',
    input: { query: 'from:bank' },
  })).technicalCode, 'tool_not_configured');
  assert.equal((await service.callFromApp('mailer', {
    toolId: 'gmail',
    actionId: 'gmail.send_email',
  })).technicalCode, 'tool_not_configured');

  const configured = await service.configure({ toolId: 'gmail', locale: 'es' });
  assert.equal(configured.success, false);
  assert.equal(configured.technicalCode, 'forger_account_required');
  assert.equal((await service.getTool('gmail')).status, 'error');
  assert.equal((await service.callFromAgent({
    toolId: 'gmail',
    actionId: 'gmail.search_messages',
  })).technicalCode, 'tool_configuration_error');
  assert.equal((await service.deactivate('missing-tool')).technicalCode, 'tool_not_found');

  const deactivated = await service.deactivate('gmail', { keepSecrets: true });
  assert.equal(deactivated.success, true);
  const registry = JSON.parse(await fs.readFile(path.join(root, 'official-tools.json'), 'utf8'));
  assert.deepEqual(registry.appGrants.mailer, {});
});

test('DesktopUpdater checks metadata, downloads to userData cache, validates checksum, and opens the downloaded installer', async (t) => {
  const root = await tmpRoot('desktop-updater');
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  const installer = Buffer.from('installer-bytes');
  const sha256 = require('node:crypto').createHash('sha256').update(installer).digest('hex');
  const states = [];
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/latest.json')) {
      return Response.json({
        schemaVersion: 1,
        version: '9.9.9',
        publishedAt: '2026-05-21T00:00:00Z',
        releaseNotes: { summary: 'Test release', changes: ['Test release'] },
        assets: [{
          platform: process.platform,
          arch: process.arch,
          kind: process.platform === 'win32' ? 'nsis' : 'dmg',
          url: 'https://github.com/forger-ai/desktop/releases/download/v9.9.9/forger-desktop-installer.dmg',
          sha256,
          size: installer.length,
        }],
      });
    }
    return new Response(installer, { status: 200, headers: { 'content-length': String(installer.length) } });
  };
  const updater = new DesktopUpdater({
    currentVersion: '0.1.0',
    metadataUrl: 'https://example.invalid/latest.json',
    userDataPath: root,
    onStateChanged: (state) => states.push(state.status),
  });

  const available = await updater.check();
  const ready = await updater.download();
  const installed = await updater.install();

  assert.equal(available.status, 'available');
  assert.equal(ready.status, 'ready');
  assert.equal(await fs.readFile(ready.downloadedPath, 'utf8'), installer.toString('utf8'));
  assert.equal(installed.status, 'ready');
  assert.ok(states.includes('checking'));
  assert.ok(states.includes('downloading'));
});

test('DesktopUpdater reports up-to-date, unsupported, checksum, download, and install error states without network side effects', async (t) => {
  const root = await tmpRoot('desktop-updater-errors');
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  const metadataFor = (overrides = {}) => ({
    schemaVersion: 1,
    version: '9.9.9',
    publishedAt: '2026-05-21T00:00:00Z',
    releaseNotes: { summary: 'Release', changes: ['One'] },
    assets: [{
      platform: process.platform,
      arch: process.arch,
      kind: process.platform === 'win32' ? 'nsis' : 'dmg',
      url: 'https://github.com/forger-ai/desktop/releases/download/v9.9.9/forger-desktop-installer.dmg',
      sha256: '0'.repeat(64),
      size: 5,
    }],
    ...overrides,
  });
  const withFetch = async (impl, callback) => {
    globalThis.fetch = impl;
    return await callback();
  };

	  await withFetch(async () => Response.json(metadataFor({ version: '0.1.0' })), async () => {
	    const updater = new DesktopUpdater({ currentVersion: '0.1.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
	    assert.equal((await updater.check()).status, 'up_to_date');
	    assert.equal((await updater.download()).status, 'error');
	    assert.equal(updater.getState().technicalCode, 'up_to_date');
	  });

	  await withFetch(async () => Response.json(metadataFor()), async () => {
	    const updater = new DesktopUpdater({ currentVersion: 'dev-build', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
	    const state = await updater.check();
	    assert.equal(state.status, 'available');
	    assert.equal(state.availableVersion, '9.9.9');
	  });

	  await withFetch(async () => Response.json(metadataFor()), async () => {
	    const updater = new DesktopUpdater({ metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
	    const state = await updater.check();
	    assert.equal(state.status, 'up_to_date');
	  });

	  await withFetch(async () => Response.json(metadataFor({
	    releaseNotes: null,
	    assets: [{ platform: process.platform, arch: process.arch, kind: process.platform === 'win32' ? 'nsis' : 'dmg', url: 'https://github.com/forger-ai/desktop/releases/download/v9.9.9/no-notes.dmg' }],
	  })), async () => {
	    const updater = new DesktopUpdater({ currentVersion: '0.1.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
	    const state = await updater.check();
	    assert.equal(state.status, 'available');
	    assert.deepEqual(state.releaseNotes, { changes: [] });
	  });

  await withFetch(async () => Response.json(metadataFor({ assets: [{ platform: 'other', arch: 'other', kind: 'dmg', url: 'https://github.com/forger-ai/desktop/releases/download/v9.9.9/other.dmg' }] })), async () => {
    const updater = new DesktopUpdater({ currentVersion: '0.1.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
    const state = await updater.check();
    assert.equal(state.status, 'unsupported');
    assert.match(state.technicalCode, /^unsupported_/);
  });

  await withFetch(async (url) => {
    if (String(url).endsWith('/latest.json')) {
      return Response.json(metadataFor());
    }
    return new Response('bytes', { status: 200, headers: { 'content-length': '5' } });
  }, async () => {
    const updater = new DesktopUpdater({ currentVersion: '0.1.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
    await updater.check();
    const state = await updater.download();
    assert.equal(state.status, 'error');
    assert.equal(state.technicalCode, 'checksum_mismatch');
    assert.equal(await fs.stat(path.join(root, 'desktop-updates', '9.9.9', 'forger-desktop-installer.dmg.download')).catch(() => null), null);
  });

  await withFetch(async (url) => {
    if (String(url).endsWith('/latest.json')) {
      return Response.json(metadataFor({ assets: [{ ...metadataFor().assets[0], sha256: undefined }] }));
    }
    return new Response('nope', { status: 503 });
  }, async () => {
    const updater = new DesktopUpdater({ currentVersion: '0.1.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
    await updater.check();
    const state = await updater.download();
    assert.equal(state.status, 'error');
    assert.equal(state.technicalCode, 'download_http_503');
  });

  await withFetch(async () => new Response('{}', { status: 500 }), async () => {
    const updater = new DesktopUpdater({ currentVersion: '0.1.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
    const state = await updater.check();
    assert.equal(state.status, 'error');
    assert.equal(state.technicalCode, 'metadata_http_500');
  });

	  const idleUpdater = new DesktopUpdater({ currentVersion: '0.1.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
	  assert.equal((await idleUpdater.install()).technicalCode, 'idle');

	  await withFetch(async (url) => {
	    if (String(url).endsWith('/latest.json')) {
	      return Response.json(metadataFor({ assets: [{ ...metadataFor().assets[0], sha256: undefined }] }));
	    }
	    return new Response('ready', { status: 200, headers: { 'content-length': '5' } });
	  }, async () => {
	    const updater = new DesktopUpdater({ currentVersion: '0.1.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
	    const ready = await updater.download();
	    assert.equal(ready.status, 'ready');
	    const originalOpenPath = require.cache[electronPath].exports.shell.openPath;
	    require.cache[electronPath].exports.shell.openPath = async () => 'permission denied';
	    try {
	      const failed = await updater.install();
	      assert.equal(failed.status, 'error');
	      assert.equal(failed.technicalCode, 'permission denied');
	    } finally {
	      require.cache[electronPath].exports.shell.openPath = originalOpenPath;
	    }
	  });
	});

test('DesktopUpdater rejects malformed metadata and supports arrayBuffer downloads without content length', async (t) => {
  const root = await tmpRoot('desktop-updater-malformed');
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  const metadataFor = (overrides = {}) => ({
    schemaVersion: 1,
    version: '1.2.0',
    publishedAt: '2026-05-21T00:00:00Z',
    releaseNotes: { changes: ['Valid'] },
    assets: [{
      platform: process.platform,
      arch: process.arch,
      kind: process.platform === 'win32' ? 'nsis' : 'dmg',
      url: 'https://github.com/forger-ai/desktop/releases/download/v1.2.0/installer',
    }],
    ...overrides,
  });

	  for (const [payload, code] of [
	    [[], 'metadata_not_object'],
	    [{ schemaVersion: 2 }, 'metadata_schema_unsupported'],
	    [metadataFor({ version: 'not-semver' }), 'metadata_invalid_version'],
	    [metadataFor({ publishedAt: 'nope' }), 'metadata_invalid_published_at'],
	    [metadataFor({ assets: null }), 'metadata_assets_missing'],
	    [metadataFor({ assets: [null] }), 'metadata_assets_invalid'],
	    [metadataFor({ assets: [{ platform: process.platform, arch: process.arch, kind: 'dmg' }] }), 'metadata_assets_invalid'],
	    [metadataFor({ assets: [{ platform: process.platform, arch: process.arch, kind: 'dmg', url: 'not a url' }] }), 'metadata_assets_invalid'],
	    [metadataFor({ assets: [{ platform: process.platform, arch: process.arch, kind: 'dmg', url: 'http://github.com/forger-ai/desktop/releases/download/v1.2.0/app.dmg' }] }), 'metadata_assets_invalid'],
	  ]) {
    globalThis.fetch = async () => Response.json(payload);
    const updater = new DesktopUpdater({ currentVersion: '1.0.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
    assert.equal((await updater.check()).technicalCode, code);
  }

  const bytes = Buffer.from('installer');
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/latest.json')) {
      return Response.json(metadataFor());
    }
    return {
      ok: true,
      headers: { get: () => '' },
      body: null,
      arrayBuffer: async () => bytes,
    };
  };
	  const updater = new DesktopUpdater({ currentVersion: '1.0.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
	  const ready = await updater.download();
	  assert.equal(ready.status, 'ready');
	  assert.equal(ready.downloadedBytes, bytes.length);
	  assert.equal(path.basename(ready.downloadedPath), process.platform === 'win32' ? 'installer.exe' : 'installer.dmg');

	  const streamedBytes = Buffer.from('streamed-installer');
	  globalThis.fetch = async (url) => {
	    if (String(url).endsWith('/latest.json')) {
	      return Response.json(metadataFor({ version: '1.3.0' }));
	    }
	    let reads = 0;
	    return {
	      ok: true,
	      headers: { get: () => '' },
	      body: {
	        getReader: () => ({
	          read: async () => {
	            reads += 1;
	            return reads === 1
	              ? { done: false, value: streamedBytes }
	              : { done: true };
	          },
	        }),
	      },
	    };
	  };
	  const streamedUpdater = new DesktopUpdater({ currentVersion: '1.0.0', metadataUrl: 'https://example.invalid/latest.json', userDataPath: root });
	  const streamed = await streamedUpdater.download();
	  assert.equal(streamed.status, 'ready');
	  assert.equal(streamed.downloadedBytes, streamedBytes.length);
	  assert.equal(streamed.totalBytes, streamedBytes.length);
	});

test('DesktopUpdater uses environment metadata URL and installer filename fallbacks without optional callbacks', async (t) => {
  const root = await tmpRoot('desktop-updater-env-fallbacks');
  const originalFetch = globalThis.fetch;
  const originalUpdateUrl = process.env.FORGER_DESKTOP_UPDATE_URL;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalUpdateUrl === undefined) {
      delete process.env.FORGER_DESKTOP_UPDATE_URL;
    } else {
      process.env.FORGER_DESKTOP_UPDATE_URL = originalUpdateUrl;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  process.env.FORGER_DESKTOP_UPDATE_URL = 'https://metadata.test/latest.json';
  const installer = Buffer.from('installer-without-total');
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    if (String(url) === 'https://metadata.test/latest.json') {
      return Response.json({
        schemaVersion: 1,
        version: '1.2.1',
        publishedAt: '2026-05-21T00:00:00Z',
        releaseNotes: { summary: 'Env release' },
        assets: [{
          platform: process.platform,
          arch: process.arch,
          kind: 'nsis',
          url: 'https://github.com/',
        }],
      });
    }
    return new Response(installer, { status: 200 });
  };

  const updater = new DesktopUpdater({ currentVersion: '1.2', userDataPath: root });
  const available = await updater.check();
  const ready = await updater.download();

  assert.equal(available.status, 'available');
  assert.deepEqual(available.releaseNotes, { summary: 'Env release', changes: [] });
  assert.equal(path.basename(ready.downloadedPath), 'forger-desktop-1.2.1.exe');
  assert.equal(ready.downloadedBytes, installer.length);
  assert.equal(ready.totalBytes, installer.length);
  assert.deepEqual(fetchedUrls, ['https://metadata.test/latest.json', 'https://github.com/']);

  const sizedInstaller = Buffer.from('installer-with-header-size');
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/latest-sized.json')) {
      return Response.json({
        schemaVersion: 1,
        version: '1.2.2',
        publishedAt: '2026-05-21T00:00:00Z',
        assets: [{
          platform: process.platform,
          arch: process.arch,
          kind: 'dmg',
          url: 'https://github.com/forger-ai/desktop/releases/download/v1.2.2/content-length-installer',
        }],
      });
    }
    return new Response(sizedInstaller, {
      status: 200,
      headers: { 'content-length': String(sizedInstaller.length) },
    });
  };
  const sizedUpdater = new DesktopUpdater({
    currentVersion: '1.2.1',
    metadataUrl: 'https://example.invalid/latest-sized.json',
    userDataPath: root,
  });
  const sizedReady = await sizedUpdater.download();
  assert.equal(sizedReady.status, 'ready');
  assert.equal(sizedReady.totalBytes, sizedInstaller.length);
  assert.equal(path.basename(sizedReady.downloadedPath), 'content-length-installer.dmg');

  globalThis.fetch = async () => Response.json({
    schemaVersion: 1,
    version: '1.2',
    publishedAt: '2026-05-21T00:00:00Z',
    assets: [{
      platform: process.platform,
      arch: process.arch,
      kind: 'dmg',
      url: 'https://github.com/forger-ai/desktop/releases/download/v1.2/forger.dmg',
    }],
  });
  const olderUpdater = new DesktopUpdater({
    currentVersion: '1.2.1',
    metadataUrl: 'https://example.invalid/lower.json',
    userDataPath: root,
  });
  assert.equal((await olderUpdater.check()).status, 'up_to_date');

  delete process.env.FORGER_DESKTOP_UPDATE_URL;
  let defaultMetadataUrl = '';
  globalThis.fetch = async (url) => {
    defaultMetadataUrl = String(url);
    return new Response('{}', { status: 500 });
  };
  const defaultUpdater = new DesktopUpdater({ currentVersion: '1.0.0', userDataPath: root });
  assert.equal((await defaultUpdater.check()).technicalCode, 'metadata_http_500');
  assert.equal(defaultMetadataUrl, 'https://forger-ai.github.io/desktop-versions/latest.json');
});

const mockResponse = () => {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    },
  };
  return response;
};

const streamResponse = () => {
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.statusCode = 0;
  response.headers = {};
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    response.headers = headers;
  };
  response.setHeader = (key, value) => {
    response.headers[key] = value;
  };
  response.bodyBuffer = () => Buffer.concat(chunks);
  response.body = () => response.bodyBuffer().toString('utf8');
  return response;
};

test('DevCatalogService serves local app catalog metadata from FORGER_LOCAL_APPS without starting real app runtimes', async (t) => {
  const root = await tmpRoot('dev-catalog');
  const originalLocalApps = process.env.FORGER_LOCAL_APPS;
  t.after(async () => {
    process.env.FORGER_LOCAL_APPS = originalLocalApps;
    await fs.rm(root, { recursive: true, force: true });
  });
  const appDir = path.join(root, 'recipes');
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(appDir, '.version.dev'), '1.2.3-dev.20260521123456', 'utf8');
  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    name: 'recipes',
    catalog: {
      display_name: 'Recipes Dev',
      description: 'Local recipes',
      category: 'kitchen',
      runtime_stack: 'vite_fastapi_sqlite',
    },
    services: [{ name: 'backend' }],
    agents: [{ id: 'cook', name: 'Cook' }],
    promptTemplates: [{ id: 'default', title: 'Default' }],
    tools: { official: [] },
  }), 'utf8');
  await execFileAsync('git', ['init'], { cwd: appDir });
  await execFileAsync('git', ['checkout', '-b', 'coverage-branch'], { cwd: appDir });
  await execFileAsync('git', ['config', 'user.email', 'coverage@example.test'], { cwd: appDir });
  await execFileAsync('git', ['config', 'user.name', 'Coverage Test'], { cwd: appDir });
  await execFileAsync('git', ['add', 'manifest.json', '.version.dev'], { cwd: appDir });
  await execFileAsync('git', ['commit', '-m', 'seed dev catalog fixture'], { cwd: appDir });
  await fs.writeFile(path.join(appDir, 'local-change.txt'), 'dirty', 'utf8');
  process.env.FORGER_LOCAL_APPS = appDir;
  const service = new DevCatalogService();

  const health = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/health' }, health);
  const catalog = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/catalog.json' }, catalog);

  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body).local_apps, ['recipes-dev']);
  assert.equal(catalog.statusCode, 200);
  const [entry] = JSON.parse(catalog.body);
  assert.equal(entry.slug, 'recipes-dev');
  assert.equal(entry.name, 'Recipes Dev');
  assert.equal(entry.latest_version.version, '1.2.3-dev.20260521123456');
  assert.equal(entry.latest_version.agents.length, 1);
  assert.equal(entry.latest_version.prompt_templates.length, 1);
  assert.deepEqual(entry.latest_version.tools, { official: [] });
  assert.equal(entry.dev.branch, 'coverage-branch');
  assert.equal(entry.dev.dirty, true);
});

test('DevCatalogService serves dev assets, rejects unsafe paths, and exposes filtered ZIP downloads', async (t) => {
  const root = await tmpRoot('dev-catalog-assets');
  const originalLocalApps = process.env.FORGER_LOCAL_APPS;
  t.after(async () => {
    process.env.FORGER_LOCAL_APPS = originalLocalApps;
    await fs.rm(root, { recursive: true, force: true });
  });
  const appDir = path.join(root, 'finance-os');
  await fs.mkdir(path.join(appDir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'backend', 'data'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'backend', 'src', 'app'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'commons', 'backend'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'commons', 'frontend'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'frontend', 'src', 'api'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'frontend', 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(appDir, 'assets', 'icon.svg'), '<svg />', 'utf8');
  await fs.writeFile(path.join(appDir, 'backend', 'src', 'app', 'cors.py'), 'placeholder cors', 'utf8');
  await fs.writeFile(path.join(appDir, 'commons', 'backend', 'cors.py'), 'commons cors', 'utf8');
  await fs.writeFile(path.join(appDir, 'frontend', 'src', 'api', 'client.ts'), 'placeholder client', 'utf8');
  await fs.writeFile(path.join(appDir, 'commons', 'frontend', 'client.ts'), 'commons client', 'utf8');
  await fs.writeFile(path.join(appDir, 'src', 'main.py'), 'print("ok")', 'utf8');
  await fs.writeFile(path.join(appDir, 'backend', 'data', 'private.sqlite'), 'private', 'utf8');
  await fs.writeFile(path.join(appDir, 'frontend', 'node_modules', 'skip.js'), 'skip', 'utf8');
  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    name: 'finance-os',
    version: '2.0.0',
    description: 'Finance local',
    catalog: {
      display_name: 'Finance OS',
      short_description: 'Finanzas',
      permissions: ['files'],
      icon_path: 'assets/icon.svg',
    },
    stack: {
      backend: { python_version: '3.12' },
      frontend: { node_version: '22' },
    },
  }), 'utf8');
  process.env.FORGER_LOCAL_APPS = `${appDir}, ${appDir}`;
  const service = new DevCatalogService();

  const method = mockResponse();
  await service.handleRequest({ method: 'POST', url: '/health' }, method);
  assert.equal(method.statusCode, 405);

  const missing = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/missing' }, missing);
  assert.equal(missing.statusCode, 404);

  const asset = streamResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/finance-os-dev/assets/icon.svg' }, asset);
  await new Promise((resolve) => asset.on('finish', resolve));
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers['Content-Type'], 'image/svg+xml');
  assert.equal(asset.body(), '<svg />');

  const wrongAsset = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/finance-os-dev/assets/missing.svg' }, wrongAsset);
  assert.equal(wrongAsset.statusCode, 404);

  const unsafeAsset = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/finance-os-dev/../manifest.json' }, unsafeAsset);
  assert.equal(unsafeAsset.statusCode, 404);

  const missingAssetApp = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/missing-dev/assets/icon.svg' }, missingAssetApp);
  assert.equal(missingAssetApp.statusCode, 404);
  assert.equal(JSON.parse(missingAssetApp.body).error, 'app_not_found');

  const downloadMissing = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/download/missing-dev.zip' }, downloadMissing);
  assert.equal(downloadMissing.statusCode, 404);
  assert.equal(JSON.parse(downloadMissing.body).slug, 'missing-dev');

  const download = streamResponse();
  await service.handleRequest({ method: 'GET', url: '/download/finance-os-dev.zip' }, download);
  await new Promise((resolve) => download.on('finish', resolve));
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers['Content-Type'], 'application/zip');
  assert.match(download.headers['X-Forger-Checksum-Sha256'], /^[a-f0-9]{64}$/);
  assert.ok(download.bodyBuffer().length > 0);
  const zipPath = path.join(root, 'finance-os-dev.zip');
  await fs.writeFile(zipPath, download.bodyBuffer());
  const zippedCors = await execFileAsync('unzip', ['-p', zipPath, 'backend/src/app/cors.py']);
  const zippedClient = await execFileAsync('unzip', ['-p', zipPath, 'frontend/src/api/client.ts']);
  assert.equal(zippedCors.stdout, 'commons cors');
  assert.equal(zippedClient.stdout, 'commons client');

  const originalCreateReadStream = nodeFs.createReadStream;
  let cleanedStreamError = false;
  const errorResponse = streamResponse();
  errorResponse.destroy = () => {
    cleanedStreamError = true;
    return Writable.prototype.destroy.call(errorResponse);
  };
  nodeFs.createReadStream = () => ({
    pipe: () => errorResponse,
    on(event, callback) {
      if (event === 'error') {
        callback(new Error('stream_failed'));
      }
      return this;
    },
  });
  try {
    await service.handleRequest({ method: 'GET', url: '/download/finance-os-dev.zip' }, errorResponse);
    assert.equal(cleanedStreamError, true);
  } finally {
    nodeFs.createReadStream = originalCreateReadStream;
  }
});

test('DevCatalogService preserves explicit catalog fields and blocks symlinked icons outside the app root', async (t) => {
  const root = await tmpRoot('dev-catalog-explicit');
  const originalLocalApps = process.env.FORGER_LOCAL_APPS;
  t.after(async () => {
    process.env.FORGER_LOCAL_APPS = originalLocalApps;
    await fs.rm(root, { recursive: true, force: true });
  });
  const appDir = path.join(root, 'custom-app');
  await fs.mkdir(path.join(appDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'outside.png'), 'outside', 'utf8');
  await fs.writeFile(path.join(appDir, 'assets', 'icon.png'), 'png', 'utf8');
  await fs.writeFile(path.join(appDir, 'assets', 'photo.jpg'), 'jpg', 'utf8');
  await fs.writeFile(path.join(appDir, 'assets', 'preview.webp'), 'webp', 'utf8');
  await fs.writeFile(path.join(appDir, 'assets', 'raw.bin'), 'bin', 'utf8');
  await fs.symlink(path.join(root, 'outside.png'), path.join(appDir, 'assets', 'outside-link.png'));
  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    name: 'custom-app',
    version: '3.4.5',
    catalog: {
      display_name: 'Custom App',
      status: 'stable',
      runtime_stack: 'custom_stack',
      supported_platforms: ['darwin_arm64'],
      capabilities: ['files', { id: 'gmail' }],
      icon_path: 'assets/icon.png',
    },
  }), 'utf8');
  process.env.FORGER_LOCAL_APPS = appDir;
  const service = new DevCatalogService();

  const catalog = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/' }, catalog);
  assert.equal(catalog.statusCode, 200);
  assert.deepEqual(JSON.parse(catalog.body).local_apps, ['custom-app-dev']);

  const listing = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/catalog.json' }, listing);
  const [entry] = JSON.parse(listing.body);
  assert.equal(entry.name, 'Custom App Dev');
  assert.equal(entry.status, 'stable');
  assert.equal(entry.runtime_stack, 'custom_stack');
  assert.deepEqual(entry.latest_version.supported_platforms, ['darwin_arm64']);
  assert.deepEqual(entry.latest_version.capabilities, ['files', { id: 'gmail' }]);
  assert.equal(entry.latest_version.changelog.changes.at(-1), 'Branch local no disponible');

  const pngAsset = streamResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/custom-app-dev/assets/icon.png' }, pngAsset);
  await new Promise((resolve) => pngAsset.on('finish', resolve));
  assert.equal(pngAsset.statusCode, 200);
  assert.equal(pngAsset.headers['Content-Type'], 'image/png');
  assert.equal(pngAsset.body(), 'png');

  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    name: 'custom-app',
    catalog: { icon_path: 'assets/photo.jpg' },
  }), 'utf8');
  const jpgAsset = streamResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/custom-app-dev/assets/photo.jpg' }, jpgAsset);
  await new Promise((resolve) => jpgAsset.on('finish', resolve));
  assert.equal(jpgAsset.headers['Content-Type'], 'image/jpeg');

  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    name: 'custom-app',
    catalog: { icon_path: 'assets/preview.webp' },
  }), 'utf8');
  const webpAsset = streamResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/custom-app-dev/assets/preview.webp' }, webpAsset);
  await new Promise((resolve) => webpAsset.on('finish', resolve));
  assert.equal(webpAsset.headers['Content-Type'], 'image/webp');

  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    name: 'custom-app',
    catalog: { icon_path: 'assets/raw.bin' },
  }), 'utf8');
  const binaryAsset = streamResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/custom-app-dev/assets/raw.bin' }, binaryAsset);
  await new Promise((resolve) => binaryAsset.on('finish', resolve));
  assert.equal(binaryAsset.headers['Content-Type'], 'application/octet-stream');

  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    name: 'custom-app',
    catalog: { icon_path: 'assets/missing.png' },
  }), 'utf8');
  const missingIconFile = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/custom-app-dev/assets/missing.png' }, missingIconFile);
  assert.equal(missingIconFile.statusCode, 404);

  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    name: 'custom-app',
    catalog: {
      icon_path: 'assets/outside-link.png',
    },
  }), 'utf8');
  const escapedAsset = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/custom-app-dev/assets/outside-link.png' }, escapedAsset);
  assert.equal(escapedAsset.statusCode, 404);
});

test('DevCatalogService uses manifest fallbacks and keeps dev bundles free of ignored local artifacts', async (t) => {
  const root = await tmpRoot('dev-catalog-fallbacks');
  const originalLocalApps = process.env.FORGER_LOCAL_APPS;
  t.after(async () => {
    process.env.FORGER_LOCAL_APPS = originalLocalApps;
    await fs.rm(root, { recursive: true, force: true });
  });
  const appDir = path.join(root, 'no-name-app');
  await fs.mkdir(path.join(appDir, '.git'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'backend', 'data'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(appDir, '.version.dev'), '   \n', 'utf8');
  await fs.writeFile(path.join(appDir, 'manifest.json'), JSON.stringify({
    description: 'Fallback app',
    catalog: {
      permissions: ['user_selected_imports'],
    },
    agents: 'not-an-array',
    promptTemplates: 'not-an-array',
    tools: [],
  }), 'utf8');
  await fs.writeFile(path.join(appDir, 'src', 'main.py'), 'print("ok")', 'utf8');
  await fs.writeFile(path.join(appDir, 'src', 'cache.pyc'), 'compiled', 'utf8');
  await fs.writeFile(path.join(appDir, 'backend', 'data', 'local.sqlite'), 'private', 'utf8');
  await fs.writeFile(path.join(appDir, '.DS_Store'), 'mac metadata', 'utf8');
  await fs.writeFile(path.join(appDir, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
  await fs.symlink(path.join(appDir, 'src', 'main.py'), path.join(appDir, 'src', 'main-link.py'));
  process.env.FORGER_LOCAL_APPS = appDir;
  const service = new DevCatalogService();

  const catalog = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/catalog.json' }, catalog);
  assert.equal(catalog.statusCode, 200);
  const [entry] = JSON.parse(catalog.body);
  assert.equal(entry.slug, 'no-name-app-dev');
  assert.equal(entry.name, 'no-name-app Dev');
  assert.equal(entry.description, 'Fallback app');
  assert.equal(entry.category, 'utilities');
  assert.equal(entry.status, 'coming');
  assert.equal(entry.runtime_stack, 'vite_fastapi_sqlite');
  assert.equal(entry.icon_url, undefined);
  assert.equal(entry.latest_version.version, '0.0.0-dev');
  assert.deepEqual(entry.latest_version.capabilities, ['user_selected_imports']);
  assert.equal(entry.latest_version.agents, undefined);
  assert.equal(entry.latest_version.prompt_templates, undefined);
  assert.equal(entry.latest_version.tools, undefined);
  assert.equal(entry.dev.dirty, undefined);

  const noIcon = mockResponse();
  await service.handleRequest({ method: 'GET', url: '/assets/no-name-app-dev/src/main.py' }, noIcon);
  assert.equal(noIcon.statusCode, 404);

  const download = streamResponse();
  await service.handleRequest({ method: 'GET', url: '/download/no-name-app-dev.zip' }, download);
  await new Promise((resolve) => download.on('finish', resolve));
  assert.equal(download.statusCode, 200);
  assert.match(download.headers['X-Forger-Checksum-Sha256'], /^[a-f0-9]{64}$/);
  assert.ok(download.bodyBuffer().length > 0);
});

test('DevCatalogService start is idempotent and reports malformed local app manifests as catalog errors', async (t) => {
  const root = await tmpRoot('dev-catalog-start');
  const originalLocalApps = process.env.FORGER_LOCAL_APPS;
  t.after(async () => {
    process.env.FORGER_LOCAL_APPS = originalLocalApps;
    await fs.rm(root, { recursive: true, force: true });
  });
  const appDir = path.join(root, 'broken');
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(appDir, 'manifest.json'), '{bad json', 'utf8');
  process.env.FORGER_LOCAL_APPS = appDir;
  const service = new DevCatalogService();
  assert.equal(service.url, 'http://127.0.0.1:8765/catalog.json');
  await service.start();
  await service.start();
  try {
    const response = await fetch(service.url);
    const payload = await response.json();
    assert.equal(response.status, 500);
    assert.equal(payload.error, 'dev_catalog_error');
  } finally {
    service.stop();
    service.stop();
  }
});

test('DevCatalogService internal helpers cover command failures, version overrides, skip rules, and zip errors', async (t) => {
  const root = await tmpRoot('dev-catalog-internals');
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;
  t.after(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.PATH = originalPath;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, '.version.dev'), '  \n', 'utf8');
  assert.equal(await __testDevCatalogInternals.readDevVersionOverride(root), undefined);

  await assert.rejects(
    () => __testDevCatalogInternals.runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      cwd: root,
      timeoutMs: 10,
    }),
    /command_timeout/,
  );
  await assert.rejects(
    () => __testDevCatalogInternals.runCommand(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)'], {
      cwd: root,
      timeoutMs: 5_000,
    }),
    /command_failed_7: out\nerr/,
  );

  assert.equal(__testDevCatalogInternals.shouldSkip(path.join(root, 'backend', 'data', 'app.sqlite'), root), true);
  assert.equal(__testDevCatalogInternals.shouldSkip(path.join(root, '.DS_Store'), root), true);
  assert.equal(__testDevCatalogInternals.shouldSkip(path.join(root, 'src', 'cache.pyo'), root), true);
  assert.equal(__testDevCatalogInternals.shouldSkip(path.join(root, 'src', 'app.py'), root), false);
  assert.equal(__testDevCatalogInternals.shouldSkip(root, root), false);

  await fs.mkdir(path.join(root, 'commons', 'backend', 'cors.py'), { recursive: true });
  await __testDevCatalogInternals.applyCommonsOverlay(root, path.join(root, 'stage'));
  await assert.rejects(
    () => fs.readFile(path.join(root, 'stage', 'backend', 'src', 'app', 'cors.py'), 'utf8'),
    /ENOENT/,
  );

  await assert.rejects(
    () => __testDevCatalogInternals.zipDirectory(path.join(root, 'missing-source'), path.join(root, 'missing.zip')),
    /command_failed_|ENOENT/,
  );

  const fakeBin = path.join(root, 'bin');
  await fs.mkdir(fakeBin, { recursive: true });
  const powershellPath = path.join(fakeBin, 'powershell');
  await fs.writeFile(powershellPath, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
  await fs.chmod(powershellPath, 0o755);
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  await __testDevCatalogInternals.zipDirectory(root, path.join(root, "quoted ' bundle.zip"));
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});
