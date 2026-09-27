# Local inference: audit and decisions

Audit date: 2026-09-26. Evidence update: 2026-09-27 UTC. Base revision: `7fa965edc9408211d8f4336bb0ed0a4f30a88102`. Desktop version: 0.5.17. The [live plan](PLAN.md) and [M1 experiment record](M1-EXPERIMENT.md) track execution status; an in-progress result file is not a final comparison.

## Existing product map

| Concern | Current implementation / integration point |
| --- | --- |
| Platforms and shell | `package.json`: Electron/TypeScript, React/MUI; macOS arm64/x64, Windows x64, Linux x64 build targets. `src/main/core/window-bootstrap.ts` keeps renderer isolation. A packaging target is not evidence of local-model compatibility. |
| User message | `src/renderer/RendererAppController.tsx` → `src/preload/index.ts` → `src/main/ipc/chat-handlers.ts` → `src/main/chat/orchestrator.ts`. |
| Agent execution | `src/main/chat/orchestrator-helpers.ts` (`SandboxRunner`) → `src/main/llm-provider/run-service.ts` → `descriptors.ts` → `adapters/*`. App agents, tasks, automations and memory use the provider boundary too. |
| Context and retrieval | `src/main/prompt-builder/`, app docs/manifests, shared-file grants, chat history and platform memory; file search and iterative code retrieval are delegated to the CLI. No Desktop embedding subsystem was found in the audited source; this is not a dependency-wide guarantee. |
| Model/auth configuration | `src/shared/agent-runtime-registry.ts`, `src/main/core/settings-service.ts`, `src/main/runtime/agent-auth.ts`, `src/main/llm-provider/profile-resolver.ts`. Provider IDs describe agent engines. Existing model normalization has cloud defaults. Authentication uses existing official CLI login/status flows. |
| Tools and edits | Codex/Claude/Antigravity CLIs own the development agent loop. Forger MCP supplies app/platform operations; `src/main/forger-mcp-server.ts` has loopback binding and per-session tokens. `forger_create_app` reaches `src/main/installed-apps/local-app-creator.ts` and copies the bundled supported skeleton. |
| Build and acceptance | Commands are agent tools; successful provider termination or a saved Git version does not demonstrate a build, running app, or acceptance. The evaluation harness adds independent checks. |
| Streaming and outputs | Provider JSONL is parsed by adapters and converted into chat activity/progress. An output event is not necessarily a generated token. Workflow structured outputs are validated at `workflow_complete_node`; individual local model capability remains unvalidated. |
| Cancellation/errors/retries | Orchestrator process-tree cancellation; command absolute/inactivity timeouts; provider error classifiers. Existing chat retries stale threads and can change to a compatible cloud model. Local execution must bypass those fallback groups. |
| Storage and diagnostics | Local chat/run stores and logs; `src/main/error-reporting.ts` prepares report previews; `src/main/forger-backend/report-submissions.ts` uploads diagnostics after user-facing submission. Sanitization does not make source code public. |
| Other network paths | `src/main/memory-maintenance-manager.ts` selects cloud Codex independently; `forger-backend-client.ts`, updater, connections, remote sharing, applications, MCP tools and subprocesses may access networks. |
| Distribution | `src/main/runtime/agent-auth.ts` installs exact CLI versions from `src/main/core/agent-runtime-defaults.ts`; Desktop packaging and updater are separate from app ZIP/catalog installation. The local pilot does not change either distribution path. |

## Decisions

### D1 — Preserve the agent engine

Reuse `LlmProviderRunService`, Codex CLI command resolution and its JSONL parser. The local path is an explicit main-process developer input, disabled by default. It does not add a fourth engine to every provider union or implement an independent tool loop. General chat integration remains behind the viability and privacy gates.

### D2 — Ollama is the first experimental runtime

Ollama provides local model metadata and a Responses-compatible API usable by the existing CLI. llama.cpp and MLX remain alternatives documented in `RUNTIME-RESEARCH.md`. This is an integration-cost decision, not a measured performance ranking. No model is recommended for app development yet.

