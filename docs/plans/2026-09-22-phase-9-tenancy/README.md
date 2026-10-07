# Phase 9 — Tenancy and a blank slate: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every account is its own, on the server and on a shared phone; a new account signs up with an invite code and sees a blank slate; Sasha's account keeps exactly what it has today.

**Architecture:** Eight slices, one PR each, in the order of the spec's "Slices" list. Slice 1 binds all device state to the verified account (per-account IndexedDB, account-keyed storage, an epoch that stops stale work, `user_id` on outbox ops, `x-smc-account` on direct requests). Slices 4–8 move the fixed day structure into per-user, server-written, read-only templates and gate sign-up behind invite codes.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Supabase (Postgres, RLS, Auth hooks), `idb` over IndexedDB, Zod 4, Vitest 5 (`fake-indexeddb`, `jsdom` per file with `// @vitest-environment jsdom`), pnpm 11.

**Spec:** `docs/specs/phase-9-tenancy-blank-slate.md` (revision 4, final). Read it with this plan. Section numbers in this plan (0.1, 1.4, 2.6 …) are the spec's.

**Contract and hard limits:** `docs/plans/2026-09-22-multi-user-overnight-run.md`.
**Audits of the spec:** `docs/audit/specs/2026-09-22-phase-9-gpt6-sol.md`, `…-r2-gpt6-sol.md`, `…-r3-gpt6-sol.md`.

## Slice order

