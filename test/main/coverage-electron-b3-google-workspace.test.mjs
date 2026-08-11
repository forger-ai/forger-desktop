import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const selfOAuth = require('../../dist-electron/main/tools/self-oauth.js');
const oauthLoopback = require('../../dist-electron/main/tools/self-oauth/loopback.js');
const oauthTokenStore = require('../../dist-electron/main/tools/self-oauth/token-store.js');
const {
  calendarToolModule,
  docsToolModule,
  driveToolModule,
  sheetsToolModule,
} = require('../../dist-electron/main/connections/modules/google-workspace/index.js');

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
});

const createContext = (metadataRoot, initialSecrets = {}) => {
  const secrets = new Map(Object.entries(initialSecrets));
  const calls = [];
  return {
    calls,
    secrets,
    context: {
      metadataRoot,
      secretsStore: {
        getToolSecret: async (toolId, key) => {
          calls.push(['get', toolId, key]);
          return secrets.get(`${toolId}:${key}`) ?? secrets.get(key);
        },
        hasToolSecret: async (toolId, key) => {
          calls.push(['has', toolId, key]);
          return secrets.has(`${toolId}:${key}`) || secrets.has(key);
        },
        setToolSecret: async (toolId, key, value) => {
          calls.push(['set', toolId, key, value]);
          secrets.set(`${toolId}:${key}`, value);
          return { success: true, userMessage: 'saved' };
        },
      },
    },
  };
};

const execute = async (module, context, actionId, input) => await module.execute({ actionId, input }, context);

const withOAuthToken = async (implementation, callback) => {
  const original = oauthTokenStore.getStoredOAuthAccessToken;
  oauthTokenStore.getStoredOAuthAccessToken = implementation;
  try {
    return await callback();
  } finally {
    oauthTokenStore.getStoredOAuthAccessToken = original;
  }
};

const withFetchQueue = async (responses, callback) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next?.throwValue !== undefined) throw next.throwValue;
    return next;
  };
  try {
    return await callback(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('Google Workspace configuration validates credentials and supports refresh-token or loopback OAuth setup', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-google-config-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));

  const missing = createContext(root);
  assert.equal((await calendarToolModule.configure(missing.context)).technicalCode, 'calendar_oauth_client_credentials_required');
  const missingSecret = createContext(root, { [selfOAuth.OAUTH_CLIENT_ID_SECRET]: 'client' });
  assert.equal((await calendarToolModule.configure(missingSecret.context, { secrets: {} })).technicalCode, 'calendar_oauth_client_credentials_required');

  const direct = createContext(root);
  assert.deepEqual(await sheetsToolModule.configure(direct.context, {
    secrets: {
      [selfOAuth.OAUTH_CLIENT_ID_SECRET]: ' client ',
      [selfOAuth.OAUTH_CLIENT_SECRET_SECRET]: ' secret ',
      [selfOAuth.OAUTH_REFRESH_TOKEN_SECRET]: ' refresh ',
    },
  }), { success: true, userMessage: 'Google Sheets connected.' });
  assert.equal(direct.secrets.get(`sheets:${selfOAuth.OAUTH_REFRESH_TOKEN_SECRET}`), 'refresh');

  const loopback = createContext(root, {
    [selfOAuth.OAUTH_CLIENT_ID_SECRET]: 'stored-client',
    [selfOAuth.OAUTH_CLIENT_SECRET_SECRET]: 'stored-secret',
  });
  const originalLoopback = oauthLoopback.runLoopbackOAuthFlow;
  const calls = [];
  oauthLoopback.runLoopbackOAuthFlow = async (context, options) => calls.push([context, options]);
  try {
    assert.deepEqual(await driveToolModule.configure(loopback.context, { secrets: {} }), {
      success: true,
      userMessage: 'Google Drive connected.',
    });
  } finally {
    oauthLoopback.runLoopbackOAuthFlow = originalLoopback;
  }
  assert.equal(calls[0][1].toolId, 'drive');
  assert.equal(calls[0][1].callbackPath, '/oauth/drive/callback');
  assert.deepEqual(calls[0][1].authParams, {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
  });
});

