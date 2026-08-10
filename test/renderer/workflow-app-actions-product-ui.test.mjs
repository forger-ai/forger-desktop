import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = {
  workflowTypes: new URL('../../src/shared/types/workflows.ts', import.meta.url),
  desktopApi: new URL('../../src/shared/types/desktop-api.ts', import.meta.url),
  ipc: new URL('../../src/shared/ipc.ts', import.meta.url),
  preload: new URL('../../src/preload/index.ts', import.meta.url),
  ipcHandlers: new URL('../../src/main/ipc/agent-handlers.ts', import.meta.url),
  draft: new URL('../../src/renderer/views/workflows/workflow-draft.ts', import.meta.url),
  module: new URL('../../src/renderer/views/workflows/WorkflowsModule.tsx', import.meta.url),
  editor: new URL('../../src/renderer/views/workflows/WorkflowEditor.tsx', import.meta.url),
  editorHelpers: new URL('../../src/renderer/views/workflows/app-action-editor.ts', import.meta.url),
  changeDialog: new URL('../../src/renderer/views/workflows/AppActionChangeDialog.tsx', import.meta.url),
  runModal: new URL('../../src/renderer/views/workflows/WorkflowRunModal.tsx', import.meta.url),
  workflowManager: new URL('../../src/main/workflow-manager.ts', import.meta.url),
  english: new URL('../../src/renderer/i18n/locales/enSections.ts', import.meta.url),
  spanish: new URL('../../src/renderer/i18n/locales/esSections.ts', import.meta.url),
};

const read = async (key) => await readFile(paths[key], 'utf8');

test('IPC and preload expose a safe per-app action catalog without MCP session credentials', async () => {
  const [workflowTypes, desktopApi, ipc, preload, ipcHandlers] = await Promise.all([
    read('workflowTypes'), read('desktopApi'), read('ipc'), read('preload'), read('ipcHandlers'),
  ]);

  assert.match(workflowTypes, /interface WorkflowAppActionCatalog[\s\S]*?appId:\s*string;[\s\S]*?appName:\s*string;[\s\S]*?actions:\s*WorkflowAppActionSummary\[\];[\s\S]*?\}/);
  assert.match(workflowTypes, /interface WorkflowAppActionSummary[\s\S]*?toolName:\s*string;[\s\S]*?title:\s*string;[\s\S]*?inputSchema:[\s\S]*?outputSchema:[\s\S]*?annotations:[\s\S]*?effect:[\s\S]*?\}/);
  assert.match(desktopApi, /workflowsListAppActions:\s*\(appId:\s*string\)\s*=>\s*Promise<WorkflowAppActionCatalog>/);
  assert.match(ipc, /workflowsListAppActions:\s*'forger:workflows:list-app-actions'/);
  assert.match(preload, /workflowsListAppActions:\s*\(appId\)\s*=>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.workflowsListAppActions,\s*appId\)/);
  assert.match(ipcHandlers, /ipcMain\.handle\(IPC_CHANNELS\.workflowsListAppActions,[\s\S]*?appId/);

  const publicCatalogContract = workflowTypes.match(/export interface WorkflowAppAction(?:Catalog|Summary)[\s\S]*?(?=\n\})/g)?.join('\n') ?? '';
  assert.doesNotMatch(publicCatalogContract, /\b(?:token|tokenEnvVar|url|authorization|headers)\b/i);
});

test('the workflow editor offers App action and freezes the selected app/tool contract in the draft', async () => {
  const [workflowTypes, draft, module, editor, english, spanish] = await Promise.all([
    read('workflowTypes'), read('draft'), read('module'), read('editor'), read('english'), read('spanish'),
  ]);

  assert.match(workflowTypes, /interface WorkflowAppActionNode[\s\S]*?type:\s*'app_action';[\s\S]*?appId:\s*string;[\s\S]*?toolName:\s*string;[\s\S]*?input:\s*Record<string, unknown>;[\s\S]*?contract\?:\s*WorkflowAppActionContract/);
  assert.match(workflowTypes, /interface WorkflowAppActionContract[\s\S]*?appName:[\s\S]*?actionTitle:[\s\S]*?inputSchema:[\s\S]*?outputSchema:[\s\S]*?annotations:[\s\S]*?effect:/);
  assert.match(draft, /type === 'app_action'/);
  assert.match(draft, /type:\s*'app_action',[\s\S]*?appId:\s*''[\s\S]*?toolName:\s*''[\s\S]*?input:\s*\{\}/);
  assert.match(module, /workflowsListAppActions/);
  assert.match(editor, /app_action/);
  assert.match(editor, /appId/);
  assert.match(editor, /toolName/);
  assert.match(editor, /contract/);

  assert.match(english, /app_action:\s*'App action'/);
  assert.match(english, /without AI choosing/i);
  assert.match(spanish, /app_action:\s*'Acción de app'/);
  assert.match(spanish, /sin que la IA decida/i);
});

