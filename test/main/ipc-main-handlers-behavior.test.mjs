import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createIpcMainRecorder } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');
const { registerMainIpcHandlers } = require('../../dist-electron/main/ipc/main-handlers.js');

const createDeps = (overrides = {}) => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const logs = [];
  const deps = {
    APP_CLAUDE_MODEL_OPTIONS: [],
    APP_CODEX_MODEL_OPTIONS: [],
    BetterSqlite3: null,
    BrowserWindow: { fromWebContents: () => null },
    CODEX_USAGE_DASHBOARD_URL: 'https://platform.openai.com/usage',
    IPC_CHANNELS,
    app: {
      getVersion: () => '0.0.0-test',
      getPath: () => '/tmp/forger-user-data',
    },
    appAgentConversationManager: null,
    appendInstallLog: async (event, payload) => logs.push({ event, payload }),
    canUseCloudDataSync: () => false,
    chatOrchestrator: null,
    cloudDeviceManager: null,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ensureCatalogStatuses: () => undefined,
    failureDiagnostic: (error, fallbackCode) => ({
      technicalCode: error instanceof Error ? error.message : fallbackCode,
    }),
    forgerBackendClient: null,
    forwardCloudSocialEvent: () => undefined,
    fs,
    getConnectionsService: () => ({
      call: async () => ({}),
      configure: async () => ({}),
      disconnect: async () => ({}),
      listState: async () => ({ types: [], instances: [] }),
      setDefaultConnection: async () => ({}),
    }),
    getInstallLogPath: () => '/tmp/forger-install.log',
    ipcMain,
    listCatalogFromBackend: async () => [],
    mainWindow: null,
    path,
    publicForgerAccount: (account) => ({ authenticated: Boolean(account.authenticated) }),
    registry: { apps: {} },
    resolveInstalledManifest: async () => null,
    resolveSelectedAppDisplayName: (appId) => appId,
    sanitizeRendererChatTrace: (input) => ({ traceEvent: input.event }),
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    shell: { openExternal: async () => undefined },
    state: {
      agentToolSettings: { approvals: {} },
      catalogApps: [],
      cloudSyncSettings: {},
      forgerAccount: { authenticated: false },
      settings: {},
    },
    toAppSummary: (record) => record,
    ...overrides,
  };

  registerMainIpcHandlers(deps);
  return { deps, handlers, logs };
};

test('rename installed app validates ownership and input before touching the manifest', async () => {
  const { handlers } = createDeps({
    registry: {
      apps: {
        'not-owned': { appId: 'not-owned', installDir: '/apps/not-owned' },
        'no-dir': { appId: 'no-dir' },
      },
    },
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.renameInstalledApp)(null, { appId: 'missing', name: 'Nueva' }), {
    success: false,
    userMessage: 'No encontramos esta app instalada.',
    technicalCode: 'app_not_installed',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.renameInstalledApp)(null, { appId: 'no-dir', name: 'Nueva' }), {
    success: false,
    userMessage: 'No encontramos esta app instalada.',
    technicalCode: 'app_not_installed',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.renameInstalledApp)(null, { appId: 'not-owned', name: '   ' }), {
    success: false,
    userMessage: 'Escribe un nombre para la app.',
    technicalCode: 'app_name_required',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.renameInstalledApp)(null, { appId: 'not-owned', name: 'Nueva' }), {
    success: false,
    userMessage: 'Solo puedes cambiar el nombre de apps tuyas o remixes.',
    technicalCode: 'app_rename_not_owned_or_remixable',
  });
});

