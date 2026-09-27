# Experimental Forger local-development benchmark

This directory contains **30 catalogued cases: 5 implemented fixtures and 25 planned cases**. Implemented means the fixture, prompt, budgets and evaluator exist. That status alone does **not** establish that the evaluator has passed its real Docker controls or that a model has completed the task. Model recommendations require separate recorded evidence. Architecture, decisions and overall status live in [the local-development plan](../../docs/local-development/PLAN.md).

## What runs

| ID | Family | Initial state | Required result | Partition |
| --- | --- | --- | --- | --- |
| `template-01` | Create from supported template | Pinned Vite/FastAPI/SQLite skeleton | Local desk screen, working counter and API | Development |
| `crud-01` | Persistent CRUD | Notes screen with read-only backend | Create, update, delete, validation and restart persistence | Development |
| `modify-01` | Modify an existing app | Working synthetic notes CRUD | Case-insensitive API/UI search preserving existing behavior | Development |
| `bug-01` | Fix a testable defect | Notes title trimming is intentionally broken | Correct POST/PUT normalization and validation | Development |
| `multi-01` | Coordinated feature | Working notes CRUD; evaluator also seeds a pre-existing schema | Database/API/UI archive and restore without losing existing rows | Holdout |

All five use a **supported template**; none measures creation from scratch. The planned backlog contains a from-scratch case, but it has no runnable fixture. S/M/L/XL are provisional behavior-based bands, not token sizes. `tasks.json` keeps estimable task features separate from observed results. Token counts remain unknown until the exact model tokenizer and complete rendered agent context can be observed.

Each attempt starts from a fresh copy of the shipped public skeleton plus a versioned synthetic overlay. `skeleton-pin.json` fixes the skeleton/commons revisions and the SHA-256 of every copied file. A mismatch blocks the run. There is no download or automatic repinning. Real credentials, user applications, `.env`, installed environments, databases and previous build output are not copied.

Preparation materializes the 14 shared source files that the pinned skeleton's Docker Compose configuration mounts from `commons`. It verifies those mount declarations, copies their exact pinned contents into the execution paths, and protects both copies from agent edits. `fixturePreparation` records the preparation recipe hash, source/destination mappings, file hashes and prepared-state hash. The bundled skeleton itself is not modified. This step is necessary to reproduce the stack that actually runs, because its stored placeholder copies can differ from the mounted commons version.

The runner calls the existing compiled **`LlmProviderRunService`**, which starts the supported Codex agent tool loop with explicitly enabled local inference. It does not implement another agent. The first common protocol permits file inspection/edits and bounded shell tools, but does not grant Docker or network access to the agent. The evaluator performs app builds/tests **after** the agent finishes. Giving small models an approved test-feedback loop is a separate, unmeasured optimization; this protocol does not claim to evaluate that optimized flow.

## Commands

From `desktop`, after the normal Desktop dependencies are present:

```sh
npm run build:electron
node --test test/main/local-development-benchmark.test.mjs
node scripts/local-development/benchmark.mjs --list
node scripts/local-development/benchmark.mjs --check
```

The controlled Node tests use synthetic files, a fake CLI and a loopback HTTP fixture through the real compiled provider service. They are **harness/provider tests, not model benchmarks**. Opening the fixture port requires the execution environment to permit loopback listening. No model or cloud credentials are needed. Dockerized app commands never run on the host.

### Explicit evaluator preparation

The runner requires an **already installed image identified by its immutable `sha256:` image ID** and never pulls or builds one. The supplied Dockerfile is a preparation recipe; only recorded control runs establish whether its resulting image works. Building it installs Python/npm/browser packages and may download large base images; do this only after the person has authorized those downloads and a **local** Docker daemon is running.

```sh
docker build --pull=false -f benchmarks/local-development/evaluator/Dockerfile -t forger-local-evaluator:0.1 .
docker image inspect --format '{{.Id}}' forger-local-evaluator:0.1
```

