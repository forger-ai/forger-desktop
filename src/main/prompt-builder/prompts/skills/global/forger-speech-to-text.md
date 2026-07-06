---
name: forger-speech-to-text
description: Use when a task needs local audio transcription or translation through Forger's Speech to text service.
---

- Speech to text is a local Forger platform service, not an installed app, plugin, external Connection, or optional Forger Tool.
- Installed app Speech to text access depends on the app manifest declaring `platformCapabilities.speechToText`. Use `forger-manifest-authoring` for the exact manifest change and restart requirement.
- Before promising transcription or translation, check the service status with `forger_speech_to_text_status`.
- Use file transcription for existing audio files. Use realtime only for an active Desktop or authorized app session where the person has started microphone capture.
- Use `forger_transcribe_audio` or `forger_translate_audio` only with files explicitly shared by the person, files selected through Forger, or files from an app that declares `platformCapabilities.speechToText`.
- Prefer the active/default Speech to text model. Omit `model` unless the person or app specifically needs a higher quality file transcription or translation.
- `model` is supported only for file transcription and translation. Realtime microphone transcription and translation use the active model configured in Desktop.
- When a non-default file model is requested, Desktop may load that faster-whisper model on demand and reuse it while it remains active.
- Raw live audio access is separate from speech transcription. It requires `platformCapabilities.audioInput`, not just `platformCapabilities.speechToText`, and apps capture that raw audio through their own visible frontend flow rather than a Desktop raw-audio bridge endpoint.
- Installed app backends can list audio input devices through the signed Desktop runtime bridge before requesting realtime transcription. Use the returned device ids as `deviceId`; `default` means the system default input.
- Realtime transcript bridge sessions require `platformCapabilities.speechToText`.
- Installed app backends that declare `platformCapabilities.speechToText` can use the signed Desktop runtime bridge routes `GET /v1/apps/:appId/audio/input-devices`, `GET /v1/apps/:appId/audio/devices`, `POST /v1/apps/:appId/audio/transcriptions`, `DELETE /v1/apps/:appId/audio/transcriptions/:consumerId`, and `POST /v1/apps/:appId/audio/file-transcriptions`.
- `POST /v1/apps/:appId/audio/transcriptions` creates a realtime session descriptor. The live transcript data flows over the returned WebSocket session; polling REST transcript endpoints are not part of the contract. When the app closes that live stream, it must close the Desktop consumer with `DELETE /v1/apps/:appId/audio/transcriptions/:consumerId`.
- Use `POST /v1/apps/:appId/audio/file-transcriptions` only for saved audio files that are already authorized for the app.
- Do not invent fallback bridge route names, raw-audio bridge routes, aliases, query-token endpoints, or polling transcript endpoints. If the signed Desktop runtime bridge route is unavailable, report that the platform capability is unavailable.
- Do not read arbitrary filesystem paths for audio. If the file is not authorized, ask the person to share or select it through Forger.
- Realtime microphone transcription is not permission to capture audio on your own. Treat it as a Desktop/Settings or app-authorized live session, not as a filesystem or endpoint to manage manually.
- If the service is not installed, not running, or busy, explain what remains unavailable and what Forger needs before transcription can proceed.
- Explain the result in functional language: what audio was processed, whether transcription or translation succeeded, and what text was produced.
- Do not tell the person to call endpoints, pass tokens, run Python commands, or manage localhost URLs.
