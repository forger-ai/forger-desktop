import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helpers = require('../../dist-electron/main/connections/modules/token-service-connectors/helpers.js');
const metaClient = require('../../dist-electron/main/connections/modules/token-service-connectors/meta-ads/client.js');
const metaCampaigns = require('../../dist-electron/main/connections/modules/token-service-connectors/meta-ads/campaigns.js');
const { executeMetaAds } = require('../../dist-electron/main/connections/modules/token-service-connectors/meta-ads/actions.js');
const { getSlackConnectionStatus, slackToolModule } = require('../../dist-electron/main/connections/modules/slack/index.js');
const grants = require('../../dist-electron/main/connections/grants.js');
const { ConnectorApiError } = require('../../dist-electron/main/connections/modules/token-connector.js');

const createContext = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    secretsStore: {
      getToolSecret: async (toolId, key) => values.get(`${toolId}:${key}`) ?? values.get(key) ?? null,
      setToolSecret: async (toolId, key, value) => {
        values.set(`${toolId}:${key}`, value);
        return { success: true };
      },
    },
  };
};

const slackContext = (token = 'xoxb-test') => createContext({ 'slack:bot_token': token });

const runSlack = (actionId, input = {}, context = slackContext()) =>
  slackToolModule.execute({ toolId: 'slack', actionId, input }, context);

const response = (payload, status = 200, rejectJson = false) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => rejectJson ? Promise.reject(new Error('invalid json')) : payload,
});

const withFetch = async (handler, action) => {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
};

test('token connector helpers normalize schemas, required values, credentials, hosts, proof, and errors', async () => {
  assert.equal(helpers.clean(' value '), 'value');
  assert.equal(helpers.clean(42), '');
  assert.deepEqual(helpers.record({ value: 1 }), { value: 1 });
  assert.deepEqual(helpers.record([]), {});
  assert.deepEqual(helpers.list([1]), [1]);
  assert.deepEqual(helpers.list({}), []);
  assert.equal(helpers.limit(3.6), 4);
  assert.equal(helpers.limit(Number.NaN, 12), 12);
  assert.equal(helpers.limit(-10), 1);
  assert.equal(helpers.limit(500), 100);
  assert.deepEqual(helpers.schema(), { type: 'object', properties: {} });
  assert.deepEqual(helpers.schema({ id: { type: 'string' } }, ['id']).required, ['id']);
  assert.equal(helpers.arraySchema('items').properties.items.type, 'array');
  assert.equal(helpers.objectSchema().properties.item.type, 'object');
  assert.equal(helpers.objectSchema('record').properties.record.type, 'object');
  assert.equal(helpers.secret('token', 'Token', 'Usage').required, true);
  assert.equal(helpers.secret('token', 'Token', 'Usage', false).required, false);
  assert.equal((await helpers.status('demo', 'Demo').run()).data.connected, true);
  assert.equal(helpers.fail('missing').userMessage, 'Completa los campos requeridos.');
  assert.equal(helpers.fail('missing', 'Custom').userMessage, 'Custom');
  assert.equal(helpers.req({ value: ' ok ' }, 'value', 'missing'), 'ok');
  assert.equal(helpers.req({}, 'value', 'missing').technicalCode, 'missing');
  assert.equal(helpers.reqNum({ count: 2.6 }, 'count', 'missing'), 3);
  assert.equal(helpers.reqNum({ count: ' 4 ' }, 'count', 'missing'), 4);
  assert.equal(helpers.reqNum({ count: 0 }, 'count', 'missing').technicalCode, 'missing');
  assert.equal(helpers.basic('user', 'pass'), 'Basic dXNlcjpwYXNz');
  assert.equal(helpers.host(' https://example.test/// '), 'example.test');
  assert.equal(helpers.proof('token'), undefined);
  assert.match(helpers.proof('token', 'secret'), /^[0-9a-f]{64}$/);
  assert.equal(helpers.resultError('Demo', new ConnectorApiError('api_code'), 'fallback').technicalCode, 'api_code');
  assert.equal(helpers.resultError('Demo', new Error('boom'), 'fallback').technicalCode, 'boom');
  assert.equal(helpers.resultError('Demo', 'boom', 'fallback').technicalCode, 'fallback');
});

