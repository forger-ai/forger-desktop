# Desktop Tests

This directory starts the desktop automated test structure.

## Current Layer

- `contracts/`: fast `node:test` checks for shared contracts that should not drift.
- `main/`: `node:test` integration tests for main-process services using temp directories and fake CLIs or servers.

Run:

```sh
npm run test
```

The tests build `dist-electron` first and then import compiled CommonJS modules. They must not use real Codex or Claude credentials, real user data, or the real private app workspace.

Coverage:

```sh
npm run test:coverage
```

`test:coverage` is the report-only Electron coverage harness. It builds `dist-electron` from a clean directory, then runs the same `node:test` contract and main-process suites through `c8`. This covers compiled main-process, preload, and shared modules.

The strict gate is intentionally separate:

```sh
npm run test:coverage:electron:strict
```

Use the strict script when the current Electron suite is expected to satisfy the configured gate. Do not wire it into the default test path while known uncovered Electron files still make the gate fail.

The `c8` config keeps exclusions minimal:

- `dist-electron/main/index.js`, because it is an Electron entrypoint that only imports startup wiring.
- `dist-electron/main/core/main-process.js`, because it is the Electron composition root: controller factories, dependency wiring, pass-through wrappers, and import-time lifecycle registration. Its behavior-bearing controllers, IPC handlers, lifecycle module, and a composition smoke test remain covered.
- Compiled type-only files such as `dist-electron/shared/types/**/*.js`, `dist-electron/main/**/types.js`, and `dist-electron/main/**/*-types.js`.
- `dist-electron/shared/types.js`, because it is the shared type barrel and re-export glue.

Renderer coverage is out of scope for this harness. Add renderer coverage through Vitest/jsdom rather than the Node runner, because the renderer is bundled for the browser by Vite.

## Next Layer

Add Playwright Electron after the main-process seams for catalog, install, MCP, Codex, and Claude are easier to stub. The first E2E smoke suite should cover clean install, app install, MCP use, Codex/Claude chat calls, and Electron security flags.
