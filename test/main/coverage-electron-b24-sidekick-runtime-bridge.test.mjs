import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { DesktopRuntimeBridgeError } = require('../../dist-electron/main/desktop-runtime-bridge-error.js');
const { createSidekickRuntimeBridgeBindings, routeSidekickRuntimeRequest } = require('../../dist-electron/main/sidekick-runtime-bridge.js');

const rejectedCode = async (promise, code) => await assert.rejects(promise, (error) => {
  assert.ok(error instanceof DesktopRuntimeBridgeError);
  assert.equal(error.message, code);
  return true;
});

test('sidekick runtime bindings copy device state and expose only safe hardware receipts', async () => {
  const service = {
    getState: async () => ({ sidekicks: [{ sidekickId: 'one', name: 'Kitchen', status: 'online', capabilities: ['screen'] }] }),
    sendScreen: async () => ({ success: false }),
    speak: async () => ({ success: true, playbackId: 'play-1', samplesPlayed: 4 }),
  };
  const bindings = createSidekickRuntimeBridgeBindings(() => service);
  const listed = await bindings.listSidekicksForApp('app');
  assert.deepEqual(listed, [{ sidekickId: 'one', name: 'Kitchen', status: 'online', capabilities: ['screen'] }]);
  service.getState = async () => ({ sidekicks: [] });
  assert.deepEqual(await bindings.listSidekicksForApp('app'), []);
  assert.deepEqual(await bindings.sendSidekickScreen('app', { sidekickId: 'one', template: 'idle' }), { success: false });
  service.sendScreen = async () => ({ success: false, userMessage: 'Offline', technicalCode: 'offline' });
  assert.deepEqual(await bindings.sendSidekickScreen('app', { sidekickId: 'one', template: 'idle' }), {
    success: false, userMessage: 'Offline', technicalCode: 'offline',
  });
  assert.equal((await bindings.speakThroughSidekick('app', { sidekickId: 'one', text: 'Hi', model: 'm', voice: 'v' })).playbackId, 'play-1');
});