test('a saved app action without a snapshot is visibly pending and can explicitly adopt the current contract', async () => {
  const [editor, editorHelpers, changeDialog, english, spanish] = await Promise.all([
    read('editor'), read('editorHelpers'), read('changeDialog'), read('english'), read('spanish'),
  ]);

  assert.match(editor, /appActionContractPending/);
  assert.match(editor, /!node\.contract/);
  assert.match(editor, /selectedCatalogAction/);
  assert.match(editor, /copy\.appActionContractPending/);
  assert.match(editor, /copy\.appActionAdoptCurrentContract/);
  assert.match(editor, /contractForAction\(selectedCatalogAction\)/);
  assert.match(editor, /contract:/);
  assert.match(editor, /summarizeAppActionContractChange\(node\.contract/);
  assert.match(changeDialog, /contractChange && reviewedAction/);
  assert.match(changeDialog, /appActionCurrentEffect/);
  assert.match(editorHelpers, /configuredValuePaths/);
  assert.match(editorHelpers, /`\$\{prefix\}\.\$\{key\}`/);
  assert.match(english, /appActionContractPending:\s*['"].*(?:input|output) structure.*not saved/i);
  assert.match(english, /appActionAdoptCurrentContract:\s*['"]Use current structure['"]/);
  assert.match(spanish, /appActionContractPending:\s*['"].*estructura.*aún no está guardada/i);
  assert.match(spanish, /appActionAdoptCurrentContract:\s*['"]Usar estructura actual['"]/);
});

test('contract drift keeps the saved snapshot visible and offers review/adopt while preserving schema-compatible input', async () => {
  const [editor, english, spanish] = await Promise.all([read('editor'), read('english'), read('spanish')]);

  assert.match(editor, /appActionContractChanged/);
  assert.match(editor, /appActionContract/);
  assert.match(editor, /selectedCatalogAction/);
  assert.match(editor, /copy\.appActionContractChanged/);
  assert.match(editor, /copy\.appActionReviewCurrentContract/);
  assert.match(editor, /copy\.appActionAdoptCurrentContract/);
  assert.match(editor, /preserveCompatibleAppActionInput|isAppActionInputCompatible/);
  assert.match(editor, /inputSchema/);
  assert.match(editor, /input:\s*(?:nextInput|preservedInput)/);
  assert.match(english, /appActionContractChanged:\s*['"].*(?:changed|different)/i);
  assert.match(english, /appActionReviewCurrentContract:\s*['"]Review change['"]/);
  assert.match(spanish, /appActionContractChanged:\s*['"].*(?:cambió|diferente)/i);
  assert.match(spanish, /appActionReviewCurrentContract:\s*['"]Revisar cambio['"]/);
});

test('a missing installed app neither loads its catalog nor offers a contradictory retry', async () => {
  const editor = await read('editor');

  assert.match(editor, /selectedAppAvailable\s*&&\s*!appActionState/);
  assert.match(editor, /selectedAppAvailable\s*&&\s*node\.appId\s*&&\s*appActionState\?\.status === 'error'/);
  assert.match(editor, /copy\.appActionAppMissing/);

  const loadEffect = editor.match(/useEffect\(\(\) => \{[\s\S]*?loadAppActions\(node\.appId\);[\s\S]*?\}, \[[\s\S]*?\]\);/)?.[0] ?? '';
  assert.match(loadEffect, /selectedAppAvailable/);
});

test('catalog discovery is deduplicated per app and stale responses cannot replace a forced refresh', async () => {
  const module = await read('module');

  assert.match(module, /appActionCatalogsRef/);
  assert.match(module, /existing\?\.status === 'loading' \|\| existing\?\.status === 'ready'/);
  assert.match(module, /appActionRequestIdsRef/);
  assert.match(module, /appActionRequestIdsRef\.current\[appId\] !== requestId/);
});

test('replacing or adopting an app-action contract uses a MUI review dialog, never window.confirm', async () => {
  const [editor, editorHelpers, changeDialog, english, spanish] = await Promise.all([
    read('editor'), read('editorHelpers'), read('changeDialog'), read('english'), read('spanish'),
  ]);

  assert.doesNotMatch(editor, /window\.confirm/);
  assert.doesNotMatch(changeDialog, /window\.confirm/);
  assert.match(changeDialog, /\bDialog\b/);
  assert.match(changeDialog, /\bDialogTitle\b/);
  assert.match(changeDialog, /\bDialogContent\b/);
  assert.match(changeDialog, /\bDialogActions\b/);
  assert.match(editor, /pendingAppAction/);
  assert.match(editor, /summarizeAppActionContractChange/);
  assert.match(changeDialog, /appActionValuesRemoved/);
  assert.match(editorHelpers, /keptInputValues/);
  assert.match(editorHelpers, /removedInputValues/);
  assert.match(changeDialog, /copy\.appActionContractReviewTitle/);
  assert.match(changeDialog, /copy\.appActionAdoptCurrentContract/);
  assert.match(english, /appActionContractReviewTitle:\s*['"]Review action change['"]/);
  assert.match(spanish, /appActionContractReviewTitle:\s*['"]Revisar cambio de acción['"]/);
});

test('approval identifies the exact app, action, effect, and data before a risky call', async () => {
  const [runModal, workflowManager, english, spanish] = await Promise.all([
    read('runModal'), read('workflowManager'), read('english'), read('spanish'),
  ]);

  assert.match(workflowManager, /appName:\s*node\.contract\?\.appName/);
  assert.match(workflowManager, /actionTitle:\s*node\.contract\?\.actionTitle/);
  assert.match(workflowManager, /effect:\s*node\.contract\?\.effect/);
  assert.match(runModal, /appActionApprovalDetails/);
  assert.match(runModal, /appActionApproval\.appName.*appActionApproval\.actionTitle/);
  assert.match(runModal, /appActionEffects\[appActionApproval\.effect\]/);
  assert.match(runModal, /appActionApproval\.actionInput/);
  assert.match(english, /appActionApprovalTitle:\s*['"]Review the exact app action['"]/);
  assert.match(spanish, /appActionApprovalTitle:\s*['"]Revisa la acción exacta de la app['"]/);
});
