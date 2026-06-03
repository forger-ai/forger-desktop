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
      const frontmatter = body.match(/^---\n([\s\S]*?)\n---/);
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
    allowedActions: ['gmail.search_messages', 'gmail.send_email'],
  });
  assert.match(officialTools, /Gmail status: connected and ready/);
  assert.match(officialTools, /`gmail.search_messages`/);
  assert.match(officialTools, /opening, launching, starting, running, or bringing up the app means using Forger app tools/);
  assert.match(officialTools, /Use the app runtime status tool/);
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
    appRoot: '/Users/test/Forger/apps/finance-os',
    runRoot: '/Users/test/Forger/apps/finance-os/frontend',
    appStack: 'backend python/fastapi/uv; frontend typescript/react/vite/mui',
    runtime: 'provider codex, model gpt-5.4',
    networkAccess: false,
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
  assert.match(appPrompt, /NETWORK ACCESS: disabled/);
  assert.match(appPrompt, /FORGER CHAT MODE: edit_app/);
  assert.match(appPrompt, /Always use Plan Mode before programming/);
  assert.match(appPrompt, /forger_ask_question/);
  assert.match(appPrompt, /functional scope, user intent, desired behavior/);
  assert.match(appPrompt, /Do not use it for low-impact design preferences/);
  assert.match(appPrompt, /affected flow/);
  assert.match(appPrompt, /smallest visible change/);
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
    networkAccess: false,
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
  assert.doesNotMatch(appResumePrompt, /APP_ROOT/);
  assert.doesNotMatch(appResumePrompt, /Gmail status/);
  assert.match(appResumePrompt, /FORGER CHAT MODE: edit_app/);
  assert.match(appResumePrompt, /Propose a concise implementation plan before programming/);
  assert.match(appResumePrompt, /opening or starting an installed app means opening it through Forger Desktop/i);
  assert.match(appResumePrompt, /Use Forger MCP app tools to open the app and to check runtime status/);
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
  assert.match(globalAgents, /Memories without `read_when` are always-injected/);
  assert.match(globalAgents, /Use `forger-memory` before reading, saving, updating, deduplicating, deleting, or explaining memory/);
  assert.match(globalAgents, /Treat the person as non-technical by default/);
  assert.match(globalAgents, /Use product words: app, screen, button, data, file, saved version, flow, result/);
  assert.match(globalAgents, /## Request Playbooks[\s\S]*## How To Speak With The Person/);
  assert.match(globalAgents, /### Building a New App[\s\S]*1\. Clarify the goal[\s\S]*2\. Shape the first useful version[\s\S]*3\. Offer two or three product directions/);
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
    'forger-agents',
    'forger-app-shell-layout',
    'forger-automations',
    'forger-desktop-runtime-bridge',
    'forger-fastapi-contracts',
    'forger-frontend-product-patterns',
    'forger-frontend-structure',
    'forger-gmail',
    'forger-installed-app-change',
    'forger-localization',
    'forger-manifest-authoring',
    'forger-memory',
    'forger-mobile-responsive-frontend',
    'forger-mui-component-patterns',
    'forger-mui-consistency',
    'forger-mui-date-pickers',
    'forger-mui-design-patterns',
    'forger-official-tools',
    'forger-permissions',
    'forger-python-backend',
    'forger-react-ui',
    'forger-remote-tunnel-wiring',
    'forger-secrets',
    'forger-social-app-review',
    'forger-tailwind-design-patterns',
    'forger-tailwind-responsive-frontend',
    'forger-tailwind-shadcn-patterns',
    'forger-tanstack-query-patterns',
    'forger-tasks',
    'forger-tools',
    'forger-web-interface-review',
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
  const appOfficialSkill = buildInstalledAppSkillTemplates(['gmail.search_messages']).find((template) => template.id === 'forger-app-official-tools');
  assert.ok(appOfficialSkill);
  assert.equal(appOfficialSkill.description, 'Use when an installed app wants to call official Forger tools; limit tool calls to manifest-granted actions such as Gmail search, read, attachment download, or send.');
  assert.match(appOfficialSkill.body, /`gmail\.search_messages`/);
  const manifestSkill = templates.find((template) => template.id === 'forger-manifest-authoring');
  assert.ok(manifestSkill);
  assert.match(manifestSkill.body, /## Full Manifest JSON Contract/);
  assert.match(manifestSkill.body, /"appSecrets": \[/);
  assert.match(manifestSkill.body, /"promptTemplates": \[/);
  assert.match(manifestSkill.body, /"agents": \[/);
  assert.match(manifestSkill.body, /promptTemplates[\s\S]*agents[\s\S]*tools/);
  assert.match(manifestSkill.body, /"permissionMode": "safe"/);
  assert.match(manifestSkill.body, /claude-sonnet-4-6/);
  assert.match(manifestSkill.body, /Do not use legacy Claude Code aliases/);
  assert.match(manifestSkill.body, /gmail\.connection\.status/);
  assert.match(manifestSkill.body, /Every entry in `tools\.required\[\]` and `tools\.optional\[\]` must include `toolId`, `reason`, and `actions`/);
  assert.match(manifestSkill.body, /`reason` is required, not decorative/);
  assert.match(manifestSkill.body, /Do not add `catalog\.capabilities`/);
  assert.match(templates.find((template) => template.id === 'forger-agents')?.body ?? '', /^---\nname: forger-agents/m);
  assert.match(templates.find((template) => template.id === 'forger-tasks')?.body ?? '', /^---\nname: forger-tasks/m);
  assert.match(templates.find((template) => template.id === 'forger-tools')?.body ?? '', /^---\nname: forger-tools/m);
  const appShellSkill = templates.find((template) => template.id === 'forger-app-shell-layout');
  assert.ok(appShellSkill);
  assert.match(appShellSkill.body, /only the main content region scrolls/);
  assert.match(appShellSkill.body, /Rail-style destinations remain visible/);
  assert.match(appShellSkill.body, /Tailwind responsive variants/);
  assert.match(appShellSkill.body, /MUI breakpoints and `useMediaQuery`/);
  assert.match(appShellSkill.body, /If a top bar uses fixed positioning/);
  assert.match(appShellSkill.body, /fixed bottom navigation/);
  const productPatternsSkill = templates.find((template) => template.id === 'forger-frontend-product-patterns');
  assert.ok(productPatternsSkill);
  assert.equal(productPatternsSkill.description, 'Use when creating or changing Forger app dashboards, CRUD screens, forms, data views, assistant task surfaces, multi-step workflows, or screen structure before choosing stack-specific UI skills.');
  assert.match(productPatternsSkill.body, /Do not overload dashboards/);
  assert.match(productPatternsSkill.body, /Use pills and badges sparingly/);
  assert.match(productPatternsSkill.body, /minimalist request means fewer visual containers/);
  assert.match(productPatternsSkill.body, /agent threads, promptTemplate tasks/);
  assert.match(productPatternsSkill.body, /Inspect the real app before selecting implementation guidance/);
  assert.match(productPatternsSkill.body, /forger-frontend-structure/);
  assert.match(productPatternsSkill.body, /forger-react-ui/);
  assert.match(productPatternsSkill.body, /forger-app-shell-layout/);
  assert.match(productPatternsSkill.body, /forger-localization/);
  assert.match(productPatternsSkill.body, /forger-tailwind-design-patterns/);
  assert.match(productPatternsSkill.body, /forger-tailwind-shadcn-patterns/);
  assert.match(productPatternsSkill.body, /forger-tailwind-responsive-frontend/);
  assert.match(productPatternsSkill.body, /forger-mui-design-patterns/);
  assert.match(productPatternsSkill.body, /forger-mui-component-patterns/);
  assert.match(productPatternsSkill.body, /forger-mui-date-pickers/);
  assert.match(productPatternsSkill.body, /forger-mui-consistency/);
  assert.match(productPatternsSkill.body, /forger-mobile-responsive-frontend/);
  const webInterfaceReviewSkill = templates.find((template) => template.id === 'forger-web-interface-review');
  assert.ok(webInterfaceReviewSkill);
  assert.match(webInterfaceReviewSkill.body, /Do not fetch remote guideline documents/);
  assert.match(webInterfaceReviewSkill.body, /not a public marketing website/);
  const muiDesignSkill = templates.find((template) => template.id === 'forger-mui-design-patterns');
  assert.ok(muiDesignSkill);
  assert.match(muiDesignSkill.body, /Apply these rules only to Forger Desktop or installed apps whose manifest declares a MUI frontend/);
  const muiComponentSkill = templates.find((template) => template.id === 'forger-mui-component-patterns');
  assert.ok(muiComponentSkill);
  assert.match(muiComponentSkill.body, /Apply these rules only to Forger Desktop or apps whose manifest declares a MUI frontend/);
  assert.match(muiComponentSkill.body, /MUI X Community packages/);
  assert.match(muiComponentSkill.body, /Do not use MUI X Pro or Premium/);
  assert.match(muiComponentSkill.body, /Use MUI X Community `DataGrid`/);
  assert.match(muiComponentSkill.body, /Use MUI X Community Charts/);
  assert.match(muiComponentSkill.body, /Use `DatePicker`/);
  assert.match(muiComponentSkill.body, /Do not use `TextField type="date"`/);
  assert.match(muiComponentSkill.body, /Use `Card` for content and actions about one subject/);
  const muiDatePickerSkill = templates.find((template) => template.id === 'forger-mui-date-pickers');
  assert.ok(muiDatePickerSkill);
  assert.match(muiDatePickerSkill.body, /Apply these rules only to Forger Desktop or apps whose manifest declares a MUI frontend/);
  assert.match(muiDatePickerSkill.body, /Use MUI X Community Date and Time Pickers/);
  assert.match(muiDatePickerSkill.body, /Wrap picker usage in `LocalizationProvider`/);
  assert.match(muiDatePickerSkill.body, /Do not use `TextField type="date"`/);
  assert.match(muiDatePickerSkill.body, /Stored values remain stable across reloads/);
  const tailwindDesignSkill = templates.find((template) => template.id === 'forger-tailwind-design-patterns');
  assert.ok(tailwindDesignSkill);
  assert.match(tailwindDesignSkill.body, /Tailwind CSS, shadcn\/ui copied components, and Radix primitives/);
  assert.match(tailwindDesignSkill.body, /Do not use MUI component APIs/);
  assert.match(tailwindDesignSkill.body, /Minimal or operational screens use unframed page sections/);
  const tailwindShadcnSkill = templates.find((template) => template.id === 'forger-tailwind-shadcn-patterns');
  assert.ok(tailwindShadcnSkill);
  assert.equal(tailwindShadcnSkill.description, 'Use when building Tailwind/shadcn app UI controls, forms, dialogs, selects, comboboxes, popovers, dropdowns, tabs, tooltips, sheets, accordions, toasts, copied components, or Radix primitives; inspect existing components and install shadcn/Radix before hand-rolling interactive behavior.');
  assert.match(tailwindShadcnSkill.body, /## Component Selection Loop/);
  assert.match(tailwindShadcnSkill.body, /Identify the needed behavior before writing JSX/);
  assert.match(tailwindShadcnSkill.body, /add the matching shadcn component through the app package manager and shadcn CLI or registry/);
  assert.match(tailwindShadcnSkill.body, /Keep direct `@radix-ui\/\*` imports inside reusable `frontend\/src\/components\/ui\/\*` primitives/);
  assert.match(tailwindShadcnSkill.body, /Avoid native `<select>`, custom `div` menus, ad hoc popovers, manual focus traps, and hand-rolled keyboard behavior/);
  assert.match(tailwindShadcnSkill.body, /shadcn\/ui components are copied app code/);
  assert.match(tailwindShadcnSkill.body, /Do not add Headless UI or another headless component system/);
  assert.match(tailwindShadcnSkill.body, /Badge is for compact status/);
  assert.match(tailwindShadcnSkill.body, /Plain rows, headings, sections, tables, and description lists/);
  assert.match(tailwindShadcnSkill.body, /Card inside Card/);
  const tailwindResponsiveSkill = templates.find((template) => template.id === 'forger-tailwind-responsive-frontend');
  assert.ok(tailwindResponsiveSkill);
  assert.match(tailwindResponsiveSkill.body, /Tailwind\/shadcn Forger app/);
  assert.match(tailwindResponsiveSkill.body, /mobile width around 390 px/);
  const tanstackQuerySkill = templates.find((template) => template.id === 'forger-tanstack-query-patterns');
  assert.ok(tanstackQuerySkill);
  assert.match(tanstackQuerySkill.body, /TanStack Query as the client-side server-state layer/);
  assert.match(tanstackQuerySkill.body, /Do not apply SSR, SSG, dehydration/);
  const bridgeSkill = templates.find((template) => template.id === 'forger-desktop-runtime-bridge');
  assert.ok(bridgeSkill);
  assert.match(bridgeSkill.body, /commons\/backend\/forger_desktop\.py/);
  assert.match(bridgeSkill.body, /start_agent_task/);
  assert.match(bridgeSkill.body, /start_manifest_agent_thread/);
  assert.match(bridgeSkill.body, /resume_manifest_agent_thread/);
  assert.match(bridgeSkill.body, /removed freeform endpoints/);
  assert.match(bridgeSkill.body, /Finance OS is the reference pattern/);
  assert.match(bridgeSkill.body, /Opening, launching, starting, running, or bringing up an installed app means using Forger Desktop app controls/);
  assert.match(bridgeSkill.body, /forger_get_app_runtime_status/);
  const officialToolsSkill = templates.find((template) => template.id === 'forger-official-tools');
  assert.ok(officialToolsSkill);
  assert.doesNotMatch(officialToolsSkill.description, /memory/);
  assert.match(officialToolsSkill.body, /forger_open_app/);
  assert.match(officialToolsSkill.body, /Do not manually start app services/);
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
  assert.equal(installedAppsSeed.length, 2);
  assert.equal(catalogAppsSeed.some((app) => app.id === 'finance-os'), true);
  assert.equal(settingsSeed.safeMode, true);
  assert.equal(settingsSeed.defaultAgentProvider, 'auto');
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
    const bodyWithoutFrontmatter = skill.body.replace(/^---\n[\s\S]*?\n---\n?/, '');
    assert.doesNotMatch(
      bodyWithoutFrontmatter,
      /Use this skill when|Use this skill before|This skill applies only/,
      `${skill.group}/${skill.filename} should not keep generic loading triggers in the body`,
    );
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
