# Slice 8 — Key validation M2 (`plan_days` keys come from the owner's templates)

> **Later, not built (needs a product decision).** See the banner in `README.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `plan_days.day_type_override` must be a key of one of the owner's templates, and the keys of `eaten_slots`, `swaps`, `slot_notes` and `item_overrides` must be slot keys of the owner's templates, so an invited account can store `breakfast` and nobody can store another account's keys.

**Architecture:** One migration replaces the fixed check on `day_type_override` and the fixed slot list in `plan_day_eaten_slots_valid()` with a trigger that reads the owner's templates. A late offline op that fails it gets `error` and parks.

**Tech Stack:** Postgres plpgsql trigger, Vitest DB tests.

**Spec:** `docs/specs/phase-9-tenancy-blank-slate.md` 2.5, Slices item 8, Rollout step 5.

**Branch:** `feat/p9-key-validation-m2`. One PR, unmerged.

## Global Constraints

See `README.md`. Migration `supabase/migrations/20261106090000_template_key_validation.sql` + down
file; add to `tests/migrations/down-coverage.test.ts`. Local stack and `p9-tenancy` only in this
run.

**Order changed in round 4 (audit plan r4 finding 4).** M2 is applied on production **before**
slice 6 deploys (README step 5), so the database accepts `breakfast` before any screen can write it.
Precondition, checked by Devin right before the apply: every account has templates
(`select count(*) from auth.users u where not exists (select 1 from day_templates t where t.user_id = u.id)`
= 0). Until slice 6 deploys, the code in production writes Sasha's slot keys for every account.
For a `manual` account (every account that existed before Phase 9: Sasha, T and every kept account)
M2 also accepts the seven legacy slot keys and the three legacy day types, so those writes keep
working during the interval and afterwards (audit plan r7 finding 1); see the rule below.

Apply with `apply-migrations.py` only (README); the dry run must list exactly `20261106090000`;
then run `scripts/p9/check-sync-guard.sql`.

## Current code (verified at `1d5790d`)

- `supabase/migrations/20260911000200_user_schema.sql:80` — the check on `day_type_override` (three keys).
- `supabase/migrations/20261026090000_plan_days_eaten_slots.sql:5-31` — `plan_day_eaten_slots_valid()` with the seven fixed slot ids at `:10-13`.
- `lib/coach/actions.ts:61-62` — `snack` is the extras pseudo-slot (allowed in `slot_notes`/`item_overrides` only if the current code writes it there; read the current function to keep what it accepts).
- `lib/sync/outbox.ts:198-208,309-311` — `error` ops retry, then park.

## File structure

Create: the migration + down; `tests/plan/key-validation.test.ts` (DB).

---

### Task 1: The trigger

**Rule: validate only what a write adds or changes (audit plan r5 finding 3).** `_sync_upsert`
keeps every field an op omits (`20261026090000_plan_days_eaten_slots.sql:127-135`), so a trigger
that re-checks every stored key would refuse any later edit of a row that already holds an old key
(for example a kept account with an old `meal-1` mark and only the `everyday` template). The trigger
`plan_days_template_keys` (`before insert or update`) therefore checks:
- `day_type_override`: only when `NEW.day_type_override is distinct from OLD.day_type_override`
  (on insert: when not null) — it must be a key of one of the owner's templates;
- `eaten_slots`, `swaps`, `slot_notes`, `item_overrides`: only the keys whose value in `NEW`
  differs from `OLD` (or that `OLD` lacks) — each must be a slot key of the owner's templates
  (`snack` too where the current function accepts it).
- **Legacy allowance for `manual` accounts (audit plan r7 finding 1).** When the owner's
  `account_claims.seed_policy` is `manual`, the allowed set is the owner's template keys **plus**
  the legacy set: day types `training-10`, `training-7-fasted`, `rest`; slot keys `coffee`,
  `pouches-pre`, `post-refuel`, `meal-1`, `meal-2`, `meal-3`, `hot-chocolate` (the lists of
  `20260911000200_user_schema.sql:80` and `20261026090000_plan_days_eaten_slots.sql:10-13`). A
  `default` (invited) account, or an account with no claim row, gets only its template keys. So a
  kept account backfilled with `everyday` loses no write from a tab of the pre-slice-6 build
  (`lib/plan.ts:43-46`, `lib/plan-day-client.ts:183-199` write `meal-1` …); its legacy keys stay
  stored, the resolver treats a legacy day type by category (slice 6 Task 1), and showing legacy
  slot keys under `everyday` is "Later".
Keys already stored stay and are never re-judged; nothing is rewritten. The shape check
(`plan_day_eaten_slots_valid`, now shape-only) still runs on the whole value.

- [ ] **Step 1: Failing tests**

The trigger's exception is an RPC **error** (no handler in `apply_sync_op`; the route turns it into
an `error` op result, `app/api/sync/ops/route.ts:88-92`). The direct RPC calls below therefore
assert `error` on the Supabase response, and one route test asserts the `error` op result (audit
plan r5 finding 8). Each case uses its own date; marks are objects `{ eaten_at, changed_at }`, as
the shape check requires (`20261026090000_plan_days_eaten_slots.sql:10-24`).

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, adminClient, runSql } from "../helpers/supabase";
import { createInvitedUser, createTrustedAdminUser } from "../helpers/supabase";
import fixture from "@/scripts/fixtures/sasha-plan.json";

const T = "2026-11-02T08:05:00Z";
const mark = { eaten_at: T, changed_at: T };
let day = 0;
const nextDate = () => `2026-11-${String(10 + (day++)).padStart(2, "0")}`;

/** One op on its own date: a create when baseRev is null, else an update at that rev. */
async function apply(userId: string, date: string, payload: Record<string, unknown>, baseRev: number | null = null) {
  return adminClient().rpc("apply_sync_op", { p_user_id: userId, p_op: {
    op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date,
    kind: baseRev === null ? "create" : "update", base_rev: baseRev,
    payload: { local_date: date, ...payload }, client_ts: new Date().toISOString() } });
}
const revOf = (userId: string, date: string) =>
  Number(runSql(`select rev from plan_days where user_id = '${userId}' and local_date = '${date}'`));

describe.skipIf(!HAS_BRANCH || !HAS_DB)("20261106090000 key validation (spec 2.5)", () => {
  let invited = "";
  beforeAll(async () => { invited = (await createInvitedUser()).id; });

  it("accepts breakfast in eaten_slots for an invited account", async () => {
    const r = await apply(invited, nextDate(), { eaten_slots: { breakfast: mark } });
    expect(r.error).toBeNull();
    expect((r.data as { status: string }).status).toBe("applied");
  });
  it("refuses Sasha's slot keys for an invited account (RPC error)", async () => {
    expect((await apply(invited, nextDate(), { eaten_slots: { "pouches-pre": mark } })).error).not.toBeNull();
  });
  it("refuses a day_type_override that is not one of the owner's template keys", async () => {
    expect((await apply(invited, nextDate(), { day_type_override: "training-10" })).error).not.toBeNull();
  });
  it("accepts the owner's template key", async () => {
    expect((await apply(invited, nextDate(), { day_type_override: "everyday" })).error).toBeNull();
  });
  it("keeps an old stored key, accepts a new valid key on the same row, refuses a changed old key (audit plan r5 finding 3)", async () => {
    const date = nextDate();
    // one old-era row, as it was before M2: seeded with the trigger off, in one committed statement
    runSql(`begin; alter table plan_days disable trigger plan_days_template_keys;
      insert into plan_days (user_id, local_date, eaten_slots, rev)
        values ('${invited}', '${date}', '{"meal-1": {"eaten_at": "${T}", "changed_at": "${T}"}}', 1);
      alter table plan_days enable trigger plan_days_template_keys; commit;`);
    expect((await apply(invited, date, { eaten_slots: { "meal-1": mark, breakfast: mark } }, revOf(invited, date))).error).toBeNull();
    expect(runSql(`select eaten_slots ? 'meal-1' from plan_days where user_id = '${invited}' and local_date = '${date}'`)).toBe("t");
    const changedOld = { "meal-1": { eaten_at: null, changed_at: "2026-11-02T09:00:00Z" }, breakfast: mark };
    expect((await apply(invited, date, { eaten_slots: changedOld }, revOf(invited, date))).error).not.toBeNull();
  });
  it("a kept manual account with only `everyday` keeps writing legacy keys, during and after the interval (audit plan r7 finding 1)", async () => {
    const kept = await createTrustedAdminUser(`p9-kept-${crypto.randomUUID()}@meal-companion.test`, "p9-kept-pw-123456");
    runSql(`insert into account_claims (user_id, invite_id, seed_policy) values ('${kept.id}', null, 'manual')
      on conflict (user_id) do nothing`);
    expect((await adminClient().rpc("backfill_default_templates", { p_user_ids: [kept.id] })).error).toBeNull();
    expect((await apply(kept.id, nextDate(), { eaten_slots: { "meal-1": mark } })).error).toBeNull();      // pre-slice-6 build
    expect((await apply(kept.id, nextDate(), { day_type_override: "training-10" })).error).toBeNull();
    expect((await apply(kept.id, nextDate(), { eaten_slots: { breakfast: mark } })).error).toBeNull();     // slice 6 build
    expect((await apply(kept.id, nextDate(), { eaten_slots: { "not-a-slot": mark } })).error).not.toBeNull();
    // the invited account keeps the strict rule
    expect((await apply(invited, nextDate(), { eaten_slots: { "meal-1": mark } })).error).not.toBeNull();
  });
  it("still accepts every key of a seeded manual account (Sasha's keys unchanged)", async () => {
    const manual = await createTrustedAdminUser(`p9-manual-${crypto.randomUUID()}@meal-companion.test`, "p9-manual-pw-12345");
    runSql(`insert into account_claims (user_id, invite_id, seed_policy) values ('${manual.id}', null, 'manual')
      on conflict (user_id) do nothing`);
    const { error } = await adminClient().rpc("seed_templates_from_fixture", { p_user_id: manual.id, p_fixture: fixture });
    expect(error).toBeNull();
    const r = await apply(manual.id, nextDate(), { day_type_override: "training-7-fasted",
      eaten_slots: { coffee: mark, "post-refuel": mark, "meal-1": mark, "meal-2": mark, "meal-3": mark } });
    expect(r.error).toBeNull();
  });
});
```

