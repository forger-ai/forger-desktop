import type { AgentToolDefinition, AgentToolId } from '../../shared/types';
import {
  CODEX_REASONING_OPTIONS,
  LLM_PROVIDER_KEYS,
  LLM_PROVIDER_REGISTRY,
} from '../../shared/agent-runtime-registry';
import { APP_CATEGORIES } from '../../shared/types/catalog';

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export const getMcpToolInputSchema = (toolId: AgentToolId): Record<string, unknown> => {
  if (toolId === 'memory_list') {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'app'] },
        appId: { type: 'string' },
        kind: { type: 'string', enum: ['preference', 'profile', 'workflow', 'constraint', 'fact'] },
        status: { type: 'string', enum: ['active', 'candidate', 'archived'] },
      },
      additionalProperties: false,
    };
  }
  if (toolId === 'memory_create') {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'app'] },
        appId: { type: 'string' },
        kind: { type: 'string', enum: ['preference', 'profile', 'workflow', 'constraint', 'fact'] },
        title: { type: 'string' },
        body: { type: 'string' },
        text: { type: 'string', description: 'Legacy alias for body.' },
        read_when: { type: 'string', description: 'When this memory should be read. Empty means always inject the memory body.' },
        status: { type: 'string', enum: ['active', 'candidate', 'archived'] },
        evidence: { type: 'string' },
      },
      required: ['scope', 'kind'],
      additionalProperties: false,
    };
  }
  if (toolId === 'memory_update') {
    return {
      type: 'object',
      properties: {
        id: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'app'] },
        appId: { type: 'string' },
        kind: { type: 'string', enum: ['preference', 'profile', 'workflow', 'constraint', 'fact'] },
        title: { type: 'string' },
        body: { type: 'string' },
        text: { type: 'string' },
        read_when: { type: 'string', description: 'When this memory should be read. Empty means always inject the memory body.' },
        status: { type: 'string', enum: ['active', 'candidate', 'archived'] },
        evidence: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    };
  }
  if (toolId === 'memory_delete') {
    return {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    };
  }

  if (toolId === 'respond_and_end' || toolId === 'respond_and_wait') {
    return {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          maxLength: 4000,
          description: 'Texto exacto que el Sidekick hablara en voz alta. Breve, natural y en el idioma del turno.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    };
  }

  if (
    toolId === 'forger_get_app_runtime_status' ||
    toolId === 'forger_open_app' ||
    toolId === 'forger_stop_app' ||
    toolId === 'forger_restart_app' ||
    toolId === 'forger_refresh_app_view' ||
    toolId === 'forger_update_app' ||
    toolId === 'forger_list_app_prompts'
  ) {
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada sobre la que se ejecuta la herramienta.',
        },
      },
      required: ['appId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_get_app_view_snapshot') {
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada cuya ventana de Forger se inspeccionara.',
        },
        selector: {
          type: 'string',
          description: 'Selector CSS opcional dentro de la ventana de la app. Omitir para inspeccionar body.',
        },
        includeHtml: {
          type: 'boolean',
          description: 'Incluye HTML truncado del selector cuando hace falta diagnosticar estructura.',
        },
        maxChars: {
          type: 'number',
          minimum: 1000,
          maximum: 50000,
          description: 'Limite aproximado de caracteres para texto y HTML devueltos.',
        },
      },
      required: ['appId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_get_app_runtime_diagnostics') {
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada cuyo runtime y logs recientes se revisaran.',
        },
        recentLines: {
          type: 'number',
          minimum: 10,
          maximum: 200,
          description: 'Cantidad maxima de lineas recientes por log.',
        },
      },
      required: ['appId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_finish_social_app_install' || toolId === 'forger_delete_quarantined_social_app') {
    return {
      type: 'object',
      properties: {
        quarantineId: {
          type: 'string',
          description: 'ID local de la cuarentena activa. Si se omite, Forger usa el contexto del chat de revision.',
        },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_update_published_app_info') {
    return {
      type: 'object',
      properties: {
        userAppId: {
          type: 'number',
          minimum: 1,
          description: 'ID numerico de la app publicada en Social. En el catalogo aparece como socialUserAppId.',
        },
        appId: {
          type: 'string',
          description: 'ID local de una app instalada que ya esta asociada a una publicacion Social.',
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Nombre visible de la app publicada.',
        },
        shortDescription: {
          type: 'string',
          maxLength: 180,
          description: 'Descripcion corta visible en tarjetas o listados.',
        },
        description: {
          type: 'string',
          description: 'Descripcion publica de la app.',
        },
        longDescription: {
          type: 'string',
          description: 'Descripcion larga publica de la app.',
        },
        category: {
          type: 'string',
          enum: [...APP_CATEGORIES],
          description: 'Categoria publica de la app.',
        },
        visibility: {
          type: 'string',
          enum: ['public', 'friends', 'private'],
          description: 'Visibilidad publica de la app en Social.',
        },
      },
      anyOf: [
        { required: ['userAppId'] },
        { required: ['appId'] },
      ],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_speech_to_text_status') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_text_to_speech_status' || toolId === 'forger_text_to_speech_voices') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_transcribe_audio' || toolId === 'forger_translate_audio') {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Ruta del archivo de audio compartido o autorizado por Forger.',
        },
        language: {
          type: 'string',
          description: 'Codigo de idioma opcional cuando se conoce.',
        },
        model: {
          type: 'string',
          enum: ['tiny', 'base', 'small', 'medium', 'large-v3'],
          description: 'Modelo faster-whisper opcional para transcripcion de archivo. Omitir para usar el modelo activo de Forger.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_synthesize_speech') {
    return {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Texto que se convertira en audio.',
        },
        model: {
          type: 'string',
          description: 'Modelo local de TTS, por ejemplo kokoro.',
        },
        voice: {
          type: 'string',
          description: 'Voz cargada para el modelo solicitado.',
        },
        speed: {
          type: 'number',
          description: 'Velocidad opcional de habla.',
        },
        format: {
          type: 'string',
          enum: ['wav', 'mp3', 'opus'],
        },
      },
      required: ['text', 'model', 'voice'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_create_app') {
    return {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Nombre visible de la app que se creara.',
        },
        description: {
          type: 'string',
          description: 'Descripcion breve y visible de la app.',
        },
        purpose: {
          type: 'string',
          description: 'Que debe ayudar a hacer la app y cual es el resultado esperado para la persona.',
        },
        lookAndFeel: {
          type: 'string',
          description: 'Direccion visual y de experiencia elegida o recomendada.',
        },
      },
      required: ['name', 'description', 'purpose'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_add_app_to_personal_agent') {
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada cuyo MCP debe quedar disponible para este agente personal en proximas ejecuciones.',
        },
      },
      required: ['appId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'wakeup_in') {
    return {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Segundos a esperar. Minimo 5.' },
        prompt: { type: 'string', description: 'Prompt visible que se insertara al despertar en esta misma conversacion.' },
      },
      required: ['seconds', 'prompt'],
      additionalProperties: false,
    };
  }

  if (toolId === 'cancel_wakeup') {
    return {
      type: 'object',
      properties: {
        wakeupId: { type: 'string', description: 'ID opcional del wakeup. Si se omite, cancela el de la conversacion actual.' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'create_agent_routine' || toolId === 'update_agent_routine') {
    return {
      type: 'object',
      properties: {
        ...(toolId === 'update_agent_routine' ? { routineId: { type: 'string' } } : {}),
        name: { type: 'string' },
        prompt: { type: 'string', description: 'Prompt visible que se insertara en el thread de la rutina en cada ejecucion.' },
        periodicity: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['hourly', 'daily', 'weekly'] },
            timeOfDay: { type: 'string', description: 'HH:MM para daily/weekly.' },
            weeklyDay: { type: 'number', description: '0 (domingo) a 6 (sabado) para weekly.' },
          },
          required: ['type'],
          additionalProperties: false,
        },
        missedRunPolicy: { type: 'string', enum: ['skip', 'always', 'within_window'] },
        missedRunWindowMinutes: { type: 'number' },
        enabled: { type: 'boolean' },
        authorizationText: { type: 'string', description: 'Texto con la autorizacion de la persona para esta mutacion.' },
      },
      required: toolId === 'update_agent_routine'
        ? ['routineId', 'name', 'prompt', 'periodicity', 'authorizationText']
        : ['name', 'prompt', 'periodicity', 'authorizationText'],
      additionalProperties: false,
    };
  }

  if (toolId === 'list_agent_routines') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  if (toolId === 'delete_agent_routine') {
    return {
      type: 'object',
      properties: {
        routineId: { type: 'string' },
        authorizationText: { type: 'string', description: 'Texto con la autorizacion de la persona para borrar la rutina.' },
      },
      required: ['routineId', 'authorizationText'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_list_agent_peers') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_ask_agent') {
    return {
      type: 'object',
      properties: {
        targetAgentId: {
          type: 'string',
          description: 'ID del agente permitido al que se iniciara un thread nuevo. Omitir cuando threadId continua un thread existente.',
        },
        threadId: {
          type: 'string',
          description: 'Thread inter-agente existente para continuar.',
        },
        message: {
          type: 'string',
          description: 'Mensaje que recibira el otro agente.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_read_agent_thread') {
    return {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'Thread inter-agente permitido que se leera en modo solo lectura.',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_request_app_tool_grant') {
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada que declaro la herramienta en tools.optional.',
        },
        toolId: {
          type: 'string',
          description: 'ID de la herramienta oficial opcional declarada por la app, por ejemplo gmail.',
        },
        reason: {
          type: 'string',
          description: 'Motivo funcional y visible para explicar por que la app necesita activar esta herramienta.',
        },
      },
      required: ['appId', 'toolId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_connection_list') {
    return {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Tipo de conexion opcional, por ejemplo gmail.' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_connection_status') {
    return {
      type: 'object',
      properties: {
        type: { type: 'string' },
        connectionId: { type: 'string' },
      },
      required: ['type'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_ask_question') {
    return {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 3,
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    description: {
                      type: 'string',
                      description: 'Detalle user-facing de lo que implica elegir esta respuesta.',
                    },
                  },
                  required: ['id', 'label', 'description'],
                  additionalProperties: false,
                },
              },
            },
            required: ['id', 'question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_test_app_prompt') {
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada.',
        },
        kind: {
          type: 'string',
          enum: ['promptTemplate', 'agent', 'agentPrompt'],
        },
        id: {
          type: 'string',
          description: 'ID del prompt declarado por la app. Para agentPrompt usa agentId:initial, agentId:resume o agentId:steer.',
        },
        prompt: {
          type: 'string',
          description: 'Texto candidato opcional. Si se omite, se prueba el prompt actual.',
        },
        variables: {
          type: 'object',
          description: 'Variables de prueba para renderizar el prompt.',
          additionalProperties: true,
        },
      },
      required: ['appId', 'kind', 'id'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_update_app_prompt') {
    const runtimeProviderSchemas = LLM_PROVIDER_KEYS.map((provider) => {
      const definition = LLM_PROVIDER_REGISTRY[provider];
      return {
        type: 'object',
        properties: {
          provider: { const: provider },
          model: { type: 'string', enum: definition.modelOptions.map((option) => option.realModelName) },
          effort: { type: 'string', enum: definition.effortOptions.map((option) => option.value) },
        },
        required: ['provider', 'model', 'effort'],
        additionalProperties: false,
      };
    });
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada.',
        },
        kind: {
          type: 'string',
          enum: ['promptTemplate', 'agent', 'agentPrompt'],
        },
        id: {
          type: 'string',
          description: 'ID del prompt declarado por la app.',
        },
        prompt: {
          type: 'string',
          description: 'Nuevo texto plano del prompt. Debe conservar las variables {{...}} del original.',
        },
        runtime: {
          oneOf: runtimeProviderSchemas,
        },
        provider: { type: 'string', enum: [...LLM_PROVIDER_KEYS] },
        model: { type: 'string', enum: LLM_PROVIDER_KEYS.flatMap((provider) => LLM_PROVIDER_REGISTRY[provider].modelOptions.map((option) => option.realModelName)) },
        effort: { type: 'string', enum: LLM_PROVIDER_KEYS.flatMap((provider) => LLM_PROVIDER_REGISTRY[provider].effortOptions.map((option) => option.value)) },
        reasoningEffort: { type: 'string', enum: CODEX_REASONING_OPTIONS.map((option) => option.value) },
      },
      required: ['appId', 'kind', 'id', 'prompt'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_restore_app_prompt') {
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada.',
        },
        kind: {
          type: 'string',
          enum: ['promptTemplate', 'agent', 'agentPrompt'],
        },
        id: {
          type: 'string',
          description: 'ID del prompt declarado por la app.',
        },
      },
      required: ['appId', 'kind', 'id'],
      additionalProperties: false,
    };
  }

  if (
    toolId === 'gmail.connection.status' ||
    toolId === 'gmail.get_profile' ||
    toolId === 'gmail.list_labels' ||
    toolId === 'whatsapp.connection.status' ||
    toolId === 'slack.connection.status' ||
    toolId === 'trello.connection.status'
  ) {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.search_messages') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        query: { type: 'string' },
        maxResults: { type: 'number' },
        pageToken: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.list_threads') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        query: { type: 'string' },
        labelIds: { type: 'array', items: { type: 'string' } },
        maxResults: { type: 'number' },
        pageToken: { type: 'string' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.read_thread') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        threadId: { type: 'string' },
        messageId: { type: 'string' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.list_changes') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        startHistoryId: { type: 'string' },
        maxResults: { type: 'number' },
        pageToken: { type: 'string' },
      },
      required: ['startHistoryId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.modify_thread') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        threadId: { type: 'string' },
        addLabelIds: { type: 'array', items: { type: 'string' } },
        removeLabelIds: { type: 'array', items: { type: 'string' } },
        markRead: { type: 'boolean' },
        markUnread: { type: 'boolean' },
        star: { type: 'boolean' },
        unstar: { type: 'boolean' },
        archive: { type: 'boolean' },
      },
      required: ['threadId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.move_thread') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        threadId: { type: 'string' },
        destination: { type: 'string', enum: ['trash', 'untrash'] },
      },
      required: ['threadId', 'destination'],
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.read_attachment') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        messageId: { type: 'string' },
        attachmentId: { type: 'string' },
        filename: { type: 'string' },
      },
      required: ['messageId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.list_drafts') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        maxResults: { type: 'number' },
        pageToken: { type: 'string' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.get_draft' || toolId === 'gmail.delete_draft' || toolId === 'gmail.send_draft') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        draftId: { type: 'string' },
      },
      required: ['draftId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.save_draft') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        draftId: { type: 'string' },
        threadId: { type: 'string' },
        to: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
        bodyHtml: { type: 'string' },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              filename: { type: 'string' },
              mimeType: { type: 'string' },
            },
            required: ['filePath'],
            additionalProperties: false,
          },
        },
      },
      required: ['to', 'subject'],
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.send_email') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        to: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
        bodyHtml: { type: 'string' },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              filename: { type: 'string' },
              mimeType: { type: 'string' },
            },
            required: ['filePath'],
            additionalProperties: false,
          },
        },
      },
      required: ['to', 'subject'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_chrome_extension.connection.status') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_chrome_extension.open_dedicated_tab') {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional http or https URL to open in the dedicated Chrome tab.' },
      },
      additionalProperties: false,
    };
  }

  if (
    toolId === 'forger_chrome_extension.get_current_url' ||
    toolId === 'forger_chrome_extension.close_window' ||
    toolId === 'forger_chrome_extension.close_session'
  ) {
    return {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_chrome_extension.navigate') {
    return {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string', description: 'http or https URL.' },
      },
      required: ['sessionId', 'url'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_chrome_extension.get_html') {
    return {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string', description: 'Optional CSS selector. If omitted, returns the full page HTML.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_chrome_extension.wait_for_selector') {
    return {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        state: {
          type: 'string',
          enum: ['attached', 'visible', 'hidden', 'detached'],
          description: 'Expected selector state. Defaults to visible.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          maximum: 60000,
          description: 'Maximum wait time in milliseconds. Defaults to 10000.',
        },
      },
      required: ['sessionId', 'selector'],
      additionalProperties: false,
    };
  }

  if (
    toolId === 'forger_chrome_extension.click' ||
    toolId === 'forger_chrome_extension.focus' ||
    toolId === 'forger_chrome_extension.hover'
  ) {
    return {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
      },
      required: ['sessionId', 'selector'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_chrome_extension.input_text') {
    return {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['sessionId', 'selector', 'text'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_chrome_extension.submit_form') {
    return {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string', description: 'CSS selector for the form or an element inside the form.' },
        submitSelector: { type: 'string', description: 'Optional CSS selector for the submit button inside the form.' },
      },
      required: ['sessionId', 'selector'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_chrome_extension.get_styles') {
    return {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional CSS property names to inspect.',
        },
      },
      required: ['sessionId', 'selector'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_chrome_extension.set_styles') {
    return {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        styles: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Allowed CSS styles to apply, for example outline, outline-offset, background-color, box-shadow, border, color, opacity, or z-index.',
        },
      },
      required: ['sessionId', 'selector', 'styles'],
      additionalProperties: false,
    };
  }

  if (toolId === 'whatsapp.start_pairing') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        method: { type: 'string', enum: ['qr', 'pairing_code'] },
        phoneNumber: { type: 'string' },
      },
      required: ['method'],
      additionalProperties: false,
    };
  }

  if (toolId === 'whatsapp.list_chats') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        chatType: { type: 'string', enum: ['direct', 'group', 'channel'] },
        query: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'whatsapp.read_messages') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        chatId: { type: 'string' },
        limit: { type: 'number' },
        beforeMessageRef: { type: 'string' },
      },
      required: ['chatId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'whatsapp.download_attachment') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        attachmentId: { type: 'string' },
      },
      required: ['attachmentId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'whatsapp.send_message') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        chatId: { type: 'string' },
        text: { type: 'string' },
        replyToMessageRef: { type: 'string' },
      },
      required: ['chatId', 'text'],
      additionalProperties: false,
    };
  }

  if (toolId === 'whatsapp.get_chat_details') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        chatId: { type: 'string' },
      },
      required: ['chatId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'workflow_get_context') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  if (toolId === 'workflow_complete_node') {
    return {
      type: 'object',
      properties: {
        output: {
          type: 'object',
          description: 'Resultado estructurado del nodo que consumen los nodos siguientes.',
        },
        summary: {
          type: 'string',
          description: 'Resumen breve del trabajo realizado, orientado al usuario final.',
        },
      },
      required: ['output', 'summary'],
      additionalProperties: false,
    };
  }

  if (toolId === 'workflow_fail_node') {
    return {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Motivo claro por el que el nodo no pudo completarse.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_workflow_list') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_workflow_get' || toolId === 'forger_workflow_run') {
    return {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
      },
      required: ['workflowId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'forger_workflow_upsert') {
    return {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID del flujo existente. Omitir para crear uno nuevo.' },
        name: { type: 'string' },
        description: { type: 'string' },
        enabled: { type: 'boolean' },
        trigger: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['manual', 'scheduled'] },
            frequency: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['hourly', 'daily', 'weekly'] },
                timeOfDay: { type: 'string', description: 'HH:MM para daily/weekly.' },
                weeklyDay: { type: 'number', description: '0 (domingo) a 6 (sabado) para weekly.' },
              },
            },
            missedRunPolicy: { type: 'string', enum: ['skip', 'always', 'within_window'] },
            missedRunWindowMinutes: { type: 'number' },
          },
          required: ['type'],
        },
        nodes: {
          type: 'array',
          description: 'Nodos del flujo. Tipos: llm_agent (prompt, toolIds, connectionGrants, appIds, runtime, outputSchema), forger_agent (agentId, prompt), forger_tool (toolId, input), connection (connectionType, actionId, connectionId opcional, input), condition (expression con left, operator, right). Todos requieren id y name. requiresApproval pausa el flujo hasta aprobar el paso.',
          items: { type: 'object' },
        },
        edges: {
          type: 'array',
          description: 'Conexiones entre nodos: { from, to, condition } con condition success, error o always. En nodos condition, success es la rama verdadera y error la falsa.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              condition: { type: 'string', enum: ['success', 'error', 'always'] },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['name', 'trigger', 'nodes'],
      additionalProperties: false,
    };
  }

  if (toolId === 'slack.list_channels') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        limit: { type: 'number', description: 'Cantidad maxima de canales (default 100).' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'slack.read_messages') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        channelId: { type: 'string' },
        limit: { type: 'number', description: 'Cantidad maxima de mensajes (default 20).' },
      },
      required: ['channelId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'slack.send_message') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        channelId: { type: 'string', description: 'ID o nombre del canal, por ejemplo C0123 o #general.' },
        text: { type: 'string' },
      },
      required: ['channelId', 'text'],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.list_boards') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.list_lists' ) {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        boardId: { type: 'string' },
      },
      required: ['boardId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.list_cards') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        listId: { type: 'string' },
        limit: { type: 'number', description: 'Cantidad maxima de tarjetas (default 50).' },
      },
      required: ['listId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.filter_cards') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        boardId: { type: 'string' },
        listId: { type: 'string' },
        query: { type: 'string' },
        closed: { type: 'boolean' },
        labelIds: { type: 'array', items: { type: 'string' } },
        memberIds: { type: 'array', items: { type: 'string' } },
        dueBefore: { type: 'string', description: 'Fecha maxima de vencimiento en formato ISO 8601.' },
        dueAfter: { type: 'string', description: 'Fecha minima de vencimiento en formato ISO 8601.' },
        dueComplete: { type: 'boolean' },
        limit: { type: 'number', description: 'Cantidad maxima de tarjetas (default 50).' },
      },
      required: [],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.create_card') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        listId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        dueDate: { type: 'string', description: 'Fecha limite en formato ISO 8601.' },
      },
      required: ['listId', 'name'],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.update_card') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        cardId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        listId: { type: 'string' },
        dueDate: { type: 'string', description: 'Fecha limite en formato ISO 8601.' },
        dueComplete: { type: 'boolean' },
        closed: { type: 'boolean' },
      },
      required: ['cardId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.delete_card') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        cardId: { type: 'string' },
      },
      required: ['cardId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.comment_card') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        cardId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['cardId', 'text'],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.list_card_attachments') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        cardId: { type: 'string' },
      },
      required: ['cardId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.download_attachment') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        cardId: { type: 'string' },
        attachmentId: { type: 'string' },
        fileName: { type: 'string' },
      },
      required: ['cardId', 'attachmentId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'trello.upload_attachment') {
    return {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        cardId: { type: 'string' },
        filePath: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['cardId', 'filePath'],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
};

export const getMcpToolAnnotations = (tool: AgentToolDefinition): McpToolAnnotations => {
  if (tool.id === 'forger_transcribe_audio' || tool.id === 'forger_translate_audio' || tool.id === 'forger_synthesize_speech') {
    return {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    };
  }
  if (tool.category === 'consulta' || tool.category === 'memoria') {
    return {
      readOnlyHint: tool.category === 'consulta' || tool.id === 'memory_list',
      destructiveHint: false,
      idempotentHint: tool.id !== 'memory_create',
      openWorldHint: false,
    };
  }
  // Codex native approval must not block Forger runs; sensitive actions are
  // still gated inside executeAgentTool through ensureToolApproval().
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
};
