---
name: forger-frontend-structure
description: Keep Forger React frontends organized with feature-first folders and small reusable components.
---

- Use this skill before creating or reorganizing frontend code for vite-fastapi-sqlite React apps.
- Prefer this structure: `frontend/src/app`, `frontend/src/features/<area>`, `frontend/src/components`, `frontend/src/api`, `frontend/src/lib`, `frontend/src/i18n`, and `frontend/src/theme`.
- Keep `app/` for root wiring, providers, app shell composition, routing or view selection, and cross-feature state orchestration.
- Keep `features/<area>/` for domain screens, feature-specific components, feature hooks, and feature helpers.
- Keep `components/` only for UI reused by multiple features. Do not put one-off feature screens there.
- Keep `api/` for HTTP clients, request/response types, and backend contract helpers. Do not put UI state there.
- Keep `lib/` for pure reusable helpers with no React rendering and no app-specific side effects.
- Keep `theme/` for MUI theme and design tokens.
- Avoid growing `App.tsx` into a large feature file. It should delegate to `app/` or feature modules.