test('rename installed app surfaces manifest failures as a local rename error', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-rename-invalid-'));
  try {
    await fs.writeFile(path.join(root, 'manifest.json'), '[]', 'utf8');
    const { handlers } = createDeps({
      registry: {
        apps: {
          'demo-app': { appId: 'demo-app', installDir: root, privateLocal: true },
        },
      },
    });

    assert.deepEqual(await handlers.get(IPC_CHANNELS.renameInstalledApp)(null, { appId: 'demo-app', name: 'Nueva' }), {
      success: false,
      userMessage: 'No pudimos cambiar el nombre de esta app.',
      technicalCode: 'app_manifest_invalid',
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rename installed app persists the manifest display name and updates local state for private apps', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-rename-local-'));
  try {
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ id: 'demo-app' }), 'utf8');
    const upserts = [];
    const record = { appId: 'demo-app', installDir: root, privateLocal: true, name: 'Vieja' };
    const { handlers, deps } = createDeps({
      registry: { apps: { 'demo-app': record } },
      state: {
        agentToolSettings: { approvals: {} },
        catalogApps: [{ id: 'demo-app', name: 'Vieja' }, { id: 'other', name: 'Other' }],
        cloudSyncSettings: {},
        forgerAccount: { authenticated: false },
        settings: {},
      },
      toAppSummary: (entry) => ({ id: entry.appId, name: entry.name }),
      upsertInstalledRecord: async (entry) => upserts.push(entry),
    });

    assert.deepEqual(await handlers.get(IPC_CHANNELS.renameInstalledApp)(null, { appId: 'demo-app', name: '  Nueva App  ' }), {
      success: true,
      userMessage: 'Nombre actualizado.',
      app: { id: 'demo-app', name: 'Vieja' },
      cloudSynced: false,
    });
    assert.deepEqual(upserts, [{ ...record, name: 'Nueva App' }]);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.catalog.display_name, 'Nueva App');
    assert.deepEqual(deps.state.catalogApps, [
      { id: 'demo-app', name: 'Nueva App' },
      { id: 'other', name: 'Other' },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rename installed app reports cloud sync outcomes for social apps', async () => {
  const makeRoot = async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-rename-cloud-'));
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ catalog: { display_name: 'Vieja' } }), 'utf8');
    return root;
  };
  const rootA = await makeRoot();
  const rootB = await makeRoot();
  const rootC = await makeRoot();
  try {
    const noBackend = createDeps({
      registry: {
        apps: { 'demo-app': { appId: 'demo-app', installDir: rootA, socialSource: { userAppId: 42 } } },
      },
      upsertInstalledRecord: async () => undefined,
    });
    const offline = await noBackend.handlers.get(IPC_CHANNELS.renameInstalledApp)(null, { appId: 'demo-app', name: 'Nueva' });
    assert.equal(offline.success, true);
    assert.equal(offline.cloudSynced, false);
    assert.equal(offline.technicalCode, 'backend_client_missing');

    const cloudCalls = [];
    const synced = createDeps({
      forgerBackendClient: {
        updateSocialApp: async (input) => cloudCalls.push(input),
      },
      registry: {
        apps: {
          'demo-app': {
            appId: 'demo-app',
            installDir: rootB,
            privateLocal: true,
            publishedSocialSource: { userAppId: 77 },
          },
        },
      },
      upsertInstalledRecord: async () => undefined,
    });
    assert.deepEqual(await synced.handlers.get(IPC_CHANNELS.renameInstalledApp)(null, { appId: 'demo-app', name: 'Nueva' }), {
      success: true,
      userMessage: 'Nombre actualizado.',
      app: { appId: 'demo-app', installDir: rootB, privateLocal: true, publishedSocialSource: { userAppId: 77 } },
      cloudSynced: true,
    });
    assert.deepEqual(cloudCalls, [{ id: 77, name: 'Nueva' }]);

    const failing = createDeps({
      forgerBackendClient: {
        updateSocialApp: async () => {
          throw new Error('social_update_rejected');
        },
      },
      registry: {
        apps: { 'demo-app': { appId: 'demo-app', installDir: rootC, socialSource: { userAppId: 42 } } },
      },
      upsertInstalledRecord: async () => undefined,
    });
    const failed = await failing.handlers.get(IPC_CHANNELS.renameInstalledApp)(null, { appId: 'demo-app', name: 'Nueva' });
    assert.equal(failed.success, true);
    assert.equal(failed.cloudSynced, false);
    assert.equal(failed.technicalCode, 'social_update_rejected');
    assert.equal(failed.userMessage, 'El nombre cambió en este equipo, pero no pudimos actualizar tu perfil de Forger.');
  } finally {
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
    await fs.rm(rootC, { recursive: true, force: true });
  }
});

const createTaskStoreRecorder = () => {
  const upserts = [];
  const statusUpdates = [];
  return {
    upserts,
    statusUpdates,
    store: {
      upsert: async (input) => {
        upserts.push(input);
        return input;
      },
      appendStatusUpdate: async (taskId, update) => statusUpdates.push([taskId, update]),
      list: async () => [{ id: 'task-1' }],
      get: async (id) => ({ id }),
    },
  };
};

test('social upload fails fast with a background task record when the account or ownership is missing', async () => {
  const missingBackend = createTaskStoreRecorder();
  const noBackend = createDeps({
    getBackgroundTaskStore: () => missingBackend.store,
    registry: {
      apps: { 'demo-app': { appId: 'demo-app', installDir: '/apps/demo-app', privateLocal: true, name: 'Demo' } },
    },
  });
  assert.deepEqual(await noBackend.handlers.get(IPC_CHANNELS.uploadSocialApp)(null, { appId: 'demo-app' }), {
    success: false,
    userMessage: 'Inicia sesion en Forger Cloud para subir apps a Social.',
    technicalCode: 'backend_client_missing',
  });
  assert.equal(missingBackend.upserts.length, 2);
  assert.equal(missingBackend.upserts[0].status, 'queued');
  assert.equal(missingBackend.upserts[0].title, 'Subiendo Demo a Social');
  assert.equal(missingBackend.upserts[1].status, 'failed');
  assert.equal(missingBackend.upserts[1].result.technicalCode, 'backend_client_missing');

  const notOwned = createTaskStoreRecorder();
  const withBackend = createDeps({
    forgerBackendClient: { uploadSocialApp: async () => ({}) },
    getBackgroundTaskStore: () => notOwned.store,
    registry: {
      apps: { 'store-app': { appId: 'store-app', installDir: '/apps/store-app', name: 'Store App' } },
    },
  });
  assert.deepEqual(await withBackend.handlers.get(IPC_CHANNELS.uploadSocialApp)(null, { appId: 'store-app' }), {
    success: false,
    userMessage: 'Solo puedes subir a Social apps tuyas o remixes de apps compartidas.',
    technicalCode: 'social_upload_not_owned_or_remixable',
  });
  assert.equal(notOwned.upserts[1].status, 'failed');
  assert.equal(notOwned.upserts[1].result.technicalCode, 'social_upload_not_owned_or_remixable');
});