test('token connector HTTP helpers set safe content types, filter forms, and map response failures', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push([String(url), init]);
    if (String(url).endsWith('/empty')) return response({}, 204);
    if (String(url).endsWith('/invalid')) return response({}, 200, true);
    if (String(url).endsWith('/failed')) return response({ message: 'private' }, 429);
    return response({ ok: true });
  }, async () => {
    assert.deepEqual(await helpers.json('https://api.test/json', { method: 'POST', body: '{}' }, 'demo'), { ok: true });
    assert.deepEqual(await helpers.json('https://api.test/empty', { method: 'POST' }, 'demo'), {});
    assert.deepEqual(await helpers.json('https://api.test/invalid', { headers: { 'content-type': 'custom' } }, 'demo'), {});
    await assert.rejects(() => helpers.json('https://api.test/failed', {}, 'demo'), (error) => error.technicalCode === 'demo_http_429');
    const form = new FormData();
    form.append('file', new Blob(['data']), 'file.txt');
    await helpers.json('https://api.test/form-data', { method: 'POST', body: form }, 'demo');
    await helpers.form('https://api.test/form', { kept: 3, empty: '', absent: undefined }, { authorization: 'Bearer test' }, 'demo');
  });
  assert.equal(new Headers(calls[0][1].headers).get('content-type'), 'application/json; charset=utf-8');
  assert.equal(new Headers(calls[4][1].headers).has('content-type'), false);
  assert.equal(String(calls[5][1].body), 'kept=3');
});

test('module helper wraps validation success and both connector and generic failures', async () => {
  const context = createContext();
  for (const [validate, expected] of [
    [async () => ({ ok: true, data: { account: 'ok' } }), undefined],
    [async () => { throw new ConnectorApiError('demo_validation_api'); }, 'demo_validation_api'],
    [async () => { throw new Error('boom'); }, 'demo_validation_failed'],
  ]) {
    const module = helpers.moduleFrom({
      id: 'demo', name: 'Demo', description: 'Demo connector', secrets: [], validate, actions: [],
    });
    const configured = await module.configure(context, { toolId: 'demo' });
    assert.equal(configured.technicalCode, expected);
  }
});

test('Meta Ads actions cover reads, writes, pagination, validation, unknown actions, and failures', async () => {
  const context = createContext({ ad_account_id: ' 123 ' });
  const originalGraph = metaClient.graph;
  const originalCreate = metaCampaigns.createPausedCampaign;
  const originalUpdate = metaCampaigns.updateCampaign;
  const calls = [];
  metaClient.graph = async (_context, target, init) => {
    calls.push([target, init]);
    return target.includes('empty') ? {} : { data: [{ id: 'one' }] };
  };
  metaCampaigns.createPausedCampaign = async () => ({ success: true, data: { created: true } });
  metaCampaigns.updateCampaign = async () => ({ success: true, data: { updated: true } });
  const invoke = (actionId, input = {}) => executeMetaAds({ toolId: 'meta_ads', actionId, input }, context);
  try {
    assert.equal((await invoke('meta_ads.connection.status')).success, true);
    assert.equal((await invoke('meta_ads.list_ad_accounts', { limit: Number.NaN })).data.adAccounts.length, 1);
    assert.equal((await invoke('meta_ads.list_campaigns', { limit: -10 })).data.campaigns.length, 1);
    assert.equal((await invoke('meta_ads.get_campaign', { campaignId: 'campaign-1' })).success, true);
    assert.equal((await invoke('meta_ads.get_campaign')).technicalCode, 'meta_ads_campaignId_required');
    assert.equal((await invoke('meta_ads.get_insights', { objectId: ' ', datePreset: '' })).success, true);
    assert.equal((await invoke('meta_ads.create_campaign_paused')).data.created, true);
    assert.equal((await invoke('meta_ads.update_campaign')).data.updated, true);
    assert.equal((await invoke('meta_ads.pause_campaign', { campaignId: 'campaign-1' })).data.paused, true);
    assert.equal((await invoke('meta_ads.pause_campaign')).technicalCode, 'meta_ads_campaign_required');
    assert.equal((await invoke('meta_ads.list_pages', { limit: 500 })).data.pages.length, 1);
    metaClient.graph = async () => ({});
    assert.deepEqual((await invoke('meta_ads.list_pages')).data.pages, []);
    metaClient.graph = async (_context, target, init) => {
      calls.push([target, init]);
      return { data: [{ id: 'one' }] };
    };
    assert.equal((await invoke('meta_ads.list_leadgen_forms', { pageId: 'page-1', limit: 10 })).data.forms.length, 1);
    assert.equal((await invoke('meta_ads.list_leadgen_forms')).technicalCode, 'meta_ads_page_required');
    assert.equal((await invoke('meta_ads.list_form_leads', { formId: 'form-1', after: ' next ', since: 'a', until: 'b' })).data.leads.length, 1);
    assert.equal((await invoke('meta_ads.list_form_leads')).technicalCode, 'meta_ads_formId_required');
    assert.equal((await invoke('meta_ads.get_lead', { leadId: 'lead-1' })).success, true);
    assert.equal((await invoke('meta_ads.list_ad_leads', { adId: 'ad-1' })).success, true);
    assert.equal((await invoke('meta_ads.unknown')).technicalCode, 'meta_ads_action_unknown');
    assert.equal((await executeMetaAds({ toolId: 'meta_ads', actionId: 'meta_ads.unknown', input: [] }, context)).success, false);

    metaClient.graph = async () => { throw 'failure'; };
    assert.equal((await invoke('meta_ads.list_pages')).technicalCode, 'meta_ads_action_failed');
    metaClient.graph = async () => { throw new Error('graph failed'); };
    assert.equal((await invoke('meta_ads.list_pages')).technicalCode, 'graph failed');
  } finally {
    metaClient.graph = originalGraph;
    metaCampaigns.createPausedCampaign = originalCreate;
    metaCampaigns.updateCampaign = originalUpdate;
  }
  assert.equal(calls.some(([target, init]) => target === '/campaign-1' && init?.method === 'POST'), true);
});

