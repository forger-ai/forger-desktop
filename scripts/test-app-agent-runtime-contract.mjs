import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  buildManifestAgentResumePrompt,
  buildManifestAgentStartPrompt,
  buildManifestAgentSteerPrompt,
} = require('../dist-electron/main/app-agent/conversation-helpers.js');
const { renderManifestAgentPrompt } = require('../dist-electron/main/manifest-agent-prompts.js');
const {
  PromptOverridesStore,
  buildPromptBases,
  validatePromptEdit,
} = require('../dist-electron/main/prompt-overrides.js');
const { AppMcpManager } = require('../dist-electron/main/app-mcp-manager.js');

const manifestAgent = {
  id: 'feature-intake-agent',
  title: 'Feature Intake',
  initialPrompt: 'legacy',
  prompts: {
    initial: {
      body: 'Runtime contract:\\n{{runtimeContract}}\\n\\nMessage:\\n{{userMessage}}\\n\\nPayload:\\n{{turnPayload}}',
      variables: {
        runtimeContract: { type: 'text' },
        userMessage: { type: 'text' },
        turnPayload: { type: 'json' },
      },
    },
    resume: {
      body: 'Resume:\\n{{userMessage}}\\n{{shortId}}',
      variables: {
        userMessage: { type: 'text' },
        shortId: { type: 'string' },
      },
    },
  },
};

const manifestOnlyAgent = {
  id: 'freeChatOrchestrator',
  kind: 'orchestrator',
  title: 'Free Chat Orchestrator',
  description: 'Runs the main free-chat conversation.',
  prompts: {
    initial: {
      body: 'Free chat initial:\\n{{userMessage}}',
      variables: {
        userMessage: { type: 'text' },
      },
    },
    resume: {
      body: 'Free chat resume:\\n{{turnPayload}}\\n{{userMessage}}',
      variables: {
        turnPayload: { type: 'json' },
        userMessage: { type: 'text' },
      },
    },
  },
};

const renderedInitial = renderManifestAgentPrompt({
  agent: manifestAgent,
  kind: 'initial',
  appRoot: process.cwd(),
  variables: {
    runtimeContract: 'Visible app replies must use `respond_to_user`.',
    userMessage: 'techlead crea el plan aca en vibe',
    turnPayload: { z: 1, a: 2 },
  },
});
assert.match(renderedInitial, /^Runtime contract:/);
assert.match(renderedInitial, /techlead crea el plan aca en vibe/);
assert.match(renderedInitial, /"a": 2,[\s\S]*"z": 1/);
assert.doesNotMatch(renderedInitial, /Contexto actual de la app/);
assert.doesNotMatch(renderedInitial, /Usa las herramientas MCP/);

const renderedSteer = renderManifestAgentPrompt({
  agent: manifestAgent,
  kind: 'steer',
  appRoot: process.cwd(),
  variables: {
    userMessage: 'actualiza el paso 2',
    shortId: 'step-2',
  },
});
assert.match(renderedSteer, /^Resume:/);

assert.throws(
  () => renderManifestAgentPrompt({
    agent: manifestAgent,
    kind: 'resume',
    appRoot: process.cwd(),
    variables: { userMessage: 'x', shortId: 'ok', extra: 'nope' },
  }),
  /agent_prompt_variable_not_declared:extra/,
);
assert.throws(
  () => renderManifestAgentPrompt({
    agent: manifestAgent,
    kind: 'resume',
    appRoot: process.cwd(),
    variables: { userMessage: 'x' },
  }),
  /agent_prompt_variable_required:shortId/,
);
assert.throws(
  () => renderManifestAgentPrompt({
    agent: manifestAgent,
    kind: 'resume',
    appRoot: process.cwd(),
    variables: { userMessage: 'x', shortId: 'bad\nvalue' },
  }),
  /agent_prompt_variable_multiline_string:shortId/,
);

assert.equal(buildManifestAgentStartPrompt(`  ${renderedInitial}  `), renderedInitial);
assert.equal(buildManifestAgentResumePrompt(`  ${renderedSteer}  `), renderedSteer);
assert.equal(buildManifestAgentSteerPrompt(`  ${renderedSteer}  `), renderedSteer);

