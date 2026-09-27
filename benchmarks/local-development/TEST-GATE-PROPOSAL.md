# Proposed gate for tests contributed by the agent

Status: **proposed, not implemented**. Evaluator 0.2.0 requires the unchanged regression suites and independent API/browser acceptance. It permits additional tests but does not independently establish that the agent added a collected test or that a new regression test fails before a bug fix. A passing current result must not be described as proving either property.

## Observable contract

1. Compare the initial fixture inventory with the submitted source inventory. Identify new regular files in the permitted test locations (`backend/tests/test_*.py` and frontend `*.test.*` / `*.spec.*`). Preserve their paths and SHA-256 values. At least one added file is required, but file existence alone is insufficient.
2. Keep every original test and configuration protected. Run the existing suites with their existing coverage thresholds and add machine-readable framework reports. No dependency, test-discovery or coverage configuration is edited to satisfy this gate.
3. Attribute collected cases to the added files. Require at least one collected, executed, passing case from an added file; skipped, xfailed, empty or uncollected files do not qualify. All original regressions must still pass.
4. For `bug-01`, also prepare a separate fresh baseline using the exact same pinned fixture preparation. Copy only the identical newly added test files into that baseline, without the candidate's application-source changes. Run them with the original tests in the same immutable evaluator image.
5. The bug baseline must fail at least one newly added test through a functional assertion against the existing public contract. A collection/import error, missing new production symbol, timeout, infrastructure error, skip/xfail, or coverage-only failure does not establish a reproduced defect. Original baseline tests must still pass. The identical added test cases must pass on the submitted application.

This is a separate additional success gate, not a replacement for the independent acceptance evaluator. The model cannot satisfy it by weakening existing tests or removing a requirement. Bug regression tests should exercise the existing POST/PUT contract so that they can run on both states.

## Reuse and evidence

Reuse `prepareFixture`, inventory/protected-file checks, immutable staging, Docker isolation and the pinned image. Both application states receive the same test bytes at their original execution paths, mounted read-only. The baseline uses a separate temporary database and container; it cannot reuse candidate runtime artifacts. Application commands remain inside Docker.

Pytest can emit JUnit XML for the full original suite plus added files. Vitest can emit its machine-readable report in addition to its normal reporter. Report parsers must distinguish collected/executed case outcomes from command exit codes and coverage outcomes, validate expected report files and identify added cases by their source paths. The bug comparison matches those case identities across both states. No assertion counts are inferred from source text.

Store a `testContribution` result containing new-file hashes, collected/executed/passed case identities, baseline functional failures, original-suite outcomes and the image/evaluator pins. Parsing or attribution uncertainty blocks this additional gate rather than counting as success. Fixtures should cover empty/uncollected tests, skips, expected failures, collection errors, coverage-only failure, a test that passes both states, a real fail-before/pass-after test, changed test hashes and original-regression failures.

The existing evaluator does not certify resistance to deliberate report tampering by arbitrary malicious code sharing its container user. Read-only test files and external API/browser acceptance remain distinct controls. Adding framework reports does not remove that limitation.

Enabling this gate changes the evaluation protocol/version and requires fresh controls and results. Earlier records remain evidence under their original evaluator hash; they are not retroactively marked as satisfying the proposed gate.
