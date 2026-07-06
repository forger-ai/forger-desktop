import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  ConfigureOfficialToolInput,
  OfficialToolActionDefinition,
  OfficialToolDefinition,
  ToolMutationResult,
} from '../../../shared/types';
import type { InternalToolContext, InternalToolModule } from '../types';
import {
  getStoredOAuthAccessToken,
  OAuthConnectionError,
  OAUTH_CLIENT_ID_SECRET,
  OAUTH_CLIENT_SECRET_SECRET,
  OAUTH_REFRESH_TOKEN_SECRET,
  runLoopbackOAuthFlow,
} from '../self-oauth';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = cleanString(record[key]);
  return value || undefined;
};

const requiredString = (input: Record<string, unknown>, key: string, code: string): string | CallOfficialToolResult => {
  const value = cleanString(input[key]);
  return value || { success: false, userMessage: `Missing ${key}.`, technicalCode: code };
};

const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(1, numeric));
};

const sanitizeFilename = (value: string): string => {
  const sanitized = value.replace(/[/:\\]/g, '-').replace(/[\x00-\x1F\x7F]/g, '').trim();
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : 'download';
};

class GoogleApiError extends Error {
  constructor(public readonly technicalCode: string, message?: string) {
    super(message ?? technicalCode);
    this.name = 'GoogleApiError';
  }
}

interface GoogleConnectionDefinition {
  id: 'calendar' | 'sheets' | 'drive' | 'docs';
  name: string;
  description: string;
  scopes: string[];
  apiBase: string;
  actions: OfficialToolActionDefinition[];
  executeAction(context: InternalToolContext, actionId: string, input: Record<string, unknown>): Promise<CallOfficialToolResult>;
}

const oauthSecrets = [
  {
    name: OAUTH_CLIENT_ID_SECRET,
    label: 'OAuth client ID',
    required: true,
    usage: 'Client ID from your own Google Cloud OAuth app. Stored locally on this device.',
    manual: true,
  },
  {
    name: OAUTH_CLIENT_SECRET_SECRET,
    label: 'OAuth client secret',
    required: true,
    usage: 'Client secret from your own Google Cloud OAuth app. Stored locally on this device.',
    manual: true,
  },
];

const getAccessToken = (context: InternalToolContext, toolId: string): Promise<string> =>
  getStoredOAuthAccessToken(context, { toolId, tokenUrl: GOOGLE_TOKEN_URL });

const googleFetch = async (
  context: InternalToolContext,
  toolId: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> => {
  const accessToken = await getAccessToken(context, toolId);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    throw new GoogleApiError(`${toolId}_http_${response.status}`);
  }
  return response;
};

const googleJson = async (
  context: InternalToolContext,
  toolId: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const response = await googleFetch(context, toolId, url, init);
  if (response.status === 204) {
    return {};
  }
  return await response.json().catch(() => ({}));
};

const getGoogleIdentity = async (
  context: InternalToolContext,
  toolId: string,
): Promise<Record<string, unknown>> => {
  await getAccessToken(context, toolId);
  return {};
};

const configureGoogle = async (
  context: InternalToolContext,
  definition: GoogleConnectionDefinition,
  input?: ConfigureOfficialToolInput,
): Promise<ToolMutationResult> => {
  const provided = input?.secrets ?? {};
  const clientId = cleanString(provided[OAUTH_CLIENT_ID_SECRET])
    || cleanString(await context.secretsStore.getToolSecret(definition.id, OAUTH_CLIENT_ID_SECRET));
  const clientSecret = cleanString(provided[OAUTH_CLIENT_SECRET_SECRET])
    || cleanString(await context.secretsStore.getToolSecret(definition.id, OAUTH_CLIENT_SECRET_SECRET));
  const providedRefreshToken = cleanString(provided[OAUTH_REFRESH_TOKEN_SECRET]);
  if (!clientId || !clientSecret) {
    return {
      success: false,
      userMessage: `${definition.name} needs your Google OAuth client ID and client secret.`,
      technicalCode: `${definition.id}_oauth_client_credentials_required`,
    };
  }
  if (providedRefreshToken) {
    await context.secretsStore.setToolSecret(definition.id, OAUTH_CLIENT_ID_SECRET, clientId);
    await context.secretsStore.setToolSecret(definition.id, OAUTH_CLIENT_SECRET_SECRET, clientSecret);
    await context.secretsStore.setToolSecret(definition.id, OAUTH_REFRESH_TOKEN_SECRET, providedRefreshToken);
    return { success: true, userMessage: `${definition.name} connected.` };
  }
  await runLoopbackOAuthFlow(context, {
    toolId: definition.id,
    clientId,
    clientSecret,
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    callbackPath: `/oauth/${definition.id}/callback`,
    scopes: definition.scopes,
    authParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
    },
  });
  return { success: true, userMessage: `${definition.name} connected.` };
};

