import type {
  AgentToolDefinition,
  AgentToolId,
  RuntimeStatus,
} from '../../shared/types';

export const INTERNAL_MCP_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    id: 'forger_ask_question',
    packageId: 'forger:internal',
    name: 'Hacer preguntas',
    description: 'Registra preguntas estructuradas para que la persona responda antes de continuar.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_list_agent_peers',
    packageId: 'forger:internal',
    name: 'Listar agentes permitidos',
    description: 'Lista los agentes personales que este agente puede contactar, sus criterios y threads recientes.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_create_personal_agent',
    packageId: 'forger:internal',
    name: 'Crear agente personal',
    description: 'Crea un agente personal nuevo cuando el agente actual tiene permiso para crear otros agentes.',
    category: 'actualizacion',
    risk: 'medio',
    defaultRequiresApproval: false,
  },
  {
    id: 'respond_and_end',
    packageId: 'forger:internal',
    name: 'Responder y terminar',
    description: 'Habla el texto por el Sidekick y termina el turno de voz. Llamar exactamente una vez por turno; el texto se reproduce tal cual.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'respond_and_wait',
    packageId: 'forger:internal',
    name: 'Responder y esperar',
    description: 'Habla el texto por el Sidekick y deja el microfono escuchando de inmediato el follow-up de la persona, sin wake word. Usar solo cuando se necesita su respuesta para continuar.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'wakeup_in',
    packageId: 'forger:internal',
    name: 'Despertar en segundos',
    description: 'Programa un despertar one-shot en esta misma conversacion de agente personal. Bloquea el envio hasta despertar o cancelar.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'cancel_wakeup',
    packageId: 'forger:internal',
    name: 'Cancelar despertar',
    description: 'Cancela el despertar one-shot pendiente de esta conversacion de agente personal.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'create_agent_routine',
    packageId: 'forger:internal',
    name: 'Crear rutina de agente',
    description: 'Crea una rutina periodica one-shot para el agente personal actual, con thread propio conversable.',
    category: 'actualizacion',
    risk: 'medio',
    defaultRequiresApproval: false,
  },
  {
    id: 'list_agent_routines',
    packageId: 'forger:internal',
    name: 'Listar rutinas de agente',
    description: 'Lista las rutinas del agente personal actual.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'update_agent_routine',
    packageId: 'forger:internal',
    name: 'Actualizar rutina de agente',
    description: 'Actualiza una rutina existente del agente personal actual con autorizacion textual.',
    category: 'actualizacion',
    risk: 'medio',
    defaultRequiresApproval: false,
  },
  {
    id: 'delete_agent_routine',
    packageId: 'forger:internal',
    name: 'Eliminar rutina de agente',
    description: 'Elimina una rutina del agente personal actual conservando el thread conversable.',
    category: 'actualizacion',
    risk: 'medio',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_ask_agent',
    packageId: 'forger:internal',
    name: 'Preguntar a otro agente',
    description: 'Inicia o continua un thread local con otro agente personal permitido y espera su respuesta con timeout.',
    category: 'consulta',
    risk: 'medio',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_read_agent_thread',
    packageId: 'forger:internal',
    name: 'Leer thread de agente',
    description: 'Lee en modo solo lectura el transcript de un thread inter-agente permitido.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'workflow_get_context',
    packageId: 'forger:internal',
    name: 'Leer contexto del nodo',
    description: 'Devuelve el contexto completo de entrada del nodo de flujo en ejecucion, incluyendo los outputs de los nodos anteriores.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'workflow_complete_node',
    packageId: 'forger:internal',
    name: 'Completar nodo de flujo',
    description: 'Marca el nodo de flujo actual como exitoso y registra el output estructurado que consumen los nodos siguientes.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'workflow_fail_node',
    packageId: 'forger:internal',
    name: 'Reportar fallo de nodo',
    description: 'Marca el nodo de flujo actual como fallido con un motivo claro.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_connection_list',
    packageId: 'forger:connections',
    name: 'Listar conexiones',
    description: 'Lista conexiones externas disponibles para esta sesion sin exponer secretos.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
  {
    id: 'forger_connection_status',
    packageId: 'forger:connections',
    name: 'Revisar estado de conexion',
    description: 'Revisa el estado de una conexion externa concedida a esta sesion.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
];

export const WORKFLOW_NODE_TOOL_IDS = new Set<AgentToolId>([
  'workflow_get_context',
  'workflow_complete_node',
  'workflow_fail_node',
]);

export const PERSONAL_AGENT_PEER_TOOL_IDS = new Set<AgentToolId>([
  'forger_list_agent_peers',
  'forger_ask_agent',
  'forger_read_agent_thread',
]);

export const PERSONAL_AGENT_ROUTINE_TOOL_IDS = new Set<AgentToolId>([
  'wakeup_in',
  'cancel_wakeup',
  'create_agent_routine',
  'list_agent_routines',
  'update_agent_routine',
  'delete_agent_routine',
]);

export const SIDEKICK_VOICE_TOOL_IDS = new Set<AgentToolId>([
  'respond_and_end',
  'respond_and_wait',
]);

export const WORKFLOW_MANAGEMENT_TOOL_IDS = new Set<AgentToolId>([
  'forger_workflow_list',
  'forger_workflow_get',
  'forger_workflow_upsert',
  'forger_workflow_review',
  'forger_workflow_apply',
  'forger_workflow_run',
]);

const CHROME_APP_RUNTIME_URL_ACTIONS = new Set<AgentToolId>([
  'forger_chrome_extension.open_dedicated_tab',
  'forger_chrome_extension.navigate',
]);

export const getChromeAppRuntimeUrlBlock = (input: {
  appId: string;
  toolId: AgentToolId;
  targetUrl: string;
  status: RuntimeStatus;
}): Record<string, unknown> | null => {
  if (!CHROME_APP_RUNTIME_URL_ACTIONS.has(input.toolId) || input.appId === 'forger') {
    return null;
  }
  const targetOrigin = urlOrigin(input.targetUrl);
  if (!targetOrigin) {
    return null;
  }
  const blockedRuntimeUrl = [
    { kind: 'frontendUrl', url: input.status.frontendUrl },
    { kind: 'backendUrl', url: input.status.backendUrl },
  ].find((entry) => urlOrigin(entry.url) === targetOrigin);

  if (!blockedRuntimeUrl) {
    return null;
  }

  return {
    success: false,
    appId: input.appId,
    userMessage: 'Abre e inspecciona esta app desde la ventana de Forger. Las URLs internas del runtime son solo diagnostico y no deben abrirse en Chrome.',
    technicalCode: 'forger_app_runtime_url_not_chrome_target',
    blockedRuntimeUrl: blockedRuntimeUrl.kind,
    suggestedTools: [
      'forger_open_app',
      'forger_restart_app',
      'forger_get_app_view_snapshot',
      'forger_get_app_runtime_diagnostics',
    ],
  };
};

const urlOrigin = (value?: string): string | null => {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};
