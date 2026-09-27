# Experimental local development

Updated 2026-09-27 UTC. Forger has an explicitly enabled developer evaluation path through its existing provider service and Codex tool loop. The authorized experiments run on an actual Apple M1 with 8 GiB unified memory. Ollama 0.34.4 and the pinned Qwen3 0.6B/1.7B/4B artifacts are installed in a private evaluation store. The completed 0.6B follow-up records 12 attempts of one bug task in two separate experiments, with no accepted fixes. There is no normal Desktop local/cloud selector, managed installer or stable strict-local mode, and no candidate has a validated development recommendation.

Start with the [live plan](PLAN.md), [M1 experiment and owned resources](M1-EXPERIMENT.md), [code map and decisions](ARCHITECTURE.md), [runtime research](RUNTIME-RESEARCH.md), [candidate catalog](models.json), and [promotion gates](promotion-gates.json). The initial [host observation](evidence/host-2026-09-26.json) establishes physical hardware and reported Metal support; dated calibration and task records establish what actually ran. Detection, runtime-reported GPU allocation and measured resource samples are distinct evidence.

The current [Qwen3 0.6B results and reproduction procedure](QWEN06-RESULTS.md) report the completed [v1 protocol](QWEN06-CONTEXT-EXPERIMENT.md) and [separate v2 protocol](QWEN06-REQUEST-V2-EXPERIMENT.md). The [small-model context literature record](SMALL-MODEL-CONTEXT-RESEARCH.md) separates published findings from these local results. The earlier [17-attempt M1 delivery](M1-RESULTS.md) remains historical evidence under its original conditions.

## Activation and rollback

The internal `LlmProviderRunService` requires `enableExperimentalLocalInference: true` and an explicit `localInference` configuration for an `app_prompt_task` / `task` execution. The runtime remains `provider: 'codex'` because Codex owns the agent loop. Its custom inference provider targets the selected Ollama server. This branch runs before cloud authentication, model normalization or cloud fallback.

Ordinary Desktop chats, settings, app agents, automations and cloud defaults do not select this path. The benchmark command enables it only for its own execution. Stopping that command and leaving the flag disabled rolls back activation; no production configuration or credential is changed. Changes in benchmark tasks occur in disposable synthetic workspaces.

Context preparation is a separate opt-in configuration. `direct-v1` preserves the existing prompt; `staged-v1` uses two bounded calls to the same model to interpret the full prompt and select up to three real files. `staged-request-v2` instead consumes an explicit functional request verified as a literal substring of the full prompt, and also gives that request to file selection. Both staged variants append bounded real-source excerpts as untrusted advisory data while retaining the complete original prompt and restrictions. This is two-call preparation, not adaptive retrieval within the agent loop. It has no validated application benefit. Invalid preparation fails the attempt without retrying or switching to cloud.

The CLI reaches inference through an authenticated per-run loopback gateway with a fixed destination, explicit model check and no redirect forwarding. The gateway accepts bounded function/namespace tool declarations and rejects unsupported custom tools and custom-tool history before forwarding; it does not silently translate or discard them. The [tool-contract probe](evidence/cli-tool-contract-2026-09-27.json) exercises the installed CLI against synthetic inference, not a candidate model.

The experiment has its own runtime home/store and named evaluator VM. The general adapter still treats its configured Ollama server as a trusted dependency: the gateway does not authenticate that server or prevent another local process from reaching it. The separate runtime network profile and serial lifecycle procedure are documented in [M1-EXPERIMENT.md](M1-EXPERIMENT.md). They do not isolate background memory maintenance, diagnostics, connections or ordinary Desktop traffic.

An outer Seatbelt sandbox prevents Codex's existing inner command sandbox from initializing on this Mac. Synthetic evaluation explicitly selects `codex-workspace`, keeps the original safe workspace sandbox and disabled tool-network access, and records `wholeCliEgressVerified=false`. The failed nested probe, passing original-workspace probe and controlled network canaries remain separate evidence. No unsafe execution mode or silent cloud fallback is enabled to bypass the limitation.

## Reproduce software verification

From the Desktop repository:

```sh
npm run build:electron
node --test test/main/local-inference*.test.mjs test/main/local-development*.test.mjs test/main/llm-provider-run-service.test.mjs test/main/chat-orchestrator.test.mjs test/contracts/llm-provider-boundaries.test.mjs
npm run typecheck
npm run lint
npm run local:hardware
npm run local:benchmark -- --list
```

The local integration specs use synthetic HTTP responses and CLI fixtures. Hardware tests include injected OS values; those are tests of detection logic, not measurements of simulated machines. Run software/build checks separately from resource-sensitive model measurement so the checks do not silently change the observed workload.

An optional protocol smoke uses the real, already installed Codex **0.144.1** binary with a synthetic loopback server. It asks the real agent tool loop to create a temporary file, verifies the file and cleans up. It performs no model inference and must never enter a quality or speed comparison:

