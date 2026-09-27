import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MockAgent } = require('undici');
const { downloadImageStream } = require('../../dist-electron/main/connections/modules/whatsapp/image-download.js');
const key = { remoteJid: 'synthetic-chat', id: 'synthetic-photo', fromMe: false };
const input = dispatcher => ({
  message: { key, message: { imageMessage: { url: 'https://mmg.whatsapp.net/photo', mediaKey: Buffer.alloc(32) } } },
  expected: key, dispatcher, authorize: async () => true,
  keys: async () => assert.fail('No complete media body was received'),
  reupload: async () => assert.fail('No expiry response was received'),
});
const consume = async stream => { for await (const _chunk of stream) assert.fail('Failed downloads cannot yield bytes'); };

test('the actual fetch implementation never follows a media redirect', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  agent.get('https://mmg.whatsapp.net').intercept({ path: '/photo', method: 'GET', headers: { origin: 'https://web.whatsapp.com' } })
    .reply(302, '', { headers: { location: 'https://elsewhere.invalid/photo' } });
  let closed = false;
  const dispatcher = { dispatch: agent.dispatch.bind(agent), destroy: async () => { await agent.close(); closed = true; } };
  await assert.rejects(consume(downloadImageStream(input(dispatcher))), error => error.cause?.message === 'image_redirect_denied');
  assert.equal(closed, true);
});

test('actual fetch aborts a stalled body after headers and releases its dispatcher', async () => {
  let aborted = false; let destroyed = false;
  const dispatcher = {
    dispatch(_options, handler) {
      handler.onConnect(error => { aborted = true; handler.onError(error); });
      handler.onHeaders(200, [], () => {}, 'OK');
      handler.onData(Buffer.from([1, 2, 3]));
      return true;
    },
    async destroy() { destroyed = true; },
  };
  await assert.rejects(consume(downloadImageStream({ ...input(dispatcher), timeoutMs: 20 })), /image_download_timeout/);
  assert.equal(aborted, true);
  assert.equal(destroyed, true);
});

test('a fetch connection error after headers rejects without an uncaught stream error', async () => {
  let destroyed = false;
  const dispatcher = {
    dispatch(_options, handler) {
      handler.onConnect(error => handler.onError(error));
      handler.onHeaders(200, [], () => {}, 'OK');
      queueMicrotask(() => handler.onError(new Error('synthetic disconnected socket')));
      return true;
    },
    async destroy() { destroyed = true; },
  };
  await assert.rejects(consume(downloadImageStream({ ...input(dispatcher), timeoutMs: 20 })));
  assert.equal(destroyed, true);
});
