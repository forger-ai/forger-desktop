# Local development evidence plan

Updated: 2026-09-27 UTC. Status: the Qwen3 0.6B/context-preparation follow-up is complete. Two separate six-attempt experiments on one bug task produce no accepted changes. The previous 17-attempt M1 delivery remains unchanged historical evidence. Model recommendations and public rollout remain gated.

## Completed continuation — Qwen3 0.6B and context preparation

The user explicitly selects Qwen3-0.6B and asks whether the same small model can interpret a request before retrieving context gradually. The approximately 523 MB Q4_K_M artifact is downloaded into the existing isolated store and all six files pass the [offline digest verifier](evidence/verified-artifacts-qwen3-0.6b-2026-09-27.json). The implemented treatment uses two bounded calls followed by real-file excerpts, not adaptive retrieval throughout execution. The [literature record](SMALL-MODEL-CONTEXT-RESEARCH.md) keeps published evidence separate from measured Forger outcomes.

The [v1 protocol](QWEN06-CONTEXT-EXPERIMENT.md) and [separate v2 protocol](QWEN06-REQUEST-V2-EXPERIMENT.md) freeze their respective software and budgets before evaluation. V1 produces 0/3 direct and 0/3 prepared successes; v2 produces 0/3 direct and 0/3 prepared successes. These are 12 new attempts of **one** task, `bug-01`, with zero observed tools or file edits. Six of six preparations return valid JSON but select the same three irrelevant paths. V2 separates the literal functional request from benchmark instructions and identifies the broad goal, but its interpretation remains incomplete. Schema validity does not establish useful understanding or application success.

The current [software freeze](evidence/qwen06-v2-software-freeze-2026-09-27.json) records 266/266 tests, Electron build, typecheck and lint passing. Sources, compiled adapter and harness remain frozen throughout each experiment. [QWEN06-RESULTS.md](QWEN06-RESULTS.md) links the raw direct/staged records and within-experiment comparisons. The two versions and older 1.7B/4B results cannot be pooled into a controlled cross-version comparison. No model recommendation or public mode is enabled.

## Previous delivery — authorized M1 experiment

The user now requests all following steps on this computer. This authorizes the described local runtime/model and evaluator preparation downloads. It does not authorize a public release, production changes, credential changes, private-repository transmission or unbounded cloud spending.

The earlier increment validates positive/negative evaluator controls, installs the pinned runtime and first candidates in a separate user-owned directory, records bounded cold/warm calibration and network canaries, and executes the initial Forger tasks. Model recommendations and public UI remain gated on actual task results. Build and inference phases are serialized on the 8 GB host. At that continuation's start the host reports about 5.9 GiB of occupied swap and 15.3 GiB free disk; these are historical workload conditions, not current resource observations or proof of model incompatibility.

Parallel ownership: evaluation fixtures/controls and Docker acceptance; bounded runtime calibration/resource collection; parent-owned runtime/VM provisioning, integration and evidence. Existing code edits remain preserved. Acceptance requires known positive/negative evaluator results, real-model attempts with failures retained, and explicit reporting of unavailable metrics. If utility is not demonstrated, the result is a narrower supported scope or no recommendation rather than an unsupported stable-mode claim.

## Scope and acceptance gate

The user-visible goal is to develop useful local apps without sending inference context to a cloud provider. The first increment exposes an explicitly enabled developer evaluation path through the existing Desktop `LlmProviderRunService` and Codex agent tool loop. It does not enable a public model picker, claim a strict offline mode, or change cloud defaults. Model weights and runtimes are not downloaded without approval.

Repository: `desktop` only. Existing branch is `agent/new-conversation-mode-selector`; working tree was clean at audit. Production, credentials, releases and other repositories remain outside this increment.

The existing CLI performs file retrieval, edits, command execution and tool iteration. A new HTTP agent loop would duplicate that architecture. The initial runtime is Ollama, reached by Codex's supported local/custom-provider mechanism; other runtimes remain evaluated alternatives, not implementations.

Previous delivery evidence: the pinned runtime and 1.7B/4B models are installed in an isolated directory and verified; both candidates completed native cold/warm calibration without the requested visible answer at a 64-token cap. Evaluator controls pass 10/10 at version 0.1 and 6/6 affected controls at version 0.2; that delivery's integrated software suite passes 213/213, with Electron build, typecheck and lint passing. The first real template task at 8192 context fails acceptance with zero tools/edits and observed Ollama prompt truncation. The 1.7B run at 16384 completes all five task families with zero accepted tasks, tools or edits. The 4B baseline also finishes 0/5, with five inactivity timeouts before application acceptance. Versioned smaller-context profiles are evaluated separately. These configurations leave reasoning/sampling defaults uncontrolled and are not pure measures of model quality. See `M1-EXPERIMENT.md` and the dated evidence files; the historical file-inspection evidence fix is included in the 213-test suite.

