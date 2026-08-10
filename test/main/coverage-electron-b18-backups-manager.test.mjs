import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BackupsManager } = require('../../dist-electron/main/backups-manager.js');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const usePlatform = (platform) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  return () => Object.defineProperty(process, 'platform', descriptor);
};

const fixture = async (t, name = 'backups-b18') => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'state', 'backups');
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const events = [];
  await fs.mkdir(path.join(installDir, 'backend', 'data'), { recursive: true });
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: (appId) => (appId === appRecord.appId ? appRecord : undefined),
    isAppRunning: () => false,
    log: async (event, payload) => events.push([event, payload]),
  });
  return { root, installDir, backupsRoot, appRecord, manager, events };
};

const writeRemoteBackup = async ({ backupDir, appRecord, files, backupId = 'cloud-backup' }) => {
  await fs.mkdir(path.join(backupDir, 'files'), { recursive: true });
  const summaries = [];
  for (const [sourceRelativePath, value] of Object.entries(files)) {
    const backupRelativePath = path.posix.join('files', sourceRelativePath.replaceAll('\\', '/'));
    const target = path.join(backupDir, backupRelativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value, 'utf8');
    summaries.push({
      sourceRelativePath,
      backupRelativePath,
      sha256: sha256(value),
      sizeBytes: Buffer.byteLength(value),
    });
  }
  const metadata = {
    schemaVersion: 1,
    appId: appRecord.appId,
    appName: appRecord.name,
    appVersion: appRecord.version,
    backupId,
    createdAt: new Date().toISOString(),
    reason: 'manual',
    files: summaries,
  };
  await fs.writeFile(path.join(backupDir, 'metadata.json'), JSON.stringify(metadata), 'utf8');
  return metadata;
};

test('BackupsManager validates portable identifiers and Windows-equivalent restore targets', async (t) => {
  const { manager, appRecord, installDir, root } = await fixture(t, 'forger-backups-b18-win32');

  assert.equal(manager.backupDirectory('', 'valid'), null);
  assert.equal(manager.backupDirectory('demo-app', ''), null);
  assert.equal(manager.backupDirectory('demo-app.', 'valid'), null);
  assert.equal(manager.backupDirectory('CON', 'valid'), null);
  assert.equal(manager.backupDirectory(undefined, 'valid'), null);
  assert.equal((await manager.createBackup({ appId: 'NUL' })).technicalCode, 'invalid_app_id');
  assert.equal((await manager.deleteBackup({ appId: 'AUX', backupId: 'valid' })).technicalCode, 'invalid_app_id');
  assert.equal((await manager.deleteBackup({ appId: 'demo-app', backupId: 'LPT1' })).technicalCode, 'invalid_backup_id');
  assert.equal((await manager.restoreBackup({ appId: 'COM1', backupId: 'valid' })).technicalCode, 'invalid_app_id');
  assert.equal((await manager.restoreBackupDirectory({ appId: 'PRN', backupDir: root })).technicalCode, 'invalid_app_id');

  const restorePlatform = usePlatform('win32');
  t.after(restorePlatform);
  assert.ok(manager.backupDirectory('demo-app', 'valid'));
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    services: [{ volumes: [{ persist: true, source: 'BACKEND/DATA' }] }],
  }), 'utf8');
  const contract = await manager.collectPersistentPathContract(appRecord);
  assert.deepEqual(contract, [{ relativePath: 'BACKEND/DATA', allowsDescendants: true }]);
  await manager.verifyRemoteRestoreTargets(appRecord, {
    files: [{ sourceRelativePath: 'backend/data/Case.db' }],
  });
  await fs.writeFile(path.join(installDir, 'backend', 'data', 'Case.db'), 'local', 'utf8');
  assert.equal((await manager.createBackup({ appId: appRecord.appId })).success, true);
  const cloudDir = path.join(root, 'windows-cloud');
  const metadata = await writeRemoteBackup({ backupDir: cloudDir, appRecord, files: { 'backend/data/Case.db': 'cloud' } });
  assert.equal((await manager.buildRestorePlan(cloudDir, installDir, metadata)).length, 1);
  assert.deepEqual(await manager.missingRestoreParents(installDir.toUpperCase(), installDir.toLowerCase()), []);
});

