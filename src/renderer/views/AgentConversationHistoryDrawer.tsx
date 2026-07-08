import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import {
  Box,
  Collapse,
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import type { PersonalAgentConversation } from '@shared/types';
import type { AgentConversationHistoryGroup } from './AgentsView.helpers';
import {
  formatRelativeHistoryTime,
  HISTORY_INITIAL_LIMIT,
  HISTORY_LIMIT_STEP,
} from './chat/history-drawer-helpers';

interface AgentConversationHistoryDrawerProps {
  t: AppDictionary;
  open: boolean;
  groups: AgentConversationHistoryGroup[];
  selectedConversationId?: string;
  collapsedGroups: Record<string, boolean>;
  groupLimits: Record<string, number>;
  reserveTrafficLightSpace: boolean;
  onClose: () => void;
  onSelectConversation: (conversation: PersonalAgentConversation) => void;
  onToggleGroup: (groupId: string) => void;
  onShowMore: (groupId: string, nextLimit: number) => void;
}

export function AgentConversationHistoryDrawer({
  t,
  open,
  groups,
  selectedConversationId,
  collapsedGroups,
  groupLimits,
  reserveTrafficLightSpace,
  onClose,
  onSelectConversation,
  onToggleGroup,
  onShowMore,
}: AgentConversationHistoryDrawerProps) {
  const theme = useTheme();
  return (
    <Drawer
      anchor="left"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: 360,
          maxWidth: '92vw',
          bgcolor: theme.palette.background.default,
          borderRight: `1px solid ${theme.palette.divider}`,
          WebkitAppRegion: 'no-drag',
        },
      }}
    >
      {groups.length === 0 ? (
        <Box sx={{ px: 2, pb: 2, pt: reserveTrafficLightSpace ? 6 : 2, WebkitAppRegion: 'no-drag' }}>
          <Typography variant="body2" color="text.secondary">
            {t.agents.historyEmpty}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ px: 1.25, pb: 1.5, pt: reserveTrafficLightSpace ? 5.25 : 1.25, WebkitAppRegion: 'no-drag' }}>
          <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {groups.map((group) => {
              const collapsed = collapsedGroups[group.id] === true;
              const visibleLimit = groupLimits[group.id] ?? HISTORY_INITIAL_LIMIT;
              const visibleItems = group.items.slice(0, visibleLimit);
              const remainingItems = group.items.length - visibleItems.length;

              return (
                <Box key={group.id}>
                  <ListItemButton
                    onClick={() => onToggleGroup(group.id)}
                    sx={{
                      minHeight: 32,
                      borderRadius: 1,
                      px: 0.75,
                      py: 0.25,
                      color: 'text.secondary',
                    }}
                  >
                    <Box sx={{ width: 24, display: 'flex', alignItems: 'center', color: 'text.secondary' }}>
                      {collapsed ? <ChevronRightRounded fontSize="small" /> : <ExpandMoreRounded fontSize="small" />}
                    </Box>
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{ flex: 1, minWidth: 0, fontWeight: 650, color: 'text.primary' }}
                    >
                      {group.label}
                    </Typography>
                  </ListItemButton>
                  <Collapse in={!collapsed} timeout="auto" unmountOnExit>
                    <List disablePadding sx={{ pl: 3.25, pr: 0.5 }}>
                      {visibleItems.map((item) => (
                        <ListItem key={item.id} disablePadding>
                          <ListItemButton
                            selected={item.id === selectedConversationId}
                            onClick={() => onSelectConversation(item)}
                            sx={{
                              minHeight: 34,
                              borderRadius: 1,
                              py: 0.25,
                              pl: 0.75,
                              pr: 0.75,
                              '&.Mui-selected': {
                                bgcolor: theme.palette.action.selected,
                              },
                            }}
                          >
                            <ListItemText
                              primary={
                                <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                                  <Typography
                                    variant="body2"
                                    noWrap
                                    sx={{ flex: 1, minWidth: 0, color: 'text.primary' }}
                                  >
                                    {item.title}
                                  </Typography>
                                  <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
                                    {formatRelativeHistoryTime(item.updatedAt, t.sections.chat.historyNow)}
                                  </Typography>
                                </Stack>
                              }
                              sx={{ m: 0 }}
                            />
                          </ListItemButton>
                        </ListItem>
                      ))}
                      {remainingItems > 0 ? (
                        <ListItem disablePadding>
                          <ListItemButton
                            onClick={() => onShowMore(group.id, visibleLimit + HISTORY_LIMIT_STEP)}
                            sx={{
                              minHeight: 32,
                              borderRadius: 1,
                              px: 0.75,
                              py: 0.25,
                              color: 'text.secondary',
                            }}
                          >
                            <Typography variant="body2">{t.sections.chat.showMoreHistory}</Typography>
                          </ListItemButton>
                        </ListItem>
                      ) : null}
                    </List>
                  </Collapse>
                </Box>
              );
            })}
          </List>
        </Box>
      )}
    </Drawer>
  );
}
