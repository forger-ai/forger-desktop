---
name: forger-secrets
description: Use when an app needs credentials, tokens, API keys, private configuration, appSecrets manifest declarations, runtime environment injection, missing-secret handling, or secret safety.
---

- App secrets let a person connect credentials, tokens, keys, or private configuration to one installed app.
- The manifest declares which secrets the app needs; Forger stores the actual values separately and injects them safely at runtime.
- Secret values must not appear in manifests, prompts, memory, logs, generated files, tests, screenshots, or final messages.
- Use `forger-manifest-authoring` when writing the exact `manifest.json` shape for app secret declarations.
- If a secret is missing, explain the missing setup in product language and avoid printing internal variable names unless technical detail is requested.
