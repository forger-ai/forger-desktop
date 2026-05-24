---
name: forger-secrets
description: Understand app secrets, used when people need to share personal credentials with an app through safe environment variables.
---

- App secrets let a person connect credentials, tokens, keys, or private configuration to one installed app.
- The manifest declares which secrets the app needs; Forger stores the actual values separately and injects them safely at runtime.
- Secret values must not appear in manifests, prompts, memory, logs, generated files, tests, screenshots, or final messages.
- Use `forger-manifest-authoring` when writing the exact `manifest.json` shape for app secret declarations.
- If a secret is missing, explain the missing setup in product language and avoid printing internal variable names unless technical detail is requested.
