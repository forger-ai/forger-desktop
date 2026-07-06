export const tokenProviderPortals: Record<string, string> = {
  notion: 'https://www.notion.so/my-integrations',
  slack: 'https://api.slack.com/apps',
  trello: 'https://trello.com/power-ups/admin',
  figma: 'https://www.figma.com/developers/api#access-tokens',
  zendesk: 'https://support.zendesk.com/hc/en-us/articles/4408845965210',
  discord: 'https://discord.com/developers/applications',
  calendly: 'https://calendly.com/integrations/api_webhooks',
  gitlab: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  shopify: 'https://admin.shopify.com/',
  whatsapp_business: 'https://developers.facebook.com/apps/',
  telegram: 'https://t.me/BotFather',
  sendgrid: 'https://app.sendgrid.com/settings/api_keys',
  postmark: 'https://account.postmarkapp.com/servers',
  twilio: 'https://console.twilio.com/us1/account/keys-credentials/api-keys',
};

export const tokenProviderPermissionHint = (type: string, es: boolean): string => {
  const hints: Record<string, [string, string]> = {
    notion: ['Comparte cada página o base de datos con la integración antes de usarla.', 'Share each page or database with the integration before using it.'],
    slack: ['Usa un bot token con scopes de canales y mensajes que coincidan con tus acciones.', 'Use a bot token with channel and message scopes that match your actions.'],
    trello: ['Crea key/token de Trello y limita el acceso al workspace que usarás.', 'Create a Trello key/token and limit access to the workspace you will use.'],
    discord: ['Usa un bot token y agrega el bot a los servidores donde actuará.', 'Use a bot token and add the bot to the servers where it will act.'],
    gitlab: ['Selecciona scopes de API y, para self-hosted, revisa la base URL.', 'Select API scopes and, for self-hosted instances, review the base URL.'],
    shopify: ['Usa un Admin API token de una custom app con permisos mínimos de productos, pedidos e inventario.', 'Use a custom app Admin API token with minimal product, order, and inventory permissions.'],
    whatsapp_business: ['Usa un token de Meta con WhatsApp Cloud API y el phone number ID correcto.', 'Use a Meta token with WhatsApp Cloud API and the correct phone number ID.'],
    twilio: ['Prioriza API Key SID/Secret y Account SID, no el Auth Token legacy.', 'Prefer API Key SID/Secret plus Account SID, not the legacy Auth Token.'],
  };
  const hint = hints[type];
  return hint ? hint[es ? 0 : 1] : es
    ? 'Selecciona solo los permisos mínimos necesarios para las acciones que usarás en Forger.'
    : 'Select only the minimum permissions needed for the actions you will use in Forger.';
};
