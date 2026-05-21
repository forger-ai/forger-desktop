# Desktop Electron Coverage Findings

This file tracks behavior mismatches found while raising Electron-side coverage.
Each entry records what the test initially expected, what the code actually does, and whether the product should change.

## Validation Error Keys And `__proto__`

- Expected from the first test draft: `safeValidationKeys` would preserve every syntactically safe key, including `__proto__`.
- Actual behavior before this change: JSON-owned prototype-like keys such as `__proto__`, `constructor`, and `prototype` could pass the syntax filter and appear in diagnostic validation metadata.
- Product analysis: validation summaries are diagnostic metadata and should not preserve prototype-like keys, even when they come from backend JSON.
- Decision: filter prototype-like validation keys in production and cover that branch with a JSON-shaped regression test.

## App-Agent Task Progress For MCP `item.started`

- Expected from the first test draft: an `item.started` event with `item.type = "mcp_tool_call"` would show an internal-tools progress message.
- Actual behavior before this change: conversation progress already reported started tool calls, but task progress only mapped `turn.started`, completed command output, completed agent messages, and started command execution. Started MCP calls returned no user-facing task progress message.
- Product analysis: task runs can otherwise look idle while an internal app tool is starting. The existing localized `usingTools` copy is generic enough and does not expose internal command details.
- Decision: map started MCP/tool items to the existing internal-tools progress message for task runs.

## Gmail OAuth Backend Error Codes

- Expected from the first test draft: refresh failures would be remapped to a Desktop-prefixed technical code such as `gmail_oauth_backend_invalid_grant`.
- Actual behavior: Desktop preserves the backend `error` field as the technical code, for example `invalid_grant`, while using the backend description as the message.
- Product analysis: preserving backend codes is useful for support and avoids inventing a second taxonomy. The user-visible message remains safe.
- Decision: adjust the test to the current contract.

## Coverage Harness And Stale `dist-electron`

- Expected: coverage should measure the freshly compiled Electron output only.
- Actual behavior before this change: local runs could leave stale compiled files in `dist-electron`, causing misleading coverage.
- Product analysis: stale coverage is an engineering risk, not user-visible behavior, but it can block or mislead releases.
- Decision: add an Electron clean step before compiling for tests and coverage.

## Automation Selected App IDs

- Expected from the first test draft: automation creation would dedupe selected apps and drop unsafe path-like values such as `../bad`.
- Actual behavior: the sanitizer deduped non-empty strings but preserved path-like app IDs, so invalid IDs could reach MCP, memory, and network-access hooks.
- Product analysis: this is a real safety bug. Automations should only operate on declared app IDs; preserving path-like identifiers creates confusing internal behavior and weakens app-boundary expectations.
- Decision: fix production sanitization to keep only slug-like app IDs and update the test to expect `../bad` to be dropped.

## Local Dev Catalog Display Names

- Expected from the first test draft: a local app named `Recipes Dev` would appear as `Recipes Dev`.
- Actual behavior: the dev catalog appended `Dev` unconditionally, producing `Recipes Dev Dev`.
- Product analysis: this is a visible polish bug in the developer/local app install surface. The catalog should signal local development builds without duplicating words in the app name.
- Decision: fix production display-name formatting to append `Dev` only when the source display name does not already end with it.

## App MCP Python Command Resolution

- Expected from the first test draft: an app MCP manifest command starting with `python` would launch the base installed runtime Python path.
- Actual behavior: the MCP manager prepares the app backend Python environment and launches the backend venv Python executable.
- Product analysis: the actual behavior is better for app reliability. MCP servers should run with the app backend dependencies, while the base runtime remains the source used to create or repair that environment.
- Decision: adjust the test to expect the backend venv Python path.

## Cloud Pairing Code Length

- Expected from the first test draft: cloud device pairing codes are always eight uppercase alphanumeric characters.
- Actual behavior: the random base64url string was filtered after generation, so rare `-` or `_` characters could leave a shorter code.
- Product analysis: this is a real pairing-flow polish and reliability bug. The user sees and types this code, so variable-length codes make the flow less predictable and can look broken.
- Decision: fix production code generation to keep drawing random characters until it can return exactly eight uppercase alphanumeric characters.

## Path And Version Helper Edge Cases