test('BackupsManager lists only canonical directories with matching readable metadata', async (t) => {
  const { root, backupsRoot, manager, appRecord } = await fixture(t, 'forger-backups-b18-list');
  await fs.mkdir(backupsRoot, { recursive: true });
  assert.deepEqual(await manager.listBackups('invalid.'), []);

  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(backupsRoot, appRecord.appId), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await manager.listBackups(), []);
  await fs.rm(path.join(backupsRoot, appRecord.appId));

  const appBackupRoot = path.join(backupsRoot, appRecord.appId);
  await fs.mkdir(path.join(appBackupRoot, 'bad-backup'), { recursive: true });
  await fs.writeFile(path.join(appBackupRoot, 'plain-file'), 'ignored', 'utf8');
  const firstDir = path.join(appBackupRoot, 'first');
  const secondDir = path.join(appBackupRoot, 'second');
  const first = await writeRemoteBackup({ backupDir: firstDir, appRecord, backupId: 'first', files: {} });
  const second = await writeRemoteBackup({ backupDir: secondDir, appRecord, backupId: 'second', files: {} });
  first.createdAt = '2025-01-01T00:00:00.000Z';
  second.createdAt = '2026-01-01T00:00:00.000Z';
  await fs.writeFile(path.join(firstDir, 'metadata.json'), JSON.stringify(first), 'utf8');
  await fs.writeFile(path.join(secondDir, 'metadata.json'), JSON.stringify(second), 'utf8');
  assert.deepEqual((await manager.listBackups()).map(({ backupId }) => backupId), ['second', 'first']);
});

test('BackupsManager treats manifest entries as a strict persistent-data contract', async (t) => {
  const { manager, appRecord, installDir, root } = await fixture(t, 'forger-backups-b18-contract');
  const danglingLink = path.join(installDir, 'backend', 'data', 'runtime-entry');
  await fs.symlink(path.join(root, 'missing-target'), danglingLink);
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({
    services: [
      {},
      { volumes: [{ persist: true }, { persist: true, source: '../escape' }, { persist: true, source: '.' }] },
      { context: '', environment: { DATABASE_URL: 42 } },
      { environment: { DATABASE_URL: 'sqlite:///relative.sqlite3' } },
      { environment: { DATABASE_URL: `sqlite:///${path.join(root, 'outside.sqlite3')}` } },
    ],
  }), 'utf8');

  const contract = await manager.collectPersistentPathContract(appRecord);
  assert.deepEqual(contract, [{ relativePath: 'backend/data', allowsDescendants: true }]);
  assert.deepEqual(await manager.collectPersistentFiles(appRecord), []);
  await assert.rejects(
    manager.verifyRemoteRestoreTargets(appRecord, { files: [{ sourceRelativePath: '.' }] }),
    /invalid_backup_metadata_path/,
  );
  await assert.rejects(
    manager.verifyRemoteRestoreTargets(appRecord, { files: [{ sourceRelativePath: 'manifest.json' }] }),
    /remote_backup_target_not_persistent/,
  );
  await fs.writeFile(path.join(installDir, 'manifest.json'), 'null', 'utf8');
  assert.deepEqual(await manager.collectPersistentPathContract(appRecord), [
    { relativePath: 'backend/data', allowsDescendants: true },
  ]);
});