test('social upload stages a filtered copy of the app, uploads it, and records the published source', async () => {
  const installDir = await fs.mkdtemp(path.join(tmpdir(), 'forger-social-src-'));
  try {
    await fs.mkdir(path.join(installDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(installDir, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(installDir, 'data'), { recursive: true });
    await fs.writeFile(path.join(installDir, 'app.py'), 'print("hola")', 'utf8');
    await fs.writeFile(path.join(installDir, 'src', 'main.py'), 'main', 'utf8');
    await fs.writeFile(path.join(installDir, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
    await fs.writeFile(path.join(installDir, 'data', 'store.sqlite'), 'db', 'utf8');
    await fs.writeFile(path.join(installDir, '.env.local'), 'SECRET=1', 'utf8');

    const taskStore = createTaskStoreRecorder();
    const stagedFiles = [];
    const uploads = [];
    const upserts = [];
    const listStagedFiles = async (dir, prefix = '') => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await listStagedFiles(path.join(dir, entry.name), rel);
        } else {
          stagedFiles.push(rel);
        }
      }
    };
    const record = {
      appId: 'demo-app',
      installDir,
      socialSource: { userAppId: 42, slug: 'demo-app', ownerUsername: 'grace' },
      description: 'Descripción corta',
      name: 'Demo',
    };
    const { handlers, deps } = createDeps({
      forgerBackendClient: {
        uploadSocialApp: async (input) => {
          uploads.push(input);
          await input.onProgress('Subiendo archivo 1/1');
          return { id: 77, name: 'Registro Fácil', slug: 'registro-facil', owner: { username: 'ada' } };
        },
        createSocialAppShare: async (userAppId) => ({ userAppId, deepLink: 'https://forger.app/s/registro-facil' }),
      },
      getBackgroundTaskStore: () => taskStore.store,
      registry: { apps: { 'demo-app': record } },
      resolveInstalledManifest: async () => ({ catalog: { category: 'finance' } }),
      state: {
        agentToolSettings: { approvals: {} },
        catalogApps: [{ id: 'demo-app', name: 'Demo' }],
        cloudSyncSettings: {},
        forgerAccount: { authenticated: true },
        settings: {},
      },
      upsertInstalledRecord: async (entry) => upserts.push(entry),
      validateArchiveEntries: async (zipPath) => {
        await fs.access(zipPath);
      },
      zipDirectory: async (sourceDir, zipPath) => {
        await listStagedFiles(sourceDir);
        await fs.writeFile(zipPath, 'PK-zip', 'utf8');
      },
    });

    const result = await handlers.get(IPC_CHANNELS.uploadSocialApp)(null, {
      appId: 'demo-app',
      name: 'Registro Fácil ✨',
      visibility: 'public',
    });

    assert.equal(result.success, true);
    assert.equal(result.userMessage, 'App subida a Social.');
    assert.equal(result.app.id, 77);
    assert.equal(result.share.deepLink, 'https://forger.app/s/registro-facil');

    stagedFiles.sort();
    assert.deepEqual(stagedFiles, ['demo-app/app.py', 'demo-app/src/main.py'], 'staging must drop node_modules, data DBs, and .env files');

    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].name, 'Registro Fácil ✨');
    assert.equal(uploads[0].slug, 'registro-facil', 'remix uploads derive a slug from the app name');
    assert.equal(uploads[0].category, 'finance');
    assert.equal(uploads[0].longDescription, 'Descripción corta');
    assert.equal(uploads[0].remixSourceUserAppId, 42);

    assert.deepEqual(upserts, [{
      ...record,
      name: 'Registro Fácil',
      publishedSocialSource: { userAppId: 77, slug: 'registro-facil', ownerUsername: 'ada' },
    }]);
    assert.deepEqual(deps.state.catalogApps, [{ id: 'demo-app', name: 'Registro Fácil' }]);

    const finalTask = taskStore.upserts.at(-1);
    assert.equal(finalTask.status, 'succeeded');
    assert.equal(finalTask.result.message, 'App subida a Social. https://forger.app/s/registro-facil');
    assert.deepEqual(taskStore.statusUpdates.map(([, update]) => update.message), [
      'Preparando app',
      'Comprimiendo app',
      'Subiendo a Social',
      'Subiendo archivo 1/1',
      'Creando link para compartir',
    ]);
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test('social upload converts packaging failures into a failed background task and user error', async () => {
  const installDir = await fs.mkdtemp(path.join(tmpdir(), 'forger-social-fail-'));
  try {
    await fs.writeFile(path.join(installDir, 'app.py'), 'print("hola")', 'utf8');
    const taskStore = createTaskStoreRecorder();
    const { handlers } = createDeps({
      forgerBackendClient: {
        uploadSocialApp: async () => {
          throw new Error('should_not_upload');
        },
      },
      getBackgroundTaskStore: () => taskStore.store,
      registry: {
        apps: { 'demo-app': { appId: 'demo-app', installDir, privateLocal: true, name: 'Demo' } },
      },
      validateArchiveEntries: async () => undefined,
      zipDirectory: async () => {
        throw new Error('zip_failed');
      },
    });

    assert.deepEqual(await handlers.get(IPC_CHANNELS.uploadSocialApp)(null, { appId: 'demo-app', slug: 'demo-app' }), {
      success: false,
      userMessage: 'No pudimos subir la app a Social.',
      technicalCode: 'zip_failed',
    });
    const finalTask = taskStore.upserts.at(-1);
    assert.equal(finalTask.status, 'failed');
    assert.equal(finalTask.result.technicalCode, 'zip_failed');
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

const BACKEND_DELEGATED_CHANNELS = [
  ['updateSocialApp', 'updateSocialApp', [{ id: 7, name: 'Nueva' }]],
  ['updateSocialAppVisibility', 'updateSocialAppVisibility', [7, 'private']],
  ['deleteSocialApp', 'deleteSocialApp', [7]],
  ['createSocialAppShare', 'createSocialAppShare', [7]],
  ['resolveSocialCode', 'resolveSocialCode', ['ABC123']],
  ['resolveSocialApp', 'resolveSocialApp', [7]],
  ['getSocialProfile', 'getSocialProfile', ['ada']],
  ['getForumParticipation', 'getForumParticipation', []],
  ['updateForumParticipation', 'updateForumParticipation', ['join']],
  ['listForumPosts', 'listForumPosts', [25]],
  ['getForumPost', 'getForumPost', [3]],
  ['createForumPost', 'createForumPost', ['hola foro']],
  ['createForumComment', 'createForumComment', [3, 'comentario']],
  ['replyForumComment', 'replyForumComment', [9, 'respuesta']],
  ['deleteForumPost', 'deleteForumPost', [3]],
  ['deleteForumComment', 'deleteForumComment', [9]],
  ['moderateForumPost', 'moderateForumPost', [3, 'hide', 'spam']],
  ['moderateForumComment', 'moderateForumComment', [9, 'hide', 'spam']],
];

test('social and forum channels reject with backend_client_missing when the cloud client is unavailable', async () => {
  const { handlers } = createDeps();

  for (const [channelKey, , args] of BACKEND_DELEGATED_CHANNELS) {
    await assert.rejects(
      handlers.get(IPC_CHANNELS[channelKey])(null, ...args),
      /backend_client_missing/,
      `${channelKey} should reject without a backend client`,
    );
  }
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCloudStorageUsage)(), null);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listMySocialApps)(), { apps: [] });
});

test('social and forum channels delegate to the backend client with the renderer arguments', async () => {
  const calls = [];
  const backend = {};
  for (const [, method] of BACKEND_DELEGATED_CHANNELS) {
    backend[method] = async (...args) => {
      calls.push([method, ...args]);
      return { method, args };
    };
  }
  backend.socialProfileUrl = (username) => {
    calls.push(['socialProfileUrl', username]);
    return `https://forger.app/u/${username}`;
  };
  backend.getCloudStorageUsage = async () => ({ usedBytes: 9 });
  backend.listMySocialApps = async () => ({ apps: [{ id: 7 }] });
  const { handlers } = createDeps({ forgerBackendClient: backend });

  for (const [channelKey, method, args] of BACKEND_DELEGATED_CHANNELS) {
    assert.deepEqual(
      await handlers.get(IPC_CHANNELS[channelKey])(null, ...args),
      { method, args },
      `${channelKey} should return the backend result`,
    );
  }
  assert.equal(await handlers.get(IPC_CHANNELS.getSocialProfileUrl)(null, 'ada'), 'https://forger.app/u/ada');
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getCloudStorageUsage)(), { usedBytes: 9 });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.listMySocialApps)(), { apps: [{ id: 7 }] });
  assert.deepEqual(
    calls.filter(([name]) => name === 'moderateForumPost'),
    [['moderateForumPost', 3, 'hide', 'spam']],
  );

  const missingProfileUrl = createDeps();
  await assert.rejects(
    missingProfileUrl.handlers.get(IPC_CHANNELS.getSocialProfileUrl)(null, 'ada'),
    /backend_client_missing/,
  );
});

