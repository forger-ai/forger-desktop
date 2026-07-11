---
name: forger-sidekick
description: Use when an installed app has a visible workflow that shows a bounded screen or speaks through a paired Forger Sidekick.
---

- Sidekick is a Desktop-owned local device. Installed apps never connect to its firmware socket and never receive pairing secrets, encrypted envelopes, raw PCM, or synthesized audio bytes.
- Declare `platformCapabilities.sidekickDisplay` before using Sidekick screens. Declare both `platformCapabilities.sidekickSpeech` and `platformCapabilities.textToSpeech` before speaking through Sidekick. Each declaration includes a concrete user-visible `reason` and is shown in Forger's access review.
- The app backend uses the per-app signed Desktop runtime bridge already provided in its runtime environment. Do not expose that environment, its signature secret, or localhost bridge details to the browser UI.
- `GET /v1/apps/:appId/sidekicks` lists only safe device identity, connection status, and capability names. It requires either Sidekick capability.
- `POST /v1/apps/:appId/sidekicks/screen` accepts `sidekickId`, `template`, and the bounded fields supported by that template. Templates are `idle`, `state`, `card`, and `transcript`. State icons are `listening`, `thinking`, `speaking`, `sleeping`, and `error`; card icons come from the Sidekick icon catalog. Desktop rejects unknown templates, icons, missing required fields, and oversized content before contacting the device.
- `POST /v1/apps/:appId/sidekicks/speak` accepts `sidekickId`, `text`, `model`, `voice`, and optional `speed` from 0.5 through 2.0. Text, model, and voice are explicit. Desktop synthesizes a temporary WAV, converts it to the firmware contract, streams it over the paired encrypted transport, and removes temporary synthesis output.
- Treat a Sidekick being offline, lacking the requested firmware capability, or rejecting playback as a normal unavailable-device result. Show the app's original content in its own interface and let the person retry; do not silently redirect to another speaker or device.
- Keep screen content concise and user-visible. Do not send secrets, hidden prompts, internal paths, stack traces, tokens, raw documents, or background telemetry to Sidekick.