- Expected from the second-wave coverage draft: folder-version normalization would collapse an all-punctuation input to `unknown`, and update comparison would treat `v1.0.0` and `1.0.0` as equal after numeric normalization.
- Actual behavior: folder-version normalization preserves sanitized separator characters such as `---`; update comparison removes `v` for numeric comparison but still uses the original normalized strings as a final lexical tie-breaker, so `v1.0.0` is considered newer than `1.0.0`.
- Product analysis: neither case is a clear user-facing bug in the current Desktop flow. Published app versions should not be all punctuation, and catalog/installed version strings should use a consistent prefix convention. Changing either helper now could affect update availability semantics beyond this coverage task.
- Decision: document current behavior in tests and leave product behavior unchanged.

## Context Support Official Tool Skills

- Expected from the third-wave coverage draft: an MCP-only app context would generate only the app MCP skill and Gmail skill.
- Actual behavior: the official-tool template set also generates `forger-official-tools` and `forger-permissions`.
- Product analysis: this is desirable. App agents need both tool usage guidance and permission-boundary guidance when official tools or app MCP tools are available.
- Decision: adjust the test to preserve the broader generated skill contract.

## App Secret Validation Env Names

- Expected from the third-wave coverage draft: duplicate app-secret validation would report the prefixed storage/env key, for example `APP_SECRET_API_KEY`.
- Actual behavior: validation reports the app-facing env name produced from the declaration, for example `API_KEY`.
- Product analysis: the current message is clearer for app authors because it points to the manifest-level env name, not an internal storage prefix.
- Decision: adjust the test to the current app-facing validation message.

## Official Tool Declaration Shape

- Expected from the third-wave coverage draft: manifest tool declarations would use display-like fields such as `id` and `name`.
- Actual behavior: `normalizeAppToolDeclarations` accepts `toolId`, `reason`, and non-empty `actions`.
- Product analysis: the current shape is better for permission review because it records why an app needs a tool and which actions are requested.
- Decision: adjust the fixture to the declared permission contract and leave production unchanged.

## Required And Optional Declarations For The Same Official Tool

- Expected from the cloud/MCP coverage draft: an app that declares Gmail as required for read actions and optional for send actions would be allowed to call the required Gmail actions before the optional grant is enabled.
- Actual behavior: `callFromApp` finds both declarations by `toolId`; when the optional declaration exists and the app grant is false, it denies the call before distinguishing the required action set.
- Product analysis: current catalog declarations should not place the same tool in both required and optional lists. A mixed required/optional action model for one tool would need an explicit contract change so grants are checked per action, not per tool.
- Decision: keep the test fixtures split by app and leave production unchanged.

## Gmail OAuth Callback Error Branch Under `node:test`

- Expected from the cloud/MCP coverage draft: the local OAuth state-mismatch callback branch could be asserted with `assert.rejects(runGmailOAuthFlow(...))`.
- Actual behavior before this change: the HTTP callback rejected the internal callback promise before the outer OAuth flow awaited the race, and `node:test` reported that as an asynchronously handled rejection.
- Product analysis: this is a real resilience issue in the local OAuth bridge. The user-facing error mapping was correct, but the process could emit noisy unhandled-rejection diagnostics while handling expected negative callback paths.
- Decision: attach a no-op rejection observer immediately after creating the callback promise while preserving the existing awaited result mapping.

## Claude Runtime Fallback Effort

- Expected from the fourth-wave coverage draft: when both a Claude runtime model and effort are invalid, resolving against Desktop defaults would fall back to both the default Claude model and default Claude effort.
- Actual behavior: the invalid model falls back to the configured default model, but effort has already been normalized to the generic Claude default `medium`, so it does not inherit the configured default effort.
- Product analysis: this is a subtle selector semantics issue, not an immediate user-facing bug. Users normally select valid model/effort pairs through the UI, and changing fallback order could affect manifest/runtime compatibility in existing apps.
- Decision: document current behavior in tests. Revisit only if product wants invalid manifest runtime values to be fully replaced by Desktop defaults as a single unit.

## Chat Cancel While Permission Is Pending

- Expected from the chat state-machine coverage draft: canceling a run while it is waiting for permission clears the visible permission request and resolves the pending decision as denied.
- Actual behavior before this change: the pending decision was denied internally, but the public run still exposed `permissionRequest` on the canceled run.
- Product analysis: this is a real visible state bug. A canceled chat run should not keep a stale approval request available to the UI.
- Decision: clear `permissionRequest` during `cancelRun` before emitting the canceled run state.

## Chat Shared File Sandbox Roots

