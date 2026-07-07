import type { OfficialToolActionDefinition, OfficialToolDefinition } from '../../../../../shared/types';
import {
  OAUTH_CLIENT_ID_SECRET,
  OAUTH_CLIENT_SECRET_SECRET,
} from '../../../../tools/self-oauth';
import { objectSchema, schema, secret } from '../helpers';
import { AD_ACCOUNT_ID_SECRET, API_VERSION_SECRET, ID } from './client';

const action = (
  id: string,
  name: string,
  description: string,
  risk: OfficialToolActionDefinition['risk'],
  inputSchema?: Record<string, unknown>,
  outputSchema?: Record<string, unknown>,
): OfficialToolActionDefinition => ({ id, name, description, risk, ...(inputSchema ? { inputSchema } : {}), ...(outputSchema ? { outputSchema } : {}) });

const listOutput = (key: string) => schema({ [key]: { type: 'array', items: { type: 'object' } } }, [key]);

export const metaAdsDefinition: OfficialToolDefinition = {
  id: ID, name: 'Meta Ads', description: 'Lee campañas y leads de Meta Ads con OAuth self-managed.', version: '0.1.0',
  runtime: 'builtin', official: true,
  secrets: [
    { ...secret(OAUTH_CLIENT_ID_SECRET, 'OAuth client ID de Meta', 'Client ID de tu app de Meta.'), manual: true },
    { ...secret(OAUTH_CLIENT_SECRET_SECRET, 'OAuth client secret de Meta', 'Client secret de tu app de Meta.'), manual: true },
    { ...secret(AD_ACCOUNT_ID_SECRET, 'Ad Account ID', 'ID de cuenta publicitaria con o sin act_.'), manual: true },
    { ...secret(API_VERSION_SECRET, 'Version Graph API', 'Si se deja vacia usa v23.0.', false), manual: true },
  ],
  actions: [
    action('meta_ads.connection.status', 'Estado de conexion', 'Revisa si Meta Ads esta conectado.', 'low', undefined, schema({ connected: { type: 'boolean' } }, ['connected'])),
    action('meta_ads.list_ad_accounts', 'Listar cuentas publicitarias', 'Lista cuentas visibles.', 'medium', schema({ limit: { type: 'number' } }), listOutput('adAccounts')),
    action('meta_ads.list_campaigns', 'Listar campañas', 'Lista campañas.', 'medium', schema({ limit: { type: 'number' } }), listOutput('campaigns')),
    action('meta_ads.get_campaign', 'Leer campaña', 'Obtiene una campaña.', 'medium', schema({ campaignId: { type: 'string' } }, ['campaignId']), objectSchema('campaign')),
    action('meta_ads.get_insights', 'Leer insights', 'Obtiene insights.', 'medium', schema({ objectId: { type: 'string' }, datePreset: { type: 'string' } }), listOutput('insights')),
    action('meta_ads.create_campaign_paused', 'Crear campaña pausada', 'Crea campaña siempre PAUSED.', 'high', schema({ name: { type: 'string' }, objective: { type: 'string' }, specialAdCategories: { type: 'array', items: { type: 'string' } }, status: { type: 'string' } }, ['name', 'objective']), objectSchema('campaign')),
    action('meta_ads.update_campaign', 'Actualizar campaña', 'Actualiza campaña sin activarla.', 'high', schema({ campaignId: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' } }, ['campaignId']), objectSchema('campaign')),
    action('meta_ads.pause_campaign', 'Pausar campaña', 'Pausa una campaña.', 'high', schema({ campaignId: { type: 'string' } }, ['campaignId']), schema({ paused: { type: 'boolean' } }, ['paused'])),
    action('meta_ads.list_pages', 'Listar paginas', 'Lista paginas visibles para recuperar formularios.', 'high', schema({ limit: { type: 'number' } }), listOutput('pages')),
    action('meta_ads.list_leadgen_forms', 'Listar formularios de leads', 'Lista formularios Lead Ads de una pagina.', 'high', schema({ pageId: { type: 'string' }, limit: { type: 'number' } }, ['pageId']), listOutput('forms')),
    action('meta_ads.list_form_leads', 'Listar leads de formulario', 'Lee leads capturados por un formulario.', 'high', schema({ formId: { type: 'string' }, limit: { type: 'number' }, after: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' } }, ['formId']), listOutput('leads')),
    action('meta_ads.get_lead', 'Leer lead', 'Lee un lead por ID.', 'high', schema({ leadId: { type: 'string' } }, ['leadId']), objectSchema('lead')),
    action('meta_ads.list_ad_leads', 'Listar leads de anuncio', 'Lee leads asociados a un anuncio.', 'high', schema({ adId: { type: 'string' }, limit: { type: 'number' }, after: { type: 'string' } }, ['adId']), listOutput('leads')),
  ],
  changelog: ['Conector OAuth self-managed de Meta Ads con lectura de leads.'],
};
