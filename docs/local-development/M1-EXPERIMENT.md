# M1 evaluation environment

Observed on 2026-09-27 UTC (2026-09-26 in Santiago). This is an isolated developer experiment on an actual Apple M1 with 8 GB unified memory. It is not a supported installation or a strict offline product mode.

## Owned resources and reproducibility

The runtime archive, extracted binaries, model store, fresh home and logs are under `~/Library/Application Support/ForgerLocalEvaluation`. The directory is private to the user. Existing Ollama installations, Docker contexts, Lima instances, production services and credentials are unchanged. The experiment uses numeric loopback port 11445.

Ollama 0.34.4 archive size and SHA-256 match the catalog. macOS `codesign --verify --deep --strict` succeeds; the signing team is `3MU9H2V9Y9`. The Qwen3 1.7B and 4B registry manifests, configuration and all referenced layers are verified on disk by size and SHA-256. See [initial artifact verification](evidence/artifact-integrity-2026-09-27.json) and the offline `verify-artifacts.mjs` procedure below. Integrity does not establish agent competence.

The runtime starts with an empty inherited environment, a separate HOME/model store, `OLLAMA_NO_CLOUD=1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1` and `OLLAMA_KEEP_ALIVE=2m`. The first agent trial uses `OLLAMA_CONTEXT_LENGTH=8192`; the subsequent five-family runs use a restarted server with `OLLAMA_CONTEXT_LENGTH=16384`. Native calibration explicitly overrides context size for its own request; agent context metadata is not a runtime context control. Each agent result separately records `/api/ps` observations. The 8192 trial records prompt truncation and remains a failure in its own configuration.

The package parameter blob declares temperature 0.6, but the observed Responses runtime sampler logs temperature 1.0, top-k 20 and top-p 0.95. The initial adapter does not set an explicit sampling seed or temperature. It also does not apply the generic runner's `effort: none` field. Do not describe these agent runs as deterministic or as non-thinking inference. The native calibration explicitly requests temperature 0 and seed 42. Neither configuration is a quality recommendation.

Ollama 0.34.4 Responses does not expose a verified fail-closed context-overflow control through this adapter. A reported context allocation is not proof that every message was retained throughout a multi-turn task. See [protocol research](RUNTIME-RESEARCH.md).

The owned Lima instance is named `forger-local-eval`, uses the VZ backend, two CPUs, 3 GiB RAM and a 12 GiB sparse disk. Ubuntu's exact image URL/digest and runtime settings are in [provisioning evidence](evidence/provisioning-2026-09-27.json). Docker comes from Ubuntu's signed apt repository, without a downloaded shell installer. Only a synthetic scratch directory and evaluator files are shared, read-only. No existing VM is started or changed.

Use a per-command Docker endpoint; do not change the user's default context:

```sh
env -u DOCKER_CONTEXT \
  DOCKER_HOST="unix://$HOME/.lima/forger-local-eval/sock/docker.sock" \
  TMPDIR=/private/tmp/forger-local-eval \
  node scripts/local-development/controls.mjs \
    --evaluator-image sha256:de5bb77888ef8a6826ffa49ab9132d287c4e9e26a187c5a143213eeaa2e28406 \
    --output /absolute/path/to/new-controls.json
```

