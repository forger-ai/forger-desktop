import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDictionary } from '@renderer/i18n';
import { RendererAppDialogs } from '@renderer/app/RendererAppDialogs';

const modalSpies = vi.hoisted(() => ({
  cloud: vi.fn(),
  codex: vi.fn(),
  claude: vi.fn(),
  provider: vi.fn(),
}));

vi.mock('@renderer/components/ForgerCloudModal', () => ({
  ForgerCloudModal: (props: Record<string, any>) => {
    modalSpies.cloud(props);
    if (!props.open) return null;
    return (
      <div data-testid="cloud-modal">
        <button onClick={props.onClose}>Cloud close</button>
        <button onClick={() => props.onLogin({ email: 'user@example.com', password: 'secret' })}>Cloud login</button>
        <button onClick={() => props.onGoogleLogin()}>Cloud Google</button>
        <button onClick={() => props.onAppleLogin()}>Cloud Apple</button>
        <button onClick={() => props.onRegister({ email: 'user@example.com', password: 'secret' })}>Cloud register</button>
        <button onClick={() => props.onUpdateUsername('new-name')}>Cloud username</button>
        <button onClick={() => props.onLogout()}>Cloud logout</button>
      </div>
    );
  },
}));

vi.mock('@renderer/components/CodexConfigModal', () => ({
  CodexConfigModal: (props: Record<string, any>) => {
    modalSpies.codex(props);
    if (!props.open) return null;
    return (
      <div data-testid="codex-modal">
        <button onClick={props.onClose}>Codex close</button>
        <button onClick={props.onConnect}>Codex connect</button>
        <button onClick={props.onRefresh}>Codex refresh</button>
        <button onClick={() => props.onOpenExternalUrl('https://codex.example')}>Codex docs</button>
      </div>
    );
  },
}));

vi.mock('@renderer/components/ClaudeConfigModal', () => ({
  ClaudeConfigModal: (props: Record<string, any>) => {
    modalSpies.claude(props);
    if (!props.open) return null;
    return (
      <div data-testid="claude-modal">
        <button onClick={props.onClose}>Claude close</button>
        <button onClick={props.onConnect}>Claude connect</button>
        <button onClick={props.onRefresh}>Claude refresh</button>
        <button onClick={props.onDisconnect}>Claude disconnect</button>
        <button onClick={props.onSignOut}>Claude sign out</button>
        <button onClick={props.onReinstall}>Claude reinstall</button>
        <button onClick={() => props.onOpenExternalUrl('https://claude.example')}>Claude docs</button>
      </div>
    );
  },
}));

vi.mock('@renderer/components/LlmProviderConnectModal', () => ({
  LlmProviderConnectModal: (props: Record<string, any>) => {
    modalSpies.provider(props);
    if (!props.open) return null;
    return (
      <div data-testid="provider-modal">
        <button onClick={props.onClose}>Provider close</button>
        <button onClick={props.onConnect}>Provider connect</button>
        <button onClick={() => props.onOpenExternalUrl('https://provider.example')}>Provider docs</button>
      </div>
    );
  },
}));

const t = getDictionary('en');

