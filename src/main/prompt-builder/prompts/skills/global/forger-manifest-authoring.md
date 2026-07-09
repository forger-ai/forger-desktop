---
name: forger-manifest-authoring
description: Use when an app needs platform runtime wiring or manifest changes: services, MCP/data tools, Forger Tools, Connections, secrets, promptTemplates, AI tasks, recommendations/import/extract/summarize/generate flows, app agents/assistants/advisors, skills/scripts, platformCapabilities, tunnels, catalog/install metadata, or manifest.json validation.
---

- Use this skill even when the person does not say "manifest". Product requests often imply manifest work when an app needs an AI task, assistant, recommendation flow, import/extract/summarize/generate workflow, connected account, Forger Tool, app secret, runtime capability, local sharing, internet sharing, app-local skill, script, service, MCP server, or catalog/install behavior.
- A manifest is an internal Forger platform contract. It describes how Forger installs, runs, prompts, grants Forger Tools and Connections to, and operates an app. It is not the list of visible app features.
- Current non-deprecated manifest sections include `name`, `version`, `description`, `changelog`, `stack`, `catalog`, `platformCapabilities`, `services`, `mcp`, `tools`, `connections`, `appSecrets`, `promptTemplates`, `agents`, `scripts`, `skills`, `cloudMessaging`, `agentRuntime`, `remoteTunnel`, and `localNetworkShare`.
- Treat `catalog.capabilities` as decorative catalog copy only. Do not add `catalog.capabilities` for runtime behavior, permissions, service access, Forger Tools, Connections, secrets, app agents, prompt templates, scripts, skills, messaging, remote tunnel, local network sharing, Speech to text, or Text to speech.
- If `catalog.supported_platforms` declares Windows, macOS, or Linux support, app code must respect that platform contract. Use `forger-cross-platform-app-code` when code touches OS detection, filesystem paths, processes, runtime startup, scripts, MCP helpers, or app-agent helpers.
- `localNetworkShare` and `remoteTunnel` are top-level manifest flags. New apps created from Forger default both flags to `true` so Desktop can provide local network sharing and remote tunnel sessions.
- Agents may edit `manifest.json` when an app needs platform runtime access. Adding `platformCapabilities`, `localNetworkShare`, `remoteTunnel`, `tools.required`, or `connections.required` is the app declaring its runtime contract; after the app is restarted, Desktop re-reads the manifest and wires the matching platform bridge, access metadata, required Forger Tool actions, or required Connection actions. Optional Forger Tools and Connections still need a user grant or approval before the app can use them.

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
    "category": "productivity",
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
    },
    "workspaceFolders": {
      "required": false,
      "reason": "Lets this app ask the person to grant selected folders for an explicit app workflow that needs to read or write files outside the app-private workspace."
    },
    "agentRuntimeControl": {
      "required": false,
      "reason": "Lets this app choose provider, model, or effort per agent task or manifest-agent run for a visible model-selection workflow."
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
        "toolId": "forger_chrome_extension",
        "reason": "Lets this app operate a dedicated Chrome session when you ask it to open, inspect, navigate, fill, submit, or visually adjust pages.",
        "actions": ["*"]
      }
    ]
  },
  "connections": {
    "required": [],
    "optional": [
      {
        "type": "gmail",
        "reason": "Lets this app help you search, read, download attachments from, or send email when you explicitly ask.",
        "actions": [
          "gmail.connection.status",
          "gmail.get_profile",
          "gmail.list_labels",
          "gmail.list_threads",
          "gmail.search_messages",
          "gmail.read_thread",
          "gmail.list_changes",
          "gmail.modify_thread",
          "gmail.read_attachment",
          "gmail.list_drafts",
          "gmail.get_draft",
          "gmail.save_draft",
          "gmail.send_draft",
          "gmail.send_email"
        ],
        "multiple": false
      },
      {
        "type": "whatsapp",
        "reason": "Lets this app read or send approved WhatsApp messages for the selected workflow.",
        "actions": [
          "whatsapp.connection.status",
          "whatsapp.list_chats",
          "whatsapp.read_messages",
          "whatsapp.send_message"
        ],
        "multiple": true
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
          "model": "gpt-5.2",
          "reasoningEffort": "medium"
        },
        "claude": {
          "model": "claude-sonnet-5",
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
          "model": "gpt-5.2",
          "reasoningEffort": "medium"
        },
        "claude": {
          "model": "claude-sonnet-5",
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
- Recommended Claude models for new manifests are versioned ids: `claude-sonnet-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, and `claude-haiku-4-5-20251001`. Prefer `claude-sonnet-5` unless the task clearly needs Fable, Opus, or Haiku.
- Do not use legacy Claude Code aliases such as `best`, `default`, `opus`, `sonnet`, `haiku`, `opus[1m]`, `sonnet[1m]`, or `opusplan` in new manifests. They remain readable for compatibility only.
- `permissionMode` controls provider filesystem permissions for a prompt template or agent. Use `"safe"` by default. Use `"unsafe"` only when that specific task or agent needs broad filesystem access, and make sure the user can see and edit that choice in Forger.
- `permissionMode` may be declared directly on `promptTemplates[]` or `agents[]`, or inside an explicit `runtime` block when the manifest uses one.
- `tools` declares Forger Tools only. Use it for Forger-owned actions such as Forger Chrome Extension (`forger_chrome_extension.connection.status`, `forger_chrome_extension.open_dedicated_tab`, `forger_chrome_extension.get_current_url`, `forger_chrome_extension.navigate`, `forger_chrome_extension.get_html`, `forger_chrome_extension.wait_for_selector`, `forger_chrome_extension.click`, `forger_chrome_extension.focus`, `forger_chrome_extension.hover`, `forger_chrome_extension.input_text`, `forger_chrome_extension.submit_form`, `forger_chrome_extension.get_styles`, `forger_chrome_extension.set_styles`, `forger_chrome_extension.close_window`, `forger_chrome_extension.close_session`). Do not put external Connections such as Gmail, Google Calendar, Google Sheets, Google Drive, Google Docs, GitHub, Notion, WhatsApp, Slack, or Trello in `tools`.
- `connections` declares external accounts, workspaces, services, or sessions. Use it for Gmail actions (`gmail.connection.status`, `gmail.get_profile`, `gmail.list_labels`, `gmail.search_messages`, `gmail.list_threads`, `gmail.read_thread`, `gmail.list_changes`, `gmail.modify_thread`, `gmail.move_thread`, `gmail.read_attachment`, `gmail.list_drafts`, `gmail.get_draft`, `gmail.save_draft`, `gmail.delete_draft`, `gmail.send_draft`, `gmail.send_email`), Google Calendar actions (`calendar.connection.status`, `calendar.list_events`, `calendar.create_event`, `calendar.update_event`, `calendar.delete_event`), Google Sheets actions (`sheets.connection.status`, `sheets.read_range`, `sheets.append_rows`, `sheets.update_range`), Google Drive actions (`drive.connection.status`, `drive.list_files`, `drive.download_file`, `drive.upload_file`), Google Docs actions (`docs.connection.status`, `docs.read_document`, `docs.create_document`, `docs.append_text`, `docs.replace_text`), GitHub actions (`github.connection.status`, `github.list_repositories`, `github.search_issues`, `github.get_issue`, `github.create_issue`, `github.create_comment`), Notion actions (`notion.connection.status`, `notion.search`, `notion.get_page`, `notion.get_database`, `notion.query_database`, `notion.create_page`, `notion.update_page`), WhatsApp actions (`whatsapp.connection.status`, `whatsapp.start_pairing`, `whatsapp.list_chats`, `whatsapp.read_messages`, `whatsapp.download_attachment`, `whatsapp.send_message`, `whatsapp.get_chat_details`), Slack actions, Trello actions, and future external services.
- For Gmail apps, keep the manifest scoped to the product need. Mailbox list, labels, profile, sync, and read actions can be `connections.required` only when the app cannot function without them. Sending, drafts, trash/untrash, and attachment download should be `connections.optional` unless the app's core purpose clearly requires them.
- Every entry in `tools.required[]` and `tools.optional[]` must include `toolId`, `reason`, and `actions`. Every entry in `connections.required[]` and `connections.optional[]` must include `type`, `reason`, `actions`, and `multiple`. `reason` is required, not decorative; it must explain the user-visible reason this app needs that access.
- `actions` remains a string array. It may contain the special token `"*"`, which means every current action for that single Forger Tool or Connection type; it never grants actions from another tool or connection type. Use `["*"]` only when the app genuinely needs the full surface. For Connections, Desktop resolves and freezes the current action set at approval time, so later new actions require review before they become available.
- `tools.required` and `connections.required` mean the app declares a functional dependency. After the app restarts, Desktop wires the declared required action set for that app. Desktop still allows installation when the underlying Forger Tool or Connection is missing or unconfigured; at runtime, calls to missing, inactive, unconfigured, or undeclared actions fail with an access error.
- `tools.optional` and `connections.optional` require a user grant or approval before the app can use them. Optional access may be preselected in an install or review access modal when there is no saved grant, but it is not available to the app until the person confirms it. The person can connect, disconnect, grant, or revoke optional access later from Forger surfaces.
- Put a Connection in `connections.required` only when the app cannot perform its core purpose without that external service. Otherwise put it in `connections.optional`.
- Do not declare OAuth tokens, Google refresh tokens, GitHub access tokens, Notion integration tokens, Slack tokens, Trello keys, or WhatsApp sessions in `appSecrets`; Forger Connections own external account setup and account/session storage.
- Chrome `set_styles` grants must be tied to temporary visual highlighting or restoring selected elements, not arbitrary CSS or persistent page changes. Chrome `submit_form` grants are sensitive because they can send data or trigger remote changes.
- `appSecrets` are declarations only. They never store secret values. Never put secret values in manifests, prompts, logs, memory, generated files, test fixtures, screenshots, or final messages.
- `scripts` and `skills` are internal agent tools, not visible app features.
- `agentRuntime.networkAccess` controls whether manifest-declared app agent runs can use network access by default.
- `platformCapabilities` are runtime declarations shown in Forger's access review and app detail views. They are not user grants, Forger Tools, Connections, app secrets, scripts, catalog capabilities, or provider filesystem permissions. After the app restarts, Desktop re-reads supported platform capabilities and wires the matching signed runtime bridge behavior for that app.
- `platformCapabilities.speechToText` is the runtime declaration for Forger's local Speech to text service. Use it only when the app has a real audio file transcription, translation, or authorized realtime transcription workflow. File transcription can request a non-default faster-whisper model when the app needs higher quality; realtime transcript workflows use Desktop's active Speech to text model.
- `platformCapabilities.audioInput` is the runtime declaration for visible raw live microphone or system audio access. Use it only when the app has a real raw recording, live monitoring, or audio-processing workflow. It declares permission and user-facing intent; it does not provide a Desktop raw-audio bridge endpoint. Do not use `speechToText` as a substitute for raw audio access.
- `platformCapabilities.textToSpeech` is the runtime declaration for Forger's local Text to speech service. Use it only when the app has a real local voice synthesis workflow where calls provide explicit text, model, and voice. Apps can use the signed Desktop runtime bridge `/audio/say` endpoint for ephemeral playback after listing output devices. `reason` must describe the user-visible workflow enabled by that local service.
- `platformCapabilities.workspaceFolders` is the runtime declaration for folder-grant workflows. Use it only when the app has a visible feature that needs the person to grant one or more external folders. It does not grant access by itself, and it is not a provider filesystem setting, Forger Tool, Connection, app secret, script, or catalog capability.
- `platformCapabilities.agentRuntimeControl` is the runtime declaration for app backend flows that choose provider, model, or effort per agent task or manifest-agent run through the signed Desktop runtime bridge. Use it only when the app has a visible workflow that needs model selection. It may be `true` or an object with `required` and `reason`; prefer the object form with a concrete user-visible reason. Without it, any request body that sends `runtime` to agent tasks or manifest-agent start, resume, or steer is rejected, and those runs use the runtime configured in the manifest, prompt overrides, or Desktop defaults.
- Folder grants are Forger-owned permissions. The app may request them only through Forger-controlled UI or runtime flows, must explain the user-visible reason, and must treat grant ids as handles to approved folders instead of asking agents, backends, or prompts to browse arbitrary local paths.
- Prompt-template tasks, app agent runs, and conversation runs that need granted folders should receive a `workspace` object with `cwdGrantId` for the selected working folder and `additionalFolderGrantIds` for extra approved folders. Apps may keep returned full paths in saved data, UI, and prompts so agents can understand the person's workspace, but raw paths are context only; Desktop authorizes and resolves access from grant ids.
- Keep `localNetworkShare` and `remoteTunnel` as top-level runtime flags. Do not move them into `catalog.capabilities` or visible feature lists. After changing these flags, restart the app so Desktop updates the installed app runtime metadata and sharing/tunnel support.
- After changing manifest runtime wiring, including `platformCapabilities`, `tools.required`, `tools.optional`, `connections.required`, `connections.optional`, `localNetworkShare`, `remoteTunnel`, services, app agents, prompt templates, or app secrets, restart the app before claiming the new contract is available.
- For relational app data, prefer explicit SQLite/SQLModel tables and typed columns. Do not add JSON columns unless the data is genuinely schemaless and the reason is documented.
