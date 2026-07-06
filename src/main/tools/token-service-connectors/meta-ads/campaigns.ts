import type { CallOfficialToolResult } from '../../../../shared/types';
import type { InternalToolContext } from '../../types';
import { clean, req } from '../helpers';
import { graph } from './client';

export const createPausedCampaign = async (
  context: InternalToolContext,
  account: string,
  input: Record<string, unknown>,
): Promise<CallOfficialToolResult> => {
  const name = req(input, 'name', 'meta_ads_name_required');
  const objective = req(input, 'objective', 'meta_ads_objective_required');
  if (typeof name !== 'string') return name;
  if (typeof objective !== 'string') return objective;
  if (clean(input.status) && clean(input.status).toUpperCase() !== 'PAUSED') {
    return { success: false, userMessage: 'Forger solo crea campañas pausadas.', technicalCode: 'meta_ads_active_status_rejected' };
  }
  const campaign = await graph(context, `/${account}/campaigns`, {
    method: 'POST',
    body: JSON.stringify({ name, objective, status: 'PAUSED', special_ad_categories: Array.isArray(input.specialAdCategories) ? input.specialAdCategories : [] }),
  });
  return { success: true, userMessage: 'Campaña creada en Meta Ads en estado pausado.', data: { campaign } };
};

export const updateCampaign = async (
  context: InternalToolContext,
  input: Record<string, unknown>,
): Promise<CallOfficialToolResult> => {
  const id = req(input, 'campaignId', 'meta_ads_campaign_required');
  if (typeof id !== 'string') return id;
  const requested = clean(input.status).toUpperCase();
  if (requested && requested !== 'PAUSED') {
    return { success: false, userMessage: 'Forger no activa campañas de Meta Ads.', technicalCode: 'meta_ads_active_status_rejected' };
  }
  const campaign = await graph(context, `/${id}`, { method: 'POST', body: JSON.stringify({ name: clean(input.name) || undefined, status: requested || undefined }) });
  return { success: true, data: { campaign } };
};