Route boundary (no DB, `tests/sync/ops-route.test.ts` style, ops stamped with the user id): when
the mocked `rpc` resolves `{ data: null, error: { message: 'unknown slot key "pouches-pre"' } }`,
`POST /api/sync/ops` answers `{ status: "error", message: … }` for that op (the client parks it).

(`fixture` is `import fixture from "@/scripts/fixtures/sasha-plan.json"`; `createTrustedAdminUser`
comes from `tests/helpers/supabase.ts`, slice 5.)

**Rollback precondition (audit plan r1 finding 5).** The old fixed-key check cannot be added back
while any row holds a new key, and changing or deleting user rows to make it fit would lose data.
So the down file starts with a guard and refuses instead of damaging data:

```sql
do $guard$
declare n integer;
begin
  select count(*) into n from plan_days
  where (day_type_override is not null
         and day_type_override not in ('training-10','training-7-fasted','rest'))
     or exists (select 1 from jsonb_object_keys(eaten_slots) k
                where k not in ('coffee','pouches-pre','post-refuel','meal-1','meal-2','meal-3','hot-chocolate'))
     or exists (select 1 from jsonb_object_keys(swaps) k
                where k not in ('coffee','pouches-pre','post-refuel','meal-1','meal-2','meal-3','hot-chocolate'))
     or exists (select 1 from jsonb_object_keys(slot_notes) k
                where k not in ('coffee','pouches-pre','post-refuel','meal-1','meal-2','meal-3','hot-chocolate','snack'))
     or exists (select 1 from jsonb_object_keys(item_overrides) k
                where k not in ('coffee','pouches-pre','post-refuel','meal-1','meal-2','meal-3','hot-chocolate','snack'));
  if n > 0 then
    raise exception 'M2 rollback refused: % plan_days rows use template keys the old check does not know. Roll forward instead.', n;
  end if;
end;
$guard$;
```

