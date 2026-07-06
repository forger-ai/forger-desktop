import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, clean, host, json, moduleFrom, objectSchema, record, req, reqNum, schema, secret } from './helpers';

const version = (s: Record<string, string>) => clean(s.api_version) || '2026-07';
const base = (s: Record<string, string>) => `https://${host(s.shop_domain)}/admin/api/${version(s)}`;
const api = (s: Record<string, string>, path: string, init: RequestInit = {}) =>
  json(`${base(s)}${path}`, { ...init, headers: { 'X-Shopify-Access-Token': s.access_token, ...(init.headers ?? {}) } }, 'shopify');

const listAction = (id: string, name: string, path: string, key: string): TokenConnectorActionDefinition => ({
  id, name, description: `${name} de Shopify.`, risk: 'medium',
  inputSchema: schema({ limit: { type: 'number' } }), outputSchema: arraySchema(key),
  run: async ({ input, secrets }) => {
    const data = record(await api(secrets, `${path}?limit=${input.limit ?? 50}`));
    return { success: true, data: { [key]: Array.isArray(data[key]) ? data[key] : [] } };
  },
});
const getAction = (id: string, name: string, path: string, key: string, inputKey: string): TokenConnectorActionDefinition => ({
  id, name, description: `${name} de Shopify.`, risk: 'medium',
  inputSchema: schema({ [inputKey]: { type: 'number' } }, [inputKey]), outputSchema: objectSchema(key),
  run: async ({ input, secrets }) => {
    const resourceId = reqNum(input, inputKey, 'shopify_resource_required'); if (typeof resourceId !== 'number') return resourceId;
    const data = record(await api(secrets, path.replace('{id}', String(resourceId))));
    return { success: true, data: { [key]: record(data[key]) } };
  },
});

const actions: TokenConnectorActionDefinition[] = [
  listAction('shopify.list_products', 'Listar productos', '/products.json', 'products'),
  listAction('shopify.list_orders', 'Listar pedidos', '/orders.json', 'orders'),
  listAction('shopify.list_customers', 'Listar clientes', '/customers.json', 'customers'),
  getAction('shopify.get_product', 'Leer producto', '/products/{id}.json', 'product', 'productId'),
  getAction('shopify.get_order', 'Leer pedido', '/orders/{id}.json', 'order', 'orderId'),
  getAction('shopify.get_customer', 'Leer cliente', '/customers/{id}.json', 'customer', 'customerId'),
  {
    id: 'shopify.create_product', name: 'Crear producto', description: 'Crea un producto.', risk: 'high',
    inputSchema: schema({ title: { type: 'string' }, bodyHtml: { type: 'string' }, vendor: { type: 'string' }, status: { type: 'string' } }, ['title']),
    outputSchema: objectSchema('product'),
    run: async ({ input, secrets }) => {
      const title = req(input, 'title', 'shopify_title_required'); if (typeof title !== 'string') return title;
      const product = { title, body_html: clean(input.bodyHtml) || undefined, vendor: clean(input.vendor) || undefined, status: clean(input.status) || undefined };
      const data = record(await api(secrets, '/products.json', { method: 'POST', body: JSON.stringify({ product }) }));
      return { success: true, userMessage: 'Producto creado en Shopify.', data: { product: record(data.product) } };
    },
  },
  {
    id: 'shopify.update_product', name: 'Actualizar producto', description: 'Actualiza un producto.', risk: 'high',
    inputSchema: schema({ productId: { type: 'number' }, title: { type: 'string' }, status: { type: 'string' } }, ['productId']),
    outputSchema: objectSchema('product'),
    run: async ({ input, secrets }) => {
      const id = reqNum(input, 'productId', 'shopify_product_required'); if (typeof id !== 'number') return id;
      const product = { id, title: clean(input.title) || undefined, status: clean(input.status) || undefined };
      const data = record(await api(secrets, `/products/${id}.json`, { method: 'PUT', body: JSON.stringify({ product }) }));
      return { success: true, data: { product: record(data.product) } };
    },
  },
  {
    id: 'shopify.create_draft_order', name: 'Crear draft order', description: 'Crea un draft order.', risk: 'high',
    inputSchema: schema({ draftOrder: { type: 'object' } }, ['draftOrder']), outputSchema: objectSchema('draftOrder'),
    run: async ({ input, secrets }) => {
      const data = record(await api(secrets, '/draft_orders.json', { method: 'POST', body: JSON.stringify({ draft_order: record(input.draftOrder) }) }));
      return { success: true, data: { draftOrder: record(data.draft_order) } };
    },
  },
  {
    id: 'shopify.update_inventory_level', name: 'Actualizar inventario', description: 'Actualiza inventario.', risk: 'high',
    inputSchema: schema({ locationId: { type: 'number' }, inventoryItemId: { type: 'number' }, available: { type: 'number' } }, ['locationId', 'inventoryItemId', 'available']),
    outputSchema: objectSchema('inventoryLevel'),
    run: async ({ input, secrets }) => {
      const location = reqNum(input, 'locationId', 'shopify_location_required'); const item = reqNum(input, 'inventoryItemId', 'shopify_inventory_required');
      if (typeof location !== 'number') return location; if (typeof item !== 'number') return item;
      const data = record(await api(secrets, '/inventory_levels/set.json', { method: 'POST', body: JSON.stringify({ location_id: location, inventory_item_id: item, available: input.available }) }));
      return { success: true, data: { inventoryLevel: record(data.inventory_level) } };
    },
  },
];

export const shopifyToolModule = moduleFrom({
  id: 'shopify', name: 'Shopify', description: 'Administra productos, pedidos, clientes e inventario de Shopify.',
  secrets: [secret('shop_domain', 'Dominio de tienda Shopify', 'Dominio myshopify.com.'), secret('access_token', 'Admin API access token', 'Token de una custom app.'), secret('api_version', 'Version Admin API', 'Si se deja vacia usa 2026-07.', false)],
  validate: async (secrets) => {
    const shop = record(record(await api(secrets, '/shop.json')).shop);
    return { ok: true, data: { subject: String(shop.id ?? ''), email: clean(shop.email), workspace: clean(shop.name) || host(secrets.shop_domain) } };
  },
  actions,
});
