---
name: forger-remote-tunnel-wiring
description: Use when changing remoteTunnel or localNetworkShare manifest flags, frontend API clients, entrypoints, uploads, downloads, browser-only flows, or local-vs-remote app access.
---

- New apps created from Forger must keep these top-level manifest flags enabled:

```json
{
  "localNetworkShare": true,
  "remoteTunnel": true
}
```

- These flags are internal runtime permissions. Do not describe them as visible app features unless the app also implements visible sharing or remote-access UI.
- Remote tunnel access depends on the app manifest declaring `"remoteTunnel": true`. Use `forger-manifest-authoring` for the exact manifest change and restart requirement.
- Remote tunnel sessions let the person reach the local app through the Forger mobile app. The mobile app is in closed beta; people who need access should write to the contact email published by Forger, currently `hello@forger.cloud`.
- Forger Desktop owns the local network and remote tunnel lifecycle. Apps must not create their own public server, start an independent tunnel, ask the person to open ports, or treat a tunnel provider as the app privacy boundary.
- In `vite-fastapi-sqlite` apps, frontend calls go through the shared API client. Normal local requests stay on the configured API base URL; remote requests use the shared remote tunnel helper when Desktop builds a remote session.
- Frontend code must not call Forger Desktop directly. The durable chain is `frontend -> app backend route -> app.forger_desktop or app-owned service -> Forger Desktop`.
- If the app includes the shared remote tunnel frontend module, mount the remote session floating control once from the frontend entrypoint and keep it from covering core mobile actions.
- Do not add app-owned remote tunnel security middleware unless the current Desktop/runtime contract requires it for that app. Desktop owns the remote tunnel session security boundary.
- Keep assistant, MCP, script, and internal automation routes out of remote user workflows unless there is a reviewed product reason to expose a specific route.
- Do not promise mobile remote access for an app unless `remoteTunnel` is active in the manifest and Forger Desktop has restarted with that manifest.
- Verify that local API calls still work normally, mobile remote sessions remain usable, and uploads, JSON requests, downloads, and error responses behave the same from local and remote entrypoints.
