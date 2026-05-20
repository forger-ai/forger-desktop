import type { InternalToolContext } from '../types';
import { getCachedUserAccessToken } from './oauth';
import {
  META_GRAPH_API_VERSION,
  type MetaLead,
  type MetaLeadFieldValue,
  type MetaLeadFormSummary,
  type MetaPageSummary,
} from './types';

const GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 20_000;

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly technicalCode: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number | string;
    error_subcode?: number | string;
    fbtrace_id?: string;
  };
}

interface PageNode {
  id?: string;
  name?: string;
  category?: string;
  access_token?: string;
  tasks?: string[];
}

interface PagesResponse {
  data?: PageNode[];
  paging?: { next?: string };
}

interface LeadFormNode {
  id?: string;
  name?: string;
  status?: string;
  created_time?: string;
  leads_count?: number;
}

interface LeadFormsResponse {
  data?: LeadFormNode[];
  paging?: { next?: string };
}

interface LeadNode {
  id?: string;
  created_time?: string;
  form_id?: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  campaign_id?: string;
  platform?: string;
  is_organic?: boolean;
  partner_name?: string;
  field_data?: Array<{ name?: string; values?: unknown }>;
  custom_disclaimer_responses?: Array<{ name?: string; values?: unknown }>;
}

interface LeadsResponse {
  data?: LeadNode[];
  paging?: { next?: string; cursors?: { before?: string; after?: string } };
}

const sanitizeText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const sanitizeValues = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : item == null ? '' : String(item)))
    .filter((item) => item.length > 0);
};

const toFieldValues = (raw: Array<{ name?: string; values?: unknown }> | undefined): MetaLeadFieldValue[] => {
  if (!Array.isArray(raw)) return [];
  const result: MetaLeadFieldValue[] = [];
  for (const entry of raw) {
    const name = sanitizeText(entry?.name);
    if (!name) continue;
    result.push({ name, values: sanitizeValues(entry?.values) });
  }
  return result;
};

const toLead = (node: LeadNode): MetaLead | null => {
  const id = sanitizeText(node.id);
  const createdTime = sanitizeText(node.created_time);
  if (!id || !createdTime) return null;
  return {
    id,
    createdTime,
    formId: sanitizeText(node.form_id) ?? '',
    adId: sanitizeText(node.ad_id),
    adName: sanitizeText(node.ad_name),
    adsetId: sanitizeText(node.adset_id),
    campaignId: sanitizeText(node.campaign_id),
    platform: sanitizeText(node.platform),
    isOrganic: typeof node.is_organic === 'boolean' ? node.is_organic : undefined,
    partnerName: sanitizeText(node.partner_name),
    fieldData: toFieldValues(node.field_data),
    customDisclaimerResponses: toFieldValues(node.custom_disclaimer_responses),
  };
};

const toLeadForm = (node: LeadFormNode): MetaLeadFormSummary | null => {
  const id = sanitizeText(node.id);
  const name = sanitizeText(node.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    status: sanitizeText(node.status) ?? 'UNKNOWN',
    createdTime: sanitizeText(node.created_time) ?? '',
    leadsCount: typeof node.leads_count === 'number' ? node.leads_count : undefined,
  };
};

const toPage = (node: PageNode): MetaPageSummary | null => {
  const id = sanitizeText(node.id);
  const name = sanitizeText(node.name);
  if (!id || !name) return null;
  const tasks = Array.isArray(node.tasks)
    ? node.tasks.filter((task): task is string => typeof task === 'string')
    : [];
  return {
    id,
    name,
    category: sanitizeText(node.category),
    tasks,
  };
};

const clampLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value) || !value || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
};

const buildGraphError = (status: number, payload: GraphErrorBody | null): MetaApiError => {
  const error = payload?.error ?? {};
  const fallback = `Meta respondio con HTTP ${status}.`;
  const message = sanitizeText(error.message) ?? fallback;
  const codeParts: Array<string | number> = [];
  if (error.code != null) codeParts.push(error.code);
  if (error.error_subcode != null) codeParts.push(error.error_subcode);
  const technicalCode = codeParts.length
    ? `meta_graph_error_${codeParts.join('_')}`
    : `meta_graph_error_http_${status}`;
  return new MetaApiError(message, technicalCode, status);
};