- Expected from the chat shared-file coverage draft: files explicitly shared with a chat run are included in the provider sandbox allowlist, while missing file references are ignored.
- Actual behavior before this change: shared files were resolved and stored on the run, but the provider boundary received only the app working directory in `FORGER_ALLOWED_ROOTS` and Codex trusted roots.
- Product analysis: this is a real app-boundary bug. A user-shared file should be available to the run that received it, and unrelated or missing paths should not widen the sandbox.
- Decision: pass resolved shared roots to Codex and Claude provider runs, include them in Codex trusted roots, and cover the behavior with the fake chat runner.

## Chat Git Repository Detection

- Expected from the chat apply/undo coverage draft: applying a preview to a folder without `.git` initializes local app version history before committing the change.
- Actual behavior before this change: `ensureGitRepository` treated a completed `git rev-parse --is-inside-work-tree` process as success even when Git returned a nonzero "not a repository" result, so initialization was skipped.
- Product analysis: this is a real local-versioning bug. The first saved app change depends on creating a repository when one is missing.
- Decision: require a zero exit code and `true` output before considering a folder an existing Git worktree, then cover apply and undo through a temporary app repo.

## Malformed Manifest Arrays

- Expected from the manifest/backend boundary coverage pass: an installed `manifest.json` must be a JSON object.
- Actual behavior: a top-level JSON array passed the generic `typeof parsed === "object"` check and was treated as a manifest-shaped value.
- Product analysis: this is a real boundary bug. A malformed installed manifest should not be allowed to imply capabilities, agent settings, tools, or cloud behavior.
- Decision: reject top-level arrays while resolving installed manifests and cover the fallback behavior in tests.

## Context Support Malformed Stack Shapes

- Expected from the context-support coverage pass: generated app agent context should only treat object-shaped manifest stacks as valid.
- Actual behavior before this change: top-level manifest arrays and stack section arrays could pass object checks in the context support path.
- Product analysis: malformed manifests should not generate stack skill contracts or imply app capabilities.
- Decision: reject manifest arrays and stack arrays in context support, and cover the fallback behavior in focused context tests.

## Encoded Cloud Relay Parent Paths

- Expected from the cloud relay boundary coverage pass: parent-directory traversal should be blocked even when encoded.
- Actual behavior: raw `..` segments were blocked, but percent-encoded variants such as `%2e%2e` could pass the string check before URL normalization.
- Product analysis: this is a real boundary bug for remote app access. Relay paths must not escape or normalize into a different target than the request visibly names.
- Decision: decode paths for the safety check, block malformed encodings, and return a normalized bad-request response for malformed internal JSON bodies.

## Malformed Backend Rating And Backup Payloads

- Expected from the backend normalizer coverage pass: malformed numeric and string fields should be dropped or clamped before entering Desktop state.
- Actual behavior: invalid rating IDs or scores could become `NaN`, and malformed remote backup payload fields could produce non-string IDs/names or `NaN` byte counts.
- Product analysis: this is a product reliability bug at the cloud boundary. Bad backend payloads should degrade to empty or safe values instead of poisoning UI state with invalid primitives.
- Decision: require finite rating IDs/scores, require string app IDs/names for backup summaries, and clamp invalid backup counts and byte totals to zero.

## Malformed Cloud Device Socket Payloads

- Expected from the manifest/storage/managers coverage pass: malformed cloud-device websocket payloads are ignored without surfacing as unhandled async failures.
- Actual behavior before this change: the socket message handler parsed JSON directly inside an async method invoked without awaiting, so malformed payloads could become unhandled promise rejections.
- Product analysis: this is a real cloud relay/device resilience bug. A malformed relay frame should not destabilize the Desktop process or leave noisy diagnostics.
- Decision: catch malformed socket JSON, record `cloud_socket_message_invalid`, and keep the device manager alive.

## Forger Cloud OAuth Callback Rejection Timing

- Expected from the focused cloud-device test run: negative Google login callback paths return safe IPC results without creating asynchronous activity after the test completes.
- Actual behavior before this change: the callback promise could reject during `openExternalUrl` before the flow awaited `Promise.race`, which let Node observe the rejection as temporarily unhandled.
- Product analysis: this is a real resilience issue in the login bridge. The user-facing result was still mapped, but the process could emit noisy unhandled-rejection diagnostics on callback errors.
- Decision: attach a no-op rejection observer immediately after creating the callback promise while preserving the existing awaited result mapping.

## Gmail OAuth Secret Save Fallback Copy