(Copy the exact old key lists from `20260911000200_user_schema.sql:80` and
`20261026090000_plan_days_eaten_slots.sql:10-13`, and check what the current functions accept for
`swaps`, `slot_notes` and `item_overrides` before you write the guard; `snack` is listed only where
the current code accepts it.) **Rollback condition (audit plan r9 finding 6): M2 rolls back only
while no `plan_days` row stores a key outside the old lists.** Any account can close that window,
not only an invited one: a `manual` account with the `everyday` template (T, a kept account) that
ticks `breakfast` after slice 6 deploys — or on the Preview (slice 6 Preview step 7) — writes such a
key. After that, M2 is roll-forward only.

Add to `tests/plan/key-validation.test.ts` (DB, each in its own transaction with `runSql` and
`rollback`):

```ts
it("the down file refuses while a row holds a new key, and changes nothing", () => {
  const down = readFileSync("supabase/migrations/down/20261106090000_template_key_validation.down.sql", "utf8");
  // the invited account's rows with eaten_slots.breakfast exist from the first tests
  expect(() => runSql(`begin; ${down} rollback;`)).toThrow(/M2 rollback refused/);
  expect(runSql(`select count(*) > 0 from plan_days where user_id = '${invited}' and eaten_slots ? 'breakfast'`)).toBe("t");
});
const LEGACY_SLOTS_SQL = "'coffee','pouches-pre','post-refuel','meal-1','meal-2','meal-3','hot-chocolate'";
it("the down file refuses after a MANUAL everyday account writes breakfast (audit plan r9 finding 6)", async () => {
  const kept = await createTrustedAdminUser(`p9-kept2-${crypto.randomUUID()}@meal-companion.test`, "p9-kept2-pw-12345");
  runSql(`insert into account_claims (user_id, invite_id, seed_policy) values ('${kept.id}', null, 'manual') on conflict (user_id) do nothing`);
  await adminClient().rpc("backfill_default_templates", { p_user_ids: [kept.id] });
  expect((await apply(kept.id, nextDate(), { eaten_slots: { breakfast: mark } })).error).toBeNull();
  const down = readFileSync("supabase/migrations/down/20261106090000_template_key_validation.down.sql", "utf8");
  expect(() => runSql(`begin; delete from plan_days where user_id <> '${kept.id}'; ${down} rollback;`)).toThrow(/M2 rollback refused/);
});
it("the down file succeeds when no row holds a new key", () => {
  const down = readFileSync("supabase/migrations/down/20261106090000_template_key_validation.down.sql", "utf8");
  // Remove EVERY row that holds a key outside the old lists (the invited account's and the manual
  // accounts' `breakfast` rows from earlier tests), inside this rolled-back transaction only
  // (audit plan r11 finding 4).
  expect(runSql(`begin;
    delete from plan_days where (day_type_override is not null
        and day_type_override not in ('training-10','training-7-fasted','rest'))
      or exists (select 1 from jsonb_object_keys(eaten_slots) k where k not in (${LEGACY_SLOTS_SQL}))
      or exists (select 1 from jsonb_object_keys(swaps) k where k not in (${LEGACY_SLOTS_SQL}))
      or exists (select 1 from jsonb_object_keys(slot_notes) k where k not in (${LEGACY_SLOTS_SQL}, 'snack'))
      or exists (select 1 from jsonb_object_keys(item_overrides) k where k not in (${LEGACY_SLOTS_SQL}, 'snack'));
    ${down}
    select count(*) from pg_constraint where conname = 'plan_days_eaten_slots_shape'; rollback;`)).toMatch(/1$/);
});
```

