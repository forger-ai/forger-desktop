import { createHmac } from 'node:crypto';
import type { CallOfficialToolResult, OfficialToolRisk } from '../../../../shared/types';
import { ConnectorApiError, createTokenConnectorModule, type TokenConnectorActionDefinition, type TokenConnectorSecretDefinition } from '../token-connector';
import type { InternalToolContext, InternalToolModule } from '../../../tools/types';

export const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const limit = (value: unknown, fallback = 25, max = 100): number => {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(1, number));
};
export const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
export const arraySchema = (key: string) => schema({ [key]: { type: 'array', items: { type: 'object' } } }, [key]);
export const objectSchema = (key = 'item') => schema({ [key]: { type: 'object' } }, [key]);
export const secret = (name: string, label: string, usage: string, required = true): TokenConnectorSecretDefinition =>
  ({ name, label, usage, required });
export const status = (type: string, name: string): TokenConnectorActionDefinition => ({
  id: `${type}.connection.status`,
  name: 'Estado de conexion',
  description: `Revisa si ${name} esta conectado.`,
  risk: 'low',
  outputSchema: schema({ connected: { type: 'boolean' } }, ['connected']),
  run: async () => ({ success: true, data: { connected: true } }),
});
export const fail = (technicalCode: string, userMessage = 'Completa los campos requeridos.'): CallOfficialToolResult =>
  ({ success: false, userMessage, technicalCode });
export const req = (input: Record<string, unknown>, key: string, code: string): string | CallOfficialToolResult =>
  clean(input[key]) || fail(code);
export const reqNum = (input: Record<string, unknown>, key: string, code: string): number | CallOfficialToolResult => {
  const parsed = typeof input[key] === 'number' ? input[key] as number : Number.parseInt(clean(input[key]), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fail(code);
};
export const basic = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
export const host = (value: string): string => clean(value).replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
export const proof = (token: string, appSecret?: string): string | undefined =>
  appSecret ? createHmac('sha256', appSecret).update(token).digest('hex') : undefined;

export const json = async (url: string, init: RequestInit, prefix: string): Promise<unknown> => {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type') && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  const response = await fetch(url, { ...init, headers });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new ConnectorApiError(`${prefix}_http_${response.status}`);
  return data;
};

export const form = (url: string, values: Record<string, unknown>, headers: HeadersInit, prefix: string) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') body.set(key, String(value));
  return json(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body }, prefix);
};

export const resultError = (name: string, error: unknown, fallback: string): CallOfficialToolResult => ({
  success: false,
  userMessage: `No pudimos completar la accion de ${name}. Revisa la conexion y permisos.`,
  technicalCode: error instanceof ConnectorApiError ? error.technicalCode : error instanceof Error ? error.message : fallback,
});

export interface TokenModuleInput {
  id: string;
  name: string;
  description: string;
  secrets: TokenConnectorSecretDefinition[];
  validate: (secrets: Record<string, string>, context: InternalToolContext) => Promise<{ ok: boolean; data?: Record<string, unknown>; technicalCode?: string }>;
  actions: TokenConnectorActionDefinition[];
}

export const moduleFrom = (input: TokenModuleInput): InternalToolModule => createTokenConnectorModule({
  id: input.id,
  name: input.name,
  description: input.description,
  version: '0.1.0',
  connectionStatusActionId: `${input.id}.connection.status`,
  secrets: input.secrets,
  changelog: [`Conector local de ${input.name}.`],
  copy: { connected: `${input.name} quedo conectado.`, connectFailed: `No pudimos validar ${input.name}.` },
  validate: async (secrets, context) => {
    try {
      return await input.validate(secrets, context);
    } catch (error) {
      return {
        ok: false,
        technicalCode: error instanceof ConnectorApiError ? error.technicalCode : `${input.id}_validation_failed`,
      };
    }
  },
  actions: [status(input.id, input.name), ...input.actions],
});

export type Risk = OfficialToolRisk;
