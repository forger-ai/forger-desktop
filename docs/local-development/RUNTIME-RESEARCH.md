# Local development runtime research

Research date: **2026-09-26**. This document records source inspection and the initial evaluation decision. It does not report model performance. The machine identified during the workspace audit is Apple M1, 8 CPU cores, and 8,589,934,592 bytes of unified memory. No candidate model runs or model-weight downloads form part of this research.

## Decision and evidence status

The first evaluation route uses the existing Forger Codex agent integration, Codex CLI **0.144.1**, and a separately installed Ollama server. Forger sends stateless Responses requests through a dedicated Codex custom provider. It does not add a second agent loop. The runtime and model must already exist; the experimental run path does not install them.

This is an integration decision, not a finding that Ollama is faster, safer, or more capable than every alternative. The present evidence supports a controlled experiment. No model is validated for application development, no automatic hardware recommendation is justified, and no completely offline or strict-isolation claim is established.

| Item | Evidence on the research date |
| --- | --- |
| Codex version | Repository pin and locally installed package both read `0.144.1`. |
| CLI interface | Installed binary `exec --help` accepts `--json`, `--oss`, `--local-provider`, `--ephemeral`, `--ignore-user-config`, and `--output-schema`. This is an interface check, not an inference test. |
| Local runtime protocol | Ollama documents stateless `/v1/responses`, streaming, and function tools. Responses support starts at `0.13.3`; this is a protocol floor, not a guarantee for every model. |
| Candidate identity | Public manifests and small config documents were fetched. Manifest SHA-256 values, weight-layer digests, declared sizes, and quantization are recorded in `models.json`. |
| Real model capability | Pending: no model was loaded and no Forger development fixture was solved. |
| Performance / memory | Pending: hardware identity is not a benchmark. |
| Strict privacy | Pending: loopback routing and network policy still require process-level verification. |

The protocol claims come from [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility). The executable path inspected is the Forger-owned `codex-cli/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` under Electron's local user-data directory. No authentication files were inspected.

## Why this route is the smallest useful experiment

| Runtime | Documented relevant features | Initial evaluation decision |
| --- | --- | --- |
| Ollama | macOS 14+; Apple M-series CPU/GPU execution; model metadata and lifecycle APIs; Responses streaming and function tools; documented Codex integration. | Chosen for the first route because the existing Codex loop can consume it and model identity can be checked before inference. No hosted endpoint is selected. |
| llama.cpp | Apple Silicon support through Metal/Accelerate; quantized GGUF; chat, Responses, JSON-schema sampling and tools; API-key authentication; loopback or UNIX-socket listeners. | Technically credible alternative. Keep outside the first implementation until the shared protocol/capability tests can compare it. Do not claim it lacks Responses support. |
| MLX / MLX-LM | Apple-oriented execution, quantization and streaming; MLX-LM includes a server and model-dependent tool parsing. Its documented memory-wiring optimization needs macOS 15+. | Defer a separate Python/server distribution path. No measured speed or memory advantage is assumed. |

