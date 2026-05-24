import type { RendererChatTraceEvent } from '../../shared/types';

export const RENDERER_CHAT_TRACE_EVENTS = new Set<RendererChatTraceEvent['event']>([
  'chat_run_event_received',
  'chat_run_message_append_attempt',
  'chat_run_message_appended',
  'chat_new_conversation_clicked',
]);
