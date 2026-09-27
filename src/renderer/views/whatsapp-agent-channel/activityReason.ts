const reasons: Record<string, readonly [string, string]> = {
  run_start_rejected: ['The task could not start. Review the chat settings before sending a new request.', 'La tarea no pudo comenzar. Revisa los ajustes del chat antes de enviar otra solicitud.'],
  run_admission_interrupted: ['Task startup was interrupted. Review any recorded result before trying again.', 'Se interrumpió el inicio de la tarea. Revisa si dejó un resultado antes de volver a intentarlo.'],
  desktop_restarted: ['Forger restarted while this task was running. Its actions are not repeated automatically.', 'Forger se reinició durante esta tarea. Sus acciones no se repiten automáticamente.'],
  legacy_admission_unconfirmed: ['The previous task could not be confirmed. Review its conversation before sending it again.', 'No se pudo confirmar la tarea anterior. Revisa su conversación antes de enviarla nuevamente.'],
  participant_access_removed: ['This person no longer has permission to assign tasks in this chat.', 'Esta persona ya no tiene permiso para pedir tareas en este chat.'],
  channel_reconfigured: ['The chat settings changed. The earlier task was stopped to respect the new access settings.', 'Cambió la configuración del chat. La tarea anterior se detuvo para respetar los nuevos permisos.'],
  channel_deleted: ['This chat was removed from the agent.', 'Se quitó este chat del agente.'],
  run_failed: ['The task failed. Open the conversation to review its result.', 'La tarea falló. Abre la conversación para revisar su resultado.'],
  run_canceled: ['The task was canceled. Actions already taken are not undone.', 'Se canceló la tarea. Las acciones ya realizadas no se deshacen.'],
  canceled: ['The task was canceled. Actions already taken are not undone.', 'Se canceló la tarea. Las acciones ya realizadas no se deshacen.'],
  off: ['Automatic replies were paused for this chat.', 'Se pausaron las respuestas automáticas de este chat.'],
  corrected: ['This task was replaced by an explicit correction.', 'Esta tarea se reemplazó por una corrección explícita.'],
  response_missing: ['The task finished without a reply to send. Review its conversation.', 'La tarea terminó sin una respuesta para enviar. Revisa su conversación.'],
  delivery_unconfirmed: ['WhatsApp may have received this reply. Review the chat before deciding what to do next.', 'WhatsApp podría haber recibido esta respuesta. Revisa el chat antes de decidir cómo continuar.'],
  whatsapp_offline: ['WhatsApp is disconnected. Reconnect the account in Connections.', 'WhatsApp está desconectado. Vuelve a conectar la cuenta en Conexiones.'],
  whatsapp_send_unavailable: ['WhatsApp is not ready to send. Reconnect the account in Connections; the reply stays queued.', 'WhatsApp no está listo para enviar. Reconecta la cuenta en Conexiones; la respuesta queda en cola.'],
  whatsapp_not_connected: ['WhatsApp is disconnected. Reconnect the account in Connections.', 'WhatsApp está desconectado. Vuelve a conectar la cuenta en Conexiones.'],
  whatsapp_connection_not_connected: ['WhatsApp is disconnected. Reconnect the account in Connections.', 'WhatsApp está desconectado. Vuelve a conectar la cuenta en Conexiones.'],
  whatsapp_send_rate_limited: ['This reply is waiting for the account to be ready to send again.', 'Esta respuesta espera a que la cuenta pueda volver a enviar mensajes.'],
};

export function activityReason(reason: string, spanish: boolean): string {
  const message = reasons[reason] ?? ['The task or delivery needs review. Open the conversation to inspect the result.', 'La tarea o la entrega necesita revisión. Consulta la conversación para ver el resultado.'];
  return message[spanish ? 1 : 0];
}