test('cloud device pairing channels return safe fallbacks without a device manager and delegate with one', async () => {
  const withoutManager = createDeps();
  const fallbackCases = [
    ['registerCloudDevice', [{ name: 'Mac' }], 'No pudimos registrar este equipo.'],
    ['unlinkMobileDeviceFromDesktop', [11], 'No pudimos desvincular el dispositivo.'],
    ['acceptMobilePairingRequest', [12], 'No pudimos aceptar la solicitud.'],
    ['rejectMobilePairingRequest', [13], 'No pudimos rechazar la solicitud.'],
    ['deleteMobilePairingRequest', [14], 'No pudimos eliminar la solicitud.'],
  ];
  for (const [channelKey, args, userMessage] of fallbackCases) {
    assert.deepEqual(await withoutManager.handlers.get(IPC_CHANNELS[channelKey])(null, ...args), {
      devices: [],
      connected: false,
      success: false,
      userMessage,
      technicalCode: 'cloud_device_manager_missing',
    }, `${channelKey} fallback`);
  }

  const calls = [];
  const withManager = createDeps({
    cloudDeviceManager: {
      registerCloudDevice: async (input) => {
        calls.push(['registerCloudDevice', input]);
        return { success: true, registered: input.name };
      },
      unlinkMobileDeviceFromDesktop: async (authorizationId) => ({ success: true, authorizationId }),
      acceptMobilePairingRequest: async (requestId) => ({ success: true, accepted: requestId }),
      rejectMobilePairingRequest: async (requestId) => ({ success: true, rejected: requestId }),
      deleteMobilePairingRequest: async (requestId) => ({ success: true, deleted: requestId }),
    },
  });
  assert.deepEqual(await withManager.handlers.get(IPC_CHANNELS.registerCloudDevice)(null, { name: 'Studio' }), {
    success: true,
    registered: 'Studio',
  });
  assert.deepEqual(await withManager.handlers.get(IPC_CHANNELS.registerCloudDevice)(null, undefined), {
    success: true,
    registered: '',
  });
  assert.deepEqual(await withManager.handlers.get(IPC_CHANNELS.unlinkMobileDeviceFromDesktop)(null, 11), {
    success: true,
    authorizationId: 11,
  });
  assert.deepEqual(await withManager.handlers.get(IPC_CHANNELS.acceptMobilePairingRequest)(null, 12), {
    success: true,
    accepted: 12,
  });
  assert.deepEqual(await withManager.handlers.get(IPC_CHANNELS.rejectMobilePairingRequest)(null, 13), {
    success: true,
    rejected: 13,
  });
  assert.deepEqual(await withManager.handlers.get(IPC_CHANNELS.deleteMobilePairingRequest)(null, 14), {
    success: true,
    deleted: 14,
  });
  assert.deepEqual(calls, [
    ['registerCloudDevice', { name: 'Studio' }],
    ['registerCloudDevice', { name: '' }],
  ]);
});

