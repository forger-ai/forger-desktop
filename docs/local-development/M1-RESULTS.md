# Actual M1 evaluation — 2026-09-27 UTC

This report concerns the physical Apple M1 / 8 GiB computer, macOS 26.5.1, with existing user applications left open. It does not simulate older or lower-memory hardware. Times below describe failed attempts, not time to a functional solution. No candidate or product configuration is validated.

## Baseline agent results

Ollama 0.34.4, Codex 0.144.1, Q4_K_M artifacts and Forger 0.5.17 with the local uncommitted adapter are recorded by exact digest/hash in each run. Both runs use the original `baseline-v1` agent settings (implicit at the time), requested and runtime-reported context 16384, a 10-minute task budget, a 60-tool limit and the adapter's 120-second inactivity cutoff. Reasoning and sampling defaults are not explicitly controlled. Runtime sampler observations show temperature 1.0; the model artifact's temperature 0.6 does not set the effective Responses default.

| Task | Qwen3 1.7B | Agent seconds | Qwen3 4B | Agent seconds |
| --- | --- | ---: | --- | ---: |
| Supported-template counter app | Acceptance failure | 120.3 | Inactivity timeout | 125.3 |
| Persistent notes CRUD | Required backend checks fail | 130.4 | Inactivity timeout | 122.0 |
| Search existing notes | Acceptance failure | 98.6 | Inactivity timeout | 122.3 |
| Fix title normalization | Acceptance failure | 63.8 | Inactivity timeout | 122.2 |
| Archive/restore across DB, API and UI (holdout) | Missing required archive state | 96.8 | Inactivity timeout | 122.5 |

- **1.7B: 0/5 accepted, 0/5 autonomous successes, no human interventions, zero observed tool calls or file changes.** Independent Docker checks run after generation. A failing required test on an unchanged incomplete fixture is not a newly introduced regression.
- **4B: 0/5 accepted, 0/5 autonomous successes, no human interventions, five timeouts and zero observed tool calls.** Each request times out while processing the initial context. The application evaluator and final file inspection are not reached for these historical attempts; they are not reported as having run. The empty file-change array in those older records is not independent proof of unchanged files.
- Each task has one trial per model in these baseline suites. There is no per-task repeatability estimate and no subset solved by both. Do not rank the models using the duration of their failures.
- Every case starts from the supported template. Neither creation from scratch nor a model-generated working application is demonstrated by these baseline runs.

Raw records: [1.7B five-family run](evidence/m1-qwen3-1.7b-context16384-2026-09-27.json), [4B five-family run](evidence/m1-qwen3-4b-context16384-2026-09-27.json). Agent time includes the resource monitor and post-agent residency observation. Docker/VM lifecycle is recorded separately. The source and compiled-provider hashes match across the baselines; the harness hash differs because the standalone artifact verifier was added between them. The strict comparison utility therefore rejects these as a formally controlled paired report. This table is a descriptive record, not a cloud comparison or a model-quality ranking.

The earlier [1.7B 8192-context template attempt](evidence/m1-qwen3-1.7b-template-trial1-2026-09-27.json) also fails, with no tools/edits. Its [runtime warning](evidence/context-truncation-8192-2026-09-27.json) records prompt truncation from 8327 to 4098 tokens. That attempt remains separate; increasing the reported context does not prove retained context throughout every turn.

## Resource and latency observations

The VM is stopped for inference; after the selected model is unloaded, the VM starts for Docker acceptance. Models and compiler processes do not intentionally overlap. OS caches, other applications, thermal state and system swap remain uncontrolled.

| Baseline | Maximum sampled runtime-tree RSS | Maximum sampled system swap used |
| --- | ---: | ---: |
| 1.7B / 16384 context | 3,341,058,048 bytes | 8,585,866,117 bytes |
| 4B / 16384 context | 4,670,652,416 bytes | 10,929,569,792 bytes |

RSS is a sampled sum and may double-count shared pages. System swap cannot be causally assigned to this model. Neither number is peak physical unified-memory usage. For 4B, `/api/ps` reports 5,470,557,304 bytes total and 4,539,736,390 bytes allocated to VRAM at context 16384; that report is distinct from measured RSS. Initial model download size alone is not a capacity estimate.

Native calibration uses the same short synthetic prompt, context 2048, generation cap 64, temperature 0 and seed 42. There is one cold and one warm sample per candidate. Cold means absent from `/api/ps`, not a cold OS cache.

| Candidate / phase | First thinking chunk | Runtime load | Runtime-reported generation rate | Requested visible answer |
| --- | ---: | ---: | ---: | --- |
| 1.7B cold | 2612.8 ms | 2304.9 ms | 41.68 tokens/s | Not produced |
| 1.7B warm | 87.4 ms | 1.1 ms | 42.02 tokens/s | Not produced |
| 4B cold | 4564.6 ms | 4330.6 ms | 22.46 tokens/s | Not produced |
| 4B warm | 69.5 ms | 1.1 ms | 22.23 tokens/s | Not produced |

All four streams end at the generation cap after thinking only. These values measure a bounded native stream; they are not agent completion speeds. Visible-response latency is null. The cap may be too short to answer with thinking enabled; this result does not establish inability to answer the prompt. Calibration files record the rate formula, runtime token counts, timings and limitations.

