# Qwen3-0.6B and same-model context preparation on M1 / 8 GiB

Measured on **2026-09-27 UTC**, using the actual Apple M1 / 8 GiB host. **The model runs, but neither tested preparation method produces an accepted repair.** These are two small experiments on one repeated synthetic bug, not a twelve-task benchmark or evidence that every use of this model fails.

## Evidence status

| Category | Result |
| --- | --- |
| Implemented | Optional two-call preparation in the existing local provider; bounded real-file retrieval; original request preservation; explicit v2 functional request; exact experiment/comparison commands and provenance. |
| Software tested | **266/266** relevant tests pass, zero skipped; Electron build, full typecheck and lint pass. Synthetic responses and injected filesystem/network failures verify integration behavior, not model intelligence. |
| Model measured | **12 attempted runs, one distinct task**, two experiments with three repetitions per arm. All fail independent acceptance; no tools, edits, intervention or observed timeouts. |
| Intermediate behavior | All six preparations produce schema-valid outputs. V2 identifies the general goal, but does not preserve every requirement or select useful files. |
| Not demonstrated | Autonomous app development, a useful preprocessing optimization, reliable tool calling, full requirement understanding, strict-local product privacy or a hardware recommendation. |
| Proposed only | Deterministic code localization, a narrower editing contract and in-loop application-test feedback as a separately controlled next experiment. |

The earlier **17 attempts with 1.7B/4B** remain separate historical evidence in [M1-RESULTS.md](M1-RESULTS.md). No cloud model is invoked and no private app is used in these new attempts.

## Fixed setup and experimental difference

The exact artifact is `qwen3:0.6b`, GGUF Q4_K_M, manifest `sha256:7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435`. Weights occupy 522,640,096 bytes; model layers plus configuration total 522,653,767 bytes, excluding manifest and transport. Download size is not required memory. [Artifact verification](evidence/verified-artifacts-qwen3-0.6b-2026-09-27.json) checks the pinned runtime archive, manifest and every model layer. The model remains experimental in [the catalog](models.json).

Both experiments use Ollama **0.34.4**, Codex **0.144.1**, Forger **0.5.17** with local changes, `compact-v1`, context allocation 16,384 and the pinned evaluator image `sha256:de5bb77888ef8a6826ffa49ab9132d287c4e9e26a187c5a143213eeaa2e28406`. Agent budget is 600 seconds and 60 observed tool calls, no harness retries, with 240 seconds for independent evaluation. Native preparation uses the same model/context, `think:false`, temperature 0.7, top-p 0.8, top-k 20, seed 42, at most 256 generated tokens and 30 seconds per call. The CLI agent retains its existing separate profile; preparation settings are not silently attributed to it.

Every attempt starts from a fresh copy of the supported template with the known note-title bug. The request requires POST/PUT trimming before persistence, invalid-title rejection, preserved CRUD behavior and regression tests. The original protected evaluator is unchanged. Template builds and existing regression checks can pass while this specific bug remains; that is not a successful repair.

Each experiment runs D/S, S/D, D/S. `direct-v1` passes the original prompt unchanged. Prepared arms first extract tentative intent, then select up to three IDs from a filtered inventory; Forger reads bounded source excerpts and appends them as untrusted advisory context. This **adds context**; it does not compress the original request or implement an adaptive retrieval loop during editing.

- [V1 protocol](QWEN06-CONTEXT-EXPERIMENT.md): intent extraction receives the complete prompt, including benchmark/platform instructions.
- [V2 protocol](QWEN06-REQUEST-V2-EXPERIMENT.md): an explicit `localContextRequest` carries the literal functional request. Both preparation stages see that request without administrative instructions. The final agent still sees the complete original prompt and restrictions.

