# Qwen3 0.6B: bounded interpretation and progressive context

Protocol recorded before model task evaluation, 2026-09-27 UTC. Status: implementation and artifact preparation in progress. The user explicitly requests this candidate and current literature on preprocessing with small models. This experiment authorizes the approximately 523 MB Qwen3:0.6b download, not cloud inference, publication, or changes to private installed applications.

## Question and acceptance

Does using the same local model to interpret a request and select a small amount of real workspace context improve accepted application changes, compared with the existing compact agent receiving the request directly?

Only `desktop` changes. The existing provider service, Codex agent, Ollama runtime and immutable Docker acceptance are reused. No alternate agent engine, product UI, cloud fallback, training or model recommendation is introduced. All existing user changes and previous negative evidence remain intact.

- `direct-v1`: unchanged original task prompt and `compact-v1` agent profile.
- `staged-v1`: the same model performs two bounded native JSON calls: interpret the original request; select up to three files from a real, filtered inventory. Forger reads bounded excerpts and appends the derived hints as untrusted data. The original request remains verbatim and authoritative.
- Both use Qwen3:0.6b Q4_K_M, the same exact manifest, runtime, CLI, agent profile, context allocation, original task, initial fixture, permissions, acceptance and total task budget. The extra calls count against that budget and elapsed time. No retry or fallback hides preprocessing failures.
- The existing CLI can continue retrieving files during execution. This tests preparation before the agent, not a trained retrieval policy or arbitrary multi-step orchestration.

Primary outcome: all immutable acceptance and regression groups pass, with no protected-test changes or unwanted modifications. Intermediate JSON validity, tool calls, and file selection are diagnostic outcomes, not application success. More time is acceptable only if usefulness improves; no promised speedup.

Initial sample: `bug-01`, three trials per strategy, fresh supported-template fixture per attempt. Alternate strategy order across trial pairs. Retain all failed attempts. Freeze implementation before the six attempts. A second task and larger evaluation are gated on useful accepted changes; this narrow sample cannot validate a product or model generally. Existing promotion thresholds do not change.

## Implementation and ownership

1. Parent: protocol, isolated model provisioning/integrity, real M1 runs, final evidence and cleanup.
2. Context worker: behavior tests first, optional provider configuration, bounded native calls and workspace retrieval; privacy/error/cancellation tests. No UI or default change.
3. Harness worker: explicit CLI strategy, preserved original/effective prompt identities, strict ablation comparator, failure accounting and tests.
4. Research worker: primary-source literature synthesis with dates, applicability limits and an explicit distinction between trained compressors, QA tasks and software agents.

Tests must cover unchanged direct behavior; preservation of original requirements; existing-path-only selection; secret and symlink exclusion; cancellation/timeouts and redirect rejection; failed preprocessing never invoking the CLI; and retained diagnostic evidence. Run the existing relevant local/provider/cloud-regression suite, Electron build, typecheck and lint before measured trials.

## Measurements and limitations

Record exact source/build/harness/task/prompt/acceptance hashes, model/runtime/CLI versions, strategy, selected file identities, truncation, per-stage elapsed time and Ollama-reported token/load/evaluation counts. Bytes and lines are bounds, not tokenizer measurements. Record total time, accepted tasks, observed tool calls/edits, runtime-tree RSS and system swap. Physical peak unified memory, the complete CLI prompt and retained context remain unverified.

Native preparation requests use the same context allocation as the agent to avoid deliberately changing it between stages. Preparation is non-thinking, temperature 0.7, top-p 0.8, top-k 20, seed 42, maximum 256 generated tokens and 30 seconds per call. Agent sampling remains separately documented; deterministic results are not claimed. Whole-task budget remains 600 seconds/60 observed agent tools, with the existing 120-second CLI inactivity cutoff.

The model is absent from runtime residency before each task, but OS cache, foreground applications and thermal state are uncontrolled. VM and model inference are serialized. Build/test feedback still arrives after agent execution for both strategies; this known integration limitation is held constant, not fixed or attributed to the model by this experiment. Whole-CLI network and filesystem isolation limitations from M1-EXPERIMENT.md continue to apply; only synthetic fixtures are evaluated.

## Results

Pending actual runs. Literature findings, source changes and software tests are not real-model successes. The final report records whether the hypothesis is supported, unsupported, or unresolved by this small sample, and the exact state for resumption.
