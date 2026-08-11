import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowsTypesPath = new URL('../../src/shared/types/workflows.ts', import.meta.url);
const desktopApiPath = new URL('../../src/shared/types/desktop-api.ts', import.meta.url);
const workflowDraftPath = new URL('../../src/renderer/views/workflows/workflow-draft.ts', import.meta.url);
const workflowEditorPath = new URL('../../src/renderer/views/workflows/WorkflowEditor.tsx', import.meta.url);
const workflowModulePath = new URL('../../src/renderer/views/workflows/WorkflowsModule.tsx', import.meta.url);
const workflowEditorPagePath = new URL('../../src/renderer/views/workflows/WorkflowEditorPage.tsx', import.meta.url);
const englishPath = new URL('../../src/renderer/i18n/locales/enSections.ts', import.meta.url);
const spanishPath = new URL('../../src/renderer/i18n/locales/esSections.ts', import.meta.url);

const readSources = async (...paths) => await Promise.all(paths.map((path) => readFile(path, 'utf8')));

const assertContains = (source, fragments, label) => {
  for (const fragment of fragments) {
    assert.equal(source.includes(fragment), true, `${label} must include: ${fragment}`);
  }
};

test('app_action is a first-class typed node and is the first step offered by the editor', async () => {
  const [types, draft, editor, english, spanish] = await readSources(
    workflowsTypesPath,
    workflowDraftPath,
    workflowEditorPath,
    englishPath,
    spanishPath,
  );

  assertContains(types, [
    "export type WorkflowAppActionEffect = 'read' | 'write' | 'external' | 'destructive' | 'unknown';",
    "export type WorkflowAppActionRisk = 'low' | 'medium' | 'high';",
    'export interface WorkflowAppAction {',
    'toolName: string;',
    'title: string;',
    'inputSchema: Record<string, unknown>;',
    'outputSchema: Record<string, unknown>;',
    'effect: WorkflowAppActionEffect;',
    'risk: WorkflowAppActionRisk;',
    'idempotent: boolean;',
    'contractHash: string;',
    'export interface WorkflowAppActionNode extends WorkflowNodeBase {',
    "type: 'app_action';",
    'appId: string;',
    'action: WorkflowAppAction;',
    '| WorkflowAppActionNode',
  ], 'workflow types');
  assertContains(draft, [
    "if (type === 'app_action')",
  ], 'workflow draft factory');
  assertContains(editor, [
    "app_action:",
    'WORKFLOW_NODE_TYPE_ORDER',
    'WORKFLOW_NODE_TYPE_ORDER.map((type)',
  ], 'WorkflowEditor');

  const orderDeclaration = editor.match(/WORKFLOW_NODE_TYPE_ORDER[\s\S]{0,500}/)?.[0] ?? '';
  assert.ok(orderDeclaration.indexOf("'app_action'") >= 0, 'the explicit button order contains app_action');
  assert.ok(
    orderDeclaration.indexOf("'app_action'") < orderDeclaration.indexOf("'llm_agent'"),
    'App action appears before AI-backed node types',
  );
  assertContains(english, ["app_action: 'App action'"], 'English workflow copy');
  assertContains(spanish, ["app_action: 'Acción de app'"], 'Spanish workflow copy');
});

test('the product loads app actions and guides selection App then Action then schema mapping', async () => {
  const [desktopApi, workflowModule, editorPage, editor] = await readSources(
    desktopApiPath,
    workflowModulePath,
    workflowEditorPagePath,
    workflowEditorPath,
  );

  assert.match(
    desktopApi,
    /workflows(?:List)?AppActions[^\n]*Promise<WorkflowAppActionDefinition\[\]>/,
    'DesktopApi exposes typed action discovery for one installed app',
  );
  assertContains(workflowModule, [
    'WorkflowAppAction',
    'appActions',
    'setAppActions',
    'listInstalledApps()',
  ], 'WorkflowsModule action discovery');
  assert.match(
    workflowModule,
    /workflows(?:List)?AppActions\(/,
    'WorkflowsModule discovers actions through the desktop bridge',
  );
  assertContains(editorPage, [
    'appActions:',
    'appActions={data.appActions}',
  ], 'WorkflowEditorPage graph data');
  assertContains(editor, [
    'appActions:',
    'copy.appActionApp',
    'copy.appActionAction',
    "current.type !== 'app_action'",
    '<SchemaForm',
    'sources={sourcesWithItem}',
    'mapTooltip={copy.mapField}',
  ], 'WorkflowEditor app action panel');

  const appActionPanel = editor.match(/node\.type === 'app_action'[\s\S]{0,9000}/)?.[0] ?? '';
  const appSelect = appActionPanel.indexOf('copy.appActionApp');
  const actionSelect = appActionPanel.indexOf('copy.appActionAction');
  const schemaForm = appActionPanel.indexOf('<SchemaForm');
  assert.ok(appSelect >= 0 && appSelect < actionSelect && actionSelect < schemaForm);
  assert.match(appActionPanel, /filter\([^\n]*appId[^\n]*node\.appId|node\.appId[^\n]*filter\(/);
});

test('a saved app or action that disappeared stays visible as a broken selection instead of being erased', async () => {
  const [draft, editor] = await readSources(workflowDraftPath, workflowEditorPath);

  assertContains(draft, [
    'nodes: workflow.nodes.map((node) => ({ ...node }))',
  ], 'draftFromWorkflow');
  assertContains(editor, [
    'appActionAppAvailable',
    'appActionAvailable',
    'value={node.appId}',
    'value={node.toolName}',
    'copy.appActionMissing',
    'node.action.contractHash',
  ], 'broken app action selection');
  assert.equal(
    editor.includes("value={appActionAppAvailable ? node.appId : ''}"),
    false,
    'the stored app selection is not blanked when discovery fails',
  );
  assert.equal(
    editor.includes("value={appActionAvailable ? node.toolName : ''}"),
    false,
    'the stored action selection is not blanked when discovery fails',
  );
});

test('the editor explains deterministic execution, effect, and mandatory approval in English and Spanish', async () => {
  const [editor, english, spanish] = await readSources(workflowEditorPath, englishPath, spanishPath);

  assertContains(editor, [
    'node.action.effect',
    'node.action.risk',
    'copy.appActionEffects',
    'copy.appActionRisks',
    "const appActionRequiresApproval = node.type === 'app_action';",
    'toolName, action: snapshot, input: {}, requiresApproval: true',
    'copy.appActionApprovalRequired',
    'copy.noAiRequired',
  ], 'WorkflowEditor safety explanation');
  assertContains(english, [
    "appActionApp: 'App'",
    "appActionAction: 'Action'",
    "appActionApprovalRequired: 'This action always requires your approval before it runs.'",
    "noAiRequired: 'This workflow does not use AI.'",
    "read: 'Reads data'",
    "write: 'Changes data'",
    "external: 'Acts outside the app'",
    "destructive: 'Can delete data'",
    "unknown: 'Effect not declared'",
  ], 'English deterministic action copy');
  assertContains(spanish, [
    "appActionApp: 'App'",
    "appActionAction: 'Acción'",
    "appActionApprovalRequired: 'Esta acción siempre requiere tu aprobación antes de ejecutarse.'",
    "noAiRequired: 'Este flujo no usa IA.'",
    "read: 'Lee datos'",
    "write: 'Cambia datos'",
    "external: 'Actúa fuera de la app'",
    "destructive: 'Puede eliminar datos'",
    "unknown: 'Efecto no declarado'",
  ], 'Spanish deterministic action copy');
});
