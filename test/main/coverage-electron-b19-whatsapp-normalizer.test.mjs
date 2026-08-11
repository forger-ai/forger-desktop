import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  chatFromMessage,
  classifyWhatsAppJid,
  decodeStableMessageRef,
  encodeStableMessageRef,
  normalizeBaileysChat,
  normalizeBaileysContact,
  normalizeBaileysMessage,
  normalizeWhatsAppJid,
  phoneNumberFromJid,
} = require('../../dist-electron/main/connections/modules/whatsapp/normalizer.js');

const directJid = '56912345678@s.whatsapp.net';

test('given identifiers and stable references, normalization accepts supported identities and rejects malformed payloads', () => {
  assert.equal(normalizeWhatsAppJid(`  ${directJid}  `), directJid);
  assert.equal(normalizeWhatsAppJid(123), '');
  assert.equal(classifyWhatsAppJid('team@g.us'), 'group');
  assert.equal(classifyWhatsAppJid('updates@newsletter'), 'channel');
  assert.equal(classifyWhatsAppJid(directJid), 'direct');

  assert.equal(phoneNumberFromJid('client-569 123@s.whatsapp.net'), '569123');
  assert.equal(phoneNumberFromJid('device-42@lid'), '42');
  assert.equal(phoneNumberFromJid('letters@lid'), undefined);
  assert.equal(phoneNumberFromJid('team@g.us'), undefined);

  const ref = { remoteJid: directJid, id: 'message-1', fromMe: false, participant: 'peer@lid' };
  assert.deepEqual(decodeStableMessageRef(encodeStableMessageRef(ref)), ref);
  assert.deepEqual(decodeStableMessageRef(encodeStableMessageRef({ ...ref, participant: undefined })), {
    remoteJid: directJid,
    id: 'message-1',
    fromMe: false,
  });
  for (const malformed of [undefined, '', '   ', 'not-json']) {
    assert.equal(decodeStableMessageRef(malformed), null);
  }
  for (const partial of [
    { id: 'message-1', fromMe: false },
    { remoteJid: directJid, fromMe: false },
    { remoteJid: directJid, id: 'message-1', fromMe: 'false' },
  ]) {
    assert.equal(decodeStableMessageRef(Buffer.from(JSON.stringify(partial)).toString('base64url')), null);
  }
});

test('given text variants and malformed messages, indexed messages expose only validated observable fields', () => {
  assert.equal(normalizeBaileysMessage(null), null);
  assert.equal(normalizeBaileysMessage('message'), null);
  assert.equal(normalizeBaileysMessage({}), null);
  assert.equal(normalizeBaileysMessage({ key: { id: 'missing-jid' } }), null);
  assert.equal(normalizeBaileysMessage({ key: { remoteJid: directJid, id: 7 } }), null);
  assert.equal(normalizeBaileysMessage({ key: { remoteJid: directJid, id: '   ' } }), null);

  const cases = [
    [{ conversation: 'plain' }, 'plain', 'conversation'],
    [{ extendedTextMessage: { text: 'extended' } }, 'extended', 'extendedTextMessage'],
    [{ imageMessage: { caption: 'image caption' } }, 'image caption', 'imageMessage'],
    [{ videoMessage: { caption: 'video caption' } }, 'video caption', 'videoMessage'],
    [{ extendedTextMessage: { text: 9 } }, undefined, 'extendedTextMessage'],
    [{ imageMessage: { caption: 9 } }, undefined, 'imageMessage'],
    [{ videoMessage: { caption: 9 } }, undefined, 'videoMessage'],
    [{ reactionMessage: {} }, undefined, 'reactionMessage'],
    [{}, undefined, 'unknown'],
    [undefined, undefined, 'unknown'],
  ];

  for (const [message, expectedText, expectedType] of cases) {
    const normalized = normalizeBaileysMessage({
      key: { remoteJid: directJid, id: `id-${expectedType}`, fromMe: false },
      message,
    });
    assert.equal(normalized.messageType, expectedType);
    assert.equal(normalized.text, expectedText);
    assert.equal(normalized.hasAttachments, expectedType === 'imageMessage' || expectedType === 'videoMessage');
  }

  const complete = normalizeBaileysMessage({
    key: { remoteJid: 'team@g.us', id: 'complete', fromMe: true, participant: ' peer@lid ' },
    pushName: ' Sender ',
    messageTimestamp: 123,
    message: { conversation: 'hello' },
  });
  assert.equal(complete.senderId, 'peer@lid');
  assert.equal(complete.senderDisplayName, 'Sender');
  assert.equal(complete.timestamp, 123);
  assert.equal(complete.fromMe, true);
  assert.equal(complete.isGroup, true);
  assert.equal(complete.isChannel, false);

  const channel = normalizeBaileysMessage({
    key: { remoteJid: 'feed@newsletter', id: 'channel', participant: 7 },
    pushName: 7,
    messageTimestamp: { toNumber: () => 456 },
  });
  assert.equal(channel.timestamp, 456);
  assert.equal(channel.isGroup, false);
  assert.equal(channel.isChannel, true);

  for (const messageTimestamp of [
    Number.NaN,
    '123',
    {},
    { toNumber: 1 },
    { toNumber: () => '123' },
    { toNumber: () => Number.POSITIVE_INFINITY },
  ]) {
    const message = normalizeBaileysMessage({
      key: { remoteJid: directJid, id: `timestamp-${String(messageTimestamp)}` },
      messageTimestamp,
    });
    assert.equal(message.timestamp, undefined);
  }
});

