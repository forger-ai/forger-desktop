import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SidekickMicrophonePreprocessor,
  chunkSidekickPcm,
  parsePcm16MonoWav,
  resamplePcm16Mono,
} = require('../../dist-electron/main/sidekick-audio-codec.js');
const { telegramToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/telegram.js');
const { getChromeAppRuntimeUrlBlock } = require('../../dist-electron/main/forger-mcp/internal-tools.js');
const { getMcpToolInputSchema } = require('../../dist-electron/main/forger-mcp/tool-metadata.js');

const wavFixture = (samples = [1, -1], sampleRate = 24_000) => {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
};

test('audio codec rejects every malformed rate, chunk, RIFF, format, and data boundary', () => {
  for (const rate of [8_000.5, 7_999, 96_001]) {
    assert.throws(() => new SidekickMicrophonePreprocessor(rate), /sidekick_audio_sample_rate_invalid/);
  }

  const wrongRiff = wavFixture();
  wrongRiff.write('NOPE', 0, 'ascii');
  assert.throws(() => parsePcm16MonoWav(wrongRiff), /sidekick_wav_invalid/);
  const wrongWave = wavFixture();
  wrongWave.write('NOPE', 8, 'ascii');
  assert.throws(() => parsePcm16MonoWav(wrongWave), /sidekick_wav_invalid/);
  for (const declared of [0, 10_000]) {
    const wav = wavFixture();
    wav.writeUInt32LE(declared, 4);
    assert.throws(() => parsePcm16MonoWav(wav), /sidekick_wav_invalid/);
  }
  const overlongChunk = wavFixture();
  overlongChunk.writeUInt32LE(1_000, 16);
  assert.throws(() => parsePcm16MonoWav(overlongChunk), /sidekick_wav_invalid/);
  const shortFormat = wavFixture();
  shortFormat.writeUInt32LE(8, 16);
  assert.throws(() => parsePcm16MonoWav(shortFormat), /sidekick_wav_invalid/);
  const nonPcm = wavFixture();
  nonPcm.writeUInt16LE(3, 20);
  assert.throws(() => parsePcm16MonoWav(nonPcm), /sidekick_wav_pcm16_required/);
  for (const mutate of [
    (wav) => wav.writeUInt16LE(8, 34),
    (wav) => wav.writeUInt32LE(0, 24),
    (wav) => wav.writeUInt32LE(7_999, 24),
    (wav) => wav.writeUInt32LE(96_001, 24),
  ]) {
    const wav = wavFixture();
    mutate(wav);
    assert.throws(() => parsePcm16MonoWav(wav), /sidekick_wav_pcm16_required/);
  }
  const noData = wavFixture();
  noData.write('skip', 36, 'ascii');
  assert.throws(() => parsePcm16MonoWav(noData), /sidekick_wav_invalid/);
  const oddData = wavFixture();
  oddData.writeUInt32LE(1, 40);
  assert.throws(() => parsePcm16MonoWav(oddData), /sidekick_wav_invalid/);

  for (const [sourceRate, targetRate] of [[1.5, 16_000], [16_000, 1.5], [0, 16_000], [16_000, 0]]) {
    assert.throws(() => resamplePcm16Mono(Int16Array.of(1), sourceRate, targetRate), /sidekick_audio_sample_rate_invalid/);
  }
  assert.deepEqual(Array.from(resamplePcm16Mono(new Int16Array(), 16_000, 8_000)), []);
  assert.deepEqual(Array.from(resamplePcm16Mono(Int16Array.of(1, 2), 16_000, 16_000)), [1, 2]);
  for (const chunkSize of [1.5, 0, 1_025]) {
    assert.throws(() => chunkSidekickPcm(Int16Array.of(1), chunkSize), /sidekick_audio_chunk_size_invalid/);
  }
});

test('MCP metadata and Chrome runtime guard expose creation, draft, and safe URL contracts', () => {
  assert.deepEqual(getMcpToolInputSchema('forger_create_personal_agent').required, ['name']);
  assert.equal(getMcpToolInputSchema('gmail.list_drafts').properties.maxResults.type, 'number');
  const base = {
    appId: 'demo',
    toolId: 'forger_chrome_extension.navigate',
    targetUrl: 'https://public.example/path',
    status: { status: 'running', frontendUrl: 'http://127.0.0.1:3000', backendUrl: 'http://127.0.0.1:8000' },
  };
  assert.equal(getChromeAppRuntimeUrlBlock({ ...base, toolId: 'forger_open_app' }), null);
  assert.equal(getChromeAppRuntimeUrlBlock({ ...base, appId: 'forger' }), null);
  assert.equal(getChromeAppRuntimeUrlBlock({ ...base, targetUrl: 'not a url' }), null);
  assert.equal(getChromeAppRuntimeUrlBlock(base), null);
  assert.equal(getChromeAppRuntimeUrlBlock({
    ...base,
    status: { status: 'running', frontendUrl: 'not a url', backendUrl: undefined },
  }), null);
});

const createTelegramContext = () => {
  const values = new Map();
  return {
    values,
    context: {
      metadataRoot: '/tmp/forger-b29-telegram',
      secretsStore: {
        getToolSecret: async (toolId, name) => values.get(`${toolId}:${name}`),
        setToolSecret: async (toolId, name, value) => {
          values.set(`${toolId}:${name}`, value);
          return { success: true };
        },
        hasToolSecret: async (toolId, name) => values.has(`${toolId}:${name}`),
        deleteToolSecrets: async () => ({ success: true }),
      },
    },
  };
};

test('Telegram connector validates bots and maps reads, writes, deletion, callback, and API failures', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  let deleteResult = true;
  let apiFailure = false;
  let missingBotId = false;
  globalThis.fetch = async (url, options = {}) => {
    const request = new URL(url);
    const method = request.pathname.split('/').at(-1);
    calls.push({ method, options });
    if (apiFailure) return new Response(JSON.stringify({ ok: false, description: '' }), { status: 200 });
    if (method === 'getMe') return new Response(JSON.stringify({ ok: true, result: missingBotId ? { username: 'named-bot' } : { id: 42, username: '', first_name: 'Forger Bot' } }), { status: 200 });
    if (method === 'getUpdates') return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1 }] }), { status: 200 });
    if (method === 'deleteMessage') return new Response(JSON.stringify({ ok: true, result: deleteResult }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7, method } }), { status: 200 });
  };

  try {
    const { context } = createTelegramContext();
    const configured = await telegramToolModule.configure(context, {
      toolId: 'telegram',
      secrets: { bot_token: ' bot-token ' },
    });
    assert.equal(configured.success, true);
    assert.equal(calls[0].options.method, 'GET');

    const execute = (actionId, input = {}) => telegramToolModule.execute({ toolId: 'telegram', actionId, input }, context);
    assert.equal((await execute('telegram.connection.status')).data.username, 'Forger Bot');
    assert.equal((await execute('telegram.send_message', { chatId: '', text: 'hello' })).technicalCode, 'telegram_chatId_required');
    assert.equal((await execute('telegram.send_message', { chatId: '1', text: '' })).technicalCode, 'telegram_text_required');
    assert.equal((await execute('telegram.get_updates')).data.updates.length, 1);
    assert.equal((await execute('telegram.get_updates', { limit: 5 })).success, true);
    for (const [actionId, input] of [
      ['telegram.send_message', { chatId: '1', text: 'hello' }],
      ['telegram.send_photo', { chatId: '1', photo: 'https://example.com/photo.jpg', caption: undefined }],
      ['telegram.send_document', { chatId: '1', document: 'file-id', caption: 'report' }],
      ['telegram.edit_message_text', { chatId: '1', messageId: '2', text: 'edited' }],
      ['telegram.answer_callback_query', { callbackQueryId: 'cb-1', text: 'done' }],
    ]) {
      assert.equal((await execute(actionId, input)).success, true, actionId);
    }
    assert.equal(calls.some((call) => call.options.method === 'POST'), true);
    assert.equal((await execute('telegram.delete_message', { chatId: '1', messageId: '2' })).data.deleted, true);
    deleteResult = false;
    assert.equal((await execute('telegram.delete_message', { chatId: '1', messageId: '2' })).data.deleted, false);
    apiFailure = true;
    const failed = await execute('telegram.send_message', { chatId: '1', text: 'hello' });
    assert.equal(failed.technicalCode, 'telegram_api_error');
    assert.equal(failed.userMessage, 'Telegram rechazo la accion.');
    assert.equal((await execute('telegram.get_updates')).technicalCode, 'telegram_api_error');
    const invalidConfiguration = await telegramToolModule.configure(context, {
      toolId: 'telegram',
      secrets: { bot_token: 'invalid-token' },
    });
    assert.equal(invalidConfiguration.success, false);
    assert.equal(invalidConfiguration.technicalCode, 'telegram_api_error');
    apiFailure = false;
    missingBotId = true;
    assert.equal((await execute('telegram.connection.status')).data.subject, '');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
