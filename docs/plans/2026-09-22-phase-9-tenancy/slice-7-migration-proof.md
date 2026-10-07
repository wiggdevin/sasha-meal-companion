# Slice 7 — Migration proof tooling and the proof on `p9-tenancy`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the proof tooling, and prove on a restore of production what M1 alone can prove: M1 and the seed change no resolved day for the production code, every seeded option renders back to its authored meal, row counts are exact, and the M1 rollback drills behave. The comparison with the resolver code (Sasha's days identical under slice 6) is slice 6's gate.

**Architecture:** Four scripts under `scripts/p9/`: row counts per owner per table (SQL), a canonical `ResolvedDay` snapshot that can run against any code root (so the "before" runs from a worktree at the base commit), a seed runner, and a diff. The proof is a runbook executed on `p9-tenancy` only.

**Tech Stack:** `tsx` scripts, `psql`, Supabase JS (service role against the branch only), Node `git worktree`.

**Spec:** `docs/specs/phase-9-tenancy-blank-slate.md` 2.7 (proof steps 1–6), Slices item 7.
The M2 part of spec 2.7 steps 3 and 6 moves to slice 8 (audit plan r3 finding 7). **The final
comparison with the resolver code (spec 2.7 step 3's `after.json`) moves to slice 6's gate** (audit
plan r5 finding 6), because slice 6 is merged after this slice. This slice depends on slices 3
(#247 catalog) and 4 only, and proves only what M1 alone can prove.

**Branch:** `feat/p9-migration-proof`. One PR (scripts + the proof output), unmerged.

## Global Constraints

See `README.md`. Every script refuses a target whose **project ref** is production's fixed ref,
`fivatgdpuenszxxnijpc` (the same constant as `scripts/db-branch.sh:12` `PROJECT_REF`; audit plan
r5 finding 5). The scripts import it from one module, `scripts/p9/production-ref.ts`, which a test
compares with the `PROJECT_REF=` line of `scripts/db-branch.sh`. No environment file
(`.env.local`, `NEXT_PUBLIC_SUPABASE_URL`) takes part in the decision. The ref is read from the
target URL's host (`https://<ref>.supabase.co`) or from `--project-ref`; a target whose ref cannot
be read is refused (fail closed) — **with one exception (audit plan r4 finding 7):** `row-counts.ts --read-only-production`
may read production. In that mode it sends only the one generated `select` statement, inside
`begin transaction read only; … ; rollback;`, through the Management API query endpoint (the
same endpoint `scripts/apply-migrations.py` uses), prints counts only, and refuses any other
flag. Read-only production SQL is allowed by the contract. No other script has this mode. **Account data is never committed (audit plan r13 finding 3).** Snapshots, row counts per owner,
the M2 inventory and every other output that carries account data are written to
`~/Backups/supabase/p9-proof/<run-id>/` with file mode `600` (directory `700`), and the writer keeps
only the last 3 run directories (house keep-last-N pattern, `~/bin/rise-db-backup.sh`). Only a
redacted summary goes into the repository and the PR: `docs/proof/p9/<run-id>.json` with, per
output, its SHA-256, the snapshot key count, the number of differences (0 to pass), the provenance
(code root commit, resolved module paths) and table-level row counts **without** owner ids. A test
(`tests/p9/no-account-data.test.ts`) fails if any file under `docs/proof/` contains a UUID, an
e-mail address, a date-keyed snapshot or a macro value.

## Current code (verified at `1d5790d`)

- `scripts/backup.sh`, `scripts/restore-to-branch.sh` (`<dump> --confirm <branch-ref>`), `scripts/db-branch.sh` (`create <name>`, `env`).
- `lib/resolve.ts:168` `resolveDay(store, date, waterCups)`; `lib/server/day-context.ts:176` `serverStoreFor(admin, userId, date)`.
- Fixture and writers from slice 4.

## File structure

Create: `scripts/p9/row-counts.sql`, `scripts/p9/row-counts.ts` (runs the SQL, prints sorted
`table|owner|count`), `scripts/p9/resolve-snapshot.ts` (`--user <id> --target <url> --code-root <path> --out <file>`),
`scripts/p9/seed.ts` (`--target <url> --user <id> [--backfill <id,…>]`),
`scripts/p9/diff-snapshots.ts` (`<before> <after>`),
`scripts/p9/meal-roundtrip.ts`, `tests/p9/snapshot-canonical.test.ts`, `tests/p9/diff.test.ts`,
`tests/p9/target-guard.test.ts`.

## Interfaces

```ts
export function canonicalDay(day: ResolvedDay): string;            // stable key order, numbers fixed to 3 dp
export function snapshotDates(firstOpenedAt: string, today: string, planDayDates: string[]): string[]; // first_opened_at … today+60 ∪ plan_days dates
export const PRODUCTION_REF = "fivatgdpuenszxxnijpc";                // scripts/p9/production-ref.ts
export function refuseProduction(target: string, opts?: { readOnlyProduction?: boolean }): void;
  // target = URL or project ref; throws when its ref is PRODUCTION_REF (unless readOnlyProduction) or cannot be read
export function rowCountSql(tables: OwnedTable[]): string;           // uses the owner chain; see Task 4
export function readOnlyWrap(sql: string): string;                   // "begin transaction read only; …; rollback;"
export function diffSnapshots(before: Record<string, string>, after: Record<string, string>): string[];
  // "<key> <path>" for every difference; no allow-list (audit plan r10: exact gate)
```

---

### Task 1: Canonical snapshot and date range (no DB)

**Every field is compared.** `canonicalDay` requires the full field set of `main`'s `ResolvedDay`
(`lib/types.ts:243-269`): `date`, `dayType`, `isFloorDay`, `targets`, `slots[]` (each: `slot`,
`time`, `label`, `meal`, `components`, `macros`, `eaten`, `eatenAt`, `note`), `extras`, `consumed`,
`waterCups`, `gut`, `weightLb` — a missing key is written as `null`, never dropped. Fields that
slice 6 adds (`templateKey`, `category`) are not in `main`'s set; the slice 6 gate checks them
separately: `templateKey === before.dayType` and `category === (before.dayType === "rest" ? "rest"
: "training")` for every key.
- [ ] **Step 1: Failing tests** (`tests/p9/snapshot-canonical.test.ts`): `canonicalDay` gives the same string for two objects with keys in different order; `0.1 + 0.2` prints as `0.300`; `snapshotDates("2026-01-01T09:00:00Z", "2026-01-03", ["2025-12-30"])` returns `2025-12-30`, `2026-01-01` … `2026-03-04` (today + 60), sorted and unique. Each date is expanded ×2 (Floor Day off and on) and × each stored swap in the runner, not here.
- [ ] **Step 2:** `pnpm exec vitest run tests/p9/snapshot-canonical.test.ts` — FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit.

### Task 2: Diff with an allow-list (no DB)

**Exact (audit plan r10).** The diff compares the canonical JSON of each key path by path and
reports every difference as `"<key> <path>"`; there is no allow-list, so a changed day always fails.
- [ ] **Step 1: Failing tests** (`tests/p9/diff.test.ts`): identical maps → `[]`; one changed meal
  → `["2026-02-03|floor=on slots[meal-2].meal.id"]`; a changed `targets.protein` → reported; a key
  missing in `after` → `missing:<key>`; a key only in `after` → `extra:<key>`; the CLI has no
  `--allow` flag (passing one is an error).
- [ ] **Steps 2–5.**

### Task 3: Production guard (no DB)

- [ ] **Step 1: Failing tests** (`tests/p9/target-guard.test.ts`): `refuseProduction("https://fivatgdpuenszxxnijpc.supabase.co")` throws "refusing production"; **the same while `process.env.NEXT_PUBLIC_SUPABASE_URL` is stubbed to a preview branch URL** (audit plan r5 finding 5) → still throws; with `{ readOnlyProduction: true }` it passes; a branch URL passes; a URL whose ref cannot be read (for example `http://localhost:54321` without `--project-ref`) throws "cannot verify target", except the local stack, which is allowed only as the exact host `127.0.0.1` or `localhost`; `PRODUCTION_REF` equals the `PROJECT_REF=` value parsed from `scripts/db-branch.sh`; `resolve-snapshot.ts`, `seed.ts` and `meal-roundtrip.ts` never pass the option (a source scan asserts `readOnlyProduction` appears only in `row-counts.ts`).
- [ ] **Steps 2–5.** Every script calls it first.

### Task 3b: Row-count SQL with the owner chain, both modes (no DB, then DB; audit plan r4 finding 7)

The owned tables come from PR #247's catalog (`tests/tenancy/catalog.ts` `ownedTables()`: direct
`user_id` tables plus foreign-key children with `parent` and `fk`). A child such as
`favorites_meal_items` has no `user_id` (`supabase/migrations/20260911000200_user_schema.sql:54`),
so its owner is found through the chain, never by selecting a `user_id` it does not have.

- [ ] **Step 1: Failing tests** (`tests/p9/row-counts-sql.test.ts`, no DB): for
  `{ table: "water_log", parent: null, fk: null }` the SQL is
  `select 'water_log' as t, x.user_id::text as owner, count(*) from public.water_log x group by 2`;
  for `favorites_meal_items` (parent `favorites_meals`, fk `meal_id`) it joins
  `public.favorites_meals p0 on p0.id = x.meal_id` and groups by `p0.user_id`; for a two-level
  child (`recipe_items` → `recipe_revisions` → `recipes`) it joins both parents; the SQL never
  names `x.user_id` for a child; `readOnlyWrap(sql)` starts with `begin transaction read only;` and
  ends with `rollback;`.
- [ ] **Step 2:** FAIL. **Step 3:** implement `rowCountSql` (walk `parent` until a direct owner;
  one `join` per level) and `readOnlyWrap`. **Step 4:** PASS.
- [ ] **Step 5: Exercise both modes before the gate uses them** (DB): on the local stack, seed one
  row per manifest table for a user (PR #247's `tests/tenancy/seed.ts`) and assert every table
  reports 1 for that user (`tests/p9/row-counts-db.test.ts`); on `p9-tenancy`, run
  `row-counts.ts --target <branch>`; and Devin runs `row-counts.ts --read-only-production` once and
  checks the output has one line per owned table and no error. Only then is the step 1 comparison
  of Task 5 a gate.

### Task 4: The runners (DB; run, not unit-tested beyond Tasks 1–3)

- `row-counts.ts`: `rowCountSql(ownedTables())` (Task 3b) as one `union all`, run against the
  target; on production only with `--read-only-production` and `readOnlyWrap`.
- `resolve-snapshot.ts` **runs each snapshot in its own process configured for one code root**
  (audit plan r7 finding 2): it writes a small entry file `.p9-snapshot-entry.ts` into the
  `--code-root` worktree (a disposable worktree) and runs `pnpm exec tsx .p9-snapshot-entry.ts`
  with `cwd = <code root>`, so that root's own `tsconfig.json` resolves every `@/…` import. The
  entry imports `serverStoreFor` (`lib/server/day-context.ts`) and `resolveDay` (`lib/resolve.ts`),
  loads the **complete day state** with the service role from the target (audit plan r13 finding 2):
  `serverStoreFor(admin, user, date)` and `loggedEntries(admin, user, date)` from that root's
  `lib/server/day-context.ts` (`:114`, `:176`; the same pair `buildDayContext` uses at `:276-288`)
  for the store and the extras; `water_log.cups` for the date as `waterCups`; the `gut_log` state and
  the `weigh_ins` weight for the date put into `store.days[date].gut` / `.weightLb` (the two fields
  `resolveDay` reads from the stored day, `lib/resolve.ts:245-247`); then it resolves each date ×
  floor × swap,
  and prints `{ provenance, days }` where `provenance` = `{ gitHead: git rev-parse HEAD of the root,
  resolvePath: import.meta.resolve("@/lib/resolve"), dayContextPath:
  import.meta.resolve("@/lib/server/day-context") }` and `days` =
  `{ "<date>|floor=<on|off>|swap=<id|none>": canonicalDay(...) }`. The runner refuses the output
  unless both paths are inside the code root (after `realpath`) and `gitHead` equals the commit
  the runbook names; it writes `provenance` into the snapshot file, and `diff-snapshots.ts` prints
  both provenances before the diff. Test (`tests/p9/snapshot-provenance.test.ts`, no DB): a fake
  entry output whose `resolvePath` is outside the root is refused.
- `seed.ts`: `seed_templates_from_fixture(user, fixture)` and
  `backfill_default_templates(ids)`.
- `meal-roundtrip.ts`: renders every `slot_meals` row back to a `Meal` and deep-compares with the
  fixture's authored entry; prints mismatches.

Commit each script with its guard call.

### Task 5: Ledger check (audit plan r5 finding 7)

A down file run by hand removes objects but leaves its row in
`supabase_migrations.schema_migrations`, and `scripts/apply-migrations.py` then treats that version
as applied. So after every drill the branch is restored, and every gate first runs
`scripts/p9/ledger-check.sql` (read-only): for each Phase 9 version, "row in the ledger" must equal
"object present" — `20261104090000` ↔ `to_regclass('public.day_templates')`, `20261104090100` ↔
the column `plan_days.category_override`, `20261105090000` ↔ `public.rate_limit_counters`,
`20261105090100` ↔ `public.invite_claims`, `20261106090000` ↔ the trigger from slice 8,
`20261107090000` ↔ `public.app_config`. Any mismatch → stop; Devin restores the branch.
- [ ] TDD: `tests/p9/ledger-check.test.ts` (local stack): all pass after `supabase db reset`; after
  running one down file by hand inside a rolled-back transaction, the query reports that version as
  a mismatch.

### Task 6: The M1 proof runbook on `p9-tenancy` (spec 2.7 steps 1–6, M1 part)

Run in order; save every output under `~/Backups/supabase/p9-proof/<run-id>/`. This proves what M1 can prove without the
resolver: M1 is additive, the seed is exact, the rollbacks work.

1. (Devin) dump production and restore into `p9-tenancy`, ledger included. Then
   `row-counts.ts --read-only-production` on production (Devin runs it) and
   `row-counts.ts --target <branch>` → `row-counts-source.txt`, `row-counts-branch.txt`; equal.
2. `git worktree add ../mc-p9-base <base commit>` (the production code); run
   `resolve-snapshot.ts --code-root ../mc-p9-base --target <branch> --user <Sasha>` → `before.json`.
   This file is kept for slice 6's gate.
3. `ledger-check.sql`; apply M1 with `apply-migrations.py` (dry run lists exactly `20261104090000`,
   `20261104090100`); `check-sync-guard.sql`; run `seed.ts` with Sasha's id and `--backfill <test id>`.
   Snapshot with the **base** code root → `after-m1-base.json`; `diff-snapshots.ts before.json
   after-m1-base.json` → prints nothing (M1 and the seed change no resolved day for the code in
   production).
4. `meal-roundtrip.ts` → no mismatches.
5. `row-counts.ts` after: her existing tables unchanged; new rows exactly 3 templates, 15 slots,
   14 options, 9 floor meals, and the fixture's component count.
6. Drills, each on its own clean restore, each followed by a restore (audit plan r5 finding 7):
   - Drill A (M1 full): state of step 3; run `down/20261104090100_…down.sql`, then
     `down/20261104090000_…down.sql`; snapshot with the base code root → equals `before.json`.
     Then Devin restores the branch.
   - Drill B (M1 only, fresh): restore; apply M1 and the seed; run M1's down files; snapshot →
     equals `before.json`. Then Devin restores the branch.
   - Drill C (refusal after use): restore; apply M1; write one `plan_days.category_override =
     'rest'` for the test account through `apply_sync_op`; run the `20261104090100` down file → it
     raises "M1 rollback refused" and changes nothing. Then Devin restores the branch.
7. **Leave the branch ready for slice 8:** after the last restore, apply M1 with
   `apply-migrations.py`, run `seed.ts` and the backfill again, run `ledger-check.sql` and
   `check-sync-guard.sql`; both pass. Record the branch state in the PR body.

Remove the worktree afterwards (`git worktree remove ../mc-p9-base`); keep `before.json`.

- [ ] Commit the outputs and open the PR (unmerged). The PR body lists each step with its result.

## Preview test steps

Nothing new in the app. Devin reads `~/Backups/supabase/p9-proof/<run-id>/` in the PR: empty `before.json` ↔
`after-m1-base.json` diff, empty round-trip mismatches, equal row counts, drills A and B equal, drill C
refused, and the final ledger and guard checks pass.

## Rollback

Scripts only: revert the merge commit. The branch data is disposable (restore again).

## Human steps for Devin

1. Dump production and restore into `p9-tenancy` with the migration ledger: once for the proof,
   and once after each drill (four restores in this slice). The restore copies Sasha's health data into the branch; delete the branch when Phase 9
   is live.
2. (No floor cases: the resolver comparison at slice 6's gate is exact.)
