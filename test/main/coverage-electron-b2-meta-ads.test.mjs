import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const selfOAuth = require('../../dist-electron/main/tools/self-oauth.js');
const selfOAuthLoopback = require('../../dist-electron/main/tools/self-oauth/loopback.js');
const metaClient = require('../../dist-electron/main/connections/modules/token-service-connectors/meta-ads/client.js');
const { configureMetaAds } = require('../../dist-electron/main/connections/modules/token-service-connectors/meta-ads/configure.js');
const {
  createPausedCampaign,
  updateCampaign,
} = require('../../dist-electron/main/connections/modules/token-service-connectors/meta-ads/campaigns.js');

const createSecretsContext = (initial = {}) => {
  const secrets = new Map(Object.entries(initial));
  const reads = [];
  const writes = [];
  return {
    reads,
    secrets,
    writes,
    context: {
      secretsStore: {
        getToolSecret: async (toolId, key) => {
          reads.push([toolId, key]);
          return secrets.get(key);
        },
        setToolSecret: async (toolId, key, value) => {
          writes.push([toolId, key, value]);
          secrets.set(key, value);
          return { success: true, userMessage: 'saved' };
        },
      },
    },
  };
};

test('Meta Ads configuration rejects incomplete credentials and accepts an explicitly supplied access token', async () => {
  const missing = createSecretsContext();
  assert.deepEqual(await configureMetaAds(missing.context), {
    success: false,
    userMessage: 'Completa client ID, client secret y Ad Account ID de Meta Ads.',
    technicalCode: 'meta_ads_oauth_credentials_required',
  });

  const direct = createSecretsContext();
  const result = await configureMetaAds(direct.context, {
    secrets: {
      [selfOAuth.OAUTH_CLIENT_ID_SECRET]: ' client-1 ',
      [selfOAuth.OAUTH_CLIENT_SECRET_SECRET]: ' secret-1 ',
      [metaClient.AD_ACCOUNT_ID_SECRET]: ' act-1 ',
      [metaClient.API_VERSION_SECRET]: ' v24.0 ',
      [selfOAuth.OAUTH_ACCESS_TOKEN_SECRET]: ' token-1 ',
    },
  });
  assert.deepEqual(result, { success: true, userMessage: 'Meta Ads conectado.' });
  assert.equal(direct.reads.length, 0);
  assert.deepEqual(direct.writes.slice(0, 5).map((entry) => entry.slice(0, 2)), [
    [metaClient.ID, selfOAuth.OAUTH_CLIENT_ID_SECRET],
    [metaClient.ID, selfOAuth.OAUTH_CLIENT_SECRET_SECRET],
    [metaClient.ID, metaClient.AD_ACCOUNT_ID_SECRET],
    [metaClient.ID, metaClient.API_VERSION_SECRET],
    [metaClient.ID, selfOAuth.OAUTH_ACCESS_TOKEN_SECRET],
  ]);
  assert.match(direct.secrets.get(selfOAuth.OAUTH_ACCESS_TOKEN_EXPIRES_AT_SECRET), /^\d+$/);
});

test('Meta Ads configuration reuses stored credentials and starts OAuth when no access token is supplied', async () => {
  const harness = createSecretsContext({
    [selfOAuth.OAUTH_CLIENT_ID_SECRET]: 'stored-client',
    [selfOAuth.OAUTH_CLIENT_SECRET_SECRET]: 'stored-secret',
    [metaClient.AD_ACCOUNT_ID_SECRET]: 'stored-account',
  });
  const originalVersion = metaClient.version;
  const originalRunLoopbackOAuthFlow = selfOAuthLoopback.runLoopbackOAuthFlow;
  const oauthCalls = [];
  metaClient.version = async () => 'v99.0';
  selfOAuthLoopback.runLoopbackOAuthFlow = async (context, input) => {
    oauthCalls.push([context, input]);
  };
  try {
    assert.deepEqual(await configureMetaAds(harness.context, { secrets: {} }), {
      success: true,
      userMessage: 'Meta Ads conectado.',
    });
  } finally {
    metaClient.version = originalVersion;
    selfOAuthLoopback.runLoopbackOAuthFlow = originalRunLoopbackOAuthFlow;
  }

  assert.equal(harness.reads.length, 3);
  assert.deepEqual(oauthCalls, [[harness.context, {
    toolId: metaClient.ID,
    clientId: 'stored-client',
    clientSecret: 'stored-secret',
    authUrl: 'https://www.facebook.com/v99.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v99.0/oauth/access_token',
    callbackPath: '/oauth/meta_ads/callback',
    scopes: metaClient.META_SCOPES,
    requireRefreshToken: false,
  }]]);
});

test('Meta Ads campaign creation validates required fields and never permits an active initial status', async () => {
  const originalGraph = metaClient.graph;
  const graphCalls = [];
  metaClient.graph = async (...args) => {
    graphCalls.push(args);
    return { id: 'campaign-1' };
  };
  try {
    assert.equal((await createPausedCampaign({}, 'act-1', {})).technicalCode, 'meta_ads_name_required');
    assert.equal((await createPausedCampaign({}, 'act-1', { name: 'Launch' })).technicalCode, 'meta_ads_objective_required');
    assert.equal((await createPausedCampaign({}, 'act-1', {
      name: 'Launch', objective: 'TRAFFIC', status: 'ACTIVE',
    })).technicalCode, 'meta_ads_active_status_rejected');

    const withoutCategories = await createPausedCampaign({}, 'act-1', {
      name: 'Launch', objective: 'TRAFFIC', status: '', specialAdCategories: 'none',
    });
    const withCategories = await createPausedCampaign({}, 'act-1', {
      name: 'Launch 2', objective: 'AWARENESS', status: ' paused ', specialAdCategories: ['HOUSING'],
    });
    assert.equal(withoutCategories.success, true);
    assert.equal(withCategories.success, true);
  } finally {
    metaClient.graph = originalGraph;
  }

  assert.deepEqual(graphCalls.map((call) => [call[1], JSON.parse(call[2].body)]), [
    ['/act-1/campaigns', { name: 'Launch', objective: 'TRAFFIC', status: 'PAUSED', special_ad_categories: [] }],
    ['/act-1/campaigns', { name: 'Launch 2', objective: 'AWARENESS', status: 'PAUSED', special_ad_categories: ['HOUSING'] }],
  ]);
});

test('Meta Ads campaign updates validate identity and preserve paused-by-default safety', async () => {
  const originalGraph = metaClient.graph;
  const graphCalls = [];
  metaClient.graph = async (...args) => {
    graphCalls.push(args);
    return { id: 'campaign-1' };
  };
  try {
    assert.equal((await updateCampaign({}, {})).technicalCode, 'meta_ads_campaign_required');
    assert.equal((await updateCampaign({}, { campaignId: 'campaign-1', status: 'ACTIVE' })).technicalCode, 'meta_ads_active_status_rejected');
    assert.equal((await updateCampaign({}, { campaignId: 'campaign-1', name: ' ' })).success, true);
    assert.equal((await updateCampaign({}, {
      campaignId: 'campaign-1', name: ' New name ', status: 'paused',
    })).success, true);
  } finally {
    metaClient.graph = originalGraph;
  }

  assert.deepEqual(graphCalls.map((call) => JSON.parse(call[2].body)), [
    {},
    { name: 'New name', status: 'PAUSED' },
  ]);
});
