import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moreViewPath = new URL('../../src/renderer/views/MoreView.tsx', import.meta.url);
const sidebarPath = new URL('../../src/renderer/components/Sidebar.tsx', import.meta.url);
const appShellPath = new URL('../../src/renderer/components/AppShell.tsx', import.meta.url);
const controllerPath = new URL('../../src/renderer/app/RendererAppController.tsx', import.meta.url);
const appViewPath = new URL('../../src/renderer/app/RendererAppView.tsx', import.meta.url);
const desktopApiPath = new URL('../../src/shared/types/desktop-api.ts', import.meta.url);
const englishPath = new URL('../../src/renderer/i18n/locales/enMore.ts', import.meta.url);
const spanishPath = new URL('../../src/renderer/i18n/locales/esMore.ts', import.meta.url);

const readSources = async (...paths) => await Promise.all(paths.map((filePath) => readFile(filePath, 'utf8')));

const assertContains = (source, fragments, label) => {
  for (const fragment of fragments) {
    assert.equal(source.includes(fragment), true, `${label} must include: ${fragment}`);
  }
};

test('given Workflows is off, More shows one disabled early-access card while grid and sidebar access stay unavailable', async () => {
  const [moreView, sidebar, appShell, appView] = await readSources(
    moreViewPath,
    sidebarPath,
    appShellPath,
    appViewPath,
  );

  assertContains(moreView, [
    'workflowsEnabled: boolean;',
    'workflowsEarlyAccessBusy: boolean;',
    'onUpdateWorkflowsEarlyAccess: (enabled: boolean) => void;',
    "const isWorkflows = item.id === 'workflows';",
    'const surfaceEnabled = !isWorkflows || workflowsEnabled;',
    'disabled={!surfaceEnabled}',
    'label={t.beta.earlyAccessBadge}',
    'checked={workflowsEnabled}',
    'disabled={workflowsEarlyAccessBusy}',
    'aria-busy={workflowsEarlyAccessBusy}',
    '<CircularProgress size={18}',
    'role="status"',
    'workflowsEnabled ? t.more.workflowsDisabling : t.more.workflowsEnabling',
    '{surfaceEnabled ? (',
  ], 'MoreView');
  assert.equal(moreView.includes('window.confirm'), false, 'the early-access card uses the product dialog, not a browser prompt');

  assertContains(sidebar, [
    'workflowsEnabled: boolean;',
    "item.id !== 'workflows' || workflowsEnabled",
  ], 'Sidebar');
  assertContains(appShell, [
    'workflowsEnabled: boolean;',
    'workflowsEnabled={workflowsEnabled}',
  ], 'AppShell');
  assertContains(appView, [
    'workflowsEnabled={workflowsEnabled}',
    'workflowsEarlyAccessBusy={workflowsEarlyAccessBusy}',
    'onUpdateWorkflowsEarlyAccess={handleUpdateWorkflowsEarlyAccess}',
  ], 'RendererAppView');
});

test('given a stale Workflows view while the gate is off, navigation lands on More without mounting any workflow surface', async () => {
  const [controller, appView] = await readSources(controllerPath, appViewPath);

  assertContains(controller, [
    "const WORKFLOW_VIEWS = new Set<View>(['workflows', 'workflowEditor', 'workflowDetail']);",
    'const workflowsEnabled = settings.earlyAccess?.workflowsEnabled === true;',
    'if (!workflowsEnabled && WORKFLOW_VIEWS.has(currentView))',
    "setCurrentView('more');",
    'setSelectedWorkflowId(null);',
  ], 'RendererAppController');
  assertContains(appView, [
    "workflowsEnabled && (currentView === 'workflows' || currentView === 'workflowEditor' || currentView === 'workflowDetail')",
  ], 'RendererAppView workflow render guard');
});

test('enabling Workflows calls the dedicated API once, exposes busy state, and publishes confirmed settings before unlocking access', async () => {
  const [controller, moreView, desktopApi] = await readSources(controllerPath, moreViewPath, desktopApiPath);

  assertContains(desktopApi, [
    'updateWorkflowsEarlyAccess: (enabled: boolean) => Promise<Settings>;',
  ], 'DesktopApi');
  assertContains(controller, [
    'const [workflowsEarlyAccessBusy, setWorkflowsEarlyAccessBusy] = useState(false);',
    'const handleUpdateWorkflowsEarlyAccess = async (enabled: boolean) => {',
    'setWorkflowsEarlyAccessBusy(true);',
    'const nextSettings = await getDesktopApi().updateWorkflowsEarlyAccess(enabled);',
    'setSettings(nextSettings);',
    'setWorkflowsEarlyAccessBusy(false);',
  ], 'RendererAppController opt-in flow');
  assertContains(moreView, [
    'onUpdateWorkflowsEarlyAccess(true);',
    'disabled={workflowsEarlyAccessBusy}',
  ], 'MoreView opt-in action');

  const busyStart = controller.indexOf('setWorkflowsEarlyAccessBusy(true);');
  const apiCall = controller.indexOf('const nextSettings = await getDesktopApi().updateWorkflowsEarlyAccess(enabled);', busyStart);
  const publishSettings = controller.indexOf('setSettings(nextSettings);', apiCall);
  const busyEnd = controller.indexOf('setWorkflowsEarlyAccessBusy(false);', publishSettings);
  assert.ok(busyStart >= 0 && busyStart < apiCall && apiCall < publishSettings && publishSettings < busyEnd);
});

test('disabling Workflows confirms the impact before mutation and leaves every Workflows entry inaccessible after success', async () => {
  const [moreView, english, spanish] = await readSources(moreViewPath, englishPath, spanishPath);

  assertContains(moreView, [
    'const [workflowsDisableDialogOpen, setWorkflowsDisableDialogOpen] = useState(false);',
    'setWorkflowsDisableDialogOpen(true);',
    '<Dialog open={workflowsDisableDialogOpen}',
    't.more.workflowsDisableTitle',
    't.more.workflowsDisableBody',
    't.more.workflowsDisableCancel',
    't.more.workflowsDisableConfirm',
    'onUpdateWorkflowsEarlyAccess(false);',
  ], 'MoreView opt-out confirmation');
  assertContains(english, [
    "workflowsEnabling: 'Turning on Workflows…',",
    "workflowsDisabling: 'Turning off Workflows…',",
    "workflowsDisableTitle: 'Turn off Workflows?',",
    "workflowsDisableConfirm: 'Turn off Workflows',",
    'scheduled workflows won’t start',
    'saved workflows and run history will stay on this device',
  ], 'English opt-out copy');
  assertContains(spanish, [
    "workflowsEnabling: 'Activando Flujos…',",
    "workflowsDisabling: 'Desactivando Flujos…',",
    "workflowsDisableTitle: '¿Desactivar Flujos?',",
    "workflowsDisableConfirm: 'Desactivar Flujos',",
    'los flujos programados no se iniciarán',
    'los flujos guardados y el historial permanecerán en este dispositivo',
  ], 'Spanish opt-out copy');
});
