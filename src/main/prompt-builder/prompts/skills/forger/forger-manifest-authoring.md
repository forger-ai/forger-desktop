---
name: forger-manifest-authoring
description: Use when creating, editing, validating, or reviewing app manifest.json fields for stack, services, tools, appSecrets, promptTemplates, agents, scripts, skills, tunnel, or catalog metadata.
---

- A manifest is an internal Forger platform contract. It describes how Forger installs, runs, prompts, grants tools to, and operates an app. It is not the list of visible app features.
- Current non-deprecated manifest sections include `name`, `version`, `description`, `changelog`, `stack`, `catalog`, `platformCapabilities`, `services`, `mcp`, `tools`, `appSecrets`, `promptTemplates`, `agents`, `scripts`, `skills`, `cloudMessaging`, `agentRuntime`, `remoteTunnel`, and `localNetworkShare`.
- Treat `catalog.capabilities` as decorative catalog copy only. Do not add `catalog.capabilities` for runtime behavior, permissions, service access, tools, secrets, app agents, prompt templates, scripts, skills, messaging, remote tunnel, local network sharing, Speech to text, or Text to speech.
- `localNetworkShare` and `remoteTunnel` are top-level manifest flags. New apps created from Forger default both flags to `true` so Desktop can provide local network sharing and remote tunnel sessions.

## Full Manifest JSON Contract
Use this shape as the current authoring contract. Remove fields that do not apply instead of leaving fake capabilities.

```json
{
  "name": "Example App",
  "version": "1.0.0",
  "description": "Short product description.",
  "changelog": [
    {
      "version": "1.0.0",
      "summary": "Initial release.",
      "changes": ["Describe a visible product change."]
    }
  ],
  "catalog": {
    "category": "productividad",
    "status": "production",
    "icon": "assets/icon.png"
  },
  "platformCapabilities": {
    "speechToText": {
      "required": false,
      "reason": "Lets this app transcribe audio files selected by the person through Forger's local Speech to text service."
    },
    "textToSpeech": {
      "required": false,
      "reason": "Lets this app synthesize spoken audio from text through Forger's local Text to speech service."
    },
    "audioInput": {
      "required": false,
      "reason": "Lets this app access live microphone or system audio input for a visible recording or monitoring workflow."
    }
  },
  "stack": {
    "backend": {
      "language": "Python",
      "framework": "FastAPI",
      "package_manager": "uv",
      "database": "SQLite"
    },
    "frontend": {
      "language": "TypeScript",
      "framework": "React",
      "bundler": "Vite",
      "ui": "tailwind-shadcn-radix"
    }
  },
  "services": [
    {
      "name": "backend",
      "type": "backend",
      "port": 8000,
      "command": "uv run uvicorn app.main:app --host 127.0.0.1 --port {port}",
      "healthcheck": "/health",
      "context": "backend",
      "environment": {
        "EXAMPLE_ENV": "value"
      },
      "volumes": [
        {
          "source": "data",
          "target": "backend/data",
          "persist": true
        }
      ]
    },
    {
      "name": "frontend",
      "type": "frontend",
      "port": 5173,
      "command": "npm run dev -- --host 127.0.0.1 --port {port}",
      "healthcheck": "/",
      "context": "frontend"
    }
  ],
  "mcp": {
    "type": "http",
    "context": "backend",
    "command": "uv run python -m app.mcp_server",
    "healthcheck": "/health",
    "environment": {},
    "toolTimeoutSec": 30
  },
  "tools": {
    "required": [],
    "optional": [
      {
        "toolId": "gmail",
        "reason": "Lets this app help you search, read, download attachments from, or send email when you explicitly ask.",
        "actions": [
          "gmail.connection.status",
          "gmail.search_messages",
          "gmail.read_thread",
          "gmail.read_attachment",
          "gmail.send_email"
        ]
      }
    ]
  },
  "appSecrets": [
    {
      "name": "EXAMPLE_API_KEY",
      "label": "Example service key",
      "required": false,
      "usage": "Used to connect this app to the person's Example account."
    }
  ],
  "promptTemplates": [
    {
      "id": "import-file",
      "title": "Import file",
      "description": "Read a shared file and prepare records for review.",
      "arguments": [
        {
          "name": "sourceFile",
          "type": "file",
          "required": true,
          "multiple": false,
          "acceptedFileTypes": [".csv", ".xlsx"],
          "maxBytes": 10485760
        },
        {
          "name": "notes",
          "type": "string",
          "required": false,
          "maxLength": 60000
        }
      ],
      "prompt": "Review the provided sourceFile and use notes when provided.",
      "permissionMode": "safe",
      "runtimeRecommendations": {
        "codex": {
          "model": "gpt-5.4",
          "reasoningEffort": "medium"
        },
        "claude": {
          "model": "claude-sonnet-4-6",
          "effort": "high"
        }
      }
    }
  ],
  "agents": [
    {
      "id": "reviewer",
      "title": "Reviewer",
      "description": "Helps review app data with the person.",
      "kind": "thread_interface",
      "prompts": {
        "initial": {
          "body": "Start the review for the provided topic.",
          "variables": {
            "topic": {
              "type": "text",
              "required": true
            }
          }
        },
        "resume": {
          "body": "Continue the review for the provided topic.",
          "variables": {
            "topic": {
              "type": "text",
              "required": true
            }
          }
        },
        "steer": {
          "body": "Adjust the current review using the provided instruction.",
          "variables": {
            "instruction": {
              "type": "text",
              "required": true
            }
          }
        }
      },
      "runtimeRecommendations": {
        "codex": {
          "model": "gpt-5.4",
          "reasoningEffort": "medium"
        },
        "claude": {
          "model": "claude-sonnet-4-6",
          "effort": "high"
        }
      },
      "permissionMode": "safe"
    }
  ],
  "scripts": {
    "import": "uv run python scripts/import_data.py",
    "validate": "uv run python scripts/validate_data.py"
  },
  "skills": [
    ".agents/skills/app-data-import"
  ],
  "agentRuntime": {
    "networkAccess": true
  },
  "cloudMessaging": {
    "enabled": false,
    "defaultDelivery": "persistent"
  },
  "localNetworkShare": true,
  "remoteTunnel": true
}
```

