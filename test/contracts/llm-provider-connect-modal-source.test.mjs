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
  assert.doesNotMatch(modalSource, /onRefresh/);
  assert.doesNotMatch(modalSource, /onReinstall/);
  assert.doesNotMatch(modalSource, /llmProviderConnect\.refresh/);
  assert.doesNotMatch(modalSource, /llmProviderConnect\.reinstall/);
  assert.doesNotMatch(codexSource, /onRefresh=\{onRefresh\}/);
  assert.doesNotMatch(claudeSource, /onRefresh=\{onRefresh\}/);
  assert.doesNotMatch(claudeSource, /onReinstall=\{onReinstall\}/);
  assert.match(codexSource, /https:\/\/openai\.com\/policies\/row-terms-of-use\//);
  assert.match(codexSource, /https:\/\/openai\.com\/policies\/row-privacy-policy\//);
  assert.match(claudeSource, /https:\/\/support\.claude\.com\/en\/collections\/4078534-privacy-and-legal/);
  assert.match(claudeSource, /https:\/\/privacy\.claude\.com\/en\//);
  assert.match(dialogsSource, /https:\/\/antigravity\.google\/terms/);
  assert.match(dialogsSource, /https:\/\/transparency\.google\/intl\/en\/our-policies\/privacy-policy-terms-of-service/);
});

test('Antigravity sign in opens the shared connection modal before launching system Terminal login', async () => {
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');
  const viewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const dialogsSource = await readSource('src/renderer/app/RendererAppDialogs.tsx');

  assert.match(controllerSource, /antigravityConfigOpen/);
  assert.match(controllerSource, /getDesktopApi\(\)\.connectAntigravityAuth\(\)/);
  assert.doesNotMatch(controllerSource, /getDesktopApi\(\)\.startAntigravityAuthSession\(\)/);
  assert.match(controllerSource, /setAntigravityAuthConsoleOpen\(false\)/);
  assert.match(viewSource, /onOpenAntigravityConfig=\{\(\) => setAntigravityConfigOpen\(true\)\}/);
  assert.match(dialogsSource, /<LlmProviderConnectModal[\s\S]*provider="antigravity"[\s\S]*onConnect=\{handleConnectAntigravityAuth\}/);
});

test('LLM provider settings keep system profiles internal while showing simple provider defaults', async () => {
  const settingsSource = await readSource('src/renderer/views/SettingsView.tsx');
  const viewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');
  const registrySource = await readSource('src/shared/agent-runtime-registry.ts');
  const englishSource = await readSource('src/renderer/i18n/en.ts');
  const spanishSource = await readSource('src/renderer/i18n/es.ts');

  assert.match(settingsSource, /llmProviderProfiles/);
  assert.match(settingsSource, /activeProviderProfiles/);
  assert.match(settingsSource, /onActiveProviderProfileChange/);
  assert.doesNotMatch(settingsSource, /providerConnectedAccountsTitle/);
  assert.doesNotMatch(settingsSource, /providerAccountFallbackHint/);
  assert.match(viewSource, /llmProviderProfiles=\{settings\.llmProviderProfiles\}/);
  assert.match(viewSource, /activeProviderProfiles=\{settings\.activeProviderProfiles\}/);
  assert.doesNotMatch(viewSource, /providerOptionsWithAccounts/);
  assert.match(viewSource, /<AgentsView[\s\S]*providerOptions=\{visibleProviderOptions\}/);
  assert.match(viewSource, /onActiveProviderProfileChange=\{\(input\) => void handleActiveProviderProfileChange\(input\)\}/);
  assert.match(controllerSource, /setActiveLlmProviderProfile/);
  assert.match(registrySource, /label: 'ChatGPT', value: 'codex'/);
  assert.match(registrySource, /label: 'Claude', value: 'claude'/);
  assert.match(registrySource, /label: 'Google', value: 'antigravity'/);

  assert.match(englishSource, /llmProviderTitle: 'AI accounts'/);
  assert.match(englishSource, /providerSignInAction: 'Connect account'/);
  assert.match(spanishSource, /llmProviderTitle: 'Cuentas de IA'/);
  assert.match(spanishSource, /providerSignInAction: 'Conectar cuenta'/);
});