Sources: [Ollama macOS requirements](https://docs.ollama.com/macos), [Ollama Codex integration](https://docs.ollama.com/integrations/codex), [llama.cpp project](https://github.com/ggml-org/llama.cpp), [llama.cpp server contract](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [llama.cpp function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md), [MLX-LM](https://github.com/ml-explore/mlx-lm), and [MLX-LM server](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py). All were inspected on 2026-09-26; moving-branch references are research snapshots and are not runtime pins.

Ollama **0.34.4** is the release observed during research and is the proposed reproducible evaluation version. The public release metadata lists `ollama-darwin.tgz`, 160,042,307 bytes, with SHA-256 `e9c8fddaab5f48f47f2c4ae3d23d0732f5182417125353faeed2188e34a22799`. Only release metadata was fetched: the archive was neither downloaded nor executed, and its signature/notarization was not verified. See [the versioned release](https://github.com/ollama/ollama/releases/tag/v0.34.4) and [release metadata](https://api.github.com/repos/ollama/ollama/releases/tags/v0.34.4). This proposal does not authorize automatic installation or updates.

## Codex 0.144.1 details that affect the integration

1. **Do not use `--oss` for the no-download evaluation path.** The pinned `exec` implementation invokes `ensure_oss_provider_ready` when that flag is enabled. The pinned Ollama implementation calls `pull_with_reporter` when the requested model is missing. Its code therefore has a download side effect, including for an explicit model argument. The default OSS model is `gpt-oss:20b`, which is not an 8 GB recommendation. Sources: [pinned exec implementation](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/exec/src/lib.rs) and [pinned Ollama setup](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/ollama/src/lib.rs).

2. **Use a distinct custom provider ID**, with an explicitly allowed loopback URL, `wire_api = "responses"`, `requires_openai_auth = false`, and `supports_websockets = false`. Codex 0.144.1 exposes these fields and only supports the Responses wire protocol. Do not attach cloud credentials. Bounded retries and an idle timeout belong to the run configuration. Source: [pinned provider definitions](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/model-provider-info/src/lib.rs). Current official documentation also describes [custom providers and OSS mode](https://developers.openai.com/codex/config-advanced).

3. **`--ignore-user-config` does not ignore project configuration.** In the pinned loader, it affects user config layers; loading project layers still proceeds when `cwd` exists. `--ignore-rules` affects execution-policy rules, not the complete config, hooks, plugins, or MCP setup. An isolated Codex home alone therefore does not establish an isolated run. The initial experiment needs controlled fixtures and a fail-closed policy for unexpected configuration, alongside explicit security settings. It must preserve required safety rules rather than disable them to make a run succeed. Source: [pinned config loader](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/config/src/loader/mod.rs).

4. **Context must be measured before making a support claim.** Ollama recommends at least 64k context for Codex. Smaller context trials are explicit experiments and can fail because Forger instructions, tool schemas, source files, and previous tool results do not fit. Changing Codex's context metadata does not by itself resize Ollama's actual context. Pin both sides, count with the candidate tokenizer, reserve generation space, and reject overflow rather than silently truncate requirements. Sources: [Codex integration guidance](https://docs.ollama.com/integrations/codex) and [Ollama context configuration](https://docs.ollama.com/api/openai-compatibility).

5. **A schema option is not demonstrated schema reliability.** The installed CLI exposes an output-schema argument and Ollama documents structured generation. Each runtime/model/protocol combination still needs a real acceptance test. Function-call arguments must be validated against the tool contract before execution. Source: [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs).

## Candidate pool and provenance

`models.json` contains three experimental candidates. These are deliberately small downloadable artifacts with documented tool support, rather than a claim that parameter count predicts agent quality. Qwen3 1.7B and 4B provide a related baseline with different resource footprints; Qwen3.5 2B adds another architecture/template combination. Their catalog order is not a recommendation rank. No claim is made that these are the newest or best available models.

| Ollama model | Format / quantization | Weight-layer bytes | Role in the experiment |
| --- | --- | ---: | --- |
| `qwen3:1.7b` | GGUF / Q4_K_M | 1,359,279,776 | Lower-download baseline; useful agent behavior remains unverified. |
| `qwen3:4b` | GGUF / Q4_K_M | 2,497,280,480 | Compare success and resource pressure against the related smaller artifact. |
| `qwen3.5:2b` | GGUF / Q8_0 | 2,741,180,928 | Test another tool parser/model architecture; the config declares Ollama `0.17.1` as its minimum. |

The sizes describe weights, not total memory. All also need context/cache memory, runtime allocations, Forger, the OS, browser, backend, build/test tools, and safety margin. Model identity comes from the full manifest digest; mutable tags only name the download source. The registry labels `qwen3:1.7b` with `model_type: 2.0B`, so the catalog retains its published name without deriving memory from that name. Sources: [1.7B package](https://ollama.com/library/qwen3:1.7b), [4B package](https://ollama.com/library/qwen3:4b), and [Qwen3.5 2B package](https://ollama.com/library/qwen3.5:2b).

The upstream Qwen repositories expose Apache-2.0 licenses. The catalog calls the model artifacts **open weights** and leaves an Open Source AI assessment unestablished: a permissive weight license alone does not prove availability of the complete training materials. For redistributing Apache-2.0 material, preserve the license, required attribution/NOTICE material, and notices of modifications; trademark rights are separate. The initial experiment does not redistribute weights. See the [Qwen3 license](https://huggingface.co/Qwen/Qwen3-4B/blob/1cfa9a7208912126459214e8b04321603b3df60c/LICENSE), [Qwen3.5 license](https://huggingface.co/Qwen/Qwen3.5-2B/blob/15852e8c16360a2fea060d615a32b45270f8a8fc/LICENSE), and [Ollama runtime license](https://github.com/ollama/ollama/blob/v0.34.4/LICENSE).

An observed upstream repository revision is not proof that Ollama converted that exact revision. `sourceRevision` is therefore `null` for that build provenance, while `upstreamRevisionObserved` records the independent source snapshot. Weight digests are registry declarations; verification of actual downloaded weight bytes is pending. Manifest hashes were calculated from successfully fetched manifest bytes. Nothing in this catalog is a performance result.

## Privacy and endpoint boundaries

Ollama's local API does not authenticate callers; a bearer value supplied to an OpenAI-compatible client is ignored. It binds loopback by default, but can forward a local request to a hosted model after sign-in. `OLLAMA_NO_CLOUD=1` must apply to the server process; setting it only on Codex cannot change an already running server. Sources: [authentication](https://docs.ollama.com/api/authentication), [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), and [FAQ](https://docs.ollama.com/faq).

For the experiment, verify the installed model's full digest and inspect `/api/show` and `/api/tags` before sending any prompt. Reject nonempty `remote_model` or `remote_host`; the versioned API types expose both fields. Reject unknown models, URL credentials, redirects and non-allowed hosts. Failure stays local and stops the run. Neither a successful preflight nor a loopback address protects against a malicious or concurrently modified local service. Source: [Ollama 0.34.4 API types](https://github.com/ollama/ollama/blob/v0.34.4/api/types.go).

A stricter distribution needs an owned runtime process, authenticated boundary or appropriately permissioned local transport, no unintended network exposure, and OS-level egress enforcement for the agent and descendants. A proxy authenticating only its front door does not protect an exposed unauthenticated backend. Repo config, hooks, MCP servers, compiler scripts, install scripts, and generated applications are independent egress paths. Telemetry, crash reports, exported logs, and indexing need the same review. These are requirements for the strict mode, not verified guarantees of the headless experiment.

Use synthetic fixtures for the first runs. Keep credentials out of inherited environments and context. Treat source files and tool results as untrusted instructions. Cloud comparison requires a separate, explicit action authorizing the provider and synthetic fixture payload. Local failures must never trigger a cloud retry.

## What to measure on the M1 with 8 GB

The first gate is a bounded capability run through Forger: receive an instruction, read a synthetic supported app fixture, make a patch, run the fixture's acceptance and regression checks, and stop within its tool/time budget. Include creation from the supported template, persistent CRUD, modification, a reproducible bug, and coordinated multi-file changes. Record template-based creation separately from creation from scratch. The harness, not the model's completion message, determines success.

For each artifact/configuration, record:

- Exact Forger commit, Codex/Ollama versions, manifest digest, tokenizer/chat-template identity, context/output limits, sampling/thinking settings, tool contracts, retry budget, and date.
- Total/available memory, memory pressure and swap before/during/after the run; peak memory across Ollama's runner, Codex and the app/build/test processes; acceleration actually selected; failures to allocate or recover. Process RSS alone does not describe unified-memory pressure.
- Model load time, first-token latency, prompt evaluation time, generation rate as secondary data, and time until a working app passes the checks. Separate initial download, cold model load, and warm execution.
- Passed/attempted tasks, autonomous versus assisted results, acceptance and regression outcomes, tool calls, retries, timeouts, rejected/invalid tool arguments, unwanted changes and loops.
- Cancellation latency and whether generation, child commands and resource use actually stop. The JS client documents stream cancellation, but this does not prove the Codex-to-Ollama path has stopped computation. Source: [Ollama JS cancellation](https://github.com/ollama/ollama-js#abort).
- Controlled egress observations for the main agent, runtime, descendants and fixture application; make expected external destinations unreachable and verify failure behavior. A UI-only request mock is insufficient.

Start with one loaded model and one active task. Increase context only within the model's supported limit and the measured memory budget. Capture failures as outcomes. Repeat a reserved subset, report the sample size and variability, and do not convert disk fit into an automatic recommendation. Native Ollama responses expose load/prompt/generation duration and count fields that can support a separate calibration capture; availability through the Codex Responses path still needs verification. Source: [generation metrics](https://docs.ollama.com/api/generate).

## Catalog maintenance and next evidence

1. Fetch only official release metadata/manifests, record the date and hash, and review changes. Never silently accept a changed tag digest.
2. Obtain explicit approval before downloading the runtime archive or model weights. Verify archive/weight hashes after download; retain provenance and license files.
3. Use a private evaluation runtime with explicit local-only server settings, rather than changing an existing user service. Verify actual backend/version and model capability metadata.
4. Run the capability gate and the benchmark fixtures through Forger. Keep failed attempts and raw machine-readable results.
5. Promote a configuration only when its predefined acceptance, regression, resource and privacy gates pass on the stated hardware. Keep unsupported hardware and empty evidence visibly pending.

Resume from the repository's live plan and benchmark instructions. This document and `models.json` are research inputs; they do not enable a model selector or declare a stable local mode.
# Follow-up findings from real M1 evaluation (2026-09-27 UTC)

The actual 8192-context Forger run logged an 8327-token prompt shortened to 4098 tokens and failed the template task with no tool calls or edits. Keep the failure; it does not distinguish model competence from inadequate context. A larger runtime context is a separate experiment, not a guaranteed remedy.

Inspection of the pinned Ollama 0.34.4 implementation confirms that the Responses conversion does not forward native `shift`, `truncate` or `options.num_ctx` controls. Its `truncation` field is accepted without establishing native overflow rejection. The runtime default can be set with `OLLAMA_CONTEXT_LENGTH`, but model parameters can override it. Observe `/api/ps.context_length` during execution. The absence of a warning does not prove that every context item was retained.

Namespaces are recursively converted into qualified function names and split back on output. Free-form custom tools have a different problem: grammar/format is not retained and custom call/history items are not implemented as the Codex free-form contract. Function support must not be generalized to that contract.

Primary sources, consulted 2026-09-27 UTC:

- [Responses input and conversion, v0.34.4](https://github.com/ollama/ollama/blob/v0.34.4/openai/responses.go).
- [Responses middleware, v0.34.4](https://github.com/ollama/ollama/blob/v0.34.4/middleware/openai.go).
- [Prompt construction, v0.34.4](https://github.com/ollama/ollama/blob/v0.34.4/server/prompt.go).
- [Tokenized context handling, v0.34.4](https://github.com/ollama/ollama/blob/v0.34.4/llm/llama_server.go).
- [Runtime/model option precedence, v0.34.4](https://github.com/ollama/ollama/blob/v0.34.4/server/routes.go).
- [Local context configuration](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size).

These are specific compatibility findings. They do not establish strict whole-product privacy or a validated model configuration.
# Agent configuration follow-up (2026-09-27)

The actual five-family Qwen3 1.7B run at a runtime-reported context of 16384 produces no accepted tasks, calls or edits. This does not isolate model quality: the initial adapter inherits Codex defaults for multi-agent tools and reasoning, and does not control temperature or seed. The generic runner supplies `effort: none`, but that field is not applied by the initial local adapter. Zero reasoning tokens in Ollama usage is not evidence that thinking was off.

Primary sources consulted on 2026-09-27:

- Codex 0.144.1 enables `features.multi_agent` by default; `features.multi_agent=false` is the current switch. The retired `multi_agent_mode` flag is not equivalent. [Pinned feature definitions](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/features/src/lib.rs#L1001).
- Codex serializes `reasoning.effort` only for a model that advertises reasoning support. An explicit non-thinking experiment needs the request verified, using `model_reasoning_effort="none"`, `model_supports_reasoning_summaries=true` and `model_reasoning_summary="none"`. [Pinned client](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/core/src/client.rs#L762), [configuration schema](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/core/config.schema.json#L5288).
- Ollama maps `reasoning.effort="none"` to disabled thinking. [Pinned conversion](https://github.com/ollama/ollama/blob/v0.34.4/openai/openai.go#L503).
- With no request temperature, Responses sets temperature 1.0. A model-file temperature alone does not control this route. This matches the observed runtime sampler logs; changing sampling requires a separate recorded experiment. [Pinned Responses conversion](https://github.com/ollama/ollama/blob/v0.34.4/openai/responses.go#L682).

These findings justify testing a smaller tool inventory and explicit reasoning policy separately. They do not establish that either change improves task success. Original failed configurations remain in the evidence. No result from a fake runtime is counted as a model capability.
