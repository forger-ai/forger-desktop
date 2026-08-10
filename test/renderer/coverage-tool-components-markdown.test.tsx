import { ThemeProvider } from '@mui/material/styles';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  OfficialToolSummary,
} from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import { buildAppTheme } from '@renderer/theme/appTheme';
import { AppsGrid } from '@renderer/components/AppsGrid';
import { DesktopUpdateSummaryMarkdown } from '@renderer/app/DesktopUpdateSummaryMarkdown';
import { MarkdownMessage } from '@renderer/views/chat/MarkdownMessage';
import { ForgerToolDetail } from '@renderer/views/tools/ForgerToolDetail';
import { OfficialToolDetail } from '@renderer/views/tools/OfficialToolDetail';
import { PermissionList } from '@renderer/views/tools/PermissionList';
import { ToolRow } from '@renderer/views/tools/ToolRow';

const t = getDictionary('en');

const tool = (
  id: AgentToolDefinition['id'],
  overrides: Partial<AgentToolDefinition> = {},
): AgentToolDefinition => ({
  id,
  packageId: 'forger',
  name: `Tool ${id}`,
  description: `Description ${id}`,
  category: 'consulta',
  risk: 'bajo',
  defaultRequiresApproval: false,
  ...overrides,
});

const toolPackage = (tools: AgentToolDefinition[]): AgentToolPackageDefinition => ({
  id: 'forger',
  name: 'Forger',
  description: 'Built-in tools',
  icon: 'forger',
  tools,
});

const officialTool = (
  overrides: Partial<OfficialToolSummary> = {},
): OfficialToolSummary => ({
  id: 'custom',
  name: 'Custom connector',
  description: 'A connector',
  version: '1.0.0',
  runtime: 'node',
  actions: [],
  secrets: [],
  official: true,
  status: 'available',
  configured: false,
  ...overrides,
});

const settings: AgentToolSettings = { approvals: {} };

describe('tool presentation components', () => {
  it('renders arbitrary children in the responsive apps grid', () => {
    render(<AppsGrid><span>First app</span><span>Second app</span></AppsGrid>);
    expect(screen.getByText('First app')).toBeVisible();
    expect(screen.getByText('Second app')).toBeVisible();
  });

  it('renders a clickable tool row with optional onboarding metadata', async () => {
    const onClick = vi.fn();
    const { container, rerender } = render(
      <ToolRow
        icon={<span>Icon</span>}
        title="Search"
        description="Search data"
        meta="Built in"
        pill={<span>Safe</span>}
        onboardingTarget="search-tool"
        onClick={onClick}
      />,
    );
    expect(container.querySelector('[data-onboarding-target="search-tool"]')).toBeTruthy();
    await userEvent.click(screen.getByText('Search'));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(
      <ToolRow icon={<span>Icon</span>} title="Other" description="Other description" meta="Meta" pill={null} onClick={onClick} />,
    );
    expect(container.querySelector('[data-onboarding-target]')).toBeNull();
  });

  it('renders permission metadata, localization, busy state, and approval changes', async () => {
    const onApprovalChange = vi.fn();
    const tools = [
      tool('forger_app_list', { defaultRequiresApproval: true, risk: 'alto', category: 'app' }),
      tool('forger_memory_list', { risk: 'medio', category: 'memoria' }),
      tool('forger_memory_delete', { risk: 'bajo', category: 'actualizacion' }),
    ];
    render(
      <PermissionList
        tools={tools}
        settings={{ approvals: { forger_app_list: false, forger_memory_list: true } }}
        busyToolId="forger_memory_list"
        t={t}
        onboardingTarget="permissions"
        onApprovalChange={onApprovalChange}
      />,
    );
    expect(document.querySelector('[data-onboarding-target="permissions"]')).toBeTruthy();
    expect(document.querySelector('[data-onboarding-target="tool-permission-forger_app_list"]')).toBeTruthy();
    expect(screen.getAllByText(t.sections.tools.approvalOff)).toHaveLength(2);
    expect(screen.getByText(t.sections.tools.approvalOn)).toBeVisible();
    const switches = screen.getAllByRole('checkbox', { name: t.sections.tools.approvalToggleLabel });
    expect(switches[0]).not.toBeChecked();
    expect(switches[1]).toBeChecked();
    expect(switches[1]).toBeDisabled();
    await userEvent.click(switches[2]);
    expect(onApprovalChange).toHaveBeenCalledWith('forger_memory_delete', true);
  });

  it('shows Forger tool details with and without a permission package', async () => {
    const onBack = vi.fn();
    const onApprovalChange = vi.fn();
    const packageDefinition = toolPackage([tool('forger_app_list')]);
    const { rerender } = render(
      <ForgerToolDetail
        mode="light"
        title="Forger"
        description="Built-in platform actions"
        toolPackage={packageDefinition}
        settings={settings}
        busyToolId={null}
        t={t}
        onBack={onBack}
        onApprovalChange={onApprovalChange}
      />,
    );
    expect(screen.getByText(t.sections.tools.builtIn)).toBeVisible();
    expect(screen.getByText('Tool forger_app_list')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.sections.tools.title }));
    expect(onBack).toHaveBeenCalledOnce();

    rerender(
      <ForgerToolDetail
        mode="dark"
        title="Forger"
        description="Built-in platform actions"
        toolPackage={null}
        settings={settings}
        busyToolId={null}
        t={t}
        onBack={onBack}
        onApprovalChange={onApprovalChange}
      />,
    );
    expect(screen.queryByText('Tool forger_app_list')).not.toBeInTheDocument();
  });
});