(`readFileSync` from `node:fs`. The second test deletes only inside its own rolled-back
transaction.)

A parked op test (client side, no DB): `lib/sync/outbox.test.ts` already covers `error` → retry →
park; add one case with `message` containing the trigger's text to prove it parks and is not
dropped.

- [ ] **Step 2:** FAIL. **Step 3:** migration: drop the `day_type_override` check; make `plan_day_eaten_slots_valid` shape-only; add `plan_days_template_keys()` trigger function (`before insert or update`) that raises `check_violation` with a clear message; the down file first runs the rollback precondition below, then restores the original check and
function text verbatim. **Step 4:** PASS (local stack). **Step 5:** commit.

### Task 1b: Inventory of stored keys outside each owner's templates (audit plan r5 finding 3)

`scripts/p9/m2-inventory.sql` (read-only): per account, the `plan_days` rows whose
`day_type_override` or any key of `eaten_slots`, `swaps`, `slot_notes`, `item_overrides` is not in
that account's templates — counts and the unknown keys only. Devin runs it on production
(read-only) before the M2 apply. Because the trigger judges only keys a write adds or changes, these
rows keep their data and stay editable for every other key; no key migration and no extra template
is needed. The list is information for Devin (for example, a kept account's old marks will not show
under its own template once slice 6 deploys).
- [ ] TDD: `tests/plan/m2-inventory.test.ts` (local stack): a seeded row with `meal-1` under an
  `everyday`-only account is listed; a row with only `breakfast` is not.

