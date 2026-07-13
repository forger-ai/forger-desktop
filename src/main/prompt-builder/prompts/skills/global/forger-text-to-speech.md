---
name: forger-text-to-speech
description: Use when a task needs local voice synthesis through Forger's Text to speech service.
---

- Text to speech is a local Forger platform service, not an installed app, plugin, external Connection, or optional Forger Tool.
- Installed app Text to speech access depends on the app manifest declaring `platformCapabilities.textToSpeech`. Use `forger-manifest-authoring` for the exact manifest change and restart requirement.
- Before promising synthesis, check the service status with `forger_text_to_speech_status`.
- Before choosing a voice, use `forger_text_to_speech_voices`; every synthesis call must pass `text`, `model`, and `voice` explicitly.
- Text to speech is separate from Speech to text. Do not assume STT model settings, audio input settings, or transcription languages apply to TTS.
- Do not rely on hidden defaults. If no suitable model or voice is available, say that local voice synthesis is not ready for that voice.
- The voice defines the language and locale. Do not invent a separate language parameter or claim a voice supports a language unless the voice list says so.
- Use `forger_synthesize_speech` only for text provided by the person, produced by the current task, or requested by an app that declares `platformCapabilities.textToSpeech`.
- Installed app backends that declare `platformCapabilities.textToSpeech` can use the signed Desktop runtime bridge routes `GET /v1/apps/:appId/audio/output-devices`, `GET /v1/apps/:appId/audio/devices`, `POST /v1/apps/:appId/audio/say`, `POST /v1/apps/:appId/audio/synthesis`, `GET /v1/apps/:appId/audio/playbacks/:playbackId`, and `POST /v1/apps/:appId/audio/playbacks/:playbackId/cancel`.
- Speaking through a paired Sidekick additionally requires `platformCapabilities.sidekickSpeech`. Use the signed `GET /v1/apps/:appId/sidekicks` and `POST /v1/apps/:appId/sidekicks/speak` routes; Desktop keeps synthesis bytes, pairing secrets, and the firmware transport private.
- Use `POST /v1/apps/:appId/audio/say` for ephemeral playback. The call queues playback, returns a `playbackId`, and Desktop deletes the temporary synthesized audio after playback completes or fails.
- Use `POST /v1/apps/:appId/audio/synthesis` only when an app needs generated audio bytes for its own authorized flow. Do not use `/audio/say` when the app needs to store, download, or inspect the audio bytes.
- If an app needs a specific speaker, list output devices through the signed Desktop runtime bridge first and pass the returned `outputDeviceId` to `/audio/say`. Omitting it uses the system default output.
- Do not invent voices, languages, model names, paths, endpoints, aliases, route fallbacks, or tokens. If the signed Desktop runtime bridge route is unavailable, report that the platform capability is unavailable.
- Explain the result in functional language: what was synthesized, which model and voice were used, and what remains unavailable if the local service is not installed or running.
- Do not tell the person to call endpoints, pass tokens, run Python commands, or manage localhost URLs.