Before a configuration becomes validated it must run all five task families (supported-template creation, persistent CRUD, modification, test-proven bug fix, coordinated multi-file feature), compile and start the app, pass immutable external acceptance and regression checks, stay within recorded time/resource budgets, and pass a real network-boundary evaluation. Holdout tasks and repeat runs must be reported, including failures. There is no numerical quality or speed claim before measurement.

`promotion-gates.json` records provisional product acceptance thresholds before real model evaluation. Those thresholds are policy decisions, not measured predictions. Changing them requires a new version and fresh holdout evidence.

## Increments

| Increment | Acceptance | Modules | Status / evidence |
| --- | --- | --- | --- |
| 1. Audit and plan | Trace actual agent, auth, tooling, telemetry and distribution | This directory; existing chat, provider and runtime modules | Static audit complete; implementation plan recorded |
| 2. Minimal local adapter | Explicit activation; existing provider service; local-only endpoint/model preflight; no cloud auth/fallback; bounded execution/cancellation | `src/main/llm-provider/`, focused behavior tests | Implemented; real Codex + synthetic runtime tool/file-edit and redirect probes pass. First real template attempt fails; see evidence |
| 3. Initial evaluation harness | Reproducible synthetic fixtures, fixed budgets, independent acceptance, machine-readable failures and pending evidence | `scripts/local-development/`, `test/`, benchmark catalog | Five executable task specifications, 25 planned cases. Docker reference/broken controls 10/10 passed; stronger version 0.2 assertions for three affected families pass 6/6 |
| 4. Candidate viability | Actual M1/8 GB runs across five families; repeats and holdout results | Candidate catalog and run records | Earlier 1.7B/4B baselines: 0/5 each; profile variants remain in M1-RESULTS. New 0.6B follow-up: two experiments, each 0/3 direct and 0/3 prepared on one bug task. Useful development scope not established; see QWEN06-RESULTS |
| 5. Managed installation | Pinned artifacts, integrity/provenance, resumable/cancellable download, deletion and rollback | Runtime installation services | Proposed; gated on viable candidates |
| 6. Calibration and selection | Conservative resource accounting plus measured task success; unknown evidence stays unknown | Hardware snapshots, calibration/selection service | Hardware/resource sampling and real cold/warm calibration implemented/tested; recommendations remain disabled |
| 7. Comparisons and UI | Explicit local/cloud choice; provenance, limits and uncertainty visible | MUI, IPC and configuration | Proposed; no silent default changes |
| 8. Hardening and rollout | All background traffic/context paths audited and tested; rollback; activation remains reversible | Privacy policy, runtime and release controls | Pending; no stable or strict-offline claim |

## Implementation sequence and ownership

1. Audit provider and security boundaries in parallel, plus primary-source runtime research.
2. Write provider behavior specs before adapter implementation; keep cloud adapter unchanged where possible.
3. Independently implement benchmark fixtures and acceptance machinery, consuming the common provider service.
4. Integrate hardware observation, documentation and machine-readable evidence; run focused provider/cloud regressions, typecheck and applicable lint/build checks.
5. Review network/credential boundaries. Real model tests are a separate evidence class from fake server/CLI tests.

No new public `AgentProvider` is introduced merely for inference: current provider IDs describe agent engines. The first developer entry point does not go through cloud model normalization or cloud authentication. It is intentionally not exposed through ordinary chat until per-conversation modality, background memory, diagnostics and context isolation are implemented.

### Configuration follow-up acceptance

The initial failure pattern triggers a separate experiment, not silent replacement of baseline results. First verify whether explicitly disabling multi-agent tools reduces the observed tool inventory while preserving a real CLI command/file-edit probe. A non-thinking setting is a separate variant whose serialized request must be observed before measurement. A compact base-instruction profile is considered only within the same Codex engine and safe workspace policy. Each variant retains the original task, protected tests, 10-minute total / 60-tool budget, and recorded 120-second default inactivity cutoff. Evaluate development tasks before any further holdout use. No optimization is called beneficial without improved accepted tasks, latency or resources under recorded conditions.