test('Google Calendar covers connection state and complete event lifecycle with bounded query inputs', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-google-calendar-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const disconnected = createContext(root);
  assert.deepEqual(await execute(calendarToolModule, disconnected.context, 'calendar.connection.status'), {
    success: true,
    data: { connected: false },
  });

  const connected = createContext(root, { [selfOAuth.OAUTH_REFRESH_TOKEN_SECRET]: 'refresh' });
  await withOAuthToken(async () => 'google-token', async () => await withFetchQueue([
    jsonResponse({ items: [{ id: 'calendar-1' }] }),
    jsonResponse({ malformed: true }),
    jsonResponse({ items: [{ id: 'event-1' }] }),
    jsonResponse({ items: 'bad' }),
    jsonResponse({ id: 'created' }),
    jsonResponse({ id: 'updated' }),
    jsonResponse({ id: 'updated-with-times' }),
    new Response(null, { status: 204 }),
  ], async (requests) => {
    assert.deepEqual((await execute(calendarToolModule, connected.context, 'calendar.connection.status')).data, {
      connected: true,
      subject: undefined,
      email: undefined,
      username: undefined,
    });
    assert.deepEqual((await execute(calendarToolModule, connected.context, 'calendar.list_calendars')).data.calendars, [{ id: 'calendar-1' }]);
    assert.deepEqual((await execute(calendarToolModule, connected.context, 'calendar.list_calendars')).data.calendars, []);
    assert.deepEqual((await execute(calendarToolModule, connected.context, 'calendar.list_events', {
      calendarId: ' team/calendar ', timeMin: ' start ', timeMax: ' end ', maxResults: 999,
    })).data.events, [{ id: 'event-1' }]);
    assert.deepEqual((await execute(calendarToolModule, connected.context, 'calendar.list_events', {
      maxResults: -5,
    })).data.events, []);
    assert.match(requests[2].url, /calendars\/team%2Fcalendar\/events/);
    assert.match(requests[2].url, /maxResults=250/);
    assert.match(requests[3].url, /calendars\/primary\/events/);
    assert.match(requests[3].url, /maxResults=1/);

    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.create_event', {})).technicalCode, 'calendar_summary_required');
    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.create_event', { summary: 'Meeting' })).technicalCode, 'calendar_start_required');
    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.create_event', { summary: 'Meeting', start: 's' })).technicalCode, 'calendar_end_required');
    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.create_event', {
      summary: ' Meeting ', description: ' Desc ', start: '2026-01-01', end: '2026-01-02', timeZone: ' UTC ',
    })).success, true);
    assert.deepEqual(JSON.parse(requests[4].init.body), {
      summary: 'Meeting',
      description: 'Desc',
      start: { dateTime: '2026-01-01', timeZone: 'UTC' },
      end: { dateTime: '2026-01-02', timeZone: 'UTC' },
    });

    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.update_event', {})).technicalCode, 'calendar_event_required');
    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.update_event', { eventId: 'event-1' })).success, true);
    assert.deepEqual(JSON.parse(requests[5].init.body), {});
    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.update_event', {
      eventId: 'event-1', start: '2026-02-01', end: '2026-02-02',
    })).success, true);
    assert.deepEqual(JSON.parse(requests[6].init.body), {
      start: { dateTime: '2026-02-01' },
      end: { dateTime: '2026-02-02' },
    });
    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.delete_event', {})).technicalCode, 'calendar_event_required');
    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.delete_event', { eventId: 'event-1' })).success, true);
    assert.equal((await execute(calendarToolModule, connected.context, 'calendar.unknown', [])).technicalCode, 'calendar_action_unknown');
  }));
});