test('given every media kind, attachment metadata is normalized without trusting malformed values', () => {
  const mediaCases = [
    ['imageMessage', 'image'],
    ['videoMessage', 'video'],
    ['audioMessage', 'audio'],
    ['documentMessage', 'document'],
    ['stickerMessage', 'sticker'],
  ];
  const lengths = [
    12,
    13n,
    '14',
    { toNumber: () => 15 },
    16,
  ];
  const hashes = [
    ' encoded-hash ',
    Buffer.from('buffer-hash'),
    new Uint8Array([1, 2, 3]),
    undefined,
    '',
  ];

  for (let index = 0; index < mediaCases.length; index += 1) {
    const [messageType, kind] = mediaCases[index];
    const normalized = normalizeBaileysMessage({
      key: { remoteJid: directJid, id: `media-${index}`, fromMe: false },
      message: {
        [messageType]: {
          fileName: index === 0 ? ' picture.jpg ' : 42,
          mimetype: index === 0 ? ' image/jpeg ' : '',
          caption: index === 0 ? ' caption ' : false,
          fileLength: lengths[index],
          fileSha256: hashes[index],
        },
      },
    });
    assert.equal(normalized.attachments[0].kind, kind);
    assert.equal(normalized.attachments[0].sizeBytes, Number(lengths[index]?.toNumber?.() ?? lengths[index]));
    assert.equal(normalized.attachments[0].downloaded, false);
    assert.equal(normalized.attachments[0].downloadStatus, 'not_downloaded');
    assert.equal(
      typeof normalized.attachments[0].rawMessageJson,
      typeof lengths[index] === 'bigint' ? 'undefined' : 'string',
    );
  }

  const first = normalizeBaileysMessage({
    key: { remoteJid: directJid, id: 'media-fields' },
    message: {
      imageMessage: {
        fileName: ' picture.jpg ',
        mimetype: ' image/jpeg ',
        caption: ' caption ',
        fileLength: 12,
        fileSha256: ' encoded-hash ',
      },
    },
  }).attachments[0];
  assert.equal(first.fileName, 'picture.jpg');
  assert.equal(first.mimeType, 'image/jpeg');
  assert.equal(first.caption, 'caption');
  assert.equal(first.sha256, 'encoded-hash');

  for (const fileLength of [0, Number.NaN, 2n ** 80n, 'nope', '9'.repeat(400), null, {}, { toNumber: 1 }, { toNumber: () => '1' }, { toNumber: () => Number.NaN }]) {
    const message = normalizeBaileysMessage({
      key: { remoteJid: directJid, id: `bad-length-${String(fileLength)}` },
      message: { documentMessage: { fileLength, fileSha256: 17 } },
    });
    assert.equal(message.attachments[0].sizeBytes, undefined);
    assert.equal(message.attachments[0].sha256, undefined);
  }

  for (const payload of [null, 'media', []]) {
    const message = normalizeBaileysMessage({
      key: { remoteJid: directJid, id: `bad-payload-${String(payload)}` },
      message: { imageMessage: payload },
    });
    assert.deepEqual(message.attachments, []);
  }

  const circular = {
    key: { remoteJid: directJid, id: 'circular' },
    message: { audioMessage: {} },
  };
  circular.self = circular;
  assert.equal(normalizeBaileysMessage(circular).attachments[0].rawMessageJson, undefined);
});

