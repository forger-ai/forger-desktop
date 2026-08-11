import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PersonalAgentGrantOptions } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import {
  ANTIGRAVITY_MODEL_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
} from '@renderer/preferences';
import { AgentAccessControls } from '@renderer/views/AgentAccessControls';
import { defaultAccessDraft, type AccessDraft } from '@renderer/views/AgentsView.helpers';

const t = getDictionary('en');
const providerOptions = [
  { value: 'auto' as const, label: 'Automatic' },
  { value: 'codex' as const, label: 'Codex' },
  { value: 'claude' as const, label: 'Claude' },
  { value: 'antigravity' as const, label: 'Antigravity' },
];

const emptyOptions: PersonalAgentGrantOptions = {
  apps: [], tools: [], connections: [], peerAgents: [],
};

const grantOptions = {
  apps: [
    { appId: 'installed-app', name: 'Installed app', description: 'Ready app', status: 'installed' },
    { appId: 'running-app', name: 'Running app', status: 'running' },
    { appId: 'installing-app', name: 'Installing app', status: 'installing' },
    { appId: 'error-app', name: 'Error app', status: 'error' },
    { appId: 'conflict-app', name: 'Conflict app', status: 'conflict' },
    { appId: 'available-app', name: '', status: 'not_installed' },
    { appId: 'unknown-app', name: 'Unknown app' },
  ],
  tools: [
    {
      id: 'calendar', name: 'Calendar', description: 'Calendar tool', configured: true, status: 'connected',
      actions: [
        { id: 'calendar.events.list', toolId: 'calendar', name: 'List events', description: '', risk: 'read' },
        { id: 'calendar.events.create', toolId: 'calendar', name: 'Create event', description: '', risk: 'write' },
      ],
    },
    {
      id: 'mail', name: 'Mail', description: 'Mail tool', configured: false, status: 'disconnected',
      actions: [{ id: 'mail.send', toolId: 'mail', name: 'Send mail', description: '', risk: 'write' }],
    },
    { id: 'empty', name: 'Empty tool', description: '', configured: true, status: 'connected', actions: [] },
  ],
  connections: [
    {
      type: 'github', displayName: 'GitHub', description: '', configured: true, supportsMultiple: true,
      definition: {},
      instances: [
        { id: 'gh-email', type: 'github', label: 'Work', accountIdentity: { email: 'dev@example.com' } },
        { id: 'gh-user', type: 'github', accountIdentity: { username: 'octocat' } },
        { id: 'gh-workspace', type: 'github', accountIdentity: { workspace: 'Acme' } },
        { id: 'gh-phone', type: 'github', accountIdentity: { phoneNumber: '+123' } },
        { id: 'gh-label', type: 'github', label: 'Fallback label' },
        { id: 'gh-id', type: 'github' },
      ],
      actions: [
        { id: 'github.issues.list', name: 'List issues' },
        { id: 'github.issues.create', name: 'Create issue' },
      ],
    },
    {
      type: 'slack', displayName: 'Slack', description: '', configured: false, supportsMultiple: false,
      definition: {}, instances: [{ id: 'slack-one', type: 'slack' }],
      actions: [{ id: 'slack.messages.send', name: 'Send message' }],
    },
    {
      type: 'empty', displayName: 'Empty connection', description: '', configured: true, supportsMultiple: false,
      definition: {}, instances: [], actions: [],
    },
  ],
  peerAgents: [
    { agentId: 'active-agent', name: 'Current agent' },
    { agentId: 'peer-one', name: 'Researcher', description: 'Finds sources' },
    { agentId: 'peer-two', name: 'Writer' },
  ],
} as unknown as PersonalAgentGrantOptions;

const renderControls = ({
  initial = defaultAccessDraft(),
  options = grantOptions,
  activeAgentId = 'active-agent',
}: {
  initial?: AccessDraft;
  options?: PersonalAgentGrantOptions;
  activeAgentId?: string | null;
} = {}) => {
  const changes = vi.fn();
  const Harness = () => {
    const [draft, setDraft] = useState(initial);
    return (
      <>
        <AgentAccessControls
          activeAgentId={activeAgentId}
          draft={draft}
          grantOptions={options}
          providerOptions={providerOptions}
          setDraft={(updater) => {
            setDraft((current) => {
              const next = typeof updater === 'function' ? updater(current) : updater;
              changes(next);
              return next;
            });
          }}
          t={t}
        />
        <output data-testid="draft">{JSON.stringify(draft)}</output>
      </>
    );
  };
  render(<Harness />);
  return changes;
};