test('speech-to-text channels delegate to the service including stop, audio picking, and uploads', async () => {
  const calls = [];
  const service = {
    getState: async () => ({ status: 'idle' }),
    stop: () => calls.push(['stop']),
    updateConfig: async (input) => ({ status: 'configured', input }),
    allowUserSelectedPath: async (selectedPath) => calls.push(['allowUserSelectedPath', selectedPath]),
    process: async (input, access) => {
      calls.push(['process', input, access]);
      return { text: 'transcrito' };
    },
    processUpload: async (input) => ({ text: 'upload', bytes: input.bytes }),
    createRealtimeSession: async () => ({ sessionId: 'rt-1' }),
  };
  const { handlers } = createDeps({
    dialog: {
      showOpenDialog: async (options) => {
        calls.push(['showOpenDialog', options.properties, options.filters[0].name]);
        return { canceled: false, filePaths: ['/tmp/audio.m4a'] };
      },
    },
    getPrivateDataRoot: () => '/tmp/forger-private-data',
    getSpeechToTextService: () => service,
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.speechToTextStop)(), { status: 'idle' });
  assert.deepEqual(calls[0], ['stop']);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.speechToTextUpdateConfig)(null, { language: 'es' }), {
    status: 'configured',
    input: { language: 'es' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.speechToTextPickAudio)(), {
    canceled: false,
    path: '/tmp/audio.m4a',
  });
  assert.deepEqual(calls.at(-1), ['allowUserSelectedPath', '/tmp/audio.m4a']);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.speechToTextProcess)(null, { path: '/tmp/audio.m4a' }), {
    text: 'transcrito',
  });
  assert.deepEqual(calls.at(-1), [
    'process',
    { path: '/tmp/audio.m4a' },
    { extraAllowedRoots: ['/tmp/forger-private-data'] },
  ]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.speechToTextProcessUpload)(null, { bytes: 12 }), {
    text: 'upload',
    bytes: 12,
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.speechToTextCreateRealtimeSession)(), { sessionId: 'rt-1' });
});

test('speech-to-text audio picker skips path allow-listing when the user cancels', async () => {
  const calls = [];
  const { handlers } = createDeps({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getSpeechToTextService: () => ({
      allowUserSelectedPath: async (selectedPath) => calls.push(['allowUserSelectedPath', selectedPath]),
    }),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.speechToTextPickAudio)(), { canceled: true, path: undefined });
  assert.deepEqual(calls, []);
});

test('text-to-speech, developer settings, and background task channels delegate with renderer input', async () => {
  const calls = [];
  const taskStore = createTaskStoreRecorder();
  const { handlers } = createDeps({
    getBackgroundTaskStore: () => taskStore.store,
    getDeveloperPathState: async (appId) => ({ appId: appId ?? null, developerMode: true }),
    getTextToSpeechService: () => ({
      getState: async () => ({ status: 'ready' }),
      stop: () => calls.push(['tts-stop']),
      updateConfig: async (input) => ({ status: 'configured', input }),
      synthesize: async (input) => ({ audioPath: '/tmp/out.wav', text: input.text }),
    }),
    updateAppDeveloperSettings: async (input) => ({ appId: input.appId, developerPath: input.developerPath }),
    updateDeveloperMode: async (input) => ({ developerMode: input.enabled }),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.textToSpeechStop)(), { status: 'ready' });
  assert.deepEqual(calls, [['tts-stop']]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.textToSpeechUpdateConfig)(null, { voice: 'es-CL' }), {
    status: 'configured',
    input: { voice: 'es-CL' },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.textToSpeechSynthesize)(null, { text: 'hola' }), {
    audioPath: '/tmp/out.wav',
    text: 'hola',
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateDeveloperMode)(null, { enabled: true }), {
    developerMode: true,
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.updateAppDeveloperSettings)(null, { appId: 'demo', developerPath: '/dev/demo' }), {
    appId: 'demo',
    developerPath: '/dev/demo',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getDeveloperPathState)(null, 'demo'), {
    appId: 'demo',
    developerMode: true,
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.backgroundTasksList)(), [{ id: 'task-1' }]);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.backgroundTaskGet)(null, 'task-1'), { id: 'task-1' });
  const upserted = await handlers.get(IPC_CHANNELS.backgroundTasksUpsert)(null, { id: 'task-2', status: 'queued' });
  assert.deepEqual(upserted, { id: 'task-2', status: 'queued' });
  assert.deepEqual(taskStore.upserts, [{ id: 'task-2', status: 'queued' }]);
});