V2 is preregistered after observing v1, with new code and fresh direct controls. [V1](evidence/qwen06-software-freeze-2026-09-27.json) and [v2](evidence/qwen06-v2-software-freeze-2026-09-27.json) freeze records contain source, compiled provider, harness and protocol hashes. Those software identities are checked after their respective runs. The pre-run protocol copies are retained in evidence. Formal pairing is valid only **within** each experiment; v1/v2 descriptions do not constitute a controlled cross-version comparison.

## Application outcomes and duration

| Experiment / arm | Accepted / attempted | Mean full failed attempt | Range | Sample SD | Mean agent phase, including preparation |
| --- | --- | --- | --- | --- | --- |
| V1 direct | 0/3 | 37.68 s | 37.01–38.41 s | 0.70 s | 9.90 s |
| V1 prepared | 0/3 | 47.23 s | 45.81–48.59 s | 1.39 s | 19.54 s |
| V2 direct | 0/3 | 38.40 s | 37.96–39.22 s | 0.71 s | 11.02 s |
| V2 prepared | 0/3 | 48.72 s | 44.20–55.19 s | 5.74 s | 21.64 s |

These durations end in **failure**, not a functional solution. The full timer includes model unload, VM startup and Docker acceptance, while preflight/VM shutdown are recorded separately. Download is outside it. Preparation alone averages 4.76 seconds in v1 and 4.42 seconds in v2. Additional prompt processing and generated output also affect the agent phase; elapsed differences cannot be attributed solely to those extra calls. There are zero pairs solved by both strategies, so there is no solved-only speed comparison.

Across all 12 attempts: backend compilation, frontend build, existing backend/frontend regression and runtime health checks pass on the unmodified fixture. Task acceptance fails with persisted `'  Trim me  '` instead of `'Trim me'`. Evaluation stops at that failure; later checks must not be reported as passed. No candidate writes source or tests, changes protected files, or invokes an observed tool. No human correction enters an attempt.

Raw evidence: [v1 direct](evidence/m1-qwen06-direct-2026-09-27.json), [v1 prepared](evidence/m1-qwen06-staged-2026-09-27.json), [v1 comparison](evidence/m1-qwen06-context-ablation-2026-09-27.json), [v2 direct](evidence/m1-qwen06-v2-direct-2026-09-27.json), [v2 prepared](evidence/m1-qwen06-v2-staged-2026-09-27.json), [v2 comparison](evidence/m1-qwen06-v2-context-ablation-2026-09-27.json). [Derived statistics and the post-run semantic audit](evidence/qwen06-analysis-2026-09-27.json) include hashes of every source report.

## What preparation actually does

All three v1 interpretations identify `Synthetic Forger benchmark` as the goal and emphasize administrative restrictions. Separating the request in v2 changes all three goals to `Reproduce and fix the note-title whitespace bug`. This is a narrow positive observation about the general topic, not complete understanding: v2 omits explicit normalization, HTTP 422, preservation of records/tests/configuration and required new regression tests. Its search phrase `preserve title whitespace` can even point against trimming. The unchanged original request remains authoritative in all cases.

All six selections return exactly the same first three entries: `backend/scripts/verify.py`, `backend/src/app/__init__.py`, and `backend/src/app/background_jobs.py`. The relevant implementation, `backend/src/app/notes.py`, is present at position 17 of an untruncated 60-file inventory. Selected excerpts and hashes are identical across repetitions and versions. This suggests a possible position effect, but its cause is untested. It does not demonstrate that the model cannot select any file under any prompt.

The original prompt is 1,086 bytes; prepared prompts grow to 7,920 bytes in v1 and 7,954 in v2. Native runtime counters report 407/1,382 input tokens for v1 intent/selection and 261/1,472 for v2, with outputs 85/15 and 83/15 respectively. These are runtime-reported per-call counts, not a measurement of the complete retained CLI context. The same preparation seed is reused; identical outputs are not independent evidence of general reliability. All twelve native calls finish with schema-valid JSON; formatting did not establish useful selection.

## Hardware and privacy limits