A static review identifies metadata loss when timeout/cancellation errors are normalized. The completed corrections preserve observed runtime/digest/tool inventory through those errors and inspect files after failed attempts; missing or unavailable evidence is explicit. That earlier suite passes 213/213. The versioned profile probes pass, but real narrow tasks remain unsuccessful; profiles are retained only as reproducibility controls, not recommended optimizations.

### Closed deliveries and next dependency

`M1-RESULTS.md` and `evidence/m1-summary-2026-09-27.json` record 17 attempts across seven configurations and five distinct tasks, with no accepted task. Reference evaluator controls and synthetic CLI probes are separate. The smaller compact profile does produce actual model-driven tool calls, but fails the task and sometimes tries unavailable host app commands. The agent has no in-loop Docker validation feedback; this is an integration limitation, not proof of intrinsic model incapacity.

The completed 0.6B continuation adds 12 attempts of one repeatedly inspected task, retained separately in [QWEN06-RESULTS.md](QWEN06-RESULTS.md). It demonstrates bounded local preparation and validation of structured outputs, but no improvement in accepted edits or relevant file selection. The next **proposed, unimplemented** experiment combines deterministic source-code search, a bounded editing contract and controlled test feedback, with model/VM resources scheduled explicitly. It needs its own frozen protocol and independent acceptance; more planning or retries are not presumed beneficial.

Verified restricted external-file reads remain a separate product dependency. Current `workspace-write` grants full-disk reads. Whole-CLI egress and Desktop background privacy remain unresolved. Do not advance public UI, model recommendations or a stable managed installation on these failed task results. Cloud benchmarking is unexecuted; the initial plan is not an approved spending run. The existing gates remain unchanged.

Current cleanup is verified in [cleanup-qwen06-2026-09-27.json](evidence/cleanup-qwen06-2026-09-27.json): the owned runtime PID 24723 is absent, loopback port 11445 is closed and the owned VM is stopped. Downloaded verified assets and the local unpublished code remain for reproducibility. The earlier cleanup record belongs to the preceding delivery.

## Initial audit constraints (historical; continuation evidence above supersedes availability)

- Observed host: Darwin arm64, Apple M1, 8 CPU cores, 8,589,934,592 bytes total memory (`sysctl`, 2026-09-26). This is hardware detection, not performance evidence.
- Forger version at audit: 0.5.17; configured Codex CLI: 0.144.1.
- Ollama / llama-server are absent from PATH at audit; model availability has not been established.
- Docker CLI is present but its local daemon is unavailable. No evaluator image has been built or downloaded; application acceptance has not executed.
- Real inference speed, peak unified memory, swap, energy, task success and network isolation: **unmeasured**.
- The shipped Vite/FastAPI/SQLite skeleton is Dockerized; its dependency, build and test commands run through Docker. No runtime/image/model download is implicit in evaluation.
- Full-app privacy also depends on cloud memory maintenance, diagnostics, connections, application traffic and updater/catalog traffic. A loopback inference URL does not establish offline operation or authenticate an existing local service.

## First-increment delivery evidence (historical)

- `evidence/host-2026-09-26.json`: observed M1 / 8 GB and reported Metal support; performance fields remain unmeasured.
- `evidence/cli-protocol-2026-09-26.json`: installed CLI 0.144.1, two synthetic Responses turns, real command/file creation and five redirect canaries. The original direct-client redirect failure and its gateway remediation are retained.
- `evidence/software-verification-2026-09-26.json`: 139/139 focused tests pass; Electron compilation, Desktop typechecking and lint pass. Verification covers configuration, credentials, environment, routing, bounded processes, cancellations, hardware logic, harness accounting and existing cloud behavior. Synthetic results do not validate a candidate.
- `evidence/preflight-final-2026-09-26.json` reports `docker_unavailable` with zero attempts. `evidence/cloud-plan-2026-09-26.json` is an unexecuted synthetic comparison plan. No weights/runtime or evaluator image was downloaded.
- `RESUME.md` separates completed implementation from exact prerequisites and unverified product capabilities. There is no managed installer, public local/cloud selector, calibration-based recommendation or executed cloud comparison in this increment.

## Completion reporting

Each delivery records implemented, tested (fake versus real), measured, proposed, and blocked work separately. Runs store exact model/runtime/configuration, Forger revision, task/acceptance hashes, date and hardware evidence. Unknown metrics are null with a reason, never invented zeros. Failures remain in denominators.
