import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

const emptyGate = (overrides: Record<string, unknown> = {}) => ({
  appId: 'planner', appName: 'Planner', canInstall: true, platformCapabilities: {},
  required: [], optional: [], connectionRequired: [], connectionOptional: [], agents: [], promptTemplates: [],
  ...overrides,
});

describe('RendererAppController install-gate renderers and decisions', () => {
  it('renders every capability, tool, connection, and installed-item presentation variant', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    expect(result.current.capabilityRows(null)).toEqual([]);
    const capabilities = result.current.capabilityRows(emptyGate({
      platformCapabilities: {
        unknown_capability: { required: false },
        network: { required: true, reason: 'Required to sync' },
      },
    }) as never);

    const tool = (overrides: Record<string, unknown> = {}) => ({
      declaration: { toolId: 'calendar', actions: [], reason: 'Calendar access' }, required: false,
      resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false,
      available: false, configured: false, ...overrides,
    });
    const connection = (overrides: Record<string, unknown> = {}) => ({
      declaration: { type: 'slack', actions: [], reason: 'Slack access' }, required: false,
      resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false,
      configured: false, instances: [], ...overrides,
    });
    const onToolChange = vi.fn();
    const onConnectionChange = vi.fn();
    const view = render(<>
      {capabilities.map(result.current.renderInstallCapability)}
      {result.current.renderInstallTool(tool({ available: true, configured: false, tool: { id: 'calendar', name: 'Calendar' }, resolvedActions: [{ id: 'read', name: 'Read' }] }) as never, false, { 'tool:calendar': true }, onToolChange)}
      {result.current.renderInstallTool(tool({ declaration: { toolId: 'all-tool', actions: ['*'], reason: 'Everything' }, allActions: true }) as never, true)}
      {result.current.renderInstallConnection(connection({ definition: { type: 'slack', displayName: 'Slack', actions: [] }, allActions: true }) as never, false, { 'connection:slack': true }, onConnectionChange)}
      {result.current.renderInstallConnection(connection({ declaration: { type: 'missing', actions: [], reason: 'Missing' } }) as never, true)}
      {result.current.renderInstallItem({ id: 'described', title: 'Described item', description: 'Visible description', prompt: 'Prompt' } as never)}
      {result.current.renderInstallItem({ id: 'plain', title: 'Plain item', prompt: 'Prompt' } as never)}
    </>);
    expect(screen.getByText('unknown_capability')).toBeInTheDocument();
    expect(screen.getByText('Visible description')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('switch')[0]!);
    fireEvent.click(screen.getAllByRole('switch')[1]!);
    expect(onToolChange).toHaveBeenCalledWith('tool:calendar', false);
    expect(onConnectionChange).toHaveBeenCalledWith('connection:slack', false);
    view.unmount();
  });

  it('opens review for each independently reviewable gate and installs an empty gate directly', async () => {
    const variants = [
      { platformCapabilities: { network: { required: true } } },
      { required: [{ declaration: { toolId: 'required', actions: [], reason: 'Required' }, required: true, resolvedActions: [], allActions: false, granted: true, hasStoredGrant: true, available: true, configured: true }] },
      { optional: [{ declaration: { toolId: 'optional', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, available: true, configured: false }] },
      { connectionRequired: [{ declaration: { type: 'required', actions: [], reason: 'Required' }, required: true, resolvedActions: [], allActions: false, granted: true, hasStoredGrant: true, configured: true, instances: [] }] },
      { connectionOptional: [{ declaration: { type: 'optional', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: false, hasStoredGrant: false, configured: false, instances: [] }] },
      { agents: [{ id: 'agent', title: 'Agent', prompt: 'Prompt' }] },
      { promptTemplates: [{ id: 'prompt', title: 'Prompt', prompt: 'Prompt' }] },
    ];
    for (const variant of variants) {
      resetControllerHarness();
      const bridge = installControllerBridge({ getAppToolsInstallGate: emptyGate(variant) });
      const current = await renderControllerHarness(bridge);
      await act(async () => current.result.current.handleInstall('planner'));
      expect(current.result.current.pendingInstallGate).not.toBeNull();
      current.unmount();
    }

    const bridge = installControllerBridge({
      getAppToolsInstallGate: emptyGate(), installApp: { success: true, userMessage: '' }, installWelcome: { success: false },
    });
    const direct = await renderControllerHarness(bridge);
    await act(async () => direct.result.current.handleInstall('planner'));
    expect(bridge.call('installApp')).toHaveBeenCalled();
    expect(direct.result.current.pendingInstallGate).toBeNull();
  });

  it('guards absent gates and details and recovers optional and direct grant failures', async () => {
    const bridge = installControllerBridge({
      setAppToolGrant: () => Promise.reject(new Error('tool grant failed')),
      setAppConnectionGrant: () => Promise.reject(new Error('connection grant failed')),
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleConfirmInstallWithTools());
    await act(async () => result.current.handleAppDetailsToolGrant('tool', true));
    await act(async () => result.current.handleAppDetailsConnectionGrant('connection', true));
    expect(bridge.call('setAppToolGrant')).not.toHaveBeenCalled();

    await act(async () => result.current.openAppDetails('planner'));
    await act(async () => result.current.handleAppDetailsToolGrant('tool', true));
    await act(async () => result.current.handleAppDetailsConnectionGrant('connection', true));
    expect(result.current.bannerSeverity).toBe('error');

    const gate = emptyGate({
      optional: [{ declaration: { toolId: 'tool', actions: [], reason: 'Optional' }, required: false, resolvedActions: [], allActions: false, granted: true, hasStoredGrant: true, available: true, configured: true }],
    });
    bridge.set('getAppToolsInstallGate', gate);
    await act(async () => result.current.handleInstall('planner'));
    bridge.set('setAppToolGrant', () => Promise.reject(new Error('grant failed')));
    await act(async () => result.current.handleConfirmInstallWithTools());
    expect(result.current.pendingInstallBusy).toBe(false);
  });
});