test('BackupsManager reports inconsistent records and allocation failures without publishing partial backups', async (t) => {
  const { manager, appRecord, backupsRoot, installDir } = await fixture(t, 'forger-backups-b18-create-errors');
  manager.getInstalledApp = () => ({ ...appRecord, appId: 'other-app' });
  assert.equal((await manager.createBackup({ appId: 'demo-app' })).technicalCode, 'invalid_app_id');

  manager.getInstalledApp = () => appRecord;
  manager.allocateBackupDirectory = async () => null;
  assert.equal((await manager.createBackup({ appId: 'demo-app' })).technicalCode, 'unsafe_backup_path');

  const outside = path.join(path.dirname(backupsRoot), 'outside-allocation');
  await fs.mkdir(outside, { recursive: true });
  manager.allocateBackupDirectory = async () => ({ backupId: 'unsafe', backupDir: outside });
  await assert.rejects(manager.createBackup({ appId: 'demo-app' }), /unsafe_backup_create_path/);
  assert.equal(await fs.stat(outside).then(() => true, () => false), true);

  const source = path.join(installDir, 'backend', 'data', 'app.sqlite3');
  const external = path.join(path.dirname(backupsRoot), 'external.sqlite3');
  await fs.writeFile(external, 'outside', 'utf8');
  await fs.symlink(external, source, 'file');
  manager.collectPersistentFiles = async () => [source];
  delete manager.allocateBackupDirectory;
  await assert.rejects(manager.createBackup({ appId: 'demo-app' }), /unsafe_backup_create_path/);
  assert.deepEqual(await manager.listBackups('demo-app'), []);
});

test('BackupsManager cleans failed copies and preserves a destination replaced during creation', async (t) => {
  const { manager, installDir, backupsRoot } = await fixture(t, 'forger-backups-b18-copy-errors');
  const source = path.join(installDir, 'backend', 'data', 'app.sqlite3');
  await fs.writeFile(source, 'database', 'utf8');
  const outside = path.join(path.dirname(backupsRoot), 'outside-copy.sqlite3');
  await fs.mkdir(path.dirname(outside), { recursive: true });
  await fs.writeFile(outside, 'outside', 'utf8');
  const originalCopyFile = fs.copyFile;
  fs.copyFile = async (from, to, mode) => {
    await originalCopyFile(from, to, mode);
    await fs.rm(to);
    await fs.symlink(outside, to, 'file');
  };
  t.after(() => { fs.copyFile = originalCopyFile; });
  await assert.rejects(manager.createBackup({ appId: 'demo-app' }), /unsafe_backup_create_path/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  assert.deepEqual(await manager.listBackups('demo-app'), []);
});

test('BackupsManager serializes failures, allocation collisions, and cleanup safely', async (t) => {
  const { manager, appRecord, backupsRoot } = await fixture(t, 'forger-backups-b18-allocation');
  assert.equal(await manager.allocateBackupDirectory('invalid.'), null);

  const outside = path.join(path.dirname(backupsRoot), 'outside-root');
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(backupsRoot, { recursive: true });
  await fs.symlink(outside, path.join(backupsRoot, appRecord.appId), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await manager.allocateBackupDirectory(appRecord.appId), null);
  await fs.rm(path.join(backupsRoot, appRecord.appId));

  const originalMkdir = fs.mkdir;
  fs.mkdir = async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(path.join(backupsRoot, appRecord.appId))) {
      const error = new Error('disk read only');
      error.code = 'EROFS';
      throw error;
    }
    return await originalMkdir(target, options);
  };
  await assert.rejects(manager.allocateBackupDirectory(appRecord.appId), /disk read only/);
  fs.mkdir = originalMkdir;

  await originalMkdir(path.join(backupsRoot, appRecord.appId), { recursive: true });
  let collisions = 0;
  fs.mkdir = async (target, options) => {
    if (path.dirname(String(target)) === path.join(backupsRoot, appRecord.appId) && collisions < 8) {
      collisions += 1;
      const error = new Error('collision');
      error.code = 'EEXIST';
      throw error;
    }
    return await originalMkdir(target, options);
  };
  await assert.rejects(manager.allocateBackupDirectory(appRecord.appId), /backup_id_allocation_failed/);
  assert.equal(collisions, 8);
  fs.mkdir = originalMkdir;
  t.after(() => { fs.mkdir = originalMkdir; });

  const allocated = await manager.allocateBackupDirectory(appRecord.appId);
  await manager.removeAllocatedBackupDirectory(allocated.backupDir);
  assert.equal(await fs.stat(allocated.backupDir).then(() => true, () => false), false);
  await manager.removeAllocatedBackupDirectory(outside);
  assert.equal(await fs.stat(outside).then(() => true, () => false), true);
});