const promptBases = buildPromptBases([], [
  {
    id: 'legacy-agent',
    title: 'Legacy Agent',
    initialPrompt: 'Legacy {{userMessage}}',
  },
  manifestAgent,
  manifestOnlyAgent,
], {
  model: 'gpt-5.4',
  reasoningEffort: 'medium',
});
assert.deepEqual(promptBases.map((item) => `${item.kind}:${item.id}`).sort(), [
  'agent:legacy-agent',
  'agentPrompt:feature-intake-agent:initial',
  'agentPrompt:feature-intake-agent:resume',
  'agentPrompt:freeChatOrchestrator:initial',
  'agentPrompt:freeChatOrchestrator:resume',
]);

const resumeBase = promptBases.find((item) => item.kind === 'agentPrompt' && item.id === 'feature-intake-agent:resume');
assert.ok(resumeBase);
assert.equal(resumeBase.agentId, 'feature-intake-agent');
assert.equal(resumeBase.promptKind, 'resume');
assert.deepEqual(Object.keys(resumeBase.declaredVariables).sort(), ['shortId', 'userMessage']);
assert.equal(validatePromptEdit(resumeBase, 'Resume:\n{{userMessage}}\n{{shortId}}').valid, true);
assert.match(validatePromptEdit(resumeBase, 'Resume:\n{{userMessage}}').errors.join('\n'), /shortId/);
assert.match(validatePromptEdit(resumeBase, 'Resume:\n{{userMessage}}\n{{shortId}}\n{{extra}}').errors.join('\n'), /extra/);

const storeDir = await mkdtemp(join(tmpdir(), 'forger-prompt-overrides-'));
try {
  const store = new PromptOverridesStore(join(storeDir, 'overrides.json'));
  await store.update('app', promptBases, {
    appId: 'app',
    kind: 'agentPrompt',
    id: 'feature-intake-agent:resume',
    prompt: 'Resume changed:\n{{userMessage}}\n{{shortId}}',
  });
  await store.update('app', promptBases, {
    appId: 'app',
    kind: 'agent',
    id: 'legacy-agent',
    prompt: 'Legacy changed {{userMessage}}',
  });
  const applied = await store.applyToAgents('app', [
    {
      id: 'legacy-agent',
      title: 'Legacy Agent',
      initialPrompt: 'Legacy {{userMessage}}',
    },
    structuredClone(manifestAgent),
  ]);
  assert.equal(applied.find((agent) => agent.id === 'legacy-agent').initialPrompt, 'Legacy changed {{userMessage}}');
  const appliedManifestAgent = applied.find((agent) => agent.id === 'feature-intake-agent');
  assert.equal(appliedManifestAgent.initialPrompt, 'legacy');
  assert.match(appliedManifestAgent.prompts.resume.body, /^Resume changed:/);
  assert.match(appliedManifestAgent.prompts.initial.body, /^Runtime contract:/);
} finally {
  await rm(storeDir, { recursive: true, force: true });
}

const mcpInstallDir = await mkdtemp(join(tmpdir(), 'forger-app-mcp-'));
try {
  await mkdir(join(mcpInstallDir, 'backend'));
  const calls = [];
  const manager = new AppMcpManager({
    getInstalledApp: (appId) => ({
      appId,
      installDir: mcpInstallDir,
      requiredPythonVersion: '3.12',
    }),
    resolveInstalledManifest: async () => ({
      mcp: {
        command: 'python -e 0',
        healthcheck: '/health',
      },
    }),
    ensureRuntimeInstalled: async () => ({
      rootDir: tmpdir(),
      python: process.execPath,
    }),
    ensureBackendPythonEnvironment: async (pythonPath, backendDir, appId, reason) => {
      calls.push({ pythonPath, backendDir, appId, reason });
    },
    getVenvExecutables: (backendDir) => ({
      python: process.execPath,
      pip: join(backendDir, '.venv', 'bin', 'pip'),
    }),
    getFreePort: async () => 65500,
    splitManifestCommand: (command) => command.split(/\s+/).filter(Boolean),
    ensurePathInside: () => true,
    translateManifestEnvironment: () => ({}),
    ensureSqliteDatabaseParent: async () => {},
    getRuntimePathEntries: () => [],
    waitForHttpOk: async () => {},
    terminateProcess: async (child) => {
      child.kill();
    },
    appendInstallLog: async () => {},
    truncateForInstallLog: (value) => value,
    serializeErrorForInstallLog: (error) => ({ message: String(error) }),
  });
  const configs = await manager.listenMcps(['vibe'], 'run-1');
  assert.equal(configs.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].appId, 'vibe');
  assert.equal(calls[0].reason, 'app_mcp_start');
  assert.equal(calls[0].backendDir, join(mcpInstallDir, 'backend'));
} finally {
  await rm(mcpInstallDir, { recursive: true, force: true });
}