The authorized experiment has provisioned Ollama **0.34.4**, Qwen3 **1.7B Q4_K_M** and **4B Q4_K_M** in a private evaluation directory. The archive and model manifests/configuration/layers have recorded byte-integrity verification; the runtime also has a separately recorded macOS signature check. See [runtime and 1.7B artifacts](evidence/artifact-integrity-2026-09-27.json) and [4B artifacts](evidence/artifact-integrity-qwen3-4b-2026-09-27.json). These assets are not distributed by Forger, and their presence does not validate a model's development capabilities.

### D3 — Use an explicit custom local provider; do not use auto-pull

The configured Codex CLI version is 0.144.1. Its OSS path calls provider preparation, which can pull a missing model. The pilot instead selects a custom Responses provider with an explicit numeric loopback endpoint, no OpenAI authentication, and no request retries. Preflight checks an already installed model and its digest. It rejects remote-backed models and does not install anything.

The primary-source verification is recorded in `RUNTIME-RESEARCH.md`, including the exact tagged CLI source. Current configuration fields are also documented by [OpenAI](https://developers.openai.com/codex/config-reference). The installed CLI also passes a synthetic two-turn tool/file-edit probe; this is protocol evidence, not a real model inference run.

### D4 — Keep evidence classes separate

- **Behavior tests:** synthetic HTTP runtime and CLI fixtures verify integration contracts and failure paths.
- **Real CLI / synthetic runtime:** the installed Codex 0.144.1 consumes synthetic Responses events, invokes a real local command, creates a checked temporary file and rejects exercised redirects through the gateway. This establishes protocol behavior without measuring a model. Whole-CLI egress remains unverified.
- **Host observation:** the physical Apple M1 has 8,589,934,592 bytes (8 GiB) of unified memory and an Apple GPU reporting Metal support. Native inference has run on that host; Ollama reports GPU/VRAM allocation. Those reported values are distinct from measured peak unified-memory use. Free memory is not a safe model budget.
- **Real runtime calibration:** direct Ollama generation, observed cold/resident state, timing and sampled resources. The two 1.7B calibration streams exhaust a 64-token generation limit with thinking output and no requested `READY` answer. They are not agent tasks.
- **Evaluator controls:** reviewable reference applications must pass and deliberately incomplete initial applications must fail. These validate the measurement procedure, not model quality.
- **Real model task measurement:** the existing Forger provider and agent loop attempts a synthetic application task; only independent acceptance determines success. The completed first 8K-context task fails and remains in the denominator. Other runs are interpreted only after their recorded state is terminal.
- **Compatibility estimate:** cannot promote a configuration to validated or supply invented throughput/success values.

Null metrics include a reason. Failures stay in benchmark denominators. The initial task taxonomy uses functional coordination and regression risk, not tokens as a synonym for difficulty.

### D5 — No strict-offline or whole-product privacy claim

The pilot has no cloud authentication/fallback path. This is narrower than proving all Desktop traffic stays local. A strict global mode must also cover memory maintenance, cloud diagnostics, remote MCP/connections, application services and child processes. Local endpoint binding alone is not client/server authentication, and a user-managed runtime remains a trusted component.

`--ignore-user-config` does not remove project configuration in the pinned CLI. Project configuration must be rejected or controlled for pilot workspaces; command-line overrides alone do not prove that arbitrary hooks or MCP tools cannot run. A fresh Codex home contains no copied cloud `auth.json`. Local task results are untrusted, and immutable acceptance checks run outside the writable task workspace.

### D6 — Evidence before product expansion

The experiment owns a separate runtime directory and a named evaluator VM; its scripts perform bounded model unload and VM lifecycle operations. Product-managed downloads/resume/removal, authenticated runtime ownership across normal Desktop sessions, evidence-based automatic recommendation, MUI model selection, cloud comparison execution and stable rollout remain separate increments. No fallback changes modality without an explicit user action.

### D7 — Authenticate and constrain the inference relay

A real CLI canary found that the direct custom-provider HTTP client followed a 307 redirect to a different loopback port. The adapter therefore creates a new loopback gateway per execution. A random bearer token authenticates CLI requests to this gateway; the token is excluded from the explicit tool-shell environment. The gateway accepts only `POST /v1/responses` for the selected model, forwards to one fixed numeric loopback target using native HTTP, strips credentials/cookies, bounds input/output and time, and rejects non-200 upstream responses without forwarding `Location`. Cancellation closes active connections.

`src/main/llm-provider/local/gateway.ts` also validates a bounded tool inventory. It accepts function declarations and function namespaces, and rejects unsupported types and `custom_tool_call` / `custom_tool_call_output` history before forwarding. It does not translate custom tools, silently remove unsupported declarations, or rewrite tool schemas. The [installed-CLI tool-contract probe](evidence/cli-tool-contract-2026-09-27.json) verifies an actual `exec_command` file edit against synthetic inference. A transport contract and a model's advertised `tools` capability do not prove reliable argument generation or task completion.

The same installed CLI subsequently passed redirect canaries for 301, 302, 303, 307 and 308, with zero requests at the second server. [Protocol evidence](evidence/cli-protocol-2026-09-26.json) retains both the original failure and the passing remediation. This authenticates the per-run relay, not the user-managed Ollama service itself. It does not prevent direct access to that service, a trusted runtime forwarding requests, or another process changing a model tag after preflight. The digest is observed before execution, not cryptographically attested for every inference.

### D8 — Keep small-model preparation optional and preserve original authority

The 2026-09-27 Qwen3-0.6B follow-up adds `contextStrategy` to the existing local configuration: `direct-v1` remains the default; `staged-v1` and `staged-request-v2` are explicit evaluation controls. `local/context-preprocessor.ts` orchestrates two bounded calls through `context-http.ts`; `context-files.ts` inventories and reads eligible fixture sources. This reuses the provider and CLI rather than introducing another agent engine. Qwen3:0.6b Q4_K_M is downloaded into the same private evaluation store with pinned, verified metadata in `models.json`.

Preparation extracts tentative intent and selects existing file IDs. Actual source excerpts are advisory, untrusted context beside the complete unchanged original prompt. V2 requires a separate literal `localContextRequest` from that prompt, checked before inference; the field cannot enter a cloud run. The functional request is separated because the first measured treatment mistakes evaluation instructions for the goal. Native requests reject redirects, nonempty tool calls, invalid outputs and deadline/cancellation failures. Files are bounded, checked for confinement and identity, and opened without following symlinks or blocking on FIFO substitution. Credential-name/content filtering is heuristic, not complete secret detection.

Preparation consumes the original task budget and preserves failure metadata. Original, functional-request and effective prompt hashes have distinct meanings. The harness compares strategies only when task, artifact, source/build, original request, tool profile and acceptance identities match; prior failures remain intact. No setting is promoted automatically. [The two preregistered experiments](QWEN06-RESULTS.md) each finish at 0/3 direct and 0/3 prepared on one repeated bug. V2 names the general goal but still selects unrelated files; this does not validate a useful optimization. Adaptive in-loop retrieval, a narrow patch contract and application-test feedback are separate proposals.

## Privacy verification limits

Tests with canary values prove the tested environment and auth-file isolation cases. Synthetic HTTP servers cover URL rejection, digest checks and gateway failures; redirect tests also exercise the actual installed CLI. These checks cannot prove the real runtime or every CLI descendant avoids external traffic. The local service is not part of the CLI process tree: cancelling a task closes its request and kills the owned CLI group, but does not unload or stop an independently running Ollama server.

Controlled [network canaries](evidence/network-canary-tcp-2026-09-27.json) exercise parent, child and grandchild processes against TCP/UDP IPv4/IPv6 and Unix receivers. A denied outcome requires a working unrestricted baseline and a permission rejection, not a timeout. This coverage is specific to those probes. The owned Ollama server uses an experimental outer Seatbelt profile allowing loopback worker traffic; another local service can still act as a relay.

An outer network sandbox around the real Codex process prevents its inner workspace sandbox from starting on this Mac: [the nested probe fails](evidence/cli-network-tcp-smoke-failure-2026-09-27.json), while [the original workspace probe passes](evidence/cli-workspace-smoke-2026-09-27.json). The serial experiment therefore requires an explicit network-policy choice and uses `codex-workspace` only with synthetic fixtures. It preserves `workspace-write` and disabled tool-network access; it never enables unsafe command execution to work around the failure. `wholeCliEgressVerified` remains false. Background memory maintenance, cloud reporting/connections, indexing dependencies and ordinary Desktop subprocesses are not isolated by this developer path. A strict product mode still requires those boundaries to be addressed and verified.

The evaluator stages only inventoried fixture files and mounts supplied source, original tests and configuration read-only. Preparation reproduces the pinned skeleton's 14 commons mounts before recording protected hashes. A security review found and removed an earlier writable copy of original tests. Real Docker controls now exercise the mounts, builds, original regression suites, runtime, SQLite restarts and browser checks: [version 0.1 controls](evidence/evaluator-controls-envfixed-2026-09-27.json) record five accepted references and five expected rejections; [version 0.2 controls](evidence/evaluator-controls-v02-2026-09-27.json) record three accepted references and three expected rejections for strengthened CRUD, search and archive checks. Keep these evaluator versions distinct.

These mounts address file modification; shared process identity and writable scratch areas do not establish complete resistance to malicious test sabotage. Independent HTTP/browser acceptance remains necessary. Seven completed check groups are not a count of individual assertions or application tests. Proving that the model added useful tests, including a bug test that fails before the fix, has a [separate proposed gate](../../benchmarks/local-development/TEST-GATE-PROPOSAL.md); it is not yet an implemented success condition.

## Measurable M1 / 8 GB gate

The available host is a physical Apple M1 with 8 GiB unified memory. Its [initial hardware snapshot](evidence/host-2026-09-26.json) is historical detection evidence, not a simulated machine or model benchmark. [Provisioning evidence](evidence/provisioning-2026-09-27.json) records the private runtime, the owned Lima VZ VM with two CPUs and 3 GiB RAM, and pre-existing workload/swap. Other user applications were not closed to produce a clean-machine benchmark.

`scripts/local-development/m1-evaluation.mjs` serializes resource use: the VM stops before agent inference; afterward the selected model is unloaded and the VM starts for Docker evaluation. `/api/ps` absence verifies reported residency, not the instant every GPU allocation is freed. Lifecycle intervals, runtime-reported context/VRAM, resource samples and agent time are distinct fields. The build/test environment is addressed by immutable image ID and does not pull dependencies during a task.

The [cold calibration](evidence/calibration-qwen3-1.7b-cold-2026-09-27.json) and [warm calibration](evidence/calibration-qwen3-1.7b-warm-2026-09-27.json) are one sample each at runtime context 2048 and a 64-token generation cap. Cold means absent from `/api/ps`; OS/file caches remain uncontrolled. Both end at the generation cap with an empty visible response and no `READY` answer. Native token throughput in those records measures that bounded thinking stream, not development speed or successful response latency.

The [first 1.7B template attempt](evidence/m1-qwen3-1.7b-template-trial1-2026-09-27.json) at requested agent context 8192 fails acceptance with zero observed tool calls and no file changes. The [runtime log observation](evidence/context-truncation-8192-2026-09-27.json) records a prompt reduction from 8327 to 4098 tokens even though the runtime reports context 8192. Requested context, reported allocation, input actually retained and later context shifting are separate facts; neither a larger setting nor a successful stream guarantees complete retained context.

Both baseline 16,384-context experiments complete with zero accepted tasks out of five per candidate. The [M1 results](M1-RESULTS.md) distinguish acceptance failures, inactivity timeouts, sampled resources, native calibration and subsequent configuration experiments. There is no validated model recommendation. The [live plan](PLAN.md) records the scope decision and outstanding gates.

The pinned Codex `workspace-write` policy grants full-disk reads. Isolating HOME and environment does not enforce Forger's shared-files-only requirement. A documented custom restricted-read profile exists but requires replacing the legacy sandbox options and testing command, symlink and child-process boundaries. This remains a blocker for ordinary installed-app use, independently of inference endpoint restrictions and whole-CLI egress.

For each pinned candidate, record: model download size/time separately; cold load and already-loaded runs; effective context/tokenizer; prompt/tool tokens; acceptance/regression outcomes; functional time; actual first-token timing only if observable; tool calls, retries and timeouts; peak process and system/unified-memory pressure, swap and OOM; disk; foreground apps; thermal/power conditions; and failed attempts. Test more than one context setting and leave room for Desktop, browser, compiler, Python/Node, SQLite and OS. A model whose weights fit can still fail this gate.
