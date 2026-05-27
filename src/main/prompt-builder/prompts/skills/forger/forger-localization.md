---
name: forger-localization
description: Use when writing or changing user-facing app text, localization, language detection, assistant copy, prompt copy, labels, navigation, validation, empty/loading/error/success states, or messages.
---

- User-facing text includes localized UI copy, user-facing messages, assistant copy, prompt copy, validation messages, empty states, loading states, error states, success states, labels, navigation, and locale passed into app backend routes.
- For `vite-fastapi-sqlite` apps, use the shared locale helpers from `frontend/src/api/locale.ts`.
- The app frontend must call its own backend route `GET /api/forger/context` for Forger locale context. It must not call Desktop directly, read Desktop runtime secrets, or depend on `window.forgerApp`.
- The app backend owns the Desktop bridge call through `app.forger_context` and `app.forger_desktop`.
- Use URL or browser locale only for first render and local development fallback. Apply async runtime context only when the backend response says `source === "desktop"`.
- Keep all visible copy in app-local dictionaries or locale modules such as `frontend/src/i18n/es.ts` and `frontend/src/i18n/en.ts`.
- Do not hard-code visible copy in React components, backend routes, prompt strings, services, or one-off helpers.
- When adding or changing visible text, update every supported locale at the same time.
- Commons may own locale mechanics and types. It must not own app-specific product wording.
- Explain localization changes to the person as app language/copy behavior, not bridge routes, secrets, or implementation files.