const toGoogleResult = (toolId: string, error: unknown): CallOfficialToolResult => {
  if (error instanceof OAuthConnectionError) {
    return { success: false, userMessage: error.message, technicalCode: error.technicalCode };
  }
  if (error instanceof GoogleApiError) {
    return {
      success: false,
      userMessage: `Could not complete the ${toolId} action.`,
      technicalCode: error.technicalCode,
    };
  }
  return {
    success: false,
    userMessage: `Could not complete the ${toolId} action.`,
    technicalCode: error instanceof Error ? error.message : `${toolId}_action_failed`,
  };
};

const createGoogleModule = (definition: GoogleConnectionDefinition): InternalToolModule => {
  const toolDefinition: OfficialToolDefinition = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: '0.1.0',
    runtime: 'builtin',
    official: true,
    secrets: oauthSecrets,
    actions: [
      {
        id: `${definition.id}.connection.status`,
        name: 'Connection status',
        description: `Checks whether ${definition.name} is connected.`,
        risk: 'low',
        outputSchema: {
          type: 'object',
          properties: {
            connected: { type: 'boolean' },
            email: { type: 'string' },
            subject: { type: 'string' },
          },
          required: ['connected'],
        },
      },
      ...definition.actions,
    ],
    changelog: ['Self-managed Google OAuth connector.'],
  };

  return {
    definition: toolDefinition,
    configure: (context, input) => configureGoogle(context, definition, input),
    execute: async (input: CallOfficialToolInput, context: InternalToolContext): Promise<CallOfficialToolResult> => {
      try {
        if (input.actionId === `${definition.id}.connection.status`) {
          const hasRefresh = await context.secretsStore.hasToolSecret(definition.id, OAUTH_REFRESH_TOKEN_SECRET);
          if (!hasRefresh) {
            return { success: true, data: { connected: false } };
          }
          const identity = await getGoogleIdentity(context, definition.id);
          return {
            success: true,
            data: {
              connected: true,
              subject: optionalString(identity, 'id'),
              email: optionalString(identity, 'email'),
              username: optionalString(identity, 'name'),
            },
          };
        }
        const actionInput = input.input && typeof input.input === 'object' && !Array.isArray(input.input)
          ? input.input as Record<string, unknown>
          : {};
        return await definition.executeAction(context, input.actionId, actionInput);
      } catch (error) {
        return toGoogleResult(definition.id, error);
      }
    },
  };
};

const calendarActions: OfficialToolActionDefinition[] = [
  {
    id: 'calendar.list_calendars',
    name: 'List calendars',
    description: 'Lists calendars visible to the connected Google account.',
    risk: 'low',
    outputSchema: {
      type: 'object',
      properties: { calendars: { type: 'array', items: { type: 'object' } } },
      required: ['calendars'],
    },
  },
  {
    id: 'calendar.list_events',
    name: 'List events',
    description: 'Lists events from a Google Calendar.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar id. Defaults to primary.' },
        timeMin: { type: 'string', description: 'Optional RFC3339 start time.' },
        timeMax: { type: 'string', description: 'Optional RFC3339 end time.' },
        maxResults: { type: 'number', description: 'Maximum events to return.' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: { events: { type: 'array', items: { type: 'object' } } },
      required: ['events'],
    },
  },
  {
    id: 'calendar.create_event',
    name: 'Create event',
    description: 'Creates a Google Calendar event.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        timeZone: { type: 'string' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    id: 'calendar.update_event',
    name: 'Update event',
    description: 'Updates a Google Calendar event.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        eventId: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        timeZone: { type: 'string' },
      },
      required: ['eventId'],
    },
  },
  {
    id: 'calendar.delete_event',
    name: 'Delete event',
    description: 'Deletes a Google Calendar event.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        eventId: { type: 'string' },
      },
      required: ['eventId'],
    },
  },
];