Base images match the shipped stack. Dependency versions resolve once during explicit image preparation; the resulting image ID pins that environment for repeats. Rebuilding the tag can resolve newer dependencies and is a new environment, requiring a fresh recorded image ID and baseline validation. The evaluator records Python and frontend dependency inventories. The browser version is tied to the image ID. The runner rejects remote Docker TCP/SSH/cloud contexts before contacting their daemon; a local socket can still be a user-configured proxy, which this check cannot attest.

Before using candidate results to validate a recommendation, verify the prepared evaluator with the reviewable solutions in `references/` and the known failing initial fixtures. The control runner never invokes a model and refuses to count an unrelated build/infrastructure failure as the expected negative outcome. Reference application code and added tests preserve every original protected test/configuration file. A complete baseline requires five accepted references and five expected rejections under the same frozen evaluator/image.

```sh
node scripts/local-development/controls.mjs --evaluator-image sha256:EXACT_64_HEX_IMAGE_ID --tasks template-01 --output tmp/evaluator-template-controls.json
node scripts/local-development/controls.mjs --evaluator-image sha256:EXACT_64_HEX_IMAGE_ID --output tmp/evaluator-all-controls.json
```

`--kind reference` or `--kind initial` runs a diagnostic subset; it cannot set `allFiveFamiliesValidated=true`. The output file is written after each control, preserves detailed evaluation failures, and does not overwrite earlier evidence. A `passed` negative control means the application was rejected at its expected missing-requirement group, not that the initial application passed acceptance. The full baseline gate also requires the corresponding positive reference to pass. These records have `evidenceClass=evaluator_control` and `modelUsed=false`; they are not model-task results.

Reference-source preparation and protected-file preservation have Node tests. Real Docker execution status belongs to the resulting control JSON records; source preparation alone does not validate the image, browser, tests or applications. The initial delivery had no available Docker daemon and no evaluator image.

### Local attempt and repeat

Ollama, a model with the required reported capabilities and the Codex executable must already be installed. Use the exact local model name and digest, not an unpinned tag alone. The provider preflight verifies the locally reported digest/capabilities and records `/api/version`; it never pulls a missing model. Obtain these from the existing local runtime, following the procedure in the architecture documentation. Runtime reports establish identity/capability claims, not benchmark validation or authentication of that local service.

Replace the explicit placeholders before running:

```sh
node scripts/local-development/benchmark.mjs --run --model EXACT_LOCAL_MODEL --model-digest sha256:EXACT_64_HEX_DIGEST --context-window 4096 --cli /ABSOLUTE/PATH/TO/CODEX --evaluator-image sha256:EXACT_64_HEX_IMAGE_ID --tasks template-01 --repeat 1 --output tmp/local-template-run.json
node scripts/local-development/benchmark.mjs --run --model EXACT_LOCAL_MODEL --model-digest sha256:EXACT_64_HEX_DIGEST --context-window 4096 --cli /ABSOLUTE/PATH/TO/CODEX --evaluator-image sha256:EXACT_64_HEX_IMAGE_ID --suite development --repeat 3 --output tmp/local-development-repeats.json
```

`--endpoint` defaults to `http://127.0.0.1:11434`. `--suite holdout` selects `multi-01`; freeze candidate settings before executing holdout tasks, and keep their results out of configuration tuning. `--suite all` runs all five. Repeats use fresh app/database state, but **do not imply a cold model**. `--context-window` sets the agent context budget; the effective Ollama context/KV configuration is not established by that flag and remains separately unknown.

Output files use exclusive creation and never overwrite prior evidence. Exit code `2` means at least one selected task failed or was blocked; code `1` indicates an invocation/configuration error. A preflight blocker is reported separately from attempted tasks. Once the provider invocation starts, errors/timeouts stay in the failure denominator. Successful text from the agent is never sufficient.

### Serial evaluation on the M1

The Mac procedure separates model execution from the evaluator VM to avoid making both compete for the same unified memory. It controls only the explicitly prepared Lima instance named `forger-local-eval`; it does not create a VM, install dependencies, pull an image or touch another instance. Its Docker endpoint must be that instance's local Unix socket and `DOCKER_CONTEXT` must be unset. The VM must already mount the designated scratch directory and evaluator source read-only.