## What the controls establish

[Evaluator 0.1](evidence/evaluator-controls-envfixed-2026-09-27.json) accepts five reviewed reference solutions and rejects five incomplete fixtures (10/10 expected outcomes). [Evaluator 0.2](evidence/evaluator-controls-v02-2026-09-27.json) strengthens three families and passes all six affected positive/negative controls. These exercise build, startup, backend/frontend tests, SQLite persistence and browser flows. They are not model-generated successes. Proving that an agent added useful fail-before/pass-after tests remains a separate [proposed gate](../../benchmarks/local-development/TEST-GATE-PROPOSAL.md).

The installed real CLI completes the synthetic two-turn command/file-edit probe, and the authenticated gateway blocks redirect forwarding and unsupported custom-tool contracts. The controlled network canary records 21 working permitted/baseline paths and 15 denied paths across process depths/transports, with no canary leakage in those restricted cases. None of these checks proves complete process egress isolation.

## Privacy and product decision

The inference route is numeric loopback, model-digest preflight is explicit, cloud auth/fallback is bypassed, and CLI environment/home are separate. The actual workspace-write sandbox still permits full-disk reads. An outer network sandbox breaks nested command sandbox initialization on this Mac. Whole-CLI traffic, background memory/diagnostics and ordinary Desktop/app processes are not isolated. The runtime's loopback endpoint itself is not authenticated by the per-run gateway. See [boundaries and exact setup](M1-EXPERIMENT.md).

Consequently, the experiment does not establish strict-local or fully disconnected product readiness. Public UI, managed installation and automatic model recommendations remain gated. Cloud comparison is prepared only as synthetic fixtures; no cloud benchmark or spending occurs. The 30-entry task catalog has five executable tasks and 25 planned tasks.

## Configuration follow-up

The three real-CLI synthetic profile probes pass. They verify that the request drops multi-agent tools, serializes reasoning effort `none` when selected and carries the exact compact contract. They also verify a real file edit driven by synthetic inference. The following real-model attempts use the same `bug-01` task and 16384 runtime context; their results remain separate from the frozen baselines.

| Candidate / profile | Attempts accepted | Agent seconds | Observed tool calls | Result |
| --- | ---: | --- | --- | --- |
| 1.7B / single-agent | 0/1 | 89.5 | 0 | Stream closes before `response.completed`; final file inspection unavailable in this historical record |
| 1.7B / single-agent, no thinking | 0/1 | 60.9 | 0 | No file changes; title-normalization acceptance fails |
| 1.7B / compact, no thinking | 0/3 | 27.3, 32.0, 257.0 | 4, 2, 13 | No file changes in any repetition; acceptance fails |
| 4B / compact, no thinking | 0/1 | 121.8 | 0 | Inactivity timeout; the corrected harness verifies no file changes even after the error |

Raw evidence: [single-agent](evidence/m1-qwen3-1.7b-single-agent-bug-2026-09-27.json), [no-thinking](evidence/m1-qwen3-1.7b-no-thinking-bug-2026-09-27.json), [three compact repetitions](evidence/m1-qwen3-1.7b-compact-bug-repeat3-2026-09-27.json), [4B compact](evidence/m1-qwen3-4b-compact-bug-2026-09-27.json). The compact 1.7B profile establishes actual model-to-command-tool round trips, including returned errors. It does not establish competent tool selection or app-development success. Its failed calls include missing `uv`/`npm` and invalid directory changes. The 4B compact timing also overlaps brief host-side evidence fingerprinting; it is not a clean-machine controlled latency estimate.

The repeated subset is one task with three trials, not the five-task repeat set required for promotion. Times vary substantially, and none is a time to a functional solution. Profiles remain explicit reproducibility controls, without a recommended optimization or default product activation. Original failures and promotion thresholds remain unchanged. A [machine-readable index](evidence/m1-summary-2026-09-27.json) covers **17 attempt records across seven configurations and five distinct tasks**, including repeats; it is not a 17-task independent suite or a pooled model-quality rate.

The harness deliberately does not give the agent Docker access or host app build/test commands. Independent Docker acceptance happens after the agent finishes. This prevents simultaneous inference/VM memory demand and host execution of Dockerized app commands, but also removes the agent's normal test-feedback loop. Missing `uv`/`npm` in the sanitized command environment is an integration/environment constraint. Attempts to use those commands despite the task instruction are recorded; the resulting failures do not isolate model ability from the evaluation setup. A managed validation tool would need its own design, sandbox/resource checks and separate comparison.

## Delivery state

The final relevant software suite passes **213/213 tests**, Electron build, typechecking and lint. Tests distinguish failure-time file inspection from unavailable evidence; older records are not retroactively rewritten. See [verification](evidence/software-verification-final-2026-09-27.json). The runtime process is stopped, its port is closed and the owned VM reports `Stopped`; [cleanup evidence](evidence/cleanup-2026-09-27.json) records those observations. Verified assets remain for reproducibility. Nothing is published and no credential is changed.

The product scope remains unvalidated. The next useful increment is a bounded, isolated validation tool that returns app test failures during the agent loop, together with verified restricted filesystem reads. Repeat the narrow development case under that explicit configuration before expanding the suite, adding a managed installer or enabling local/cloud UI. Cloud measurements and their spending still require a concrete authorized comparison run.
