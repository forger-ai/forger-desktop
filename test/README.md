# Desktop Tests

This directory starts the desktop automated test structure.

## Current Layer

- `contracts/`: fast `node:test` checks for shared contracts that should not drift.
- `main/`: `node:test` integration tests for main-process services using temp directories and fake CLIs or servers.
- `renderer/`: Vitest + jsdom interaction tests that render React/MUI surfaces and exercise them through accessible controls.
- `e2e/`: Playwright smoke tests that launch the real unpackaged Electron application against built assets.
- `resources/`: Python integration tests for bundled local services.

## Test Quality Rules

Tests reproduce real use cases of the application and assert observable behavior: return values, persisted state, IPC responses, emitted events, and state transitions of compiled modules from `dist-electron`.

Not allowed:

- Regex or substring matching against TypeScript/TSX source files to assert implementation details.
- Assertions that removed features stay absent (`doesNotMatch` on identifiers or copy deleted in a previous version).
- Assertions on cosmetic arrangement, such as menu ordering or which MUI component renders a block.
- Tests that pin exact third-party versions; assert the shape of the contract (for example, an exact-semver pin) instead of the value.

Allowed contract checks that are not behavior tests:

- Real configuration data: `package.json` build targets, entitlements, workflow artifact names.
- Generic policy lints that scan all files uniformly (for example, no `@ts-nocheck` under `src/main`).
- Architectural import boundaries (for example, execution surfaces must not import provider adapters directly).

Run the default local suite, which includes full Electron behavior and rendered React/MUI behavior:

```sh
npm run test
```

Run only the full Electron suite with:

```sh
npm run test:electron
```

The Electron command builds `dist-electron` once, then runs the contract and main-process suites plus the automation-approval and app-agent-runtime checks against that build. Default and platform Electron runs do not force process exit, so leaked handles fail visibly instead of being hidden. The tests must not use real Codex or Claude credentials, real user data, or the real private app workspace.

The cross-platform CI matrix uses the full Electron suite on Ubuntu and a focused Electron suite on macOS and Windows. The focused suite covers packaging contracts, IPC/preload boundaries, URL/process opening, window bootstrap behavior, transactional backup restore, and signed cloud-backup validation:

```sh
npm run test:electron:focused
```

Run rendered React/MUI behavior tests:

```sh
npm run test:renderer
```

Run the real Electron smoke locally:

```sh
npm run test:e2e
```

`test:e2e` builds the renderer and Electron main/preload assets once, then launches the installed Electron development binary. When those assets are already built, CI and release jobs use:

```sh
npm run test:e2e:built
```

The smoke uses one worker, no retries, bounded Playwright timeouts, and no fixed sleeps. Every launch receives a unique temporary profile with an empty process home, isolated Electron `userData`, and an isolated private Forger workspace. The profile override is accepted only when all three conditions hold: the explicit E2E profile variable is present, the process runs with `NODE_ENV=test`, and Electron reports that the app is unpackaged. Packaged production state is never redirected.

The smoke asserts behavior from a real Electron process:

- the Desktop window has `nodeIntegration` off, `contextIsolation` on, and Chromium sandboxing on;
- renderer JavaScript cannot access `require`, `process`, `module`, `Buffer`, or Node path globals;
- the `window.forger` preload bridge exists and exposes functions only;
- an uncontrolled child-window request is denied without creating a window or invoking the operating system shell;
- Electron closes and the temporary state is removed in `finally` cleanup.

Linux CI runs the smoke through `xvfb-run`; macOS and Windows run it directly. Every native release job runs the smoke against its unpackaged built assets before packaging.

Run the bundled speech-to-text resource tests after installing their exact test dependencies:

```sh
python -m pip install -r test/resources/requirements.txt
npm run test:resources
```

Coverage:

```sh
npm run test:coverage
```

`test:coverage` runs both enforceable coverage gates: strict Electron coverage and renderer coverage.

To inspect Electron coverage without applying the gate:

```sh
npm run test:coverage:electron:report
```

The strict Electron gate builds once, runs the full Electron suite and the two special runtime checks through `c8`, and enforces 100% global coverage:

- 100% lines
- 100% statements
- 100% branches
- 100% functions

Run it directly with:

```sh
npm run test:coverage:electron:strict
```

The c8 report and strict commands retain Node's forced-exit option because the coverage process currently needs deterministic report finalization. The ordinary Electron suites remain the leak-detection path.

The `c8` config keeps exclusions minimal:

- `dist-electron/main/index.js`, because it is an Electron entrypoint that only imports startup wiring.
- `dist-electron/main/core/main-process.js`, because it is the Electron composition root: controller factories, dependency wiring, pass-through wrappers, and import-time lifecycle registration. Its behavior-bearing controllers, IPC handlers, lifecycle module, and a composition smoke test remain covered.
- Compiled type-only files such as `dist-electron/shared/types/**/*.js`, `dist-electron/main/**/types.js`, and `dist-electron/main/**/*-types.js`.
- `dist-electron/shared/types.js`, because it is the shared type barrel and re-export glue.

Renderer coverage uses V8 over the real `src/renderer` tree. It excludes only declaration files and the generated documentation bundle. Every included renderer file remains visible in the report, and the global gate requires:

- 100% lines
- 100% statements
- 100% branches
- 100% functions

Run it with:

```sh
npm run test:coverage:renderer
```

## Next Layer

The current Playwright layer is a startup and security smoke, not installer automation or a full product journey. Later E2E suites should cover clean install, app install, MCP use, and controlled Codex/Claude chat calls after those seams are practical to stub without credentials or live services.
