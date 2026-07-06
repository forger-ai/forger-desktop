import type { CallOfficialToolInput, CallOfficialToolResult } from '../../../../shared/types';
import {
  OAUTH_ACCESS_TOKEN_SECRET,
} from '../../self-oauth';
import type { InternalToolContext } from '../../types';
import { clean, record, req } from '../helpers';
import { createPausedCampaign, updateCampaign } from './campaigns';
import { AD_ACCOUNT_ID_SECRET, ID, adAccount, graph, withParams } from './client';

const dataList = (value: unknown): unknown[] => Array.isArray(record(value).data) ? record(value).data as unknown[] : [];
const limit = (input: Record<string, unknown>, fallback = 25): number =>
  typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.min(100, Math.max(1, Math.round(input.limit))) : fallback;

export const executeMetaAds = async (
  input: CallOfficialToolInput,
  context: InternalToolContext,
): Promise<CallOfficialToolResult> => {
  const actionInput = input.input && typeof input.input === 'object' && !Array.isArray(input.input) ? input.input as Record<string, unknown> : {};
  const account = adAccount(clean(await context.secretsStore.getToolSecret(ID, AD_ACCOUNT_ID_SECRET)));
  try {
    if (input.actionId === 'meta_ads.connection.status') return { success: true, data: { connected: Boolean(await context.secretsStore.getToolSecret(ID, OAUTH_ACCESS_TOKEN_SECRET)), accountIdentity: { workspace: account } } };
    if (input.actionId === 'meta_ads.list_ad_accounts') return { success: true, data: { adAccounts: dataList(await graph(context, `/me/adaccounts?fields=id,name,account_status,currency&limit=${limit(actionInput)}`)) } };
    if (input.actionId === 'meta_ads.list_campaigns') return { success: true, data: { campaigns: dataList(await graph(context, `/${account}/campaigns?fields=id,name,status,effective_status,objective&limit=${limit(actionInput)}`)) } };
    if (input.actionId === 'meta_ads.get_campaign') return await getById(context, actionInput, 'campaignId', 'campaign', 'id,name,status,effective_status,objective');
    if (input.actionId === 'meta_ads.get_insights') return { success: true, data: { insights: dataList(await graph(context, `/${clean(actionInput.objectId) || account}/insights?fields=campaign_id,campaign_name,impressions,clicks,spend&date_preset=${clean(actionInput.datePreset) || 'last_7d'}`)) } };
    if (input.actionId === 'meta_ads.create_campaign_paused') return createPausedCampaign(context, account, actionInput);
    if (input.actionId === 'meta_ads.update_campaign') return updateCampaign(context, actionInput);
    if (input.actionId === 'meta_ads.pause_campaign') return await pauseCampaign(context, actionInput);
    if (input.actionId === 'meta_ads.list_pages') return { success: true, data: { pages: dataList(await graph(context, `/me/accounts?fields=id,name,category,tasks&limit=${limit(actionInput)}`)) } };
    if (input.actionId === 'meta_ads.list_leadgen_forms') return await listForms(context, actionInput);
    if (input.actionId === 'meta_ads.list_form_leads') return await listLeads(context, actionInput, 'formId');
    if (input.actionId === 'meta_ads.get_lead') return await getById(context, actionInput, 'leadId', 'lead', 'id,created_time,field_data,ad_id,form_id,platform');
    if (input.actionId === 'meta_ads.list_ad_leads') return await listLeads(context, actionInput, 'adId');
    return { success: false, userMessage: 'La accion de Meta Ads no esta disponible.', technicalCode: 'meta_ads_action_unknown' };
  } catch (error) {
    return { success: false, userMessage: 'No pudimos completar la accion de Meta Ads.', technicalCode: error instanceof Error ? error.message : 'meta_ads_action_failed' };
  }
};

const getById = async (context: InternalToolContext, input: Record<string, unknown>, key: string, out: string, fields: string) => {
  const id = req(input, key, `meta_ads_${key}_required`);
  return typeof id === 'string' ? { success: true, data: { [out]: await graph(context, `/${id}?fields=${fields}`) } } : id;
};

const pauseCampaign = async (context: InternalToolContext, input: Record<string, unknown>) => {
  const id = req(input, 'campaignId', 'meta_ads_campaign_required');
  if (typeof id !== 'string') return id;
  await graph(context, `/${id}`, { method: 'POST', body: JSON.stringify({ status: 'PAUSED' }) });
  return { success: true, data: { paused: true } };
};

const listForms = async (context: InternalToolContext, input: Record<string, unknown>) => {
  const pageId = req(input, 'pageId', 'meta_ads_page_required');
  if (typeof pageId !== 'string') return pageId;
  const path = withParams(`/${pageId}/leadgen_forms`, { fields: 'id,name,status,leads_count,created_time', limit: limit(input) });
  return { success: true, data: { forms: dataList(await graph(context, path)) } };
};

const listLeads = async (context: InternalToolContext, input: Record<string, unknown>, key: 'formId' | 'adId') => {
  const id = req(input, key, `meta_ads_${key}_required`);
  if (typeof id !== 'string') return id;
  const path = withParams(`/${id}/leads`, { fields: 'id,created_time,field_data,ad_id,form_id,platform', limit: limit(input), after: clean(input.after), since: clean(input.since), until: clean(input.until) });
  return { success: true, data: { leads: dataList(await graph(context, path)) } };
};
