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
} = require('../../dist-electron/main/prompt-builder/forger-base.js');
const {
  buildForgerAppAgentsMarkdown,
} = require('../../dist-electron/main/prompt-builder/apps-base.js');
const {
  buildCodexPromptForFreeChat,
  buildCodexPromptWithAppContext,
} = require('../../dist-electron/main/prompt-builder/user-message.js');
const {
  buildInstalledAppSkillTemplates,
  buildForgerOfficialToolSkillTemplates,
  buildForgerOfficialToolsPromptSection,
} = require('../../dist-electron/main/prompt-builder/official-tools.js');
const {
  bulletList,
  optionalSection,
  promptTemplateRoots,
  renderPromptFile,
  renderTemplate,
  resolvePromptTemplatePath,
} = require('../../dist-electron/main/prompt-builder/index.js');
const {
  catalogAppsSeed,
  installedAppsSeed,
  settingsSeed,
} = require('../../dist-electron/shared/mock-data.js');

const readSkillFiles = async () => {
  const skillsRoot = path.resolve('src/main/prompt-builder/prompts/skills');
  const entries = [];
  for (const group of ['global', 'forger', 'apps']) {
    const groupRoot = path.join(skillsRoot, group);
    const filenames = (await fs.readdir(groupRoot)).filter((entry) => entry.endsWith('.md')).sort();
    for (const filename of filenames) {
      const body = await fs.readFile(path.join(groupRoot, filename), 'utf8');
      const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(frontmatter, `${filename} has frontmatter`);
      const name = frontmatter[1].match(/^name:\s*(.*)$/m)?.[1];
      const description = frontmatter[1].match(/^description:\s*(.*)$/m)?.[1];
      assert.ok(name, `${filename} has a name`);
      assert.ok(description, `${filename} has a description`);
      entries.push({ group, filename, name, description, body });
    }
  }
  return entries;
};

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
    whatsappReady: true,
    chromeExtensionReady: true,
    allowedActions: [
      'gmail.search_messages',
      'gmail.send_email',
      'whatsapp.list_chats',
      'whatsapp.send_message',
      'forger_chrome_extension.connection.status',
      'forger_chrome_extension.open_dedicated_tab',
      'forger_chrome_extension.submit_form',
      'forger_chrome_extension.get_styles',
      'forger_chrome_extension.set_styles',
    ],
  });
  assert.match(officialTools, /Gmail status: connected and ready/);
  assert.match(officialTools, /WhatsApp status: connected or active locally/);
  assert.match(officialTools, /Forger Chrome Extension status: connected and ready/);
  assert.match(officialTools, /`gmail.search_messages`/);
  assert.match(officialTools, /`whatsapp.list_chats`/);
  assert.match(officialTools, /`forger_chrome_extension.connection.status`/);
  assert.match(officialTools, /`forger_chrome_extension.open_dedicated_tab`/);
  assert.match(officialTools, /`forger_chrome_extension.submit_form`/);
  assert.match(officialTools, /`forger_chrome_extension.get_styles`/);
  assert.match(officialTools, /`forger_chrome_extension.set_styles`/);
  assert.match(officialTools, /Free chat can inspect installed apps with `forger_list_installed_apps`/);
  assert.match(officialTools, /unofficial local WhatsApp Web integration/);
  assert.match(officialTools, /Use only chat IDs and message references returned by WhatsApp reads or listings/);
  assert.match(officialTools, /official Forger tool for a dedicated Chrome window/);
  assert.match(officialTools, /Use only `forger_chrome_extension\.\*` actions/);
  assert.match(officialTools, /Do not ask for arbitrary JavaScript execution/);
  assert.match(officialTools, /opening, launching, starting, running, or bringing up the app means using Forger app tools/);
  assert.match(officialTools, /Use the app runtime status tool/);
  assert.match(buildForgerOfficialToolsPromptSection({
    mode: 'free-chat',
    gmailReady: false,
  }), /Free chat can inspect official tool availability[\s\S]*WhatsApp must be activated[\s\S]*Chrome Extension must be activated[\s\S]*Gmail must be activated/);
  assert.match(buildForgerOfficialToolsPromptSection({
    mode: 'app-agent',
    gmailReady: false,
    allowedActions: [],
  }), /App agents may use official Forger tools[\s\S]*not declared any official Forger tool actions/);

  const appPrompt = buildCodexPromptWithAppContext({
    appId: 'finance-os',
    displayName: 'Finance OS',
    appRoot: '/Users/test/Forger/apps/finance-os',
    runRoot: '/Users/test/Forger/apps/finance-os/frontend',
    appStack: 'backend python/fastapi/uv; frontend typescript/react/vite/mui',
    runtime: 'provider codex, model gpt-5.4',
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
  assert.match(appPrompt, /APP_ROOT: \/Users\/test\/Forger\/apps\/finance-os/);
  assert.match(appPrompt, /RUN_ROOT: \/Users\/test\/Forger\/apps\/finance-os\/frontend/);
  assert.match(appPrompt, /APP_STACK: backend python\/fastapi\/uv; frontend typescript\/react\/vite\/mui/);
  assert.match(appPrompt, /RUNTIME: provider codex, model gpt-5\.4/);
  assert.doesNotMatch(appPrompt, /NETWORK ACCESS/);
  assert.match(appPrompt, /FORGER CHAT MODE: edit_app/);
  assert.match(appPrompt, /Treat `APP_ROOT` as the installed app repository root/);
  assert.match(appPrompt, /Treat `RUN_ROOT` as the current working directory/);
  assert.match(appPrompt, /Read the app's `AGENTS\.md` before making claims about the app's current facts/);
  assert.match(appPrompt, /Do not rely on the app `AGENTS\.md` for this edit workflow/);
  assert.match(appPrompt, /use the app's AGENTS\.md for app-specific facts/);
  assert.match(appPrompt, /Use the chat-mode instructions above for the Forger operational workflow/);
  assert.doesNotMatch(appPrompt, /follow the Forger contract in AGENTS\.md/);
  assert.match(appPrompt, /Always use Plan Mode before programming/);
  assert.match(appPrompt, /forger_ask_question/);
  assert.match(appPrompt, /functional scope, user intent, desired behavior/);
  assert.match(appPrompt, /Do not use it for low-impact design preferences/);
  assert.match(appPrompt, /affected flow/);
  assert.match(appPrompt, /Before editing, check the Git branch and status from `APP_ROOT`/);
  assert.match(appPrompt, /pre-existing unsaved changes/);
  assert.match(appPrompt, /smallest visible change/);
  assert.match(appPrompt, /For non-trivial behavior changes, write or update behavior\/spec tests before implementation/);
  assert.match(appPrompt, /Restart the installed app through Forger Desktop/);
  assert.match(appPrompt, /save the result as a new internal app version/);
  assert.match(appPrompt, /use APP_ROOT for versioning checks/);
  assert.match(appPrompt, /Opening or starting an installed app means opening it through Forger Desktop/);
  assert.match(appPrompt, /Use Forger MCP app tools to open the app and to check runtime status/);
  assert.match(appPrompt, new RegExp(`FORGER CONTRACT: ${FORGER_AGENT_CONTRACT_VERSION}`));
  assert.match(appPrompt, /Size: 1.5 KB/);
  assert.match(appPrompt, /USER MESSAGE:\nRevisar presupuesto/);
  const appResumePrompt = buildCodexPromptWithAppContext({
    turnKind: 'resume',
    appId: 'finance-os',
    displayName: 'Finance OS',
    appRoot: '/Users/test/Forger/apps/finance-os',
    runRoot: '/Users/test/Forger/apps/finance-os/frontend',
    appStack: 'backend python/fastapi/uv; frontend typescript/react/vite/mui',
    runtime: 'provider codex, model gpt-5.4',
    userPrompt: ' Continuar ',
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
  assert.doesNotMatch(appResumePrompt, /SELECTED APP/);
  assert.doesNotMatch(appResumePrompt, /^APP_ROOT:/m);
  assert.doesNotMatch(appResumePrompt, /Gmail status/);
  assert.match(appResumePrompt, /FORGER CHAT MODE: edit_app/);
  assert.match(appResumePrompt, /Do not rely on the app `AGENTS\.md` for this edit workflow/);
  assert.match(appResumePrompt, /Propose a concise implementation plan before programming/);
  assert.match(appResumePrompt, /Before editing, check the Git branch and status from `APP_ROOT`/);
  assert.match(appResumePrompt, /save the result as a new internal app version/);
  assert.match(appResumePrompt, /opening or starting an installed app means opening it through Forger Desktop/i);
  assert.match(appResumePrompt, /Use Forger MCP app tools to open the app and to check runtime status/);
  assert.doesNotMatch(appResumePrompt, /NETWORK ACCESS/);
  assert.match(appResumePrompt, /SHARED FILES IN THIS MESSAGE:[\s\S]*budget\.csv/);
  assert.match(appResumePrompt, /USER MESSAGE:\nContinuar/);
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
  assert.match(freePrompt, /FORGER CHAT MODE: free_chat/);
  assert.match(freePrompt, /free-form conversation with the agent/);
  assert.match(freePrompt, /Do not silently turn open-ended brainstorming into app creation or app editing/);
  assert.match(freePrompt, /# What Is Forger\?/);
  assert.match(freePrompt, /USER LANGUAGE: not configured/);
  assert.doesNotMatch(freePrompt, /NETWORK ACCESS/);
  assert.match(freePrompt, /No shared files/);
  const freeResumePrompt = buildCodexPromptForFreeChat({
    turnKind: 'resume',
    userPrompt: 'Sigue',
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
  });
  assert.match(freeResumePrompt, /FORGER CHAT MODE: free_chat/);
  assert.match(freeResumePrompt, /free-form conversation with the agent/);
  assert.doesNotMatch(freeResumePrompt, /# What Is Forger\?/);
  assert.doesNotMatch(freeResumePrompt, /Gmail status/);
  assert.doesNotMatch(freeResumePrompt, /NETWORK ACCESS/);
  assert.match(freeResumePrompt, /SHARED FILES IN THIS MESSAGE:[\s\S]*large\.csv/);
  assert.match(freeResumePrompt, /USER MESSAGE:\nSigue/);
  const createPrompt = buildCodexPromptForFreeChat({
    chatMode: 'create_app',
    userPrompt: 'Create a recipe planner',
    userLanguage: 'en',
    officialToolsContext: '',
    sharedFilesRootName: 'shared',
    sharedFiles: [],
  });
  assert.match(createPrompt, /FORGER CHAT MODE: create_app/);
  assert.match(createPrompt, /Prefer `forger_ask_question`/);
  assert.match(createPrompt, /Call `forger_create_app` only after the intent is clear enough/);
  assert.match(createPrompt, /Propose a concrete color palette/);
  assert.match(createPrompt, /keep working in this same chat/);
  assert.match(createPrompt, /Internally break the idea into product goals, user stories, data model/);
  const createResumePrompt = buildCodexPromptForFreeChat({
    turnKind: 'resume',
    chatMode: 'create_app',
    userPrompt: 'The main user is a home cook',
    userLanguage: 'en',
    officialToolsContext: '',
    sharedFilesRootName: 'shared',
    sharedFiles: [],
  });
  assert.match(createResumePrompt, /FORGER CHAT MODE: create_app/);
  assert.match(createResumePrompt, /pre-creation clarification/);
  assert.match(createResumePrompt, /USER MESSAGE:\nThe main user is a home cook/);
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
  assert.match(appAgents, /This app declares structured app tools/);
  assert.match(appAgents, /import: internal agent tool/);
  assert.match(appAgents, /This app may be installed and operated through Forger/);
  assert.match(appAgents, /fallback context file used when the app does not ship its own app-owned `AGENTS\.md`/);
  assert.match(appAgents, /Do not infer visible capabilities only from scripts/);
  assert.match(appAgents, /Shared files are task inputs only/);
  assert.match(appAgents, /Forger may inject relevant global memory or memory for this installed app/);
  assert.match(appAgents, /Use the `forger-memory` skill before reading, saving, updating, deduplicating, deleting, or explaining memory/);
  assert.match(appAgents, /Prefer structured app tools when they exist/);
  assert.match(appAgents, /When the person asks to open, launch, start, run, or bring up the app, use Forger Desktop app controls/);
  assert.match(appAgents, /Do not start app services manually with Python, uvicorn, npm, Vite, FastAPI, or localhost commands/);
  assert.match(appAgents, /Keep secret values out of prompts/);
  assert.doesNotMatch(appAgents, /## Response Language/);
  assert.doesNotMatch(appAgents, /You are the Forger agent/);
  assert.doesNotMatch(appAgents, /Use simple language for the person writing to Forger/);
  assert.match(buildForgerAppAgentsMarkdown('frontend-only', {
    stack: {
      backend: {},
      frontend: {},
    },
  }), /Backend: undefined[\s\S]*Frontend: undefined/);
  assert.match(buildForgerAppAgentsMarkdown('empty-app', null), /No structured app tools[\s\S]*No scripts declared[\s\S]*- Undefined/);

  const globalAgents = buildGlobalForgerAgentsMarkdown();
  assert.match(globalAgents, new RegExp(FORGER_AGENT_CONTRACT_MARKER));
  assert.match(globalAgents, /You are an agent inside Forger/);
  assert.match(globalAgents, /In this folder lives the Forger home/);
  assert.match(globalAgents, /Forger helps people download approved apps, create their own apps/);
  assert.match(globalAgents, /Forger home is the person's private local workspace/);
  assert.match(globalAgents, /## Response Language/);
  assert.match(globalAgents, /## Strict Domain/);
  assert.match(globalAgents, /## Shared Files/);
  assert.match(globalAgents, /## Source of Truth/);
  assert.match(globalAgents, /## Memory/);
  assert.match(globalAgents, /Forger memory is platform context/);
  assert.match(globalAgents, /Desktop also injects a dynamic memory registry before prompts/);
  assert.match(globalAgents, /registry lists memory titles and `read_when` conditions/);
  assert.match(globalAgents, /Memories without `read_when` are always-injected/);
  assert.match(globalAgents, /when you need an id for update or delete/);
  assert.match(globalAgents, /Use `forger-memory` before reading, saving, updating, deduplicating, deleting, or explaining memory/);
  assert.doesNotMatch(globalAgents, /memoryRegistry/);
  assert.match(globalAgents, /Treat the person as non-technical by default/);
  assert.match(globalAgents, /Use product words: app, screen, button, data, file, saved version, flow, result/);
  assert.match(globalAgents, /## Request Playbooks[\s\S]*## How To Speak With The Person/);
  assert.match(globalAgents, /### Building a New App[\s\S]*1\. Clarify the goal[\s\S]*2\. Shape the first minimum useful version[\s\S]*Remember your step by step plans using the memory/);
  assert.match(globalAgents, /### Building a New App[\s\S]*When creating or modifying a newly created app always scan your memory[\s\S]*Offer two or three product directions/);
  assert.match(globalAgents, /### Building a New App[\s\S]*use `forger-localization` before drafting labels, navigation, empty states, loading states, error states, success states/);
  assert.match(globalAgents, /### Asking Clarifying Questions[\s\S]*use `forger_ask_question` when it is available/);
  assert.match(globalAgents, /### Asking Clarifying Questions[\s\S]*creates the visual question interface/);
  assert.match(globalAgents, /### Asking Clarifying Questions[\s\S]*Do not write a menu, checklist, or numbered list of question options/);
  assert.match(globalAgents, /### Modifying an App[\s\S]*1\. Identify what should feel different[\s\S]*3\. Work on one visible improvement[\s\S]*4\. Save the result as a new version/);
  assert.match(globalAgents, /### Answering a Simple Question[\s\S]*1\. Identify the selected app[\s\S]*3\. Give a direct answer from verified app information/);
  assert.match(globalAgents, /### Working With App Data[\s\S]*1\. Identify which app and which data[\s\S]*3\. Prefer a safe preview[\s\S]*5\. Explain what was reviewed, loaded, changed, skipped, or left untouched/);
  assert.match(globalAgents, /### Resolving an App Update Conflict[\s\S]*1\. Protect the person's current app[\s\S]*4\. When something cannot be kept cleanly[\s\S]*6\. Finish by explaining what was kept/);
  assert.match(globalAgents, /### Solving a Problem[\s\S]*1\. Identify the affected app[\s\S]*2\. Understand what the person expected[\s\S]*6\. Finish by explaining what changed/);
  assert.match(globalAgents, /Never save, reveal, or repeat secrets/);
  assert.doesNotMatch(globalAgents, /Gmail manifest declaration example/);
  assert.doesNotMatch(globalAgents, /backend owns persistence, validation, import\/export rules/);
  assert.doesNotMatch(globalAgents, /Do not add JSON columns/);
  assert.doesNotMatch(globalAgents, /Treat `APP_ROOT` from the message prompt/);
  assert.throws(() => renderPromptFile('agents-md/global-forger.md', {
    forgerContractMarker: FORGER_AGENT_CONTRACT_MARKER,
  }), /prompt_template_variable_missing:forgerPartial/);
});

test('official tool skill templates and seed data keep expected Desktop defaults', async () => {
  const templates = buildForgerOfficialToolSkillTemplates();
  assert.deepEqual(templates.map((template) => template.id), [
    'forger-app-agents-authoring',
    'forger-app-mcp-data-tools',
    'forger-context',
    'forger-automations',
    'forger-dev-backend-development',
    'forger-dev-in-app-agents',
    'forger-frontend-patterns',
    'forger-gmail',
    'forger-installed-app-change',
    'forger-localization',
    'forger-manifest-authoring',
    'forger-memory',
    'forger-official-tools',
    'forger-permissions',
    'forger-product-docs',
    'forger-remote-tunnel-wiring',
    'forger-secrets',
    'forger-social-app-review',
    'forger-speech-to-text',
    'forger-text-to-speech',
    'forger-tools',
    'forger-whatsapp',
  ]);
  assert.ok(templates.every((template) => template.body.startsWith('---\nname:')));
  const skillFiles = await readSkillFiles();
  const workspaceSkillFiles = skillFiles.filter((entry) => entry.group === 'global' || entry.group === 'forger');
  assert.deepEqual(
    templates.map((template) => template.id),
    workspaceSkillFiles.map((entry) => entry.name),
  );
  for (const template of templates) {
    const file = workspaceSkillFiles.find((entry) => entry.name === template.id);
    assert.ok(file);
    assert.equal(template.description, file.description);
  }
  assert.deepEqual(buildInstalledAppSkillTemplates(['gmail.search_messages']).map((template) => template.id), [
    'forger-app-agents-authoring',
    'forger-app-mcp-data-tools',
    'forger-context',
    'forger-app-official-tools',
  ]);
  const appOfficialSkill = buildInstalledAppSkillTemplates(['gmail.search_messages', 'whatsapp.list_chats']).find((template) => template.id === 'forger-app-official-tools');
  assert.ok(appOfficialSkill);
  assert.equal(appOfficialSkill.description, 'Use when an installed app wants to call official Forger tools; limit tool calls to manifest-granted actions such as Gmail, WhatsApp, or Forger Chrome Extension read, inspect, browser-control, download, or send actions.');
  assert.match(appOfficialSkill.body, /`gmail\.search_messages`/);
  assert.match(appOfficialSkill.body, /`whatsapp\.list_chats`/);
  assert.match(appOfficialSkill.body, /commons\/backend\/forger_desktop\.py/);
  const manifestSkill = templates.find((template) => template.id === 'forger-manifest-authoring');
  assert.ok(manifestSkill);
  assert.match(manifestSkill.body, /## Full Manifest JSON Contract/);
  assert.match(manifestSkill.body, /"appSecrets": \[/);
  assert.match(manifestSkill.body, /"promptTemplates": \[/);
  assert.match(manifestSkill.body, /whatsapp\.send_message/);
  assert.match(manifestSkill.body, /"agents": \[/);
  assert.match(manifestSkill.body, /promptTemplates[\s\S]*agents[\s\S]*tools/);
  assert.match(manifestSkill.body, /"permissionMode": "safe"/);
  assert.match(manifestSkill.body, /claude-sonnet-4-6/);
  assert.match(manifestSkill.body, /Do not use legacy Claude Code aliases/);
  assert.match(manifestSkill.body, /gmail\.connection\.status/);
  assert.match(manifestSkill.body, /Every entry in `tools\.required\[\]` and `tools\.optional\[\]` must include `toolId`, `reason`, and `actions`/);
  assert.match(manifestSkill.body, /`reason` is required, not decorative/);
  assert.match(manifestSkill.body, /Do not add `catalog\.capabilities`/);
  assert.match(manifestSkill.body, /platformCapabilities\.speechToText[\s\S]*authorized realtime transcription workflow/);
  assert.match(manifestSkill.body, /platformCapabilities\.textToSpeech[\s\S]*explicit text, model, and voice/);
  const speechSkill = templates.find((template) => template.id === 'forger-speech-to-text');
  assert.ok(speechSkill);
  assert.match(speechSkill.body, /forger_speech_to_text_status/);
  assert.match(speechSkill.body, /realtime/);
  assert.match(speechSkill.body, /files explicitly shared/);
  assert.match(speechSkill.body, /not permission to capture audio on your own/);
  const ttsSkill = templates.find((template) => template.id === 'forger-text-to-speech');
  assert.ok(ttsSkill);
  assert.match(ttsSkill.body, /forger_text_to_speech_voices/);
  assert.match(ttsSkill.body, /text`, `model`, and `voice`/);
  assert.match(ttsSkill.body, /voice defines the language and locale/);
  assert.match(ttsSkill.body, /Do not rely on hidden defaults/);
  assert.equal(templates.some((template) => template.id === 'forger-agents'), false);
  assert.equal(templates.some((template) => template.id === 'forger-tasks'), false);
  assert.equal(templates.some((template) => template.id === 'forger-desktop-runtime-bridge'), false);
  assert.equal(templates.some((template) => template.id === 'forger-fastapi-contracts'), false);
  assert.equal(templates.some((template) => template.id === 'forger-python-backend'), false);
  assert.equal(templates.some((template) => template.id === 'forger-tanstack-query-patterns'), false);
  const inAppAgentsSkill = templates.find((template) => template.id === 'forger-dev-in-app-agents');
  assert.ok(inAppAgentsSkill);
  assert.equal(inAppAgentsSkill.description, 'Use when designing, implementing, reviewing, or explaining in-app AI flows, including manifest agent threads, promptTemplate tasks, Desktop runtime bridge calls, resumable conversations, progress UI, polling, cancellation, and app-visible results.');
  assert.match(inAppAgentsSkill.body, /App agents are app-declared conversational coworkers/);
  assert.match(inAppAgentsSkill.body, /Prompt template tasks are app-declared one-shot jobs/);
  assert.match(inAppAgentsSkill.body, /commons\/backend\/forger_desktop\.py/);
  assert.match(inAppAgentsSkill.body, /start_agent_task/);
  assert.match(inAppAgentsSkill.body, /start_manifest_agent_thread/);
  assert.match(inAppAgentsSkill.body, /resume_manifest_agent_thread/);
  assert.match(inAppAgentsSkill.body, /removed freeform endpoints/);
  assert.match(inAppAgentsSkill.body, /MCP writes, assistant task completion, and agent-generated changes should trigger an app-visible refresh/);
  assert.match(inAppAgentsSkill.body, /forger_get_app_runtime_status/);
  const backendDevelopmentSkill = templates.find((template) => template.id === 'forger-dev-backend-development');
  assert.ok(backendDevelopmentSkill);
  assert.equal(backendDevelopmentSkill.description, 'Use when creating or changing Forger app backend behavior, including FastAPI routes, SQLModel or SQLite persistence, migrations, validation, local data safety, API contracts, TanStack Query server-state refresh, MCP write refresh, polling, realtime updates, and backend tests.');
  assert.match(backendDevelopmentSkill.body, /FastAPI as the local app service layer/);
  assert.match(backendDevelopmentSkill.body, /typed Pydantic request and response models/);
  assert.match(backendDevelopmentSkill.body, /explicit SQLModel\/SQLite columns and relationships/);
  assert.match(backendDevelopmentSkill.body, /Migrations must preserve existing user data/);
  assert.match(backendDevelopmentSkill.body, /TanStack Query as the client-side server-state layer/);
  assert.match(backendDevelopmentSkill.body, /MCP tools, assistant tasks, imports, exports, backend jobs, or scripts write app data/);
  assert.match(backendDevelopmentSkill.body, /realtime or websocket support/);
  assert.match(backendDevelopmentSkill.body, /Do not rely on a full app reload/);
  assert.match(templates.find((template) => template.id === 'forger-tools')?.body ?? '', /^---\nname: forger-tools/m);
  const frontendPatternsSkill = templates.find((template) => template.id === 'forger-frontend-patterns');
  assert.ok(frontendPatternsSkill);
  assert.equal(frontendPatternsSkill.description, 'Use when creating or changing Forger app frontend code, UX, routed views, forms, responsive layouts, visual systems, Tailwind/shadcn components, interaction states, motion, accessibility, and final UI review.');
  assert.match(frontendPatternsSkill.body, /Tailwind CSS, shadcn\/ui copied components, and Radix primitives by default/);
  assert.match(frontendPatternsSkill.body, /Keep `forger-dev-backend-development` separate/);
  assert.match(frontendPatternsSkill.body, /Infer the app kind, target person, daily workflow/);
  assert.match(frontendPatternsSkill.body, /one radius logic, one accent logic, one density level/);
  assert.match(frontendPatternsSkill.body, /TanStack Router for new routed Forger apps/);
  assert.match(frontendPatternsSkill.body, /npm exec --yes shadcn@latest -- list @shadcn --limit 200 --cwd \./);
  assert.match(frontendPatternsSkill.body, /npm exec --yes shadcn@latest -- search @shadcn --query "date" --limit 50 --cwd \./);
  assert.match(frontendPatternsSkill.body, /npm exec --yes shadcn@latest -- add <component> --cwd \./);
  assert.match(frontendPatternsSkill.body, /Forms must prefer shadcn\/Radix for complex controls/);
  assert.match(frontendPatternsSkill.body, /date and time fields, check `calendar`, `popover`, `input`, `select`, `form`, `dialog`, `sheet`, `command`/);
  assert.match(frontendPatternsSkill.body, /Pills and badges are for compact status/);
  assert.match(frontendPatternsSkill.body, /Do not put cards inside cards/);
  assert.match(frontendPatternsSkill.body, /Mobile responsive is required/);
  assert.match(frontendPatternsSkill.body, /Use motion for view transitions/);
  assert.match(frontendPatternsSkill.body, /Check that no generic AI-default visual pattern/);
  assert.doesNotMatch(frontendPatternsSkill.body, /TasteSkill|Read the Room Before Anything Else|Anti-Default Discipline|The audience picks the aesthetic|Use cards ONLY when elevation communicates real hierarchy/);
  assert.equal(templates.some((template) => template.id === 'forger-app-shell-layout'), false);
  assert.equal(templates.some((template) => template.id === 'forger-frontend-product-patterns'), false);
  assert.equal(templates.some((template) => template.id === 'forger-frontend-structure'), false);
  assert.equal(templates.some((template) => template.id === 'forger-react-ui'), false);
  assert.equal(templates.some((template) => template.id.startsWith('forger-mui-')), false);
  assert.equal(templates.some((template) => template.id.startsWith('forger-tailwind-')), false);
  assert.equal(templates.some((template) => template.id === 'forger-mobile-responsive-frontend'), false);
  assert.equal(templates.some((template) => template.id === 'forger-web-interface-review'), false);
  const officialToolsSkill = templates.find((template) => template.id === 'forger-official-tools');
  assert.ok(officialToolsSkill);
  assert.doesNotMatch(officialToolsSkill.description, /memory/);
  assert.match(officialToolsSkill.body, /forger_open_app/);
  assert.doesNotMatch(officialToolsSkill.body, /Free chat/);
  assert.match(officialToolsSkill.body, /forger_chrome_extension\.connection\.status/);
  assert.match(officialToolsSkill.body, /forger_chrome_extension\.submit_form/);
  assert.match(officialToolsSkill.body, /commons\/backend\/forger_desktop\.py/);
  assert.match(officialToolsSkill.body, /Do not manually start app services/);
  const toolsSkill = templates.find((template) => template.id === 'forger-tools');
  assert.ok(toolsSkill);
  assert.match(toolsSkill.body, /Manifest `tools\.required\[\]` means the app cannot perform its core purpose/);
  assert.match(toolsSkill.body, /Manifest `tools\.optional\[\]` means the app can work without the tool/);
  assert.match(toolsSkill.body, /App agents may call official Forger tools only when the selected app context and grants allow/);
  assert.match(toolsSkill.body, /App backends may call granted official tools through the signed Desktop runtime bridge helpers/);
  assert.match(toolsSkill.body, /Agent-facing grant requests go through Forger MCP/);
  assert.match(toolsSkill.body, /UI grant toggles are for the person to allow or deny optional app access/);
  assert.match(toolsSkill.body, /A granted app may still need visible approval for sensitive actions/);
  const memorySkill = templates.find((template) => template.id === 'forger-memory');
  assert.ok(memorySkill);
  assert.equal(memorySkill.description, 'Use when reading, saving, updating, deduplicating, deleting, or explaining Forger platform memory, including injected memories, app-scoped memory, global preferences, privacy, and safe user-facing language.');
  assert.match(memorySkill.body, /## read_when/);
  assert.match(memorySkill.body, /Memory is a Forger platform layer/);
  assert.match(memorySkill.body, /not an installed app feature, app manifest grant, or optional official tool/);
  assert.match(memorySkill.body, /Memories without `read_when` are always-injected/);
  assert.match(memorySkill.body, /Memories with `read_when` are registered in context by title and condition/);
  assert.match(memorySkill.body, /Treat injected memories as already available context/);
  assert.match(memorySkill.body, /Read existing memory before saving/);
  assert.match(memorySkill.body, /Prefer `memory_update`/);
  assert.match(memorySkill.body, /Never save secrets, credentials, tokens, private keys/);
  assert.match(memorySkill.body, /I updated what Forger remembers/);
  const installedAppChangeSkill = templates.find((template) => template.id === 'forger-installed-app-change');
  assert.ok(installedAppChangeSkill);
  assert.match(installedAppChangeSkill.body, /Restart after structural app edits/);
  assert.match(installedAppChangeSkill.body, /forger_restart_app/);
  assert.match(installedAppChangeSkill.body, /frontend\/src\/App\.tsx/);
  assert.match(installedAppChangeSkill.body, /vite\.config/);
  assert.match(installedAppChangeSkill.body, /package\.json/);
  assert.match(installedAppChangeSkill.body, /FastAPI\/backend code/);
  assert.match(installedAppChangeSkill.body, /manifest services\/environment/);
  assert.match(installedAppChangeSkill.body, /Failed to resolve import/);
  assert.match(installedAppChangeSkill.body, /stopping and reopening the installed app, including its local services/);
  assert.match(installedAppChangeSkill.body, /Do not use `forger_refresh_app_view` as the recovery step after app edits/);
  const localizationSkill = templates.find((template) => template.id === 'forger-localization');
  assert.ok(localizationSkill);
  assert.equal(localizationSkill.description, 'Use when writing or changing user-facing app text, localization, language detection, assistant copy, prompt copy, labels, navigation, validation, empty/loading/error/success states, or messages.');
  assert.match(localizationSkill.body, /description: Use when writing or changing user-facing app text/);
  assert.match(localizationSkill.body, /User-facing text includes localized UI copy/);
  assert.match(localizationSkill.body, /empty states, loading states, error states, success states/);
  assert.match(localizationSkill.body, /\/api\/forger\/context/);
  assert.match(localizationSkill.body, /window\.forgerApp/);
  const productDocsSkill = templates.find((template) => template.id === 'forger-product-docs');
  assert.ok(productDocsSkill);
  assert.match(productDocsSkill.body, /Forger Documentation \/ Documentación de Forger is high-level product documentation/);
  assert.match(productDocsSkill.body, /what Forger is, how Forger works, which capabilities exist/);
  assert.match(productDocsSkill.body, /Do not use this documentation as the guide for creating an app, writing code, designing manifests, implementing MCP servers, changing app data, modifying installed apps/);
  assert.match(productDocsSkill.body, /verify the current state before answering/);
  assert.equal(installedAppsSeed.length, 2);
  assert.equal(catalogAppsSeed.some((app) => app.id === 'finance-os'), true);
  assert.equal(settingsSeed.safeMode, true);
  assert.equal(settingsSeed.defaultAgentProvider, 'auto');
  assert.equal(settingsSeed.defaultChatNetworkAccess, true);
  assert.equal(settingsSeed.agentDefaults.codex.model, settingsSeed.codexDefaults.model);
});

test('create app prompts do not inline official localization skill selection', async () => {
  const enSections = await fs.readFile(path.resolve('src/renderer/i18n/locales/enSections.ts'), 'utf8');
  const esSections = await fs.readFile(path.resolve('src/renderer/i18n/locales/esSections.ts'), 'utf8');

  assert.doesNotMatch(enSections, /Use forger-localization any time you write user-facing app text/);
  assert.doesNotMatch(esSections, /Usa forger-localization cada vez que escribas texto visible para la app/);
});

test('prompt-builder skills keep loading triggers in frontmatter descriptions', async () => {
  const skillFiles = await readSkillFiles();
  for (const skill of skillFiles) {
    const bodyWithoutFrontmatter = skill.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    assert.doesNotMatch(
      bodyWithoutFrontmatter,
      /Use this skill when|Use this skill before|This skill applies only/,
      `${skill.group}/${skill.filename} should not keep generic loading triggers in the body`,
    );
  }
});

test('prompt-builder skill frontmatter accepts Windows CRLF line endings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-skill-crlf-'));
  const previousEnvRoot = process.env.FORGER_DESKTOP_PROMPTS_ROOT;
  try {
    await fs.mkdir(path.join(root, 'skills', 'global'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'skills', 'global', 'crlf-skill.md'),
      [
        '---',
        'name: crlf-skill',
        'description: Use when verifying Windows packaged skill markdown.',
        '---',
        '',
        'Body with CRLF frontmatter.',
      ].join('\r\n'),
      'utf8',
    );

    process.env.FORGER_DESKTOP_PROMPTS_ROOT = root;

    assert.deepEqual(buildInstalledAppSkillTemplates().map((template) => template.id), [
      'crlf-skill',
      'forger-app-official-tools',
    ]);
  } finally {
    if (previousEnvRoot === undefined) {
      delete process.env.FORGER_DESKTOP_PROMPTS_ROOT;
    } else {
      process.env.FORGER_DESKTOP_PROMPTS_ROOT = previousEnvRoot;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prompt template helpers resolve configured roots and validate paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-prompt-roots-'));
  const envRoot = path.join(root, 'env-prompts');
  const resourcesRoot = path.join(root, 'resources');
  const previousEnvRoot = process.env.FORGER_DESKTOP_PROMPTS_ROOT;
  const previousResourcesPath = process.resourcesPath;
  try {
    await fs.mkdir(path.join(envRoot, 'custom'), { recursive: true });
    await fs.mkdir(path.join(resourcesRoot, 'prompt-builder', 'prompts', 'resource'), { recursive: true });
    await fs.writeFile(path.join(envRoot, 'custom', 'hello.md'), 'Hello {{ name }}\r\n', 'utf8');
    await fs.writeFile(path.join(resourcesRoot, 'prompt-builder', 'prompts', 'resource', 'fallback.md'), 'Resource {{value}}', 'utf8');

    process.env.FORGER_DESKTOP_PROMPTS_ROOT = envRoot;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesRoot,
    });

    assert.ok(promptTemplateRoots().includes(envRoot));
    assert.ok(promptTemplateRoots().includes(path.join(resourcesRoot, 'prompt-builder', 'prompts')));
    assert.equal(resolvePromptTemplatePath('/custom/hello.md'), path.join(envRoot, 'custom', 'hello.md'));
    assert.equal(renderPromptFile('custom/hello.md', { name: 'Forger' }), 'Hello Forger');
    assert.equal(renderPromptFile('resource/fallback.md', { value: 42 }), 'Resource 42');
    assert.equal(renderTemplate('A\r\n{{x}}\n', { x: null }, { trim: false }), 'A\n\n');
    assert.equal(optionalSection('  body  ', 'prefix:'), 'prefix:body');
    assert.equal(optionalSection('   ', 'prefix:'), '');
    assert.equal(bulletList(['- one'], '- empty'), '- one');
    assert.equal(bulletList([], '- empty'), '- empty');
    assert.throws(() => resolvePromptTemplatePath('../secret.md'), /prompt_template_path_invalid/);
    assert.throws(() => resolvePromptTemplatePath('missing.md'), /prompt_template_not_found/);
    assert.throws(() => renderTemplate('{{ required }}', { required: 'yes', 'required:other': true }), /prompt_template_required_unused/);
    assert.throws(() => renderTemplate('{{ missing }}', {}), /prompt_template_variable_missing:missing/);
  } finally {
    if (previousEnvRoot === undefined) {
      delete process.env.FORGER_DESKTOP_PROMPTS_ROOT;
    } else {
      process.env.FORGER_DESKTOP_PROMPTS_ROOT = previousEnvRoot;
    }
    if (previousResourcesPath === undefined) {
      delete process.resourcesPath;
    } else {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: previousResourcesPath,
      });
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prompt builder renders markdown templates strictly and exposes package roots', () => {
  assert.equal(renderTemplate('Hello {{name}}', { name: 'Forger' }), 'Hello Forger');
  assert.equal(renderTemplate('Line 1\n{{body}}', { body: 'Line 2\nLine 3' }), 'Line 1\nLine 2\nLine 3');
  assert.equal(renderTemplate('Optional: {{empty}}', { empty: '' }), 'Optional:');
  assert.throws(() => renderTemplate('Hello {{name}}', {}), /prompt_template_variable_missing:name/);
  assert.throws(() => renderTemplate('Hello {{outer}}', { outer: '{{inner}}' }), /prompt_template_unresolved:inner/);
  assert.match(resolvePromptTemplatePath('chat/app-chat-start.md'), /app-chat-start\.md$/);
  assert.ok(promptTemplateRoots().some((entry) => entry.includes('prompt-builder')));
  const automationPrompt = renderPromptFile('automations/global-automation.md', {
    automationName: 'Daily review',
    forgerPartial: renderPromptFile('partials/forger.md', {}),
    appLines: '- Finance OS (id: finance-os)',
    userInstruction: 'Summarize pending work.',
  });
  assert.match(automationPrompt, /# Forger Global Automation/);
  assert.match(automationPrompt, /# What Is Forger\?/);
  assert.match(automationPrompt, /## Included Apps/);
  assert.match(automationPrompt, /## User Instruction/);
});
