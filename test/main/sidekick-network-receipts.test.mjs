import assert from 'node:assert/strict';
import test from 'node:test';

import { SidekickSpeakerReceipts } from '../../dist-electron/main/sidekick-network-receipts.js';

test('Sidekick speaker acknowledgements have a hard deadline and release their pending slot', async () => {
  const receipts = new SidekickSpeakerReceipts(10);
  const runtime = { pendingSpeakerAcks: new Map() };
  await Promise.all([
    assert.rejects(receipts.wait(runtime, 'progress:playback-1:0'), /sidekick_speaker_ack_timeout/),
    new Promise((resolve) => setTimeout(resolve, 20)),
  ]);
  assert.equal(runtime.pendingSpeakerAcks.size, 0);
});

test('Sidekick speaker uses negotiated transport credits and falls back safely for legacy firmware', () => {
  const receipts = new SidekickSpeakerReceipts();
  const createRuntime = () => ({
    pendingSpeakerAcks: new Map(),
    speakerPlayback: {
      playbackId: 'playback-1',
      status: 'starting',
      queueDepth: 1,
      maxInFlightChunks: 1,
    },
  });

  const negotiated = createRuntime();
  receipts.handleStarted(negotiated, {
    playbackId: 'playback-1',
    maxChunkSamples: 1024,
    queueDepth: 8,
    maxInFlightChunks: 3,
  });
  assert.equal(negotiated.speakerPlayback.status, 'playing');
  assert.equal(negotiated.speakerPlayback.queueDepth, 8);
  assert.equal(negotiated.speakerPlayback.maxInFlightChunks, 3);

  const legacy = createRuntime();
  receipts.handleStarted(legacy, {
    playbackId: 'playback-1',
    maxChunkSamples: 1024,
    queueDepth: 8,
  });
  assert.equal(legacy.speakerPlayback.status, 'playing');
  assert.equal(legacy.speakerPlayback.maxInFlightChunks, 1);
});