test('Google Sheets validates ranges and row matrices across read, append, update, and unknown actions', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-google-sheets-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const harness = createContext(root);

  await withOAuthToken(async () => 'google-token', async () => await withFetchQueue([
    jsonResponse({ values: [['a']] }),
    jsonResponse({ updates: 2 }),
    jsonResponse({ updates: 1 }),
  ], async (requests) => {
    assert.equal((await execute(sheetsToolModule, harness.context, 'sheets.read_range', {})).technicalCode, 'sheets_spreadsheet_required');
    assert.equal((await execute(sheetsToolModule, harness.context, 'sheets.read_range', { spreadsheetId: 'sheet' })).technicalCode, 'sheets_range_required');
    assert.deepEqual((await execute(sheetsToolModule, harness.context, 'sheets.read_range', {
      spreadsheetId: 'sheet/id', range: 'A1:B2',
    })).data, { values: [['a']] });
    assert.equal((await execute(sheetsToolModule, harness.context, 'sheets.append_rows', {
      spreadsheetId: 'sheet', range: 'A1', values: 'bad',
    })).technicalCode, 'sheets_values_required');
    assert.equal((await execute(sheetsToolModule, harness.context, 'sheets.append_rows', {
      spreadsheetId: 'sheet', range: 'A1', values: [['a'], 'b'],
    })).success, true);
    assert.deepEqual(JSON.parse(requests[1].init.body), { values: [['a'], ['b']] });
    assert.equal((await execute(sheetsToolModule, harness.context, 'sheets.update_range', {
      spreadsheetId: 'sheet', range: 'A1', values: [[1]],
    })).success, true);
    assert.equal(requests[2].init.method, 'PUT');
    assert.equal((await execute(sheetsToolModule, harness.context, 'sheets.unknown', {
      spreadsheetId: 'sheet', range: 'A1', values: [],
    })).technicalCode, 'sheets_action_unknown');
  }));
});

test('Google Drive lists, downloads, sanitizes, and uploads files inside metadata boundaries', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-google-drive-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const harness = createContext(root);
  const uploadPath = path.join(root, 'upload.txt');
  await fs.writeFile(uploadPath, 'upload body', 'utf8');

  await withOAuthToken(async () => 'google-token', async () => await withFetchQueue([
    jsonResponse({ files: [{ id: 'file-1' }] }),
    jsonResponse({ files: 'bad' }),
    new Response(Buffer.from('download body')),
    new Response(Buffer.from('fallback filename')),
    new Response(Buffer.from('id filename')),
    jsonResponse({ id: 'uploaded-1' }),
    jsonResponse({ id: 'uploaded-2' }),
  ], async (requests) => {
    assert.deepEqual((await execute(driveToolModule, harness.context, 'drive.list_files', {
      query: ' name contains report ', pageSize: Number.NaN,
    })).data.files, [{ id: 'file-1' }]);
    assert.deepEqual((await execute(driveToolModule, harness.context, 'drive.list_files', {
      pageSize: 500,
    })).data.files, []);
    assert.match(requests[0].url, /pageSize=20/);
    assert.match(requests[0].url, /q=name\+contains\+report/);
    assert.match(requests[1].url, /pageSize=100/);

    assert.equal((await execute(driveToolModule, harness.context, 'drive.download_file', {})).technicalCode, 'drive_file_required');
    const downloaded = await execute(driveToolModule, harness.context, 'drive.download_file', {
      fileId: 'file/1', filename: ' \u0000report/name.txt ',
    });
    assert.equal(downloaded.data.size, Buffer.byteLength('download body'));
    assert.equal(path.basename(downloaded.data.filePath), 'report-name.txt');
    assert.equal(await fs.readFile(downloaded.data.filePath, 'utf8'), 'download body');

    const fallbackName = await execute(driveToolModule, harness.context, 'drive.download_file', {
      fileId: 'file-2', filename: '..',
    });
    assert.equal(path.basename(fallbackName.data.filePath), 'download');
    const idFilename = await execute(driveToolModule, harness.context, 'drive.download_file', {
      fileId: 'file-3',
    });
    assert.equal(path.basename(idFilename.data.filePath), 'file-3');

    assert.equal((await execute(driveToolModule, harness.context, 'drive.upload_file', {})).technicalCode, 'drive_file_path_required');
    assert.equal((await execute(driveToolModule, harness.context, 'drive.upload_file', {
      filePath: uploadPath,
    })).success, true);
    assert.equal((await execute(driveToolModule, harness.context, 'drive.upload_file', {
      filePath: uploadPath, name: 'Renamed', parentFolderId: 'parent-1', mimeType: 'text/plain',
    })).success, true);
    assert.equal(new Headers(requests[6].init.headers).get('content-type').startsWith('multipart/related; boundary=forger-'), true);
    assert.equal((await execute(driveToolModule, harness.context, 'drive.unknown', {})).technicalCode, 'drive_action_unknown');
  }));
});