const requestGraph = async <T>(
  pathname: string,
  params: Record<string, string | number | undefined>,
  accessToken: string,
): Promise<T> => {
  const url = new URL(`${GRAPH_BASE}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set('access_token', accessToken);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MetaApiError('Meta no respondio a tiempo.', 'meta_graph_timeout', null);
    }
    throw new MetaApiError(
      'No pudimos contactar Meta.',
      'meta_graph_network_error',
      null,
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let payload: unknown = null;
  if (raw.length > 0) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw buildGraphError(response.status, payload as GraphErrorBody | null);
  }

  if (!payload || typeof payload !== 'object') {
    throw new MetaApiError(
      'Meta devolvio una respuesta vacia o invalida.',
      'meta_graph_response_invalid',
      response.status,
    );
  }
  return payload as T;
};

const followPaginated = async <Node, Out>(
  initialUrl: string,
  initialParams: Record<string, string | number | undefined>,
  accessToken: string,
  mapNode: (node: Node) => Out | null,
  maxResults: number,
): Promise<Out[]> => {
  const out: Out[] = [];
  let url = initialUrl;
  let params: Record<string, string | number | undefined> | null = initialParams;
  while (out.length < maxResults) {
    const page = (await requestGraph<{ data?: Node[]; paging?: { next?: string } }>(
      url,
      params ?? {},
      accessToken,
    )) ?? {};
    const items = Array.isArray(page.data) ? page.data : [];
    for (const item of items) {
      const mapped = mapNode(item);
      if (mapped) {
        out.push(mapped);
        if (out.length >= maxResults) break;
      }
    }
    const next = page.paging?.next;
    if (!next) break;
    // The Graph API encodes the next page as a full URL with the access
    // token already attached. Strip it back to path + params so requestGraph
    // re-applies a fresh token.
    const nextUrl = new URL(next);
    nextUrl.searchParams.delete('access_token');
    params = {};
    nextUrl.searchParams.forEach((value, key) => {
      (params as Record<string, string>)[key] = value;
    });
    url = `${nextUrl.pathname}${nextUrl.search}`;
    // requestGraph appends params from `params`, so collapse the URL to
    // just its pathname now.
    url = nextUrl.pathname;
  }
  return out;
};

export const validateConnection = async (context: InternalToolContext): Promise<{ ok: boolean }> => {
  const token = await getCachedUserAccessToken(context);
  await requestGraph<{ id: string }>('/me', { fields: 'id' }, token);
  return { ok: true };
};

export const listPages = async (
  context: InternalToolContext,
  options: { maxResults?: number } = {},
): Promise<MetaPageSummary[]> => {
  const token = await getCachedUserAccessToken(context);
  const limit = clampLimit(options.maxResults);
  const response = await requestGraph<PagesResponse>(
    '/me/accounts',
    { fields: 'id,name,category,access_token,tasks', limit },
    token,
  );
  const pages = (response.data ?? [])
    .map((node) => toPage(node))
    .filter((page): page is MetaPageSummary => page !== null);
  return pages;
};

const getPageAccessToken = async (
  context: InternalToolContext,
  pageId: string,
): Promise<string> => {
  const token = await getCachedUserAccessToken(context);
  const node = await requestGraph<PageNode>(
    `/${encodeURIComponent(pageId)}`,
    { fields: 'access_token' },
    token,
  );
  const pageToken = sanitizeText(node.access_token);
  if (!pageToken) {
    throw new MetaApiError(
      'No se pudo obtener el access token de la Page.',
      'meta_page_access_token_missing',
      null,
    );
  }
  return pageToken;
};

export const listLeadForms = async (
  context: InternalToolContext,
  input: { pageId: string; maxResults?: number },
): Promise<MetaLeadFormSummary[]> => {
  const pageToken = await getPageAccessToken(context, input.pageId);
  const maxResults = clampLimit(input.maxResults);
  const path = `/${encodeURIComponent(input.pageId)}/leadgen_forms`;
  const initial: Record<string, string | number | undefined> = {
    fields: 'id,name,status,created_time,leads_count',
    limit: maxResults,
  };
  return followPaginated<LeadFormNode, MetaLeadFormSummary>(
    path,
    initial,
    pageToken,
    toLeadForm,
    maxResults,
  );
};

export const syncLeads = async (
  context: InternalToolContext,
  input: { formId: string; pageId: string; since?: string; maxResults?: number },
): Promise<MetaLead[]> => {
  const pageToken = await getPageAccessToken(context, input.pageId);
  const maxResults = clampLimit(input.maxResults);
  const params: Record<string, string | number | undefined> = {
    fields:
      'id,created_time,ad_id,ad_name,adset_id,campaign_id,form_id,platform,is_organic,partner_name,field_data,custom_disclaimer_responses',
    limit: maxResults,
  };
  if (input.since) {
    // Graph uses `filtering=[{field:"time_created", operator:"GREATER_THAN", value:<unix>}]`
    // for incremental queries. We accept ISO and convert.
    const since = Date.parse(input.since);
    if (Number.isFinite(since)) {
      const unix = Math.floor(since / 1000);
      params.filtering = JSON.stringify([
        { field: 'time_created', operator: 'GREATER_THAN', value: unix },
      ]);
    }
  }
  return followPaginated<LeadNode, MetaLead>(
    `/${encodeURIComponent(input.formId)}/leads`,
    params,
    pageToken,
    toLead,
    maxResults,
  );
};

export const getLead = async (
  context: InternalToolContext,
  input: { leadId: string; pageId?: string },
): Promise<MetaLead> => {
  const token = input.pageId
    ? await getPageAccessToken(context, input.pageId)
    : await getCachedUserAccessToken(context);
  const node = await requestGraph<LeadNode>(
    `/${encodeURIComponent(input.leadId)}`,
    {
      fields:
        'id,created_time,ad_id,ad_name,adset_id,campaign_id,form_id,platform,is_organic,partner_name,field_data,custom_disclaimer_responses',
    },
    token,
  );
  const lead = toLead(node);
  if (!lead) {
    throw new MetaApiError(
      'Meta devolvio un lead invalido.',
      'meta_lead_response_invalid',
      null,
    );
  }
  return lead;
};
