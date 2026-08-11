import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentConversationHistoryDrawer } from '@renderer/views/AgentConversationHistoryDrawer';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { AgentConversationHistoryGroup } from '@renderer/views/AgentsView.helpers';
import type { PersonalAgentConversation } from '@shared/types';

const t = en as unknown as AppDictionary;

const conversation = (id: string, updatedAt = '2026-08-10T09:00:00.000Z'): PersonalAgentConversation => ({
  id,
  agentId: 'agent-1',
  title: `Conversation ${id}`,
  status: 'active',
  origin: 'user',
  readOnly: false,
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt,
  messages: [],
});

const groups: AgentConversationHistoryGroup[] = [
  {
    id: 'today',
    label: 'Today',
    items: Array.from({ length: 7 }, (_value, index) => conversation(`today-${index + 1}`)),
  },
  {
    id: 'older',
    label: 'Older',
    items: [conversation('older-1', 'invalid-date')],
  },
];

const renderHistory = ({
  historyGroups = groups,
  collapsedGroups = {},
  groupLimits = {},
  reserveTrafficLightSpace = false,
}: {
  historyGroups?: AgentConversationHistoryGroup[];
  collapsedGroups?: Record<string, boolean>;
  groupLimits?: Record<string, number>;
  reserveTrafficLightSpace?: boolean;
} = {}) => {
  const onClose = vi.fn();
  const onSelectConversation = vi.fn();
  const onToggleGroup = vi.fn();
  const onShowMore = vi.fn();
  const view = render(
    <AgentConversationHistoryDrawer
      t={t}
      open
      groups={historyGroups}
      selectedConversationId="today-1"
      collapsedGroups={collapsedGroups}
      groupLimits={groupLimits}
      reserveTrafficLightSpace={reserveTrafficLightSpace}
      onClose={onClose}
      onSelectConversation={onSelectConversation}
      onToggleGroup={onToggleGroup}
      onShowMore={onShowMore}
    />,
  );
  return { ...view, onClose, onSelectConversation, onToggleGroup, onShowMore };
};

describe('AgentConversationHistoryDrawer shell', () => {
  it('shows the empty state and closes the drawer', async () => {
    const user = userEvent.setup();
    const handlers = renderHistory({ historyGroups: [], reserveTrafficLightSpace: true });

    expect(screen.getByText(t.agents.historyEmpty)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(handlers.onClose).toHaveBeenCalledOnce();
    handlers.unmount();

    renderHistory({ historyGroups: [], reserveTrafficLightSpace: false });
    expect(screen.getByText(t.agents.historyEmpty)).toBeInTheDocument();
  });

  it('selects conversations, toggles groups, and expands the default page', async () => {
    const user = userEvent.setup();
    const handlers = renderHistory();

    await user.click(screen.getByText('Today'));
    expect(handlers.onToggleGroup).toHaveBeenCalledWith('today');

    await user.click(screen.getByText('Conversation today-1'));
    expect(handlers.onSelectConversation).toHaveBeenCalledWith(groups[0].items[0]);
    expect(screen.getByText('Conversation today-1').closest('.MuiListItemButton-root')).toHaveClass('Mui-selected');

    await user.click(screen.getByText(t.sections.chat.showMoreHistory));
    expect(handlers.onShowMore).toHaveBeenCalledWith('today', 15);
    expect(screen.queryByText('Conversation today-6')).not.toBeInTheDocument();
    expect(screen.getByText('Conversation older-1')).toBeInTheDocument();
  });

  it('honors custom limits, collapsed groups, and a list with no remaining items', () => {
    renderHistory({
      collapsedGroups: { older: true },
      groupLimits: { today: 7 },
      reserveTrafficLightSpace: true,
    });

    expect(screen.getByText('Conversation today-7')).toBeInTheDocument();
    expect(screen.queryByText(t.sections.chat.showMoreHistory)).not.toBeInTheDocument();
    expect(screen.queryByText('Conversation older-1')).not.toBeInTheDocument();
  });
});
