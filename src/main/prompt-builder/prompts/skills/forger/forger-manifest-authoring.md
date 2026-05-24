---
name: forger-manifest-authoring
description: Write and review Forger app manifests using the current manifest contract.
---

- Use this skill before creating or editing an app `manifest.json`.
- A manifest is an internal Forger platform contract. It describes how Forger installs, runs, prompts, grants tools to, and operates an app. It is not the list of visible app features.
- Current non-deprecated manifest sections include `name`, `version`, `description`, `changelog`, `stack`, `catalog`, `services`, `mcp`, `tools`, `appSecrets`, `promptTemplates`, `agents`, `scripts`, `skills`, `cloudMessaging`, `agentRuntime`, `remoteTunnel`, and `localNetworkShare`.
- Do not add `catalog.capabilities` to new manifests. Use separate manifest sections for tools, secrets, app agents, prompt templates, scripts, skills, messaging, runtime, remote tunnel, and local network sharing.
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
      "ui": "MUI"
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
          "maxLength": 2000
        }
      ],
      "prompt": "Review the provided sourceFile and use notes when provided.",
      "runtimeRecommendations": {
        "codex": {
          "model": "gpt-5.4",
          "reasoningEffort": "medium"
        },
        "claude": {
          "model": "claude-sonnet-4-5",
          "effort": "medium"
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
          "model": "claude-sonnet-4-5",
          "effort": "medium"
        }
      }
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
    "networkAccess": false
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
- `agents` are resumable conversational coworkers. Prefer `prompts.initial.body`, with optional `prompts.resume.body` and `prompts.steer.body`; do not use legacy `name` or top-level `prompt`.
- Prompt variables for agents live under each prompt as `variables`; variable types are `text`, `string`, `json`, or `path`.
- In real manifest prompt bodies, refer to declared variables with the app prompt syntax expected by that surface. This skill template avoids literal double-brace examples because Desktop renders this file as a strict Markdown template.
- `tools` declares official Forger tools only. Today the official tool is Gmail, with actions `gmail.connection.status`, `gmail.search_messages`, `gmail.read_thread`, `gmail.read_attachment`, and `gmail.send_email`.
- Put Gmail in `tools.required` only when the app cannot perform its core purpose without Gmail. Otherwise put it in `tools.optional`.
- Do not declare Gmail OAuth credentials in `appSecrets`; Forger Tools owns Gmail OAuth connection and token storage.
- `appSecrets` are declarations only. They never store secret values. Never put secret values in manifests, prompts, logs, memory, generated files, test fixtures, screenshots, or final messages.
- `scripts` and `skills` are internal agent tools, not visible app features.
- `agentRuntime.networkAccess` controls whether app agent runs can use network access by default. Keep it `false` unless the app has a concrete need.
- Keep `localNetworkShare` and `remoteTunnel` as top-level runtime flags. Do not move them into `catalog.capabilities` or visible feature lists.
- For relational app data, prefer explicit SQLite/SQLModel tables and typed columns. Do not add JSON columns unless the data is genuinely schemaless and the reason is documented.
