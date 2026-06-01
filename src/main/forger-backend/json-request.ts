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
    const message = method === 'GET'
      ? 'Forger Cloud session is no longer valid.'
      : 'No pudimos completar la accion en Forger Cloud.';
    throw backendError(message, `${code}_${response.status}`);
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
    throw backendError('No pudimos completar la accion en Forger Cloud.', `${code}_${response.status}`);
  }
  return payload;
};
