import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ForgerAccountStore,
  normalizeForgerAccountUser,
  publicForgerAccount,
} = require('../../dist-electron/main/forger-account-store.js');
const {
  buildGlobalForgerAgentsMarkdown,
  FORGER_AGENT_CONTRACT_MARKER,
  FORGER_AGENT_CONTRACT_VERSION,
} = require('../../dist-electron/main/prompts/forger-base.js');
const {
  buildForgerAppAgentsMarkdown,
} = require('../../dist-electron/main/prompts/apps-base.js');
const {
  buildCodexPromptForFreeChat,
  buildCodexPromptWithAppContext,
} = require('../../dist-electron/main/prompts/user-message.js');
const {
  buildForgerOfficialToolSkillTemplates,
  buildForgerOfficialToolsPromptSection,
} = require('../../dist-electron/main/prompts/official-tools.js');
const {
  catalogAppsSeed,
  installedAppsSeed,
  settingsSeed,
} = require('../../dist-electron/shared/mock-data.js');

test('Forger account store normalizes persisted user sessions and clears local account files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-account-store-'));
  const filePath = path.join(root, 'account.json');
  try {
    assert.deepEqual(normalizeForgerAccountUser(null), undefined);
    assert.deepEqual(normalizeForgerAccountUser({ id: 'bad', email: 'person@example.com' }), undefined);
    assert.deepEqual(normalizeForgerAccountUser({
      id: '42',
      email: 'person@example.com',
      username: 'person',
      first_name: 'Ada',
      lastName: 'Lovelace',
      confirmed: true,
      subscription_tier: 'pro',
      username_changed_at: '2026-05-01T00:00:00.000Z',
      usernameChangeAvailableAt: '2026-06-01T00:00:00.000Z',
    }), {
      id: 42,
      email: 'person@example.com',
      username: 'person',
      firstName: 'Ada',
      lastName: 'Lovelace',
      confirmed: true,
      subscriptionTier: 'pro',
      usernameChangedAt: '2026-05-01T00:00:00.000Z',
      usernameChangeAvailableAt: '2026-06-01T00:00:00.000Z',
    });

    const store = new ForgerAccountStore(filePath);
    assert.deepEqual(await store.load(), { authenticated: false });
    await store.save({
      authenticated: true,
      token: 'secret-token',
      confirmationRequired: true,
      user: { id: 1, email: 'person@example.com', confirmed: true, subscriptionTier: 'free' },
    });
    const loaded = await store.load();
    assert.equal(loaded.authenticated, true);
    assert.equal(loaded.token, 'secret-token');
    assert.equal(loaded.confirmationRequired, true);
    assert.equal(publicForgerAccount(loaded).authenticated, true);
    assert.equal(publicForgerAccount({ authenticated: true }).authenticated, false);
    await store.clear();
    assert.deepEqual(await store.load(), { authenticated: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Forger prompt builders include contract, language, files, official tools, and user text', () => {
  const officialTools = buildForgerOfficialToolsPromptSection({
    mode: 'free-chat',
    gmailReady: true,
    allowedActions: ['gmail.search_messages', 'gmail.send_email'],
  });
  assert.match(officialTools, /Gmail status: connected and ready/);
  assert.match(officialTools, /`gmail.search_messages`/);
  assert.match(buildForgerOfficialToolsPromptSection({
    mode: 'free-chat',
    gmailReady: false,
  }), /Free chat can inspect official tool availability[\s\S]*Gmail must be activated/);
  assert.match(buildForgerOfficialToolsPromptSection({
    mode: 'app-agent',
    gmailReady: false,
    allowedActions: [],
  }), /App agents may use official Forger tools[\s\S]*not declared any official Forger tool actions/);

  const appPrompt = buildCodexPromptWithAppContext({
    appId: 'finance-os',
    displayName: 'Finance OS',
    userPrompt: ' Revisar presupuesto ',
    userLanguage: 'es',
    officialToolsContext: officialTools,
    sharedFilesRootName: 'shared',
    sharedFiles: [{
      name: 'budget.csv',
      relativePath: 'chat/budget.csv',
      sizeBytes: 1536,
      modifiedAt: '2026-05-21T00:00:00.000Z',
      source: 'attached',
    }],
  });
  assert.match(appPrompt, /SELECTED APP: \/finance-os/);
  assert.match(appPrompt, new RegExp(`FORGER CONTRACT: ${FORGER_AGENT_CONTRACT_VERSION}`));
  assert.match(appPrompt, /Size: 1.5 KB/);
  assert.match(appPrompt, /USER MESSAGE:\nRevisar presupuesto/);
  assert.match(buildCodexPromptWithAppContext({
    appId: 'recipes',
    displayName: 'Recipes',
    userPrompt: 'Abrir receta',
    userLanguage: ' ',
    officialToolsContext: ' ',
    sharedFilesRootName: 'shared',
    sharedFiles: [{
      name: 'note.txt',
      relativePath: 'mentions/note.txt',
      sizeBytes: Number.NaN,
      modifiedAt: '2026-05-21T00:00:00.000Z',
      source: 'mentioned',
    }],
  }), /USER LANGUAGE: not configured[\s\S]*Size: 0 B[\s\S]*mentioned with @/);
  assert.match(buildCodexPromptWithAppContext({
    appId: 'recipes',
    displayName: 'Recipes',
    userPrompt: 'Sin archivos',
    sharedFilesRootName: 'shared',
    sharedFiles: [],
  }), /USER LANGUAGE: not configured[\s\S]*No shared files/);

  const freePrompt = buildCodexPromptForFreeChat({
    userPrompt: 'Hola',
    userLanguage: '',
    officialToolsContext: '',
    sharedFilesRootName: 'shared',
    sharedFiles: [],
  });
  assert.match(freePrompt, /FORGER CHAT MODE: free chat/);
  assert.match(freePrompt, /USER LANGUAGE: not configured/);
  assert.match(freePrompt, /No shared files/);
  assert.match(buildCodexPromptForFreeChat({
    userPrompt: 'Leer archivo',
    userLanguage: 'en',
    officialToolsContext: 'Gmail status: connected.',
    sharedFilesRootName: 'shared',
    sharedFiles: [{
      name: 'large.csv',
      relativePath: 'attached/large.csv',
      sizeBytes: 1024 * 1024 * 2,
      modifiedAt: '2026-05-21T00:00:00.000Z',
      source: 'attached',
    }],
  }), /Gmail status: connected\.[\s\S]*Size: 2\.0 MB[\s\S]*attached in this message/);
  assert.match(buildCodexPromptForFreeChat({
    userPrompt: 'Leer archivo mencionado',
    userLanguage: 'en',
    officialToolsContext: ' ',
    sharedFilesRootName: 'shared',
    sharedFiles: [{
      name: 'report.csv',
      relativePath: 'mentions/report.csv',
      sizeBytes: 1,
      modifiedAt: '2026-05-21T00:00:00.000Z',
      source: 'mentioned',
    }],
  }), /Size: 1 B[\s\S]*mentioned with @/);

  const appAgents = buildForgerAppAgentsMarkdown('finance-os', {
    name: 'Finance OS',
    stack: {
      backend: { language: 'Python', framework: 'FastAPI', package_manager: 'uv', database: 'SQLite' },
      frontend: { language: 'TypeScript', framework: 'React', bundler: 'Vite', ui: 'MUI' },
    },
    scripts: { import: 'python scripts/import.py' },
    mcp: { command: 'python mcp.py' },
  });
  assert.match(appAgents, /Backend: language Python, framework FastAPI/);
  assert.match(appAgents, /Frontend: language TypeScript, framework React/);
  assert.match(appAgents, /This app declares MCP tools/);
  assert.match(appAgents, /import: internal agent tool/);
  assert.match(buildForgerAppAgentsMarkdown('frontend-only', {
    stack: {
      backend: {},
      frontend: {},
    },
  }), /Backend: undefined[\s\S]*Frontend: undefined/);
  assert.match(buildForgerAppAgentsMarkdown('empty-app', null), /No app MCP tools[\s\S]*No scripts declared[\s\S]*- Undefined/);

  const globalAgents = buildGlobalForgerAgentsMarkdown();
  assert.match(globalAgents, new RegExp(FORGER_AGENT_CONTRACT_MARKER));
  assert.match(globalAgents, /Do not use external files/);
});

test('official tool skill templates and seed data keep expected Desktop defaults', () => {
  const templates = buildForgerOfficialToolSkillTemplates();
  assert.deepEqual(templates.map((template) => template.id), [
    'forger-official-tools',
    'forger-gmail',
    'forger-permissions',
  ]);
  assert.ok(templates.every((template) => template.body.startsWith('---\nname:')));
  assert.equal(installedAppsSeed.length, 2);
  assert.equal(catalogAppsSeed.some((app) => app.id === 'finance-os'), true);
  assert.equal(settingsSeed.safeMode, true);
  assert.equal(settingsSeed.defaultAgentProvider, 'auto');
  assert.equal(settingsSeed.agentDefaults.codex.model, settingsSeed.codexDefaults.model);
});
