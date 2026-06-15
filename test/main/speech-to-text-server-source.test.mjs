import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('speech to text realtime server uses real VAD, a separate worker process, and realtime metrics', async () => {
  const source = await readFile(path.join(root, 'resources/speech-to-text/server.py'), 'utf8');

  assert.match(source, /import multiprocessing/);
  assert.match(source, /import webrtcvad/);
  assert.match(source, /class VoiceActivityDetector/);
  assert.match(source, /class RealtimeTranscriptionWorker/);
  assert.match(source, /realtime_transcription_worker/);
  assert.match(source, /realtime_partial_coalesced/);
  assert.match(source, /realtime_transcribe_job_completed/);
  assert.match(source, /realtimeQueueDepth/);
  assert.match(source, /lastRealtimeFactor/);
  assert.doesNotMatch(source, /audio_file_too_large/);
  assert.doesNotMatch(source, /audio_duration_too_long/);
  assert.doesNotMatch(source, /max_file_size_mb/);
  assert.doesNotMatch(source, /max_duration_seconds/);
});