## Authoring Rules
- `promptTemplates` are one-shot tasks. Use them for bounded, form-backed work. Use `id`, `title`, `description`, `arguments`, and `prompt`; do not use legacy `name` or `inputs`.
- Use `maxLength: 60000` for freeform text arguments such as `idea`, `description`, `instructions`, or long user notes. Keep small limits only for intentionally short fields such as titles, IDs, labels, dates, or category names.
- `agents` are resumable conversational coworkers. Prefer `prompts.initial.body`, with optional `prompts.resume.body` and `prompts.steer.body`; do not use legacy `name` or top-level `prompt`.
- Prompt variables for agents live under each prompt as `variables`; variable types are `text`, `string`, `json`, or `path`.
- In real manifest prompt bodies, refer to declared variables with the app prompt syntax expected by that surface. This skill template avoids literal double-brace examples because Desktop renders this file as a strict Markdown template.
- Recommended Claude models for new manifests are versioned ids: `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, and `claude-haiku-4-5-20251001`. Prefer `claude-sonnet-4-6` unless the task clearly needs Opus or Haiku.
- Do not use legacy Claude Code aliases such as `best`, `default`, `opus`, `sonnet`, `haiku`, `opus[1m]`, `sonnet[1m]`, or `opusplan` in new manifests. They remain readable for compatibility only.
- `permissionMode` controls provider filesystem permissions for a prompt template or agent. Use `"safe"` by default. Use `"unsafe"` only when that specific task or agent needs broad filesystem access, and make sure the user can see and edit that choice in Forger.
- `permissionMode` may be declared directly on `promptTemplates[]` or `agents[]`, or inside an explicit `runtime` block when the manifest uses one.
- `tools` declares official Forger tools only. Available official tools include Gmail actions (`gmail.connection.status`, `gmail.search_messages`, `gmail.read_thread`, `gmail.read_attachment`, `gmail.send_email`) and WhatsApp actions (`whatsapp.connection.status`, `whatsapp.start_pairing`, `whatsapp.list_chats`, `whatsapp.read_messages`, `whatsapp.download_attachment`, `whatsapp.send_message`, `whatsapp.get_chat_details`).
- Every entry in `tools.required[]` and `tools.optional[]` must include `toolId`, `reason`, and `actions`. `reason` is required, not decorative; it must explain the user-visible reason this app needs that official tool access.
- Put Gmail in `tools.required` only when the app cannot perform its core purpose without Gmail. Otherwise put it in `tools.optional`.
- Do not declare Gmail OAuth credentials in `appSecrets`; Forger Tools owns Gmail OAuth connection and token storage.
- `appSecrets` are declarations only. They never store secret values. Never put secret values in manifests, prompts, logs, memory, generated files, test fixtures, screenshots, or final messages.
- `scripts` and `skills` are internal agent tools, not visible app features.
- `agentRuntime.networkAccess` controls whether manifest-declared app agent runs can use network access by default.
- `platformCapabilities.speechToText` is the runtime declaration for Forger's local Speech to text service. Use it only when the app has a real audio file transcription, translation, or authorized realtime transcription workflow. File transcription can request a non-default faster-whisper model when the app needs higher quality; realtime transcript workflows use Desktop's active Speech to text model.
- `platformCapabilities.audioInput` is the runtime declaration for visible raw live microphone or system audio access. Use it only when the app has a real raw recording, live monitoring, or audio-processing workflow. It declares permission and user-facing intent; it does not provide a Desktop raw-audio bridge endpoint. Do not use `speechToText` as a substitute for raw audio access.
- `platformCapabilities.textToSpeech` is the runtime declaration for Forger's local Text to speech service. Use it only when the app has a real local voice synthesis workflow where calls provide explicit text, model, and voice. Apps can use the signed Desktop runtime bridge `/audio/say` endpoint for ephemeral playback after listing output devices. `reason` must describe the user-visible workflow enabled by that local service.
- Keep `localNetworkShare` and `remoteTunnel` as top-level runtime flags. Do not move them into `catalog.capabilities` or visible feature lists.
- For relational app data, prefer explicit SQLite/SQLModel tables and typed columns. Do not add JSON columns unless the data is genuinely schemaless and the reason is documented.
