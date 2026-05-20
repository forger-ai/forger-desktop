import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  OfficialToolDefinition,
  ToolMutationResult,
} from '../../../shared/types';
import type { InternalToolContext, InternalToolModule } from '../types';
import {
  MetaApiError,
  getLead,
  listLeadForms,
  listPages,
  syncLeads,
  validateConnection,
} from './client';
import { MetaOAuthError, runMetaOAuthFlow } from './oauth';
import {
  META_TOOL_ID,
  META_USER_TOKEN_SECRET,
  type MetaGetLeadInput,
  type MetaListLeadFormsInput,
  type MetaSyncLeadsInput,
} from './types';

const definition: OfficialToolDefinition = {
  id: META_TOOL_ID,
  name: 'Meta Lead Ads',
  description:
    'Lee leads y formularios de Lead Ads en las Pages de Facebook/Instagram que administra el usuario. Requiere iniciar sesion en Forger antes de conectar la cuenta de Meta. Solo lectura — no crea ni modifica campanas.',
  version: '0.1.0',
  runtime: 'builtin',
  official: true,
  secrets: [
    {
      name: META_USER_TOKEN_SECRET,
      label: 'Conexion OAuth de Meta',
      required: true,
      usage:
        'Permite leer Pages y leads de Lead Ads sin volver a conectar la cuenta. Forger Cloud renueva este token cuando se acerca a expirar.',
    },
  ],
  actions: [
    {
      id: 'meta.connection.status',
      name: 'Estado de conexion',
      description: 'Revisa si Meta esta conectado.',
      risk: 'low',
    },
    {
      id: 'meta.list_pages',
      name: 'Listar Pages',
      description:
        'Lista las Pages de Facebook/Instagram que el usuario administra y que tienen permisos para Lead Ads.',
      risk: 'low',
    },
    {
      id: 'meta.list_lead_forms',
      name: 'Listar formularios de leads',
      description:
        'Lista los formularios de Lead Ads asociados a una Page, incluyendo conteo de leads y estado.',
      risk: 'medium',
    },
    {
      id: 'meta.sync_leads',
      name: 'Sincronizar leads de un formulario',
      description:
        'Trae los leads nuevos de un formulario desde la fecha indicada (filtrado server-side). Devuelve cada lead con field_data (nombre, email, telefono, custom questions) y datos de origen (ad/adset/campaign).',
      risk: 'high',
    },
    {
      id: 'meta.get_lead',
      name: 'Leer un lead',
      description: 'Lee un lead especifico por id, con todos sus campos y datos de origen.',
      risk: 'high',
    },
  ],
  changelog: ['Base inicial: conexion OAuth + listado de Pages, formularios y leads (read-only).'],
};

const toToolResult = (
  error: unknown,
  fallbackMessage: string,
  fallbackCode: string,
): CallOfficialToolResult => {
  if (error instanceof MetaOAuthError) {
    return {
      success: false,
      userMessage: error.message,
      technicalCode: error.technicalCode,
    };
  }
  if (error instanceof MetaApiError) {
    return {
      success: false,
      userMessage: fallbackMessage,
      technicalCode: error.technicalCode,
    };
  }
  return {
    success: false,
    userMessage: fallbackMessage,
    technicalCode: error instanceof Error ? error.message : fallbackCode,
  };
};

const parseListPagesInput = (input: unknown): { maxResults?: number } => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const candidate = input as Record<string, unknown>;
  const maxResults = typeof candidate.maxResults === 'number' && Number.isFinite(candidate.maxResults)
    ? candidate.maxResults
    : undefined;
  return maxResults !== undefined ? { maxResults } : {};
};

const parseListLeadFormsInput = (input: unknown): MetaListLeadFormsInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const pageId = typeof candidate.pageId === 'string' ? candidate.pageId.trim() : '';
  if (!pageId) {
    return null;
  }
  const result: MetaListLeadFormsInput = { pageId };
  if (typeof candidate.maxResults === 'number' && Number.isFinite(candidate.maxResults)) {
    result.maxResults = candidate.maxResults;
  }
  if (typeof candidate.modifiedSince === 'string' && candidate.modifiedSince.trim().length > 0) {
    result.modifiedSince = candidate.modifiedSince.trim();
  }
  return result;
};

