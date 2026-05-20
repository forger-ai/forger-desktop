export const META_TOOL_ID = 'meta';
export const META_USER_TOKEN_SECRET = 'oauth_user_access_token';
export const META_GRAPH_API_VERSION = 'v23.0';

// Lead Ads read flow. Page management/write scopes are intentionally not
// included — this tool is read-only over leads and the pages that host
// them. Add scopes here only when a corresponding action is exposed below.
export const META_SCOPES = [
  'public_profile',
  'pages_show_list',
  'pages_read_engagement',
  'leads_retrieval',
] as const;

export interface MetaListPagesInput {
  // No input — returns all Pages the user manages. Filtering by name happens
  // client-side after the call.
}

export interface MetaListLeadFormsInput {
  pageId: string;
  // Filter to forms that have at least one lead since this ISO timestamp.
  modifiedSince?: string;
  maxResults?: number;
}

export interface MetaSyncLeadsInput {
  formId: string;
  pageId: string;
  // ISO timestamp. The agent should pass the `last_synced_at` of the
  // mapping it persists locally, so this call returns only fresh leads.
  // If omitted, defaults to fetching the last 30 days.
  since?: string;
  maxResults?: number;
}

export interface MetaGetLeadInput {
  leadId: string;
  // Optional: when provided, page access token resolution is faster. If
  // missing, the tool resolves the lead's owning Page via the Graph API
  // first.
  pageId?: string;
}

export interface MetaPageSummary {
  id: string;
  name: string;
  category?: string;
  // tasks the user holds on this Page; Lead Ads access requires
  // `LEADS` at minimum.
  tasks: string[];
}

export interface MetaLeadFormSummary {
  id: string;
  name: string;
  status: string; // ACTIVE | DRAFT | PAUSED | DELETED | ARCHIVED
  createdTime: string;
  leadsCount?: number;
}

export interface MetaLeadFieldValue {
  name: string;
  // Meta returns `values` as an array even for single-valued fields. We
  // surface the raw array; consumers (the agent) join when needed.
  values: string[];
}

export interface MetaLead {
  id: string;
  createdTime: string;
  formId: string;
  adId?: string;
  adName?: string;
  adsetId?: string;
  campaignId?: string;
  platform?: string;
  isOrganic?: boolean;
  partnerName?: string;
  fieldData: MetaLeadFieldValue[];
  customDisclaimerResponses?: MetaLeadFieldValue[];
}

export interface MetaTokenResponse {
  access_token?: string;
  token_type?: string;
  // Long-lived user tokens come back with an expiration ~60 days out.
  // Short-lived tokens from the initial code exchange have ~1-2 hours.
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}
