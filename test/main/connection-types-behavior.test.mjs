import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ConnectionsService,
} = require('../../dist-electron/main/connections-service.js');

const createSecretsStore = () => {
  const values = new Map();
  return {
    values,
    async setConnectionSecret(connectionId, name, value) {
      values.set(`${connectionId}:${name}`, value);
      return { success: true, userMessage: 'ok' };
    },
    async getConnectionSecret(connectionId, name) {
      return values.get(`${connectionId}:${name}`) ?? null;
    },
    async hasConnectionSecret(connectionId, name) {
      return values.has(`${connectionId}:${name}`);
    },
    async deleteConnectionSecrets(connectionId) {
      for (const key of [...values.keys()]) {
        if (key.startsWith(`${connectionId}:`)) {
          values.delete(key);
        }
      }
      return { success: true, userMessage: 'ok' };
    },
  };
};

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const withMockedFetch = async (handler, operation) => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  try {
    return await operation(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const createService = async (options = {}) => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-connection-types-'));
  const secretsStore = createSecretsStore();
  const service = new ConnectionsService({ metadataRoot, secretsStore, ...options });
  await service.load();
  return {
    service,
    metadataRoot,
    secretsStore,
    cleanup: async () => {
      await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

test('built-in connection actions with user input declare inputSchema for workflow forms', async () => {
  const harness = await createService();
  try {
    const expectedActions = new Map([
      [
        'gmail',
        [
          'gmail.get_profile',
          'gmail.list_labels',
          'gmail.search_messages',
          'gmail.list_threads',
          'gmail.read_thread',
          'gmail.list_changes',
          'gmail.modify_thread',
          'gmail.move_thread',
          'gmail.read_attachment',
          'gmail.list_drafts',
          'gmail.get_draft',
          'gmail.save_draft',
          'gmail.delete_draft',
          'gmail.send_draft',
          'gmail.send_email',
        ],
      ],
      ['calendar', ['calendar.list_events', 'calendar.create_event', 'calendar.update_event', 'calendar.delete_event']],
      ['sheets', ['sheets.read_range', 'sheets.append_rows', 'sheets.update_range']],
      ['drive', ['drive.list_files', 'drive.download_file', 'drive.upload_file']],
      ['docs', ['docs.read_document', 'docs.create_document', 'docs.append_text', 'docs.replace_text']],
      ['github', ['github.list_repositories', 'github.search_issues', 'github.get_issue', 'github.create_issue', 'github.create_comment']],
      ['notion', ['notion.search', 'notion.get_page', 'notion.get_database', 'notion.query_database', 'notion.create_page', 'notion.update_page']],
      [
        'whatsapp',
        [
          'whatsapp.start_pairing',
          'whatsapp.list_chats',
          'whatsapp.read_messages',
          'whatsapp.download_attachment',
          'whatsapp.send_message',
          'whatsapp.get_chat_details',
        ],
      ],
      ['slack', ['slack.list_channels', 'slack.read_messages', 'slack.send_message']],
      [
        'trello',
        [
          'trello.list_lists',
          'trello.list_cards',
          'trello.filter_cards',
          'trello.create_card',
          'trello.update_card',
          'trello.delete_card',
          'trello.comment_card',
          'trello.list_card_attachments',
          'trello.download_attachment',
          'trello.upload_attachment',
        ],
      ],
      ['figma', ['figma.get_file', 'figma.get_file_nodes', 'figma.get_images', 'figma.get_comments', 'figma.create_comment', 'figma.delete_comment', 'figma.get_team_projects', 'figma.get_project_files']],
      ['zendesk', ['zendesk.search', 'zendesk.list_tickets', 'zendesk.get_ticket', 'zendesk.create_ticket', 'zendesk.update_ticket', 'zendesk.add_ticket_comment', 'zendesk.list_users']],
      ['discord', ['discord.list_guilds', 'discord.list_channels', 'discord.read_messages', 'discord.send_message', 'discord.create_channel', 'discord.create_thread', 'discord.add_reaction', 'discord.delete_message']],
      ['calendly', ['calendly.list_event_types', 'calendly.list_available_times', 'calendly.list_scheduled_events', 'calendly.get_event', 'calendly.list_invitees', 'calendly.cancel_event']],
      ['gitlab', ['gitlab.list_projects', 'gitlab.get_project', 'gitlab.list_issues', 'gitlab.get_issue', 'gitlab.create_issue', 'gitlab.update_issue', 'gitlab.create_issue_note', 'gitlab.list_merge_requests', 'gitlab.get_merge_request', 'gitlab.create_merge_request_note', 'gitlab.list_pipelines']],
      ['shopify', ['shopify.list_products', 'shopify.get_product', 'shopify.create_product', 'shopify.update_product', 'shopify.list_orders', 'shopify.get_order', 'shopify.list_customers', 'shopify.get_customer', 'shopify.create_draft_order', 'shopify.update_inventory_level']],
      ['whatsapp_business', ['whatsapp_business.list_phone_numbers', 'whatsapp_business.send_text_message', 'whatsapp_business.send_template_message', 'whatsapp_business.upload_media', 'whatsapp_business.send_media_message', 'whatsapp_business.mark_message_read', 'whatsapp_business.get_business_profile', 'whatsapp_business.update_business_profile']],
      ['telegram', ['telegram.get_updates', 'telegram.send_message', 'telegram.send_photo', 'telegram.send_document', 'telegram.edit_message_text', 'telegram.delete_message', 'telegram.answer_callback_query']],
      ['sendgrid', ['sendgrid.send_email', 'sendgrid.send_template_email', 'sendgrid.list_templates', 'sendgrid.get_template', 'sendgrid.list_contacts', 'sendgrid.upsert_contact', 'sendgrid.delete_contact', 'sendgrid.get_suppressions']],
      ['postmark', ['postmark.send_email', 'postmark.send_batch', 'postmark.list_templates', 'postmark.get_template', 'postmark.create_template', 'postmark.update_template', 'postmark.get_message', 'postmark.list_bounces']],
      ['twilio', ['twilio.send_sms', 'twilio.send_whatsapp_message', 'twilio.list_messages', 'twilio.get_message', 'twilio.create_call', 'twilio.list_calls', 'twilio.get_call']],
      ['meta_ads', ['meta_ads.list_ad_accounts', 'meta_ads.list_campaigns', 'meta_ads.get_campaign', 'meta_ads.get_insights', 'meta_ads.create_campaign_paused', 'meta_ads.update_campaign', 'meta_ads.pause_campaign', 'meta_ads.list_pages', 'meta_ads.list_leadgen_forms', 'meta_ads.list_form_leads', 'meta_ads.get_lead', 'meta_ads.list_ad_leads']],
    ]);
    const types = await harness.service.listTypes();
    for (const [type, actionIds] of expectedActions) {
      const definition = types.find((candidate) => candidate.type === type);
      assert.ok(definition, `${type} definition is available`);
      for (const actionId of actionIds) {
        const action = definition.actions.find((candidate) => candidate.id === actionId);
        assert.ok(action, `${actionId} action is available`);
        assert.equal(action.inputSchema?.type, 'object', `${actionId} exposes an object schema`);
        assert.ok(action.inputSchema.properties, `${actionId} exposes editable fields`);
      }
    }
  } finally {
    await harness.cleanup();
  }
});

test('new connection registry entries use self-managed setup and expose safe schemas', async () => {
  const harness = await createService();
  try {
    const definitions = new Map((await harness.service.listTypes()).map((definition) => [definition.type, definition]));
    for (const type of ['calendar', 'sheets', 'drive', 'docs', 'github']) {
      const definition = definitions.get(type);
      assert.ok(definition, `${type} definition is registered`);
      assert.equal(definition.setupKind, 'oauth');
      assert.equal(definition.supportsMultiple, true);
      assert.ok(definition.secretsSchema.some((secret) => secret.name === 'oauth_client_id' && secret.required), `${type} asks for a local OAuth client id`);
      assert.ok(definition.actions.some((action) => action.id === `${type}.connection.status`), `${type} has a status action`);
      assert.equal(JSON.stringify(definition).includes('refresh_token'), false, `${type} does not ask the renderer for refresh tokens`);
    }

    const notion = definitions.get('notion');
    assert.ok(notion, 'notion definition is registered');
    assert.equal(notion.setupKind, 'manual_secret');
    assert.ok(notion.secretsSchema.some((secret) => secret.name === 'integration_token' && secret.required));

    for (const type of ['figma', 'zendesk', 'discord', 'calendly', 'gitlab', 'shopify', 'whatsapp_business', 'telegram', 'sendgrid', 'postmark', 'twilio']) {
      const definition = definitions.get(type);
      assert.ok(definition, `${type} definition is registered`);
      assert.equal(definition.setupKind, 'manual_secret');
      assert.equal(definition.supportsMultiple, true);
      assert.ok(definition.secretsSchema.some((secret) => secret.required), `${type} asks for a local credential`);
      assert.ok(definition.actions.some((action) => action.id === `${type}.connection.status`), `${type} has a status action`);
    }

    const metaCreate = definitions.get('meta_ads').actions.find((action) => action.id === 'meta_ads.create_campaign_paused');
    assert.equal(definitions.get('meta_ads').setupKind, 'oauth');
    assert.ok(definitions.get('meta_ads').secretsSchema.some((secret) => secret.name === 'oauth_client_id' && secret.required));
    assert.equal(definitions.get('meta_ads').oauth.callbackPath, '/oauth/meta_ads/callback');
    assert.equal(definitions.get('meta_ads').oauth.requiresProviderRedirectConfig, true);
    assert.ok(definitions.get('meta_ads').oauth.scopes.includes('leads_retrieval'));
    assert.equal(metaCreate.risk, 'high');
    assert.equal(definitions.get('meta_ads').actions.find((action) => action.id === 'meta_ads.list_form_leads').risk, 'high');
  } finally {
    await harness.cleanup();
  }
});

test('OAuth connection definitions include the active local callback URL', async () => {
  const harness = await createService({
    selfOAuthCallbackService: {
      start: async () => undefined,
      stop: async () => undefined,
      getState: () => ({ baseUrl: 'http://127.0.0.1:43210', port: 43210, previousPort: 32109, portChanged: true }),
      callbackUrl: (callbackPath) => `http://127.0.0.1:43210${callbackPath}`,
      registerFlow: () => () => undefined,
    },
  });
  try {
    const meta = (await harness.service.listTypes()).find((definition) => definition.type === 'meta_ads');
    assert.equal(meta.oauth.callbackUrl, 'http://127.0.0.1:43210/oauth/meta_ads/callback');
    assert.equal(meta.oauth.previousCallbackUrl, 'http://127.0.0.1:32109/oauth/meta_ads/callback');
    assert.equal(meta.oauth.callbackPortChanged, true);
  } finally {
    await harness.cleanup();
  }
});

test('connection setup guides are localized and expose only safe setup values', async () => {
  const harness = await createService({
    selfOAuthCallbackService: {
      start: async () => undefined,
      stop: async () => undefined,
      getState: () => ({ baseUrl: 'http://127.0.0.1:43210', port: 43210, portChanged: false }),
      callbackUrl: (callbackPath) => `http://127.0.0.1:43210${callbackPath}`,
      registerFlow: () => () => undefined,
    },
  });
  try {
    const esTypes = await harness.service.listTypes('es');
    const enTypes = await harness.service.listTypes('en');
    for (const definition of esTypes) {
      assert.ok(definition.setupGuide, `${definition.type} has a setup guide`);
      assert.ok(definition.setupGuide.steps.length > 0, `${definition.type} guide has steps`);
      const guideText = JSON.stringify(definition.setupGuide);
      assert.equal(guideText.includes('refresh_token'), false, `${definition.type} guide does not leak refresh tokens`);
      assert.equal(guideText.includes('secret-value'), false, `${definition.type} guide does not leak secret values`);
    }
    const esByType = new Map(esTypes.map((definition) => [definition.type, definition]));
    const enByType = new Map(enTypes.map((definition) => [definition.type, definition]));
    assert.ok(esByType.get('drive').setupGuide.title.includes('Crear cliente OAuth'));
    assert.ok(enByType.get('drive').setupGuide.title.includes('Create an OAuth client'));
    assert.ok(esByType.get('drive').setupGuide.copyValues.some((value) =>
      value.kind === 'scope' && value.value === 'https://www.googleapis.com/auth/drive.file'));
    assert.ok(esByType.get('meta_ads').setupGuide.copyValues.some((value) =>
      value.kind === 'callback_url' && value.value === 'http://127.0.0.1:43210/oauth/meta_ads/callback'));
    assert.ok(esByType.get('meta_ads').setupGuide.copyValues.some((value) =>
      value.kind === 'scope' && value.value === 'leads_retrieval'));
    assert.ok(esByType.get('notion').setupGuide.copyValues.some((value) =>
      value.kind === 'field' && value.value.toLowerCase().includes('token')));
  } finally {
    await harness.cleanup();
  }
});

test('Meta Ads lead actions read pages, forms, and leads without leaking tokens', async () => {
  const harness = await createService();
  try {
    await withMockedFetch(
      (url, options) => {
        const textUrl = String(url);
        assert.equal(new Headers(options.headers).get('authorization'), 'Bearer meta-token');
        if (textUrl.includes('/me/accounts')) {
          assert.equal(textUrl.includes('access_token'), false);
          return jsonResponse({ data: [{ id: 'page-1', name: 'Forger Page' }] });
        }
        if (textUrl.includes('/page-1/leadgen_forms')) {
          return jsonResponse({ data: [{ id: 'form-1', name: 'Leads' }] });
        }
        if (textUrl.includes('/form-1/leads')) {
          return jsonResponse({ data: [{ id: 'lead-1', field_data: [{ name: 'email', values: ['person@example.com'] }] }] });
        }
        if (textUrl.includes('/lead-1?')) {
          return jsonResponse({ id: 'lead-1', field_data: [{ name: 'email', values: ['person@example.com'] }] });
        }
        return jsonResponse({ error: 'unexpected' }, 404);
      },
      async () => {
        const configured = await harness.service.configure({
          type: 'meta_ads',
          label: 'Meta',
          secrets: { oauth_client_id: 'meta-client', oauth_client_secret: 'meta-secret', oauth_access_token: 'meta-token', ad_account_id: 'act_123' },
        });
        assert.equal(configured.success, true);
        const pages = await harness.service.call({ type: 'meta_ads', connectionId: configured.instance.id, actionId: 'meta_ads.list_pages', input: {} });
        const forms = await harness.service.call({ type: 'meta_ads', connectionId: configured.instance.id, actionId: 'meta_ads.list_leadgen_forms', input: { pageId: 'page-1' } });
        const leads = await harness.service.call({ type: 'meta_ads', connectionId: configured.instance.id, actionId: 'meta_ads.list_form_leads', input: { formId: 'form-1' } });
        const lead = await harness.service.call({ type: 'meta_ads', connectionId: configured.instance.id, actionId: 'meta_ads.get_lead', input: { leadId: 'lead-1' } });
        assert.equal(pages.data.pages[0].id, 'page-1');
        assert.equal(forms.data.forms[0].id, 'form-1');
        assert.equal(leads.data.leads[0].field_data[0].values[0], 'person@example.com');
        assert.equal(lead.data.lead.id, 'lead-1');
        assert.equal(JSON.stringify({ configured, pages, forms, leads, lead }).includes('meta-token'), false);
      },
    );
  } finally {
    await harness.cleanup();
  }
});

test('Slack connection stores token per instance, exposes safe identity, and calls actions', async () => {
  const harness = await createService();
  try {
    await withMockedFetch(
      (url) => {
        if (url.endsWith('/auth.test')) {
          return jsonResponse({ ok: true, team: 'Forger HQ', user: 'forger-bot' });
        }
        if (url.endsWith('/conversations.list')) {
          return jsonResponse({ ok: true, channels: [{ id: 'C1', name: 'general', is_private: false, num_members: 4 }] });
        }
        return jsonResponse({ ok: false, error: 'unknown_method' });
      },
      async (calls) => {
        const configured = await harness.service.configure({
          type: 'slack',
          label: 'Workspace',
          secrets: { bot_token: ' xoxb-connection-token ' },
        });
        assert.equal(configured.success, true);
        assert.equal(configured.instance.accountIdentity.workspace, 'Forger HQ');
        assert.equal(configured.instance.accountIdentity.username, 'forger-bot');
        assert.equal(
          harness.secretsStore.values.get(`${configured.instance.id}:bot_token`),
          'xoxb-connection-token',
        );

        const status = await harness.service.call({
          type: 'slack',
          connectionId: configured.instance.id,
          actionId: 'slack.connection.status',
        });
        assert.equal(status.success, true);
        assert.equal(status.data.connected, true);
        assert.equal(status.data.accountIdentity.workspace, 'Forger HQ');

        const channels = await harness.service.call({
          type: 'slack',
          connectionId: configured.instance.id,
          actionId: 'slack.list_channels',
          input: {},
        });
        assert.equal(channels.success, true);
        assert.equal(channels.data.channels[0].name, 'general');
        const listCall = calls.find((call) => call.url.endsWith('/conversations.list'));
        assert.equal(listCall.options.headers.Authorization, 'Bearer xoxb-connection-token');
        assert.equal(JSON.stringify(status).includes('xoxb-connection-token'), false);
      },
    );
  } finally {
    await harness.cleanup();
  }
});

test('Trello connection supports independent accounts and create-card action', async () => {
  const harness = await createService();
  try {
    await withMockedFetch(
      (url, options) => {
        if (url.includes('/members/me')) {
          return jsonResponse({ username: 'felipe', fullName: 'Felipe Pezoa' });
        }
        if (url.includes('/cards') && options.method === 'POST') {
          return jsonResponse({ id: 'card-1', name: 'Nueva tarjeta', url: 'https://trello.com/c/card-1' });
        }
        return jsonResponse([]);
      },
      async () => {
        const configured = await harness.service.configure({
          type: 'trello',
          label: 'Trello personal',
          secrets: { api_key: 'key-1', api_token: 'token-1' },
        });
        assert.equal(configured.success, true);
        assert.equal(configured.instance.accountIdentity.username, 'felipe');

        const card = await harness.service.call({
          type: 'trello',
          connectionId: configured.instance.id,
          actionId: 'trello.create_card',
          input: { listId: 'list-1', name: 'Nueva tarjeta' },
        });
        assert.equal(card.success, true);
        assert.equal(card.data.id, 'card-1');
        assert.equal(JSON.stringify(card).includes('token-1'), false);
      },
    );
  } finally {
    await harness.cleanup();
  }
});

test('Notion token connection validates identity and calls page actions without leaking token', async () => {
  const harness = await createService();
  try {
    await withMockedFetch(
      (url, options) => {
        if (url.endsWith('/users/me')) {
          return jsonResponse({ id: 'bot-1', name: 'Forger Bot', type: 'bot' });
        }
        if (url.endsWith('/search')) {
          return jsonResponse({ results: [{ id: 'page-1', object: 'page' }] });
        }
        if (url.endsWith('/pages/page-1') && options.method === 'PATCH') {
          return jsonResponse({ id: 'page-1', archived: true });
        }
        return jsonResponse({ id: 'page-1' });
      },
      async (calls) => {
        const configured = await harness.service.configure({
          type: 'notion',
          label: 'Workspace docs',
          secrets: { integration_token: ' notion-secret ' },
        });
        assert.equal(configured.success, true);
        assert.equal(configured.instance.accountIdentity.username, 'Forger Bot');
        assert.equal(harness.secretsStore.values.get(`${configured.instance.id}:integration_token`), 'notion-secret');

        const search = await harness.service.call({
          type: 'notion',
          connectionId: configured.instance.id,
          actionId: 'notion.search',
          input: { query: 'roadmap' },
        });
        assert.equal(search.success, true);
        assert.equal(search.data.results[0].id, 'page-1');

        const update = await harness.service.call({
          type: 'notion',
          connectionId: configured.instance.id,
          actionId: 'notion.update_page',
          input: { pageId: 'page-1', archived: true },
        });
        assert.equal(update.success, true);
        assert.equal(update.data.id, 'page-1');

        const searchCall = calls.find((call) => call.url.endsWith('/search'));
        assert.equal(searchCall.options.headers.Authorization, 'Bearer notion-secret');
        assert.equal(JSON.stringify({ search, update, configured }).includes('notion-secret'), false);
      },
    );
  } finally {
    await harness.cleanup();
  }
});

test('Google workspace connections use stored self OAuth secrets and redact tokens from action output', async () => {
  const harness = await createService();
  try {
    await withMockedFetch(
      (url, _options) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return jsonResponse({ access_token: 'google-access-token', expires_in: 3600, token_type: 'Bearer' });
        }
        if (url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
          return jsonResponse({ id: 'google-subject', email: 'person@example.com', name: 'Person Example' });
        }
        if (url.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList')) {
          return jsonResponse({ items: [{ id: 'primary', summary: 'Personal' }] });
        }
        if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
          return jsonResponse({ items: [{ id: 'event-1', summary: 'Meeting' }] });
        }
        return jsonResponse({});
      },
      async () => {
        const configured = await harness.service.configure({
          type: 'calendar',
          label: 'Calendar',
          accountIdentity: { email: 'person@example.com' },
          secrets: {
            oauth_client_id: 'client-id',
            oauth_client_secret: 'client-secret',
            oauth_refresh_token: 'refresh-token',
          },
        });
        assert.equal(configured.success, true);
        assert.equal(configured.instance.accountIdentity.email, 'person@example.com');

        const calendars = await harness.service.call({
          type: 'calendar',
          connectionId: configured.instance.id,
          actionId: 'calendar.list_calendars',
          input: {},
        });
        assert.equal(calendars.success, true);
        assert.equal(calendars.data.calendars[0].id, 'primary');

        const events = await harness.service.call({
          type: 'calendar',
          connectionId: configured.instance.id,
          actionId: 'calendar.list_events',
          input: { calendarId: 'primary' },
        });
        assert.equal(events.success, true);
        assert.equal(events.data.events[0].id, 'event-1');
        assert.equal(JSON.stringify({ configured, calendars, events }).includes('refresh-token'), false);
        assert.equal(JSON.stringify({ configured, calendars, events }).includes('google-access-token'), false);
      },
    );
  } finally {
    await harness.cleanup();
  }
});

test('Drive OAuth status does not require Google userinfo scope', async () => {
  const harness = await createService();
  try {
    await withMockedFetch(
      (url) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return jsonResponse({ access_token: 'drive-access-token', expires_in: 3600, token_type: 'Bearer' });
        }
        if (url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
          return jsonResponse({ error: { message: 'insufficient_scope' } }, 403);
        }
        return jsonResponse({});
      },
      async (calls) => {
        const configured = await harness.service.configure({
          type: 'drive',
          label: 'Drive personal',
          secrets: {
            oauth_client_id: 'client-id',
            oauth_client_secret: 'client-secret',
            oauth_refresh_token: 'refresh-token',
          },
        });
        assert.equal(configured.success, true);
        assert.equal(configured.instance.status, 'connected');

        const status = await harness.service.call({
          type: 'drive',
          connectionId: configured.instance.id,
          actionId: 'drive.connection.status',
        });
        assert.equal(status.success, true);
        assert.equal(status.data.connected, true);
        assert.equal(calls.some((call) => call.url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')), false);
      },
    );
  } finally {
    await harness.cleanup();
  }
});

test('new token connections validate credentials, call representative actions, and redact secrets', async () => {
  const harness = await createService();
  try {
    const callsByType = new Map();
    await withMockedFetch(
      (url, options) => {
        const textUrl = String(url);
        const record = (type) => {
          callsByType.set(type, [...(callsByType.get(type) ?? []), { url: textUrl, options }]);
        };
        if (textUrl === 'https://api.figma.com/v1/me') {
          record('figma');
          return jsonResponse({ id: 'figma-user', email: 'design@example.com', handle: 'Designer' });
        }
        if (textUrl.includes('api.figma.com/v1/files/file-1')) {
          record('figma');
          return jsonResponse({ name: 'Design system' });
        }
        if (textUrl.includes('acme.zendesk.com/api/v2/users/me.json')) {
          record('zendesk');
          return jsonResponse({ user: { id: 1, email: 'support@example.com', name: 'Support' } });
        }
        if (textUrl.includes('acme.zendesk.com/api/v2/search.json')) {
          record('zendesk');
          return jsonResponse({ results: [{ id: 101, subject: 'Help' }] });
        }
        if (textUrl.endsWith('discord.com/api/v10/users/@me')) {
          record('discord');
          return jsonResponse({ id: 'bot-1', username: 'ForgerBot' });
        }
        if (textUrl.endsWith('discord.com/api/v10/users/@me/guilds')) {
          record('discord');
          return jsonResponse([{ id: 'guild-1', name: 'Forger' }]);
        }
        if (textUrl.endsWith('api.calendly.com/users/me')) {
          record('calendly');
          return jsonResponse({ resource: { uri: 'https://api.calendly.com/users/user-1', name: 'Scheduler', email: 'calendar@example.com' } });
        }
        if (textUrl.includes('api.calendly.com/event_types')) {
          record('calendly');
          return jsonResponse({ collection: [{ uri: 'event-type-1', name: 'Intro' }] });
        }
        if (textUrl.endsWith('gitlab.example.com/api/v4/user')) {
          record('gitlab');
          return jsonResponse({ id: 10, username: 'developer', email: 'dev@example.com' });
        }
        if (textUrl.includes('gitlab.example.com/api/v4/projects')) {
          record('gitlab');
          return jsonResponse([{ id: 20, name: 'Project' }]);
        }
        if (textUrl.includes('demo.myshopify.com/admin/api/2026-07/shop.json')) {
          record('shopify');
          return jsonResponse({ shop: { id: 1, name: 'Demo Shop', email: 'shop@example.com' } });
        }
        if (textUrl.includes('demo.myshopify.com/admin/api/2026-07/products.json')) {
          record('shopify');
          return jsonResponse({ products: [{ id: 1, title: 'Product' }] });
        }
        if (textUrl.includes('graph.facebook.com') && textUrl.includes('/waba-1/phone_numbers')) {
          record('whatsapp_business');
          return jsonResponse({ data: [{ id: 'phone-1', display_phone_number: '+15550000000' }] });
        }
        if (textUrl.includes('api.telegram.org/bottelegram-token/getMe')) {
          record('telegram');
          return jsonResponse({ ok: true, result: { id: 99, username: 'forger_bot' } });
        }
        if (textUrl.includes('api.telegram.org/bottelegram-token/getUpdates')) {
          record('telegram');
          return jsonResponse({ ok: true, result: [{ update_id: 1 }] });
        }
        if (textUrl.endsWith('api.sendgrid.com/v3/user/profile')) {
          record('sendgrid');
          return jsonResponse({ username: 'mailer', email: 'mail@example.com' });
        }
        if (textUrl.endsWith('api.sendgrid.com/v3/templates?generations=dynamic')) {
          record('sendgrid');
          return jsonResponse({ templates: [{ id: 'tmpl-1', name: 'Welcome' }] });
        }
        if (textUrl.endsWith('api.postmarkapp.com/server')) {
          record('postmark');
          return jsonResponse({ ID: 1, Name: 'Server' });
        }
        if (textUrl.includes('api.postmarkapp.com/templates')) {
          record('postmark');
          return jsonResponse({ Templates: [{ TemplateId: 1, Name: 'Receipt' }] });
        }
        if (textUrl.endsWith('api.twilio.com/2010-04-01/Accounts/AC123.json')) {
          record('twilio');
          return jsonResponse({ sid: 'AC123', friendly_name: 'Twilio Account' });
        }
        if (textUrl.includes('api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')) {
          record('twilio');
          return jsonResponse({ messages: [{ sid: 'SM1', body: 'hello' }] });
        }
        if (textUrl.includes('graph.facebook.com') && textUrl.includes('/act_123')) {
          record('meta_ads');
          if (textUrl.includes('/campaigns')) {
            const body = JSON.parse(options.body ?? '{}');
            assert.equal(body.status, 'PAUSED');
            assert.notEqual(body.status, 'ACTIVE');
            return jsonResponse({ id: 'campaign-1', status: 'PAUSED' });
          }
          return jsonResponse({ id: 'act_123', name: 'Ad account', account_status: 1 });
        }
        return jsonResponse({ error: 'unexpected' }, 404);
      },
      async () => {
        const cases = [
          {
            type: 'figma',
            secrets: { access_token: 'figma-token' },
            actionId: 'figma.get_file',
            input: { fileKey: 'file-1' },
          },
          {
            type: 'zendesk',
            secrets: { subdomain: 'acme', email: 'support@example.com', api_token: 'zendesk-token' },
            actionId: 'zendesk.search',
            input: { query: 'help' },
          },
          {
            type: 'discord',
            secrets: { bot_token: 'discord-token' },
            actionId: 'discord.list_guilds',
            input: {},
          },
          {
            type: 'calendly',
            secrets: { personal_access_token: 'calendly-token' },
            actionId: 'calendly.list_event_types',
            input: { userUri: 'https://api.calendly.com/users/user-1' },
          },
          {
            type: 'gitlab',
            secrets: { api_token: 'gitlab-token', base_url: 'https://gitlab.example.com' },
            actionId: 'gitlab.list_projects',
            input: {},
          },
          {
            type: 'shopify',
            secrets: { shop_domain: 'demo.myshopify.com', access_token: 'shopify-token', api_version: '2026-07' },
            actionId: 'shopify.list_products',
            input: {},
          },
          {
            type: 'whatsapp_business',
            secrets: { access_token: 'whatsapp-token', business_account_id: 'waba-1', phone_number_id: 'phone-1' },
            actionId: 'whatsapp_business.list_phone_numbers',
            input: {},
          },
          {
            type: 'telegram',
            secrets: { bot_token: 'telegram-token' },
            actionId: 'telegram.get_updates',
            input: {},
          },
          {
            type: 'sendgrid',
            secrets: { api_key: 'sendgrid-token' },
            actionId: 'sendgrid.list_templates',
            input: {},
          },
          {
            type: 'postmark',
            secrets: { server_token: 'postmark-token' },
            actionId: 'postmark.list_templates',
            input: {},
          },
          {
            type: 'twilio',
            secrets: { account_sid: 'AC123', api_key_sid: 'SK123', api_key_secret: 'twilio-secret' },
            actionId: 'twilio.list_messages',
            input: {},
          },
          {
            type: 'meta_ads',
            secrets: { oauth_client_id: 'meta-client', oauth_client_secret: 'meta-secret', oauth_access_token: 'meta-token', ad_account_id: '123', api_version: 'v23.0' },
            actionId: 'meta_ads.create_campaign_paused',
            input: { name: 'Draft campaign', objective: 'OUTCOME_TRAFFIC', specialAdCategories: [] },
          },
        ];

        for (const item of cases) {
          const configured = await harness.service.configure({
            type: item.type,
            label: item.type,
            secrets: item.secrets,
          });
          assert.equal(configured.success, true, `${item.type} configures`);

          const result = await harness.service.call({
            type: item.type,
            connectionId: configured.instance.id,
            actionId: item.actionId,
            input: item.input,
          });
          assert.equal(result.success, true, `${item.actionId} succeeds`);
          for (const [secretName, secret] of Object.entries(item.secrets)) {
            if (!/(token|secret|key)/i.test(secretName)) continue;
            assert.equal(JSON.stringify({ configured, result }).includes(secret), false, `${item.type} redacts ${secret}`);
          }
          assert.ok((callsByType.get(item.type) ?? []).length >= (item.type === 'meta_ads' ? 1 : 2), `${item.type} made validation and action calls`);
        }
      },
    );
  } finally {
    await harness.cleanup();
  }
});
