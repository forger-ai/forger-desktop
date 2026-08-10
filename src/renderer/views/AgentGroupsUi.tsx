import type { Dispatch, ReactNode, SetStateAction } from 'react';
import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import GroupWorkRounded from '@mui/icons-material/GroupWorkRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import type { PersonalAgent, PersonalAgentGroup } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { AccessDraft } from './AgentsView.helpers';

export interface AgentDisplaySection {
  id: string;
  label: string;
  agents: PersonalAgent[];
}

interface AgentGroupSelectProps {
  draft: AccessDraft;
  groups: PersonalAgentGroup[];
  id: string;
  setDraft: Dispatch<SetStateAction<AccessDraft>>;
  t: AppDictionary;
}

export function AgentGroupSelect({ draft, groups, id, setDraft, t }: AgentGroupSelectProps) {
  return (
    <FormControl size="small" fullWidth>
      <InputLabel id={`${id}-label`}>{t.agents.group}</InputLabel>
      <Select
        labelId={`${id}-label`}
        id={id}
        label={t.agents.group}
        value={draft.groupId ?? ''}
        onChange={(event) => setDraft((current) => ({ ...current, groupId: event.target.value || null }))}
      >
        <MenuItem value="">{t.agents.noGroup}</MenuItem>
        {groups.map((group) => <MenuItem key={group.id} value={group.id}>{group.name}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

interface AgentIdentityChipsProps {
  agent: PersonalAgent;
  agents: PersonalAgent[];
  groups: PersonalAgentGroup[];
  t: AppDictionary;
}

export function AgentIdentityChips({ agent, agents, groups, t }: AgentIdentityChipsProps) {
  const creatorName = agent.createdByAgentId
    ? agents.find((candidate) => candidate.id === agent.createdByAgentId)?.name ?? agent.createdByAgentId
    : null;
  return (
    <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 0.75 }}>
      {agent.groupId ? <Chip size="small" icon={<GroupWorkRounded />} label={groups.find((group) => group.id === agent.groupId)?.name ?? t.agents.noGroup} /> : null}
      {creatorName ? <Chip size="small" variant="outlined" color="primary" label={t.agents.createdBy(creatorName)} /> : null}
    </Stack>
  );
}

interface AgentCreateDialogProps {
  accessControls: ReactNode;
  busy: boolean;
  description: string;
  draft: AccessDraft;
  groups: PersonalAgentGroup[];
  name: string;
  onClose: () => void;
  onCreate: () => void;
  onDescriptionChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onPurposeChange: (value: string) => void;
  open: boolean;
  purpose: string;
  setDraft: Dispatch<SetStateAction<AccessDraft>>;
  t: AppDictionary;
}

export function AgentCreateDialog({ accessControls, busy, description, draft, groups, name, onClose, onCreate, onDescriptionChange, onNameChange, onPurposeChange, open, purpose, setDraft, t }: AgentCreateDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t.agents.createTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField size="small" label={t.agents.name} value={name} onChange={(event) => onNameChange(event.target.value)} />
          <TextField size="small" label={t.agents.description} value={description} onChange={(event) => onDescriptionChange(event.target.value)} />
          <TextField size="small" multiline minRows={4} label={t.agents.purpose} value={purpose} onChange={(event) => onPurposeChange(event.target.value)} />
          <AgentGroupSelect draft={draft} groups={groups} id="personal-agent-create-group" setDraft={setDraft} t={t} />
          <Divider />
          {accessControls}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t.actions.close}</Button>
        <Button startIcon={<AddRounded />} variant="contained" disabled={!name.trim() || busy} onClick={onCreate}>{t.agents.create}</Button>
      </DialogActions>
    </Dialog>
  );
}

interface AgentsOverviewProps {
  agents: PersonalAgent[];
  busy: boolean;
  createdByLabel: (agent: PersonalAgent) => string | null;
  error: string | null;
  manageGroupsLabel: string;
  onCreate: () => void;
  onDelete: (agent: PersonalAgent) => void;
  onManageGroups: () => void;
  onOpen: (agent: PersonalAgent) => void;
  renderAccessChips: (agent: PersonalAgent) => ReactNode;
  sections: AgentDisplaySection[];
  t: AppDictionary;
}

