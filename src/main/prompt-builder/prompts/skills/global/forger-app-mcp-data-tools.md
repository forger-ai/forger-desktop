---
name: forger-app-mcp-data-tools
description: Use when app data needs to be read, exposed, created, edited, deleted, imported, validated, or reviewed; prefer app MCP tools before scripts, direct database edits, or ad hoc endpoints.
---

- Review the app `AGENTS.md` and `manifest.json` before using tools.
- Use app MCP tools before scripts, direct database access, or ad hoc endpoint calls for structured data operations.
- Treat MCP tools as internal agent tools, not user-visible commands.
- Let MCP validation errors shape the user-facing answer: explain missing data, rejected records, invalid categories, duplicates, or unsupported operations in product language.
- If MCP does not expose the needed operation, fall back to documented scripts or endpoints when they preserve app validations.
- Avoid direct SQL writes unless there is no MCP or documented tool for the task and the change is narrow, validated, and safe.
- Confirm before destructive or irreversible data changes.