test('given chat snapshots, chat metadata falls back safely and keeps aliases unique', () => {
  assert.equal(normalizeBaileysChat(undefined), null);
  assert.equal(normalizeBaileysChat('chat'), null);
  assert.equal(normalizeBaileysChat({ id: 7 }), null);

  const complete = normalizeBaileysChat({
    id: ` ${directJid} `,
    name: ' Primary ',
    notify: 'Primary',
    verifiedName: ' Verified ',
    subject: 9,
    unreadCount: 3,
    muteEndTime: 1,
    conversationTimestamp: { toNumber: () => 100 },
  });
  assert.equal(complete.title, 'Primary');
  assert.deepEqual(complete.aliases, ['Primary', 'Verified']);
  assert.equal(complete.phoneNumber, '56912345678');
  assert.equal(complete.unreadCount, 3);
  assert.equal(complete.isMuted, true);
  assert.equal(complete.updatedAt, new Date(100_000).toISOString());

  const fallback = normalizeBaileysChat({
    id: 'team@g.us',
    name: ' ',
    notify: 4,
    verifiedName: '',
    subject: ' Team ',
    unreadCount: '3',
    muteEndTime: 0,
    lastMessageRecvTimestamp: 101,
  });
  assert.equal(fallback.title, 'Team');
  assert.deepEqual(fallback.aliases, ['Team']);
  assert.equal(fallback.phoneNumber, undefined);
  assert.equal(fallback.unreadCount, undefined);
  assert.equal(fallback.isMuted, undefined);
  assert.equal(fallback.updatedAt, new Date(101_000).toISOString());

  const before = Date.now();
  const minimal = normalizeBaileysChat({ id: 'plain' });
  assert.equal(minimal.title, undefined);
  assert.equal(minimal.aliases, undefined);
  assert.ok(Date.parse(minimal.updatedAt) >= before);
});

test('given contacts and messages, derived chats keep public identity while omitting unsupported fields', () => {
  assert.deepEqual(normalizeBaileysContact(null), []);
  assert.deepEqual(normalizeBaileysContact('contact'), []);
  assert.deepEqual(normalizeBaileysContact({}), []);

  const contacts = normalizeBaileysContact({
    id: ` ${directJid} `,
    lid: 'device-42@lid',
    phoneNumber: directJid,
    name: ' Alice ',
    notify: 'Alice',
    verifiedName: 9,
    username: ' alice-user ',
  });
  assert.equal(contacts.length, 2);
  assert.deepEqual(contacts.map((contact) => contact.chatId), [directJid, 'device-42@lid']);
  assert.deepEqual(contacts[0].aliases, ['Alice', 'alice-user']);
  assert.equal(contacts[1].phoneNumber, '42');

  const anonymous = normalizeBaileysContact({ id: 'team@g.us', name: ' ', notify: 7 });
  assert.equal(anonymous[0].title, undefined);
  assert.equal(anonymous[0].aliases, undefined);
  assert.equal(anonymous[0].phoneNumber, undefined);

  const directMessage = normalizeBaileysMessage({
    key: { remoteJid: directJid, id: 'derived' },
    message: { conversation: 'hello' },
  });
  const directChat = chatFromMessage(directMessage);
  assert.equal(directChat.phoneNumber, '56912345678');
  assert.deepEqual(directChat.lastMessageRef, directMessage.stableMessageRef);
  assert.equal(chatFromMessage({ ...directMessage, chatId: 'team@g.us', chatType: 'group' }).phoneNumber, undefined);
});