test('remote share and activity channels delegate when wired and fall back to empty snapshots', async () => {
  const { handlers } = createDeps({
    getLlmRunsSnapshot: () => ({ items: [{ runId: 'run-1' }], activeCount: 1, errorCount: 0, updatedAt: 'now' }),
    getRemoteActivitySnapshot: () => ({ activities: [{ id: 'a1' }], activeCount: 1, preparingCount: 0, errorCount: 0, updatedAt: 'now' }),
    getRemoteNetworkShareStatus: (appId) => ({ active: true, appId }),
    startRemoteNetworkShare: async (appId) => ({ success: true, started: appId }),
    stopRemoteNetworkShare: async (appId) => ({ success: true, stopped: appId }),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.startRemoteNetworkShare)(null, 'demo-app'), {
    success: true,
    started: 'demo-app',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.stopRemoteNetworkShare)(null, 'demo-app'), {
    success: true,
    stopped: 'demo-app',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getRemoteNetworkShareStatus)(null, 'demo-app'), {
    active: true,
    appId: 'demo-app',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.getRemoteActivity)(), {
    activities: [{ id: 'a1' }],
    activeCount: 1,
    preparingCount: 0,
    errorCount: 0,
    updatedAt: 'now',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.llmRunsSnapshotGet)(), {
    items: [{ runId: 'run-1' }],
    activeCount: 1,
    errorCount: 0,
    updatedAt: 'now',
  });

  const defaults = createDeps();
  assert.equal(await defaults.handlers.get(IPC_CHANNELS.getRemoteNetworkShareStatus)(null, 'demo-app'), undefined);
  const emptyActivity = await defaults.handlers.get(IPC_CHANNELS.getRemoteActivity)();
  assert.deepEqual({ ...emptyActivity, updatedAt: 'checked' }, {
    activities: [],
    activeCount: 0,
    preparingCount: 0,
    errorCount: 0,
    updatedAt: 'checked',
  });
  assert.ok(!Number.isNaN(Date.parse(emptyActivity.updatedAt)));
  const emptyRuns = await defaults.handlers.get(IPC_CHANNELS.llmRunsSnapshotGet)();
  assert.deepEqual({ ...emptyRuns, updatedAt: 'checked' }, {
    items: [],
    activeCount: 0,
    errorCount: 0,
    updatedAt: 'checked',
  });
});

test('app creation, social review install flow, official tool calls, and app-share messages delegate', async () => {
  const calls = [];
  const { handlers } = createDeps({
    createLocalAppFromSkeleton: async (input, locale) => {
      calls.push(['createLocalApp', input, locale]);
      return { success: true, appId: 'local-1' };
    },
    deleteQuarantinedSocialApp: async (input, locale) => ({ success: true, deleted: input.quarantineId, locale }),
    finishSocialAppInstall: async (input, locale) => ({ success: true, appId: 'social-1', quarantineId: input.quarantineId, locale }),
    getOfficialToolsService: () => ({
      callFromAgent: async (input) => ({ output: `ran:${input.toolId}` }),
    }),
    prepareSocialAppReview: async (input, locale) => ({ success: true, quarantine: { id: 'q-1', shareCode: input.shareCode }, userMessage: 'ok', locale }),
    sendEncryptedCloudAppShareMessage: async (input) => ({ id: 31, ...input }),
  });

  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.createLocalApp)(null, { name: 'Mi App' }, 'es-CL'),
    { success: true, appId: 'local-1' },
  );
  assert.deepEqual(calls, [['createLocalApp', { name: 'Mi App' }, 'es-CL']]);
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.prepareSocialAppReview)(null, { shareCode: 'ABC' }, 'es-CL'),
    { success: true, quarantine: { id: 'q-1', shareCode: 'ABC' }, userMessage: 'ok', locale: 'es-CL' },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.finishSocialAppInstall)(null, { quarantineId: 'q-1' }, 'es-CL'),
    { success: true, appId: 'social-1', quarantineId: 'q-1', locale: 'es-CL' },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.deleteQuarantinedSocialApp)(null, { quarantineId: 'q-1' }, 'es-CL'),
    { success: true, deleted: 'q-1', locale: 'es-CL' },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.callOfficialTool)(null, { toolId: 'gmail.search_messages' }),
    { output: 'ran:gmail.search_messages' },
  );
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.sendCloudAppShareMessage)(null, { friendUserId: 4, userAppId: 77 }),
    { id: 31, friendUserId: 4, userAppId: 77 },
  );
});

test('antigravity auth session channels validate input and forward session events to the renderer', async () => {
  const sends = [];
  const calls = [];
  const { handlers } = createDeps({
    cancelAntigravityAuthSession: async (sessionId) => {
      calls.push(['cancel', sessionId]);
      return { success: true, canceled: sessionId };
    },
    mainWindow: { webContents: { send: (channel, payload) => sends.push([channel, payload]) } },
    startAntigravityAuthSession: async (onEvent) => {
      onEvent({ type: 'awaiting_code', url: 'https://auth.example' });
      return { success: true, sessionId: 'ag-1' };
    },
    writeAntigravityAuthSession: async (sessionId, input) => {
      calls.push(['write', sessionId, input]);
      return { success: true };
    },
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.startAntigravityAuthSession)(), { success: true, sessionId: 'ag-1' });
  assert.deepEqual(sends, [
    [IPC_CHANNELS.antigravityAuthSessionEvent, { type: 'awaiting_code', url: 'https://auth.example' }],
  ]);

  assert.deepEqual(await handlers.get(IPC_CHANNELS.writeAntigravityAuthSession)(null, { sessionId: 'ag-1' }), {
    success: false,
    userMessage: 'Invalid Antigravity auth input.',
    technicalCode: 'invalid_antigravity_auth_input',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.writeAntigravityAuthSession)(null, { sessionId: 'ag-1', input: '1234' }), {
    success: true,
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.cancelAntigravityAuthSession)(null, 42), {
    success: false,
    userMessage: 'Invalid Antigravity auth session.',
    technicalCode: 'invalid_antigravity_auth_session',
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.cancelAntigravityAuthSession)(null, 'ag-1'), {
    success: true,
    canceled: 'ag-1',
  });
  assert.deepEqual(calls, [
    ['write', 'ag-1', '1234'],
    ['cancel', 'ag-1'],
  ]);
});

