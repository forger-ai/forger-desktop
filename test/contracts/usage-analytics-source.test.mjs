import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);

test('usage analytics declares Desktop install, funnel, and legacy events', async () => {
  const source = await readFile(path.join(root, 'src/shared/types/usage-events.ts'), 'utf8');

  assert.match(source, /'forger_installed'/);
  assert.match(source, /'forger_opened'/);
  assert.match(source, /'chatgpt_connected'/);
  assert.match(source, /'llm_provider_connected'/);
  assert.match(source, /'official_tool_connected'/);
  assert.match(source, /'catalog_app_downloaded'/);
  assert.match(source, /'local_app_created'/);
  assert.match(source, /'own_app_opened'/);
  assert.match(source, /'downloaded_app_opened'/);
  assert.match(source, /'own_app_modified'/);
  assert.match(source, /'downloaded_app_modified'/);
  assert.match(source, /'personal_agent_created'/);
  assert.match(source, /'personal_agent_message_sent'/);
  assert.match(source, /'automation_created'/);
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

test('usage analytics facade preserves ChatGPT legacy event from Codex connection reporting', async () => {
  const analyticsSource = await readFile(path.join(root, 'src/renderer/usage-analytics.ts'), 'utf8');

  assert.match(analyticsSource, /eventName: 'llm_provider_connected'/);
  assert.match(analyticsSource, /input\.provider === 'codex'/);
  assert.match(analyticsSource, /submitChatGptConnectedEvent\(/);
  assert.match(analyticsSource, /eventName: 'chatgpt_connected'/);
  assert.doesNotMatch(analyticsSource, /chatgpt_connected[\s\S]{0,220}stringParameters/);
  assert.doesNotMatch(analyticsSource, /chatgpt_connected[\s\S]{0,220}intParameters/);
});

test('llm_provider_connected is emitted only after successful authenticated provider connection', async () => {
  const controllerSource = await readFile(path.join(root, 'src/renderer/app/RendererAppController.tsx'), 'utf8');

  assert.match(controllerSource, /result\.success && nextStatus\.authenticated/);
  assert.match(controllerSource, /usageAnalytics\.llmProviderConnected\(\{ provider: 'codex', surface: 'settings', locale: t\.locale, origin: 'user_action' \}\)/);
  assert.match(controllerSource, /confirmation\.success[\s\S]{0,180}usageAnalytics\.llmProviderConnected\(\{ provider: 'claude', surface: 'settings', locale: t\.locale, origin: 'user_action' \}\)/);
  assert.match(controllerSource, /nextStatus\.authenticated[\s\S]{0,180}usageAnalytics\.llmProviderConnected\(\{ provider: 'antigravity', surface: 'settings', locale: t\.locale, origin: 'user_action' \}\)/);
});

test('startup reports opened and detected persistent provider, tool, and app state', async () => {
  const controllerSource = await readFile(path.join(root, 'src/renderer/app/RendererAppController.tsx'), 'utf8');

  assert.match(controllerSource, /usageAnalytics\.forgerOpened\(\{ surface: 'startup', locale: t\.locale \}\)/);
  assert.match(controllerSource, /value\.authenticated[\s\S]{0,160}origin: 'detected_on_startup'/);
  assert.match(controllerSource, /tool\.configured[\s\S]{0,180}usageAnalytics\.officialToolConnected\(\{ toolId: tool\.id, surface: 'startup', locale: t\.locale, origin: 'detected_on_startup' \}\)/);
  assert.match(controllerSource, /app\.socialSource[\s\S]{0,180}usageAnalytics\.catalogAppDownloaded\(\{ appId: app\.id, source: 'social', surface: 'startup', locale: t\.locale, origin: 'detected_on_startup' \}\)/);
  assert.match(controllerSource, /app\.privateLocal[\s\S]{0,180}usageAnalytics\.localAppCreated\(\{ appId: app\.id, surface: 'startup', locale: t\.locale, origin: 'detected_on_startup' \}\)/);
});

test('local_app_created is emitted from created app chat updates through the facade', async () => {
  const controllerSource = await readFile(path.join(root, 'src/renderer/app/RendererAppController.tsx'), 'utf8');

  assert.match(controllerSource, /createdAppUsageEventsRef/);
  assert.match(controllerSource, /run\.createdApp/);
  assert.match(controllerSource, /usageAnalytics\.localAppCreated\(\{ appId: run\.createdApp\.appId, surface: 'chat', locale: t\.locale, origin: 'user_action' \}\)/);
});

test('app modification is emitted only after an applied run includes a commit SHA', async () => {
  const controllerSource = await readFile(path.join(root, 'src/renderer/app/RendererAppController.tsx'), 'utf8');
  const analyticsSource = await readFile(path.join(root, 'src/renderer/usage-analytics.ts'), 'utf8');

  assert.match(controllerSource, /modifiedAppUsageEventsRef/);
  assert.match(controllerSource, /run\.status === 'applied' && run\.commitSha/);
  assert.match(controllerSource, /usageAnalytics\.appModified\(\{ appId: run\.appId, app: installedAppsRef\.current\.find/);
  assert.match(analyticsSource, /eventType === 'opened' \? 'own_app_opened' : 'own_app_modified'/);
  assert.match(analyticsSource, /eventType === 'opened' \? 'downloaded_app_opened' : 'downloaded_app_modified'/);
});

test('user action funnel events are emitted from successful Desktop actions', async () => {
  const controllerSource = await readFile(path.join(root, 'src/renderer/app/RendererAppController.tsx'), 'utf8');
  const viewSource = await readFile(path.join(root, 'src/renderer/app/RendererAppView.tsx'), 'utf8');
  const agentsSource = await readFile(path.join(root, 'src/renderer/views/AgentsView.tsx'), 'utf8');

  assert.match(controllerSource, /result\.success && result\.appId[\s\S]{0,220}usageAnalytics\.catalogAppDownloaded\(\{ appId: result\.appId, source: 'social', surface: 'social', locale: t\.locale, origin: 'user_action' \}\)/);
  assert.match(controllerSource, /result\.success\)[\s\S]{0,180}usageAnalytics\.appOpened\(\{ appId, app: installedApps\.find/);
  assert.match(controllerSource, /if \(!input\.id\) \{ usageAnalytics\.automationCreated\(\{ surface: 'automations', locale: t\.locale \}\); \}/);
  assert.match(controllerSource, /result\.success && analyticsAction === 'configure'[\s\S]{0,180}usageAnalytics\.officialToolConnected\(\{ toolId, surface: 'tools', locale: t\.locale, origin: 'user_action' \}\)/);
  assert.match(viewSource, /configureResult\.success[\s\S]{0,180}usageAnalytics\.officialToolConnected\(\{ toolId: 'whatsapp', surface: 'tools', locale: t\.locale, origin: 'user_action' \}\)/);
  assert.match(agentsSource, /personalAgentsCreate[\s\S]{0,420}usageAnalytics\.personalAgentCreated\(\{ surface: 'agents', locale: t\.locale \}\)/);
  assert.match(agentsSource, /personalAgentSendMessage[\s\S]{0,420}usageAnalytics\.personalAgentMessageSent\(\{ surface: 'agents', locale: t\.locale \}\)/);
});