test('BackupsManager rejects missing, replaced, and malformed backup directories', async (t) => {
  const { manager, backupsRoot, appRecord, root } = await fixture(t, 'forger-backups-b18-metadata');
  await fs.mkdir(backupsRoot, { recursive: true });
  assert.equal((await manager.deleteBackup({ appId: appRecord.appId, backupId: 'missing' })).technicalCode, 'backup_not_found');
  await fs.mkdir(path.join(backupsRoot, appRecord.appId));
  await fs.writeFile(path.join(backupsRoot, appRecord.appId, 'missing'), 'not a directory');
  assert.equal((await manager.deleteBackup({ appId: appRecord.appId, backupId: 'missing' })).technicalCode, 'backup_not_found');
  await fs.rm(path.join(backupsRoot, appRecord.appId), { recursive: true });

  const outside = path.join(root, 'outside-backup');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(backupsRoot, appRecord.appId));
  await fs.symlink(outside, path.join(backupsRoot, appRecord.appId, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await manager.deleteBackup({ appId: appRecord.appId, backupId: 'linked' })).technicalCode, 'unsafe_backup_path');
  await assert.rejects(manager.readMetadata(appRecord.appId, 'linked'), /unsafe_backup_path/);
  await assert.rejects(manager.readMetadata('invalid.', 'valid'), /invalid_backup_id/);

  const plainFile = path.join(root, 'plain-file');
  await fs.writeFile(plainFile, 'plain', 'utf8');
  await assert.rejects(manager.readMetadataFromDirectory(plainFile), /invalid_backup_metadata/);
  const directory = path.join(root, 'metadata-directory');
  await fs.mkdir(directory);
  const outsideMetadata = path.join(root, 'outside-metadata.json');
  await fs.writeFile(outsideMetadata, '{}', 'utf8');
  await fs.symlink(outsideMetadata, path.join(directory, 'metadata.json'), 'file');
  await assert.rejects(manager.readMetadataFromDirectory(directory), /unsafe_backup_metadata_path/);

  for (const metadata of [null, {}, { schemaVersion: 1, appId: 'invalid.', backupId: 'valid', files: [] }, { schemaVersion: 1, appId: 'valid', backupId: 'NUL', files: [] }, { schemaVersion: 1, appId: 'valid', backupId: 'valid', files: null }]) {
    await fs.rm(path.join(directory, 'metadata.json'), { recursive: true, force: true });
    await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata), 'utf8');
    await assert.rejects(manager.readMetadataFromDirectory(directory), /invalid_backup_metadata/);
  }
});