const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
  await user.click(screen.getByLabelText(label));
  await user.click(screen.getByRole('option', { name: option }));
};

describe('AgentAccessControls', () => {
  it('edits provider, model, effort, permission mode, and capability switches', async () => {
    const user = userEvent.setup();
    const initial = defaultAccessDraft();
    initial.runtime = { provider: 'codex', model: 'unknown-model', effort: 'ultra' };
    const changes = renderControls({ initial, options: emptyOptions, activeAgentId: null });

    expect(screen.queryByRole('option', { name: 'Automatic' })).not.toBeInTheDocument();
    expect(screen.getByText(t.agents.noAppsAvailable)).toBeVisible();
    expect(screen.getByText(t.agents.noToolsAvailable)).toBeVisible();
    expect(screen.getByText(t.agents.noConnectionsAvailable)).toBeVisible();
    expect(screen.getByText(t.agents.noPeerAgentsAvailable)).toBeVisible();

    await choose(user, t.agents.runtimeProvider, 'Claude');
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ provider: 'claude' }),
    }));
    await choose(user, t.agents.runtimeModel, CLAUDE_MODEL_OPTIONS.at(-1)!.displayModelName);
    const effortSelect = screen.getByLabelText(t.agents.runtimeEffort);
    const currentEffort = effortSelect.textContent;
    await user.click(effortSelect);
    const nextEffort = screen.getAllByRole('option').find((option) => option.textContent !== currentEffort)!;
    await user.click(nextEffort);
    await choose(user, t.agents.permissionLevel, t.agents.expandedPermission);
    await choose(user, t.agents.permissionLevel, t.agents.standardPermission);
    await choose(user, t.agents.permissionLevel, t.agents.expandedPermission);
    await user.click(screen.getByRole('switch', { name: t.agents.internetAccess }));
    await user.click(screen.getByRole('switch', { name: new RegExp(t.agents.canSpawnAgents) }));
    expect(screen.getByTestId('draft')).toHaveTextContent('"permissionMode":"unsafe"');
    expect(screen.getByTestId('draft')).toHaveTextContent('"networkAccess":true');
    expect(screen.getByTestId('draft')).toHaveTextContent('"canSpawnAgents":true');
  });

  it('renders Antigravity choices and every app state while toggling app access', async () => {
    const user = userEvent.setup();
    const initial = defaultAccessDraft();
    initial.runtime = {
      provider: 'antigravity',
      model: ANTIGRAVITY_MODEL_OPTIONS[0].realModelName,
      effort: ANTIGRAVITY_MODEL_OPTIONS[0].defaultReasoningEffort,
    };
    initial.appIds = ['installed-app'];
    const changes = renderControls({ initial });

    expect(screen.getByLabelText(t.agents.runtimeModel)).toHaveTextContent(ANTIGRAVITY_MODEL_OPTIONS[0].displayModelName);
    for (const label of [
      t.actions.installed, t.actions.running, t.actions.installing, t.actions.error,
      t.actions.conflict, t.actions.available,
    ]) expect(screen.getAllByText(label, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText('unknown-app', { exact: false })).toBeVisible();

    await user.click(screen.getByRole('checkbox', { name: /Installed app/ }));
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ appIds: [] }));
    await user.click(screen.getByRole('checkbox', { name: /Running app/ }));
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ appIds: ['running-app'] }));
  });

  it('grants all, partial, and individual tool actions including unconfigured tools', async () => {
    const user = userEvent.setup();
    const initial = defaultAccessDraft();
    initial.toolIds = ['calendar.events.list'];
    const changes = renderControls({ initial });

    const calendarSummary = screen.getByText('Calendar').closest('.MuiAccordionSummary-root') as HTMLElement;
    const calendarToggle = within(calendarSummary).getByRole('checkbox', { name: 'Calendar' });
    expect(calendarToggle).toHaveAttribute('data-indeterminate', 'true');
    await user.click(calendarToggle);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({
      toolIds: ['calendar.events.list', 'calendar.events.create'],
    }));
    await user.click(calendarToggle);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ toolIds: [] }));
    await user.click(calendarSummary);
    await user.click(screen.getByRole('checkbox', { name: 'List events' }));
    await user.click(screen.getByRole('checkbox', { name: 'Create event' }));
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({
      toolIds: ['calendar.events.list', 'calendar.events.create'],
    }));

    const mailSummary = screen.getByText('Mail').closest('.MuiAccordionSummary-root') as HTMLElement;
    expect(within(mailSummary).getByRole('checkbox', { name: 'Mail' })).toBeDisabled();
    await user.click(mailSummary);
    expect(screen.getByRole('checkbox', { name: 'Send mail' })).toBeDisabled();
    const emptySummary = screen.getByText('Empty tool').closest('.MuiAccordionSummary-root') as HTMLElement;
    expect(within(emptySummary).getByRole('checkbox', { name: 'Empty tool' })).toBeDisabled();
  });

  it('manages connection actions, instance scopes, and peer-agent criteria', async () => {
    const user = userEvent.setup();
    const initial = defaultAccessDraft();
    initial.connectionGrants = [{
      type: 'github', actions: ['github.issues.list'], multiple: true,
      connectionIds: ['gh-email', 'missing-instance'],
    }];
    initial.peerAgentGrants = [
      { agentId: 'active-agent', name: 'Current agent', criteria: 'Internal' },
      { agentId: 'peer-one', name: 'Researcher', description: 'Finds sources', criteria: 'Only research' },
    ];
    const changes = renderControls({ initial });

    expect(screen.queryByText('Current agent')).not.toBeInTheDocument();
    const githubSummary = screen.getByText('GitHub').closest('.MuiAccordionSummary-root') as HTMLElement;
    const githubToggle = within(githubSummary).getByRole('checkbox', { name: 'GitHub' });
    expect(githubToggle).toHaveAttribute('data-indeterminate', 'true');
    await user.click(githubSummary);
    expect(screen.getByLabelText(t.agents.connectionInstances)).toHaveTextContent('dev@example.com, missing-instance');
    await user.click(screen.getByRole('checkbox', { name: 'Create issue' }));
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({
      connectionGrants: [expect.objectContaining({ actions: ['github.issues.list', 'github.issues.create'] })],
    }));
    await user.click(screen.getByRole('checkbox', { name: 'List issues' }));
    await user.click(screen.getByRole('checkbox', { name: 'Create issue' }));
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ connectionGrants: [] }));

    await user.click(githubToggle);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({
      connectionGrants: [expect.objectContaining({ type: 'github' })],
    }));
    await user.click(githubToggle);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ connectionGrants: [] }));

    const slackSummary = screen.getByText('Slack').closest('.MuiAccordionSummary-root') as HTMLElement;
    expect(within(slackSummary).getByRole('checkbox', { name: 'Slack' })).toBeDisabled();
    await user.click(slackSummary);
    expect(screen.getByRole('checkbox', { name: 'Send message' })).toBeDisabled();

    const researcher = screen.getByRole('checkbox', { name: 'Researcher' });
    const criteria = screen.getByLabelText(t.agents.usageCriteria);
    await user.clear(criteria);
    await user.type(criteria, 'Only verified sources');
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({
      peerAgentGrants: expect.arrayContaining([expect.objectContaining({ criteria: 'Only verified sources' })]),
    }));
    await user.click(researcher);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({
      peerAgentGrants: [expect.objectContaining({ agentId: 'active-agent' })],
    }));
    await user.click(screen.getByRole('checkbox', { name: 'Writer' }));
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({
      peerAgentGrants: expect.arrayContaining([expect.objectContaining({ agentId: 'peer-two', criteria: '' })]),
    }));
  });

  it('selects multiple instances and renders every identity fallback', async () => {
    const user = userEvent.setup();
    const initial = defaultAccessDraft();
    initial.connectionGrants = [{ type: 'github', actions: ['github.issues.list'], multiple: true }];
    const changes = renderControls({ initial });
    await user.click(screen.getByText('GitHub').closest('.MuiAccordionSummary-root') as HTMLElement);
    const select = screen.getByLabelText(t.agents.connectionInstances);
    expect(select).toHaveTextContent(t.agents.connectionAllInstances);
    await user.click(select);
    for (const instance of ['octocat', 'Acme', '+123', 'Fallback label', 'gh-id']) {
      await user.click(screen.getByRole('option', { name: instance }));
    }
    await user.keyboard('{Escape}');
    expect(changes).toHaveBeenCalled();
    expect(select).toHaveTextContent('octocat, Acme, +123, Fallback label, gh-id');
  });
});
