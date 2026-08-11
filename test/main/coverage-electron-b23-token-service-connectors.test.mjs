import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calendlyToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/calendly.js');
const { sendgridToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/sendgrid.js');
const { zendeskToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/zendesk.js');
const { shopifyToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/shopify.js');
const { twilioToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/twilio.js');
const { postmarkToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/postmark.js');

const secretsByType = {
  calendly: { personal_access_token: 'calendly-token' },
  sendgrid: { api_key: 'sendgrid-token' },
  zendesk: { subdomain: 'https://acme/', email: 'support@example.com', api_token: 'zendesk-token' },
  shopify: { shop_domain: 'https://demo.myshopify.com/', access_token: 'shopify-token', api_version: '2026-07' },
  twilio: { account_sid: 'AC123', api_key_sid: 'SK123', api_key_secret: 'twilio-secret' },
  postmark: { server_token: 'postmark-token' },
};

const createContext = (initialSecrets = {}) => {
  const values = new Map(Object.entries(initialSecrets));
  return {
    values,
    secretsStore: {
      setToolSecret: async (_toolId, name, value) => {
        values.set(name, value);
        return { success: true, userMessage: 'stored' };
      },
      getToolSecret: async (_toolId, name) => values.get(name) ?? null,
    },
  };
};

const responseFor = (url) => {
  if (url.endsWith('/users/me')) {
    return { resource: { uri: 'https://api.calendly.com/users/user-1', email: 'calendar@example.com', name: 'Scheduler' } };
  }
  if (url.includes('/event_type_available_times')) return { collection: [{ status: 'available' }] };
  if (url.includes('/event_types')) return { collection: [{ uri: 'event-type-1' }] };
  if (url.includes('/invitees')) return { collection: [{ email: 'guest@example.com' }] };
  if (url.includes('/cancellation')) return { resource: { status: 'canceled' } };
  if (url.includes('/scheduled_events?')) return { collection: [{ uri: 'event-1' }] };
  if (url.includes('/scheduled_events/')) return { resource: { uri: 'event-1' } };

  if (url.endsWith('/user/profile')) return { email: 'mail@example.com', username: 'mailer' };
  if (url.includes('/templates?generations=dynamic')) return { templates: [{ id: 'template-1' }] };
  if (url.includes('/marketing/contacts/search')) return { result: [{ id: 'contact-1' }] };
  if (url.includes('/asm/suppressions/global')) return [{ email: 'blocked@example.com' }];
  if (url.includes('api.sendgrid.com')) return { id: 'sendgrid-resource' };

  if (url.includes('/users/me.json')) return { user: { id: 7, email: 'support@example.com', name: 'Support' } };
  if (url.includes('/search.json')) return { results: [{ id: 10 }] };
  if (url.includes('/tickets.json')) return { tickets: [{ id: 11 }], ticket: { id: 11 } };
  if (url.includes('/users.json')) return { users: [{ id: 7 }] };
  if (url.includes('/tickets/')) return { ticket: { id: 11 } };

  if (url.includes('/shop.json')) return { shop: { id: 9, email: 'shop@example.com', name: 'Demo Shop' } };
  if (url.includes('/products')) return { products: [{ id: 1 }], product: { id: 1 } };
  if (url.includes('/orders')) return { orders: [{ id: 2 }], order: { id: 2 } };
  if (url.includes('/customers')) return { customers: [{ id: 3 }], customer: { id: 3 } };
  if (url.includes('/draft_orders')) return { draft_order: { id: 4 } };
  if (url.includes('/inventory_levels')) return { inventory_level: { available: 5 } };

  if (url.endsWith('/Accounts/AC123.json')) return { sid: 'AC123', friendly_name: 'Twilio Account' };
  if (url.includes('/Messages.json')) return { sid: 'SM1', messages: [{ sid: 'SM1' }] };
  if (url.includes('/Messages/')) return { sid: 'SM1' };
  if (url.includes('/Calls.json')) return { sid: 'CA1', calls: [{ sid: 'CA1' }] };
  if (url.includes('/Calls/')) return { sid: 'CA1' };

  if (url.endsWith('/server')) return { ID: 4, Name: 'Transactional' };
  if (url.includes('/email/batch')) return [{ MessageID: 'batch-1' }];
  if (url.endsWith('/email')) return { MessageID: 'message-1' };
  if (url.includes('/templates?')) return { Templates: [{ TemplateId: 5 }] };
  if (url.includes('/templates/')) return { TemplateId: 5 };
  if (url.includes('/templates')) return { TemplateId: 5 };
  if (url.includes('/messages/outbound/')) return { MessageID: 'message-1' };
  if (url.includes('/bounces')) return { Bounces: [{ ID: 1 }] };
  return {};
};

const withFetch = async (operation) => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  const queued = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const next = queued.length > 0 ? queued.shift() : { body: responseFor(String(url)), status: 200 };
    if (next.error) throw next.error;
    return new Response(next.raw ?? JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return await operation({
      requests,
      queueBody: (body, status = 200) => queued.push({ body, status }),
      queueRaw: (raw, status = 200) => queued.push({ raw, status }),
      queueError: (error) => queued.push({ error }),
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const call = async (module, actionId, input = {}, secrets = secretsByType[module.definition.id]) =>
  await module.execute({ toolId: module.definition.id, actionId, input }, createContext(secrets));

const expectCode = async (module, actionId, input, code) => {
  const result = await call(module, actionId, input);
  assert.equal(result.success, false);
  assert.equal(result.technicalCode, code);
};

test('Given Calendly credentials, when availability and event actions run, then inputs, fallbacks, and malformed collections stay safe', async () => {
  await withFetch(async ({ requests, queueBody }) => {
    const configured = await calendlyToolModule.configure(createContext(), { secrets: secretsByType.calendly });
    assert.equal(configured.success, true);

    assert.equal((await call(calendlyToolModule, 'calendly.list_event_types')).success, true);
    assert.equal((await call(calendlyToolModule, 'calendly.list_event_types', { userUri: 'https://api.calendly.com/users/direct', limit: 2 })).success, true);
    queueBody({});
    assert.deepEqual((await call(calendlyToolModule, 'calendly.list_event_types', { userUri: 'user' })).data.eventTypes, []);

    await expectCode(calendlyToolModule, 'calendly.list_available_times', {}, 'calendly_event_type_required');
    await expectCode(calendlyToolModule, 'calendly.list_available_times', { eventTypeUri: 'type' }, 'calendly_start_required');
    await expectCode(calendlyToolModule, 'calendly.list_available_times', { eventTypeUri: 'type', startTime: 'start' }, 'calendly_end_required');
    assert.equal((await call(calendlyToolModule, 'calendly.list_available_times', { eventTypeUri: 'type', startTime: 'start', endTime: 'end' })).success, true);
    queueBody({});
    assert.deepEqual((await call(calendlyToolModule, 'calendly.list_available_times', { eventTypeUri: 'type', startTime: 'start', endTime: 'end' })).data.availableTimes, []);

    assert.equal((await call(calendlyToolModule, 'calendly.list_scheduled_events', { organizationUri: 'org', limit: 4 })).success, true);
    assert.equal((await call(calendlyToolModule, 'calendly.list_scheduled_events', { userUri: 'user' })).success, true);
    queueBody({});
    assert.deepEqual((await call(calendlyToolModule, 'calendly.list_scheduled_events', { organizationUri: 'org' })).data.events, []);

    await expectCode(calendlyToolModule, 'calendly.get_event', {}, 'calendly_event_required');
    assert.equal((await call(calendlyToolModule, 'calendly.get_event', { eventUri: 'https://api.calendly.com/scheduled_events/event-1' })).success, true);
    assert.equal((await call(calendlyToolModule, 'calendly.get_event', { eventUri: '/' })).success, true);
    await expectCode(calendlyToolModule, 'calendly.list_invitees', {}, 'calendly_event_required');
    assert.equal((await call(calendlyToolModule, 'calendly.list_invitees', { eventUri: 'event-1', limit: 3 })).success, true);
    queueBody({});
    assert.deepEqual((await call(calendlyToolModule, 'calendly.list_invitees', { eventUri: 'event-1' })).data.invitees, []);
    await expectCode(calendlyToolModule, 'calendly.cancel_event', {}, 'calendly_event_required');
    assert.equal((await call(calendlyToolModule, 'calendly.cancel_event', { eventUri: 'event-1' })).success, true);
    assert.equal((await call(calendlyToolModule, 'calendly.cancel_event', { eventUri: 'event-1', reason: 'Duplicate' })).success, true);
    assert.ok(requests.some(({ url }) => url.includes('organization=org')));
    assert.ok(requests.some(({ url }) => url.includes('reason') === false));
  });
});

test('Given SendGrid credentials, when mail, template, contact, and suppression actions run, then validation and all input boundaries are observable', async () => {
  await withFetch(async ({ requests, queueBody, queueRaw, queueError }) => {
    assert.equal((await sendgridToolModule.configure(createContext(), { secrets: secretsByType.sendgrid })).success, true);
    await expectCode(sendgridToolModule, 'sendgrid.send_email', {}, 'sendgrid_from_required');
    await expectCode(sendgridToolModule, 'sendgrid.send_email', { fromEmail: 'from@example.com' }, 'sendgrid_subject_required');
    await expectCode(sendgridToolModule, 'sendgrid.send_email', { fromEmail: 'from@example.com', subject: 'Hi', to: [] }, 'sendgrid_to_required');
    queueRaw('', 202);
    assert.equal((await call(sendgridToolModule, 'sendgrid.send_email', { fromEmail: 'from@example.com', subject: 'Hi', to: [' a@example.com ', '', 1], text: 'Text' })).success, true);
    queueRaw('', 202);
    assert.equal((await call(sendgridToolModule, 'sendgrid.send_email', { fromEmail: 'from@example.com', subject: 'Hi', to: ['a@example.com'], html: '<b>Hi</b>' })).success, true);

    await expectCode(sendgridToolModule, 'sendgrid.send_template_email', {}, 'sendgrid_from_required');
    await expectCode(sendgridToolModule, 'sendgrid.send_template_email', { fromEmail: 'from@example.com' }, 'sendgrid_template_required');
    await expectCode(sendgridToolModule, 'sendgrid.send_template_email', { fromEmail: 'from@example.com', templateId: 'template', to: null }, 'sendgrid_to_required');
    queueRaw('', 202);
    assert.equal((await call(sendgridToolModule, 'sendgrid.send_template_email', { fromEmail: 'from@example.com', templateId: 'template', to: ['a@example.com'], dynamicTemplateData: { name: 'A' } })).success, true);
    assert.equal((await call(sendgridToolModule, 'sendgrid.list_templates')).success, true);
    queueBody({});
    assert.deepEqual((await call(sendgridToolModule, 'sendgrid.list_templates')).data.templates, []);
    await expectCode(sendgridToolModule, 'sendgrid.get_template', {}, 'sendgrid_template_required');
    assert.equal((await call(sendgridToolModule, 'sendgrid.get_template', { templateId: 'template' })).success, true);
    assert.equal((await call(sendgridToolModule, 'sendgrid.list_contacts')).success, true);
    assert.equal((await call(sendgridToolModule, 'sendgrid.list_contacts', { query: 'email="a@example.com"' })).success, true);
    await expectCode(sendgridToolModule, 'sendgrid.upsert_contact', {}, 'sendgrid_contacts_required');
    assert.equal((await call(sendgridToolModule, 'sendgrid.upsert_contact', { contacts: [{ email: 'a@example.com' }], listIds: ['list'] })).success, true);
    await expectCode(sendgridToolModule, 'sendgrid.delete_contact', { ids: ['', null] }, 'sendgrid_contact_ids_required');
    assert.equal((await call(sendgridToolModule, 'sendgrid.delete_contact', { ids: ['a,b', ' c '] })).success, true);
    assert.equal((await call(sendgridToolModule, 'sendgrid.get_suppressions')).success, true);
    queueError(new Error('offline'));
    assert.equal((await call(sendgridToolModule, 'sendgrid.list_templates')).technicalCode, 'offline');
    assert.ok(requests.some(({ init }) => init.method === 'DELETE'));
  });
});

test('Given Zendesk credentials, when ticket flows run, then required fields, optional values, list shapes, and visibility are preserved', async () => {
  await withFetch(async ({ queueBody }) => {
    assert.equal((await zendeskToolModule.configure(createContext(), { secrets: secretsByType.zendesk })).success, true);
    await expectCode(zendeskToolModule, 'zendesk.search', {}, 'zendesk_query_required');
    assert.equal((await call(zendeskToolModule, 'zendesk.search', { query: 'status:open' })).success, true);
    queueBody({});
    assert.deepEqual((await call(zendeskToolModule, 'zendesk.search', { query: 'none' })).data.results, []);
    assert.equal((await call(zendeskToolModule, 'zendesk.list_tickets')).success, true);
    assert.equal((await call(zendeskToolModule, 'zendesk.list_users', { limit: 2 })).success, true);
    queueBody({});
    assert.deepEqual((await call(zendeskToolModule, 'zendesk.list_tickets', { limit: 1 })).data.tickets, []);
    await expectCode(zendeskToolModule, 'zendesk.get_ticket', {}, 'zendesk_ticket_required');
    assert.equal((await call(zendeskToolModule, 'zendesk.get_ticket', { ticketId: '11' })).success, true);
    await expectCode(zendeskToolModule, 'zendesk.create_ticket', {}, 'zendesk_subject_required');
    await expectCode(zendeskToolModule, 'zendesk.create_ticket', { subject: 'Help' }, 'zendesk_body_required');
    assert.equal((await call(zendeskToolModule, 'zendesk.create_ticket', { subject: 'Help', body: 'Please', priority: 'high', type: 'question' })).success, true);
    assert.equal((await call(zendeskToolModule, 'zendesk.create_ticket', { subject: 'Help', body: 'Please' })).success, true);
    await expectCode(zendeskToolModule, 'zendesk.update_ticket', {}, 'zendesk_ticket_required');
    assert.equal((await call(zendeskToolModule, 'zendesk.update_ticket', { ticketId: 11, subject: 'Updated', status: 'open', priority: 'normal' })).success, true);
    assert.equal((await call(zendeskToolModule, 'zendesk.update_ticket', { ticketId: 11 })).success, true);
    await expectCode(zendeskToolModule, 'zendesk.add_ticket_comment', {}, 'zendesk_ticket_required');
    await expectCode(zendeskToolModule, 'zendesk.add_ticket_comment', { ticketId: 11 }, 'zendesk_body_required');
    assert.equal((await call(zendeskToolModule, 'zendesk.add_ticket_comment', { ticketId: 11, body: 'Public' })).success, true);
    assert.equal((await call(zendeskToolModule, 'zendesk.add_ticket_comment', { ticketId: 11, body: 'Private', public: false })).success, true);

    queueBody({ user: {} });
    const emptyIdentity = await zendeskToolModule.execute(
      { toolId: 'zendesk', actionId: 'zendesk.connection.status', input: {} },
      createContext(secretsByType.zendesk),
    );
    assert.equal(emptyIdentity.data.subject, '');
  });
});

test('Given Shopify credentials, when catalog and inventory actions run, then URL defaults, malformed lists, numeric ids, and optional fields are safe', async () => {
  await withFetch(async ({ queueBody }) => {
    assert.equal((await shopifyToolModule.configure(createContext(), { secrets: secretsByType.shopify })).success, true);
    const withoutVersion = { shop_domain: 'demo.myshopify.com', access_token: 'token' };
    assert.equal((await call(shopifyToolModule, 'shopify.list_products', {}, withoutVersion)).success, true);
    for (const [action, key] of [['shopify.list_products', 'products'], ['shopify.list_orders', 'orders'], ['shopify.list_customers', 'customers']]) {
      assert.equal((await call(shopifyToolModule, action, { limit: 3 })).success, true);
      queueBody({});
      assert.deepEqual((await call(shopifyToolModule, action)).data[key], []);
    }
    for (const [action, key] of [['shopify.get_product', 'productId'], ['shopify.get_order', 'orderId'], ['shopify.get_customer', 'customerId']]) {
      await expectCode(shopifyToolModule, action, {}, 'shopify_resource_required');
      assert.equal((await call(shopifyToolModule, action, { [key]: '2' })).success, true);
    }
    await expectCode(shopifyToolModule, 'shopify.create_product', {}, 'shopify_title_required');
    assert.equal((await call(shopifyToolModule, 'shopify.create_product', { title: 'Lamp', bodyHtml: '<p>Lamp</p>', vendor: 'Forger', status: 'draft' })).success, true);
    assert.equal((await call(shopifyToolModule, 'shopify.create_product', { title: 'Lamp' })).success, true);
    await expectCode(shopifyToolModule, 'shopify.update_product', {}, 'shopify_product_required');
    assert.equal((await call(shopifyToolModule, 'shopify.update_product', { productId: 1, title: 'New', status: 'active' })).success, true);
    assert.equal((await call(shopifyToolModule, 'shopify.update_product', { productId: 1 })).success, true);
    assert.equal((await call(shopifyToolModule, 'shopify.create_draft_order', { draftOrder: { line_items: [] } })).success, true);
    assert.equal((await call(shopifyToolModule, 'shopify.create_draft_order', { draftOrder: null })).success, true);
    await expectCode(shopifyToolModule, 'shopify.update_inventory_level', {}, 'shopify_location_required');
    await expectCode(shopifyToolModule, 'shopify.update_inventory_level', { locationId: 1 }, 'shopify_inventory_required');
    assert.equal((await call(shopifyToolModule, 'shopify.update_inventory_level', { locationId: 1, inventoryItemId: 2, available: 0 })).success, true);

    queueBody({ shop: {} });
    const fallbackIdentity = await shopifyToolModule.execute(
      { toolId: 'shopify', actionId: 'shopify.connection.status', input: {} },
      createContext(withoutVersion),
    );
    assert.equal(fallbackIdentity.success, true);
    assert.equal(fallbackIdentity.data.workspace, 'demo.myshopify.com');
  });
});

test('Given Twilio credentials, when messaging and calling flows run, then form normalization, ids, list fallbacks, and account identity are deterministic', async () => {
  await withFetch(async ({ requests, queueBody }) => {
    assert.equal((await twilioToolModule.configure(createContext(), { secrets: secretsByType.twilio })).success, true);
    for (const action of ['twilio.send_sms', 'twilio.send_whatsapp_message']) {
      await expectCode(twilioToolModule, action, {}, 'twilio_from_required');
      await expectCode(twilioToolModule, action, { from: '+1' }, 'twilio_to_required');
      await expectCode(twilioToolModule, action, { from: '+1', to: '+2' }, 'twilio_body_required');
    }
    assert.equal((await call(twilioToolModule, 'twilio.send_sms', { from: '+1', to: '+2', body: 'Hi' })).success, true);
    assert.equal((await call(twilioToolModule, 'twilio.send_whatsapp_message', { from: '+1', to: '+2', body: 'Hi' })).success, true);
    assert.equal((await call(twilioToolModule, 'twilio.send_whatsapp_message', { from: 'whatsapp:+1', to: 'whatsapp:+2', body: 'Hi' })).success, true);
    assert.equal((await call(twilioToolModule, 'twilio.list_messages', { limit: 2 })).success, true);
    queueBody({});
    assert.deepEqual((await call(twilioToolModule, 'twilio.list_messages')).data.messages, []);
    await expectCode(twilioToolModule, 'twilio.get_message', {}, 'twilio_message_required');
    assert.equal((await call(twilioToolModule, 'twilio.get_message', { messageSid: 'SM1' })).success, true);
    await expectCode(twilioToolModule, 'twilio.create_call', {}, 'twilio_from_required');
    await expectCode(twilioToolModule, 'twilio.create_call', { from: '+1' }, 'twilio_to_required');
    await expectCode(twilioToolModule, 'twilio.create_call', { from: '+1', to: '+2' }, 'twilio_url_required');
    assert.equal((await call(twilioToolModule, 'twilio.create_call', { from: '+1', to: '+2', url: 'https://example.com/twiml' })).success, true);
    assert.equal((await call(twilioToolModule, 'twilio.list_calls', { limit: 2 })).success, true);
    queueBody({});
    assert.deepEqual((await call(twilioToolModule, 'twilio.list_calls')).data.calls, []);
    await expectCode(twilioToolModule, 'twilio.get_call', {}, 'twilio_call_required');
    assert.equal((await call(twilioToolModule, 'twilio.get_call', { callSid: 'CA1' })).success, true);

    queueBody({});
    const fallbackIdentity = await twilioToolModule.execute(
      { toolId: 'twilio', actionId: 'twilio.connection.status', input: {} },
      createContext(secretsByType.twilio),
    );
    assert.equal(fallbackIdentity.data.subject, 'AC123');
    const whatsappBody = requests.find(({ init }) => String(init.body).includes('whatsapp%3A%2B1'));
    assert.ok(whatsappBody);
  });
});

test('Given Postmark credentials, when email, template, message, and bounce flows run, then required inputs and response shapes are safe', async () => {
  await withFetch(async ({ queueBody }) => {
    assert.equal((await postmarkToolModule.configure(createContext(), { secrets: secretsByType.postmark })).success, true);
    await expectCode(postmarkToolModule, 'postmark.send_email', {}, 'postmark_from_required');
    await expectCode(postmarkToolModule, 'postmark.send_email', { from: 'from@example.com' }, 'postmark_to_required');
    await expectCode(postmarkToolModule, 'postmark.send_email', { from: 'from@example.com', to: 'to@example.com' }, 'postmark_subject_required');
    assert.equal((await call(postmarkToolModule, 'postmark.send_email', { from: 'from@example.com', to: 'to@example.com', subject: 'Hi', textBody: 'Text', htmlBody: '<p>Hi</p>' })).success, true);
    await expectCode(postmarkToolModule, 'postmark.send_batch', {}, 'postmark_messages_required');
    assert.equal((await call(postmarkToolModule, 'postmark.send_batch', { messages: [{ From: 'a', To: 'b' }] })).success, true);
    assert.equal((await call(postmarkToolModule, 'postmark.list_templates', { count: 2 })).success, true);
    queueBody({});
    assert.deepEqual((await call(postmarkToolModule, 'postmark.list_templates')).data.templates, []);
    await expectCode(postmarkToolModule, 'postmark.get_template', {}, 'postmark_template_required');
    assert.equal((await call(postmarkToolModule, 'postmark.get_template', { templateId: '5' })).success, true);
    await expectCode(postmarkToolModule, 'postmark.create_template', {}, 'postmark_name_required');
    await expectCode(postmarkToolModule, 'postmark.create_template', { name: 'Receipt' }, 'postmark_subject_required');
    assert.equal((await call(postmarkToolModule, 'postmark.create_template', { name: 'Receipt', subject: 'Thanks', htmlBody: '<p>x</p>', textBody: 'x' })).success, true);
    assert.equal((await call(postmarkToolModule, 'postmark.create_template', { name: 'Receipt', subject: 'Thanks' })).success, true);
    await expectCode(postmarkToolModule, 'postmark.update_template', {}, 'postmark_template_required');
    assert.equal((await call(postmarkToolModule, 'postmark.update_template', { templateId: 5, name: 'Receipt', subject: 'Thanks', htmlBody: '<p>x</p>', textBody: 'x' })).success, true);
    assert.equal((await call(postmarkToolModule, 'postmark.update_template', { templateId: 5 })).success, true);
    await expectCode(postmarkToolModule, 'postmark.get_message', {}, 'postmark_message_required');
    assert.equal((await call(postmarkToolModule, 'postmark.get_message', { messageId: 'a/b' })).success, true);
    assert.equal((await call(postmarkToolModule, 'postmark.list_bounces', { count: 2 })).success, true);
    queueBody({});
    assert.deepEqual((await call(postmarkToolModule, 'postmark.list_bounces')).data.bounces, []);

    queueBody({});
    const fallbackIdentity = await postmarkToolModule.execute(
      { toolId: 'postmark', actionId: 'postmark.connection.status', input: {} },
      createContext(secretsByType.postmark),
    );
    assert.equal(fallbackIdentity.data.subject, '');
  });
});
