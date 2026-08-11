import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';

const tmpRoot = async (name) => fs.mkdtemp(path.join(os.tmpdir(), `forger-b20-${name}-`));

const createSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8').replace(/^sealed:/, ''),
});

test('Given connection and provider credentials, when their lifecycle is exercised, then values remain encrypted, isolated, and removable', async (t) => {
  const root = await tmpRoot('secrets-lifecycle');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/secrets-store.js');
    const { SecretsStore } = require('../../dist-electron/main/secrets-store.js');
    const store = new SecretsStore(root);

    assert.equal((await store.createUserSecret({ name: 'Token', value: 7 })).technicalCode, 'secret_value_required');
    assert.equal((await store.setConnectionSecret('', 'token', 'value')).technicalCode, 'invalid_connection_secret');
    assert.equal((await store.setConnectionSecret('whatsapp', '', 'value')).technicalCode, 'invalid_connection_secret');
    assert.equal((await store.setConnectionSecret('whatsapp', 'token', '')).technicalCode, 'invalid_connection_secret');
    assert.equal((await store.setConnectionSecret(7, 'token', 'value')).technicalCode, 'invalid_connection_secret');
    assert.equal((await store.setConnectionSecret(' whatsapp ', ' token ', 'first')).success, true);
    assert.equal((await store.setConnectionSecret('whatsapp', 'refresh', 'second')).success, true);
    assert.equal(await store.getConnectionSecret('whatsapp', 'token'), 'first');
    assert.equal(await store.getConnectionSecret('whatsapp', 'missing'), null);
    assert.equal(await store.hasConnectionSecret('whatsapp', 'refresh'), true);
    assert.equal(await store.hasConnectionSecret('missing', 'refresh'), false);
    assert.equal((await store.deleteConnectionSecrets('whatsapp')).success, true);
    assert.equal(await store.hasConnectionSecret('whatsapp', 'token'), false);

    assert.equal((await store.setProviderProfileSecret('', 'api-key', 'value')).technicalCode, 'invalid_provider_profile_secret');
    assert.equal((await store.setProviderProfileSecret('openai', '', 'value')).technicalCode, 'invalid_provider_profile_secret');
    assert.equal((await store.setProviderProfileSecret('openai', 'api-key', '')).technicalCode, 'invalid_provider_profile_secret');
    assert.equal((await store.setProviderProfileSecret(9, 'api-key', 'value')).technicalCode, 'invalid_provider_profile_secret');
    assert.equal((await store.setProviderProfileSecret(' openai ', ' api-key ', 'provider-secret')).success, true);
    assert.equal((await store.setProviderProfileSecret('openai', 'organization', 'org-1')).success, true);
    assert.equal(await store.getProviderProfileSecret('openai', 'api-key'), 'provider-secret');
    assert.equal(await store.getProviderProfileSecret('openai', 'missing'), null);
    assert.equal(await store.hasProviderProfileSecret('openai', 'organization'), true);
    assert.equal(await store.hasProviderProfileSecret('missing', 'organization'), false);
    assert.equal((await store.deleteProviderProfileSecrets('openai')).success, true);
    assert.equal(await store.hasProviderProfileSecret('openai', 'api-key'), false);

    const persisted = await fs.readFile(path.join(root, 'secrets.vault.json'), 'utf8');
    assert.equal(persisted.includes('provider-secret'), false);
    assert.equal(persisted.includes('first'), false);
  });
});

test('Given unavailable encryption or an unreadable vault, when scoped credentials mutate, then safe public errors are returned', async (t) => {
  const root = await tmpRoot('secrets-errors');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const safeStorage = createSafeStorage();

  await withMockedElectron({ safeStorage }, async (require) => {
    clearDistModule('main/secrets-store.js');
    const { SecretsStore, SecretsVaultUnavailableError, isSecretsVaultUnavailableError } = require('../../dist-electron/main/secrets-store.js');
    assert.equal(isSecretsVaultUnavailableError(new SecretsVaultUnavailableError()), true);
    assert.equal(isSecretsVaultUnavailableError(new Error('other')), false);

    safeStorage.isEncryptionAvailable = () => false;
    const unavailable = new SecretsStore(path.join(root, 'encryption-unavailable'));
    assert.equal((await unavailable.setConnectionSecret('whatsapp', 'token', 'value')).technicalCode, 'secrets_encryption_unavailable');
    assert.equal((await unavailable.deleteConnectionSecrets('whatsapp')).technicalCode, 'secrets_encryption_unavailable');
    assert.equal((await unavailable.setProviderProfileSecret('openai', 'api-key', 'value')).technicalCode, 'secrets_encryption_unavailable');
    assert.equal((await unavailable.deleteProviderProfileSecrets('openai')).technicalCode, 'secrets_encryption_unavailable');

    safeStorage.isEncryptionAvailable = () => true;
    const invalidRoot = path.join(root, 'invalid');
    await fs.mkdir(invalidRoot, { recursive: true });
    await fs.writeFile(path.join(invalidRoot, 'secrets.vault.json'), '{invalid', 'utf8');
    const invalid = new SecretsStore(invalidRoot);
    assert.equal((await invalid.setConnectionSecret('whatsapp', 'token', 'value')).technicalCode, 'secrets_vault_unavailable');
    assert.equal((await invalid.deleteConnectionSecrets('whatsapp')).technicalCode, 'secrets_vault_unavailable');
    assert.equal((await invalid.setProviderProfileSecret('openai', 'api-key', 'value')).technicalCode, 'secrets_vault_unavailable');
    assert.equal((await invalid.deleteProviderProfileSecrets('openai')).technicalCode, 'secrets_vault_unavailable');
  });
});

test('Given a vault from before scoped secret collections existed, when it loads, then missing collections migrate to empty maps', async (t) => {
  const root = await tmpRoot('secrets-legacy-scoped');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'secrets.vault.json'), JSON.stringify({
    version: 1,
    secrets: {},
    appMappings: {},
  }), 'utf8');

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/secrets-store.js');
    const { SecretsStore } = require('../../dist-electron/main/secrets-store.js');
    const store = new SecretsStore(root);

    assert.equal(await store.getConnectionSecret('whatsapp', 'token'), null);
    assert.equal(await store.hasConnectionSecret('whatsapp', 'token'), false);
    assert.equal(await store.getProviderProfileSecret('openai', 'api-key'), null);
    assert.equal(await store.hasProviderProfileSecret('openai', 'api-key'), false);
  });
});

test('Given an atomic vault rename failure, when saving, then the temporary file is removed and the original error is preserved', async (t) => {
  const root = await tmpRoot('secrets-atomic-failure');
  const originalRename = fs.rename;
  t.after(async () => {
    fs.rename = originalRename;
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/secrets-store.js');
    const { SecretsStore } = require('../../dist-electron/main/secrets-store.js');
    fs.rename = async () => { throw new Error('atomic rename failed'); };
    const store = new SecretsStore(root);

    await assert.rejects(store.createUserSecret({ name: 'Token', value: 'sensitive' }), /atomic rename failed/);
    assert.deepEqual((await fs.readdir(root)).filter((entry) => entry.endsWith('.tmp')), []);
  });
});