const parseSyncLeadsInput = (input: unknown): MetaSyncLeadsInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const pageId = typeof candidate.pageId === 'string' ? candidate.pageId.trim() : '';
  const formId = typeof candidate.formId === 'string' ? candidate.formId.trim() : '';
  if (!pageId || !formId) {
    return null;
  }
  const result: MetaSyncLeadsInput = { formId, pageId };
  if (typeof candidate.since === 'string' && candidate.since.trim().length > 0) {
    result.since = candidate.since.trim();
  }
  if (typeof candidate.maxResults === 'number' && Number.isFinite(candidate.maxResults)) {
    result.maxResults = candidate.maxResults;
  }
  return result;
};

const parseGetLeadInput = (input: unknown): MetaGetLeadInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const leadId = typeof candidate.leadId === 'string' ? candidate.leadId.trim() : '';
  if (!leadId) {
    return null;
  }
  const result: MetaGetLeadInput = { leadId };
  if (typeof candidate.pageId === 'string' && candidate.pageId.trim().length > 0) {
    result.pageId = candidate.pageId.trim();
  }
  return result;
};

const configure = async (context: InternalToolContext): Promise<ToolMutationResult> => {
  try {
    await runMetaOAuthFlow(context);
    return { success: true, userMessage: 'Meta conectado.' };
  } catch (error) {
    const result = toToolResult(error, 'No pudimos conectar Meta.', 'meta_oauth_failed');
    return {
      success: false,
      userMessage: result.userMessage ?? 'No pudimos conectar Meta.',
      technicalCode: result.technicalCode,
    };
  }
};

const execute = async (
  input: CallOfficialToolInput,
  context: InternalToolContext,
): Promise<CallOfficialToolResult> => {
  try {
    if (input.actionId === 'meta.connection.status') {
      const hasToken = await context.secretsStore.hasToolSecret(META_TOOL_ID, META_USER_TOKEN_SECRET);
      if (!hasToken) {
        return { success: true, data: { connected: false } };
      }
      await validateConnection(context);
      return { success: true, data: { connected: true } };
    }

    if (input.actionId === 'meta.list_pages') {
      const parsed = parseListPagesInput(input.input);
      const pages = await listPages(context, parsed);
      return { success: true, data: { pages } };
    }

    if (input.actionId === 'meta.list_lead_forms') {
      const parsed = parseListLeadFormsInput(input.input);
      if (!parsed) {
        return {
          success: false,
          userMessage: 'Indica el pageId del Page cuyas formas de Lead Ads quieres listar.',
          technicalCode: 'meta_list_lead_forms_input_invalid',
        };
      }
      const forms = await listLeadForms(context, parsed);
      return { success: true, data: { forms } };
    }

    if (input.actionId === 'meta.sync_leads') {
      const parsed = parseSyncLeadsInput(input.input);
      if (!parsed) {
        return {
          success: false,
          userMessage: 'Indica pageId y formId para sincronizar los leads.',
          technicalCode: 'meta_sync_leads_input_invalid',
        };
      }
      const leads = await syncLeads(context, parsed);
      return { success: true, data: { leads } };
    }

    if (input.actionId === 'meta.get_lead') {
      const parsed = parseGetLeadInput(input.input);
      if (!parsed) {
        return {
          success: false,
          userMessage: 'Indica el leadId que deseas leer.',
          technicalCode: 'meta_get_lead_input_invalid',
        };
      }
      const lead = await getLead(context, parsed);
      return { success: true, data: lead };
    }

    return {
      success: false,
      userMessage: 'La accion de Meta no esta disponible.',
      technicalCode: 'meta_action_unknown',
    };
  } catch (error) {
    return toToolResult(error, 'No pudimos completar la accion de Meta.', 'meta_action_failed');
  }
};

export const metaToolModule: InternalToolModule = {
  definition,
  configure,
  execute,
};
