import { createTheme, ThemeProvider } from '@mui/material/styles';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolsView, type SelectedTool } from '@renderer/views/ToolsView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { AgentToolDefinition, AgentToolPackageDefinition, AgentToolSettings, OfficialToolSummary } from '@shared/types';

vi.mock('@renderer/views/tools/ToolRow', () => ({
  ToolRow: ({ title, description, meta, pill, onClick }: { title: string; description: string; meta: string; pill: React.ReactNode; onClick: () => void }) => (
    <button type="button" data-testid={`tool-row-${title}`} onClick={onClick}>
      <span>{title}</span><span>{description}</span><span>{meta}</span>{pill}
    </button>
  ),
}));

vi.mock('@renderer/views/tools/ToolIcons', () => ({
  ForgerToolIcon: ({ mode }: { mode: string }) => <span data-testid="forger-icon">{mode}</span>,
}));

vi.mock('@renderer/views/tools/ForgerToolDetail', () => ({
  ForgerToolDetail: (props: {
    mode: string;
    title: string;
    description: string;
    toolPackage: AgentToolPackageDefinition | null;
    onBack: () => void;
    onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
  }) => (
    <div data-testid="forger-detail" data-mode={props.mode} data-package={props.toolPackage?.id ?? 'none'}>
      <span>{props.title}</span><span>{props.description}</span>
      <button type="button" onClick={props.onBack}>Back from Forger</button>
      <button type="button" onClick={() => props.onApprovalChange('forger_list_catalog', false)}>Change Forger approval</button>
    </div>
  ),
}));

vi.mock('@renderer/views/tools/OfficialToolDetail', () => ({
  OfficialToolDetail: (props: {
    tool: OfficialToolSummary;
    toolPackage: AgentToolPackageDefinition | null;
    onBack: () => void;
    onConnect: (secrets?: Record<string, string>) => void;
    onDisconnect: () => void;
    onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
  }) => (
    <div data-testid="official-detail" data-package={props.toolPackage?.id ?? 'none'}>
      <span>{props.tool.name}</span>
      <button type="button" onClick={props.onBack}>Back from official</button>
      <button type="button" onClick={() => props.onConnect({ token: 'secret' })}>Connect official</button>
      <button type="button" onClick={props.onDisconnect}>Disconnect official</button>
      <button type="button" onClick={() => props.onApprovalChange('forger_list_catalog', true)}>Change official approval</button>
    </div>
  ),
}));

const t = en as unknown as AppDictionary;
const forgerTool: AgentToolDefinition = {
  id: 'forger_list_catalog',
  packageId: 'forger',
  name: 'Catalog source',
  description: 'Catalog source description',
  category: 'consulta',
  risk: 'bajo',
  defaultRequiresApproval: true,
};
const officialAction = { id: 'read', name: 'Read', description: 'Read data', risk: 'low' as const };
const gmail: OfficialToolSummary = {
  id: 'gmail', name: 'Gmail', description: 'Read Gmail messages', version: '1.0.0', runtime: 'node', actions: [officialAction], secrets: [], official: true,
  status: 'configured', configured: true,
};
const slack: OfficialToolSummary = {
  id: 'slack', name: 'Slack', description: 'Send Slack messages', version: '1.0.0', runtime: 'node', actions: [officialAction, { ...officialAction, id: 'send', name: 'Send' }], secrets: [], official: true,
  status: 'available', configured: false,
};
const forgerPackage: AgentToolPackageDefinition = {
  id: 'forger', name: 'Unlocalized Forger', description: 'Unlocalized description', icon: 'forger', tools: [forgerTool],
};
const gmailPackage: AgentToolPackageDefinition = {
  id: 'official:gmail', name: 'Gmail package', description: 'Gmail package', icon: 'forger', tools: [forgerTool, { ...forgerTool, id: 'forger_check_updates' }],
};
const settings: AgentToolSettings = { approvals: {} };

const renderView = ({
  packages = [forgerPackage, gmailPackage],
  officialTools = [gmail, slack],
  selectedTool = null as SelectedTool,
  errorMessage = null as string | null,
  errorTechnicalCode = null as string | null,
  mode = 'light' as 'light' | 'dark',
} = {}) => {
  const handlers = {
    onSelectedToolChange: vi.fn(),
    onApprovalChange: vi.fn(),
    onActivateOfficialTool: vi.fn(),
    onConfigureOfficialTool: vi.fn(),
    onDeactivateOfficialTool: vi.fn(),
  };
  const view = render(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <ToolsView
        packages={packages}
        settings={settings}
        officialTools={officialTools}
        selectedTool={selectedTool}
        busyToolId={null}
        busyOfficialToolId={null}
        errorMessage={errorMessage}
        errorTechnicalCode={errorTechnicalCode}
        t={t}
        {...handlers}
      />
    </ThemeProvider>,
  );
  return { ...handlers, ...view };
};

