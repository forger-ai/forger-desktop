import { backendError, buildBackendHeaders } from './client-helpers';

interface BackendJsonRequestOptions {
  backendBaseUrl: string;
  token: () => string | undefined;
}

const readJson = async (response: Response): Promise<unknown> => {
  const raw = await response.text();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const backendPayloadErrorCode = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const error = typeof record.error === 'string' ? record.error.trim() : '';
  return error || undefined;
};

const backendPayloadMessage = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  return message || undefined;
};

const backendFailureMessage = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  status: number,
  payload: unknown,
): string => {
  const backendCode = backendPayloadErrorCode(payload);
  if (status === 401 || status === 403) {
    return 'Tu sesión de Forger Cloud expiró. Inicia sesión de nuevo e inténtalo otra vez.';
  }
  if (status === 404) {
    return 'No encontramos esa app o el código de invitación ya no está disponible.';
  }
  if (status === 422 && backendCode === 'platform_not_supported') {
    return 'Esta app no está disponible para este sistema operativo.';
  }
  return backendPayloadMessage(payload)
    ?? (method === 'GET' ? 'Forger Cloud session is no longer valid.' : 'No pudimos completar la accion en Forger Cloud.');
};

const throwBackendRequestError = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  response: Response,
  payload: unknown,
  code: string,
): never => {
  const backendErrorCode = backendPayloadErrorCode(payload);
  throw backendError(backendFailureMessage(method, response.status, payload), backendTechnicalCode(code, response.status, backendErrorCode), {
    httpStatus: response.status,
    ...(backendErrorCode ? { backendErrorCode } : {}),
  });
};

const backendTechnicalCode = (code: string, status: number, backendErrorCode?: string): string => {
  if (code === 'social_user_app_download_failed') {
    if (status === 401 || status === 403) {
      return 'forger_cloud_auth_expired';
    }
    if (status === 404) {
      return 'social_app_download_not_found';
    }
    if (status === 422 && backendErrorCode === 'platform_not_supported') {
      return 'social_app_platform_not_supported';
    }
  }
  return `${code}_${status}`;
};

const requestJson = async (
  options: BackendJsonRequestOptions,
  method: 'GET' | 'POST' | 'PATCH',
  pathname: string,
  code: string,
  body?: Record<string, unknown>,
): Promise<unknown> => {
  const response = await fetch(`${options.backendBaseUrl}${pathname}`, {
    method,
    headers: body
      ? { ...buildBackendHeaders(options.token()), 'Content-Type': 'application/json' }
      : buildBackendHeaders(options.token()),
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throwBackendRequestError(method, response, payload, code);
  }
  return payload;
};

export const getBackendJson = (
  options: BackendJsonRequestOptions,
  pathname: string,
  code: string,
): Promise<unknown> => requestJson(options, 'GET', pathname, code);

export const postBackendJson = (
  options: BackendJsonRequestOptions,
  pathname: string,
  body: Record<string, unknown>,
  code: string,
): Promise<unknown> => requestJson(options, 'POST', pathname, code, body);

export const patchBackendJson = (
  options: BackendJsonRequestOptions,
  pathname: string,
  body: Record<string, unknown>,
  code: string,
): Promise<unknown> => requestJson(options, 'PATCH', pathname, code, body);

export const deleteBackendJson = async (
  options: BackendJsonRequestOptions,
  pathname: string,
  code: string,
): Promise<unknown> => {
  const response = await fetch(`${options.backendBaseUrl}${pathname}`, {
    method: 'DELETE',
    headers: buildBackendHeaders(options.token()),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throwBackendRequestError('DELETE', response, payload, code);
  }
  return payload;
};
