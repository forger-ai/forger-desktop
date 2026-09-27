import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ChatPicker } from '@renderer/views/whatsapp-agent-channel/ChatPicker';
import { copy } from '@renderer/views/whatsapp-agent-channel/copy';
import { chatLabel, type ObservedChat } from '@renderer/views/whatsapp-agent-channel/model';

const person: ObservedChat = { chatId: 'person', chatType: 'direct', contactName: 'Ana', title: 'Nickname', phoneNumber: '+56 9 1234 5678' };
function Harness({ choices = [person], loading = false, error = '' }: { choices?: ObservedChat[]; loading?: boolean; error?: string }) {
  const [chatId, setChatId] = useState('');
  const [search, setSearch] = useState('');
  return <><ChatPicker choices={choices} chatId={chatId} disabled={false} loading={loading} error={error} search={search} onSearch={setSearch} onSelect={setChatId} c={copy.en} /><output data-testid="identity">{chatId}</output><output data-testid="query">{search}</output></>;
}

describe('WhatsApp searchable chat picker', () => {
  it('keeps a typed query when results refresh, restores selection on blur and clears deliberately', async () => {
    const user = userEvent.setup(); const view = render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Chat' });
    await user.click(input);
    await user.click(screen.getByRole('option', { name: 'Ana +56 9 1234 5678' }));
    expect(screen.getByTestId('identity')).toHaveTextContent('person');
    fireEvent.change(input, { target: { value: 'Another contact' } });
    expect(screen.getByTestId('query')).toHaveTextContent('Another contact');
    view.rerender(<Harness choices={[{ ...person, contactName: 'Ana Actualizada' }]} />);
    expect(input).toHaveValue('Another contact');
    await user.tab();
    expect(input).toHaveValue('Ana Actualizada · +56 9 1234 5678');
    expect(screen.getByTestId('query')).toBeEmptyDOMElement();
    await user.click(input);
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(input).toHaveValue('');
    expect(screen.getByTestId('identity')).toBeEmptyDOMElement();
  });

  it('offers loading, empty search and unavailable states inside the dropdown', async () => {
    const user = userEvent.setup(); const view = render(<Harness choices={[]} loading />);
    const input = screen.getByRole('combobox', { name: 'Chat' });
    await user.click(input);
    expect(screen.getByText('Loading conversations…')).toBeVisible();
    view.rerender(<Harness choices={[]} />);
    expect(screen.getByText(copy.en.noChats)).toBeVisible();
    await user.type(input, 'Ana');
    expect(screen.getByText(copy.en.noMatches)).toBeVisible();
    view.rerender(<Harness choices={[]} error={copy.en.chatsFailed} />);
    expect(screen.getByText(copy.en.chatsFailed)).toBeVisible();
  });

  it('uses trusted labels with a phone fallback and never treats a group identifier as a phone', () => {
    expect(chatLabel(person)).toBe('Ana · +56 9 1234 5678');
    expect(chatLabel({ chatId: 'one', chatType: 'direct', contactName: ' ', title: 'Nick' })).toBe('Nick');
    expect(chatLabel({ chatId: 'one', chatType: 'direct', phoneNumber: '+1234' })).toBe('+1234');
    expect(chatLabel({ chatId: 'one', chatType: 'direct' })).toBe('one');
    expect(chatLabel({ chatId: 'group@g.us', chatType: 'group', phoneNumber: '123' })).toBe('group@g.us');
    expect(chatLabel({ chatId: 'group@g.us', chatType: 'group', title: 'Team', contactName: 'Ignore', phoneNumber: '123' })).toBe('Team');
  });
});
