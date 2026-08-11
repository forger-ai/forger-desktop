import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunActivity } from '@shared/types';
import { en } from '@renderer/i18n/en';

import {
  AgentRunActivityReceipt,
  type AgentRunActivityReceiptActivity,
} from '@renderer/components/AgentRunActivityReceipt';

const counts = (total: number): AgentRunActivity['counts'] => ({
  total,
  mcpCalls: 0,
  fileReads: 0,
  fileWrites: 0,
  commands: 0,
  connectedServices: 0,
  permissions: 0,
  notes: 0,
  errors: 0,
});

const activity = (overrides: Partial<AgentRunActivity> = {}): AgentRunActivity => ({
  runId: 'run-1',
  surface: 'desktop_chat',
  status: 'completed',
  startedAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:01:00.000Z',
  finishedAt: '2026-08-10T10:01:00.000Z',
  durationMs: 60_000,
  summary: 'Finished the requested work.',
  items: [],
  counts: counts(0),
  redactions: [],
  ...overrides,
});

describe('AgentRunActivityReceipt', () => {
  it('shows an always-expanded live state with an empty and a custom thinking label', () => {
    const view = render(
      <AgentRunActivityReceipt
        t={en}
        status="running"
        emptyLabel="Preparing the workspace"
      />,
    );

    expect(screen.getByText('Preparing the workspace')).toBeVisible();
    expect(screen.getByRole('progressbar')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    view.rerender(<AgentRunActivityReceipt t={en} status="queued" />);
    expect(screen.getByText(en.sections.chat.agentThinking)).toBeVisible();
  });

  it('renders concrete live activity rows with their visible tones and ignores fallback progress', () => {
    render(
      <AgentRunActivityReceipt
        t={en}
        title="Live agent work"
        activity={activity({
          status: 'running',
          summary: 'Still running',
          durationMs: undefined,
          finishedAt: undefined,
          counts: counts(3),
          items: [
            { id: 'error', kind: 'error', summary: 'Command failed', createdAt: '2026-08-10T10:00:03.000Z' },
            { id: 'note', kind: 'assistant_note', summary: 'Trying another path', createdAt: '2026-08-10T10:00:02.000Z' },
            { id: 'read', kind: 'file_read', summary: 'Read plan.md', createdAt: '2026-08-10T10:00:01.000Z' },
          ],
        })}
        progressMessages={['This fallback must not be shown']}
      />,
    );

    expect(screen.getByText('Live agent work')).toBeVisible();
    expect(screen.getByText('Command failed')).toBeVisible();
    expect(screen.getByText('Trying another path')).toBeVisible();
    expect(screen.getByText(en.agentRunActivityReceipt.timelineKinds.file_read)).toBeVisible();
    expect(screen.queryByText('This fallback must not be shown')).not.toBeInTheDocument();
  });

  it('adapts legacy sections into ordered rows and toggles uncontrolled details', () => {
    const onExpandedChange = vi.fn();
    const legacy: AgentRunActivityReceiptActivity = {
      id: 'legacy-run',
      title: 'Legacy activity',
      status: 'completed',
      completedAt: '2026-08-10T10:02:00.000Z',
      sections: [{ items: [{ label: 'Ignored activity section' }] }],
    };

    render(
      <AgentRunActivityReceipt
        t={en}
        activity={legacy}
        defaultExpanded
        onExpandedChange={onExpandedChange}
        sections={[
          {
            title: 'Visible details',
            items: [
              { id: 'labeled', label: 'Read the project' },
              { label: '', value: 'Wrote the report' },
              { label: '', value: 12 },
              { label: '', value: true },
              { label: '', value: <strong>Hidden element</strong> },
              { label: '', value: { hidden: true } },
              { label: '', value: null },
              { label: '', value: '' },
            ],
          },
          { title: 'Empty section' },
        ]}
      />,
    );

    expect(screen.getByText('Legacy activity')).toBeVisible();
    expect(screen.getByText('Read the project')).toBeVisible();
    expect(screen.getByText('Wrote the report')).toBeVisible();
    expect(screen.getByText('12')).toBeVisible();
    expect(screen.getByText('true')).toBeVisible();
    expect(screen.queryByText('Ignored activity section')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden element')).not.toBeInTheDocument();

    const collapse = screen.getByRole('button', { name: en.agentRunActivityReceipt.collapse });
    fireEvent.click(collapse);
    expect(onExpandedChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: en.agentRunActivityReceipt.expand })).toHaveAttribute('aria-expanded', 'false');
  });

  it('supports controlled expansion and a concrete summary when there are no rows', () => {
    const onExpandedChange = vi.fn();
    const view = render(
      <AgentRunActivityReceipt
        t={en}
        activity={activity({ summary: 'A concise completed summary.' })}
        expanded
        onExpandedChange={onExpandedChange}
      />,
    );

    expect(screen.getByText('A concise completed summary.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: en.agentRunActivityReceipt.collapse }));
    expect(onExpandedChange).toHaveBeenCalledWith(false);

    view.rerender(
      <AgentRunActivityReceipt
        t={en}
        activity={activity({ summary: '' })}
        summary="Summary supplied by the caller"
        expanded
      />,
    );
    expect(screen.getByText('Summary supplied by the caller')).toBeVisible();
  });

  it('normalizes markdown exclusions and preserves unmatched progress rows', () => {
    const view = render(
      <AgentRunActivityReceipt
        t={en}
        mode="completed"
        defaultExpanded
        progressMessages={[
          { id: 'report', message: '## **Done** [report](https://example.test)', createdAt: '2026-08-10T10:00:02.000Z' },
          '> ![diagram](image.png) `Reviewed` ~files~',
          { message: 'Visible progress', createdAt: 'invalid' },
          '   ',
        ]}
        excludeText={['Done report', 'Reviewed files', ' ']}
      />,
    );

    expect(screen.getByText('Visible progress')).toBeVisible();
    expect(screen.queryByText(/Done/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reviewed/)).not.toBeInTheDocument();

    view.rerender(
      <AgentRunActivityReceipt
        t={en}
        mode="completed"
        expanded
        summary="Only the summary remains"
        progressMessages={['**Hide me**']}
        excludeText="Hide me"
      />,
    );
    expect(screen.getByText('Only the summary remains')).toBeVisible();
  });

  it('falls back from empty legacy sections to activity summaries and omits empty receipts', () => {
    const view = render(
      <AgentRunActivityReceipt
        t={en}
        activity={{ id: 'legacy-summary', status: 'completed', summary: 'Legacy summary', sections: [{ title: 'Empty' }] }}
        defaultExpanded
      />,
    );
    expect(screen.getByText('Legacy summary')).toBeVisible();

    view.rerender(
      <AgentRunActivityReceipt
        t={en}
        activity={{ status: 'completed', summary: 'Summary without an id' }}
        defaultExpanded
      />,
    );
    expect(screen.getByText('Summary without an id')).toBeVisible();

    view.rerender(<AgentRunActivityReceipt t={en} activity={{ status: 'completed' }} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
