import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WhatsAppConnectionManager } = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
const {
  whatsappToolModule,
  __resetWhatsAppToolForTests,
} = require('../../dist-electron/main/connections/modules/whatsapp/index.js');

const createContext = (metadataRoot = '/tmp/forger-whatsapp-b9', locale = 'es') => ({
  metadataRoot,
  locale,
  secretsStore: {
    hasToolSecret: async () => false,
    getToolSecret: async () => undefined,
    setToolSecret: async () => ({ success: true }),
    deleteToolSecrets: async () => undefined,
  },
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => true,
  getGmailOAuthClientId: async () => 'gmail-client-id',
  exchangeGmailOAuthCode: async () => ({}),
  refreshGmailOAuthAccessToken: async () => ({}),
  appendLog: async () => undefined,
});

test('Given the official WhatsApp tool, actions validate inputs, preserve manager failures, and manage each workspace lifecycle', async (t) => {
  __resetWhatsAppToolForTests();
  t.after(() => __resetWhatsAppToolForTests());
  const calls = [];
  let behavior = 'success';
  const implementations = {
    status: async (_context) => {
      calls.push(['status']);
      if (behavior === 'throw-error') throw new Error('whatsapp_status_failed');
      if (behavior === 'throw-value') throw 'offline';
      return { configured: true, connected: true };
    },
    startPairing: async (_context, input) => {
      calls.push(['startPairing', input]);
      if (behavior === 'failure-full') {
        return { success: false, userMessage: 'Pairing rejected.', technicalCode: 'pairing_rejected', data: { retry: false } };
      }
      return { success: true, method: input.method };
    },
    listChats: async (input) => {
      calls.push(['listChats', input]);
      return { chats: [], input };
    },
    readMessages: async (_context, input) => {
      calls.push(['readMessages', input]);
      if (behavior === 'failure-empty') return { success: false };
      return { success: true, messages: [], input };
    },
    downloadAttachment: async (_context, input) => {
      calls.push(['downloadAttachment', input]);
      return { success: true, input };
    },
    sendMessage: async (_context, input) => {
      calls.push(['sendMessage', input]);
      return { success: true, input };
    },
    getChatDetails: async (_context, input) => {
      calls.push(['getChatDetails', input]);
      return { success: true, input };
    },
    stopListening: async () => calls.push(['stopListening']),
    disconnect: async (_context) => calls.push(['disconnect']),
  };
  for (const [name, implementation] of Object.entries(implementations)) {
    WhatsAppConnectionManager.prototype[name] = implementation;
  }

  const context = createContext();
  assert.equal((await whatsappToolModule.configure(context)).success, true);
  assert.equal((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.connection.status',
  }, context)).data.connected, true);

  for (const input of [null, [], 'record', {}, { method: 'invalid' }]) {
    assert.equal((await whatsappToolModule.execute({ toolId: 'whatsapp', actionId: 'whatsapp.start_pairing', input }, context)).technicalCode, 'whatsapp_pairing_input_invalid');
  }
  assert.equal((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.start_pairing',
    input: { method: 'qr' },
  }, context)).success, true);
  behavior = 'failure-full';
  assert.deepEqual(await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.start_pairing',
    input: { method: 'pairing_code', phoneNumber: ' +56 9000 ' },
  }, context), {
    success: false,
    userMessage: 'Pairing rejected.',
    technicalCode: 'pairing_rejected',
    data: { retry: false },
  });
  behavior = 'success';

  for (const input of [
    null,
    { chatType: 'invalid', query: ' ', limit: '10', cursor: 8 },
    { chatType: 'direct', query: ' person ', limit: 5, cursor: ' next ' },
    { chatType: 'group' },
    { chatType: 'channel' },
  ]) {
    assert.equal((await whatsappToolModule.execute({ toolId: 'whatsapp', actionId: 'whatsapp.list_chats', input }, context)).success, true);
  }

  for (const input of [null, [], 'record', {}, { chatId: 1 }, { chatId: '  ' }]) {
    assert.equal((await whatsappToolModule.execute({ toolId: 'whatsapp', actionId: 'whatsapp.read_messages', input }, context)).technicalCode, 'whatsapp_read_input_invalid');
  }
  assert.equal((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.read_messages',
    input: { chatId: ' chat-1 ', limit: 4, beforeMessageRef: ' previous ' },
  }, context)).success, true);
  behavior = 'failure-empty';
  assert.deepEqual(await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.read_messages',
    input: { chatId: 'chat-1' },
  }, context), { success: false });
  behavior = 'success';

  for (const input of [null, {}, { attachmentId: 1 }, { attachmentId: ' ' }]) {
    assert.equal((await whatsappToolModule.execute({ toolId: 'whatsapp', actionId: 'whatsapp.download_attachment', input }, context)).technicalCode, 'whatsapp_download_attachment_input_invalid');
  }
  assert.equal((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.download_attachment',
    input: { attachmentId: ' attachment-1 ' },
  }, context)).data.input.attachmentId, 'attachment-1');

  for (const input of [
    null,
    [],
    {},
    { chatId: 1, text: 'hello' },
    { chatId: 'chat-1', text: 2 },
    { chatId: ' ', text: 'hello' },
    { chatId: 'chat-1', text: ' ' },
  ]) {
    assert.equal((await whatsappToolModule.execute({ toolId: 'whatsapp', actionId: 'whatsapp.send_message', input }, context)).technicalCode, 'whatsapp_send_input_invalid');
  }
  assert.deepEqual((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.send_message',
    input: { chatId: ' chat-1 ', text: ' hello ', replyToMessageRef: ' previous ' },
  }, context)).data.input, { chatId: 'chat-1', text: 'hello', replyToMessageRef: 'previous' });
  assert.deepEqual((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.send_message',
    input: { chatId: 'chat-1', text: 'hello', replyToMessageRef: 2 },
  }, context)).data.input, { chatId: 'chat-1', text: 'hello' });

  for (const input of [null, {}, { chatId: 1 }, { chatId: ' ' }]) {
    assert.equal((await whatsappToolModule.execute({ toolId: 'whatsapp', actionId: 'whatsapp.get_chat_details', input }, context)).technicalCode, 'whatsapp_details_input_invalid');
  }
  assert.deepEqual((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.get_chat_details',
    input: { chatId: ' chat-1 ' },
  }, context)).data.input, { chatId: 'chat-1' });

  assert.equal((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.unknown',
  }, context)).technicalCode, 'whatsapp_action_unknown');

  behavior = 'throw-error';
  assert.equal((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.connection.status',
  }, context)).technicalCode, 'whatsapp_status_failed');
  behavior = 'throw-value';
  assert.equal((await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.connection.status',
  }, context)).technicalCode, 'whatsapp_action_failed');
  behavior = 'success';

  await whatsappToolModule.start(context);
  await whatsappToolModule.stop(context);
  await whatsappToolModule.deactivate(context);
  await whatsappToolModule.start(context);
  __resetWhatsAppToolForTests();

  assert.ok(calls.some(([name]) => name === 'stopListening'));
  assert.ok(calls.some(([name]) => name === 'disconnect'));
  assert.deepEqual(calls.find(([name, input]) => name === 'listChats' && input.chatType === 'direct')[1], {
    chatType: 'direct', query: 'person', limit: 5, cursor: 'next',
  });
});
