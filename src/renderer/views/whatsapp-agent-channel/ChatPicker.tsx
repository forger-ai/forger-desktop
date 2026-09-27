import { useState } from 'react';
import { Autocomplete, Box, TextField, Typography } from '@mui/material';
import { chatLabel, chatName, chatPhone, type ObservedChat } from './model';
import type { ChannelCopy } from './copy';

interface ChatPickerProps {
  choices: ObservedChat[];
  chatId: string;
  disabled: boolean;
  loading: boolean;
  error: string;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (chatId: string) => void;
  c: ChannelCopy;
}

/** Search changes labels and results, never the identity selected for access. */
export function ChatPicker({ choices, chatId, disabled, loading, error, search, onSearch, onSelect, c }: ChatPickerProps) {
  const [input, setInput] = useState('');
  return <Autocomplete
    fullWidth
    openText={c.openChats}
    closeText={c.close}
    clearText={c.clearChat}
    options={choices}
    value={choices.find((chat) => chat.chatId === chatId) ?? null}
    inputValue={input}
    disabled={disabled}
    loading={loading}
    loadingText={c.chatsLoading}
    noOptionsText={error || (search.trim() ? c.noMatches : c.noChats)}
    filterOptions={(options) => options}
    getOptionKey={(chat) => chat.chatId}
    getOptionLabel={chatLabel}
    isOptionEqualToValue={(option, value) => option.chatId === value.chatId}
    onInputChange={(_event, value, reason) => {
      // Result enrichment can replace the selected object while a query is in flight.
      if (reason === 'reset' && search) return;
      setInput(value);
      if (reason === 'input' || reason === 'clear') onSearch(value);
      if (reason === 'blur') onSearch('');
    }}
    onChange={(_event, chat) => {
      setInput(chat ? chatLabel(chat) : '');
      onSearch('');
      onSelect(chat?.chatId ?? '');
    }}
    renderOption={({ key, ...props }, chat) => <Box component="li" key={key} {...props}>
      <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        <Typography variant="body2">{chatName(chat)}</Typography>
        {chatPhone(chat) ? <Typography variant="caption" color="text.secondary">{chatPhone(chat)}</Typography> : null}
      </Box>
    </Box>}
    renderInput={(params) => <TextField {...params} label={c.chat} placeholder={c.search} />}
  />;
}