The evaluator is built from its Dockerfile using only the pinned public skeleton backend and frontend package manifest as build context. It does not send the Desktop repository to a daemon. Initial dependency resolution used FastAPI 0.141.1 and failed an existing skeleton route-inspection test. [FastAPI's 0.137 release notes](https://fastapi.tiangolo.com/release-notes/#01370) document the change from a flat route list to a tree (consulted 2026-09-27). The evaluator pins 0.136.3 to preserve that test's original contract. This is an evaluation dependency constraint, not a production compatibility claim. Both the failed environment and corrected dependency inventories remain recorded.

## Agent evaluation and artifact verification

With the owned binaries already verified, the foreground runtime command is:

```sh
env -i \
  HOME="$HOME/Library/Application Support/ForgerLocalEvaluation/home" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  OLLAMA_MODELS="$HOME/Library/Application Support/ForgerLocalEvaluation/models" \
  OLLAMA_HOST=127.0.0.1:11445 OLLAMA_NO_CLOUD=1 \
  OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 \
  OLLAMA_CONTEXT_LENGTH=16384 OLLAMA_KEEP_ALIVE=2m \
  /usr/bin/sandbox-exec \
    -p '(version 1)(allow default)(deny network*)(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))' \
    "$HOME/Library/Application Support/ForgerLocalEvaluation/runtime/0.34.4/ollama" serve
```

Check the listener first and do not replace an existing service using that port. Keep the observed process ID for sampling and shutdown. This profile permits loopback worker communication, including other loopback services; it is not a full offline guarantee. The command contains no credentials and does not install or pull anything.

After starting the owned runtime with the selected context, use the explicit existing Codex workspace sandbox. The serial runner starts and stops only the owned VM, records every attempt and stops that VM when it finishes. It does not stop the separately started runtime server. The CLI path below is the observed installation on this host; recheck its hash/version before reuse.

```sh
env -u DOCKER_CONTEXT \
  DOCKER_HOST="unix://$HOME/.lima/forger-local-eval/sock/docker.sock" \
  TMPDIR=/private/tmp/forger-local-eval \
  node scripts/local-development/m1-evaluation.mjs \
    --lima-cli "$HOME/.local/opt/eigen-docker-runtime/bin/limactl" \
    --vm forger-local-eval --network-policy codex-workspace \
    --runtime-pid CURRENT_OWNED_PID --endpoint http://127.0.0.1:11445 \
    --model qwen3:1.7b \
    --model-digest sha256:8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7 \
    --context-window 16384 \
    --cli "$HOME/Library/Application Support/forger-desktop/codex-cli/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex" \
    --evaluator-image sha256:de5bb77888ef8a6826ffa49ab9132d287c4e9e26a187c5a143213eeaa2e28406 \
    --suite all --output /absolute/path/to/new-agent-results.json
```

For 4B, replace the model and digest with `qwen3:4b` and `sha256:359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7`. Use a new output file for every invocation. Repeats use `--repeat`; development-only selection uses `--suite development`. The benchmark catalog retains 25 additional entries as planned, not executable coverage.

The recorded configuration experiment adds `--agent-profile PROFILE` and `--tasks bug-01`; `--repeat 3` repeats the selected task three times. Profiles are versioned experimental controls:

| Profile | Difference from the preceding profile |
| --- | --- |
| `baseline-v1` (default, including historical omitted values) | Original CLI settings; reasoning/sampling defaults remain uncontrolled |
| `single-agent-v1` | Sets `features.multi_agent=false` |
| `single-agent-no-thinking-v1` | Explicitly serializes reasoning effort `none`; does not change sampling |
| `compact-v1` | Replaces base instructions with the versioned Forger contract; preserves permission instructions, project instructions and the existing sandbox flags |

The compact contract is written by Forger into its ephemeral home with mode `0600`, never read from the evaluated repository. Its SHA-256 is recorded; the file is removed at cleanup. These settings are not public product preferences or validated optimizations. The [single-agent](evidence/cli-profile-single-agent-2026-09-27.json), [no-thinking](evidence/cli-profile-no-thinking-2026-09-27.json) and [compact](evidence/cli-profile-compact-2026-09-27.json) probes use the real CLI with synthetic inference and verify the actual request's tool inventory, reasoning field and compact contract. Their permission checks inspect invocation flags, not the full serialized permission text or filesystem-read enforcement. Each probe also verifies a real temporary file edit. Model task outcomes remain separate.

The total task budget is ten minutes with at most 60 observed tool calls; the local adapter also has a default 120-second inactivity cutoff. A runtime that spends longer than that without CLI output can fail before the total budget. This cutoff is part of the evaluated configuration, not a conclusion about intrinsic model quality.

Verify installed artifacts offline outside timed inference runs:

```sh
node scripts/local-development/verify-artifacts.mjs \
  --model qwen3:1.7b \
  --model-store "$HOME/Library/Application Support/ForgerLocalEvaluation/models" \
  --runtime-archive "$HOME/Library/Application Support/ForgerLocalEvaluation/archives/ollama-darwin-0.34.4.tgz" \
  --output /absolute/path/to/new-integrity.json
```

This command streams each digest without loading weights into memory, rejects symlink/unsafe paths and never overwrites a report. It verifies bytes against the catalog; it does not install, download, extract, or independently verify an Apple signature.

## Bounded calibration

Stop the owned VM before inference, and supply the currently running owned Ollama PID for process-tree sampling. Replace placeholders with observed values; PID reuse must not be assumed.

```sh
node scripts/local-development/calibrate-runtime.mjs \
  --endpoint http://127.0.0.1:11445 \
  --model qwen3:1.7b \
  --model-digest sha256:8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7 \
  --phase cold --budget-ms 60000 --context-window 2048 --max-tokens 64 \
  --runtime-pid CURRENT_OWNED_PID --output /absolute/path/to/new-cold.json
```

Repeat immediately with `--phase warm` and another output file. The script checks `/api/ps` instead of assuming residency. Cold means the model is not resident, not that OS/file caches have been flushed. Runtime-reported tokens are tokenizer-specific for this tiny synthetic prompt; they do not measure the agent's full context. Thinking output and visible response latency are separate. A completed HTTP stream is not proof that the requested answer was produced.

## Network boundary findings

The runtime process is started under an experimental Seatbelt profile that denies network operations except loopback bind/inbound/outbound traffic required by its workers. Loopback access can reach other local relays; no absolute isolation claim follows. Its endpoint remains trusted and locally unauthenticated; Forger's per-run gateway authenticates the CLI connection.

`network-canary.mjs` tests controlled TCP/UDP IPv4/IPv6 and Unix receivers through parent, child and grandchild processes. A restricted case counts as denied only after its unrestricted baseline reaches the receiver, the worker reports a permission error, and no nonce reaches the restricted receiver. Timeouts, refusal or sandbox initialization failure are not successes. The final profile permits TCP at a loopback port; it does not authenticate that port's owner. See [TCP canary evidence](evidence/network-canary-tcp-2026-09-27.json).

Wrapping the real Codex process with a second Seatbelt sandbox prevents its command tool from initializing the existing inner workspace sandbox on this Mac. The real synthetic tool probe fails with `sandbox_apply: Operation not permitted`; the same tool probe passes with the original Codex workspace sandbox. See [failed nested probe](evidence/cli-network-tcp-smoke-failure-2026-09-27.json) and [original workspace probe](evidence/cli-workspace-smoke-2026-09-27.json). The evaluator never resolves this by enabling unsafe command execution.

Synthetic model evaluations can explicitly use the original Codex workspace sandbox with tool-network access disabled, an isolated home/environment and the authenticated fixed-destination gateway. Whole-CLI egress remains unverified. This is distinct from strict local product readiness, background memory/telemetry isolation and completely disconnected operation.

The pinned Codex `workspace-write` policy restricts writes but grants full-disk reads. An isolated HOME/environment does not enforce the product's requirement to read external files only when shared. [Pinned policy implementation](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/protocol/src/protocol.rs#L1059), consulted 2026-09-27. These runs use controlled synthetic fixtures; the path must not be promoted to ordinary installed-app work until a restricted-read policy is implemented and tested with the actual command tools. This is a separate boundary from local inference and disabled tool-network access.

## Recovery and cleanup

The serial runner unloads only the selected model and starts/stops only the named evaluation VM. A successful unload response plus absence from `/api/ps` establishes runtime residency state; it does not measure when every GPU allocation is released. Task failures remain in the results.

Stop the experiment's own Ollama process after confirming its PID, stop `forger-local-eval`, and leave the product flag disabled to end activation. The downloaded assets remain available for repeat evaluation. Removing the designated evaluation directory and deleting the owned VM is a separate destructive cleanup; do not remove any existing user model store, VM or application workspace. No release or public rollout occurs here.
