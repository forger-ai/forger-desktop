---
name: forger-fastapi-contracts
description: Build and change FastAPI routes in Forger apps while preserving typed contracts, local data safety, and frontend compatibility.
---

- Use this skill when adding or changing FastAPI routes, request/response models, dependency injection, file uploads, error handling, or route tests in a Forger app backend.
- Keep FastAPI as the local app service layer. Desktop owns app startup, ports, runtime environment, and installed-app lifecycle.
- Use the app's existing dependency manager and stack conventions, usually `uv` in `vite-fastapi-sqlite` apps. Do not replace service startup with ad hoc `pip install` or manual `fastapi dev` instructions.
- Define typed Pydantic request and response models for route boundaries. Do not return raw database models directly to the frontend.
- Keep response fields stable once the frontend depends on them. If a field must change, update API types, feature hooks, UI states, and tests together.
- Use `response_model`, explicit status codes, and structured error responses where the app already has a response pattern.
- Raise `HTTPException` or the app's existing error helper for expected request errors. Do not leak stack traces, local paths, secrets, SQL details, or raw exception messages.
- Keep HTTP semantics consistent: use the right method, status code, idempotency expectation, and error shape for the workflow.
- Keep dependencies small and injectable: database sessions, current app context, file-library access, Desktop bridge helpers, and settings should be dependency-provided, not hidden globals.
- File routes may only read app-private workspace files or files explicitly shared by the user. Do not browse arbitrary external filesystem paths.
- CORS and remote access behavior must respect Forger Desktop local-network and remote-tunnel ownership. Do not expose independent tunnels or public services from the app backend.
- Use sync endpoints for sync work and async endpoints only when the implementation avoids blocking I/O. Do not run blocking database/file operations inside async code without the app's established pattern.
- Test route behavior through realistic API flows, including validation errors, empty states, persistence, and frontend-compatible response shape.