test('desktop error report preparation caches sanitized attachments and submit consumes them once', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-error-report-ipc-'));
  const installLogPath = path.join(root, 'install.log');
  try {
    await fs.writeFile(installLogPath, [
      JSON.stringify({ timestamp: '2026-05-24T10:00:00.000Z', event: 'open:start', appId: 'demo-app' }),
      JSON.stringify({ timestamp: '2026-05-24T10:00:01.000Z', event: 'open:failed', appId: 'demo-app', detail: 'open_failed' }),
      '',
    ].join('\n'), 'utf8');
    const submitted = [];
    const overrides = {
      forgerBackendClient: {
        submitDesktopErrorReport: async (report, attachments) => {
          submitted.push({ report, attachments });
          return { success: true, reportId: submitted.length };
        },
      },
      getCodexHome: () => {
        throw new Error('codex_home_unavailable');
      },
      getForgerHomeRoot: () => path.join(root, 'home'),
      getForgerMetadataRoot: () => path.join(root, 'metadata'),
      getInstallLogPath: () => installLogPath,
      getPrivateAppsRoot: () => path.join(root, 'apps'),
      getPrivateDataRoot: () => path.join(root, 'data'),
    };
    const { handlers } = createDeps(overrides);

    const input = {
      source: 'app',
      operation: 'open',
      message: 'No pudimos iniciar la app.',
      technicalCode: 'open_failed',
      appId: 'demo-app',
      occurredAt: '2026-05-24T10:00:04.000Z',
    };
    const preview = await handlers.get(IPC_CHANNELS.prepareDesktopErrorReport)(null, input);
    assert.equal(typeof preview.diagnosticAttachmentToken, 'string');
    assert.equal(preview.diagnosticFiles.length, 1);
    assert.equal(preview.diagnosticFiles[0].kind, 'install_log');

    const submitResult = await handlers.get(IPC_CHANNELS.submitDesktopErrorReport)(null, {
      ...input,
      diagnosticAttachmentToken: preview.diagnosticAttachmentToken,
    });
    assert.deepEqual(submitResult, { success: true, reportId: 1 });
    assert.equal(submitted[0].attachments.length, 1);
    assert.equal(submitted[0].attachments[0].filename, 'install-log.jsonl');

    await fs.rm(installLogPath, { force: true });
    await handlers.get(IPC_CHANNELS.submitDesktopErrorReport)(null, {
      ...input,
      diagnosticAttachmentToken: preview.diagnosticAttachmentToken,
    });
    assert.deepEqual(submitted[1].attachments, [], 'a consumed token must not replay cached attachments');

    const noAttachments = await handlers.get(IPC_CHANNELS.prepareDesktopErrorReport)(null, {
      source: 'desktop',
      operation: 'uncaughtException',
      message: 'boom',
      technicalCode: 'main_uncaught_exception',
      occurredAt: '2026-05-24T10:00:04.000Z',
    });
    assert.equal(noAttachments.diagnosticAttachmentToken, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('conversation diagnostic reports attach run logs, cache them by token, and submit consumes the cache', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-conversation-diag-'));
  const metadataRoot = path.join(root, 'metadata');
  try {
    const runLogPath = path.join(metadataRoot, 'runs', 'run-9.log');
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(runLogPath, '[2026-05-24T10:00:00.000Z] [stderr] agent exploded\n', 'utf8');
    const submitted = [];
    const overrides = {
      forgerBackendClient: {
        submitConversationDiagnosticReport: async (input, attachments) => {
          submitted.push({ input, attachments });
          return { success: true, reportId: submitted.length };
        },
      },
      getCodexHome: () => path.join(root, 'codex'),
      getForgerHomeRoot: () => path.join(root, 'home'),
      getForgerMetadataRoot: () => metadataRoot,
      getInstallLogPath: () => path.join(root, 'install.log'),
      getPrivateAppsRoot: () => path.join(root, 'apps'),
      getPrivateDataRoot: () => path.join(root, 'data'),
      registry: { apps: { 'demo-app': { appId: 'demo-app', version: '1.2.3' } } },
    };
    const { handlers } = createDeps(overrides);

    const input = {
      source: 'desktop_chat',
      conversationId: 'conv-1',
      appId: 'demo-app',
      runId: 'run-9',
      title: 'Fallo del agente',
    };
    const preview = await handlers.get(IPC_CHANNELS.prepareConversationDiagnosticReport)(null, input);
    assert.equal(typeof preview.diagnosticAttachmentToken, 'string');
    assert.equal(preview.diagnosticFiles.length, 1);
    assert.equal(preview.diagnosticFiles[0].filename, 'run-log-run-9.log');
    assert.deepEqual(preview.payload.diagnosticFiles, preview.diagnosticFiles);
    assert.equal(preview.payload.appVersion, '1.2.3');

    const submitResult = await handlers.get(IPC_CHANNELS.submitConversationDiagnosticReport)(null, {
      ...input,
      diagnosticAttachmentToken: preview.diagnosticAttachmentToken,
    });
    assert.deepEqual(submitResult, { success: true, reportId: 1 });
    assert.equal(submitted[0].attachments.length, 1);
    assert.match(submitted[0].attachments[0].text, /agent exploded/);

    await handlers.get(IPC_CHANNELS.submitConversationDiagnosticReport)(null, {
      ...input,
      diagnosticAttachmentToken: preview.diagnosticAttachmentToken,
    });
    assert.deepEqual(submitted[1].attachments, [], 'a consumed token must not replay cached attachments');

    const noRun = await handlers.get(IPC_CHANNELS.prepareConversationDiagnosticReport)(null, {
      source: 'desktop_chat',
      conversationId: 'conv-2',
      appId: 'demo-app',
      title: 'Sin run',
    });
    assert.equal(noRun.diagnosticAttachmentToken, undefined);

    const withoutBackend = createDeps({ ...overrides, forgerBackendClient: null });
    assert.deepEqual(
      await withoutBackend.handlers.get(IPC_CHANNELS.submitConversationDiagnosticReport)(null, input),
      {
        success: false,
        userMessage: 'No pudimos enviar el reporte de conversación.',
        technicalCode: 'backend_client_missing',
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('desktop log channel validates the event and appends a sanitized renderer log entry', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-desktop-log-'));
  try {
    const { handlers } = createDeps({
      getForgerMetadataRoot: () => root,
    });

    assert.deepEqual(await handlers.get(IPC_CHANNELS.desktopLog)(null, null), { success: false });
    assert.deepEqual(await handlers.get(IPC_CHANNELS.desktopLog)(null, { event: '   ' }), { success: false });

    assert.deepEqual(
      await handlers.get(IPC_CHANNELS.desktopLog)(null, {
        event: ' renderer_boot ',
        level: 'warn',
        message: 'arrancando',
        context: { screen: 'home' },
      }),
      { success: true },
    );
    assert.deepEqual(
      await handlers.get(IPC_CHANNELS.desktopLog)(null, { event: 'renderer_click', level: 'not-a-level' }),
      { success: true },
    );

    const written = (await fs.readFile(path.join(root, 'logs', 'forger-desktop.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(written.length, 2);
    assert.equal(written[0].event, 'renderer_boot');
    assert.equal(written[0].level, 'warn');
    assert.equal(written[0].service, 'desktop-renderer');
    assert.equal(written[0].message, 'arrancando');
    assert.deepEqual(written[0].context, { screen: 'home' });
    assert.equal(written[1].event, 'renderer_click');
    assert.equal(written[1].level, 'info', 'unknown levels default to info');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('chat start run in social review mode uses the quarantine prompt context when it is an object', async () => {
  const dataRoot = await fs.mkdtemp(path.join(tmpdir(), 'forger-chat-data-'));
  try {
    const promptInputs = [];
    const starts = [];
    const makeHandlers = (getSocialAppReviewPromptContext) => createDeps({
      buildCodexPromptWithAppContext: (input) => {
        promptInputs.push(input);
        return `prompt:${input.appId}`;
      },
      buildForgerToolsContextForApp: async () => 'tools',
      chatOrchestrator: {
        startRun: async (input) => {
          starts.push(input);
          return { runId: 'run-1', status: 'running' };
        },
      },
      getPrivateDataRoot: () => dataRoot,
      getSocialAppReviewPromptContext,
      registry: {
        apps: { 'social-demo': { appId: 'social-demo', installDir: '/apps/social-demo' } },
      },
    }).handlers;

    const reviewHandlers = makeHandlers(async (appId) => ({
      appRoot: `/quarantine/${appId}`,
      runRoot: `/quarantine/${appId}`,
    }));
    assert.deepEqual(
      await reviewHandlers.get(IPC_CHANNELS.chatStartRun)(null, {
        appId: 'social-demo',
        chatMode: 'social_app_review',
        prompt: 'revisa esta app',
      }),
      { runId: 'run-1', status: 'running' },
    );
    // Each start builds a start prompt and a resume prompt; both must carry
    // the quarantine context while the app is under social review.
    assert.equal(promptInputs[0].appRoot, '/quarantine/social-demo');
    assert.equal(promptInputs.at(-1).appRoot, '/quarantine/social-demo');

    const fallbackHandlers = makeHandlers(async () => 'not-an-object');
    await fallbackHandlers.get(IPC_CHANNELS.chatStartRun)(null, {
      appId: 'social-demo',
      chatMode: 'social_app_review',
      prompt: 'revisa esta app',
    });
    assert.equal(
      promptInputs.at(-1).appRoot,
      '/apps/social-demo',
      'non-object review contexts fall back to the installed app context',
    );
    assert.equal(starts.length, 2);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test('personal agent runtime provider connection checks map each provider to its auth status', async () => {
  const createdAgents = [];
  const auth = { claude: true, antigravity: true, codex: false };
  const { handlers } = createDeps({
    getAntigravityAuthStatus: async () => ({ authenticated: auth.antigravity }),
    getClaudeAuthStatus: async () => ({ authenticated: auth.claude }),
    getCodexAuthStatus: async () => ({ authenticated: auth.codex }),
    getOfficialToolsService: () => ({ list: async () => ({ tools: [] }) }),
    getPersonalAgentStore: () => ({
      createAgent: async (input) => {
        createdAgents.push(input);
        return { id: `agent-${createdAgents.length}`, ...input };
      },
    }),
  });
  const create = handlers.get(IPC_CHANNELS.personalAgentsCreate);

  assert.equal((await create(null, { name: 'A', runtime: { provider: 'claude' } })).id, 'agent-1');
  assert.equal((await create(null, { name: 'B', runtime: { provider: 'antigravity' } })).id, 'agent-2');
  await assert.rejects(
    create(null, { name: 'C', runtime: { provider: 'codex' } }),
    /personal_agent_runtime_provider_not_connected/,
  );

  auth.codex = true;
  auth.claude = false;
  assert.equal((await create(null, { name: 'D', runtime: { provider: 'codex' } })).id, 'agent-3');
  await assert.rejects(
    create(null, { name: 'E', runtime: { provider: 'claude' } }),
    /personal_agent_runtime_provider_not_connected/,
  );
  assert.deepEqual(createdAgents.map((agent) => agent.name), ['A', 'B', 'D']);
});