test('sidekick runtime route enforces app identity, capabilities, methods, handlers, and payload bounds', async () => {
  const allCapabilities = async () => ({ textToSpeech: true, sidekickDisplay: true, sidekickSpeech: true });
  const devices = [{ sidekickId: 'one', name: 'Kitchen', status: 'online', capabilities: ['screen'] }];
  const base = {
    getAppPlatformCapabilities: allCapabilities,
    listSidekicksForApp: async () => devices,
    sendSidekickScreen: async () => ({ success: true }),
    speakThroughSidekick: async () => ({
      success: true,
      playbackId: 'p',
      samplesPlayed: 1,
      underruns: 2,
      droppedChunks: 3,
      userMessage: 'ok',
      technicalCode: 'none',
    }),
  };
  assert.deepEqual(await routeSidekickRuntimeRequest(base, 'app', 'GET', '/other', ''), { handled: false });
  await rejectedCode(routeSidekickRuntimeRequest(base, 'other', 'GET', '/v1/apps/app/sidekicks', ''), 'desktop_runtime_app_forbidden');
  await rejectedCode(routeSidekickRuntimeRequest(base, 'app', 'POST', '/v1/apps/app/sidekicks', ''), 'desktop_runtime_route_not_found');
  await rejectedCode(routeSidekickRuntimeRequest({ getAppPlatformCapabilities: async () => ({ textToSpeech: true }) }, 'app', 'GET', '/v1/apps/app/sidekicks', ''), 'desktop_runtime_sidekick_capability_required');
  await rejectedCode(routeSidekickRuntimeRequest({ getAppPlatformCapabilities: allCapabilities }, 'app', 'GET', '/v1/apps/app/sidekicks', ''), 'desktop_runtime_sidekick_unavailable');
  const listed = await routeSidekickRuntimeRequest(base, 'app', 'GET', '/v1/apps/app/sidekicks', '');
  assert.deepEqual(listed.result, { sidekicks: devices });

  for (const body of ['{bad', '[]', 'null']) {
    await rejectedCode(routeSidekickRuntimeRequest(base, 'app', 'POST', '/v1/apps/app/sidekicks/screen', body), 'desktop_runtime_body_invalid');
  }
  await rejectedCode(routeSidekickRuntimeRequest({ ...base, getAppPlatformCapabilities: async () => ({ textToSpeech: true, sidekickSpeech: true }) }, 'app', 'POST', '/v1/apps/app/sidekicks/screen', '{}'), 'desktop_runtime_sidekickDisplay_capability_required');
  await rejectedCode(routeSidekickRuntimeRequest({ ...base, sendSidekickScreen: undefined }, 'app', 'POST', '/v1/apps/app/sidekicks/screen', '{}'), 'desktop_runtime_sidekick_unavailable');
  const invalidScreens = [
    {},
    { sidekickId: 'x'.repeat(129), template: 'idle' },
    { sidekickId: 'one', template: 'unknown' },
    { sidekickId: 'one', template: 'idle', icon: '' },
    { sidekickId: 'one', template: 'idle', title: 7 },
    { sidekickId: 'one', template: 'idle', body: 'x'.repeat(513) },
    { sidekickId: 'one', template: 'idle', text: 'x'.repeat(4001) },
    { sidekickId: 'one', template: 'idle', icon: 'unknown' },
    { sidekickId: 'one', template: 'state' },
    { sidekickId: 'one', template: 'state', icon: 'home' },
    { sidekickId: 'one', template: 'card' },
  ];
  for (const input of invalidScreens) {
    await rejectedCode(routeSidekickRuntimeRequest(base, 'app', 'POST', '/v1/apps/app/sidekicks/screen', JSON.stringify(input)), 'desktop_runtime_sidekick_screen_invalid');
  }
  const screen = await routeSidekickRuntimeRequest(base, 'app', 'POST', '/v1/apps/app/sidekicks/screen', JSON.stringify({
    sidekickId: ' one ', template: 'state', icon: 'thinking', title: ' Title ', body: ' Body ', text: ' Text ',
  }));
  assert.deepEqual(screen.result, { success: true });
  assert.deepEqual((await routeSidekickRuntimeRequest(base, 'app', 'POST', '/v1/apps/app/sidekicks/screen', JSON.stringify({
    sidekickId: 'one', template: 'idle',
  }))).result, { success: true });

  await rejectedCode(routeSidekickRuntimeRequest(base, 'app', 'GET', '/v1/apps/app/sidekicks/speak', '{}'), 'desktop_runtime_route_not_found');
  await rejectedCode(routeSidekickRuntimeRequest({ ...base, getAppPlatformCapabilities: async () => ({ textToSpeech: true }) }, 'app', 'POST', '/v1/apps/app/sidekicks/speak', '{}'), 'desktop_runtime_sidekickSpeech_capability_required');
  await rejectedCode(routeSidekickRuntimeRequest({ ...base, getAppPlatformCapabilities: async () => ({ sidekickSpeech: true, textToSpeech: false }) }, 'app', 'POST', '/v1/apps/app/sidekicks/speak', '{}'), 'desktop_runtime_textToSpeech_capability_required');
  await rejectedCode(routeSidekickRuntimeRequest({ ...base, speakThroughSidekick: undefined }, 'app', 'POST', '/v1/apps/app/sidekicks/speak', '{}'), 'desktop_runtime_sidekick_unavailable');
  for (const input of [
    {},
    { sidekickId: 'one', text: 'hello', model: 'm', voice: 'v', speed: 'fast' },
    { sidekickId: 'one', text: 'hello', model: 'm', voice: 'v', speed: Number.NaN },
    { sidekickId: 'one', text: 'hello', model: 'm', voice: 'v', speed: 0.4 },
    { sidekickId: 'one', text: 'hello', model: 'm', voice: 'v', speed: 2.1 },
  ]) await rejectedCode(routeSidekickRuntimeRequest(base, 'app', 'POST', '/v1/apps/app/sidekicks/speak', JSON.stringify(input)), 'desktop_runtime_sidekick_speech_invalid');
  const spoken = await routeSidekickRuntimeRequest(base, 'app', 'POST', '/v1/apps/app/sidekicks/speak', JSON.stringify({
    sidekickId: 'one', text: 'hello', model: 'model', voice: 'voice', speed: 1.2,
  }));
  assert.deepEqual(spoken.result, {
    success: true, playbackId: 'p', samplesPlayed: 1, underruns: 2, droppedChunks: 3, userMessage: 'ok', technicalCode: 'none',
  });
  await routeSidekickRuntimeRequest(base, 'app', 'POST', '/v1/apps/app/sidekicks/speak', JSON.stringify({
    sidekickId: 'one', text: 'hello', model: 'model', voice: 'voice',
  }));
});
