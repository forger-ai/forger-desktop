# Preparing requests and retrieving context with the same small model

Research date: **2026-09-27**. Scope: primary papers and author-maintained projects, including a targeted search of 2025–2026 work. This is a bibliographic record, not a systematic literature review, a claim about the latest leaderboard or the authoritative local measurement report. The completed Forger follow-up is recorded separately in [QWEN06-RESULTS.md](QWEN06-RESULTS.md).

**Literature conclusion:** a bounded trial of Qwen3-0.6B preparing its own retrieval requests is justified as an experiment. The reviewed sources do not establish that this unmodified model can understand an application change, select all necessary code, or complete it reliably. The original request remains authoritative; generated preparation is advisory, and repository facts come from actual file reads. Valid JSON establishes a format property, not semantic understanding. The subsequent two local experiments produce no accepted fixes; that observation limits the tested implementation and does not rewrite the papers' findings.

## Evidence state

| Category | State after the separate Forger experiments |
| --- | --- |
| Implemented | Two-call same-model preparation with real-file excerpts; a second version separates the explicit literal functional request from benchmark instructions. Neither implements adaptive retrieval in the agent loop. |
| Checked | Primary-source methods, evaluated tasks, training requirements and relevant limitations. |
| Measured separately | Verified approximately 523 MB Qwen3-0.6B Q4_K_M artifact; 12 new attempts of one bug task in two experiments. Each experiment has 0/3 direct and 0/3 prepared successes, with no tools or edits. Six preparations produce valid JSON but select the same three irrelevant paths. See the result report for conditions and raw records. |
| Proposed | Deterministic code search, a bounded editing contract and controlled application-test feedback, under a new protocol. These are not implemented or evaluated in this delivery. |
| Pending | Useful accepted edits, complete intent preservation and relevant context selection, generalization to unseen tasks, and the existing strict-privacy product gates. |

The current protocols are [v1](QWEN06-CONTEXT-EXPERIMENT.md) and [v2](QWEN06-REQUEST-V2-EXPERIMENT.md), with separate [v1 comparison](evidence/m1-qwen06-context-ablation-2026-09-27.json) and [v2 comparison](evidence/m1-qwen06-v2-context-ablation-2026-09-27.json) records. V2 identifies the broad functional goal but remains incomplete; it provides no accepted edit or improved relevant-file selection. Different software versions prevent a formal controlled cross-version comparison. Earlier Forger measurements remain in [M1-RESULTS.md](M1-RESULTS.md). None of these results or environment limitations is replaced by claims from papers. This document does not certify any privacy guarantee or model recommendation.

## What the literature supports

Publication dates below describe the cited paper version, not the date a search engine indexed it. Every source was consulted on **2026-09-27**. Numerical results are the authors' measurements under their own conditions, never measurements of Forger or this M1.

### Query rewriting: useful evidence, different training and reader