- Expected from the backend/cloud/tools coverage pass: if storing the Gmail refresh token fails without a user-facing message, the OAuth callback still renders a safe error page and rejects with a Gmail OAuth error.
- Actual behavior before this change: the callback passed an undefined body into the HTML renderer, causing a `TypeError` instead of the intended OAuth failure.
- Product analysis: this is a real local OAuth resilience bug. Secret storage can fail through generic store paths, and the browser callback page must stay safe and understandable even without a specific store message.
- Decision: fall back to the generic Gmail OAuth error copy and preserve the technical code when the secret store does not provide `userMessage`.

## Automation Run Progress Race

- Expected from the automation coverage pass: a successful automation run stays `succeeded` after streamed assistant progress updates.
- Actual behavior before this change: streamed progress writes were fire-and-forget. A progress write that started while the run was `running` could finish after the final success write and persist the older `running` status again.
- Product analysis: this is a real automation reliability bug. A completed automation should not appear stuck in progress because of an internal progress-write race.
- Decision: track and settle pending progress writes before persisting terminal run state, while keeping progress-write failures non-fatal to the provider run.

## Installed App Crash State Overwrite

- Expected from the runtime process coverage pass: when a backend or frontend process exits unexpectedly, the installed app is marked `error` and its local services are cleaned up.
- Actual behavior before this change: crash cleanup closed the app window before removing the running process record, so the window `closed` handler could run the normal stop path and overwrite the app status back to `installed`.
- Product analysis: this is a real runtime state bug. A crashed app should stay visibly failed so the user can retry, instead of looking like it was intentionally stopped.
- Decision: make crash cleanup remove the running record and terminate the sibling process while suppressing the normal window-close stop path, then persist the `error` status.

## Installed App Restart Stop Failure

- Expected from the fourth-wave runtime coverage draft: restart can report a stop-phase failure with the existing restart failure message instead of crashing the restart call.
- Actual behavior before this change: `stopInstalledAppUnlocked` allowed process termination failures to throw, so the `restartInstalledApp` stop-failure branch could not run.
- Product analysis: a failed local-process stop is recoverable feedback for the user. Restart should explain that the app could not be stopped and keep the running record for a retry.
- Decision: return a failed stop result with diagnostics when process termination fails, log `stop:failed`, and cover the restart stop-failure branch.

## Manifest Backend Command Options

- Expected from the fourth-wave runtime coverage draft: manifest backend commands can declare uvicorn/FastAPI options while Desktop still forces the local host and allocated port.
- Actual behavior before this change: backend startup normalized `uvicorn` and `fastapi dev` commands from scratch, discarding manifest-provided options after the app import/path.
- Product analysis: apps should be able to keep safe service flags such as log level or reload settings, while Desktop remains responsible for localhost binding and the runtime port.
- Decision: preserve manifest command options after the app import/path, replace `--host` and `--port` with Desktop-controlled values, and cover both uvicorn and FastAPI branches.

## Permission Broker Ellipsis Path Segments

- Expected from the chat helper coverage pass: a legitimate app file under a directory named `...` stays inside the allowed app root.
- Actual behavior before this change: `safeRealPath` rejected any resolved path containing the substring `../`, and `isPathInside` treated relative paths starting with `..` as outside even when the first path segment was `...`.
- Product analysis: the real boundary check already compares resolved paths against allowed roots. The substring check created false positives without adding protection.
- Decision: remove the redundant substring check, treat only `..` and `../` relative paths as parent escapes, and cover an allowed ellipsis directory path through `PermissionBroker.assertAllowedPath`.

## Git Init Main Branch Fallback

- Expected from the chat helper coverage pass: if `git init -b main` is unsupported, Desktop falls back to plain `git init` and then ensures `main`.
- Actual behavior before this change: the fallback only ran when spawning Git rejected, not when Git returned a nonzero status for unsupported `-b`.
- Product analysis: older Git versions can return a normal failed process for unsupported flags. Local app versioning should still initialize reliably.
- Decision: inspect the `git init -b main` exit code and run the existing fallback when the command returns nonzero.

## Chat Log Cleanup Race

- Expected from the CI coverage gate: permission audit logging and run-log writes stay best-effort when a workspace is being cleaned up, while real filesystem errors still surface.
- Actual behavior before this change: if the private app root disappeared while chat was appending audit or run-log entries, `ENOENT` could fail a chat run or become an unhandled rejection from fire-and-forget permission logging.
- Product analysis: local logging should not destabilize chat shutdown, cancellation, or workspace cleanup paths. Permission/run state remains in memory and persisted state; losing a final local log line during workspace removal is acceptable, but permission or disk errors should not be silently swallowed.
- Decision: tolerate only `ENOENT` from chat audit and run-log writes as a cleanup race, continue throwing other filesystem failures, and cover both paths in chat logging tests.