describe('ToolsView', () => {
  it('lists built-in and official tools, uses package/action counts, searches, and opens rows', async () => {
    const user = userEvent.setup();
    const handlers = renderView();

    const forgerRow = screen.getByTestId(`tool-row-${t.sections.tools.packages.forger.name}`);
    expect(forgerRow).toHaveTextContent(t.sections.tools.packageToolCount(1));
    expect(screen.getByTestId('tool-row-Gmail')).toHaveTextContent(t.sections.tools.packageToolCount(2));
    expect(screen.getByTestId('tool-row-Slack')).toHaveTextContent(t.sections.tools.packageToolCount(2));
    expect(screen.getByText(t.sections.tools.active)).toBeInTheDocument();
    expect(screen.getByText(t.sections.tools.inactive)).toBeInTheDocument();

    await user.click(forgerRow);
    await user.click(screen.getByTestId('tool-row-Gmail'));
    expect(handlers.onSelectedToolChange.mock.calls).toEqual([['forger'], ['gmail']]);

    const search = screen.getByRole('textbox', { name: t.sections.tools.searchPlaceholder });
    await user.type(search, '  GMAIL  ');
    expect(screen.queryByTestId(`tool-row-${t.sections.tools.packages.forger.name}`)).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-row-Gmail')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-row-Slack')).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'no matching capability');
    expect(screen.getByText(t.sections.tools.emptySearch)).toBeInTheDocument();
  });

  it('uses built-in fallback copy/count and shows ordinary errors without account help', () => {
    renderView({ packages: [], officialTools: [], selectedTool: 'missing', errorMessage: 'Could not load tools.', errorTechnicalCode: 'network_error' });

    expect(screen.getByTestId(`tool-row-${t.sections.tools.packages.forger.name}`)).toHaveTextContent(t.sections.tools.builtIn);
    expect(screen.getByText('Could not load tools.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.sections.tools.gmailAccountRequiredHelp })).not.toBeInTheDocument();
  });

  it('explains the account requirement and closes help by button and Escape', async () => {
    const user = userEvent.setup();
    renderView({ errorMessage: t.sections.tools.gmailAccountRequired, errorTechnicalCode: 'forger_account_required' });

    const help = screen.getByRole('button', { name: t.sections.tools.gmailAccountRequiredHelp });
    await user.click(help);
    expect(screen.getByText(t.sections.tools.gmailAccountRequiredBody)).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.actions.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(help);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('renders Forger detail with and without a package and delegates back and approval changes', async () => {
    const user = userEvent.setup();
    const handlers = renderView({ selectedTool: 'forger', mode: 'dark' });
    expect(screen.getByTestId('forger-detail')).toHaveAttribute('data-mode', 'dark');
    expect(screen.getByTestId('forger-detail')).toHaveAttribute('data-package', 'forger');
    await user.click(screen.getByRole('button', { name: 'Change Forger approval' }));
    await user.click(screen.getByRole('button', { name: 'Back from Forger' }));
    expect(handlers.onApprovalChange).toHaveBeenCalledWith('forger_list_catalog', false);
    expect(handlers.onSelectedToolChange).toHaveBeenCalledWith(null);
    handlers.unmount();

    renderView({ packages: [], officialTools: [], selectedTool: 'forger' });
    expect(screen.getByTestId('forger-detail')).toHaveAttribute('data-package', 'none');
  });

  it('renders official detail with and without a package and delegates all actions', async () => {
    const user = userEvent.setup();
    const handlers = renderView({ selectedTool: 'gmail' });
    expect(screen.getByTestId('official-detail')).toHaveAttribute('data-package', 'official:gmail');
    await user.click(screen.getByRole('button', { name: 'Connect official' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect official' }));
    await user.click(screen.getByRole('button', { name: 'Change official approval' }));
    await user.click(screen.getByRole('button', { name: 'Back from official' }));
    expect(handlers.onConfigureOfficialTool).toHaveBeenCalledWith('gmail', { token: 'secret' });
    expect(handlers.onDeactivateOfficialTool).toHaveBeenCalledWith('gmail');
    expect(handlers.onApprovalChange).toHaveBeenCalledWith('forger_list_catalog', true);
    expect(handlers.onSelectedToolChange).toHaveBeenCalledWith(null);
    handlers.unmount();

    renderView({ packages: [forgerPackage], officialTools: [slack], selectedTool: 'slack' });
    expect(screen.getByTestId('official-detail')).toHaveAttribute('data-package', 'none');
  });
});
