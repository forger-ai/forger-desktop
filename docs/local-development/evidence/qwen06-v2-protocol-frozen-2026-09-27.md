# Qwen3 0.6B: separate the functional request before preparation

Protocol recorded on 2026-09-27 UTC after the first six-attempt experiment finishes and before implementing or evaluating this follow-up. This is a new experiment, not a revision of previous observations.

## Observed problem and hypothesis

The frozen direct/staged-v1 experiment produces zero accepted fixes in both arms (0/3 each), with zero observed tools or edits. All three staged preparations return valid JSON but identify the goal as `Synthetic Forger benchmark`, derive administrative search terms and select the first three inventory entries instead of the note implementation. The original prompt includes platform/evaluation instructions before the user's functional request. These are exact observations from [the first comparison](evidence/m1-qwen06-context-ablation-2026-09-27.json), not a general model-quality conclusion.

Hypothesis: giving the interpreter the functional request as an explicit, separate input avoids that administrative framing and improves context selection and, potentially, accepted edits. This is a targeted integration correction; it is not model training, a new agent engine or a claim that the model understands all requests.

## Fixed intervention

- Preserve `direct-v1` and `staged-v1`. Add opt-in `staged-request-v2`.
- The caller supplies `localContextRequest` verbatim from the benchmark task's public instruction. Forger validates that it is nonempty and is a literal substring of the full original prompt. No last-paragraph heuristic, hidden relevant-file labels, reference patch or acceptance implementation supplies its content.
- The intention call sees only that functional request. File selection sees the functional request, tentative interpretation and the same bounded inventory. Neither preparation stage receives platform/evaluation boilerplate as if it were user intent.
- The final CLI still receives the complete original prompt, all original restrictions and advisory real-file excerpts. The extra field cannot grant permissions or change requirements. The direct arm receives the same field, but does not make preparation calls or change its inference prompt.
- Keep two native calls, identical model, settings, context allocation, caps, source filtering, excerpts, tools, compact CLI profile, permissions and application acceptance. Do not add lexical ranking, more retries, test feedback or a patch generator to this comparison.

## Sample and decision rules

Repeat `bug-01` three times per arm (direct versus staged-request-v2), alternating D/S, S/D, D/S with fresh fixtures. Freeze and hash the revised software before these six trials. Runtime identity, fixture, original prompt, functional request, protected acceptance and budgets must match within this experiment. Source fingerprints differ from v1; compare v1/v2 descriptively only, never as a formally controlled cross-version pair.

Primary success still requires all existing independent application checks. Record intent and file selection separately, including a manual post-run semantic audit. Passing a JSON schema is not passing that audit. Preserve every failed attempt; do not adjust prompts during the repetitions. A useful preparation with no accepted fix does not establish autonomous development or product readiness. Broader tasks and product expansion remain gated.

Original limitations remain: one repeatedly inspected task, English synthetic instructions, no in-loop build/test feedback, uncontrolled foreground applications/OS caches/thermal conditions, sampled RSS rather than peak physical unified memory, and unresolved whole-CLI strict privacy boundaries.

## Results

Pending actual v2 runs. Previous evidence remains unchanged. The next step after this bounded follow-up is chosen from its recorded failures rather than automatically adding more planning stages.
