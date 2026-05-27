---
name: forger-python-backend
description: Use small, safe Python backend changes focused on validation, persistence integrity, and local Forger app constraints.
---

- Keep domain validations before persisting data. Validate required fields, ranges, ownership, duplicates, state transitions, and destructive operations before writing to SQLite.
- Prefer explicit SQLModel/SQLite columns and relationships. Do not add JSON columns unless the data is genuinely schemaless and the reason is documented.
- Keep persistence and file work inside the app-private workspace unless the user explicitly shared a file for the task.
- Secrets are declarations and runtime-injected values. Do not add credentials to manifests, logs, tests, prompt text, or committed files.
- Avoid breaking payload compatibility without explaining the impact and updating the matching frontend API types.
- Prefer clear, testable changes that are easy to revert.
- Test realistic backend flows instead of only isolated helpers when routes, models, migrations, imports, or assistant-backed workflows change.