| # | File | Branch | Migration | Depends on | Tonight |
|---|---|---|---|---|---|
| 1 | [slice-1-device-state-isolation.md](slice-1-device-state-isolation.md) | `fix/p9-device-state-isolation` | none | — | yes |
| 2 | [slice-2-close-open-sign-up.md](slice-2-close-open-sign-up.md) | `fix/p9-close-open-sign-up` | none | Open for Devin 2 before deploy | if time |
| 3 | [slice-3-tenancy-checks.md](slice-3-tenancy-checks.md) | `feat/p9-tenancy-checks` | none (test-only SQL) | — | no |
| 4 | [slice-4-templates-m1.md](slice-4-templates-m1.md) | `feat/p9-templates-m1` | `20261104090000`, `20261104090100` | PRs #249, #250, #241 merged into `main` | no |
| 5 | [slice-5-invites-and-claim.md](slice-5-invites-and-claim.md) | `feat/p9-invites-claim` | `20261105090000`, `20261105090100` | slice 4 | no |
| 7 | [slice-7-migration-proof.md](slice-7-migration-proof.md) | `feat/p9-migration-proof` | none (scripts) | slices 3 (#247 catalog), 4; proves M1 only (the resolver comparison is slice 6's gate) | no |
| 8 | [slice-8-key-validation-m2.md](slice-8-key-validation-m2.md) | `feat/p9-key-validation-m2` | `20261106090000` | slices 4, 5 (test helper), 7 (scripts) | no |
| 6 | [slice-6-resolver-and-consumers.md](slice-6-resolver-and-consumers.md) | `feat/p9-template-resolver` | `20261107090000` (minimum-client gate in the database) | slices 1, 4, 5, 8 (M2 live first) | no |

**Merge and deploy order (audit plan r4 findings 4, 5): 1, 2, 3, 4, 5, 7, 8, 6.** Slice numbers are
kept for reference; slice 8 (M2) now goes **before** slice 6, so the database accepts the default
template's keys before any screen can write them.

**Migration versions (renumbered in round 4).** Production already has `20261103090000` (PR #249)
and `20261103090100` (PR #250), applied on 2026-09-22 with Devin's approval. Production does **not**
have `20261027090000` (on `main`), `20261028090000` or `20261029090000` (PR #241). Every Phase 9
migration therefore sorts after `20261103090100`: `20261104…` (slice 4), `20261105…` (slice 5),
`20261106…` (slice 8), `20261107…` (slice 6).

Dependency graph:

```
1 ─────────────────────────────┐
2 (after Devin turns hosted sign-up off)
3 ── (re-run in 4, 5 with new tables in the manifest)
PRs #249, #250, #241 ─▶ 4 ─▶ 5 ─▶ 7 ─▶ 8 (M2) ─▶ 6 (resolver + DB client gate)
```

Slices 1, 2 and 3 do not depend on each other and can run in parallel branches. Slice 3 adds a
manifest; slices 4 and 5 each add their new tables and functions to it in the same PR.

## Execution method (fixed)

- Each slice is one branch (`feat/` or `fix/`, names above) and one PR. The PR stays **unmerged**
  for Devin. Do not run `zs-land`, `gh pr merge` or any merge.
- TDD for every task: failing test, run it and see it fail, minimal code, run it and see it pass,
  commit.
- Local gates are the fast set plus the task's own tests, run targeted:
  - `pnpm exec tsc --noEmit`
  - `pnpm lint`
  - `pnpm exec vitest run <the test files of the task>`
  - Before the PR: `pnpm exec vitest run --changed origin/main` (only tests related to changed
    files).
- Never run `pnpm test`, `pnpm test:integration` or the full suite locally. CI (`.github/workflows/ci.yml`
  jobs `quality` and `integration`) is the gate. When CI ejects a PR, read the failure, re-run only
  the failing file locally, fix, push.
- Tests that need a database skip themselves unless `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`
  and `SUPABASE_TEST_SERVICE_ROLE_KEY` are set (`HAS_BRANCH` in `tests/helpers/supabase.ts`). CI's
  `integration` job starts a local stack with `python3 scripts/ci-local-supabase.py start` (CI
  only). To run one DB test locally, use the local commands below and run that file only.

**Local DB tests (audit plan r11 finding 5).** `scripts/ci-local-supabase.py start` runs only on a
GitHub Actions runner (`scripts/ci-local-supabase.py:55-56`); it stays the CI path. Locally:
```bash
pnpm exec supabase start
eval "$(pnpm exec supabase status -o env | sed -n \
  -e 's/^API_URL=/export SUPABASE_TEST_URL=/p' \
  -e 's/^ANON_KEY=/export SUPABASE_TEST_ANON_KEY=/p' \
  -e 's/^SERVICE_ROLE_KEY=/export SUPABASE_TEST_SERVICE_ROLE_KEY=/p' \
  -e 's/^DB_URL=/export SUPABASE_TEST_DB_URL=/p')"
pnpm exec vitest run <one test file>
```
(the same four values the CI helper exports, `scripts/ci-local-supabase.py:37-41`; nothing is
printed). Stop with `pnpm exec supabase stop --no-backup`.
- Each PR body: summary, the slice's "Preview test steps", the rollback, the human steps for Devin,
  and a test plan. An independent non-Anthropic code review is saved to `docs/audit/code/` (contract
  task 7).

## Global constraints

Copied from the spec and the contract. Every task's requirements include this section.

- **No production change of any kind.** No migration applied to production, no hosted auth-hook
  activation, no production Vercel env change, no production data write, no merge of a code PR.
  Read-only production SQL is allowed.
- **Supabase preview branch:** at most one, named `p9-tenancy`
  (`bash scripts/db-branch.sh create p9-tenancy`). Migrations are applied only there (and to the
  local stack), never to production.
- **Migration timestamps** are after `20261103090100` (production's newest). Do not touch PR #241,
  #249 or #250 or their files.
- **How migrations are applied (audit plan r4 finding 5).** Only with
  `python3 scripts/apply-migrations.py` (dry run; names every missing version in version order) and
  then `--commit`, with `SUPABASE_PROJECT_REF` set to the target. Never `pnpm db:push` for a hosted
  project: `supabase db push` without `--include-all` refuses (or skips) versions older than the
  remote's newest, which is exactly the state after #249/#250. Before any `--commit`, the dry-run
  list must equal the list the runbook names, in the same order; if not, stop.
- **The #249 guard must survive every later migration.** After each apply run on any target, run
  `scripts/p9/check-sync-guard.sql` (slice 4, Task 0): the three sync internals carry the
  `p9_sync_caller_guard` marker and `authenticated` has no EXECUTE on them.
- **Every data route requires `x-smc-account`** (PR #248: `401 account_header_required` when it is
  missing). Tests in slices 4–8 that call a route as a user send the matching header.
- **Sign-in shows one neutral screen** for known and unknown addresses (PR #246: "If this email has
  an account, we sent a sign-in link."). No slice may add an error that reveals whether an address
  has an account.
- **Tenancy manifests use PR #247's format:** `tests/tenancy/table-ops.json` entries
  `{ "ops": [...], "owner": "user_id" | { "parent": "<table>", "fk": "<column>" }, "seed": "<id>" }`
  (seeded by `tests/tenancy/seed.ts`), `tests/tenancy/rpc-ops.json` keyed by full signature with
  `{ "class": "account", "case": "<id>" }` or `{ "class": "pure" | "catalog", "reason": "…" }`,
  `tests/tenancy/cross-refs.json` for references to another owned row. Each slice that adds a table,
  function or reference adds its entries in the same PR (stacked on #247 if it is not merged).
- Down files live in `supabase/migrations/down/<timestamp>_<name>.down.sql` (repo convention).
- **Templates are server-written and read-only for the client in Phase 9.** No client edit, no
  archive, no outbox op, no change-feed entity for templates (spec 2.1, 2.8).
- **No fallback to Sasha's constants** in runtime code after slice 6 (spec 2.6, 3.7).
- `error`, not a new status, for an op the server refuses for account reasons (spec 0.5).
- The invite UI renders only when `NEXT_PUBLIC_INVITE_SIGNUP=1`; the flag is the last rollout step.
- Status codes: `409 account_mismatch` (0.5a), `426 client_upgrade_required` (1.5b), hook refusal
  `{ "error": { "http_code": 403, "message": "invite_required" } }` (1.4).
- Rate limits on the invite route: per IP 10/hour, per email 5/hour, global 100/hour; keys store
  hashes only (1.3).
- Invite reservation lives 30 minutes; a `hooked` claim lives 24 hours (1.4).
- No destructive git, no force-push, no amend of another writer's commit. Specs are not edited by
  this work.
- House code rules: files under 400 lines where you create them, functions under 50 lines, no silent
  error swallow, Zod at boundaries, no raw Tailwind literals in new UI.

## Review Focus

Inputs and failure modes the spec implies that are easy to miss. Each line names the owning slice
and test.

1. **Session changes in the middle of an `await`** (token refresh that yields the same user, then
   a real switch). Expected: a same-user refresh keeps the handle valid; only a different user id
   bumps the epoch. Owner: slice 1, Task 1 (`bindAccount` with the same id is a no-op test).
2. **Private mode or a blocked IndexedDB/localStorage.** Expected: the app still signs in; sync
   fails with the existing "last error" line; no throw escapes into React. Owner: slice 1, Task 2
   (open failure is not cached) and Task 4 (storage helpers swallow and report).
3. **Two tabs of the same phone, one signs in as B while the other shows A.** Expected: tab A's
   next write throws `AccountChanged` only in tab B's memory; tab A's own writes stay in A's DB;
   the server answers A's tab `409` if its cookie is now B. Owner: slice 1, Task 7
   (`409 account_mismatch` route test).
4. **An invited account on an old build or an old offline shell.** Expected: `426` and no writes.
   Owner: slice 6, 1.5b tests.
5. **Floor Day for Sasha** (round 10: unchanged in Phase 9). Expected: with Floor Day on, the same
   floor meals as `main` today; a new account has no Floor Day. Owner: slice 6 Task 4 and the exact
   gate (slice 6 Task 8c).

---

## Human steps for Devin (batched, in the spec's rollout order)

These are Devin's only; no agent does them. The slice files repeat the ones that belong to them.
The order follows spec "Rollout" steps 0–7 (audit plan r1 finding 6). A code PR deploys when it
merges, so "merge" below means "merge and let it deploy".

**Step 0 — before any Phase 9 code deploys**
1. Ask Sasha to open the app online once, so her old outbox drains under the old build
   (spec 0.6, Open for Devin 3).
2. Turn off "Allow new users to sign up" in the production Supabase dashboard and check it
   (spec 1.5a, Open for Devin 2).

**Step 1 — device isolation and closed sign-up (code only)**
3. Merge slice 1. Right after it deploys, ask Sasha to close and reopen the app online (the new
   service worker reloads old tabs). Then merge slice 2. Slice 3 (tests only) can merge at any
   time.

**Step 2 — working migration history (before any Phase 9 migration)**
4. Merge PR #249 and PR #250 into `main` (their migrations are already on production; the merge
   only puts the files in the history, so `apply-migrations.py` does not see them as missing).
5. **Apply PR #241's migrations before its code deploys (audit plan r8 finding 1).** #241's build
   sends body-fat provenance and `goal_rate_bp_week`, which only its migrations store; code first
   would drop those inputs from a profile saved in the gap. The migrations are safe for the code in
   production: their `_sync_upsert` patch keeps a stored value when an op omits the key
   (`20261029090000_rate_goals.sql:31-33`). So: rebase #241 on `main` (which now has the #249/#250
   files); in a worktree at #241's head, after a backup, run `python3 scripts/apply-migrations.py`
   against production: the dry run must list exactly `20261027090000`, `20261028090000`,
   `20261029090000`, in that order. Run it with `--commit`. Check the new columns exist
   (`user_settings.goal_rate_bp_week` and the body-fat provenance columns of `20261028090000`).
   **Only then merge PR #241** (it deploys). Then run `scripts/p9/check-sync-guard.sql` (read-only): the
   guard marker is on all three sync internals and `authenticated` has no EXECUTE. #241's two files
   patch `_sync_upsert` by text replacement (`pg_get_functiondef` + anchored `replace`), which keeps
   the guard line, and their revokes do not re-grant `authenticated`; the check proves it. If the
   check fails, stop: slice 4's first migration re-asserts the guard, but do not continue until it
   has run.
   (Open for Devin 1.)

**Step 3 — prove the order on a restore, then templates M1**
6. Dump production and restore it into `p9-tenancy` (Open for Devin 5), **including the
   `supabase_migrations.schema_migrations` ledger** (check: its newest row is `20261103090100`, or
   `20261029090000`'s row exists if step 5 is done). Run `apply-migrations.py` against the branch;
   its dry run is the exact pending set production will get. Apply it there first. Read slice 7's proof.
7. Review the accounts created since PR #237 (keep → backfill, or delete) (Open 4).
8. Merge slice 4. On production, after a backup: dry run must list exactly `20261104090000`,
   `20261104090100`; `--commit`; run the guard check; run the seed with Sasha's id and the backfill
   with the test account id **and every other kept account**. Check: `select count(*) from
   auth.users u where not exists (select 1 from day_templates t where t.user_id = u.id)` = 0
   (Open 7).

**Step 4 — invites and claim, UI hidden**
9. Merge slice 5. On production, after a backup: dry run lists exactly `20261105090000`,
   `20261105090100`; `--commit`; guard check. Do **not** activate the hook and do **not** set the
   flag yet.

**Step 5 — key validation M2, before any default-template screen (audit plan r4 finding 4)**
10. Merge slice 7 (scripts), then slice 8. On production, after a backup: the step 8 check is still
    0; dry run lists exactly `20261106090000`; `--commit`; guard check. From now on the database
    accepts `breakfast` for accounts whose template has it. Every `manual` account (Sasha, T, every
    kept account) keeps writing the legacy slot keys and day types too (slice 8 legacy allowance),
    so no tab of the build in production loses a write.

**Step 6 — resolver and the client gate** (never before steps 3 and 5)
11. Merge slice 6. On production, after a backup: dry run lists exactly `20261107090000`;
    `--commit`; guard check; set `MIN_CLIENT_BUILD` to its `CLIENT_BUILD` on Production and the same
    value in the `app_config` row the migration creates. Sasha checks her account on the preview
    first, then on production (Open 10).

**Step 7 — activate the gate**
12. Activate the before-user-created hook, turn sign-up on, run
    `scripts/invite-probe.ts --target <production> --i-am-devin-on-production` probes 1–5 at once;
    turn sign-up off again on any failure (Open 8).

**Step 8 — open invites (last)**
13. Only after steps 5–7 are live and probe 5 passed: set `NEXT_PUBLIC_INVITE_SIGNUP=1` on
    Production and create invite codes (Open 9).

**Any time**
14. Reconcile the Phase 10 spec with the template contract in the spec's "Later" (Open 11).

## Plan decisions (made by this plan, not by the spec)

Each can be reversed; the slice file gives the reason.

- **P1 (slice 1):** `SyncOp` keeps its shape; the stamped type is `OwnedOp = SyncOp & { user_id }`.
  Reason: over 30 op builders construct `SyncOp`; only `appendOp*` must stamp.
- **P2 (slice 1):** `lib/store.ts` keeps its synchronous API and reads the bound account itself
  (`currentAccountOrNull()`), keyed `smc:u:<id>:store`. Reason: dozens of synchronous callers; the
  store cache is reset on every unbind, so it cannot serve a stale account.
- **P3 (slice 1):** the legacy store blob `meal-companion:store:v1` is moved to
  `smc:legacy:meal-companion:store:v1` (held), not deleted; the current account's legacy
  eaten-migration marker is copied. **Revised in round 3:** the held blob is never imported for
  any account, and the D1 tick migration is removed (slice 1, Task 9 rule 9). Reason: the blob has
  no owner proof; losing old ticks is acceptable, giving them to another account is not.
- **P4 (slice 1):** the retained-account list is a device-level `localStorage` key
  `smc:device:accounts`, not `indexedDB.databases()`. Reason: deterministic in tests and not
  dependent on browser support. In slice 1 it is only recorded (see P9).
- **P5 (slice 1):** an account's `store` key is always kept with its DB (see P9).
- **P6 (slice 1):** `SyncBootstrap`'s effect body moves into a testable function
  `startAccountSync(handle)` in `lib/sync/account-sync.ts`; the component only calls
  `mountAccountSync()`.
- **P8 (slice 1) — REVERSED in audit round 2.** Round 1 had the server apply an op without
  `user_id` to the JWT user. Round 2 finding 1 showed that two same-origin tabs share one cookie, so
  such an op can be A's change sent as B. The plan now follows spec 0.5: missing `user_id` →
  `error: account_unbound`, no write. An old build parks and keeps an `error` op
  (`lib/sync/outbox.ts:194-208,309-312`), and the slice 1 service worker (`v3`) reloads old tabs
  into the new build, where those ops are held in `smc` (spec 0.6), not sent and not deleted.
  Residual risk: a change made in an old tab between the deploy and its reload is held on the
  phone. Human step: Sasha closes and reopens the app right after the deploy.
- **P9 (slice 1; differs from spec 0.7; audit plan r3 finding 1).** On sign-out or switch, slice 1
  deletes only re-fetchable caches. It never deletes an account DB, its `store`, drafts or scans,
  and it has no 3-DB cap. Reason: no check in slice 1 can prove that an account has no local-only
  state (a label-typed meal lives only in the store, `app/page.tsx:374-383` (`logFromLabel` → `addExtra`)). Keeping is safe, because
  each DB and store is per account. A later slice may add the cap with a proof: no local-only
  state **and** a server-confirmed caught-up sync. Cost: other accounts' data stays on a shared
  phone (unreadable by the app for another account). Devin can reverse this.

## Resolution of audit round 1

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r1-gpt6-sol.md` (DO NOT SHIP, 6 BLOCK, 5 FIX).
Every finding was checked against the code at `29369f6` (`origin/main`, specs merged as PR #244).
All 11 hold; none was rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | (Deletion superseded by round 3 finding 1: nothing is deleted now; `pendingWork` feeds only the sign-out notice.) Slice 1 Task 10: `pendingWork()` counts outbox, `pending_log_entries`, `pending_target_revisions`, `pending_weigh_ins`, drafts and scans; unreadable → `"unknown"` → keep (fail closed); the cap uses the same rule; tests for each kind, for an unreadable DB, and for a switch between the pending record and the op (Task 7 direct-request test now runs `forgetAccount`) | `lib/log/pending.ts:31`; `lib/log-commit-client.ts:63-70,245`; `lib/targets/client.ts:57`; `lib/health/weigh-in-client.ts:43` |
| 2 | BLOCK | Slice 1 Task 4: "rule for responses" — every storage helper takes the initiating handle, asserts it after each `await`, rethrows `AccountChanged` before any cache fallback; `saveStoreFor(h, …)` for every save after an `await`; tests for a late A health and expenditure response and a stale store save | `lib/health-client.ts:91-109` (write at `:102-103` after `await res.json()`); `lib/estimator-client.ts:61-75` (write at `:68-69`) |
| 3 | BLOCK | (Superseded by round 2 finding 1.) Round 1 applied ops without `user_id` as today; round 2 reverses this. Old tabs keep working through the reload path instead: refusal is `error` (parked and kept by old builds), and the `v3` service worker reloads them | spec `phase-9-tenancy-blank-slate.md:441-444` (old tabs of `manual` accounts keep working), `:267-270` (missing header accepted); `lib/sync/outbox.ts:198-208,309-311` (an `error` op parks) |
| 4 | BLOCK | (Superseded by round 3 finding 2: no import at all.) Slice 1 Task 9 rule 9 and README P3: the D1 tick migration keeps its server-proved eligibility and reads the held legacy blob; it runs only after a full legacy read; one claim per phone; tests for import, copied marker, and unreadable legacy DB | `lib/sync/plan-days.ts:14-33` (reads `loadStore().days` at `:23-24`, marker after ack at `:30-31`); `components/AuthGate.tsx:215-220,311-315` |
| 5 | BLOCK | Slice 8: the down file starts with a guard that refuses while any row holds a key outside the old lists and changes nothing; M2 is roll-forward only after the invite flag; two DB tests | `supabase/migrations/20260911000200_user_schema.sql:80`; `20261026090000_plan_days_eaten_slots.sql:5-31` (constraint `plan_days_eaten_slots_shape` calls the function) |
| 6 | BLOCK | README human steps rewritten in the spec's rollout order 0–7; the flag is the last step, after slice 6, M2 and probe 5. The plan files are present on `docs/phase-9-plan` (untracked, as the coordinator placed them) | spec `phase-9-tenancy-blank-slate.md:762-778` |
| 7 | FIX | Slice 1 Task 10: `adoptThenReady` marks ready only after a successful adoption; two tries, then a blocked view "This phone could not finish the update." with Retry; no catch-all; `adoptLegacyDevice` rejects on real errors; gate test | spec `:180` (`onAccountReady` after adoption) |
| 8 | FIX | Slice 1 Task 3: the water test controls the read-to-write interval with a gated `getRow` mock; Task 6: `mountAccountSync()` drives the real ready/gone subscription; tests assert no pass before ready and none after gone | plan r1 lines cited by the audit; `lib/water-client.ts:39-60` |
| 9 | FIX | Slice 3: `ownedTables()` finds children through foreign-key chains from the catalog, not from the manifest; a test compares each declared child owner with the catalog; `rpc-ops.json` keyed by `oid::regprocedure` full signature (slice 5 entry updated) | `tests/rls/cross-user.test.ts:7-16` (children such as `log_items`) |
| 10 | FIX | Slice 4 Task 4: `macroKcal` imported from `@/lib/scaling` and called with one macro object; `SLOT_TARGETS` indexed by `DayType` then `SlotId` | `lib/scaling.ts:20`; `lib/meals.ts:30,36-38,949-960`; `lib/types.ts:24-29` |
| 11 | FIX | Slice 1 Preview step 7: two tabs on the same preview origin; the switched tab either rebinds or gets `409 account_mismatch`; T's queued work stays in `smc-u-<T>` and arrives as T | same-origin storage and cookies are shared; separate origins are not |

## Resolution of audit round 2

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r2-gpt6-sol.md` (DO NOT SHIP, 8 BLOCK, all slice
1). Each finding was checked against the code at `29369f6`. All 8 hold; none was rejected. Each fix
takes the most conservative option. Slice 1 stays shippable alone, with no migration.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | P8 reversed: missing `user_id` → `error: account_unbound`, no write (spec 0.5). `error` is the status an old build keeps: it retries, then parks the op, never deletes it; `unsupported` or an unknown status would drop it. New Task 10a: service worker `v3` with `client.navigate()` on activate reloads old tabs into the new build. Ownerless legacy ops are held, not re-stamped: no owner proof exists for them. Owner-stamped legacy records are adopted (see 2). Tests: server refusal, old-client park-and-keep, two-tab DB case, service-worker reload. Human step: Sasha reopens the app after the deploy | `app/api/sync/ops/route.ts:79,89`; `lib/sync/outbox.ts:194-208,305-312,320`; `lib/sync/log-entry-ops.ts:143-161`; `lib/sync/outbox-membership.ts:16-37`; `public/sw.js:28-51`; `lib/water-client.ts:48-51` |
| 2 | BLOCK | Task 9 rule 5: `smc` is deleted only when the outbox, `pending_log_entries`, `pending_weigh_ins`, `pending_target_revisions` and every other `pending_*` meta key are empty; any read error keeps it. Rule 4a adopts records whose stamped owner is the current account. Tests: each meta key with an empty outbox; owner-only adoption | `lib/log/pending.ts:31,79,180-194`; `lib/health/weigh-in-client.ts:43,67-68`; `lib/targets/client.ts:57-64` |
| 3 | BLOCK | Task 10: `gateView` gets `ready`; with a resolved disposition but no ready event it renders the "Setting up this device…" shell, never children. Test: fast disposition with pending adoption. Preview step 9 | `components/AuthGate.tsx:263-271,334-335,359` |
| 4 | BLOCK | (Superseded by round 3 finding 2: no import at all.) Task 9 rule 9: the tick import runs from one per-handle join of "adoption succeeded" and "server eligibility known", whichever comes second. Ticks, ops and the local marker commit in one IndexedDB transaction. The device claim key is written before and removed on failure. Tests: both orders run once; memory-only session defers; a failed transaction leaves nothing | `components/AuthGate.tsx:289-292,296-318`; `lib/sync/plan-days.ts:14-33` |
| 5 | BLOCK | Task 10: `runTransition` serializes unbind → `await forgetAccount(previous)` → bind. `forgetAccount` deletes only `accountDbName(previous)` and `smc:u:<previous>:` keys; the cap never deletes the next or bound account. Tests: paused pending-work check with a quick return to A (A's new op survives); forgetting A leaves B intact | plan r1 Task 10 text; `lib/log-commit-client.ts:245` |
| 6 | BLOCK | Task 7: no export exemption. Export links become buttons that use `accountFetch` + `accountBlob` + an object-URL download; the route's `requireUser` answers `409` on mismatch. Guard test forbids `href` to `/api/`. Tests: two-tab switch before tapping Export (client and route). Preview step 8 | `components/ExportCard.tsx:59`; `app/api/export/route.ts:152` |
| 7 | BLOCK | Task 2: every read primitive goes through `read()`, which asserts the handle after the request resolves. Raw-handle callers assert after every awaited request (guard test and a `restoreCachedPlanDays` switch test). Test: switch while `getRow`, `allRows` and `getMeta` are pending | plan r1 Task 2 code; `lib/sync/plan-cache.ts:9-30` |
| 8 | BLOCK | Task 7: `accountFetch` asserts after the response resolves; bodies are read only through `accountJson`/`accountText`/`accountBlob`, which assert after parsing; guard test forbids raw `.json()` next to `accountFetch`. Tests: response released after the switch; body parsed after the switch | `lib/coach-client.ts:128`; `lib/constraints-client.ts:22` |

## Resolution of audit round 3

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r3-gpt6-sol.md` (DO NOT SHIP, 5 BLOCK, 3 FIX). This
was the last plan audit. Each finding was checked against the code at `29369f6`. All 8 hold; none
was rejected. Each fix takes the most conservative cut. Slice 1 still ships alone, with no migration.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Slice 1 Task 10 and P9: `forgetAccount` deletes only re-fetchable caches (coach thread cache, health, expenditure, proposals, food refs) and shell caches. It never deletes an account DB, `store`, drafts, scans or coach-action marks. No 3-DB cap in slice 1. Tests: a label-typed meal in the store survives a switch with an empty outbox; five accounts keep five DBs | `app/page.tsx:374-383` (`logFromLabel` → `addExtra`); `lib/store.ts:212`; spec 0.7 |
| 2 | BLOCK | Slice 1 Task 9 rule 9 and P3: the held legacy blob is never imported; the D1 migration call and the code only it uses are removed. Test: B signs in first, then A; neither gets the ticks; the blob stays held | `lib/sync/plan-days.ts:14-33`; `components/AuthGate.tsx:215-220,311-315` |
| 3 | BLOCK | Slice 1 new Task 7b: an inventory of every direct client Supabase call; `withAccount(h, run)` checks the handle before and after; every write carries the owner (`p_user`/`p_user_id`/`row.user_id = h.userId`), so the database refuses it under another JWT; reads are dropped on a post-resolve mismatch; `backfillFoodPrefs` takes the handle instead of reading claims. Tests: switch while the claims read or first RPC is pending; guard scan; DB case for `set_food_membership` with another `p_user` | `lib/foods/prefs-client.ts:198,248,324,341-360,478-495`; `supabase/migrations/20260911000600_rpc.sql:8-26`; `20261023090400_food_membership_v2.sql:3-12`; `20260911000500_rls.sql:5-23` |
| 4 | BLOCK | Slice 1 Task 7: Oura start gets a `POST` that answers `{ url }` after `requireUser` (so `409` on mismatch); `connectOura(h)` uses `accountFetch` + `accountJson`, then navigates to the Oura URL; the old `GET` stays for old builds; guard forbids navigation to `/api/`. Tests: route 409, stale-tab client, late response | `lib/health-client.ts:127-131`; `app/api/health/oura/start/route.ts:11-19` |
| 5 | BLOCK | Slice 6 Task 4: clock-free rule. A local `policy_epoch` rises with every policy-relevant change; templates are fetched only at the end of a sync pass whose push left no policy change pending; a verdict is used only when online, nothing is pending and its `epochAtFetch` equals the current epoch. Test: the offline-Avoid-then-reconnect sequence; clock skew changes nothing | slice 6 r2 text; `lib/constraints-client.ts` |
| 6 | FIX | Slice 4 Task 5: an annotated empty `policy_categories` (`'{}'`) is known and clean; unknown only when not annotated and nothing derived (`policyCategoriesOf`). Test for `'{}'` → safe. The spec text (2.4 "not null, not empty") needs the same correction: Open for Devin below | `supabase/migrations/20261018090000_policy_categories.sql:11-19`; `lib/server/catalog.ts` (`policyCategoriesOf`) |
| 7 | FIX | Slice 7 no longer applies M2; its drill A is M1 only. Slice 8 Task 2 runs the M2 proof and drill with slice 7's scripts; slice 8 now depends on slice 7 | spec 2.7 steps 3, 6 |
| 8 | FIX | Slice 1 Task 7: the header test reads `(call[1] as RequestInit).headers` | `new Headers(init)` on a whole `RequestInit` ignores its `headers` field |

## Open for Devin

No auditor re-checks the round 3 fixes. The independent code review of slice 1 re-checks #1–#4.

- **Open BLOCK (resolved in plan by the run, not re-audited; slice 1 code review re-checks #1-#4):**
  #1 an account switch could delete a meal that lives only in the store — cut: slice 1 deletes no
  account DB or store at all (P9; a spec 0.7 deviation for you to accept or reverse).
- **Open BLOCK (resolved in plan by the run, not re-audited; slice 1 code review re-checks #1-#4):**
  #2 legacy eaten ticks had no owner proof — cut: never imported, held on the phone; the D1
  migration code is removed.
- **Open BLOCK (resolved in plan by the run, not re-audited; slice 1 code review re-checks #1-#4):**
  #3 direct Supabase calls bypassed the account boundary — cut: owner in every write, handle checked
  before and after every call (Task 7b).
- **Open BLOCK (resolved in plan by the run, not re-audited; slice 1 code review re-checks #1-#4):**
  #4 Oura connect bypassed the account check — cut: `POST` + `accountFetch`, `409` on mismatch.
- **Open BLOCK (resolved in plan by the run, not re-audited; slice 1 code review re-checks #1-#4):**
  #5 (slice 6) a floor verdict could precede an Avoid write — cut: clock-free `policy_epoch`, fetch
  only after the push, no floor meal while a policy change is pending.
- **Round 4 (resolved in plan by the run, not re-audited):** the 8 BLOCKs of round 4 (hook-bound
  claim, database client gate, allergen evidence, M2 before slice 6, migration order and apply tool,
  header-aware tests, read-only production row counts, M1 rollback guards). New for you: merge
  #249 and #250 before slice 4 (their files only; production already has them); run the
  `apply-migrations.py` dry run and compare it with the runbook list before every `--commit`;
  insert the `app_config` `min_client_build` row with slice 6; resolve any account whose `hooked`
  claim expired (slice 5 human step 0).
- **Spec text to correct (you own the spec):** 1.5b says old tabs of `manual` accounts keep working
  through `/api/`; after PR #248 a headerless old tab gets `401` and reloads. 1.4 step 6 (enter a
  code again on another device) is replaced by the hook-bound finish. Rollout step order (M2 before
  the resolver). 2.4 allergen evidence (tags are never proof of absence). 2.4 says a ref's category must be "not null, not
  empty"; the plan follows the migration's meaning (`'{}'` = annotated clean). 0.7's delete and
  3-DB cap are deferred by P9. 0.5 ("missing `user_id` → `account_unbound`") is followed as
  written (P8 reversed). The 0.5a module list did not name the export links or Oura connect; the
  plan adds both and changes the Oura start route (a new `POST`).

## Resolution of audit round 4

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r4-gpt6-sol.md` (DO NOT SHIP, 8 BLOCK, 3 FIX, all
in slices 4–8), extra round approved by Devin. Each finding was checked against `main` at `0a26e46`
and the open PR branches #241, #246, #247, #248, #249, #250. All 11 hold; none was rejected. Each
fix takes the most conservative cut.

New facts used: production has `20261103090000` (#249) and `20261103090100` (#250) and lacks
`20261027090000` (`main`), `20261028090000` and `20261029090000` (#241);
`scripts/apply-migrations.py` applies every missing version in version order; PR #248 requires
`x-smc-account` (`401` when missing); PR #246 shows one neutral screen at sign-in; PR #247 defines
the manifest format.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Slice 5: the hook binds the claim to the created user (`hook_user_id`, `hooked_at`, never cleared; no user id → refuse). `claim_account` accepts only a `hooked` claim with `hook_user_id = auth.uid()`, never `reserved`. The cross-browser finish needs no code or nonce; the "enter a new code" recovery is removed. Tests: admin-created user with a valid new code is refused; cross-browser finish; hook without a user id | spec 1.4 steps 4–6; plan r3 slice 5 Tasks 2, 5 |
| 2 | BLOCK | Slice 6 Task 8b and migration `20261107090000`: `client_allowed()` (invited account + no or old `x-smc-client` + a `min_client_build` row → false) as a restrictive policy on every table with declared ops, and `_assert_client_allowed()` as the first statement of every account RPC. `browserClient` sends `x-smc-client`; `createRequestClient` forwards it. DB tests through PostgREST | `20261023090400_food_membership_v2.sql:127-128`; `lib/foods/prefs-client.ts:355`; `lib/supabase/client.ts:13-25`; `lib/supabase/server.ts:108-123` |
| 3 | BLOCK | Slice 4 Task 5: allergen tags are never proof of absence. Any allergen rule on the account → every floor meal `unsafe`; with no rule, tags are not used. Tests with default empty tags and with "assessed-looking" tags | `20260911000200_user_schema.sql:11`; `20260911000100_catalog_shell.sql:45`; `lib/foods/prefs-client.ts:358` |
| 4 | BLOCK | Order is now 1, 2, 3, 4, 5, 7, 8, 6: M2 is applied before slice 6 deploys, after a check that every account has templates. DB test for the interval (T's `breakfast` applied, T's old key parked, Sasha's keys applied) | `20261026090000_plan_days_eaten_slots.sql:10-13`; `lib/sync/outbox.ts:194-221` |
| 5 | BLOCK | All Phase 9 migrations renumbered after `20261103090100` (`20261104…`–`20261107…`). Apply only with `apply-migrations.py` (dry-run list must equal the runbook's list), never `pnpm db:push`. Runbook: merge #249/#250 (files only), merge #241 and apply `20261027`/`28`/`29`, prove the pending set on a restore that keeps the migration ledger, then each slice. M1 re-asserts the #249 guard; `scripts/p9/check-sync-guard.sql` runs after every apply | `package.json:16` (`supabase db push` without `--include-all`); `scripts/apply-migrations.py:1-20`; #249 `20261103090000` header; #241 `20261028090000:68-85`, `20261029090000:50-66` (text patches keep the guard; revokes do not re-grant) |
| 6 | BLOCK | Slice 6 Task 8 tests send the matching `x-smc-account`; a headerless request is `401 account_header_required` for every account; `426` only with the account header and a missing/old build; route cases write nothing | PR #248 `lib/server/auth.ts:32-43` |
| 7 | BLOCK | Slice 7: `row-counts.ts --read-only-production` (one `select` inside a read-only transaction, the only production exception); row-count SQL follows PR #247's owner chain for children; unit tests for the SQL and both modes exercised before the gate | `20260911000200_user_schema.sql:54` (`favorites_meal_items` has no `user_id`); #247 `tests/tenancy/catalog.ts` `ownedTables()` |
| 8 | BLOCK | Slice 4: the `20261104090100` down file refuses while any `category_override` exists; the `20261104090000` down file refuses while any invited claim exists; both change nothing when they refuse. Slice 7 drill C proves the refusal after a toggle | plan slice 6 day toggle writes `category_override` |
| 9 | FIX | Slices 4, 5, 6 list their exact entries in PR #247's format (`table-ops.json` `{ ops, owner, seed }` with parent chains, `fixtures.ts` builders, `cross-refs.json`, `rpc-ops.json` by signature, the no-owner RLS list) | #247 `tests/tenancy/table-ops.json`, `rpc-ops.json`, `cross-refs.json`, `fixtures.ts` |
| 10 | FIX | Slice 5 Preview step 5 and UI tests keep PR #246's neutral "If this email has an account, we sent a sign-in link." | #246 `app/sign-in/page.tsx:78-87,156-163` |
| 11 | FIX | Slice 5 probe 5 checks the durable `hook_user_id`/`hooked_at` after finalization; probe 3 records the `hooked` state before `claim_account` | spec 1.4 step 5 (`consumed` after claim) |

Earlier resolution tables name the old migration versions; round 4 renamed them in place
(`20261030…` → `20261104…`, `20261031…` → `20261105…`, `20261101…` → `20261106…`).

## Resolution of audit round 5

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r5-gpt6-sol.md` (DO NOT SHIP, 7 BLOCK, 2 FIX).
Each finding was checked against the code and the plan at `61f82f5`. All 9 hold; none was
rejected. Each fix is the most conservative cut; no new subsystem was added.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Slice 4: two M1 triggers in PR #250's style — `slot_meal_components_same_owner` (a `user` ref must belong to the template owner, for every writer, service role included) and `template_parents_fixed` (no change of any template parent or owner). Tests: direct service-role insert and update | M1 grants table writes to `service_role`; #250 `20261103090100_same_owner_references.sql` lists only earlier tables |
| 2 | BLOCK | Slice 5: `claim_invite` cancels only a `reserved` claim; with a `hooked` claim for the email it reserves nothing and answers the generic failure. Test: a second request between the hook and the email link, then `claim_account` succeeds | plan r4 slice 5 `claim_account` accepts only `hooked` |
| 3 | BLOCK | Slice 8: the M2 trigger judges only keys a write adds or changes (and `day_type_override` only when it changes); stored keys stay and are never re-judged, so no row is stranded and no key migration is needed. Read-only inventory `scripts/p9/m2-inventory.sql` for Devin before the apply. Tests: old stored key kept, new valid key accepted, changed old key refused | `20261026090000_plan_days_eaten_slots.sql:127-135` (omitted fields are kept) |
| 4 | BLOCK | Slice 6 Task 8b: the migration patches an explicit function list that never includes `client_allowed()`, `_assert_client_allowed()` or `_sync_assert_caller(uuid)`. Tests: no marker in those two, direct call and policy path answer without recursion | plan r4 slice 6 Task 8b steps 2, 3, 5 |
| 5 | BLOCK | Slice 7: production is recognized only by its fixed project ref `fivatgdpuenszxxnijpc` (the constant in `scripts/db-branch.sh:12`, compared by a test); no env file takes part; an unreadable ref is refused. Test: production target while `NEXT_PUBLIC_SUPABASE_URL` points to preview | `scripts/db-branch.sh:12` |
| 6 | BLOCK | Slice 7 proves M1 only (snapshot with the production code before and after M1 is equal). The resolver comparison (`after.json` with slice 6 code, floor cases) moves to slice 6 Task 8c, which runs after slices 7 and 8 exist. No cycle remains: 7 → 8 → 6 | plan r4 slice 7 Task 5 step 3 |
| 7 | BLOCK | Every drill runs on its own restore and is followed by a restore (ledger included); each gate first runs the new `scripts/p9/ledger-check.sql` (ledger row ↔ object present). Slice 7 and slice 8 each end by re-applying the state the next gate needs | `scripts/apply-migrations.py:67` reads the ledger; a hand-run down file leaves the row |
| 8 | FIX | Slice 8 tests: one date per case, marks as `{ eaten_at, changed_at }`, updates with the row's rev; a trigger refusal is asserted as an RPC error, and a route test asserts the `error` op result | `20261026090000_plan_days_eaten_slots.sql:10-24`; `app/api/sync/ops/route.ts:88-92` |
| 9 | FIX | Slice 4 tests: the backfill is tested on a cohort captured inside one rolled-back transaction with the migration's own statement; test users get an explicit manual claim (`makeManual`); the "every user is manual" assertion is replaced by "no manual claim has an invite" | plan r4 slice 4 Tasks 1, 2 |

## Later (plan; cut from Phase 9 by rounds 3–5)

- A device cap that deletes old account databases, with a server-confirmed "sync caught up" proof
  (round 3 finding 1, P9).
- An owner-proved recovery tool for held legacy ops and held legacy eaten ticks (rounds 2–3).
- A way to show a kept account's old slot keys under its own template, or to move them (round 5
  finding 3; the data stays in place until then).
- A self-service recovery for an account whose `hooked` claim expired (round 4 finding 1; Devin
  handles it by hand, slice 5 human step 0).
- A branch snapshot mechanism so drills do not need a fresh restore each time (round 5 finding 7).

## Resolution of audit round 6

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r6-gpt6-sol.md` (DO NOT SHIP, 2 BLOCK, 2 FIX).
All 4 hold; none was rejected. Smallest safe cut for each.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Slice 6: `client_allowed()` and `requireUser` treat an account with **no** claim row like an invited one (only `manual` is exempt); the new build sends `x-smc-client` on PostgREST, so its `claim_account` passes. Tests: hooked but unclaimed user refused through an RPC and a table write without the header, `claim_account` succeeds with it; `requireUser` `426` for a missing claim row | plan r5 slice 6 Task 8b step 2 ("no `default` row" was allowed) |
| 2 | BLOCK | Slice 6 Task 1: an override that names no template of the account selects no template; a legacy key still gives its category (`rest` / `training-*`); other unknown values are ignored; the row is not changed. Slice 8's inventory lists these rows before deployment. Tests: unit cases, and Today, day context, coach and export for an `everyday` account with a stored `training-10` row | slice 8 M2 keeps unchanged overrides; spec 2.2 step 2 |
| 3 | FIX | Slice 2 follows PR #246: "Signups not allowed for otp" shows the neutral sent screen; the Preview step expects it | `fix/p9-close-open-signup:app/sign-in/page.tsx:78-87,156-163` |
| 4 | FIX | Slice 6 Preview step 7: Preview-only setup (`MIN_CLIENT_BUILD` on Preview, `app_config` row on the branch) and `scripts/p9/old-client-probe.ts`, which proves `401`/`426` on the API and refusal on PostgREST for an old client, then success with the current build; plus a browser check | `docs/plans/2026-09-22-multi-user-overnight-run.md:19` |

## Resolution of audit round 7

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r7-gpt6-sol.md` (DO NOT SHIP, 2 BLOCK, 3 FIX).
Findings 1–4 hold and are fixed. Finding 5 holds, but its fix is a spec edit, which this plan may
not make; it goes to Devin with exact text (below).

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Slice 8: for a `manual` account (every pre-Phase-9 account: Sasha, T, kept accounts) M2 accepts its template keys plus the legacy day types and slot keys; `default` or unclaimed accounts get template keys only. No client gate change. Test: a kept `everyday` account writes `meal-1` and `training-10` (pre-slice-6 build) and `breakfast` (slice 6 build); an invited account's `meal-1` is refused | `lib/plan.ts:43-46`; `lib/plan-day-client.ts:183-199`; `20260911000200_user_schema.sql:80`; `20261026090000_plan_days_eaten_slots.sql:10-13` |
| 2 | BLOCK | Slice 7: each snapshot runs in its own `tsx` process with `cwd` = the code root, so that root's `tsconfig.json` resolves `@/…`; the output carries provenance (git HEAD, resolved paths of `lib/resolve` and `lib/server/day-context`); the runner refuses output whose paths are outside the root or whose HEAD is not the named commit | `lib/server/day-context.ts:14-25`; `tsconfig.json:18-20` |
| 3 | FIX | Slice 6 Task 7: the fresh account also holds its own `consumed` `invite_claims` row; asserted explicitly | slice 5 claim flow |
| 4 | FIX | Slice 5 `createInvitedUser` clients send the current `x-smc-client` by default (option for an old client); the slice 6 probe uses it for the fixture and omits the header only on old-client requests | `tests/helpers/supabase.ts:67-69` |
| 5 | FIX | **Applied 2026-09-23** (Devin accepted the run's decisions): the spec's 2.2 step 2 and 2.5 now carry the text below, with an "Updated 2026-09-23" note | spec `:519-528` (2.2), `:602-608` (2.5) |

**Spec text (finding 5) — applied to `docs/specs/phase-9-tenancy-blank-slate.md` on 2026-09-23:**
- 2.2 step 2, add: "When `stored.dayTypeOverride` names none of the account's templates, it selects
  no template. If it is `rest`, `training-10` or `training-7-fasted`, it still gives its category
  (rest or training); any other unknown value is ignored. The stored row is not changed."
- 2.5, replace the key rule with: "The trigger judges only what a write adds or changes:
  `day_type_override` when it changes, and the keys of `eaten_slots`, `swaps`, `slot_notes`,
  `item_overrides` whose value is new or different. Each must be a key of the owner's templates;
  for a `manual` account the legacy day types and the seven legacy slot keys are also allowed.
  Stored keys are never re-judged."

Later (added): showing a `manual` account's legacy slot keys under a template that lacks them.

## Resolution of audit round 8

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r8-gpt6-sol.md` (DO NOT SHIP, 3 BLOCK, 1 FIX).
All 4 hold and are fixed. The spec is updated where the plan changed its rule (1.4 step 2, dated
note).

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | README step 5: rebase #241, apply `20261027`/`28`/`29` from a worktree at #241's head, check the new columns, **then** merge #241; then the guard check | #241 `lib/sync/user-settings.ts:128-135`; `20261028090000_body_fat_provenance.sql:9-13`; `20261029090000_rate_goals.sql:12-33` |
| 2 | BLOCK | Slice 5 and spec 1.4 step 2: per-email lock; cancel every `reserved` claim of the email on any code; a `hooked` claim is never cancelled and makes the request refuse. Tests: replacement on another code before and after expiry | spec `:345` (one active claim per email); plan r7 slice 5 Task 2 |
| 3 | BLOCK | Slice 5 rollback: first response is flag off, hook off, sign-up off (no data change); the invites down file refuses while any hooked/consumed claim or default/invited account claim exists; a verified backup and restore come before any down file; roll-forward after the first real sign-up; drill and DB test of the refusal | slice 5 claim flow leaves `consumed` claims and `account_claims.invite_id` |
| 4 | FIX | Slice 8 rollout-interval test: T (`manual`) `meal-1` → applied; an invited account's `meal-1` → RPC error | slice 8 legacy allowance for `manual` accounts |

## Resolution of audit round 9

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r9-gpt6-sol.md` (DO NOT SHIP, 4 BLOCK, 2 FIX).
All 6 hold and are fixed. Floor Day took a cut Devin accepted: fresh server verdicts only.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Slice 5 and spec 1.4 step 2: `claim_invite` checks the new code (revoked, expired, capacity) before it cancels anything; a failure changes nothing. Test: three failed replacements leave the old claim usable | spec `:373-383` (old order) |
| 2 | BLOCK | Slice 6 Task 4 and spec 2.4: a floor meal shows only from a fresh server verdict fetched in the current online session after a completed push and pull; in memory only; cleared on offline, account change, any local change and a failed pass; never cached. The `policy_epoch` design is removed. Test: remote rule change while offline | spec `:594-597`; plan r8 slice 6 Task 4 |
| 3 | BLOCK | `Store.floorVerdicts` is the one synchronous input: the phone fills it from the session value, the server from `floorVerdicts()` in the same request. Tests on both paths | `lib/resolve.ts:168`; `lib/server/day-context.ts:176-211` |
| 4 | BLOCK | Slice 7 diff is field-level: an allow entry is one key and one path (`slots[<slot>].meal`); any other change on that day fails; a whole day can never be allowed. Slice 6's floor cases use that form | `lib/resolve.ts:168-216` (a day holds targets, times, meals) |
| 5 | FIX | Spec updated (dated notes): 1.4 steps 2, 4, 5, 6 (code checked first, hook-bound claim, no new code on another device), 2.4 (session verdicts, allergen rule), 2.8 (templates stored without verdicts), Rollout (M2 before the resolver) | spec `:394-404`, `:781-785` |
| 6 | FIX | Slice 8: M2's rollback window is "no stored new key", closed by any account's first `breakfast` (T included); drill and DB test after a manual account writes `breakfast` | slice 6 Preview step 7; slice 8 down guard |

Superseded: the round 3 finding 5 fix (`policy_epoch`) and its Open for Devin line are replaced
by this round's Floor Day rule.

## Resolution of audit round 10

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r10-gpt6-sol.md` (DO NOT SHIP, 3 BLOCK, all Floor
Day). All 3 hold. Fixed by a scope cut the run decided and Devin accepted: **Phase 9 does not change
Floor Day.**

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Removed: session verdicts, `Store.floorVerdicts`, `lib/plan/floor-session.ts`; no copy can outlive an invalidation because none exists | audit r10 #1 (Week keeps a `Store` in React state) |
| 2 | BLOCK | Removed: verdict refresh after sync; nothing can stay "safe" | audit r10 #2 (no foreground poll) |
| 3 | BLOCK | Slice 7/6 gate is exact: no allow-list; every day × Floor Day × swap must equal `main`'s output | audit r10 #3 (a floor change also changes components, macros, totals) |

Also removed: server floor verdicts in `GET /api/plan/templates` (slice 4 Task 5 returns
`{ templates, version }`), the floor ref mapping (`sasha-floor-map.json`), `floor-cases.json`, and
the allergen/category evidence rules (they served only the verdict). Slice 6 Task 4 pins Floor Day
to today's behavior. Spec 2.4, 2.7, 2.8, Success criteria and Open for Devin 6 carry dated notes.
Earlier rows about verdicts (r3 #5, r4 #3, r9 #2–#4) and the round 3 Open for Devin line about
Floor Day are superseded.

## Later: Floor Day safety verdict (its own feature)

Scope: decide on the server whether a floor meal is safe for the account (Avoid marks, constraint
profile, categories, allergens), fix the name-versus-UUID Avoid lookup, and hide an unsafe floor
meal. Design lessons from rounds 3–10 of this plan's audit:
- The phone must not decide safety from local state; one server verdict must be the only input,
  and every place that resolves a day (Today, Week, coach, MCP, export) must read the same input.
- A cached or copied verdict needs one owner that every consumer re-reads; clearing one copy is not
  enough (React state keeps others).
- A verdict can go stale while online with no local change (another device, a catalog edit); the
  feature needs a freshness rule that does not depend on sync triggers or the phone clock.
- Allergen tags default to `'{}'` and are not proof of absence; category `'{}'` means "annotated,
  clean".
- An equivalence proof must compare exact fields; approving a floor change must name every field it
  touches (meal, components, macros, totals).

## Open for Devin (added round 10)

- **Known pre-existing issue, not fixed in Phase 9:** Floor Day's Avoid check never fires. It looks
  up meal slugs such as `"eggs"` in a store keyed by `user_foods.id` UUIDs (`lib/meals.ts:921-925`,
  `lib/resolve.ts:155-159`, `lib/store.ts:291`), so a floor meal is shown even when a component is
  on Sasha's Avoid list. Phase 9 keeps this behavior unchanged; the fix is the "Later" feature above.

## Resolution of audit round 11

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r11-gpt6-sol.md` (DO NOT SHIP, 1 BLOCK, 4 FIX).
All 5 hold. Findings 1, 2, 4, 5 are fixed. Finding 3 is **pending**: the coordinator is
re-planning PR #248's account-switch design; spec 0.7 and slice 1 will be updated with that
result.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Slice 3 Task 4: permissive (owner) policies keep the cross-user probe; restrictive minimum-client policies get an own-row probe as an invited account without `x-smc-client` (0 rows at baseline, ≥ 1 when weakened); probe chosen by `pg_policies.permissive` | `20260911000500_rls.sql:17-19`; slice 6 Task 8b step 4 |
| 2 | FIX | Slice 4 goal and architecture now say `{ templates, version }`, no floor verdicts | round 10 cut |
| 3 | FIX | **Applied in round 13:** spec section 0 now carries PR #248's text at `8a5b506` (header required, `smc` never deleted, caches kept, flush before bind), with a note that reload-on-switch is under evaluation | PR #248 `8a5b506` |
| 4 | FIX | Slice 8: the rollback success test deletes every row with a key outside the old lists inside its rolled-back transaction, not only the invited account's | slice 8 earlier tests write `breakfast` for manual accounts |
| 5 | FIX | README "Local DB tests": `pnpm exec supabase start` plus the four `SUPABASE_TEST_*` exports from `supabase status -o env`; the CI helper is marked CI-only in every slice | `scripts/ci-local-supabase.py:37-41,55-56` |

## Resolution of audit round 12

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r12-gpt6-sol.md` (DO NOT SHIP, 4 BLOCK, 2 FIX).

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Resolved by status: slice 3 is implemented as PR #247 (code-reviewed to 0 BLOCK); its catalog derives ownership from the database and is the source of truth. The slice 3 file is marked superseded | PR #247 `tests/tenancy/catalog.ts`; `docs/audit/code/` |
| 2 | BLOCK | Same: PR #247's `tests/tenancy/policy-mutation.test.ts` is the source of truth; slice 6 adds its restrictive-policy probe there in its own PR (README round 11) | PR #247 |
| 3 | BLOCK | Same: PR #247's matrix is the source of truth (insert-only tables such as `client_timings` as implemented there) | PR #247 `tests/tenancy/table-matrix.test.ts` |
| 4 | BLOCK | Spec "Slices" 4–8 and "Rollout" rewritten to match this plan (order 1, 2, 3, 4, 5, 7, 8, 6; renumbered migrations; #249/#250/#241 history step; no Floor Day verdicts; exact proof), dated note | spec `## Slices`, `## Rollout` |
| 5 | FIX | Resolved by status: PR #247 already uses the database catalog and fixed the entry-point inventory regex (dynamic imports included) | PR #247 `tests/tenancy/admin-entry-points.test.ts` |
| 6 | FIX | Spec 3.6 fresh-account test also expects the account's own `consumed` `invite_claims` row, dated note | slice 5 claim flow; slice 6 Task 7 |

Slices 2 and 3 now carry an "IMPLEMENTED — see PR #246 / #247" banner; slice 1 is PR #248 (in
review).

## Resolution of audit round 13

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r13-gpt6-sol.md` (DO NOT SHIP, 3 BLOCK, 2 FIX). All 5
hold and are fixed. Round 11 finding 3 is applied too.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Spec 1.2, 1.3, 2.1, 2.5 use the renumbered versions (`20261104…`–`20261107…`); spec 2.7 steps 3 and 6 follow the plan's order (M1 → M2 → resolver), each drill on its own restore; dated note | spec `:339,358,482,594,658-672`; README order |
| 2 | BLOCK | Slice 7: the snapshot loads the complete day (store, logged entries, water, gut, weight) through the root's own `serverStoreFor` + `loggedEntries`, and `canonicalDay` requires every field of `main`'s `ResolvedDay`; slice 6's new fields are checked separately | `lib/server/day-context.ts:114,176,276-288`; `lib/resolve.ts:168,245-247`; `lib/types.ts:243-269` |
| 3 | BLOCK | Slice 7: every output with account data goes to `~/Backups/supabase/p9-proof/<run-id>/` (mode 600, keep-last-3); the repo and PR get only a redacted summary (hashes, counts, provenance); a test rejects account data under `docs/proof/` | `lib/types.ts:243-269` (targets, eaten times, notes) |
| 4 | FIX | Slice 5 and spec 1.2: `invite_claims.user_id … references auth.users on delete set null`; hook evidence kept; cleanup test | spec `:345`, `:753` |
| 5 | FIX | Slice 5 and spec 1.4 step 6: the unclaimed message says to contact the person who invited you, with Retry; no "new invite" advice | spec `:377`; slice 5 human step 0 |
| r11-3 | FIX | Spec section 0 = PR #248's section 0 at `8a5b506`, plus the reload-on-switch note; slice 1 carries an "IMPLEMENTED — PR #248" banner describing the actual behavior | PR #248 `8a5b506` |

## Resolution of audit round 14

Audit: `docs/audit/plans/2026-09-22-phase-9-plan-r14-gpt6-sol.md` (DO NOT SHIP, 3 BLOCK). This is
the last plan audit of the run. Finding 1 is fixed. Findings 2 and 3 concern PR #248's code; no
code is changed here — they are listed under "Open for Devin" and spec 0.7 now states only what
PR #248 guarantees today.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Slice 8 and slice 6 write every account-data output (snapshots, M2 inventory) to `~/Backups/supabase/p9-proof/<run-id>/` (mode 600, keep-last-3); the repo and PR get only redacted summaries; slice 6's committed `her-days.json` fixture is synthetic (authored fixture + invented days, no database) | slice 7 rule (round 13); slice 8 Task 2; slice 6 Task 3 |
| 2 | BLOCK | Open (see below); spec 0.7 softened to "best effort" | PR #248 `8a5b506` `lib/device/session-binding.ts:52-59`, `lib/device/unsaved-store.ts:39-51` |
| 3 | BLOCK | Open (see below); spec 0.7 softened | PR #248 `8a5b506` `lib/device/unsaved-store.ts:60-68` |

## Open for Devin (added round 14)

- **Open BLOCK (plan r14, not re-audited):** a save made after the pre-switch flush's last check can
  stay only in memory and be purged by the switch — resolution path: PR #248 reload-on-switch
  re-plan.
- **Open BLOCK (plan r14, not re-audited):** an unsaved copy moved to a `held:*` key (its base blob
  changed, for example by a second tab) is not restored on return, so the edit is stored but absent
  from the app — resolution path: PR #248 reload-on-switch re-plan.