The model actually loads and produces responses in seconds on this M1. No attempt fails with an observed timeout or explicit allocation error; its recorded failure is application acceptance. This supports distinguishing execution capability from useful agent behavior. It does not prove there was no memory pressure or that hardware never affects performance.

Per-attempt sampled runtime-tree RSS peaks range from **2.33–2.55 GiB**, including runtime processes and possible double-counted shared pages. This is not peak physical unified/GPU memory. System swap is also recorded, but cannot be causally attributed to this model. Other applications, temperature and OS caches are uncontrolled. The model is absent from `/api/ps` before each attempt; native preparation loads it before the CLI in prepared arms. These are not paired warm-only or fully cold-machine measurements. First-token latency and exact retained CLI context remain unobserved; CLI usage counters can aggregate multiple inference requests.

Inference targets the loopback runtime and no cloud fallback is enabled. The evaluator runs without network and accepts only synthetic workspaces. Existing **full-disk read and whole-CLI egress limitations remain unresolved**, along with ordinary Desktop background traffic. The preprocessor's bounded filesystem and HTTP checks do not upgrade the whole application to a verified strict-local/offline product. See [M1-EXPERIMENT.md](M1-EXPERIMENT.md).

The owned runtime is stopped, port 11445 is closed, and `forger-local-eval` is stopped: [cleanup evidence](evidence/cleanup-qwen06-2026-09-27.json). Verified assets remain available; other services and the default Docker context are unchanged.

## Reproduction and decision

Use the owned runtime launch procedure in [M1-EXPERIMENT.md](M1-EXPERIMENT.md), with its pinned assets and a freshly verified PID. Run software checks before timed inference. From Desktop, this runs v2 with new output paths; it never downloads a model or calls cloud:

```sh
env -u DOCKER_CONTEXT \
  DOCKER_HOST="unix://$HOME/.lima/forger-local-eval/sock/docker.sock" \
  TMPDIR=/private/tmp/forger-local-eval \
  node scripts/local-development/context-experiment.mjs \
  --lima-cli "$HOME/.local/opt/eigen-docker-runtime/bin/limactl" \
  --vm forger-local-eval --network-policy codex-workspace \
  --model qwen3:0.6b \
  --model-digest sha256:7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435 \
  --context-window 16384 --agent-profile compact-v1 \
  --cli "$HOME/Library/Application Support/forger-desktop/codex-cli/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex" \
  --evaluator-image sha256:de5bb77888ef8a6826ffa49ab9132d287c4e9e26a187c5a143213eeaa2e28406 \
  --endpoint http://127.0.0.1:11445 --runtime-pid VERIFIED_RUNTIME_PID \
  --staged-strategy staged-request-v2 \
  --direct-output NEW-direct.json --staged-output NEW-v2.json

node scripts/local-development/context-ablation.mjs \
  NEW-direct.json NEW-v2.json --staged-strategy staged-request-v2
```

Exit code 2 means completed task failures in this experiment; inspect report state and lifecycle. The comparison prints JSON to stdout and takes no `--output` option. For v1, explicitly select `staged-v1` in both commands. Neither rerun reproduces historical timings exactly, and current source fingerprints differ from the first experiment.

The [primary-source literature review](SMALL-MODEL-CONTEXT-RESEARCH.md) supports investigating retrieval and decomposition, with substantial caveats: trained small retrievers/compressors and larger coding models are not this unchanged 0.6B model. More calls alone do not establish a benefit.

**Decision:** retain the methods as disabled experimental controls; make no development recommendation and do not expand product installation/UI on these results. The next concrete experiment should use bounded deterministic code search to locate candidates, a smaller explicit edit contract, and application-test feedback during execution. It must first preserve the privacy and immutable-test boundaries, then compare against a fresh control. This is a proposed integration change, not demonstrated capability; broader/held-out tasks, Spanish instructions and useful autonomy remain unverified.
