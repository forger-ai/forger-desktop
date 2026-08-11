import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const conversationHelpers = require('../../dist-electron/main/app-agent/conversation-helpers.js');
const taskHelpers = require('../../dist-electron/main/app-agent/task-helpers.js');
const {
  buildCodexRunFailureError,
  buildProviderRunFailureError,
} = require('../../dist-electron/main/app-agent/provider-failures.js');
const { resolveSidekickVoiceProfile } = require('../../dist-electron/main/sidekick-voice-profile.js');

const message = (messageId, role, text, runId) => ({
  messageId,
  role,
  text,
  runId,
  createdAt: `2026-08-10T00:00:0${messageId.length}.000Z`,
});

const run = (overrides = {}) => ({
  runId: 'run-active',
  status: 'running',
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:01.000Z',
  ...overrides,
});

test('Given absent and idle conversations, when public summaries are requested, then null and idle contracts stay explicit', () => {
  assert.equal(conversationHelpers.toAppAgentThreadSummary(null), null);
  assert.equal(conversationHelpers.toAppAgentRunSummary('thread', undefined), null);
  assert.equal(conversationHelpers.toAppAgentRunSummaryForId(null, 'thread', 'run'), null);

  assert.deepEqual(conversationHelpers.toAppAgentThreadSummary({
    conversationId: 'thread-idle',
    appId: 'finance',
    title: 'Idle thread',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    messages: [],
  }), {
    desktop_thread_id: 'thread-idle',
    title: 'Idle thread',
    status: 'idle',
    messages: [],
  });
});

test('Given active and historical runs, when summaries are built, then only observable result and activity fields are exposed', () => {
  const messages = [
    message('1', 'assistant', 'old result', 'run-old'),
    message('2', 'user', 'question', 'run-active'),
    message('3', 'assistant', '   ', 'run-active'),
    message('4', 'assistant', 'active result', 'run-active'),
  ];
  const activeRun = run({
    error: 'provider warning',
    progressLog: ['Preparing'],
    activity: { state: 'working', summary: 'Preparing' },
  });
  const conversation = {
    conversationId: 'thread-active',
    appId: 'finance',
    title: 'Active thread',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:01.000Z',
    messages,
    activeRun,
  };

  assert.deepEqual(conversationHelpers.toAppAgentThreadSummary(conversation), {
    desktop_thread_id: 'thread-active',
    title: 'Active thread',
    status: 'running',
    active_run: {
      desktop_thread_id: 'thread-active',
      desktop_run_id: 'run-active',
      status: 'running',
      error: 'provider warning',
      resultText: 'active result',
      progressLog: ['Preparing'],
      activity: { state: 'working', summary: 'Preparing' },
    },
    messages: messages.map((entry) => ({
      id: entry.messageId,
      role: entry.role,
      content: entry.text,
      created_at: entry.createdAt,
    })),
    progressLog: ['Preparing'],
  });
  assert.deepEqual(
    conversationHelpers.toAppAgentRunSummaryForId(conversation, 'thread-active', 'run-active'),
    conversationHelpers.toAppAgentRunSummary('thread-active', activeRun, messages),
  );
  assert.deepEqual(conversationHelpers.toAppAgentRunSummaryForId(conversation, 'thread-active', 'run-old'), {
    desktop_thread_id: 'thread-active',
    desktop_run_id: 'run-old',
    status: 'completed',
    resultText: 'old result',
  });
  assert.equal(conversationHelpers.toAppAgentRunSummaryForId(conversation, 'thread-active', 'missing'), null);

  const sparseMessages = [];
  sparseMessages.length = 1;
  sparseMessages.push(message('5', 'user', 'not an assistant result', 'run-active'));
  assert.equal(conversationHelpers.latestAssistantTextForRun(sparseMessages, 'run-active'), null);
  assert.deepEqual(conversationHelpers.toAppAgentRunSummary('thread', run({ status: 'completed' }), sparseMessages), {
    desktop_thread_id: 'thread',
    desktop_run_id: 'run-active',
    status: 'completed',
  });
});

