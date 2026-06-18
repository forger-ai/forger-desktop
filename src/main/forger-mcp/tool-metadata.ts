import type { AgentToolDefinition, AgentToolId } from '../../shared/types';
import {
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
  LLM_PROVIDER_KEYS,
  LLM_PROVIDER_REGISTRY,
} from '../../shared/agent-runtime-registry';

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

  if (toolId === 'gmail.search_messages') {
    return {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.read_thread') {
    return {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        messageId: { type: 'string' },
      },
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.read_attachment') {
    return {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        attachmentId: { type: 'string' },
        filename: { type: 'string' },
      },
      required: ['messageId'],
      additionalProperties: false,
    };
  }

  if (toolId === 'gmail.send_email') {
    return {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
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
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    };
  }

  if (toolId === 'whatsapp.start_pairing') {
    return {
      type: 'object',
      properties: {
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
        chatId: { type: 'string' },
      },
      required: ['chatId'],
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
