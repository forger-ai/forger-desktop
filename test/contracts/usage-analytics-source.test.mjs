import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);

test('usage analytics declares Desktop install and ChatGPT connection events', async () => {
  const source = await readFile(path.join(root, 'src/shared/types/usage-events.ts'), 'utf8');

  assert.match(source, /'forger_installed'/);
  assert.match(source, /'chatgpt_connected'/);
});

test('forger_installed is privacy-safe and recorded once per local installation', async () => {
  const source = await readFile(path.join(root, 'src/renderer/usage-analytics.ts'), 'utf8');

  assert.match(source, /FORGER_INSTALLED_RECORDED_KEY/);
  assert.doesNotMatch(source, /hasAcceptedLegalWelcome/);
  assert.match(source, /recordedIdentifier === installationIdentifier/);
  assert.match(source, /eventName: 'forger_installed'/);
  assert.doesNotMatch(source, /forger_installed[\s\S]{0,220}stringParameters/);
  assert.doesNotMatch(source, /forger_installed[\s\S]{0,220}intParameters/);
});

test('chatgpt_connected is emitted only after successful authenticated ChatGPT connection', async () => {
  const controllerSource = await readFile(path.join(root, 'src/renderer/app/RendererAppController.tsx'), 'utf8');
  const analyticsSource = await readFile(path.join(root, 'src/renderer/usage-analytics.ts'), 'utf8');

  assert.match(controllerSource, /result\.success && nextStatus\.authenticated/);
  assert.match(controllerSource, /submitChatGptConnectedEvent\(\{ surface: 'settings', locale: t\.locale \}\)/);
  assert.match(analyticsSource, /eventName: 'chatgpt_connected'/);
  assert.doesNotMatch(analyticsSource, /chatgpt_connected[\s\S]{0,220}stringParameters/);
  assert.doesNotMatch(analyticsSource, /chatgpt_connected[\s\S]{0,220}intParameters/);
});