test('Slack maps HTTP, API, validation, list, read, and send edge cases without leaking tokens', async () => {
  const context = slackContext();
  await withFetch(async () => response({}, 503), async () => {
    assert.equal((await slackToolModule.configure(context, { toolId: 'slack', secrets: { bot_token: 'bad' } })).technicalCode, 'slack_http_503');
  });
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.equal((await slackToolModule.configure(context, { toolId: 'slack', secrets: { bot_token: 'bad' } })).technicalCode, 'slack_validation_failed');
  });
  await withFetch(async () => response({ ok: true, team: 42, user: 42 }), async () => {
    assert.equal((await slackToolModule.configure(context, { toolId: 'slack', secrets: { bot_token: 'ok' } })).success, true);
  });

  await withFetch(async () => response({ ok: true }), async () => {
    assert.deepEqual((await runSlack('slack.list_channels', { limit: 500 }, context)).data.channels, []);
    assert.deepEqual((await runSlack('slack.read_messages', { channelId: ' C1 ', limit: -4 }, context)).data.messages, []);
  });
  assert.equal((await runSlack('slack.read_messages', { channelId: 42 }, context)).technicalCode, 'slack_channel_required');

  await withFetch(async () => { throw 'offline'; }, async () => {
    assert.equal((await runSlack('slack.list_channels', {}, context)).technicalCode, 'slack_list_channels_failed');
  });
  await withFetch(async () => { throw new Error('read failed'); }, async () => {
    assert.equal((await runSlack('slack.read_messages', { channelId: 'C1' }, context)).technicalCode, 'read failed');
  });
  await withFetch(async () => response({ ok: false }), async () => {
    assert.equal((await runSlack('slack.send_message', { channelId: 'C1', text: 'hello' }, context)).technicalCode, 'slack_api_unknown_error');
  });
  assert.equal((await getSlackConnectionStatus()).data.connected, true);
});

test('connection grants normalize malformed buckets, merge declarations, and preserve snapshot defaults', () => {
  assert.deepEqual(grants.normalizeAppConnectionDeclarations([]), { required: [], optional: [] });
  const normalized = grants.normalizeAppConnectionDeclarations({
    required: [
      null,
      { type: 42, reason: 'invalid', actions: [] },
      { type: 'demo', reason: '', actions: ['read'] },
      { type: 'demo', reason: 'Invalid actions', actions: 'read' },
      { type: 'demo', reason: 'First', actions: ['read', '', 42], multiple: false },
      { type: 'demo', reason: 'Second', actions: ['write', 'read'], multiple: true },
    ],
    optional: 'invalid',
  });
  assert.deepEqual(normalized.required, [{
    type: 'demo', reason: 'First', actions: ['read', 'write'], multiple: true,
  }]);
  assert.deepEqual(grants.resolveGrantActions({ type: 'missing', requestedActions: ['*'], resolvedActions: ['old'] }, {}), []);
  assert.deepEqual(grants.resolveGrantActions({ type: 'demo', requestedActions: ['read'], resolvedActions: ['read'] }, {}), ['read']);

  const snapshot = grants.resolveConnectionActionSnapshot({
    type: 'demo', reason: 'Use demo', actions: ['read', 'missing', 'read'], multiple: false,
  }, { demo: ['read'] }, { approvedAt: '2026-08-10T00:00:00.000Z', connectionIds: ['one'] });
  assert.deepEqual(snapshot.resolvedActions, ['read']);
  assert.equal(snapshot.approvedAt, '2026-08-10T00:00:00.000Z');
  assert.deepEqual(snapshot.connectionIds, ['one']);
  assert.equal(grants.connectionGrantAllowsAction(snapshot, 'read'), true);
  assert.equal(grants.connectionGrantAllowsAction({ ...snapshot, requestedActions: ['*'] }, 'read'), false);
  assert.deepEqual(grants.resolveConnectionActionSnapshot({
    type: 'missing', reason: 'Missing catalog', actions: ['read'], multiple: false,
  }, {}).resolvedActions, []);
});