```sh
env -u DOCKER_CONTEXT TMPDIR=/private/tmp/forger-local-eval DOCKER_HOST="unix://$HOME/.lima/forger-local-eval/sock/docker.sock" node scripts/local-development/m1-evaluation.mjs --lima-cli /ABSOLUTE/PATH/limactl --vm forger-local-eval --network-policy codex-workspace --runtime-pid OLLAMA_PID --endpoint http://127.0.0.1:11445 --model EXACT_LOCAL_MODEL --model-digest sha256:EXACT_64_HEX_DIGEST --context-window 2048 --cli /ABSOLUTE/PATH/codex --evaluator-image sha256:EXACT_64_HEX_IMAGE_ID --tasks template-01 --repeat 1 --output tmp/m1-template-run.json
```

`--network-policy` is a required explicit choice. `codex-workspace` preserves the existing safe Codex workspace sandbox, isolated environment and local inference gateway. It is permitted here only for these synthetic fixtures and records `wholeCliEgressVerified=false`: it does not establish a strict whole-process network boundary. `outer-seatbelt` adds the experimental outer network policy; an actual macOS check found that it prevents the nested Codex sandbox from starting (`sandbox_apply` denied). It remains a diagnostic choice, not a verified usable policy. The runner never replaces the original workspace sandbox with an unsafe mode. A separately constrained Ollama server does not prove that every agent subprocess has the same network restriction.

Each task starts the owned VM for preflight, stops it before the agent, then observes model residency. After the agent it records `/api/ps`, requests model unload with `keep_alive: 0` and no prompt, waits at most 15 seconds for the request and residency check, starts the VM with a 120-second limit and rechecks image/CLI identity before the same immutable evaluation. Failure recovery restores the VM for the next preflight; final cleanup stops only the owned VM. Completed task results and failures are persisted after each attempt.

The optional runtime PID enables sampling during the agent; the result identifies sampled processes, available measurements and limitations. `/api/ps` supplies runtime-reported context and VRAM fields, not measured unified-memory consumption. Residency before/after is recorded; OS page caches remain uncontrolled. Agent timing excludes VM startup/shutdown. Evaluation timing includes unload, VM startup and revalidation, with each lifecycle interval also recorded separately. These reports use the distinct `m1-serial-v1` execution profile and cannot be silently pooled with ordinary runner results. Synthetic CLI failure diagnostics are bounded and redacted; private user tasks and raw private prompts are outside this procedure.

## Acceptance and isolation

Seven groups must explicitly complete: frontend build, backend compile, backend regressions, frontend regressions, runtime health, task API/persistence acceptance and browser acceptance. Reports count **completed groups**, not individual assertions or application test cases. Pytest/npm regression evidence currently records their exit outcome; JUnit per-test counts are not collected.

Evaluator `0.2.0` strengthens checks within the existing requirements: CRUD verifies normalized POST/PUT values and rejected PUTs without data mutation; archive and restore flags, list visibility, IDs and contents must survive separate backend restarts; search requires an observed successful API query while editing and deleting a filtered result with the query still active. These assertions change the evaluator hash and require fresh controls. Earlier results retain their original evaluator version and hash.

The instruction to contribute tests is not yet an independent success gate. The [test-contribution gate proposal](TEST-GATE-PROPOSAL.md) specifies collected/executed test evidence and fail-before/pass-after replay on the original bug fixture. It is proposed, not implemented; current results do not prove those properties merely because a test file exists.

Original tests, dependency files, manifest, commons and configuration are hashed before/after editing. New test hooks or configuration outside the allowlist fail the attempt. All supplied app sources, tests, configuration and shared code are then mounted **read-only** into the evaluator, including at their execution paths. The app root remains on the read-only image; backend/frontend are fixed mount points with separate writable build/cache/data space. Package contents remain read-only while Vite/Vitest caches and Python bytecode have writable locations. This prevents generated imports/build steps from rewriting the original test files inside the evaluator. Protocol tests check the mounts; dated control records establish their observed Docker behavior. Frontend regression tests receive no runtime API-URL override, so their original default-URL tests remain meaningful; builds and live acceptance retain the explicit loopback URL.

