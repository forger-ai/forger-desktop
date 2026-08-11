import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearDistModule,
  createPreloadDocumentMock,
  createPreloadElectronMock,
  createPreloadWindowMock,
  requireExposedApi,
  withMockedBrowserGlobals,
  withMockedElectron,
} from './electron-test-helpers.mjs';

test('desktop preload applies safe defaults without forwarding undeclared file fields', async () => {
  const harness = createPreloadElectronMock();
  await withMockedElectron(harness.electronMock, (require) => {
    clearDistModule('preload/index.js');
    require('../../dist-electron/preload/index.js');
  });
  const api = requireExposedApi(harness.exposed, 'forger');

  await api.liveVoiceInputStop();
  await api.filesImport({
    grantIds: ['grant-1'],
    appId: 'finance-os',
    sourcePaths: ['/must/not/escape.txt'],
  });

  assert.deepEqual(harness.invokeCalls, [
    ['forger:live-voice-input:stop', {}],
    ['forger:files:import', { grantIds: ['grant-1'], appId: 'finance-os' }],
  ]);
});

test('app preload defaults a missing locale to Spanish for permission decisions', async () => {
  const harness = createPreloadElectronMock();
  const { window } = createPreloadWindowMock({ href: 'https://finance.local/reports' });
  const { document } = createPreloadDocumentMock();
  await withMockedBrowserGlobals({ window, document }, async () => {
    await withMockedElectron(harness.electronMock, (require) => {
      clearDistModule('preload/app.js');
      require('../../dist-electron/preload/app.js');
    });
    const listener = harness.listeners.get('forger:app:agent-task:updated');
    listener({}, {
      task: {
        runId: 'run-1',
        status: 'needs_permission',
        permissionRequest: {
          requestId: 'permission-1',
          permission: 'official_tool',
          reason: 'Necesita leer mensajes.',
          risk: 'low',
          resource: 'Gmail',
        },
      },
    });
    const overlay = document.querySelector('[data-forger-permission-overlay="true"]');
    assert.equal(overlay.children[0].children[0].textContent, 'Forger necesita autorización');
    assert.equal(overlay.children[0].children[4].children[0].textContent, 'Rechazar');
  });
});
