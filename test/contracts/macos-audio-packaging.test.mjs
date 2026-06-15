import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const readEntitlements = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('macOS package declares microphone usage and audio input entitlements', () => {
  assert.equal(typeof packageJson.build?.mac?.extendInfo?.NSMicrophoneUsageDescription, 'string');
  assert.match(packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/i);
  assert.equal(typeof packageJson.build.mac.extendInfo.NSAudioCaptureUsageDescription, 'string');
  assert.match(packageJson.build.mac.extendInfo.NSAudioCaptureUsageDescription, /audio/i);

  for (const path of ['../../build/entitlements.mac.plist', '../../build/entitlements.mac.inherit.plist']) {
    const entitlements = readEntitlements(path);
    assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
    assert.match(entitlements, /<true\/>/);
  }
});
