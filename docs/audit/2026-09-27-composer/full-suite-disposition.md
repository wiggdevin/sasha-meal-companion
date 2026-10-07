# Once-only full-suite disposition

`mise exec -- pnpm test` ran once on the isolated voice worktree. Exit 1: 724 files passed, 67 skipped, 3 failed; 7,174 tests passed, 962 skipped, 3 failed. Raw output: `full-suite.log`.

The failures were triaged individually. The full suite was not repeated.

- `tests/ci/check-features.test.ts`: one subprocess assertion exceeded its default 5 s timeout in the full parallel run. The unchanged spec passed in the targeted serial rerun.
- `tests/foods/facet-thresholds.test.ts`: one offline report subprocess exceeded its default 5 s timeout in the full parallel run. The unchanged spec passed in the targeted serial rerun.
- `tests/coach/history-source-compose.test.tsx`: the 503 retry test expected an always-visible disabled Send button after the draft was cleared. The new empty composer does not promise that button. The updated test instead verifies that the textbox is disabled, attempted new text plus Enter cannot issue another post, and Try again resends the original text with the original message ID and null thread ID. The 4-test spec passed; its lint passed.

Command for timeout rerun: `mise exec -- pnpm exec vitest run tests/ci/check-features.test.ts tests/foods/facet-thresholds.test.ts --no-file-parallelism`. Exit 0, 20 tests across 2 files; output: `targeted-timeout-rerun.log`.

Repository `mise exec -- pnpm lint` passed after the review-acknowledgement source changes and voice documentation update. Documentation check: 156 rows, 0 problems. Output: `final-lint.log`.

The source then received a further narrow pointer-capture/render-lag correction; its focused checks are recorded separately in `implementation-checks.md`. This is a red initial full run with successful targeted follow-ups, not a claim that a second full run passed. The 962 skipped tests and real-device/browser limits remain unverified. Parent integration CI remains required.
