import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);

test('cloud storage usage is exposed through preload and main IPC', async () => {
  const ipcSource = await readFile(path.join(root, 'src/shared/ipc.ts'), 'utf8');
  const preloadSource = await readFile(path.join(root, 'src/preload/index.ts'), 'utf8');
  const handlersSource = await readFile(path.join(root, 'src/main/ipc/main-handlers.ts'), 'utf8');

  assert.match(ipcSource, /getCloudStorageUsage:\s*'forger:cloud-storage:get'/);
  assert.match(preloadSource, /getCloudStorageUsage:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.getCloudStorageUsage\)/);
  assert.match(handlersSource, /ipcMain\.handle\(IPC_CHANNELS\.getCloudStorageUsage/);
  assert.match(handlersSource, /forgerBackendClient\.getCloudStorageUsage\(\)/);
});

test('account menu renders compact localized cloud storage usage', async () => {
  const topbarSource = await readFile(path.join(root, 'src/renderer/components/Topbar.tsx'), 'utf8');

  assert.match(topbarSource, /cloudStorageUsage:\s*CloudStorageUsage\s*\|\s*null/);
  assert.match(topbarSource, /t\.settings\.storageCloudTitle/);
  assert.match(topbarSource, /t\.settings\.storageUsedOfLimit/);
  assert.match(topbarSource, /t\.settings\.storageMenuBreakdown/);
  assert.match(topbarSource, /onOpenStorageSettings/);
  assert.match(topbarSource, /t\.settings\.storageManage/);
});

test('settings exposes a localized storage layer with real management routes', async () => {
  const settingsSource = await readFile(path.join(root, 'src/renderer/views/SettingsView.tsx'), 'utf8');
  const englishSource = await readFile(path.join(root, 'src/renderer/i18n/en.ts'), 'utf8');
  const spanishSource = await readFile(path.join(root, 'src/renderer/i18n/es.ts'), 'utf8');

  assert.match(settingsSource, /storageTitle/);
  assert.match(settingsSource, /renderStorage/);
  assert.match(settingsSource, /onNavigate\('backups'\)/);
  assert.match(settingsSource, /onNavigate\('friends'\)/);
  assert.match(settingsSource, /t\.settings\.storageDiagnosticsExcluded/);
  assert.match(settingsSource, /t\.settings\.storageBreakdownUploadedAppsDescription/);

  for (const key of [
    'storageTitle',
    'storageCloudTitle',
    'storageManage',
    'storageManageBackups',
    'storageManageUploadedApps',
    'storageDiagnosticsExcluded',
  ]) {
    assert.match(englishSource, new RegExp(`${key}:`));
    assert.match(spanishSource, new RegExp(`${key}:`));
  }
});

test('cloud backups are available to any signed-in cloud account tier', async () => {
  const backupsSource = await readFile(path.join(root, 'src/renderer/views/BackupsView.tsx'), 'utf8');
  const registryStoreSource = await readFile(path.join(root, 'src/main/installed-apps/registry-store.ts'), 'utf8');
  const spanishSectionsSource = await readFile(path.join(root, 'src/renderer/i18n/locales/esSections.ts'), 'utf8');
  const englishSectionsSource = await readFile(path.join(root, 'src/renderer/i18n/locales/enSections.ts'), 'utf8');

  assert.match(backupsSource, /const cloudAllowed = Boolean\(account\.authenticated\)/);
  assert.doesNotMatch(backupsSource, /subscriptionTier === 'demo'/);
  assert.match(registryStoreSource, /tier === 'free'/);
  assert.match(registryStoreSource, /tier === 'demo'/);
  assert.match(registryStoreSource, /tier === 'pro'/);
  assert.doesNotMatch(spanishSectionsSource, /demo o pro/);
  assert.doesNotMatch(englishSectionsSource, /demo or pro/);
});