test('Given provider MIME types and terminal states, when helpers normalize them, then every public variant is deterministic', () => {
  assert.equal(conversationHelpers.extensionForMimeType('image/jpeg'), 'jpg');
  assert.equal(conversationHelpers.extensionForMimeType('image/jpg'), 'jpg');
  assert.equal(conversationHelpers.extensionForMimeType('image/webp'), 'webp');
  assert.equal(conversationHelpers.extensionForMimeType('image/svg+xml'), 'svg');
  assert.equal(conversationHelpers.extensionForMimeType('application/octet-stream'), 'png');
  assert.equal(conversationHelpers.isTerminalRunStatus('completed'), true);
  assert.equal(conversationHelpers.isTerminalRunStatus('failed'), true);
  assert.equal(conversationHelpers.isTerminalRunStatus('canceled'), true);
  assert.equal(conversationHelpers.isTerminalRunStatus('running'), false);

  assert.deepEqual(conversationHelpers.toConversation({
    conversationId: 'without-run',
    appId: 'finance',
    title: 'No run',
    createdAt: 'a',
    updatedAt: 'b',
    messages: [],
  }), {
    conversationId: 'without-run',
    appId: 'finance',
    title: 'No run',
    createdAt: 'a',
    updatedAt: 'b',
    messages: [],
  });
  assert.deepEqual(conversationHelpers.toRun(run()), run());
  assert.deepEqual(conversationHelpers.toConversation({
    conversationId: 'with-run',
    appId: 'finance',
    title: 'Running',
    createdAt: 'a',
    updatedAt: 'b',
    messages: [],
    activeRun: run(),
  }).activeRun, run());
  assert.deepEqual(conversationHelpers.toRun(run({ activity: { state: 'working', summary: 'Active' } })).activity, {
    state: 'working',
    summary: 'Active',
  });

  const providerMessage = (text, type = 'agent_message', event = 'item.completed') => JSON.stringify({
    type: event,
    item: { type, text },
  });
  assert.equal(conversationHelpers.progressFromCodexOutput(providerMessage('```text\nhidden\n```')), null);
  assert.match(conversationHelpers.progressFromCodexOutput(providerMessage('A'.repeat(200))), /\.\.\.$/);
  assert.equal(conversationHelpers.progressFromCodexOutput(providerMessage('ignored', null)), null);
  assert.equal(conversationHelpers.progressFromCodexOutput(providerMessage('ignored', null, 'item.started')), null);
});

test('Given task arguments and provider events at boundary shapes, when helpers normalize them, then filenames, prompts, and progress stay safe', () => {
  assert.equal(taskHelpers.normalizeTaskLocale(null), 'es');
  assert.equal(taskHelpers.sanitizeFilename(''), 'attachment');
  const used = new Set(['report.csv', 'report-2.csv']);
  assert.equal(taskHelpers.uniqueFilename('report.csv', used), 'report-3.csv');

  assert.doesNotThrow(() => taskHelpers.validateAttachmentType(
    { acceptedFileTypes: ['.csv'] },
    { mimeType: undefined },
    'REPORT.CSV',
  ));
  assert.doesNotThrow(() => taskHelpers.validateFileArgumentType(
    { name: 'document', acceptedFileTypes: ['.pdf'] },
    { mimeType: undefined },
    'report.pdf',
  ));
  assert.deepEqual(taskHelpers.normalizeFileArgumentValue(
    { name: 'document', type: 'file', multiple: false },
    { type: 'file', name: 'report.pdf', dataBase64: 'cGRm' },
  ), [{ type: 'file', name: 'report.pdf', dataBase64: 'cGRm' }]);

  assert.match(taskHelpers.renderPrompt('Review', {
    variables: {},
    files: [{ argumentName: 'document', name: 'report', path: '/safe/report', mimeType: undefined }],
  }), /document\.report: \/safe\/report/);

  const event = (type, item) => JSON.stringify({ type, item });
  assert.match(taskHelpers.progressFromCodexOutput(event('item.started', { type: 'custom_tool' }), 'en'), /Using internal tools/);
  assert.equal(taskHelpers.progressFromCodexOutput(event('item.started', { type: null }), 'en'), null);
  assert.equal(taskHelpers.progressFromCodexOutput(event('item.completed', {
    type: 'agent_message',
    text: 'Short result.',
  }), 'en'), 'Short result.');
  assert.match(taskHelpers.progressFromCodexOutput(event('item.completed', {
    type: 'agent_message',
    text: 'A'.repeat(180),
  }), 'en'), /\.\.\.$/);
});

