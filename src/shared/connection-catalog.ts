export const BUILT_IN_CONNECTION_TYPES = [
  'gmail',
  'calendar',
  'sheets',
  'drive',
  'docs',
  'github',
  'notion',
  'whatsapp',
  'slack',
  'trello',
  'figma',
  'zendesk',
  'discord',
  'calendly',
  'gitlab',
  'shopify',
  'whatsapp_business',
  'telegram',
  'sendgrid',
  'postmark',
  'twilio',
  'meta_ads',
] as const;

export type BuiltInConnectionType = typeof BUILT_IN_CONNECTION_TYPES[number];

export const CONNECTION_DISPLAY_NAMES: Record<BuiltInConnectionType, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  sheets: 'Google Sheets',
  drive: 'Google Drive',
  docs: 'Google Docs',
  github: 'GitHub',
  notion: 'Notion',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  trello: 'Trello',
  figma: 'Figma',
  zendesk: 'Zendesk',
  discord: 'Discord',
  calendly: 'Calendly',
  gitlab: 'GitLab',
  shopify: 'Shopify',
  whatsapp_business: 'WhatsApp Business Cloud',
  telegram: 'Telegram',
  sendgrid: 'SendGrid',
  postmark: 'Postmark',
  twilio: 'Twilio',
  meta_ads: 'Meta Ads',
};

export const CONNECTION_ACTION_PREFIXES: Record<string, BuiltInConnectionType> = Object.fromEntries(
  BUILT_IN_CONNECTION_TYPES.map((type) => [`${type}.`, type]),
) as Record<string, BuiltInConnectionType>;

export const connectionTypeForActionId = (actionId: string): BuiltInConnectionType | '' => {
  for (const [prefix, type] of Object.entries(CONNECTION_ACTION_PREFIXES)) {
    if (actionId.startsWith(prefix)) {
      return type;
    }
  }
  return '';
};

export const isBuiltInConnectionType = (type: string): type is BuiltInConnectionType =>
  (BUILT_IN_CONNECTION_TYPES as readonly string[]).includes(type);

export const isConnectionActionId = (actionId: string): boolean =>
  Boolean(connectionTypeForActionId(actionId));
