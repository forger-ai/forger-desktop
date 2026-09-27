# Resume the local development experiment

Updated 2026-09-27 UTC. Repository: `desktop`. Base revision: `7fa965edc9408211d8f4336bb0ed0a4f30a88102`, version 0.5.17. Changes are local and unpublished on `agent/new-conversation-mode-selector`. Preserve all changes and recheck Git state before editing. No other product repository, production, credential, release or user model service is changed.

## Current implementation

- Opt-in main-process local inference through the existing `LlmProviderRunService` and Codex tool loop. Ordinary chat, app agents, automations and cloud defaults do not enable it.
- Exact-model preflight, separate environment/home, no cloud auth/fallback, bounded execution/cancellation, authenticated fixed-destination gateway and strict supported tool-contract types.
- Hardware detection plus bounded real native calibration, serial inference/Docker scheduling, process-tree RSS and system swap observations. Recommendations remain disabled; peak unified memory remains unknown.
- Five executable synthetic app tasks from the pinned supported template; 25 additional catalog entries are planned. Docker independently checks builds, regressions, real startup, API, persistence and browser flows. Protected original tests and configuration are mounted read-only.
- An offline streaming verifier checks the catalog-pinned archive, model manifest, configuration and all layers. It is not a managed installer or signature/notarization verifier.
- Experimental agent profiles preserve a baseline and isolate smaller tool inventories, explicit reasoning and compact Forger instructions. They are evaluation controls, not validated optimizations or public settings.
- Context strategies preserve `direct-v1`, add two-call `staged-v1` preparation, and add `staged-request-v2` with an explicitly supplied, literal functional request. Preparation uses the same model, strict JSON schemas and real-file IDs; source excerpts are bounded and advisory. The original prompt and all restrictions remain intact. This does not implement adaptive retrieval in a loop, deterministic code search, a bounded patch contract or in-loop test feedback.
- Versioned metadata, predeclared promotion gates, raw machine-readable results, a strict comparison utility and an unexecuted cloud plan.

## Verified assets and owned resources

The user's instruction to execute the next steps on this computer authorizes the described local runtime/model and Docker evaluator preparation. Those downloads have happened; do not repeat stale approval questions from the first audit. This does not authorize unbounded cloud spending, private repository transmission or publication.

The actual host is Apple M1 / 8 GiB, macOS 26.5.1. Existing user applications stay open. Runtime, model store, fresh home and logs are under `~/Library/Application Support/ForgerLocalEvaluation`. Ollama 0.34.4 and Qwen3 0.6B/1.7B/4B Q4_K_M are installed and verified. The 0.6B weight file is 522,640,096 bytes, approximately 523 MB; all six manifest/config/layer files pass the [offline verifier](evidence/verified-artifacts-qwen3-0.6b-2026-09-27.json). Its manifest digest is `7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435`. Download size is not runtime memory. Qwen3.5 2B is catalogued only, not installed or measured. Consult `models.json` and the other `verified-artifacts-*` evidence. The runtime's macOS signing identity is independently recorded in initial artifact evidence.

Owned Lima VM: `forger-local-eval`, VZ, two CPUs, 3 GiB memory, 12 GiB sparse disk. Existing VM `eigen-tests` and the user's default Docker context are untouched. The per-command endpoint is `unix://$HOME/.lima/forger-local-eval/sock/docker.sock`. The evaluator image is `sha256:de5bb77888ef8a6826ffa49ab9132d287c4e9e26a187c5a143213eeaa2e28406`. It pins FastAPI 0.136.3 for the original skeleton route contract; dependency inventories and unsuccessful preparation attempts remain recorded. No Desktop/private repository build context is sent to Docker.

Codex 0.144.1 is the existing installed binary, SHA-256 `29915529b97697def1a957b0505e770aa6a45744435d62fc263e98d7619e167a`. The exact path, runtime launch, benchmark, calibration and verification commands are in [M1-EXPERIMENT.md](M1-EXPERIMENT.md). Do not assume a prior PID is still owned. Recheck listeners, runtime identity and VM state before restarting.

## Evidence and interpretation

Read [QWEN06-RESULTS.md](QWEN06-RESULTS.md) first. The current delivery records **12 new attempts of one task (`bug-01`)**, split into two frozen experiments. Each experiment has three direct and three prepared attempts; every arm finishes 0/3 accepted, with zero observed tool calls and no file edits. All six preparations return schema-valid JSON. V1 interprets benchmark framing as the goal; v2 isolates the literal functional request and identifies its broad goal, but omits requirements. Both select the same three irrelevant paths. Valid JSON and a plausible goal are not application success or a validated optimization.

The current [software freeze](evidence/qwen06-v2-software-freeze-2026-09-27.json) records **266/266 tests**, Electron build, typecheck and lint passing. The following records preserve raw outcomes and separate within-experiment comparisons:

| Experiment | Protocol | Direct attempts | Prepared attempts | Comparison |
| --- | --- | --- | --- | --- |
| V1 | [Full-prompt preparation](QWEN06-CONTEXT-EXPERIMENT.md) | [0/3](evidence/m1-qwen06-direct-2026-09-27.json) | [0/3](evidence/m1-qwen06-staged-2026-09-27.json) | [V1 comparison](evidence/m1-qwen06-context-ablation-2026-09-27.json) |
| V2 | [Literal functional request](QWEN06-REQUEST-V2-EXPERIMENT.md) | [0/3](evidence/m1-qwen06-v2-direct-2026-09-27.json) | [0/3](evidence/m1-qwen06-v2-staged-2026-09-27.json) | [V2 comparison](evidence/m1-qwen06-v2-context-ablation-2026-09-27.json) |

V1 and v2 have different software identities. Their contrast is descriptive, not a formally controlled cross-version comparison; do not pool repetitions into a general success estimate or call them 12 distinct tasks. No model recommendation follows. The same-model preprocessing literature and its training/task differences are recorded in [SMALL-MODEL-CONTEXT-RESEARCH.md](SMALL-MODEL-CONTEXT-RESEARCH.md).

### Previous M1 delivery, preserved separately

[M1-RESULTS.md](M1-RESULTS.md) records 17 earlier attempts across seven configurations and five distinct tasks, with zero accepted tasks. Compact 1.7B produces real tool round trips but fails all three bug-fix repetitions; compact 4B times out. That delivery's software suite passes 213/213 tests, with build, typecheck and lint passing. The initial 1.7B/8192 template attempt fails with observed truncation. The baseline 16384 runs finish at 0/5 accepted tasks for 1.7B (no tools or edits) and 0/5 for 4B (five inactivity timeouts during initial context processing). These are configuration-specific observations, not universal claims that the machine or model cannot work.

Cold/warm calibration is one sample per phase per model, context 2048, cap 64, temperature 0, seed 42. All four streams end after thinking only with no requested visible answer. Native throughput is not app-development speed. Sampled RSS and system swap do not establish peak unified model memory.

Evaluator controls pass 10/10 at version 0.1 and 6/6 affected controls at version 0.2. Those are reviewed reference applications and deliberately incomplete fixtures, not model successes. The real CLI's synthetic tool/redirect probes and mocked software tests are another evidence class. Software commands and counts live in `PLAN.md` and the dated verification records; do not reuse an earlier count as the final count after source changes.

Known historical defect: initial baseline failure normalization dropped some adapter metadata. New code preserves observed metadata; do not retroactively invent missing fields in earlier records. `/api/ps` observations remain available separately in the serial results. The baseline suites have different harness hashes, so the strict comparison utility rejects a formal paired comparison even though their compiled adapter matches.

## Security gates and unimplemented product scope

`workspace-write` grants full-disk reads, despite write restrictions. Separate HOME/environment do not enforce shared-files-only access. A supported custom restricted-read permission profile is researched but not implemented/tested. The second outer Seatbelt sandbox prevents the existing inner command sandbox from initializing on this host; unsafe execution is never used as a workaround. Whole-CLI egress, background memory, diagnostics and ordinary Desktop/application traffic remain unverified/unisolated. The trusted Ollama loopback endpoint is not authenticated by the gateway and can reach other loopback services under its experimental profile.

No strict-local/offline product claim, public model picker, managed download/resume/removal, autonomous model recommendation or executed cloud comparison exists. The promotion gates remain unmet. Runtime context allocation does not establish complete retained context. The added-tests fail-before/pass-after gate is proposed separately from existing immutable acceptance. Older machines and other operating systems have no model performance evidence.

## Next concrete sequence

1. Read the current 0.6B results, both closed protocols, earlier M1 results and working-tree state. Recheck available disk, workload, stopped owned resources and pinned assets. Do not redownload verified assets implicitly. The [current results](QWEN06-RESULTS.md) provide the v2 reproduction procedure; its raw records, request hashes and software freeze are the authoritative comparison inputs.
2. Run software checks outside timed inference. For any profile change, first run the real CLI against the synthetic server and verify actual request settings/tool inventory. Keep raw failed trials and exact profile/source/build identities.
3. Design and preregister the proposed next experiment: deterministic source-code search, a bounded editing contract and controlled feedback from application tests. These are not implemented or measured in this delivery. Keep it separate from the completed two-call treatments, retain the same independent acceptance, and record its resource/lifecycle costs. If it produces useful accepted changes, repeat and evaluate unseen tasks before expanding the backlog. A text response, valid JSON or successful fake-tool probe is insufficient.
4. Before ordinary app use, implement and test restricted filesystem reads, subprocess/whole-CLI network boundaries, explicit conversation modality and background memory/diagnostics policy. Use external-file, symlink and child-process canaries alongside working in-workspace controls. Do not combine the documented new permission profile with legacy sandbox flags.
5. Implement managed installation and visible local/cloud selection only for a scope backed by useful task evidence and the required privacy controls. Cloud evaluation requires separately authorized synthetic fixtures, spending and supported authentication; the current cloud command only prepares a plan.

Current cleanup is verified in [cleanup-qwen06-2026-09-27.json](evidence/cleanup-qwen06-2026-09-27.json): runtime PID 24723 is absent after identity-checked shutdown, port 11445 is closed and `forger-local-eval` is stopped. Downloaded assets remain for reproducibility. The older cleanup record and PID belong to the previous delivery. Do not promise background continuation, close user applications, delete other services/stores, publish a release or lower the predeclared thresholds to relabel failures as success.
