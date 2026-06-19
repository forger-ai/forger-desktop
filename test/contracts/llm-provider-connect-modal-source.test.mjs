import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const readSource = (relativePath) => fs.readFile(path.resolve(relativePath), 'utf8');

test('LLM provider connection modal has shared localized provider content and official policy links', async () => {
  const modalSource = await readSource('src/renderer/components/LlmProviderConnectModal.tsx');
  const dialogsSource = await readSource('src/renderer/app/RendererAppDialogs.tsx');
  const codexSource = await readSource('src/renderer/components/CodexConfigModal.tsx');
  const claudeSource = await readSource('src/renderer/components/ClaudeConfigModal.tsx');
  const englishSource = await readSource('src/renderer/i18n/en.ts');
  const spanishSource = await readSource('src/renderer/i18n/es.ts');

  for (const source of [englishSource, spanishSource]) {
    assert.match(source, /llmProviderConnect/);
    assert.match(source, /codex:[\s\S]*name: 'ChatGPT \/ Codex'[\s\S]*steps:/);
    assert.match(source, /claude:[\s\S]*name: 'Claude Code'[\s\S]*steps:/);
    assert.match(source, /antigravity:[\s\S]*name: 'Google Antigravity'[\s\S]*steps:/);
    assert.match(source, /checkbox: \(provider: string\)/);
  }

  assert.match(modalSource, /disabled=\{busy \|\| !accepted\}/);
  assert.match(modalSource, /setAccepted\(false\)/);
  assert.match(modalSource, /termsUrl/);
  assert.match(modalSource, /privacyUrl/);
  assert.match(modalSource, /onOpenExternalUrl/);
  assert.match(codexSource, /https:\/\/openai\.com\/policies\/row-terms-of-use\//);
  assert.match(codexSource, /https:\/\/openai\.com\/policies\/row-privacy-policy\//);
  assert.match(claudeSource, /https:\/\/support\.claude\.com\/en\/collections\/4078534-privacy-and-legal/);
  assert.match(claudeSource, /https:\/\/privacy\.claude\.com\/en\//);
  assert.match(dialogsSource, /https:\/\/antigravity\.google\/terms/);
  assert.match(dialogsSource, /https:\/\/transparency\.google\/intl\/en\/our-policies\/privacy-policy-terms-of-service/);
});

test('Antigravity sign in opens the shared connection modal before starting auth console', async () => {
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');
  const viewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const dialogsSource = await readSource('src/renderer/app/RendererAppDialogs.tsx');

  assert.match(controllerSource, /antigravityConfigOpen/);
  assert.match(controllerSource, /setAntigravityConfigOpen\(false\); setAntigravityAuthConsoleOpen\(true\)/);
  assert.match(viewSource, /onOpenAntigravityConfig=\{\(\) => setAntigravityConfigOpen\(true\)\}/);
  assert.match(dialogsSource, /<LlmProviderConnectModal[\s\S]*provider="antigravity"[\s\S]*onConnect=\{handleConnectAntigravityAuth\}/);
});
