# Local shopping and consumed-history proof (A15 / A11)

Run on 2026-09-27 against the existing loopback Supabase stack through
`/Users/zero-suminc./.claude/goal-state/sasha-phase-15-codex/local-run.py`. Its endpoint guard
requires HTTP `localhost` or `127.0.0.1`. No production endpoint was used.
The tests used disposable or existing synthetic accounts; the browser's
`sasha-recipes-onboarding3@example.test` fixture was untouched.

## A15: generated shopping plan and saved edits

The existing real-database test in `tests/shopping/preview-local-db.test.ts`
previews and accepts a generated plan, marks dated purchase windows checked
with notes, replans the same period, and reads it back. This pass added **20
lines and changed one import** in that test. The added assertions pin
a canonical ingredient identity, create a checked and noted manual line,
verify both after replan and `getPeriod` reload, and verify that the second
authenticated owner sees no shopping lines. The original assertions still
cover checked purchase windows and notes, a larger-need reset, and retention
of an old checked plan line as manual.

The test creates two temporary authenticated owners before the RLS reads and
deletes both in `afterAll`; it deletes its target profile and preview rows.
`tests/recipe-catalog/local-integration.test.ts` separately uses the existing
synthetic `a`/`b` owners, creates a period, tests owner RLS and manual line
CAS/retry, and cleans that period and its lines. Those persistent synthetic
accounts are not deleted.

```text
COMMAND: set -o pipefail
/Users/zero-suminc./.claude/goal-state/sasha-phase-15-codex/local-run.py /Users/zero-suminc./projects/clients/Sasha/wt/foods-annotations mise exec -- pnpm exec vitest run tests/shopping/preview-local-db.test.ts tests/recipe-catalog/local-integration.test.ts tests/shopping/preserve.test.ts -t 'rejects tab A.s stale consumed write|accepts dated purchases and preserves a checked first week|owner RLS, revision CAS and retry keep manual|retains bought, pinned and noted rows' --maxWorkers=1 | tee /Users/zero-suminc./Documents/Codex/2026-09-26/hey/work/foods-annotations/a15-a11-local-proof.log
EXIT: 0
Test Files  3 passed (3)
Tests       4 passed | 21 skipped (25)

COMMAND: set -o pipefail
/Users/zero-suminc./.claude/goal-state/sasha-phase-15-codex/local-run.py /Users/zero-suminc./projects/clients/Sasha/wt/foods-annotations mise exec -- pnpm exec vitest run tests/shopping/preview-local-db.test.ts -t 'accepts dated purchases and preserves a checked first week' --maxWorkers=1 | tee /Users/zero-suminc./Documents/Codex/2026-09-26/hey/work/foods-annotations/a15-expanded-local-proof.log
EXIT: 0
Test Files  1 passed (1)
Tests       1 passed | 15 skipped (16)
```

The second command reran the expanded generated-plan case after the 20-line
test addition. The first command ran before that addition and also covered a separate manual/RLS case and
the pure `preserveEditedLines` pin-retention case. This is server/database
proof; it does not claim a browser-generated plan journey.

## A11: consumed history

The real-database `rejects tab A's stale consumed write after tab B accepts a
newer selection` case was among the four passing tests above. It rejects the
stale selection, saves an actual consumed snapshot on the current revision,
checks sync propagation, replays idempotently, and prevents stale sync from
resurrecting the consumed mark after undo. The Avoid-impact route case below
separately verifies that an eaten recipe selection is excluded from future
affected counts:

```text
COMMAND: set -o pipefail
mise exec -- pnpm exec vitest run tests/foods/avoid-impact-route.test.ts -t 'counts owner future instances per food and excludes consumed history' --maxWorkers=1 | tee /Users/zero-suminc./Documents/Codex/2026-09-26/hey/work/foods-annotations/a11-avoid-consumed-proof.log
EXIT: 0
Test Files  1 passed (1)
Tests       1 passed | 3 skipped (4)
```

The Avoid-impact test mocks authentication and its database responses. It is
not a real-database race between saving an Avoid and logging a meal. The
real-database consumed race and the mocked Avoid exclusion establish their
separate behavior, not an atomic cross-feature guarantee.

## Source snapshot and checks

SHA-256 when the expanded test and this receipt were verified:

| File | SHA-256 |
| --- | --- |
| `tests/shopping/preview-local-db.test.ts` | `4666ae238faa7050325c0d56cb4068977dc56a7c70585ac50ac54676dc0c590c` |
| `tests/recipe-catalog/local-integration.test.ts` | `871fc32df0836a40bd88704a1127ce37b96583f2f6ffc0881eb83df49958299f` |
| `tests/shopping/preserve.test.ts` | `7ebd5b8b6dcbea661abb7bb02957964f7c949b54a768e0a9afdb0a4737233610` |
| `tests/foods/avoid-impact-route.test.ts` | `f96ab1914cacc96bb1a25db8ff7b76e7c14ae02d9b68fadc79678999d7644659` |
| `lib/server/recipe-plan.ts` | `c8edb4dec2afeae1d210528536f9984356d0bf7f1c102094b7501a9d65457fd6` |
| `lib/shopping/repository.ts` | `ecf6a4bc9232d4af4c723484f400f89e6179c11b92e5b6820104580b41d96240` |
| `lib/shopping/preserve.ts` | `9c9e9db9a72565e91a19f6be52602a2f30b4d0c29d8384067d4b6a1f67ee40b2` |
| `app/api/foods/avoid-impact/route.ts` | `25204274d256c4692d2429dfaaad7996b3dec2c9193122624908ebffcc8ab4d5` |

`git diff --check -- tests/shopping/preview-local-db.test.ts` and
`mise exec -- pnpm exec eslint tests/shopping/preview-local-db.test.ts`
both exited 0. No implementation file was changed for this proof.