```sh
npm run local:probe-cli -- /absolute/path/to/codex
npm run local:probe-cli -- /absolute/path/to/codex --redirect-check
```

The second command uses a second loopback canary to detect whether an inference redirect is followed. Use `--redirect-check=301` (or 302, 303, 307, 308) to select the status. [Recorded verification](evidence/cli-protocol-2026-09-26.json) includes the file-edit probe and all five statuses. A successful result covers that redirect scenario; it is not process-wide egress verification.

## Reproduce model evaluation

The [benchmark instructions](../../benchmarks/local-development/README.md) define exact runner options, evaluator preparation and result interpretation. There are **five executable cases and 25 catalog-only planned cases**. Docker controls, real-model attempts and synthetic harness tests have separate evidence classes. Every executable case starts from the supported Vite/FastAPI/SQLite template plus a synthetic overlay, with the pinned commons mounts materialized before protected hashes are recorded. Creation from scratch is not demonstrated.

```sh
npm run local:benchmark -- --check
npm run local:benchmark -- --cloud-plan
```

`--check` reports missing prerequisites. `--cloud-plan` prepares a synthetic comparison plan without contacting a provider. There is no automatic cloud benchmark execution or fallback. Cloud execution requires separate authorization, provider/model identity, supported authentication, a shared orchestration configuration and the same acceptance checks. Do not supply private repositories as comparison fixtures.

The current experiment supplies those prerequisites: pinned local weights/runtime, Codex 0.144.1 and a Docker evaluator in the owned Lima instance `forger-local-eval` (two CPUs, 3 GiB RAM). The evaluator image is addressed by immutable SHA-256 ID. Only synthetic scratch and evaluator files are shared with the VM read-only; the default Docker context and existing user instances remain unchanged. The runner never pulls an image, installs dependencies or downloads weights during evaluation.

Use the documented `m1-evaluation.mjs` procedure on this host. It stops the VM before inference, samples the agent/runtime phase, records `/api/ps`, unloads the selected model, then starts the VM and revalidates the image/CLI before acceptance. Agent, evaluation and lifecycle time are recorded separately. A successful unload response and absent model entry do not measure the instant all GPU allocations are released. Cold/resident state does not control OS file caches.

The original evaluator controls passed **10/10**: five reviewed solutions accepted and five deliberately incomplete initial applications rejected. Version 0.2 strengthens CRUD normalization/invalid PUT, search with an active query and archive/restore persistence; its affected controls passed **6/6**. These validate evaluator behavior and must not be reported as model success rates. Preserve each version's image/evaluator hashes and the earlier failed preparation records.

## Installation, recovery and catalog maintenance

Managed installation, resumable downloads, user-facing removal and automatic model updates remain unimplemented. The authorized experiment provisioned its own assets under `~/Library/Application Support/ForgerLocalEvaluation`; it did not modify an existing Ollama installation. The [runtime/1.7B integrity record](evidence/artifact-integrity-2026-09-27.json), [4B integrity record](evidence/artifact-integrity-qwen3-4b-2026-09-27.json), and [0.6B offline verification](evidence/verified-artifacts-qwen3-0.6b-2026-09-27.json) verify the downloaded manifest/configuration/layers by size and SHA-256. The 0.6B Q4_K_M weight file is 522,640,096 bytes, approximately 523 MB; that download size does not measure runtime memory. The initial runtime record also contains a separate macOS signature verification. The artifacts remain private evaluation assets and are not redistributed by Forger.

The independent read-only verifier makes integrity checks reproducible without loading whole weight files into memory:

```sh
node scripts/local-development/verify-artifacts.mjs --model qwen3:1.7b --model-store /ABSOLUTE/MODEL_STORE --output /ABSOLUTE/NEW_REPORT.json --runtime-archive /ABSOLUTE/ollama-darwin.tgz
node scripts/local-development/verify-artifacts.mjs --model qwen3:4b --model-store /ABSOLUTE/MODEL_STORE --output /ABSOLUTE/ANOTHER_NEW_REPORT.json
```

It reads this repository's pinned catalog, checks the manifest before trusting its blob descriptors, streams every config/layer hash, rejects unsafe paths and symlinks, and refuses to overwrite an existing report. `--runtime-archive` is optional. It performs no network access, extraction, installation or signature/notarization verification; that last claim must come from its own evidence.

The owned runtime uses dedicated loopback port 11445, a separate home/model directory and `OLLAMA_NO_CLOUD=1` on the **server** process. Setting that variable only on a client cannot change an existing server. Additional download/setup work must remain within the user's authorized scope; neither the benchmark nor the verifier invokes a remote installation script or changes another service. Tags remain mutable: preflight rejects a mismatching digest but cannot attest that a separate service preserves the same tag throughout a run.