The evaluator has no host write mount, no Docker socket, no injected user secrets, no privileges, a non-root user, bounded processes/memory/time and `--network=none`. It starts backend and frontend services inside that container and drives the browser there. Browser attempts to contact non-loopback origins fail acceptance. Backend restart checks use an actual on-disk SQLite file. Agent-created `node_modules`, `.venv`, databases and output artifacts are excluded from the staged input. The harness removes only its disposable fixtures/containers.

These controls do not certify arbitrary malicious generated code: regression tests execute app code in-process, while separate HTTP/browser checks establish observable behavior. Container processes share a user ID and writable temporary space; generated code can replace links in the writable `node_modules` directory. The read-only mounts protect supplied files, but the evaluator is not a complete defense against deliberate test sabotage. They also do not prove the host agent, a compromised runtime, Docker daemon or operating system cannot transmit data. The local provider and subprocess network policy have separate tests and documented limits. This experimental developer path does not claim that the full Desktop experience is offline.

## Evidence and comparisons

JSON records include task/acceptance/initial-state/prompt hashes, fixture-preparation provenance, trial/partition/budgets, Forger revision and dirty state, hashes of source/configuration and compiled providers, harness hash, executable hash, evaluator image ID, runtime metadata, dates, detected hardware, elapsed times, observed tool event IDs, changed files, failures and intervention status. Hashing the supplied executable does not attest other files a wrapper executable may load.

Unknown TTFT, token throughput, complete file-retrieval count, internal model retries, peak runtime/unified memory, exact tokenizer context size, costs, load time and download duration are `null` with a reason. A JSONL message is not the first model token; free OS RAM is not available-for-model memory. The current runner is noninteractive and does not support assisted resumes. Any manually assisted experiment must be separately labeled and cannot be represented as one of its autonomous runs.

Run summaries keep failures, tool/time budget exhaustion and resource errors in attempted denominators. They report sample counts, mean/min/max and sample standard deviation; there is no relative “quality percentage.” Initial downloads and cold/resident model execution are distinct measurements. Load state is currently `uncontrolled`, so do not label repeat timing as cold/warm evidence.

```sh
node scripts/local-development/compare.mjs tmp/model-a.json tmp/model-b.json
node scripts/local-development/benchmark.mjs --cloud-plan --suite all --output tmp/cloud-comparison-plan.json
```

The comparator requires equal execution profiles, common-protocol/source/build/harness pins, task/acceptance/prompt/initial-state hashes, budgets/context budget, evaluator image and CLI checksum for attempted pairs. It reports global success rates and, separately, timing only for identical task/trial pairs solved by both. It rejects controlled fake-CLI results as model evidence. Hardware differences and uncontrolled load state are disclosed and require separate interpretation.

`--cloud-plan` emits the same synthetic prompts and acceptance plan locally. It sends nothing, asks for no credentials and does not implement cloud execution. A cloud comparison still needs an explicitly authorized run through the existing provider authentication mechanism, an exact model identity and equivalent tool/context policy. “Best validated configuration per model” remains pending because no configuration is validated yet.

## Resume and maintenance

1. Read the [plan](../../docs/local-development/PLAN.md) and current evidence. Confirm the exact skeleton pin before preparing anything.
2. Obtain authorization for runtime/model/evaluator downloads as needed; start only a local Docker daemon.
3. Build/record the evaluator image and validate passing/failing baseline fixtures. Resolve cache/mount/build compatibility failures without relaxing acceptance or coverage requirements.
4. Run one development task through the real model. Then evaluate the remaining development families, repeat a subset and use frozen settings on holdout.
5. Capture missing M1/8 GB resource/token/network measurements before making a capability or recommendation claim. Do not expand the 25 planned cases until the initial five demonstrate usefulness.

Repinning the skeleton or changing a fixture, prompt, acceptance rule, dependency image, tool policy or budget creates a new comparison condition. Review the changes, update the catalog/protocol version and record new hashes rather than rewriting previous results. Rollback is removing the experimental entry point or disabling its explicit option; no model/runtime installation, production setting, credential or public release is changed by this harness.
