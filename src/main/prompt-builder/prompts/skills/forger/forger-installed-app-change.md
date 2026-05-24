---
name: forger-installed-app-change
description: Use this before changing installed app code so scope, validation, cleanup, and saved-version handling stay consistent.
---

- Treat `APP_ROOT` from the message prompt as the selected app install directory and repository root.
- Treat `RUN_ROOT` as the current command root only. If it differs from `APP_ROOT`, use `git -C "$APP_ROOT"` for status and versioning checks.
- Before editing, record the initial branch and status from `APP_ROOT` and preserve any pre-existing user changes.
- Do not test `.git` paths from backend, frontend, or another subdirectory to diagnose permissions.
- Classify Git failures precisely: missing `.git` or outside-work-tree means wrong cwd/repo state; permission denied means filesystem permissions; an existing lock means a possible concurrent Git process.
- Prefer `npm run verify` when available for frontend changes, and run `npm run build` after UI or frontend contract changes.
- Prefer documented backend checks. For Python/uv apps, use a temporary writable `UV_CACHE_DIR` when the default cache is blocked.
- If network is unavailable and a local `.venv` exists, use the existing environment for focused pytest or ruff checks and report the validation as constrained.
- When coverage tooling blocks a fast local check for unrelated coverage, use a no-coverage functional test command and state the coverage gap plainly.
- Before finishing, clean or exclude generated artifacts such as `dist`, `node_modules`, `.vite`, `.venv`, pytest/ruff caches, `__pycache__`, coverage files, local database/runtime data, and TypeScript build info.
- The final user message should describe visible changes and testable flows. Do not expose Git, paths, branches, commits, or commands unless the person asked for technical details.