test('Given auth, timeout, unsupported-model, quota, and generic failures, when errors are classified, then provider-safe codes and copy are preserved', () => {
  const expired = buildCodexRunFailureError('', 'refresh token failed: 401 Unauthorized');
  assert.equal(expired.chatCode, 'codex_auth_expired');

  const timeout = buildProviderRunFailureError('claude', '', 'timed out due to inactivity after 20 seconds');
  assert.equal(timeout.chatCode, 'timeout');

  const unsupported = buildProviderRunFailureError('antigravity', '', "The 'gemini-old' model is not supported");
  assert.equal(unsupported.chatCode, 'model_unsupported');
  assert.equal(unsupported.message, 'Google Antigravity model unsupported: gemini-old');

  const quota = buildProviderRunFailureError('claude', '', 'Rate limit exceeded. Resets in 2 hours.');
  assert.equal(quota.chatCode, 'quota_exceeded');
  assert.match(quota.message, /Claude Code quota exceeded; resets 2 hours/);

  const stdoutFallback = buildProviderRunFailureError('claude', ' stdout failure ', '');
  assert.equal(stdoutFallback.message, 'stdout failure');
  assert.equal(stdoutFallback.chatCode, undefined);

  const explicitFallback = buildProviderRunFailureError('antigravity', ' ', ' ', 'stable_fallback');
  assert.equal(explicitFallback.message, 'stable_fallback');
  assert.equal(explicitFallback.chatCode, undefined);
  assert.equal(buildProviderRunFailureError('claude', '', '', 'empty_streams').message, 'empty_streams');
});

const voiceState = (voices, config = {}) => ({
  config: { defaultModel: 'kokoro', defaultVoice: 'default', maxTextCharacters: 2_000, ...config },
  voices,
});

const voice = (overrides = {}) => ({
  id: 'default',
  model: 'kokoro',
  language: 'English',
  locale: 'en-US',
  installed: true,
  enabled: true,
  ...overrides,
});

const profile = (voiceConfig, state) => resolveSidekickVoiceProfile({ voiceConfig }, state);

test('Given voice metadata variants, when the Sidekick profile resolves, then locale fallback and voice availability remain strict', () => {
  assert.deepEqual(profile({ conversationTtlMinutes: 5, sttLanguageMode: 'voice' }, voiceState([
    voice({ locale: 'not a locale', language: 'Portuguese' }),
  ])).locale, 'pt-BR');
  assert.deepEqual(profile({ conversationTtlMinutes: 5, sttLanguageMode: 'voice' }, voiceState([
    voice({ locale: undefined, language: 'Mandarin Chinese' }),
  ])).sttLanguages, ['zh']);
  assert.equal(profile({ conversationTtlMinutes: 5, sttLanguageMode: 'voice' }, voiceState([
    voice({ locale: 'und', language: 'Unknown' }),
  ])).sttLanguages, undefined);

  assert.throws(
    () => profile({ conversationTtlMinutes: 30 }, voiceState([])),
    /sidekick_voice_tts_voice_required/,
  );
  assert.throws(
    () => profile({ model: 'kokoro', voice: 'missing', conversationTtlMinutes: 30 }, voiceState([voice()])),
    /sidekick_voice_configured_voice_unavailable/,
  );
  assert.throws(
    () => profile({ conversationTtlMinutes: 30 }, voiceState([voice({ locale: '', language: 'Unknown' })])),
    /sidekick_voice_locale_unavailable/,
  );
});

test('Given malformed language preferences and TTLs, when the Sidekick profile resolves, then safe defaults and valid bounds win', () => {
  const state = voiceState([
    voice({ id: 'disabled', enabled: false }),
    voice({ id: 'fallback', locale: 'fr-FR' }),
  ], { defaultVoice: 'missing' });
  assert.deepEqual(profile({
    conversationTtlMinutes: 30.5,
    sttLanguageMode: 'subset',
    sttLanguages: [' ES ', 'invalid', 'es', 'FR'],
  }, state), {
    model: 'kokoro',
    voice: 'fallback',
    locale: 'fr-FR',
    sttLanguages: ['es', 'fr'],
    conversationTtlMs: 30 * 60_000,
  });
  assert.deepEqual(profile({
    conversationTtlMinutes: 5,
    sttLanguageMode: 'fixed',
    sttLanguages: ['FR', 'ES'],
  }, voiceState([voice()])), {
    model: 'kokoro',
    voice: 'default',
    locale: 'en-US',
    sttLanguages: ['fr'],
    conversationTtlMs: 5 * 60_000,
  });
  assert.deepEqual(profile({
    conversationTtlMinutes: 5,
    sttLanguageMode: 'subset',
    sttLanguages: ['FR'],
  }, voiceState([voice()])).sttLanguages, ['es', 'en']);
});