test('BackupsManager verifies complete file identity and refuses ambiguous restore plans', async (t) => {
  const { manager, installDir, appRecord, root } = await fixture(t, 'forger-backups-b18-restore-plan');
  const backupDir = path.join(root, 'remote');
  const metadata = await writeRemoteBackup({ backupDir, appRecord, files: { 'backend/data/app.db': 'database' } });
  const file = metadata.files[0];

  await fs.writeFile(path.join(backupDir, file.backupRelativePath), 'x', 'utf8');
  await assert.rejects(manager.verifyBackupFiles(backupDir, metadata), /backup_file_mismatch/);
  await fs.rm(path.join(backupDir, file.backupRelativePath));
  const outsideBackupFile = path.join(root, 'outside-backup-file');
  await fs.writeFile(outsideBackupFile, 'database', 'utf8');
  await fs.symlink(outsideBackupFile, path.join(backupDir, file.backupRelativePath), 'file');
  await assert.rejects(manager.verifyBackupFiles(backupDir, metadata), /unsafe_backup_file_path/);
  await fs.rm(path.join(backupDir, file.backupRelativePath));
  await fs.writeFile(path.join(backupDir, file.backupRelativePath), 'database', 'utf8');

  await assert.rejects(manager.buildRestorePlan(backupDir, installDir, { files: [{ ...file, backupRelativePath: path.join(root, 'outside') }] }), /unsafe_backup_file_path/);
  await assert.rejects(manager.buildRestorePlan(backupDir, installDir, { files: [{ ...file, sourceRelativePath: path.join(root, 'outside') }] }), /unsafe_backup_restore_path/);
  await assert.rejects(manager.buildRestorePlan(backupDir, installDir, { files: [file, { ...file }] }), /duplicate_backup_restore_target/);

  const outside = path.join(root, 'outside-target');
  await fs.mkdir(outside);
  const targetParent = path.join(installDir, 'backend', 'data');
  await fs.rm(targetParent, { recursive: true });
  await fs.symlink(outside, targetParent, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.buildRestorePlan(backupDir, installDir, metadata), /unsafe_backup_restore_path/);
  await assert.rejects(manager.missingRestoreParents(installDir, root), /unsafe_backup_restore_path/);
});

test('BackupsManager reports batch cardinality and successful cloud restore observably', async (t) => {
  const { manager, installDir, appRecord, root, events } = await fixture(t, 'forger-backups-b18-cloud');
  assert.equal((await manager.deleteBackups({ appId: appRecord.appId, backupIds: [] })).userMessage, 'Respaldos eliminados.');

  const dataPath = path.join(installDir, 'backend', 'data', 'app.db');
  await fs.writeFile(dataPath, 'local', 'utf8');
  const one = await manager.createBackup({ appId: appRecord.appId });
  const two = await manager.createBackup({ appId: appRecord.appId });
  const single = await manager.deleteBackups({ appId: appRecord.appId, backupIds: [one.backup.backupId] });
  assert.equal(single.userMessage, 'Respaldo eliminado.');
  const partial = await manager.deleteBackups({ appId: appRecord.appId, backupIds: [two.backup.backupId, 'missing'] });
  assert.equal(partial.technicalCode, 'backup_batch_delete_partial');
  const failed = await manager.deleteBackups({ appId: appRecord.appId, backupIds: ['missing'] });
  assert.equal(failed.technicalCode, 'backup_batch_delete_failed');

  const cloudDir = path.join(root, 'cloud');
  await writeRemoteBackup({ backupDir: cloudDir, appRecord, files: { 'backend/data/app.db': 'cloud' } });
  const restored = await manager.restoreBackupDirectory({ appId: appRecord.appId, backupDir: cloudDir });
  assert.equal(restored.success, true);
  assert.equal(await fs.readFile(dataPath, 'utf8'), 'cloud');
  assert.ok(events.some(([event]) => event === 'backup:remote_restored'));
});

test('BackupsManager treats canonicalization failures and escaped persistent links as absent', async (t) => {
  const { manager, installDir, backupsRoot, root } = await fixture(t, 'forger-backups-b18-canonical-errors');
  await fs.mkdir(backupsRoot, { recursive: true });
  const originalRealpath = fs.realpath;
  fs.realpath = async (target) => {
    if (path.resolve(String(target)) === path.resolve(backupsRoot)) {
      return await originalRealpath(target);
    }
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  };
  assert.deepEqual(await manager.listBackups('demo-app'), []);
  let rootCalls = 0;
  fs.realpath = async (target) => {
    if (path.resolve(String(target)) === path.resolve(backupsRoot) && rootCalls++ === 0) {
      return await originalRealpath(target);
    }
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  };
  assert.deepEqual(await manager.listBackups('demo-app'), []);
  fs.realpath = originalRealpath;
  t.after(() => { fs.realpath = originalRealpath; });

  const outside = path.join(root, 'outside.db');
  const linked = path.join(installDir, 'backend', 'data', 'linked.db');
  await fs.writeFile(outside, 'outside', 'utf8');
  await fs.symlink(outside, linked, 'file');
  assert.deepEqual(await manager.collectPersistentFiles({
    appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir,
  }), []);
});

