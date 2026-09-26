import { isWhatsAppChannelToolSupported } from '@shared/whatsapp-channel-tool-support';
import { useEffect, useRef, useState } from 'react';
import { Alert, Autocomplete, Button, Checkbox, Chip, CircularProgress, FormControlLabel, Stack, TextField, Typography } from '@mui/material';
import type { PersonalAgentGrantOptions, PersonalAgentWhatsAppChannelPolicy, WhatsAppAgentPolicyOptions } from '@shared/types';

export function PolicyEditor({ agentId, value, onChange, disabled, english }: { agentId: string; value: PersonalAgentWhatsAppChannelPolicy; onChange: (value: PersonalAgentWhatsAppChannelPolicy) => void; disabled: boolean; english: boolean }) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [options, setOptions] = useState<WhatsAppAgentPolicyOptions | null>(null);
  const [grants, setGrants] = useState<PersonalAgentGrantOptions | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    let current = true;
    setOptions(null); setError(false);
    Promise.all([window.forger.personalAgentWhatsAppPolicyOptionsGet({ agentId }), window.forger.personalAgentGrantOptionsList()])
      .then(([policyOptions, grantOptions]) => { if (current) { setOptions(policyOptions); setGrants(grantOptions); } })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [agentId, refresh]);
  const label = (en: string, es: string) => english ? en : es;
  const chooseFiles = async () => {
    setPicking(true);
    try {
      const selected = await window.forger.filesPickForChat();
      if (!active.current || !selected.length) return;
      const imported = await window.forger.filesImport({ grantIds: selected.map((file) => file.grantId) });
      if (!active.current) return;
      onChange({ ...value, sharedFiles: [...(value.sharedFiles ?? []), ...imported.map((file) => ({ id: file.id, path: file.relativePath, relativePath: file.relativePath, name: file.name, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, source: 'attached' as const }))] });
    } catch { if (active.current) setError(true); } finally { if (active.current) setPicking(false); }
  };
  const select = (title: string, choices: { id: string; name: string }[], selected: string[], change: (ids: string[]) => void) => <Autocomplete multiple options={choices} value={choices.filter((option) => selected.includes(option.id))} getOptionLabel={(option) => option.name} disabled={disabled} onChange={(_event, next) => change(next.map((option) => option.id))} renderInput={(params) => <TextField {...params} label={title} />} />;
  return <Stack spacing={1.5}>
    <Typography variant="subtitle2">{label('Shared information and allowed actions', 'Información compartida y acciones permitidas')}</Typography>
    <Alert severity="info">{label('Only the selections below are shared. Private memories and files stay private unless selected. All chat members can see the agent’s replies.', 'Solo se comparte lo seleccionado abajo. Las memorias y archivos privados no se comparten sin seleccionarlos. Todos en el chat pueden ver las respuestas.')}</Alert>
    <Typography variant="body2" color="text.secondary">{label('External access depends on the selected connections and actions. Sharing apps, connections, or other agents also shares the information those actions can access. WhatsApp connection actions may access other chats in the selected account.', 'El acceso externo depende de las conexiones y acciones seleccionadas. Compartir apps, conexiones u otros agentes también permite acceder a la información disponible mediante esas acciones. Las acciones de la conexión WhatsApp pueden acceder a otros chats de la cuenta seleccionada.')}</Typography>
    {error ? <Alert severity="error" action={<Button onClick={() => setRefresh((n) => n + 1)}>{label('Retry', 'Reintentar')}</Button>}>{label('Could not load or share information.', 'No pude cargar o compartir información.')}</Alert> : null}
    {!options && !error ? <CircularProgress size={18} /> : null}
    {options && grants ? <>
      {select(label('Allowed apps', 'Apps permitidas'), grants.apps.filter((app) => options.agent.appIds.includes(app.appId)).map((app) => ({ id: app.appId, name: app.name })), value.appIds, (appIds) => onChange({ ...value, appIds }))}
      {select(label('Allowed tool actions', 'Acciones de herramientas permitidas'), grants.tools.flatMap((tool) => tool.actions.filter((action) => options.agent.toolIds.includes(action.id) && isWhatsAppChannelToolSupported(action.id)).map((action) => ({ id: action.id, name: `${tool.name} · ${action.name}` }))), value.toolIds, (toolIds) => onChange({ ...value, toolIds: toolIds as PersonalAgentWhatsAppChannelPolicy['toolIds'] }))}
      {options.agent.connectionGrants.map((grant) => <Stack key={grant.type} spacing={0.5}>
        <Typography variant="body2">{grants.connections.find((item) => item.type === grant.type)?.displayName ?? grant.type}</Typography>
        <Typography variant="caption" color="text.secondary">{label('These actions use the accounts already authorized in the agent settings.', 'Estas acciones usan las cuentas ya autorizadas en los ajustes del agente.')}</Typography>
        {grant.actions.map((action) => <FormControlLabel key={action} label={grants.connections.find((item) => item.type === grant.type)?.actions.find((item) => item.id === action)?.name ?? action} control={<Checkbox disabled={disabled} checked={value.connectionGrants.some((item) => item.type === grant.type && item.actions.includes(action))} onChange={(_event, checked) => {
          const current = value.connectionGrants.find((item) => item.type === grant.type);
          const selected = current?.actions ?? [];
          const actions = checked ? [...selected, action] : selected.filter((id) => id !== action);
          onChange({ ...value, connectionGrants: [...value.connectionGrants.filter((item) => item.type !== grant.type), ...(actions.length ? [{ ...grant, actions }] : [])] });
        }} />} />)}
      </Stack>)}
      {select(label('Allowed agents', 'Agentes permitidos'), grants.peerAgents.filter((peer) => options.agent.peerAgentGrants.some((grant) => grant.agentId === peer.agentId)).map((peer) => ({ id: peer.agentId, name: peer.name })), value.peerAgentIds, (peerAgentIds) => onChange({ ...value, peerAgentIds }))}
      {select(label('Memories shared with this chat', 'Memorias compartidas con este chat'), options.memories.map((memory) => ({ id: memory.id, name: `${memory.title}: ${memory.content}` })), value.sharedMemoryIds, (sharedMemoryIds) => onChange({ ...value, sharedMemoryIds }))}
    </> : null}
    <Button disabled={disabled || picking} onClick={() => void chooseFiles()}>{label('Choose files to share with this chat', 'Elegir archivos para compartir con este chat')}</Button>
    <Stack direction="row" spacing={1} flexWrap="wrap">{(value.sharedFiles ?? []).map((file) => <Chip key={file.id} label={file.name} disabled={disabled} onDelete={() => onChange({ ...value, sharedFiles: value.sharedFiles?.filter((entry) => entry.id !== file.id) })} />)}</Stack>
  </Stack>;
}
