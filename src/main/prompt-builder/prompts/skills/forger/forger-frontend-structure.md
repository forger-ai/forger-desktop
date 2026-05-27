---
name: forger-frontend-structure
description: Use when creating, reorganizing, or refactoring Forger React frontend files, feature-first folders, App.tsx root wiring, shared components, API modules, hooks, or helpers.
---

- Prefer this structure: `frontend/src/app`, `frontend/src/features/<area>`, `frontend/src/components`, `frontend/src/api`, `frontend/src/lib`, `frontend/src/i18n`, and a stack-appropriate `frontend/src/styles`, `frontend/src/design-system`, or `frontend/src/theme`.
- Keep `app/` for root wiring, providers, app shell composition, routing or view selection, and cross-feature state orchestration.
- Keep `features/<area>/` for domain screens, feature-specific components, feature hooks, and feature helpers.
- Keep `components/` only for UI reused by multiple features. Do not put one-off feature screens there.
- Keep `api/` for HTTP clients, request/response types, and backend contract helpers. Do not put UI state there.
- Keep `lib/` for pure reusable helpers with no React rendering and no app-specific side effects.
- Keep stack-specific design setup in a clear location: `styles/` or `design-system/` for Tailwind tokens and global CSS, `theme/` for MUI theme, or the app's existing equivalent.
- Avoid growing `App.tsx` into a large feature file. It should delegate to `app/` or feature modules.
