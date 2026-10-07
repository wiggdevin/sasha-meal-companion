# Combined-suite coach repair

The one combined run in
`/Users/zero-suminc./Documents/Codex/2026-09-26/hey/work/foods-combined-full-test.log`
reported 46 failures
across 22 files. Twenty were in six coach test files. They had two fixture
contract mismatches; no coach implementation defect was established by these
failures.

The new `constraint_profiles.custom_rules` column is `jsonb not null default
'[]'::jsonb` in `20261203090000_custom_food_rules.sql`. `parseCustomRules`
intentionally rejects malformed or absent persisted data. Mocked stored rows
in `run-turn`, `provider-routing`, `latency-hops`, and `reply-check-turn` omitted
the column, so those tests stopped before reaching their stated behavior.
Their stored-row fixtures now supply `custom_rules: []`; the fail-closed parser
was unchanged.

The preference-action tests in `avoid-by-name` and `role-confirmation` still
expected the old membership payload's `note: undefined` or a copied prior
note. Membership now sends `note: null` and reserves an intent; note edits are
handled separately. The updated food-note migration retains the authoritative
stored note when membership changes. The tests now assert the current payload,
and the undo test also checks that its token captured the prior Eats note.
No client or server implementation was changed for this repair.

Focused rerun from the repository checkout:

```text
COMMAND: set -o pipefail
mise exec -- pnpm exec vitest run tests/coach/run-turn.test.ts tests/coach/provider-routing.test.ts tests/coach/latency-hops.test.ts tests/coach/reply-check-turn.test.ts tests/coach/avoid-by-name.test.ts tests/coach/recipes/role-confirmation.test.ts --maxWorkers=1 | tee /Users/zero-suminc./Documents/Codex/2026-09-26/hey/work/foods-annotations/coach-focused-repair.log
EXIT: 0
Test Files  6 passed (6)
Tests       108 passed (108)
```

`mise exec -- pnpm exec eslint` on those six files and `git diff --check` both
exited 0. This was a targeted rerun; the full suite was not repeated. The
other 26 combined-suite failures remain outside this coach repair's scope.
