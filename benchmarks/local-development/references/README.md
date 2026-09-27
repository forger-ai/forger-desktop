# Evaluator reference controls

These are small, reviewable solutions to the five existing synthetic benchmark tasks. They validate the evaluator before model results are interpreted. They are not produced by, sent to, or counted as outputs of a candidate model.

`scripts/local-development/references.mjs` applies them only to a fresh pinned fixture. CRUD and trimming references reuse the complete baseline notes source; search and archive have explicit source files here. The template recipe adds a router registration through an exact, guarded replacement. Shared React rendering is used only by the search/archive references. Original tests, configuration, manifests and commons remain byte-for-byte unchanged; new regression tests are added as separate files.

The archive reference adds a SQLite column in place, preserving rows and IDs. Its test starts with the old table schema, then verifies migration and repeated startup, archive and restore. The external evaluator independently seeds another old-schema database and checks the live API/browser flow. The search reference handles `%` and `_` as literal substring characters instead of SQL wildcard commands.

Run the control commands documented in the parent README. The initial fixture is the negative control, without any reference files. Positive controls must pass all seven groups, including the original coverage thresholds; negative controls must fail at the declared functional group after preceding groups pass. A failing reference or an unrelated negative failure blocks full baseline validation. Fix evaluator/reference defects without deleting tests, reducing coverage or changing task acceptance to fit an implementation.

Hashes in control reports identify the initial fixture, reference source/recipe, resulting state, evaluator, task and image. A reference/evaluator correction requires a new complete control report. Preserve earlier failures and do not reuse their successes across changed hashes. The holdout reference checks the evaluator only; do not use it to tune a candidate model, its prompt or its execution budget.