const closedController = () => ({
  getDesktopApi: () => ({ openExternalUrl: vi.fn() }),
  t,
  pendingInstallGate: null,
  pendingInstallBusy: false,
  setPendingInstallGate: vi.fn(),
  renderInstallTool: vi.fn((item: any, required: boolean) => <span key={`tool-${item.id}`}>Tool {item.id} {String(required)}</span>),
  renderInstallConnection: vi.fn((item: any, required: boolean) => <span key={`connection-${item.id}`}>Connection {item.id} {String(required)}</span>),
  renderInstallCapability: vi.fn((item: any) => <span key={`capability-${item.id}`}>Capability {item.id}</span>),
  renderInstallItem: vi.fn((item: any) => <span key={`item-${item.id}`}>Item {item.id}</span>),
  capabilityRows: vi.fn(() => []),
  handleConfirmInstallWithTools: vi.fn(),
  cloudModalOpen: false,
  setCloudModalOpen: vi.fn(),
  forgerAccount: null,
  forgerAccountBusy: false,
  forgerAccountMessage: null,
  handleForgerLogin: vi.fn(),
  handleForgerGoogleLogin: vi.fn(),
  handleForgerAppleLogin: vi.fn(),
  handleForgerRegister: vi.fn(),
  handleForgerUsernameUpdate: vi.fn(),
  handleForgerLogout: vi.fn(),
  settings: { providerConnections: { claude: false, antigravity: false } },
  codexConfigOpen: false,
  codexAuthStatus: { authenticated: false },
  codexAuthBusy: false,
  closeCodexConfig: vi.fn(),
  handleConnectCodexAuth: vi.fn(),
  refreshCodexAuthStatus: vi.fn(),
  claudeConfigOpen: false,
  claudeAuthStatus: { authenticated: false },
  claudeAuthBusy: false,
  closeClaudeConfig: vi.fn(),
  handleConnectClaudeAuth: vi.fn(),
  refreshClaudeAuthStatus: vi.fn(),
  handleDisconnectClaudeAuth: vi.fn(),
  handleSignOutClaudeAuth: vi.fn(),
  handleReinstallClaude: vi.fn(),
  antigravityConfigOpen: false,
  antigravityAuthStatus: { authenticated: false, installed: false },
  antigravityAuthBusy: false,
  closeAntigravityConfig: vi.fn(),
  handleConnectAntigravityAuth: vi.fn(),
  agentProviderConfigOpen: false,
  setAgentProviderConfigOpen: vi.fn(),
  setCodexConfigOpen: vi.fn(),
  setClaudeConfigOpen: vi.fn(),
  setAntigravityConfigOpen: vi.fn(),
  categoryDialogOpen: false,
  setCategoryDialogOpen: vi.fn(),
  categoryDialogName: '',
  setCategoryDialogName: vi.fn(),
  handleCreateCategorySubmit: vi.fn(),
  renameCategoryDialog: { open: false, categoryPath: '', name: '' },
  setRenameCategoryDialog: vi.fn(),
  handleRenameCategorySubmit: vi.fn(),
  renameFileDialog: { open: false, file: null, name: '' },
  setRenameFileDialog: vi.fn(),
  handleRenameFileSubmit: vi.fn(),
  renameAppDialog: { open: false, name: '', busy: false, isRemix: false, syncsCloud: false },
  closeRenameAppDialog: vi.fn(),
  setRenameAppName: vi.fn(),
  submitRenameAppDialog: vi.fn(),
  moveFileDialog: { open: false, file: null, categoryPath: '' },
  setMoveFileDialog: vi.fn(),
  handleMoveFileSubmit: vi.fn(),
  fileCategories: [],
  remoteTunnelReadyDialog: { open: false },
  closeRemoteTunnelReadyDialog: vi.fn(),
  stopReadyRemoteTunnel: vi.fn(),
  openRemoteTunnelPortal: vi.fn(),
  appCategoryOptions: ['productivity', 'other'],
  socialUploadDialog: { open: false, isRemix: false, name: '', category: 'productivity', visibility: 'private' },
  closeSocialUploadDialog: vi.fn(),
  setSocialUploadVisibility: vi.fn(),
  setSocialUploadCategory: vi.fn(),
  setSocialUploadName: vi.fn(),
  submitSocialUploadDialog: vi.fn(),
  errorReportDialog: { open: false, busy: false, report: null, userMessage: '' },
  closeErrorReportDialog: vi.fn(),
  copyErrorReportDetails: vi.fn(),
  submitErrorReport: vi.fn(),
  conversationDiagnosticDialog: { open: false, busy: false, report: null, description: '', userMessage: '' },
  setConversationDiagnosticDescription: vi.fn(),
  closeConversationDiagnosticDialog: vi.fn(),
  copyConversationDiagnosticReport: vi.fn(),
  submitConversationDiagnosticReport: vi.fn(),
  bannerMessage: null,
  setBannerMessage: vi.fn(),
  bannerSeverity: 'success' as const,
});

