# Meta Lead Ads — Forger Desktop official tool

This document describes what was added to Forger Desktop in `feat/meta-lead-ads-tool` and what the Forger team needs to register externally (Meta App + Forger Cloud) before the tool can run end-to-end.

## What ships in this PR

A new official tool `meta` analogous to the existing Gmail one:

- `desktop/src/main/tools/meta/types.ts` — tool id, secret name, scope list (`leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `public_profile`), input/output types for the actions, the Graph API token-response shape.
- `desktop/src/main/tools/meta/oauth.ts` — PKCE OAuth flow that opens the browser to `https://www.facebook.com/v23.0/dialog/oauth`, listens on one of the pre-allocated loopback ports (`7861`–`7870`), exchanges the code through Forger Cloud, and stores the long-lived user access token in `secretsStore` under `meta/oauth_user_access_token`. Also exposes `refreshMetaAccessToken` for periodic rotation of the long-lived token.
- `desktop/src/main/tools/meta/client.ts` — read-only wrapper over the Graph API: `validateConnection`, `listPages`, `listLeadForms`, `syncLeads` (server-side filtered by `time_created > since`), `getLead`. Handles pagination, page-token resolution, timeouts, and structured error mapping (`MetaApiError`).
- `desktop/src/main/tools/meta/index.ts` — the `InternalToolModule` exported as `metaToolModule`. Declares 5 actions (`meta.connection.status`, `meta.list_pages`, `meta.list_lead_forms`, `meta.sync_leads`, `meta.get_lead`). All read-only — no actions that write back to Meta.

Wiring:

- `desktop/src/main/tools/index.ts` registers `metaToolModule` in `INTERNAL_TOOL_MODULES`.
- `desktop/src/main/tools/types.ts` + `desktop/src/main/official-tools-service.ts` add the Meta OAuth callables to the `InternalToolContext` / `OfficialToolsServiceOptions` interfaces (`getMetaOAuthClientId`, `exchangeMetaOAuthCode`, `refreshMetaOAuthAccessToken`).
- `desktop/src/main/forger-backend-client.ts` adds three new HTTP methods that hit Forger Cloud endpoints `/api/v1/oauth/meta/config`, `/api/v1/oauth/meta/token`, `/api/v1/oauth/meta/refresh` (mirrors the Gmail trio).
- `desktop/src/main/index.ts` wires those callables when constructing the `OfficialToolsService`.
- `desktop/src/main/forger-mcp/tool-metadata.ts` adds JSON Schemas for each `meta.*` action so installed apps that declare the tool see the correct input shapes in MCP `tools/list`.
- `desktop/src/main/forger-mcp-server.ts` extends `isOfficialTool` and `buildOfficialToolCallInput` to recognize the `meta.` prefix.
- `desktop/src/shared/types/tools.ts` extends `AgentToolId` with the 5 new action ids.
- `desktop/src/renderer/app/RendererAppController.tsx` adds the default approval values (high-risk actions require approval by default, status/list don't).

Tests: `desktop/test/main/tools-meta.test.mjs` covers registration, action surface, input validation, the disconnected → connection error path, and the backend client URL/body shapes. All 49 contract tests pass.

## What Forger team needs to register externally (before the tool can run end-to-end)

### 1. Meta App in Facebook Developers

Owner: Forger team.

1. Go to <https://developers.facebook.com/apps> and create a new app under the Forger Business account. App Type: **Business**.
2. Add the **Facebook Login for Business** product. In its settings:
   - **Valid OAuth Redirect URIs**: add all of `http://127.0.0.1:7861/oauth/meta/callback`, `http://127.0.0.1:7862/oauth/meta/callback`, …, `http://127.0.0.1:7870/oauth/meta/callback` (one entry per pre-allocated port; the desktop tool tries them in order until one is free).
   - **Login from Devices**: not used.
   - **Client OAuth Settings → Enforce HTTPS**: leave on, the loopback URIs are exempt.
3. Add the **Marketing API** product (required for `leads_retrieval`).
4. Configure App Review:
   - Request the scopes `pages_show_list`, `pages_read_engagement`, `leads_retrieval`. `public_profile` is granted by default.
   - Provide the standard Meta App Review materials: app icon, privacy policy URL (`https://forger.ai/privacy`), terms of service URL (`https://forger.ai/terms`), screencast showing the OAuth flow + lead fetch, business verification.
   - Expect 1–4 weeks. Test users can be added in Roles → Test Users to exercise the flow before App Review approves the public scopes.
5. Save the **App ID** (this becomes the `client_id` returned by `/api/v1/oauth/meta/config`) and the **App Secret** (only Forger Cloud sees this).

### 2. Forger Cloud endpoints

Owner: backend team.

Add three endpoints under `/api/v1/oauth/meta/`:

- **`GET /config`** — returns `{ "client_id": "<META_APP_ID>" }` to authenticated Forger sessions. The desktop calls this when starting the OAuth flow.
- **`POST /token`** — body `{ client_id, code, code_verifier, redirect_uri }`. Backend calls Meta's token endpoint:
  ```
  GET https://graph.facebook.com/v23.0/oauth/access_token
      ?client_id={META_APP_ID}
      &client_secret={META_APP_SECRET}
      &code={code}
      &code_verifier={code_verifier}
      &redirect_uri={redirect_uri}
  ```
  to get the short-lived user access token, then immediately exchanges it for a long-lived one:
  ```
  GET https://graph.facebook.com/v23.0/oauth/access_token
      ?grant_type=fb_exchange_token
      &client_id={META_APP_ID}
      &client_secret={META_APP_SECRET}
      &fb_exchange_token={short_lived_token}
  ```
  Return shape `{ access_token, token_type, expires_in, scope }` (matches `GmailOAuthTokenResponse`). On Meta errors, return non-2xx with `{ error, error_description }`.
- **`POST /refresh`** — body `{ client_id, user_token }`. Backend calls the long-lived exchange endpoint above using `user_token` as the `fb_exchange_token`. Returns the fresh long-lived token. Used by the desktop to keep the connection alive before the 60-day expiry.

### 3. Privacy policy + terms updates

Owner: comms / legal.

Update `forger.ai/privacy` and `forger.ai/terms` to mention:

- Forger Desktop reads Facebook/Instagram Pages and Lead Ads forms the user authorizes.
- The OAuth refresh token lives in the user's local Desktop installation, encrypted by the OS keychain.
- Lead data the user opts to import lands in the consuming app's local database (e.g. CRM OS), never in Forger Cloud.

Meta App Review rejects without these.

## How an app consumes the tool

After all of the above is in place, an app declares the tool in its `manifest.json`:

```json
{
  "tools": {
    "required": [
      {
        "toolId": "meta",
        "reason": "Importar leads de Lead Ads asociados a productos del catalogo del CRM.",
        "actions": [
          "meta.connection.status",
          "meta.list_pages",
          "meta.list_lead_forms",
          "meta.sync_leads"
        ]
      }
    ]
  }
}
```

CRM OS will be the first consumer (separate PR against `forger-ai/crm-os`). The app-side work adds a `MetaLeadFormMapping` table, an idempotent `/api/integrations/meta/import-lead` endpoint, a Conexiones panel in Settings to map forms to products, and a `crm-meta-lead-sync` skill that drives the actions. That is intentionally **not** part of this PR — this PR only adds the platform tool.

## Risk profile (declared in the tool definition)

- `meta.connection.status` — `low`. Read-only status check.
- `meta.list_pages` — `low`. Lists Pages the user already administers.
- `meta.list_lead_forms` — `medium`. Reads form metadata; no lead PII.
- `meta.sync_leads` — `high`. Returns lead PII (name, email, phone, custom-question answers). Requires explicit user approval per the default approval map in `RendererAppController.tsx`.
- `meta.get_lead` — `high`. Single-lead PII read. Same approval default.

No write actions are exposed. Adding any (publish a form, run an ad, modify a campaign) is intentionally out of scope and would need a separate App Review cycle plus a new approval review here.
