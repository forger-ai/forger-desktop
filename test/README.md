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

Coverage currently reports against all compiled `dist-electron/**/*.js` files, including untested files as 0% coverage. This covers main-process, preload, and shared modules. Renderer coverage should be added through Vitest/jsdom rather than the Node runner, because the renderer is bundled for the browser by Vite.

## Next Layer

Add Playwright Electron after the main-process seams for catalog, install, MCP, Codex, and Claude are easier to stub. The first E2E smoke suite should cover clean install, app install, MCP use, Codex/Claude chat calls, and Electron security flags.
