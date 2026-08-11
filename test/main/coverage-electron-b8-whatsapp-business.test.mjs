import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { whatsappBusinessToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/whatsapp-business.js');

const defaultSecrets = {
  access_token: 'whatsapp-token',
  business_account_id: 'business/1',
  phone_number_id: 'phone/1',
  api_version: 'v24.0',
  app_secret: 'app-secret',
};
const createContext = (secrets = defaultSecrets) => ({
  metadataRoot: '/tmp/forger-whatsapp-business-b8',
  secretsStore: {
    getToolSecret: async (_toolId, name) => secrets[name] ?? null,
    hasToolSecret: async (_toolId, name) => Boolean(secrets[name]),
    setToolSecret: async () => ({ success: true }),
    deleteToolSecrets: async () => undefined,
  },
});
const execute = (actionId, input = {}, context = createContext()) => whatsappBusinessToolModule.execute({
  toolId: 'whatsapp_business', actionId, input,
}, context);
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const withFetch = async (handler, operation) => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await operation(calls);
  } finally {
    globalThis.fetch = previous;
  }
};

test('Given WhatsApp Business credentials, messages, media and profiles stay scoped to encoded account ids', async () => {
  await withFetch(
    (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith('/phone_numbers')) {
        return response({ data: [{ id: 'phone-1', display_phone_number: '+15550000000' }] });
      }
      if (url.pathname.endsWith('/whatsapp_business_profile') && url.searchParams.has('fields')) {
        return response({ data: [{ about: 'Forger' }] });
      }
      return response({ id: 'created' });
    },
    async (calls) => {
      assert.deepEqual((await execute('whatsapp_business.connection.status')).data, {
        connected: true,
        subject: 'business/1',
        phoneNumber: '+15550000000',
        workspace: 'WhatsApp Business Cloud',
      });
      assert.equal(new URL(calls.at(-1).url).pathname, '/v24.0/business%2F1/phone_numbers');
      assert.ok(new URL(calls.at(-1).url).searchParams.get('appsecret_proof'));

      assert.equal((await execute('whatsapp_business.list_phone_numbers')).data.phoneNumbers.length, 1);

      let result = await execute('whatsapp_business.send_text_message', {
        to: ' +15550001111 ', body: ' Hello ', previewUrl: true, phoneNumberId: 'override/phone',
      });
      assert.equal(result.success, true);
      let call = calls.at(-1);
      assert.equal(new URL(call.url).pathname, '/v24.0/override%2Fphone/messages');
      assert.deepEqual(JSON.parse(call.init.body), {
        messaging_product: 'whatsapp',
        to: '+15550001111',
        type: 'text',
        text: { body: 'Hello', preview_url: true },
      });

      result = await execute('whatsapp_business.send_template_message', {
        to: '+15550001111', templateName: ' welcome ', languageCode: ' en_US ', components: [{ type: 'body' }],
      });
      assert.equal(result.success, true);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body).template, {
        name: 'welcome', language: { code: 'en_US' }, components: [{ type: 'body' }],
      });
      await execute('whatsapp_business.send_template_message', {
        to: '+15550001111', templateName: 'welcome', languageCode: 'en_US', components: 'invalid',
      });
      assert.equal('components' in JSON.parse(calls.at(-1).init.body).template, false);

      result = await execute('whatsapp_business.upload_media', {
        base64Content: Buffer.from('image').toString('base64'), filename: 'image.png', mimeType: 'image/png',
      });
      assert.equal(result.success, true);
      assert.equal(calls.at(-1).init.body instanceof FormData, true);

      result = await execute('whatsapp_business.send_media_message', {
        to: '+15550001111', mediaType: 'image', mediaId: 'media-1', caption: ' Caption ',
      });
      assert.equal(result.success, true);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body).image, { id: 'media-1', caption: 'Caption' });
      await execute('whatsapp_business.send_media_message', {
        to: '+15550001111', mediaType: 'audio', mediaId: 'media-2',
      });
      assert.deepEqual(JSON.parse(calls.at(-1).init.body).audio, { id: 'media-2' });

      assert.equal((await execute('whatsapp_business.mark_message_read', { messageId: 'message-1' })).data.markedRead, true);
      assert.equal((await execute('whatsapp_business.get_business_profile')).data.profile.about, 'Forger');
      assert.equal((await execute('whatsapp_business.update_business_profile', {
        about: ' About ', description: ' Description ', email: ' person@example.com ',
      })).data.updated, true);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
        messaging_product: 'whatsapp',
        about: 'About',
        description: 'Description',
        email: 'person@example.com',
      });
      await execute('whatsapp_business.update_business_profile');
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), { messaging_product: 'whatsapp' });
      assert.equal(calls.every((entry) => entry.init.headers.get('authorization') === 'Bearer whatsapp-token'), true);
    },
  );
});

test('Given default API settings without app proof, WhatsApp Business uses v23 and no proof query', async () => {
  const context = createContext({ access_token: 'token', business_account_id: 'business' });
  await withFetch(
    () => response({ data: [] }),
    async (calls) => {
      assert.equal((await execute('whatsapp_business.list_phone_numbers', {}, context)).success, true);
      const url = new URL(calls[0].url);
      assert.equal(url.pathname, '/v23.0/business/phone_numbers');
      assert.equal(url.searchParams.has('appsecret_proof'), false);
    },
  );
});

test('Given malformed WhatsApp Business inputs, messages and files fail before network access', async () => {
  const noPhone = createContext({ access_token: 'token', business_account_id: 'business' });
  const cases = [
    ['whatsapp_business.send_text_message', {}, 'whatsapp_business_to_required'],
    ['whatsapp_business.send_text_message', { to: 'person' }, 'whatsapp_business_input_invalid'],
    ['whatsapp_business.send_template_message', { to: 'person', templateName: 'name' }, 'whatsapp_business_input_invalid'],
    ['whatsapp_business.send_media_message', { to: 'person', mediaType: 'binary', mediaId: 'id' }, 'whatsapp_business_input_invalid'],
    ['whatsapp_business.upload_media', {}, 'whatsapp_business_media_required'],
    ['whatsapp_business.upload_media', { base64Content: 'eA==' }, 'whatsapp_business_filename_required'],
    ['whatsapp_business.upload_media', { base64Content: 'eA==', filename: 'x' }, 'whatsapp_business_mime_required'],
    ['whatsapp_business.mark_message_read', {}, 'whatsapp_business_message_required'],
  ];
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network must not be reached'); };
  try {
    for (const [actionId, input, technicalCode] of cases) {
      assert.equal((await execute(actionId, input)).technicalCode, technicalCode, actionId);
    }
    for (const [actionId, input] of [
      ['whatsapp_business.send_text_message', { to: 'person', body: 'text' }],
      ['whatsapp_business.upload_media', { base64Content: 'eA==', filename: 'x', mimeType: 'text/plain' }],
      ['whatsapp_business.mark_message_read', { messageId: 'message' }],
      ['whatsapp_business.get_business_profile', {}],
      ['whatsapp_business.update_business_profile', {}],
    ]) {
      assert.equal((await execute(actionId, input, noPhone)).technicalCode, 'whatsapp_business_phone_number_required');
    }
  } finally {
    globalThis.fetch = previous;
  }
});