describe('official tool detail behavior', () => {
  it('activates a connector without manual secrets and respects the busy state', async () => {
    const onConnect = vi.fn();
    const onBack = vi.fn();
    const { rerender } = render(
      <OfficialToolDetail
        tool={officialTool()}
        toolPackage={null}
        settings={settings}
        busyToolId={null}
        busyOfficialToolId={null}
        errorMessage={null}
        t={t}
        onBack={onBack}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
        onApprovalChange={vi.fn()}
      />,
    );
    expect(screen.getByText(t.sections.tools.inactive)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: t.sections.tools.activateTool }));
    expect(onConnect).toHaveBeenCalledWith();
    await userEvent.click(screen.getByRole('button', { name: t.sections.tools.title }));
    expect(onBack).toHaveBeenCalledOnce();

    rerender(
      <OfficialToolDetail
        tool={officialTool()}
        toolPackage={null}
        settings={settings}
        busyToolId={null}
        busyOfficialToolId="custom"
        errorMessage="Connection failed"
        t={t}
        onBack={onBack}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
        onApprovalChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: t.sections.tools.activateTool })).toBeDisabled();
    expect(screen.getByText('Connection failed')).toBeVisible();
  });

  it('collects required and optional local secrets before connecting', async () => {
    const onConnect = vi.fn();
    render(
      <OfficialToolDetail
        tool={officialTool({
          secrets: [
            { name: 'token', label: 'Token', required: true, usage: 'API access', manual: true },
            { name: 'region', label: 'Region', required: false, usage: 'Optional region', manual: true },
            { name: 'managed', label: 'Managed', required: true, usage: 'Managed elsewhere', manual: false },
          ],
        })}
        toolPackage={null}
        settings={settings}
        busyToolId={null}
        busyOfficialToolId={null}
        errorMessage={null}
        t={t}
        onBack={vi.fn()}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
        onApprovalChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Managed')).not.toBeInTheDocument();
    const connect = screen.getByRole('button', { name: t.sections.tools.connectorSecretsConnect });
    expect(connect).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Token'), '  ');
    expect(connect).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Token'));
    await userEvent.type(screen.getByLabelText('Token'), 'secret-token');
    await userEvent.type(screen.getByLabelText('Region'), 'south');
    await userEvent.click(connect);
    expect(onConnect).toHaveBeenCalledWith({ token: 'secret-token', region: 'south' });
  });

  it('disconnects configured tools and renders their permissions', async () => {
    const onDisconnect = vi.fn();
    const onApprovalChange = vi.fn();
    render(
      <OfficialToolDetail
        tool={officialTool({ configured: true, status: 'configured', secrets: [
          { name: 'token', label: 'Token', required: true, usage: 'API access', manual: true },
        ] })}
        toolPackage={toolPackage([tool('forger_app_list')])}
        settings={settings}
        busyToolId="forger_app_list"
        busyOfficialToolId={null}
        errorMessage={null}
        t={t}
        onBack={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={onDisconnect}
        onApprovalChange={onApprovalChange}
      />,
    );
    expect(screen.getByText(t.sections.tools.active)).toBeVisible();
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: t.sections.tools.disconnect }));
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(screen.getByRole('checkbox', { name: t.sections.tools.approvalToggleLabel })).toBeDisabled();
  });
});

describe('markdown presentation', () => {
  it('renders GFM update summaries and delegates safe links to the caller', async () => {
    const onOpenExternalUrl = vi.fn();
    render(
      <ThemeProvider theme={buildAppTheme('light')}>
        <DesktopUpdateSummaryMarkdown
          content={'## Changes\n\n- Faster startup\n\n| Item | Status |\n| --- | --- |\n| Tests | Green |\n\n[Details](https://forger.ai/release)'}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      </ThemeProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Changes' })).toBeVisible();
    expect(screen.getByRole('cell', { name: 'Green' })).toBeVisible();
    await userEvent.click(screen.getByRole('link', { name: 'Details' }));
    expect(onOpenExternalUrl).toHaveBeenCalledWith('https://forger.ai/release');
  });

  it.each(['light', 'dark'] as const)('renders rich chat markdown using the %s theme', async (mode) => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'forger', {
      configurable: true,
      value: { openExternalUrl },
    });
    render(
      <ThemeProvider theme={buildAppTheme(mode)}>
        <MarkdownMessage content={'# Answer\n\n`code`\n\n> quote\n\n[Docs](https://forger.ai/docs)'} />
      </ThemeProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Answer' })).toBeVisible();
    expect(screen.getByText('code')).toBeVisible();
    await userEvent.click(screen.getByRole('link', { name: 'Docs' }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://forger.ai/docs');
  });
});
