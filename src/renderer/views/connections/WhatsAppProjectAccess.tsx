import { useState } from 'react';
import { Button, Checkbox, FormControlLabel, Paper, Stack, Typography } from '@mui/material';
import type { RepositoryCollaborationCopy } from '@renderer/i18n/locales/repositoryCollaboration';
import type { RepositoryCollaborationChatParticipant, RepositoryCollaborationRepository, SetRepositoryCollaborationAccessInput } from '@shared/types/repository-collaboration';

export function WhatsAppProjectAccess({ participant, repositoryIds, repositories, groupId, copy, busy, canGrant, onSave }: {
  participant: RepositoryCollaborationChatParticipant;
  repositoryIds: string[];
  repositories: RepositoryCollaborationRepository[];
  groupId: string;
  copy: RepositoryCollaborationCopy;
  busy: boolean;
  canGrant: boolean;
  onSave: (input: SetRepositoryCollaborationAccessInput) => void;
}) {
  const [selection, setSelection] = useState(repositoryIds);
  return <Paper component="fieldset" variant="outlined" sx={{ p: 1.5, minWidth: 0, m: 0 }}>
    <Typography component="legend" fontWeight={700}>{participant.displayName}</Typography>
    <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{participant.participantId}</Typography>
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      {repositories.map((repository) => <FormControlLabel key={repository.id} label={repository.name} control={<Checkbox size="small" disabled={busy || !canGrant} checked={selection.includes(repository.id)} onChange={(_, checked) => setSelection((current) => checked ? [...current, repository.id] : current.filter((id) => id !== repository.id))} />} />)}
    </Stack>
    <Stack direction="row" spacing={1}>
      <Button size="small" disabled={busy || !canGrant} aria-label={copy.saveAccessLabel(participant.displayName)} onClick={() => onSave({ groupId, participantId: participant.participantId, displayName: participant.displayName, repositoryIds: selection })}>{copy.saveAccess}</Button>
      {repositoryIds.length > 0 ? <Button size="small" color="error" disabled={busy} aria-label={copy.revokeAccessLabel(participant.displayName)} onClick={() => onSave({ groupId, participantId: participant.participantId, displayName: participant.displayName, repositoryIds: [] })}>{copy.revokeAccess}</Button> : null}
    </Stack>
  </Paper>;
}