const renderDialogs = (overrides: Record<string, unknown> = {}) => {
  const controller = { ...closedController(), ...overrides };
  const rendered = render(<RendererAppDialogs controller={controller} />);
  return { controller, ...rendered };
};

beforeEach(() => {
  Object.values(modalSpies).forEach((spy) => spy.mockClear());
});

describe('RendererAppDialogs', () => {
  it('reviews a populated install gate, confirms it, and blocks dismissal while busy', async () => {
    const user = userEvent.setup();
    const capabilityRows = vi.fn(() => [{ id: 'camera' }]);
    const gate = {
      appName: 'Photo desk',
      required: [{ id: 'required-tool' }], optional: [{ id: 'optional-tool' }],
      connectionRequired: [{ id: 'required-connection' }], connectionOptional: [{ id: 'optional-connection' }],
      agents: [{ id: 'agent' }], promptTemplates: [{ id: 'prompt' }],
    };
    const { controller } = renderDialogs({ pendingInstallGate: gate, capabilityRows });
    expect(screen.getByText('Capability camera')).toBeVisible();
    expect(screen.getByText('Tool required-tool true')).toBeVisible();
    expect(screen.getByText('Tool optional-tool false')).toBeVisible();
    expect(screen.getByText('Connection required-connection true')).toBeVisible();
    expect(screen.getByText('Connection optional-connection false')).toBeVisible();
    expect(screen.getByText('Item agent')).toBeVisible();
    expect(screen.getByText('Item prompt')).toBeVisible();
    await user.click(screen.getByRole('button', { name: t.installGate.cancel }));
    await user.click(screen.getByRole('button', { name: t.installGate.confirm }));
    expect(controller.setPendingInstallGate).toHaveBeenCalledWith(null);
    expect(controller.handleConfirmInstallWithTools).toHaveBeenCalledOnce();

    const busy = renderDialogs({ pendingInstallGate: gate, pendingInstallBusy: true, capabilityRows });
    await user.keyboard('{Escape}');
    expect(busy.controller.setPendingInstallGate).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: t.installGate.confirm }).at(-1)).toBeDisabled();
  });

  it('shows empty install sections and accepts legacy gates without connection arrays', async () => {
    const user = userEvent.setup();
    const gate = { appName: undefined, required: [], optional: [], agents: [], promptTemplates: [] };
    const { controller } = renderDialogs({ pendingInstallGate: gate });
    expect(screen.getByText(t.installGate.noCapabilities)).toBeVisible();
    expect(screen.getByText(t.installGate.noTools)).toBeVisible();
    expect(screen.getByText(t.installGate.noConnections)).toBeVisible();
    expect(screen.getByText(t.installGate.noAgents)).toBeVisible();
    expect(screen.getByText(t.installGate.noAiTasks)).toBeVisible();
    expect(screen.getByText(t.installGate.title(t.installGate.fallbackAppName))).toBeVisible();
    await user.keyboard('{Escape}');
    expect(controller.setPendingInstallGate).toHaveBeenCalledWith(null);
  });

  it('renders either legacy connection list when the other list is absent', () => {
    const required = renderDialogs({ pendingInstallGate: {
      appName: 'Legacy required', required: [], optional: [],
      connectionRequired: [{ id: 'required-only' }], agents: [], promptTemplates: [],
    } });
    expect(screen.getByText('Connection required-only true')).toBeVisible();
    required.unmount();
    renderDialogs({ pendingInstallGate: {
      appName: 'Legacy optional', required: [], optional: [],
      connectionOptional: [{ id: 'optional-only' }], agents: [], promptTemplates: [],
    } });
    expect(screen.getByText('Connection optional-only false')).toBeVisible();
  });

  it('wires cloud and all three provider modals, including external documentation', async () => {
    const user = userEvent.setup();
    const external = vi.fn();
    const { controller, rerender } = renderDialogs({
      getDesktopApi: () => ({ openExternalUrl: external }),
      cloudModalOpen: true, codexConfigOpen: true, claudeConfigOpen: true, antigravityConfigOpen: true,
      settings: { providerConnections: { claude: true, antigravity: true } },
      claudeAuthStatus: { authenticated: true },
      antigravityAuthStatus: { authenticated: true, installed: true },
    });
    for (const name of [
      'Cloud close', 'Cloud login', 'Cloud Google', 'Cloud Apple', 'Cloud register', 'Cloud username', 'Cloud logout',
      'Codex close', 'Codex connect', 'Codex refresh', 'Codex docs',
      'Claude close', 'Claude connect', 'Claude refresh', 'Claude disconnect', 'Claude sign out', 'Claude reinstall', 'Claude docs',
      'Provider close', 'Provider connect', 'Provider docs',
    ]) await user.click(screen.getByRole('button', { name }));
    expect(controller.setCloudModalOpen).toHaveBeenCalledWith(false);
    expect(controller.handleForgerLogin).toHaveBeenCalled();
    expect(controller.handleForgerGoogleLogin).toHaveBeenCalled();
    expect(controller.handleForgerAppleLogin).toHaveBeenCalled();
    expect(controller.handleForgerRegister).toHaveBeenCalled();
    expect(controller.handleForgerUsernameUpdate).toHaveBeenCalledWith('new-name');
    expect(controller.handleForgerLogout).toHaveBeenCalled();
    expect(external).toHaveBeenCalledTimes(3);
    expect(modalSpies.claude.mock.lastCall?.[0].forgerConnected).toBe(true);
    expect(modalSpies.provider.mock.lastCall?.[0].authenticated).toBe(true);

    const disconnected = { ...controller,
      settings: { providerConnections: { claude: false, antigravity: false } },
      claudeAuthStatus: { authenticated: true }, antigravityAuthStatus: { authenticated: true, installed: false },
    };
    rerender(<RendererAppDialogs controller={disconnected} />);
    expect(modalSpies.claude.mock.lastCall?.[0].forgerConnected).toBe(false);
    expect(modalSpies.provider.mock.lastCall?.[0].authenticated).toBe(false);
  });

  it('publishes original and remixed apps and updates all social fields', async () => {
    const user = userEvent.setup();
    const { controller, rerender } = renderDialogs({
      socialUploadDialog: { open: true, isRemix: true, name: 'Remix name', category: 'productivity', visibility: 'private' },
    });
    expect(screen.getByText(t.social.uploadRemixBody)).toBeVisible();
    await user.type(screen.getByLabelText(t.social.uploadNameLabel), ' updated');
    await user.click(screen.getByLabelText(t.social.uploadCategoryLabel));
    await user.click(screen.getAllByRole('option')[1]);
    await user.click(screen.getByLabelText(t.social.uploadVisibilityLabel));
    await user.click(screen.getByRole('option', { name: t.social.uploadVisibility.public }));
    await user.click(screen.getByRole('button', { name: t.social.uploadAction }));
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(controller.setSocialUploadName).toHaveBeenCalled();
    expect(controller.setSocialUploadCategory).toHaveBeenCalledWith('other');
    expect(controller.setSocialUploadVisibility).toHaveBeenCalledWith('public');
    expect(controller.submitSocialUploadDialog).toHaveBeenCalledOnce();
    expect(controller.closeSocialUploadDialog).toHaveBeenCalledOnce();

    rerender(<RendererAppDialogs controller={{ ...controller, socialUploadDialog: {
      open: true, isRemix: false, name: '', category: 'productivity', visibility: 'friends',
    } }} />);
    expect(screen.getByText(t.social.uploadBody)).toBeVisible();
    expect(screen.queryByLabelText(t.social.uploadNameLabel)).not.toBeInTheDocument();
  });

  it('renames remix, cloud, and local apps and enforces busy and non-empty names', async () => {
    const user = userEvent.setup();
    const { controller, rerender } = renderDialogs({ renameAppDialog: {
      open: true, name: 'Remix', busy: false, isRemix: true, syncsCloud: false,
    } });
    expect(screen.getByText(t.social.renameAppRemixBody)).toBeVisible();
    await user.type(screen.getByLabelText(t.social.renameAppNameLabel), ' copy');
    await user.click(screen.getByRole('button', { name: t.actions.save }));
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(controller.setRenameAppName).toHaveBeenCalled();
    expect(controller.submitRenameAppDialog).toHaveBeenCalledOnce();
    expect(controller.closeRenameAppDialog).toHaveBeenCalledOnce();

    rerender(<RendererAppDialogs controller={{ ...controller, renameAppDialog: {
      open: true, name: 'Cloud', busy: false, isRemix: false, syncsCloud: true,
    } }} />);
    expect(screen.getByText(t.social.renameAppCloudBody)).toBeVisible();
    rerender(<RendererAppDialogs controller={{ ...controller, renameAppDialog: {
      open: true, name: '', busy: true, isRemix: false, syncsCloud: false,
    } }} />);
    expect(screen.getByText(t.social.renameAppLocalBody)).toBeVisible();
    expect(screen.getByRole('button', { name: t.social.saving })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.actions.close })).toBeDisabled();
  });

  it('switches provider setup and handles category, file rename, and move dialogs', async () => {
    const user = userEvent.setup();
    const provider = renderDialogs({ agentProviderConfigOpen: true });
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    await user.click(screen.getByRole('button', { name: t.agentProvider.claudeAction }));
    await user.click(screen.getByRole('button', { name: t.settings.antigravityConnectAction }));
    await user.click(screen.getByRole('button', { name: t.agentProvider.codexAction }));
    expect(provider.controller.setAgentProviderConfigOpen).toHaveBeenCalledWith(false);
    expect(provider.controller.setClaudeConfigOpen).toHaveBeenCalledWith(true);
    expect(provider.controller.setAntigravityConfigOpen).toHaveBeenCalledWith(true);
    expect(provider.controller.setCodexConfigOpen).toHaveBeenCalledWith(true);
    provider.unmount();

    const category = renderDialogs({ categoryDialogOpen: true, categoryDialogName: 'Work' });
    const categoryInput = screen.getByLabelText(t.sections.files.categoryNamePrompt);
    await user.type(categoryInput, 'space');
    await user.keyboard('x');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: t.sections.files.createCategory }));
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(category.controller.setCategoryDialogName).toHaveBeenCalled();
    expect(category.controller.handleCreateCategorySubmit).toHaveBeenCalledTimes(2);
    expect(category.controller.setCategoryDialogOpen).toHaveBeenCalledWith(false);
    category.unmount();

    const renameCategoryState = { open: true, categoryPath: 'work', name: 'Work' };
    const setRenameCategoryDialog = vi.fn((update: any) => {
      if (typeof update === 'function') update(renameCategoryState);
    });
    const renameCategory = renderDialogs({ renameCategoryDialog: renameCategoryState, setRenameCategoryDialog });
    await user.type(screen.getByLabelText(t.sections.files.categoryNamePrompt), ' docs');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: t.sections.files.rename }));
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(renameCategory.controller.setRenameCategoryDialog).toHaveBeenCalled();
    expect(renameCategory.controller.handleRenameCategorySubmit).toHaveBeenCalledTimes(2);
    renameCategory.unmount();

    const renameFileState = { open: true, file: { id: 'file' }, name: 'Notes.txt' };
    const setRenameFileDialog = vi.fn((update: any) => {
      if (typeof update === 'function') update(renameFileState);
    });
    const renameFile = renderDialogs({ renameFileDialog: renameFileState, setRenameFileDialog });
    await user.type(screen.getByLabelText(t.sections.files.namePrompt), ' old');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: t.sections.files.rename }));
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(renameFile.controller.setRenameFileDialog).toHaveBeenCalled();
    expect(renameFile.controller.handleRenameFileSubmit).toHaveBeenCalledTimes(2);
    renameFile.unmount();

    const moveState = { open: true, file: { id: 'file' }, categoryPath: '' };
    const setMoveFileDialog = vi.fn((update: any) => {
      if (typeof update === 'function') update(moveState);
    });
    const move = renderDialogs({
      moveFileDialog: moveState,
      setMoveFileDialog,
      fileCategories: [{ path: 'work', name: 'Work' }],
    });
    const moveDialog = screen.getByRole('dialog', { name: t.sections.files.moveFile });
    await user.click(within(moveDialog).getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Work' }));
    await user.click(within(moveDialog).getByRole('button', { name: t.sections.files.move }));
    await user.click(within(moveDialog).getByRole('button', { name: t.actions.close }));
    expect(move.controller.setMoveFileDialog).toHaveBeenCalled();
    expect(move.controller.handleMoveFileSubmit).toHaveBeenCalledOnce();
  });

  it('disables blank category and file names and closes dialogs with Escape', async () => {
    const user = userEvent.setup();
    const category = renderDialogs({ categoryDialogOpen: true, categoryDialogName: '   ' });
    expect(screen.getByRole('button', { name: t.sections.files.createCategory })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(category.controller.setCategoryDialogOpen).toHaveBeenCalledWith(false);
    category.unmount();
    const renamedCategory = renderDialogs({ renameCategoryDialog: { open: true, categoryPath: 'work', name: ' ' } });
    expect(screen.getByRole('button', { name: t.sections.files.rename })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(renamedCategory.controller.setRenameCategoryDialog).toHaveBeenCalledWith({ open: false, categoryPath: '', name: '' });
    renamedCategory.unmount();
    const renamedFile = renderDialogs({ renameFileDialog: { open: true, file: { id: 'file' }, name: '' } });
    expect(screen.getByRole('button', { name: t.sections.files.rename })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(renamedFile.controller.setRenameFileDialog).toHaveBeenCalledWith({ open: false, file: null, name: '' });
    renamedFile.unmount();
    const moved = renderDialogs({ moveFileDialog: { open: true, file: { id: 'file' }, categoryPath: '' } });
    await user.keyboard('{Escape}');
    expect(moved.controller.setMoveFileDialog).toHaveBeenCalledWith({ open: false, file: null, categoryPath: '' });
  });

  it('controls the ready remote tunnel', async () => {
    const user = userEvent.setup();
    const { controller } = renderDialogs({ remoteTunnelReadyDialog: { open: true } });
    await user.click(screen.getByRole('button', { name: t.remoteNetwork.stop }));
    await user.click(screen.getByRole('button', { name: t.remoteNetwork.openPortal }));
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(controller.stopReadyRemoteTunnel).toHaveBeenCalledOnce();
    expect(controller.openRemoteTunnelPortal).toHaveBeenCalledOnce();
    expect(controller.closeRemoteTunnelReadyDialog).toHaveBeenCalledOnce();
  });

  it('previews, copies, submits, and closes an error report without exposing its attachment token', async () => {
    const user = userEvent.setup();
    const report = {
      diagnosticAttachmentToken: 'private-token', event: 'startup_failed',
      diagnosticFiles: [{ kind: 'desktop', filename: 'desktop.log', sanitizedByteSize: 42 }],
    };
    const { controller } = renderDialogs({ errorReportDialog: {
      open: true, busy: false, report, userMessage: 'Ready to send',
    } });
    expect(screen.getByText(t.settings.reportFileItem('desktop.log', 42))).toBeVisible();
    expect((screen.getByLabelText(t.settings.errorReportDetailsLabel) as HTMLInputElement).value).not.toContain('private-token');
    expect(screen.getByText('Ready to send')).toBeVisible();
    await user.click(screen.getByRole('button', { name: t.settings.errorReportCopy }));
    await user.click(screen.getByRole('button', { name: t.settings.errorReportSend }));
    await user.click(screen.getByRole('button', { name: t.settings.errorReportNoSend }));
    expect(controller.copyErrorReportDetails).toHaveBeenCalledOnce();
    expect(controller.submitErrorReport).toHaveBeenCalledOnce();
    expect(controller.closeErrorReportDialog).toHaveBeenCalledOnce();
  });

  it('disables an unavailable error report and renders no optional preview content', () => {
    renderDialogs({ errorReportDialog: { open: true, busy: true, report: null, userMessage: '' } });
    expect(screen.queryByText(t.settings.reportFilesLabel)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t.settings.errorReportDetailsLabel)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.settings.errorReportCopy })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.settings.errorReportSend })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.settings.errorReportNoSend })).toBeDisabled();
  });

  it('edits, previews, copies, and sends conversation diagnostics in idle and busy states', async () => {
    const user = userEvent.setup();
    const report = {
      diagnosticAttachmentToken: 'conversation-token', conversationId: 'conversation-1',
      diagnosticFiles: [{ kind: 'conversation', filename: 'conversation.json', sanitizedByteSize: 128 }],
    };
    const { controller, rerender } = renderDialogs({ conversationDiagnosticDialog: {
      open: true, busy: false, report, description: '  useful context  ', userMessage: 'Prepared',
    } });
    expect(screen.getByText(t.settings.reportFileItem('conversation.json', 128))).toBeVisible();
    const preview = screen.getByLabelText(t.settings.conversationReportDetailsLabel);
    expect((preview as HTMLInputElement).value).toContain('useful context');
    expect((preview as HTMLInputElement).value).not.toContain('conversation-token');
    await user.type(screen.getByLabelText(t.settings.conversationReportDescriptionLabel), ' more');
    await user.click(screen.getByRole('button', { name: t.settings.errorReportCopy }));
    await user.click(screen.getByRole('button', { name: t.settings.conversationReportSend }));
    await user.click(screen.getByRole('button', { name: t.settings.errorReportNoSend }));
    expect(controller.setConversationDiagnosticDescription).toHaveBeenCalled();
    expect(controller.copyConversationDiagnosticReport).toHaveBeenCalledOnce();
    expect(controller.submitConversationDiagnosticReport).toHaveBeenCalledOnce();
    expect(controller.closeConversationDiagnosticDialog).toHaveBeenCalledOnce();

    rerender(<RendererAppDialogs controller={{ ...controller, conversationDiagnosticDialog: {
      open: true, busy: true, report: { ...report, diagnosticFiles: [] }, description: '   ', userMessage: '',
    } }} />);
    expect(screen.queryByText(t.settings.reportFilesLabel)).not.toBeInTheDocument();
    expect((screen.getByLabelText(t.settings.conversationReportDetailsLabel) as HTMLInputElement).value).not.toContain('description');
    expect(screen.getByRole('button', { name: t.settings.conversationReportSending })).toBeDisabled();
    expect(screen.getByLabelText(t.settings.conversationReportDescriptionLabel)).toBeDisabled();
  });

  it('dismisses success and error banners through Snackbar and Alert controls', async () => {
    const user = userEvent.setup();
    const { controller, rerender } = renderDialogs({ bannerMessage: 'Saved successfully', bannerSeverity: 'success' });
    expect(screen.getByText('Saved successfully')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(controller.setBannerMessage).toHaveBeenCalledWith(null);
    rerender(<RendererAppDialogs controller={{ ...controller, bannerMessage: 'Failed', bannerSeverity: 'error' }} />);
    await user.keyboard('{Escape}');
    expect(controller.setBannerMessage).toHaveBeenCalledWith(null);
  });
});