test('Google Docs validates document mutations and computes safe append positions from malformed and valid bodies', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-google-docs-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const harness = createContext(root);

  await withOAuthToken(async () => 'google-token', async () => await withFetchQueue([
    jsonResponse({ documentId: 'doc-new' }),
    jsonResponse({ documentId: 'doc-1' }),
    jsonResponse({ malformed: true }),
    jsonResponse({ replies: [] }),
    jsonResponse({ body: { content: [{ endIndex: 12 }, { endIndex: Number.POSITIVE_INFINITY }, null] } }),
    jsonResponse({ replies: [] }),
    jsonResponse({ replies: [] }),
  ], async (requests) => {
    assert.equal((await execute(docsToolModule, harness.context, 'docs.create_document', {})).technicalCode, 'docs_title_required');
    assert.equal((await execute(docsToolModule, harness.context, 'docs.create_document', { title: ' New doc ' })).success, true);
    assert.equal((await execute(docsToolModule, harness.context, 'docs.read_document', {})).technicalCode, 'docs_document_required');
    assert.deepEqual((await execute(docsToolModule, harness.context, 'docs.read_document', { documentId: 'doc-1' })).data, { documentId: 'doc-1' });
    assert.equal((await execute(docsToolModule, harness.context, 'docs.append_text', { documentId: 'doc-1' })).technicalCode, 'docs_text_required');

    assert.equal((await execute(docsToolModule, harness.context, 'docs.append_text', {
      documentId: 'doc-1', text: ' First ',
    })).success, true);
    assert.equal(JSON.parse(requests[3].init.body).requests[0].insertText.location.index, 1);
    assert.equal((await execute(docsToolModule, harness.context, 'docs.append_text', {
      documentId: 'doc-1', text: ' Second ',
    })).success, true);
    assert.equal(JSON.parse(requests[5].init.body).requests[0].insertText.location.index, 11);

    assert.equal((await execute(docsToolModule, harness.context, 'docs.replace_text', {
      documentId: 'doc-1',
    })).technicalCode, 'docs_contains_text_required');
    assert.equal((await execute(docsToolModule, harness.context, 'docs.replace_text', {
      documentId: 'doc-1', containsText: 'old',
    })).technicalCode, 'docs_replace_text_required');
    assert.equal((await execute(docsToolModule, harness.context, 'docs.replace_text', {
      documentId: 'doc-1', containsText: ' old ', replaceText: ' new ',
    })).success, true);
    assert.equal((await execute(docsToolModule, harness.context, 'docs.unknown', {
      documentId: 'doc-1',
    })).technicalCode, 'docs_action_unknown');
  }));
});

test('Google Workspace converts OAuth, HTTP, JSON, Error, and non-Error failures into stable results', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-google-errors-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const harness = createContext(root);

  await withOAuthToken(async () => {
    throw new selfOAuth.OAuthConnectionError('Reconnect Google.', 'google_not_connected');
  }, async () => {
    const result = await execute(calendarToolModule, harness.context, 'calendar.list_calendars');
    assert.deepEqual(result, { success: false, userMessage: 'Reconnect Google.', technicalCode: 'google_not_connected' });
  });

  await withOAuthToken(async () => 'google-token', async () => await withFetchQueue([
    jsonResponse({ error: 'denied' }, 403),
    new Response('not-json', { status: 200 }),
    new Error('network_unavailable'),
    { throwValue: 'raw-network-failure' },
  ], async () => {
    assert.deepEqual(await execute(calendarToolModule, harness.context, 'calendar.list_calendars'), {
      success: false,
      userMessage: 'Could not complete the calendar action.',
      technicalCode: 'calendar_http_403',
    });
    assert.deepEqual((await execute(calendarToolModule, harness.context, 'calendar.list_calendars')).data.calendars, []);
    assert.equal((await execute(calendarToolModule, harness.context, 'calendar.list_calendars')).technicalCode, 'network_unavailable');
    assert.equal((await execute(calendarToolModule, harness.context, 'calendar.list_calendars')).technicalCode, 'calendar_action_failed');
  }));
});