const eventBody = (input: Record<string, unknown>): Record<string, unknown> => {
  const timeZone = optionalString(input, 'timeZone');
  const body: Record<string, unknown> = {};
  for (const key of ['summary', 'description'] as const) {
    const value = optionalString(input, key);
    if (value) body[key] = value;
  }
  const start = optionalString(input, 'start');
  const end = optionalString(input, 'end');
  if (start) body.start = { dateTime: start, ...(timeZone ? { timeZone } : {}) };
  if (end) body.end = { dateTime: end, ...(timeZone ? { timeZone } : {}) };
  return body;
};

export const calendarToolModule = createGoogleModule({
  id: 'calendar',
  name: 'Google Calendar',
  description: 'Reads and manages Google Calendar calendars and events using self-managed Google OAuth.',
  apiBase: 'https://www.googleapis.com/calendar/v3',
  scopes: ['https://www.googleapis.com/auth/calendar'],
  actions: calendarActions,
  executeAction: async (context, actionId, input) => {
    if (actionId === 'calendar.list_calendars') {
      const data = await googleJson(context, 'calendar', 'https://www.googleapis.com/calendar/v3/users/me/calendarList');
      return { success: true, data: { calendars: isRecord(data) && Array.isArray(data.items) ? data.items : [] } };
    }
    if (actionId === 'calendar.list_events') {
      const calendarId = encodeURIComponent(optionalString(input, 'calendarId') ?? 'primary');
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', String(clampLimit(input.maxResults, 20, 250)));
      for (const key of ['timeMin', 'timeMax'] as const) {
        const value = optionalString(input, key);
        if (value) url.searchParams.set(key, value);
      }
      const data = await googleJson(context, 'calendar', url.toString());
      return { success: true, data: { events: isRecord(data) && Array.isArray(data.items) ? data.items : [] } };
    }
    if (actionId === 'calendar.create_event') {
      const summary = requiredString(input, 'summary', 'calendar_summary_required');
      const start = requiredString(input, 'start', 'calendar_start_required');
      const end = requiredString(input, 'end', 'calendar_end_required');
      if (typeof summary !== 'string') return summary;
      if (typeof start !== 'string') return start;
      if (typeof end !== 'string') return end;
      const calendarId = encodeURIComponent(optionalString(input, 'calendarId') ?? 'primary');
      const data = await googleJson(context, 'calendar', `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
        method: 'POST',
        body: JSON.stringify(eventBody(input)),
      });
      return { success: true, userMessage: 'Calendar event created.', data };
    }
    if (actionId === 'calendar.update_event') {
      const eventId = requiredString(input, 'eventId', 'calendar_event_required');
      if (typeof eventId !== 'string') return eventId;
      const calendarId = encodeURIComponent(optionalString(input, 'calendarId') ?? 'primary');
      const data = await googleJson(context, 'calendar', `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        body: JSON.stringify(eventBody(input)),
      });
      return { success: true, userMessage: 'Calendar event updated.', data };
    }
    if (actionId === 'calendar.delete_event') {
      const eventId = requiredString(input, 'eventId', 'calendar_event_required');
      if (typeof eventId !== 'string') return eventId;
      const calendarId = encodeURIComponent(optionalString(input, 'calendarId') ?? 'primary');
      await googleJson(context, 'calendar', `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
      return { success: true, userMessage: 'Calendar event deleted.', data: { deleted: true, eventId } };
    }
    return { success: false, userMessage: 'Calendar action is not available.', technicalCode: 'calendar_action_unknown' };
  },
});

const sheetsActions: OfficialToolActionDefinition[] = [
  {
    id: 'sheets.read_range',
    name: 'Read range',
    description: 'Reads values from a Google Sheet range.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' } },
      required: ['spreadsheetId', 'range'],
    },
  },
  {
    id: 'sheets.append_rows',
    name: 'Append rows',
    description: 'Appends rows to a Google Sheet range.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array', items: { type: 'array' } } },
      required: ['spreadsheetId', 'range', 'values'],
    },
  },
  {
    id: 'sheets.update_range',
    name: 'Update range',
    description: 'Updates values in a Google Sheet range.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array', items: { type: 'array' } } },
      required: ['spreadsheetId', 'range', 'values'],
    },
  },
];

const sheetValues = (input: Record<string, unknown>): unknown[][] | CallOfficialToolResult => {
  if (!Array.isArray(input.values)) {
    return { success: false, userMessage: 'Provide sheet values as rows.', technicalCode: 'sheets_values_required' };
  }
  return input.values.map((row) => Array.isArray(row) ? row : [row]);
};

export const sheetsToolModule = createGoogleModule({
  id: 'sheets',
  name: 'Google Sheets',
  description: 'Reads and updates Google Sheets using self-managed Google OAuth.',
  apiBase: 'https://sheets.googleapis.com/v4',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  actions: sheetsActions,
  executeAction: async (context, actionId, input) => {
    const spreadsheetId = requiredString(input, 'spreadsheetId', 'sheets_spreadsheet_required');
    const range = requiredString(input, 'range', 'sheets_range_required');
    if (typeof spreadsheetId !== 'string') return spreadsheetId;
    if (typeof range !== 'string') return range;
    const encodedRange = encodeURIComponent(range);
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}`;
    if (actionId === 'sheets.read_range') {
      const data = await googleJson(context, 'sheets', base);
      return { success: true, data };
    }
    const values = sheetValues(input);
    if (!Array.isArray(values)) return values;
    if (actionId === 'sheets.append_rows') {
      const data = await googleJson(context, 'sheets', `${base}:append?valueInputOption=USER_ENTERED`, {
        method: 'POST',
        body: JSON.stringify({ values }),
      });
      return { success: true, userMessage: 'Rows appended to Google Sheets.', data };
    }
    if (actionId === 'sheets.update_range') {
      const data = await googleJson(context, 'sheets', `${base}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        body: JSON.stringify({ values }),
      });
      return { success: true, userMessage: 'Google Sheets range updated.', data };
    }
    return { success: false, userMessage: 'Sheets action is not available.', technicalCode: 'sheets_action_unknown' };
  },
});

const driveActions: OfficialToolActionDefinition[] = [
  {
    id: 'drive.list_files',
    name: 'List files',
    description: 'Searches files in Google Drive.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, pageSize: { type: 'number' } },
    },
  },
  {
    id: 'drive.download_file',
    name: 'Download file',
    description: 'Downloads a file from Google Drive to local Forger metadata.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: { fileId: { type: 'string' }, filename: { type: 'string' } },
      required: ['fileId'],
    },
  },
  {
    id: 'drive.upload_file',
    name: 'Upload file',
    description: 'Uploads a local file to Google Drive.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string' }, name: { type: 'string' }, parentFolderId: { type: 'string' }, mimeType: { type: 'string' } },
      required: ['filePath'],
    },
  },
];

export const driveToolModule = createGoogleModule({
  id: 'drive',
  name: 'Google Drive',
  description: 'Searches, downloads, and uploads Google Drive files using self-managed Google OAuth.',
  apiBase: 'https://www.googleapis.com/drive/v3',
  scopes: ['https://www.googleapis.com/auth/drive.file'],
  actions: driveActions,
  executeAction: async (context, actionId, input) => {
    if (actionId === 'drive.list_files') {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('fields', 'files(id,name,mimeType,webViewLink,modifiedTime,size)');
      url.searchParams.set('pageSize', String(clampLimit(input.pageSize, 20, 100)));
      const query = optionalString(input, 'query');
      if (query) url.searchParams.set('q', query);
      const data = await googleJson(context, 'drive', url.toString());
      return { success: true, data: { files: isRecord(data) && Array.isArray(data.files) ? data.files : [] } };
    }
    if (actionId === 'drive.download_file') {
      const fileId = requiredString(input, 'fileId', 'drive_file_required');
      if (typeof fileId !== 'string') return fileId;
      const response = await googleFetch(context, 'drive', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const directory = path.join(context.metadataRoot, 'downloads', randomUUID());
      await fs.mkdir(directory, { recursive: true });
      const filename = sanitizeFilename(optionalString(input, 'filename') ?? fileId);
      const filePath = path.join(directory, filename);
      await fs.writeFile(filePath, buffer, { mode: 0o600 });
      return { success: true, data: { fileId, filePath, size: buffer.byteLength } };
    }
    if (actionId === 'drive.upload_file') {
      const filePath = requiredString(input, 'filePath', 'drive_file_path_required');
      if (typeof filePath !== 'string') return filePath;
      const buffer = await fs.readFile(filePath);
      const name = optionalString(input, 'name') ?? path.basename(filePath);
      const metadata = {
        name,
        ...(optionalString(input, 'parentFolderId') ? { parents: [optionalString(input, 'parentFolderId')] } : {}),
        ...(optionalString(input, 'mimeType') ? { mimeType: optionalString(input, 'mimeType') } : {}),
      };
      const boundary = `forger-${randomUUID()}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${optionalString(input, 'mimeType') ?? 'application/octet-stream'}\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const data = await googleJson(context, 'drive', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink', {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      });
      return { success: true, userMessage: 'File uploaded to Google Drive.', data };
    }
    return { success: false, userMessage: 'Drive action is not available.', technicalCode: 'drive_action_unknown' };
  },
});

const docsActions: OfficialToolActionDefinition[] = [
  {
    id: 'docs.read_document',
    name: 'Read document',
    description: 'Reads a Google Docs document.',
    risk: 'medium',
    inputSchema: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'] },
  },
  {
    id: 'docs.create_document',
    name: 'Create document',
    description: 'Creates a Google Docs document.',
    risk: 'high',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  },
  {
    id: 'docs.append_text',
    name: 'Append text',
    description: 'Appends text to a Google Docs document.',
    risk: 'high',
    inputSchema: { type: 'object', properties: { documentId: { type: 'string' }, text: { type: 'string' } }, required: ['documentId', 'text'] },
  },
  {
    id: 'docs.replace_text',
    name: 'Replace text',
    description: 'Runs a replace-all text request in a Google Docs document.',
    risk: 'high',
    inputSchema: { type: 'object', properties: { documentId: { type: 'string' }, containsText: { type: 'string' }, replaceText: { type: 'string' } }, required: ['documentId', 'containsText', 'replaceText'] },
  },
];

const documentEndIndex = (document: unknown): number => {
  if (!isRecord(document) || !isRecord(document.body) || !Array.isArray(document.body.content)) {
    return 1;
  }
  const indexes = document.body.content
    .map((entry) => isRecord(entry) && typeof entry.endIndex === 'number' ? entry.endIndex : 1)
    .filter((value) => Number.isFinite(value));
  return Math.max(1, ...indexes) - 1;
};

export const docsToolModule = createGoogleModule({
  id: 'docs',
  name: 'Google Docs',
  description: 'Reads and edits Google Docs documents using self-managed Google OAuth.',
  apiBase: 'https://docs.googleapis.com/v1',
  scopes: ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive.file'],
  actions: docsActions,
  executeAction: async (context, actionId, input) => {
    if (actionId === 'docs.create_document') {
      const title = requiredString(input, 'title', 'docs_title_required');
      if (typeof title !== 'string') return title;
      const data = await googleJson(context, 'docs', 'https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      return { success: true, userMessage: 'Google Docs document created.', data };
    }
    const documentId = requiredString(input, 'documentId', 'docs_document_required');
    if (typeof documentId !== 'string') return documentId;
    if (actionId === 'docs.read_document') {
      const data = await googleJson(context, 'docs', `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
      return { success: true, data };
    }
    if (actionId === 'docs.append_text') {
      const text = requiredString(input, 'text', 'docs_text_required');
      if (typeof text !== 'string') return text;
      const document = await googleJson(context, 'docs', `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
      const data = await googleJson(context, 'docs', `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ insertText: { location: { index: documentEndIndex(document) }, text } }],
        }),
      });
      return { success: true, userMessage: 'Text appended to Google Docs.', data };
    }
    if (actionId === 'docs.replace_text') {
      const containsText = requiredString(input, 'containsText', 'docs_contains_text_required');
      const replaceText = requiredString(input, 'replaceText', 'docs_replace_text_required');
      if (typeof containsText !== 'string') return containsText;
      if (typeof replaceText !== 'string') return replaceText;
      const data = await googleJson(context, 'docs', `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ replaceAllText: { containsText: { text: containsText, matchCase: true }, replaceText } }],
        }),
      });
      return { success: true, userMessage: 'Text replaced in Google Docs.', data };
    }
    return { success: false, userMessage: 'Docs action is not available.', technicalCode: 'docs_action_unknown' };
  },
});