export function AgentsOverview({ agents, busy, createdByLabel, error, manageGroupsLabel, onCreate, onDelete, onManageGroups, onOpen, renderAccessChips, sections, t }: AgentsOverviewProps) {
  const theme = useTheme();
  return (
    <Stack spacing={2.25} sx={{ height: '100%', minHeight: 0 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h4">{t.agents.title}</Typography>
          <Typography color="text.secondary">{t.agents.subtitle}</Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button startIcon={<GroupWorkRounded />} variant="outlined" onClick={onManageGroups}>{manageGroupsLabel}</Button>
          <Button startIcon={<AddRounded />} variant="contained" onClick={onCreate}>{t.agents.create}</Button>
        </Stack>
      </Stack>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {agents.length === 0 ? (
        <Box sx={{ border: `1px dashed ${theme.palette.divider}`, borderRadius: 1, p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">{t.agents.empty}</Typography>
        </Box>
      ) : (
        <Stack spacing={2.5} sx={{ minHeight: 0, overflow: 'auto', pr: 0.5, pb: 1 }}>
          {sections.map((section) => (
            <Box key={section.id}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <GroupWorkRounded color="action" fontSize="small" />
                <Typography variant="subtitle2" fontWeight={700}>{section.label}</Typography>
                <Chip size="small" label={section.agents.length} sx={{ height: 20 }} />
              </Stack>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
                {section.agents.map((agent) => (
                  <Card key={agent.id} variant="outlined" sx={{ borderRadius: 1, height: '100%', position: 'relative' }}>
                    <CardActionArea onClick={() => onOpen(agent)} sx={{ alignItems: 'stretch', height: '100%' }}>
                      <CardContent sx={{ p: 1.75, '&:last-child': { pb: 1.75 } }}>
                        <Stack spacing={1.25}>
                          <Box sx={{ minWidth: 0, pr: 4 }}>
                            <Typography variant="subtitle1" fontWeight={700}>{agent.name}</Typography>
                            <Typography variant="body2" color="text.secondary">{agent.description || t.agents.noDescription}</Typography>
                          </Box>
                          {createdByLabel(agent) ? <Chip size="small" variant="outlined" color="primary" label={createdByLabel(agent)} sx={{ alignSelf: 'flex-start' }} /> : null}
                          {renderAccessChips(agent)}
                        </Stack>
                      </CardContent>
                    </CardActionArea>
                    <Tooltip title={t.agents.delete}>
                      <IconButton
                        size="small"
                        disabled={busy}
                        onClick={() => onDelete(agent)}
                        sx={{ position: 'absolute', top: 10, right: 10, zIndex: 1 }}
                      >
                        <DeleteOutlineRounded fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Card>
                ))}
              </Box>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

interface AgentGroupsDialogProps {
  agents: PersonalAgent[];
  busy: boolean;
  editingGroupId: string | null;
  error: string | null;
  groupName: string;
  groups: PersonalAgentGroup[];
  onClose: () => void;
  onDelete: (group: PersonalAgentGroup) => void;
  onEdit: (group: PersonalAgentGroup) => void;
  onGroupNameChange: (name: string) => void;
  onSave: () => void;
  open: boolean;
  t: AppDictionary;
}

export function AgentGroupsDialog({ agents, busy, editingGroupId, error, groupName, groups, onClose, onDelete, onEdit, onGroupNameChange, onSave, open, t }: AgentGroupsDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t.agents.groupsTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <Typography variant="body2" color="text.secondary">{t.agents.groupsSubtitle}</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
            <TextField
              size="small"
              fullWidth
              autoFocus
              label={editingGroupId ? t.agents.renameGroup : t.agents.groupName}
              value={groupName}
              onChange={(event) => onGroupNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSave();
                }
              }}
            />
            <Button variant="contained" startIcon={editingGroupId ? <SaveRounded /> : <AddRounded />} disabled={!groupName.trim() || busy} onClick={onSave} sx={{ whiteSpace: 'nowrap' }}>
              {editingGroupId ? t.agents.saveGroup : t.agents.createGroup}
            </Button>
          </Stack>
          {groups.length > 0 ? (
            <Stack spacing={1}>
              {groups.map((group) => (
                <Paper key={group.id} variant="outlined" sx={{ px: 1.5, py: 1, borderRadius: 1 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <GroupWorkRounded color="action" fontSize="small" />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={700} noWrap>{group.name}</Typography>
                      <Typography variant="caption" color="text.secondary">{t.agents.agentsCount(agents.filter((agent) => agent.groupId === group.id).length)}</Typography>
                    </Box>
                    <Tooltip title={t.agents.renameGroup}><IconButton size="small" onClick={() => onEdit(group)}><EditRounded fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title={t.agents.deleteGroup}><IconButton size="small" disabled={busy} onClick={() => onDelete(group)}><DeleteOutlineRounded fontSize="small" /></IconButton></Tooltip>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          ) : <Typography variant="body2" color="text.secondary">{t.agents.groupsEmpty}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>{t.actions.close}</Button></DialogActions>
    </Dialog>
  );
}