test('BackupsManager removes an allocation when metadata publishing becomes unsafe', async (t) => {
  const { manager, backupsRoot, root } = await fixture(t, 'forger-backups-b18-metadata-swap');
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const originalRealpath = fs.realpath;
  fs.realpath = async (target) => {
    if (path.basename(String(target)) === 'metadata.json') {
      return outside;
    }
    return await originalRealpath(target);
  };
  t.after(() => { fs.realpath = originalRealpath; });

  await assert.rejects(manager.createBackup({ appId: 'demo-app' }), /unsafe_backup_create_path/);
  assert.deepEqual(await fs.readdir(path.join(backupsRoot, 'demo-app')), []);
});

test('BackupsManager revalidates a selected backup immediately before deletion', async (t) => {
  const { manager, backupsRoot, appRecord, root } = await fixture(t, 'forger-backups-b18-delete-swap');
  assert.equal((await manager.deleteBackupUnlocked({ appId: 'invalid.', backupId: 'valid' })).technicalCode, 'invalid_backup_id');

  const nonDirectoryRoot = path.join(root, 'backups-file');
  await fs.writeFile(nonDirectoryRoot, 'file', 'utf8');
  const fileRootManager = new BackupsManager({
    backupsRoot: nonDirectoryRoot,
    listInstalledApps: () => [],
    getInstalledApp: () => undefined,
    isAppRunning: () => false,
  });
  assert.equal((await fileRootManager.deleteBackupUnlocked({ appId: 'demo-app', backupId: 'valid' })).technicalCode, 'backup_not_found');

  const backupPath = path.join(backupsRoot, appRecord.appId, 'swap-me');
  const outside = path.join(root, 'outside-directory');
  await fs.mkdir(backupPath, { recursive: true });
  await fs.mkdir(outside);
  const originalLstat = fs.lstat;
  let swapped = false;
  fs.lstat = async (target) => {
    const stat = await originalLstat(target);
    if (!swapped && path.resolve(String(target)) === path.resolve(backupPath)) {
      swapped = true;
      await fs.rm(backupPath, { recursive: true });
      await fs.symlink(outside, backupPath, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return stat;
  };
  t.after(() => { fs.lstat = originalLstat; });
  assert.equal((await manager.deleteBackup({ appId: appRecord.appId, backupId: 'swap-me' })).technicalCode, 'unsafe_backup_path');
  assert.equal(await fs.stat(outside).then(() => true, () => false), true);
});

test('BackupsManager rejects unsafe allocation states after every filesystem boundary', async (t) => {
  const { manager, appRecord, backupsRoot, root } = await fixture(t, 'forger-backups-b18-allocation-boundaries');
  await fs.mkdir(backupsRoot, { recursive: true });
  const appRoot = path.join(backupsRoot, appRecord.appId);
  await fs.writeFile(appRoot, 'not a directory', 'utf8');
  assert.equal(await manager.allocateBackupDirectory(appRecord.appId), null);
  await fs.rm(appRoot);

  const originalMkdir = fs.mkdir;
  const outside = path.join(root, 'outside-allocation');
  await fs.mkdir(outside);
  await fs.mkdir(appRoot);
  fs.mkdir = async (target, options) => {
    if (path.dirname(String(target)) === appRoot) {
      const error = new Error('device failure');
      error.code = 'EIO';
      throw error;
    }
    return await originalMkdir(target, options);
  };
  await assert.rejects(manager.allocateBackupDirectory(appRecord.appId), /device failure/);
  fs.mkdir = async (target, options) => {
    const result = await originalMkdir(target, options);
    if (path.dirname(String(target)) === appRoot) {
      await fs.rm(target, { recursive: true });
      await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return result;
  };
  assert.equal(await manager.allocateBackupDirectory(appRecord.appId), null);
  fs.mkdir = originalMkdir;
  t.after(() => { fs.mkdir = originalMkdir; });
});

test('BackupsManager aborts allocation when its verified app root is swapped before reservation', async (t) => {
  const { manager, appRecord, backupsRoot, root } = await fixture(t, 'forger-backups-b18-allocation-root-swap');
  const appRoot = path.join(backupsRoot, appRecord.appId);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  const originalRealpath = fs.realpath;
  let appRootCalls = 0;
  fs.realpath = async (target) => {
    if (path.resolve(String(target)) === path.resolve(appRoot) && ++appRootCalls === 3) {
      return outside;
    }
    return await originalRealpath(target);
  };
  t.after(() => { fs.realpath = originalRealpath; });
  assert.equal(await manager.allocateBackupDirectory(appRecord.appId), null);
});

test('BackupsManager stops restore staging when source identity or staged content changes', async (t) => {
  const { manager, installDir, appRecord, root } = await fixture(t, 'forger-backups-b18-staging');
  const backupDir = path.join(root, 'remote');
  const metadata = await writeRemoteBackup({ backupDir, appRecord, files: { 'backend/data/app.db': 'database' } });
  const restoreFiles = await manager.buildRestorePlan(backupDir, installDir, metadata);
  const sourcePath = restoreFiles[0].sourcePath;
  const outside = path.join(root, 'outside-source');
  await fs.writeFile(outside, 'database', 'utf8');
  await fs.rm(sourcePath);
  await fs.symlink(outside, sourcePath, 'file');
  await assert.rejects(manager.buildRestorePlan(backupDir, installDir, metadata), /unsafe_backup_file_path/);
  await assert.rejects(manager.applyRestorePlan(backupDir, installDir, restoreFiles), /unsafe_backup_file_path/);
  await fs.rm(sourcePath);
  await fs.writeFile(sourcePath, 'database', 'utf8');

  const originalCopyFile = fs.copyFile;
  fs.copyFile = async (from, to, mode) => {
    await originalCopyFile(from, to, mode);
    await fs.writeFile(to, 'x', 'utf8');
  };
  await assert.rejects(manager.applyRestorePlan(backupDir, installDir, restoreFiles), /backup_file_mismatch/);
  fs.copyFile = async (from, to, mode) => {
    await originalCopyFile(from, to, mode);
    await fs.writeFile(to, 'DATABASE', 'utf8');
  };
  await assert.rejects(manager.applyRestorePlan(backupDir, installDir, restoreFiles), /backup_checksum_mismatch/);
  fs.copyFile = originalCopyFile;
  t.after(() => { fs.copyFile = originalCopyFile; });
});

test('BackupsManager rejects transaction and target parents swapped outside the install root', async (t) => {
  const { manager, installDir, appRecord, root } = await fixture(t, 'forger-backups-b18-transaction-swaps');
  const backupDir = path.join(root, 'remote');
  const metadata = await writeRemoteBackup({ backupDir, appRecord, files: { 'backend/data/app.db': 'database' } });
  const restoreFiles = await manager.buildRestorePlan(backupDir, installDir, metadata);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const originalMkdtemp = fs.mkdtemp;
  fs.mkdtemp = async (prefix, options) => {
    const transaction = await originalMkdtemp(prefix, options);
    await fs.rm(transaction, { recursive: true });
    await fs.symlink(outside, transaction, process.platform === 'win32' ? 'junction' : 'dir');
    return transaction;
  };
  await assert.rejects(manager.applyRestorePlan(backupDir, installDir, restoreFiles), /unsafe_backup_restore_path/);
  fs.mkdtemp = originalMkdtemp;
  t.after(() => { fs.mkdtemp = originalMkdtemp; });

  const targetParent = path.dirname(restoreFiles[0].targetPath);
  await fs.rm(targetParent, { recursive: true });
  await fs.symlink(outside, targetParent, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.applyRestorePlan(backupDir, installDir, restoreFiles), /unsafe_backup_restore_path/);
});

test('BackupsManager revalidates the vacant target after moving its original aside', async (t) => {
  const { manager, installDir, appRecord, root } = await fixture(t, 'forger-backups-b18-vacant-swap');
  const target = path.join(installDir, 'backend', 'data', 'app.db');
  await fs.writeFile(target, 'current!', 'utf8');
  const backupDir = path.join(root, 'remote');
  const metadata = await writeRemoteBackup({ backupDir, appRecord, files: { 'backend/data/app.db': 'backup!!' } });
  const restoreFiles = await manager.buildRestorePlan(backupDir, installDir, metadata);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const originalRename = fs.rename;
  fs.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (path.resolve(String(source)) === path.resolve(target)) {
      await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return result;
  };
  t.after(() => { fs.rename = originalRename; });
  await assert.rejects(manager.applyRestorePlan(backupDir, installDir, restoreFiles), /unsafe_backup_restore_path/);
});

test('BackupsManager rolls back commit failures and surfaces a failed rollback atomically', async (t) => {
  const { manager, installDir, appRecord, root } = await fixture(t, 'forger-backups-b18-rollback-failure');
  const target = path.join(installDir, 'backend', 'data', 'app.db');
  await fs.writeFile(target, 'current', 'utf8');
  const backupDir = path.join(root, 'remote');
  const metadata = await writeRemoteBackup({ backupDir, appRecord, files: { 'backend/data/app.db': 'backup!' } });
  const restoreFiles = await manager.buildRestorePlan(backupDir, installDir, metadata);
  const originalRename = fs.rename;
  fs.rename = async (source, destination) => {
    const from = String(source);
    if (from.includes(`${path.sep}staged${path.sep}`) || from.includes(`${path.sep}rollback${path.sep}`)) {
      throw new Error(from.includes(`${path.sep}rollback${path.sep}`) ? 'rollback failed' : 'commit failed');
    }
    return await originalRename(source, destination);
  };
  t.after(() => { fs.rename = originalRename; });
  await assert.rejects(
    manager.applyRestorePlan(backupDir, installDir, restoreFiles),
    (error) => error instanceof AggregateError && error.message === 'backup_restore_rollback_failed',
  );
});

test('BackupsManager removes newly-created restore parents when the target becomes invalid', async (t) => {
  const { manager, installDir, appRecord, root } = await fixture(t, 'forger-backups-b18-created-parent');
  const backupDir = path.join(root, 'remote');
  const metadata = await writeRemoteBackup({ backupDir, appRecord, files: { 'new/deep/app.db': 'database' } });
  const restoreFiles = await manager.buildRestorePlan(backupDir, installDir, metadata);
  const target = restoreFiles[0].targetPath;
  const originalLstat = fs.lstat;
  fs.lstat = async (candidate) => {
    if (path.resolve(String(candidate)) === path.resolve(target)) {
      return { isFile: () => false };
    }
    return await originalLstat(candidate);
  };
  t.after(() => { fs.lstat = originalLstat; });
  await assert.rejects(manager.applyRestorePlan(backupDir, installDir, restoreFiles), /unsafe_backup_restore_path/);
  assert.equal(await fs.stat(path.join(installDir, 'new')).then(() => true, () => false), false);

  const missing = await manager.missingRestoreParents(installDir, path.join(installDir, 'future', 'nested'));
  assert.deepEqual(missing, [path.join(installDir, 'future', 'nested'), path.join(installDir, 'future')]);
});
