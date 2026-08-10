import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BackupsManager } = require('../../dist-electron/main/backups-manager.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

test('BackupsManager does not mutate targets when staging the complete restore set fails', async (t) => {
  const root = await tmpRoot('backups-restore-stage-failure');
  const originalCopyFile = fs.copyFile;
  t.after(async () => {
    fs.copyFile = originalCopyFile;
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'metadata', 'backups');
  const dataDir = path.join(installDir, 'backend', 'data');
  const firstPath = path.join(dataDir, 'first.sqlite3');
  const secondPath = path.join(dataDir, 'second.sqlite3');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(firstPath, 'backup-first', 'utf8');
  await fs.writeFile(secondPath, 'backup-second', 'utf8');
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: () => appRecord,
    isAppRunning: () => false,
  });
  const created = await manager.createBackup({ appId: 'demo-app' });
  await fs.writeFile(firstPath, 'current-first', 'utf8');
  await fs.writeFile(secondPath, 'current-second', 'utf8');

  fs.copyFile = async (source, target, mode) => {
    if (String(target).includes(`${path.sep}.forger-restore-`) && String(target).endsWith(`${path.sep}staged${path.sep}1`)) {
      throw new Error('deterministic staging failure');
    }
    return await originalCopyFile(source, target, mode);
  };

  await assert.rejects(
    manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId }),
    /deterministic staging failure/,
  );
  assert.equal(await fs.readFile(firstPath, 'utf8'), 'current-first');
  assert.equal(await fs.readFile(secondPath, 'utf8'), 'current-second');
});

test('BackupsManager stages every restore file and rolls all targets back when a later commit fails', async (t) => {
  const root = await tmpRoot('backups-restore-rollback');
  const originalRename = fs.rename;
  t.after(async () => {
    fs.rename = originalRename;
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'metadata', 'backups');
  const dataDir = path.join(installDir, 'backend', 'data');
  const firstPath = path.join(dataDir, 'first.sqlite3');
  const secondPath = path.join(dataDir, 'second.sqlite3');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(firstPath, 'backup-first', 'utf8');
  await fs.writeFile(secondPath, 'backup-second', 'utf8');
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: () => appRecord,
    isAppRunning: () => false,
  });
  const created = await manager.createBackup({ appId: 'demo-app' });
  await fs.writeFile(firstPath, 'current-first', 'utf8');
  await fs.writeFile(secondPath, 'current-second', 'utf8');

  fs.rename = async (source, target) => {
    if (String(source).includes(`${path.sep}staged${path.sep}`) && path.resolve(String(target)) === path.resolve(secondPath)) {
      const error = new Error('deterministic commit failure');
      error.code = 'EPERM';
      throw error;
    }
    return await originalRename(source, target);
  };

  await assert.rejects(
    manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId }),
    /deterministic commit failure/,
  );
  assert.equal(await fs.readFile(firstPath, 'utf8'), 'current-first');
  assert.equal(await fs.readFile(secondPath, 'utf8'), 'current-second');
  assert.deepEqual(
    (await fs.readdir(installDir)).filter((entry) => entry.startsWith('.forger-restore-')),
    [],
  );
});

test('BackupsManager replaces existing targets without relying on POSIX rename-overwrite semantics', async (t) => {
  const root = await tmpRoot('backups-restore-windows-rename');
  const originalRename = fs.rename;
  t.after(async () => {
    fs.rename = originalRename;
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'metadata', 'backups');
  const databasePath = path.join(installDir, 'backend', 'data', 'app.sqlite3');
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.writeFile(databasePath, 'backup-db', 'utf8');
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: () => appRecord,
    isAppRunning: () => false,
  });
  const created = await manager.createBackup({ appId: 'demo-app' });
  await fs.writeFile(databasePath, 'current-db', 'utf8');

  fs.rename = async (source, target) => {
    if (await fs.lstat(target).catch(() => null)) {
      const error = new Error('destination exists');
      error.code = 'EEXIST';
      throw error;
    }
    return await originalRename(source, target);
  };

  const restored = await manager.restoreBackup({ appId: 'demo-app', backupId: created.backup.backupId });
  assert.equal(restored.success, true);
  assert.equal(await fs.readFile(databasePath, 'utf8'), 'backup-db');
});

test('BackupsManager rejects remote metadata targeting files outside the declared persistent-data contract', async (t) => {
  const root = await tmpRoot('backups-remote-persistent-contract');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const installDir = path.join(root, 'apps', 'demo-app');
  const backupsRoot = path.join(root, 'metadata', 'backups');
  const databasePath = path.join(installDir, 'backend', 'data', 'app.sqlite3');
  const manifestPath = path.join(installDir, 'manifest.json');
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.writeFile(databasePath, 'backup-db', 'utf8');
  await fs.writeFile(manifestPath, JSON.stringify({ services: [] }), 'utf8');
  const appRecord = { appId: 'demo-app', name: 'Demo App', version: '1.0.0', installDir };
  const manager = new BackupsManager({
    backupsRoot,
    listInstalledApps: () => [appRecord],
    getInstalledApp: () => appRecord,
    isAppRunning: () => false,
  });
  const created = await manager.createBackup({ appId: 'demo-app' });
  const backupDir = manager.backupDirectory('demo-app', created.backup.backupId);
  const metadataPath = path.join(backupDir, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.files[0].sourceRelativePath = 'manifest.json';
  await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');

  await assert.rejects(
    manager.restoreBackupDirectory({ appId: 'demo-app', backupDir }),
    /remote_backup_target_not_persistent/,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')), { services: [] });
});