[Query Rewriting for Retrieval-Augmented Large Language Models](https://aclanthology.org/2023.emnlp-main.322.pdf), EMNLP, December 2023, evaluates both prompted rewriting and a **T5-large 770M rewriter trained with supervised warm-up and reinforcement learning**. Readers include ChatGPT and Vicuna-13B. In Table 2, HotpotQA exact match changes from 30.47 for retrieve-then-read to 32.80 for the prompted LLM rewriter and 34.38 for the trained rewriter. These are QA results; the small rewriter is not also the small coding agent. The paper reports exceptions and weaker distilled performance in some settings. It supports testing better search queries, not assuming that an extra pass by untrained 0.6B improves the user's specification.

### Interleaved retrieval: an unusually relevant small-model result

[IRCoT](https://aclanthology.org/2023.acl-long.557.pdf), ACL, July 2023, alternates retrieval and intermediate generation without additional training. Its scaling study includes Flan-T5-base and Flan-T5-large as well as larger models. Retrieval improves even with the smallest variant, while **final QA does not improve for that smallest variant**. The authors omit IIRC from that scaling study because smaller models cannot reliably identify required Wikipedia titles. The method also adds model calls and accumulated context. This is evidence for progressive retrieval in multi-hop QA, with explicit limits; it is not a software-editing benchmark. Figures 8–9 and the limitations section distinguish retrieval quality from final task success. The paper inconsistently rounds its smallest model as 0.2B/0.3B; that discrepancy is immaterial to the finding and must not become an exact hardware estimate.

### Compression: specialized learned components, not free summarization

[RECOMP](https://arxiv.org/abs/2310.04408), first submitted October 6, 2023, trains extractive and abstractive compressors for downstream language-modeling and QA performance. It can return an empty augmentation for unhelpful documents. Its reported compression down to 6% of the input is an experimental result for those trained components, not an expected reduction for Forger. An abstractive summary made by unchanged Qwen3-0.6B is a different method.

[LLMLingua-2](https://arxiv.org/abs/2403.12968v2), revised August 12, 2024, learns token selection with transformer encoders such as XLM-RoBERTa-large and mBERT. It evaluates meeting/text understanding, reasoning and long-context benchmarks. Its reported speedups concern that compressor pipeline and its tested readers. This does not validate arbitrary token deletion in source code, patches, schemas or acceptance criteria. Even extractive compression can drop a negation, dependency or condition. The [official implementation](https://github.com/microsoft/LLMLingua) adds another learned component; integrating it would change the same-model experiment and require a separate resource/effectiveness comparison.

### Software work: use a constrained workflow and independent validation

[Agentless](https://arxiv.org/html/2407.01489v2), revised October 29, 2024, uses localization, repair and patch validation instead of unrestricted model-directed planning. It progressively narrows repository context and uses regression/reproduction tests to select patches. Its reported **96/300 resolved SWE-bench Lite issues (32%) use GPT-4o**, with multiple candidate patches and other components. This is relevant software evidence for a fixed workflow, but it establishes neither 0.6B competence nor full application creation. Forger can test bounded localization and patches without importing the paper's model, embedding services, sampling budget or historical leaderboard claims. Author project: [OpenAutoCoder/Agentless](https://github.com/OpenAutoCoder/Agentless).

### 2025–2026 check: small retrieval models still require specific evidence

[Think Before You Retrieve / Orion](https://arxiv.org/html/2511.07581v1), November 10, 2025, studies iterative retrieval with **350M–1.2B** models. Its method includes synthetic training trajectories, supervised fine-tuning, reinforcement learning and inference-time beam search. Reported retrieval gains show that small models can learn search strategies; they do not validate those strategies in an unchanged general-purpose 0.6B model. The task is retrieval, not repairing or running an application. Training and search branching also have costs absent from a two-call preparation trial.

[Recursive Language Models](https://arxiv.org/html/2512.24601v3), first submitted December 31, 2025 and revised May 11, 2026, provides a recent decomposition/context-management comparison. It keeps context in an external environment and permits programmatic inspection and recursive model calls. The GPT-5 experiments use GPT-5-mini for subcalls; **RLM-Qwen3-8B is fine-tuned on 1,000 filtered trajectories**. The study includes code QA, which is not patch correctness or app acceptance. It also documents expensive/unsuccessful trajectories and substantial variation in subcall behavior. The general idea can reuse a model, but these experiments do not establish untrained Qwen3-0.6B performance. Do not add recursive agents or an unrestricted REPL to this trial. Author project: [alexzhang13/rlm](https://github.com/alexzhang13/rlm).

The recent search also considered small-model retrieval and software-agent training papers. No reviewed source supplies a controlled result for the exact combination **untrained Qwen3-0.6B + same-model intent/file preparation + Forger/Codex application edits**. This is a statement about this review, not proof that no such research exists. Newer publication dates do not increase applicability by themselves.

## Bounded preparation contract

The following records the research-derived design constraints. The frozen protocols and actual implementation define the narrower contracts that were evaluated; this list does not extend their guarantees.

1. Retain the original request byte-for-byte, including prohibitions, edge cases and acceptance criteria. Store its hash. Never replace it with the generated intent.
2. Invoke the **same pinned Qwen3-0.6B model** sequentially for two small outputs: a tentative intent description and candidate file identifiers. No second model, remote embeddings, training or autonomous subagents are part of this treatment.
3. Give file selection a deterministic, bounded inventory of actual eligible files. Accept only identifiers from that inventory. Generated paths, symbols and descriptions are hypotheses until checked against the repository. A schema validator cannot determine whether the selected files are sufficient or the intent is faithful.
4. Build context excerpts by reading selected real files within the fixture workspace. Preserve source identity, line numbering and content hashes. Do not accept model-authored snippets or summaries as file contents. Filter sensitive names and obvious inline credentials, exclude metadata and unshared paths, and reject traversal, symlink escapes and oversized input. These filters are heuristic, not proof that source contains no secrets. Repository text remains untrusted data; the existing CLI's broader read permissions remain a separate unresolved boundary.
5. Mark preparation as advisory when adding it beside the original request. Preserve existing tool, permission, network and acceptance controls. Do not let preparation add requirements, weaken tests, authorize commands or activate cloud fallback.
6. Bound calls, generation, input, selected files, excerpt size and elapsed time before running. The implemented policy records invalid output as a failed attempt, without fallback or retries. Do not retry until a convenient result appears or omit failed preparations from the denominator.

This procedure can reduce navigation work or focus attention. It can also misidentify intent, hide an essential dependency, consume the task budget, or anchor the agent on a wrong plan. Reusing the same weights does not provide an independent verifier. Successive passes can reinforce the same error. More calls can increase total prompt processing even when the final context is shorter; context retained by the runtime must be observed rather than inferred from configured limits.

For code, the first experiment favors exact source excerpts over lossy semantic compression. A later progressive-retrieval variant can request a missing file/function after inspecting evidence, with explicit limits on rounds and duplicate requests. Retrieved facts and unresolved questions stay separate. That variant needs its own comparison and must not be retroactively described as part of the initial two-step trial.

## Initial A/B design and completed follow-up

The initial pilot uses **one bug task, three repetitions per arm**. It is a feasibility probe with six attempts and one distinct task, not a six-task benchmark or a general model-quality estimate. The separately frozen v2 follow-up repeats that sample structure after isolating the literal functional request. Both pilots are complete; their 12 attempts still represent only one distinct task.

| Arm | Preparation | Subsequent execution |
| --- | --- | --- |
| A — direct | No model preparation. Original request and the frozen baseline context policy. | Existing compact Codex agent profile with Qwen3-0.6B. |
| B — prepared | Same 0.6B produces intent and file selection; validated real context is added alongside the unchanged original request. | Identical compact Codex profile, permissions, tools and app acceptance criteria. |

This comparison estimates the effect of the **entire preparation bundle**, including its extra calls and selected context. It does not isolate query rewriting, decomposition, file retrieval or semantic understanding. If B provides a useful signal, an additional ablation with identical retrieved excerpts in both arms can separate context selection from preparation wording. Iterative retrieval requires a later A/B with a fixed, predeclared round limit.

Before execution, freeze the model artifact digest, runtime and CLI versions, repository/fixture hashes, preparation prompts/schema, compact agent contract, evaluator version, context/generation limits, reasoning and sampling settings. Both arms receive the same total wall-clock/tool budget; preparation consumes B's budget. Record model calls and generated/input tokens separately. If the implemented experiment instead grants B extra time, report that difference and avoid claiming equal-budget superiority.

Use clean copies of the same failing fixture. Confirm the initial failure with the independent evaluator and keep protected tests unchanged. Pair trials by fixture and settings, counterbalance order where possible, and identify cold versus resident-model runs. Record VM lifecycle, other host activity and context/cache limitations. Repetitions remain in the report even when they fail during preparation, inference or evaluation.

Primary outcome is autonomous application acceptance, including required regression checks. Record assisted success separately. Also capture:

- Preparation schema validity, out-of-inventory file requests, original-intent contradictions/omissions and any missing required dependencies discovered during evaluation. Schema validity and semantic fidelity remain separate fields; unknown fidelity is not a pass.
- End-to-end time from the first preparation/agent call until independent acceptance, plus preparation, agent, evaluator and lifecycle times separately. Failed attempts have failure duration, not time to a working solution.
- Input tokens under the model's tokenizer, runtime-retained context when observable, output tokens, time to first token, model/tool calls, retries, duplicate requests and timeouts. Token counts are workload measurements, not difficulty or quality scores.
- Sampled runtime/process memory and system pressure/swap with the existing monitor's limits, unintended file changes, new regressions and protocol failures. Reusing one model does not imply equal peak resource usage.

Inspect semantic fidelity without using another LLM as the sole judge. For synthetic fixtures, maintain reviewed requirement IDs and permitted source references independently from the generated preparation. Protected acceptance tests check behavior; a reviewed requirement-to-output audit checks whether preparation omitted or changed intent. Human review after a run is evaluation, while guidance that changes the agent's execution is intervention and disqualifies an autonomous-success claim.

Do not tune prompts between the three counted repetitions. New settings create a new named experiment; previous failures remain. An observed benefit on one repeatedly inspected bug justifies a broader test, not a recommendation. Reserve unseen fixtures across CRUD, existing-app changes and coordinated multi-file work for the next evaluation. Preserve the broader promotion gates and privacy constraints already recorded in this repository.

## Decision rules and next step

Keep this feature experimental until evidence shows that its complete cost buys useful application outcomes. Faster text generation, valid JSON, plausible intent, retrieved files or a correctly formatted patch are intermediate observations. None substitutes for compilation, startup, persistence, acceptance and regression checks required by the task.

If both arms fail, first classify the failure: preparation, missing context, unavailable tool/environment, malformed tool call, incorrect patch, timeout or acceptance failure. The literature does not justify adding more planning or recursion automatically. A narrower fixed workflow may be worth a separate trial, while unavailable test feedback or sandbox limits require their own integration work and clear reporting.

Both six-attempt pilots are complete and their failures remain in the [result report](QWEN06-RESULTS.md). The next proposed experiment uses deterministic source-code search, a bounded editing contract and controlled test feedback. It requires a separate implementation, frozen protocol and measurement; the literature does not establish that it improves this model on this host. This bibliographic record is not a claim that the proposed next workflow exists or works.