### Task 2: M2 proof and drill on `p9-tenancy` (moved here from slice 7; audit plan r3 finding 7)

Uses slice 7's scripts on the branch state slice 7 left (restored, M1 + seed + backfill applied;
`ledger-check.sql` and `check-sync-guard.sql` pass):
1. `resolve-snapshot.ts --code-root <base-code worktree>` (the code in production; slice 6 is not
   deployed yet when M2 is applied) → `~/Backups/supabase/p9-proof/<run-id>/``before-m2.json`.
2. Run the "legacy keys" inventory (Task 1b) → `~/Backups/supabase/p9-proof/<run-id>/``m2-inventory.txt`.
3. Apply M2 with `apply-migrations.py` (dry run lists exactly `20261106090000`); the same snapshot
   → `after-m2.json`; `diff-snapshots.ts before-m2.json after-m2.json` → prints nothing.
   `row-counts.ts` → unchanged. `ledger-check.sql`, `check-sync-guard.sql` pass.
4. Drill (last, audit plan r5 finding 7): run `down/20261106090000_template_key_validation.down.sql`
   (no invited account has written a new key on the branch, so the guard passes); snapshot →
   equals `before-m2.json`. **Then Devin restores the branch**, and the run re-applies M1, the seed,
   the backfill and M2 with `apply-migrations.py`; `ledger-check.sql` passes. This is the state slice
   6's gate starts from.
**Account data is never committed (audit plan r14 finding 1; slice 7 rule).** Every output above
(snapshots, inventory, row counts per owner) stays in `~/Backups/supabase/p9-proof/<run-id>/` (mode 600, keep-last-3). The
repository and the PR get only the redacted summary `docs/proof/p9/<run-id>.json` (SHA-256 of each
output, key counts, difference counts, provenance, table-level counts without owner ids); the
inventory contributes only "accounts with legacy keys: N, rows: M". `tests/p9/no-account-data.test.ts`
covers it.

### Task 3: Gate and PR

Apply to `p9-tenancy` (host check first), run the file there once, push, PR (unmerged), review to
`docs/audit/code/`. PR body: "Apply on production after slice 5's migrations and before slice 6
deploys (README step 5); precondition: every account has templates."

Add one DB test for the rollout interval (audit plan r4 finding 4), in
`tests/plan/key-validation.test.ts`: with M2 applied and the **pre-slice-6** key set, an op from
the test account T (a `manual` account, template `everyday`) with `eaten_slots.breakfast` →
`applied`; an op from T with `eaten_slots["meal-1"]` → `applied` (legacy allowance for `manual`
accounts; audit plan r8 finding 4); an op from an invited account with `eaten_slots["meal-1"]` →
RPC error (parks); an op from a manual account seeded from the fixture with `meal-1` → `applied`.

## Preview test steps

1. This slice deploys before slice 6, so the app still shows the old slots. On `p9-tenancy`,
   Devin checks in the SQL editor: an `apply_sync_op` for T with `eaten_slots.breakfast` answers
   `applied` (the statement is in the PR body). After slice 6 is on the preview: signed in as an
   invited account, tick Breakfast eaten; Settings → Sync shows 0 pending within a minute.
2. Signed in as Sasha's restored account: tick her usual slots and switch a day to the fasted type.
   Nothing parks.

## Rollback

`down/20261106090000_template_key_validation.down.sql` restores the fixed check and function
**only while no `plan_days` row stores a key outside the old lists**; otherwise it raises
"M2 rollback refused" and changes nothing (precondition above). The window closes at the first such
write by **any** account (a manual `everyday` account's `breakfast` counts); after that the path is
roll-forward only (fix the trigger in a new migration). Drill (Task 2, on the branch): after T writes
`breakfast` through `apply_sync_op`, the down file raises "M2 rollback refused" and changes nothing;
then Devin restores the branch.

## Human steps for Devin

1. Apply M2 on production before slice 6 deploys (README step 5), with a backup first, after the
   "every account has templates" check returns 0.
2. Know the rollback window: M2 rolls back only while no stored row has a new key — the first
   `breakfast` tick by any account (T included) closes it (see Rollback).