If a prerequisite is absent, prepare it through the authorized setup procedure and rerun preflight. On digest mismatch, inspect provenance and update the versioned catalog only after review. On context, memory, timeout or tool failure, retain the failed record and reduce offered scope or select another explicitly authorized configuration. Agent context budget, Ollama's reported `num_ctx`, retained input and runtime context shifting must be recorded separately. A requested or reported capacity does not guarantee the complete task context survived.

To uninstall a separately provisioned experiment, stop its owned process and remove only its designated temporary runtime/model data after confirming the scope. This feature does not own or delete models from a pre-existing Ollama service. Runtime updates require a new pinned identity and repeated capability, acceptance and privacy checks.

## Evidence and remaining work

The current [v2 software freeze](evidence/qwen06-v2-software-freeze-2026-09-27.json) records **266/266 focused tests**, Electron compilation, Desktop typechecking and lint. Tests cover context preparation, literal request provenance, failure evidence and existing provider behavior; their success is not a model-quality result. The previous [213-test verification record](evidence/software-verification-final-2026-09-27.json), 139-test record and [unavailable-Docker preflight](evidence/preflight-final-2026-09-26.json) remain historical evidence. The [cloud plan](evidence/cloud-plan-2026-09-26.json) remains prepared and unexecuted.

The completed 0.6B experiments each compare three direct attempts against three prepared attempts on the same `bug-01` task. V1 is **0/3 direct and 0/3 staged**; v2 is **0/3 direct and 0/3 staged**. All 12 attempts have zero observed tool calls and no file edits. All six preparations return valid structured JSON, but select the same three irrelevant files. V2 identifies the broad functional goal instead of the benchmark framing, while its interpretation remains incomplete. These are repeated observations on one task, not 12 distinct tasks or a validated improvement. [V1 comparison](evidence/m1-qwen06-context-ablation-2026-09-27.json) and [v2 comparison](evidence/m1-qwen06-v2-context-ablation-2026-09-27.json) preserve separate frozen software identities; cross-version results are descriptive, not a controlled paired comparison.

Completed evidence includes:

- [Evaluator 0.1 controls](evidence/evaluator-controls-envfixed-2026-09-27.json): 10/10 controls, representing five accepted references and five expected rejections. [Evaluator 0.2 affected controls](evidence/evaluator-controls-v02-2026-09-27.json): 6/6 under stronger assertions. These are applications exercised by Docker, not outputs from a candidate model.
- [Cold](evidence/calibration-qwen3-1.7b-cold-2026-09-27.json) and [warm](evidence/calibration-qwen3-1.7b-warm-2026-09-27.json) native 1.7B calibration: one sample per phase, context 2048 and 64 generated tokens. Both spend the cap on thinking, return no visible answer and fail to produce the requested `READY`. Reported generation speed measures that short stream; it does not show useful agent performance.
- [First 1.7B template task](evidence/m1-qwen3-1.7b-template-trial1-2026-09-27.json): one attempted task at requested context 8192, failed acceptance, zero observed tool calls and no file changes. The [runtime warning](evidence/context-truncation-8192-2026-09-27.json) records input truncation from 8327 to 4098 tokens despite a reported 8192 context. Preserve this failure.

The baseline 16,384-context experiments finish with **0/5 accepted tasks for 1.7B** and **0/5 for 4B**. See the [actual M1 results and limits](M1-RESULTS.md), including separate raw records and configuration follow-up. Calibration, verified downloads, GPU allocation and passing evaluator controls do not establish successful application development or compatibility with older machines.

The pinned Codex `workspace-write` sandbox permits full-disk reads. Separate HOME/environment and disabled tool networking do not enforce shared-files-only access. Restricted reads and whole-process egress are mandatory unresolved product gates; the current path is restricted to controlled synthetic evaluation. See the exact [privacy findings](M1-EXPERIMENT.md).

Before a public rollout: establish useful real-model task results, expand the 25 planned cases only when initial utility warrants it, measure resources and retained context, verify inference/child-process egress, address background memory and diagnostic exports, implement managed runtime installation/lifecycle, and add explicit MUI local/cloud choice. The [benchmark guide](../../benchmarks/local-development/README.md) also distinguishes independent acceptance from the still-proposed gate proving that an agent added useful fail-before/pass-after tests. Follow the [live plan](PLAN.md) and [M1 experiment](M1-EXPERIMENT.md) for the active work and scope limits.

The proposed next experiment combines deterministic code search, a bounded editing contract and controlled test feedback. It is not implemented or measured in this delivery and requires a separate frozen comparison before any product claim. [Current cleanup evidence](evidence/cleanup-qwen06-2026-09-27.json) verifies that the owned runtime is absent, port 11445 is closed and the evaluator VM is stopped; verified downloaded assets remain available.
