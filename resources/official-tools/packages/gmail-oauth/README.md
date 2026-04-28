# Gmail OAuth tool

This official tool package declares the Gmail OAuth contract used by Forger Desktop.

The package does not include Google credentials. A working OAuth connection requires a Google Cloud OAuth Client ID and Client Secret registered for Forger with an approved local redirect URI and consent screen. The secure implementation path is Authorization Code with PKCE initiated by the Electron main process. Tokens and client secret values stay in the local secure vault and are never sent to the renderer or logs.

Declared actions:

- `official_gmail_oauth_status`
- `official_gmail_prepare_draft`

Declared secrets:

- `google_oauth_client_id`
- `google_oauth_client_secret`
