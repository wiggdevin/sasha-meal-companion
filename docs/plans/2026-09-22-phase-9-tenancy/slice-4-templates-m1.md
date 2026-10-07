# Slice 4 — Templates M1 (tables, `account_claims`, server writers, fixture, read endpoint)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user day templates exist in the database, readable only by their owner and written only by three `security definer` functions; Sasha's plan is captured as a generated fixture; `GET /api/plan/templates` returns an account's templates as `{ templates, version }` (no floor verdicts; Floor Day is unchanged in Phase 9, round 10). Nothing in the app reads them yet (slice 6).

**Architecture:** Additive migration M1 creates four template tables and `account_claims` (backfilled `manual` for every existing user), the writers `create_default_template`, `seed_templates_from_fixture`, `backfill_default_templates`, and a second migration adds `plan_days.category_override` with an anchored patch of `_sync_upsert`. A generator at the base commit writes `scripts/fixtures/sasha-plan.json` from `lib/meals.ts`, `lib/plan.ts` and `lib/rotation.ts`. A route reads templates under RLS and answers `{ templates, version }`; it computes no floor verdicts (audit plan r11 finding 2).

**Tech Stack:** Postgres (plpgsql, RLS), Supabase JS, Next.js route handler, Zod, Vitest, `tsx` scripts.

**Spec:** `docs/specs/phase-9-tenancy-blank-slate.md` 1.2 (`account_claims`), 2.1, 2.3, 2.4 (Floor Day rows only; no verdicts, round 10), 2.6 (default template content), 2.7 (fixture, seed, backfill), 2.8 (endpoint), Slices item 4.

**Branch:** `feat/p9-templates-m1`. One PR, unmerged.

## Global Constraints

See `README.md`. For this slice:

- **Depends on PRs #249, #250 and #241 in `main`** (README "Migration versions"). Production
  already has `20261103090000` and `20261103090100`; `main` at `0a26e46` has neither file, and has
  `20261027090000` that production lacks. This slice starts only after the three PRs are merged, so
  the working history equals production's order plus #241. If they are not merged, stop and report;
  do not stack on three open branches.
- `20261104090100` patches `_sync_upsert` after `20261029090000_rate_goals.sql` (#241) and after
  the #249 guard; its anchors come from the definition on a local stack that has all of them.
- Apply migrations only with `python3 scripts/apply-migrations.py` (dry run, then `--commit`) and
  `SUPABASE_PROJECT_REF` set to the target; never `pnpm db:push` on a hosted project (README).
- Migrations: `supabase/migrations/20261104090000_day_templates.sql`,
  `supabase/migrations/20261104090100_plan_days_category_override.sql`, and their down files in
  `supabase/migrations/down/` (`<same name>.down.sql`). Add both pairs to
  `tests/migrations/down-coverage.test.ts`.
- Apply only to the local stack and to the preview branch `p9-tenancy`. **Never to production.**
- `authenticated` gets select only on the four template tables and on its own `account_claims` row.
- Templates are immutable after they are written (spec 2.1 DECIDED).
- `create_default_template(p_user_id)` is internal: execute revoked from `public`, `anon`,
  `authenticated`; granted to `service_role` only (slice 5's `claim_account` calls it as definer).

## Current code (verified at `1d5790d`)

- `lib/meals.ts:79-113` meal ids `<slot>--<slug>`; `:882-913` floor meals; `:921-925` Avoid slugs; `:938-942` `isMealSlot`; `:949-960` `SLOT_TARGETS: Record<DayType, Partial<Record<SlotId, Macros>>>` (`Macros` = `{ kcal, protein, carbs, fat }`, `lib/types.ts:24-29`); `:36-38` the local `macros()` builder, which calls `macroKcal` imported from `lib/scaling.ts:20` (`macroKcal(macros: Pick<Macros, "protein" | "carbs" | "fat">): number`).
- `lib/plan.ts:27-38` `dayTypeFor`; `:43-47` `SLOT_ORDER`; `:62-84` `BASE_SLOT_TIMES`.
- `lib/rotation.ts:57-78,203-211` phases.
- `lib/policy/constraints.ts:99` `evaluatePolicy`; `:140-150` the `allowed` path with missing category/tags.
- `supabase/migrations/20260911000200_user_schema.sql:13-19` `food_refs` ownership (`catalog` or `user` ref); `:80` `day_type_override` check.
- `supabase/migrations/20260919090300_phase3_sync_entities.sql:52-53` `_sync_current` plan_days uses `to_jsonb(t)`; `:229-230` `_sync_upsert` plan_days insert.
- `app/api/plan/` does not exist. `lib/server/auth.ts` `requireUser`.
- Down-file test: `tests/migrations/down-coverage.test.ts`.

**Spec note:** 2.1 says to patch `_sync_current` too. `_sync_current` builds the plan_days row with
`to_jsonb(t)` (`phase3_sync_entities.sql:52-53`), so a new column is carried without a patch.
Check the **latest** definition (`select pg_get_functiondef('public._sync_current(uuid,text,text)'::regprocedure)`
on the local stack after all migrations); patch it only if a later migration replaced `to_jsonb(t)`
with an explicit column list.

## File structure

Create:
- `supabase/migrations/20261104090000_day_templates.sql` (+ down)
- `supabase/migrations/20261104090100_plan_days_category_override.sql` (+ down)
- `scripts/p9/generate-plan-fixture.ts` — writes `scripts/fixtures/sasha-plan.json`
- `scripts/fixtures/sasha-plan.json` — generated, committed
- `lib/plan/template-types.ts` — Zod schemas `DayTemplateSchema`, `TemplatesResponseSchema` (shared by route and slice 6 client)
- `lib/server/plan-templates.ts` — `loadTemplates(client, userId)`
- `app/api/plan/templates/route.ts` — `GET`
- Tests: `tests/plan/templates-migration.test.ts` (DB), `tests/plan/templates-rls.test.ts` (DB), `tests/plan/plan-fixture.test.ts` (no DB), `tests/plan/templates-route.test.ts` (no DB, mocked `requireUser`)

## Interfaces (produced)

```ts
// lib/plan/template-types.ts
export type SlotKind = "composed" | "options";
export type TemplateSlot = { slot_key: string; label: string; kind: SlotKind; time: string; position: number;
  rotation_phase: number; ref: { protein: number; carbs: number; fat: number } | null;
  share: { protein: number; carbs: number; fat: number } | null;
  counts_for_adherence: boolean; required_for_completion: boolean; compact: boolean;
  meals: { purpose: "option" | "floor"; meal_id: string; name: string; prep_minutes: number; tags: string[];
    position: number; components: { seq: number; name: string; qty: number; unit: string;
      role: "protein" | "carb" | "fat" | "free"; protein_g: number; carbs_g: number; fat_g: number;
      food_ref_id: string | null }[] }[] };
export type DayTemplate = { key: string; label: string; serves: ("training" | "rest")[]; weekdays: number[];
  sizing: "reference" | "share"; position: number; slots: TemplateSlot[] };
export type TemplatesResponse = { templates: DayTemplate[]; version: string };
export const TemplatesResponseSchema: z.ZodType<TemplatesResponse>;
```

SQL (produced): `public.create_default_template(p_user_id uuid) returns void`,
`public.seed_templates_from_fixture(p_user_id uuid, p_fixture jsonb) returns void`,
`public.backfill_default_templates(p_user_ids uuid[]) returns integer` — all `security definer`,
`set search_path = public, pg_temp`.

---

### Task 0: Re-assert the #249 guard, and a read-only check (audit plan r4 finding 5)

**Files:** top of `supabase/migrations/20261104090000_day_templates.sql`; create
`scripts/p9/check-sync-guard.sql`; test `tests/tenancy/sync-internals-grants.test.ts` (from PR
#247; extend).

- The first statement block of `20261104090000` is a copy of the `do $migration$ … $migration$`
  block and the six `revoke`/`grant` lines of `20261103090000_sync_internals_revoke_authenticated.sql`
  (idempotent: a function that already carries `p9_sync_caller_guard` is skipped). So even if a
  migration between `20261103090100` and this one (for example #241's) had lost the guard, M1 puts
  it back before any Phase 9 change.
- `scripts/p9/check-sync-guard.sql` (read-only, one row per function):

```sql
select p.oid::regprocedure::text as fn,
       position('p9_sync_caller_guard' in pg_get_functiondef(p.oid)) > 0 as has_guard,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('_sync_current', '_sync_upsert', '_sync_tombstone')
order by 1;
```
  Pass = three rows, `has_guard = true`, `authenticated_can_execute = false`.
- [ ] **Step 1: Failing test** — extend `tests/tenancy/sync-internals-grants.test.ts` (DB): after
  all migrations, the check query returns the pass state; and in one rolled-back transaction, strip
  the guard line from `_sync_upsert` (the same `pg_get_functiondef` + `replace` technique), run the
  M1 guard block (read from the migration file, the text before the first `create table`) and assert
  the marker is back.
- [ ] **Step 2–5:** run it against the local stack (fails before the block exists), add the block,
  pass, commit `fix: re-assert the sync-internals guard in M1`.

### Task 1: Migration M1 — tables, `account_claims`, RLS

**Files:** `supabase/migrations/20261104090000_day_templates.sql`, its down file, `tests/plan/templates-migration.test.ts`, `tests/migrations/down-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan/templates-migration.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

describe.skipIf(!HAS_DB)("20261104090000_day_templates", () => {
  it("creates the four tables with RLS on", () => {
    expect(runSql(`select string_agg(relname || ':' || relrowsecurity, ',' order by relname) from pg_class
      where relname in ('day_templates','template_slots','slot_meals','slot_meal_components','account_claims')`))
      .toBe("account_claims:true,day_templates:true,slot_meal_components:true,slot_meals:true,template_slots:true");
  });
  it("gives authenticated select only", () => {
    expect(runSql(`select string_agg(distinct privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
      where grantee = 'authenticated' and table_name in ('day_templates','template_slots','slot_meals','slot_meal_components','account_claims')`))
      .toBe("SELECT");
  });
  it("the backfill statement gives a pre-existing user without a claim a 'manual' claim (audit plan r5 finding 9)", () => {
    // The cohort is captured inside one rolled-back transaction: a user created BEFORE the backfill
    // statement runs, with no claim, then the migration's own backfill statement (read from the file).
    const backfill = readFileSync("supabase/migrations/20261104090000_day_templates.sql", "utf8")
      .match(/insert into account_claims[\s\S]*?on conflict do nothing;/)![0];
    expect(runSql(`begin;
      insert into auth.users (id, email) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'cohort@meal-companion.test');
      ${backfill}
      select seed_policy || ':' || coalesce(invite_id::text, 'null') from account_claims
        where user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      rollback;`).split("\n").filter((l) => l.includes(":")).pop()).toBe("manual:null");
  });
  it("no manual claim carries an invite", () => {
    expect(runSql(`select count(*) from account_claims where seed_policy = 'manual' and invite_id is not null`)).toBe("0");
  });
  it("refuses a slot key 'snack' and a bad key pattern", () => {
    expect(() => runSql(`begin; insert into day_templates (user_id, key, label, serves, sizing, position)
      select id, 'Bad Key', 'x', '{rest}', 'share', 0 from auth.users limit 1; rollback;`)).toThrow();
  });
});
```

Add to `tests/migrations/down-coverage.test.ts`:

```ts
describe("20261104090000_day_templates.sql", () => {
  const DOWN = down("20261104090000_day_templates.down.sql");
  it("drops the writers, then the tables child-first", () => {
    const order = ["backfill_default_templates", "seed_templates_from_fixture", "create_default_template",
      "slot_meal_components", "slot_meals", "template_slots", "day_templates", "account_claims"];
    const at = order.map((name) => DOWN.indexOf(name));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });
});
```

- [ ] **Step 2: Run and see it fail** — local stack up; `pnpm exec vitest run tests/plan/templates-migration.test.ts tests/migrations/down-coverage.test.ts` — Expected: FAIL (tables missing; down file missing).
- [ ] **Step 3: Write the migration.** Tables and columns exactly as spec 2.1 and 1.2 (`account_claims (user_id uuid primary key references auth.users on delete cascade, invite_id uuid, seed_policy text not null check (seed_policy in ('default','manual')), claimed_at timestamptz not null default now())`). RLS on all five. Policies: `day_templates_owner_select … for select to authenticated using (user_id = (select auth.uid()))`; children through the parent with `exists (…)` (copy the `log_items` policy text from the RLS migration and change names); `account_claims_owner_select` on `user_id`. `revoke all … from anon, authenticated; grant select … to authenticated; grant all … to service_role`. Then `insert into account_claims (user_id, invite_id, seed_policy) select id, null, 'manual' from auth.users on conflict do nothing;`. The three writer functions (Task 2) go in this same file.
- [ ] **Step 4: Apply and run** — `pnpm exec supabase db reset` on the local stack (re-applies all migrations in version order); then the same vitest command. Expected: PASS.

**Tenancy manifests (audit plan r4 finding 9), in PR #247's format, same PR:**
- `tests/tenancy/table-ops.json`:
```json
"account_claims":       { "ops": ["select"], "owner": "user_id", "seed": "account_claims" },
"day_templates":        { "ops": ["select"], "owner": "user_id", "seed": "day_templates" },
"template_slots":       { "ops": ["select"], "owner": { "parent": "day_templates", "fk": "template_id" }, "seed": "template_slots" },
"slot_meals":           { "ops": ["select"], "owner": { "parent": "template_slots", "fk": "template_slot_id" }, "seed": "slot_meals" },
"slot_meal_components": { "ops": ["select"], "owner": { "parent": "slot_meals", "fk": "slot_meal_id" }, "seed": "slot_meal_components" }
```
- `tests/tenancy/fixtures.ts`: one builder per seed id above, in the file's `Builder` style (the
  builder creates the parents with the admin client, owned by `owner`, and returns the row not
  inserted). `account_claims` is a singleton per user: its `clear` is `{ user_id: owner }`.
- `tests/tenancy/cross-refs.json`: `"slot_meal_components.food_ref_id": { "writer": "service_role" }`
  (the writer functions check that a `user` ref belongs to the owner; the cross-ref test proves a
  service-role write of B's ref under A's template is refused).
- `tests/tenancy/rpc-ops.json`: no entry — the three writers are not executable by `authenticated`,
  and the manifest lists only functions `authenticated` can execute. `tests/tenancy/rpc-matrix.test.ts`
  fails if a writer ever becomes executable, because the generated list would then not equal the
  manifest.
- [ ] **Step 5: Commit** — `git add supabase tests && git commit -m "feat: day template tables and account_claims (M1, part 1)"`

---

### Task 2: The three writers and their checks

**Files:** same migration; `tests/plan/templates-writers.test.ts` (DB)

Checks inside a private helper `_check_templates(p_user_id)` called at the end of each writer
(spec 2.1): sizing columns match `sizing`; shares sum to 1 ± 0.001 per macro; `options` slots have
≥ 1 `option` meal and `composed` slots none; per owner and category exactly one default
(`weekdays = '{}'`) and no weekday twice; every `food_ref_id` is a `catalog` ref or a `user` ref of
the owner. A failed check raises and the whole call rolls back.

**Database-level ownership, for every writer (audit plan r5 finding 1).** The end-of-writer check
is not enough: M1 grants table writes to `service_role`, and PR #250's same-owner triggers
(`20261103090100_same_owner_references.sql`) cover only the tables it names. So M1 adds, in the
style of #250 (`security definer`, empty `search_path`, schema-qualified names, `42501`):
- `slot_meal_components_same_owner` — `before insert or update` on `slot_meal_components`: the
  component's `food_ref_id`, when not null, must be a `catalog` ref, or a `user` ref whose
  `user_foods.user_id` equals the template owner (found through `slot_meals` → `template_slots` →
  `day_templates.user_id`);
- `template_parents_fixed` — `before update` on `day_templates`, `template_slots`, `slot_meals`,
  `slot_meal_components`: refuses a change of `day_templates.user_id`, `template_slots.template_id`,
  `slot_meals.template_slot_id` or `slot_meal_components.slot_meal_id` (templates are immutable in
  Phase 9, so no writer needs it; a changed parent could move a component under another owner).
Tests (`tests/plan/templates-ownership.test.ts`, DB, as the service role, each in a rolled-back
transaction): a direct `insert` of a component under A's template with B's `user` ref → `42501`;
a direct `update` of an existing A component to B's ref → `42501`; a `catalog` ref → allowed; A's
own `user` ref → allowed; an `update` that moves a slot to another template or a template to
another user → `42501`. Add `"slot_meal_components.food_ref_id": { "writer": "service_role" }` to
`tests/tenancy/cross-refs.json` (already listed in Task 1) — PR #247's cross-ref test now finds a
trigger that enforces it.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, adminClient, ensureUser, resetUser, runSql } from "../helpers/supabase";

/** Test users are created after M1 ran, so the migration's backfill never reached them; each test
 *  that needs a manual account writes that claim itself (audit plan r5 finding 9). */
function makeManual(userId: string): void {
  runSql(`insert into account_claims (user_id, invite_id, seed_policy) values ('${userId}', null, 'manual')
    on conflict (user_id) do update set seed_policy = 'manual', invite_id = null`);
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("template writers", () => {
  let a = "";
  beforeAll(async () => {
    a = (await ensureUser("a")).id; await resetUser(a);
    runSql(`delete from day_templates where user_id = '${a}'`);
    makeManual(a);
  });

  it("create_default_template writes 'everyday' with the four spec slots and shares", () => {
    runSql(`select create_default_template('${a}')`);
    expect(runSql(`select string_agg(slot_key || ':' || to_char(time,'HH24:MI') || ':' || share_protein, ',' order by position)
      from template_slots s join day_templates t on t.id = s.template_id where t.user_id = '${a}' and t.key = 'everyday'`))
      .toBe("breakfast:08:00:0.25,lunch:12:30:0.35,snack-1:15:30:0.10,dinner:19:00:0.30");
  });
  it("is not executable by authenticated", async () => {
    const { error } = await (await import("../helpers/supabase")).anonClient().rpc("create_default_template", { p_user_id: a });
    expect(error).not.toBeNull();
  });
  it("seed_templates_from_fixture refuses a user that already has templates", () => {
    expect(() => runSql(`select seed_templates_from_fixture('${a}', '{}'::jsonb)`)).toThrow();
  });
  it("seed and backfill refuse a non-manual claim", () => {
    runSql(`update account_claims set seed_policy = 'default' where user_id = '${a}'`);
    expect(() => runSql(`select backfill_default_templates(array['${a}']::uuid[])`)).toThrow();
    runSql(`update account_claims set seed_policy = 'manual' where user_id = '${a}'`);
  });
  it("a share set that does not sum to 1 rolls the whole write back", () => {
    runSql(`delete from day_templates where user_id = '${a}'`);
    expect(() => runSql(`select seed_templates_from_fixture('${a}', '${badShareFixture()}'::jsonb)`)).toThrow(/share/);
    expect(runSql(`select count(*) from day_templates where user_id = '${a}'`)).toBe("0");
  });
});
```

(`badShareFixture()` returns a one-template `share` fixture whose protein shares sum to 0.9.
Note: `seed_templates_from_fixture` accepts `reference` and `share` fixtures; the check is the
same.)

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement** the functions in plpgsql (`security definer`, `set search_path = public, pg_temp`), each ≤ one screen; `revoke execute … from public, anon, authenticated; grant execute … to service_role`. `seed_templates_from_fixture` walks `p_fixture->'templates'` with `jsonb_array_elements` and inserts parent-first. `backfill_default_templates` loops over `p_user_ids`, applies the same guards, and calls `create_default_template`; it returns the count written.
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat: server-only template writers with integrity checks"`

---

### Task 3: `plan_days.category_override` (M1, part 2)

**Files:** `supabase/migrations/20261104090100_plan_days_category_override.sql` (+ down), `tests/plan/category-override.test.ts` (DB)

- [ ] **Step 1: Write the failing test** — apply a `plan_days` op with `payload: { category_override: "rest" }` through `apply_sync_op` as A (pattern: `tests/rls/cross-user.test.ts:40-60`); read the row with the admin client: `category_override = 'rest'`; an op with `"category_override": "fasted"` answers `error` (check constraint); an op that omits the key keeps the stored value.
- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement** — `alter table plan_days add column category_override text check (category_override in ('training','rest'));` then an anchored `_sync_upsert` patch in the exact style of `20261029090000_rate_goals.sql` (PR #241): read `pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)`, require each anchor exactly once, replace, `execute`. Anchors are chosen from the plan_days insert column list and its `on conflict … do update set` list (read the current definition on the local stack after PR #241's migration; copy the exact text). The down file first runs a guard (audit plan r4 finding 8), then drops the column and restores the function by the reverse replacement:

```sql
do $guard$
declare n integer;
begin
  select count(*) into n from plan_days where category_override is not null;
  if n > 0 then
    raise exception 'M1 rollback refused: % plan_days rows hold category_override. Roll forward instead.', n;
  end if;
end;
$guard$;
```

`20261104090000`'s down file gets the same kind of guard: it refuses while any `account_claims`
row has `seed_policy = 'default'` or a non-null `invite_id` (an invited account exists), because
dropping `account_claims` would erase that account's claim. Sasha's `manual` templates are
reproducible from the fixture, so they do not block the down file. So: M1 rolls back freely until the
first day toggle writes `category_override` (slice 6) or the first invited account claims (slice
5); after that, M1 is roll-forward only.
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat: plan_days.category_override through the sync upsert"`

---

### Task 4: The fixture generator (no DB)

**Files:** `scripts/p9/generate-plan-fixture.ts`, `scripts/fixtures/sasha-plan.json`, `tests/plan/plan-fixture.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan/plan-fixture.test.ts
import { describe, expect, it } from "vitest";
import fixture from "@/scripts/fixtures/sasha-plan.json";
import { buildPlanFixture } from "@/scripts/p9/generate-plan-fixture";
import { SLOT_TARGETS } from "@/lib/meals";
import { macroKcal } from "@/lib/scaling";
import type { DayType, SlotId } from "@/lib/types";

describe("Sasha plan fixture (spec 2.3, 2.7)", () => {
  it("is exactly what the generator produces from the code (no hand edits)", () => {
    expect(buildPlanFixture()).toEqual(fixture);
  });
  it("has 3 templates, 15 slots, 14 options and 9 floor meals", () => {
    const slots = fixture.templates.flatMap((t) => t.slots);
    const meals = slots.flatMap((s) => s.meals);
    expect([fixture.templates.length, slots.length,
      meals.filter((m) => m.purpose === "option").length,
      meals.filter((m) => m.purpose === "floor").length]).toEqual([3, 15, 14, 9]);
  });
  it("reference macros equal SLOT_TARGETS and kcal = 4P + 4C + 9F", () => {
    for (const t of fixture.templates) for (const s of t.slots) {
      const target = SLOT_TARGETS[t.key as DayType][s.slot_key as SlotId]!;
      expect(s.ref).toEqual({ protein: target.protein, carbs: target.carbs, fat: target.fat });
      expect(macroKcal(s.ref!)).toBe(target.kcal);
    }
  });
  it("matches the spec 2.3 table row for training-7-fasted post-refuel", () => {
    const s = fixture.templates.find((t) => t.key === "training-7-fasted")!.slots.find((x) => x.slot_key === "post-refuel")!;
    expect([s.ref, s.time, s.rotation_phase, s.kind]).toEqual([{ protein: 30, carbs: 65, fat: 12 }, "08:15", 1, "options"]);
  });
});
```

(`SLOT_TARGETS` is keyed by day type, then slot id; its `kcal` is `macroKcal` of the first option's macros, so the equality holds for every row of the spec 2.3 table.)

- [ ] **Step 2: Run and see it fail** — `pnpm exec vitest run tests/plan/plan-fixture.test.ts`.
- [ ] **Step 3: Implement** `buildPlanFixture()` (pure; imports `lib/meals.ts`, `lib/plan.ts`, `lib/rotation.ts`) and a `main` that writes pretty JSON with a trailing newline. Flags per spec 2.7. Floor meals copied onto meal-1/2/3 of each template with `food_ref_id: null` (no ref mapping in Phase 9; round 10). Run it: `pnpm exec tsx scripts/p9/generate-plan-fixture.ts > scripts/fixtures/sasha-plan.json`.
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `git add scripts tests && git commit -m "feat: generate Sasha's plan fixture from code"`

This fixture must be generated **at the base commit** (before slice 6 removes the constants). Slice
6 keeps the committed JSON and deletes nothing it depends on in tests; the "no hand edits" test is
removed in slice 6 together with the constants (it can no longer run), and replaced by a checksum
test of the committed file.

---

### Task 5: `GET /api/plan/templates`

**Files:** `lib/plan/template-types.ts`, `lib/server/plan-templates.ts`, `app/api/plan/templates/route.ts`, `tests/plan/templates-route.test.ts`, `tests/plan/templates-rls.test.ts` (DB)

The route answers `{ templates, version }`, where `version` is `sha256` of the canonical JSON of
`templates`. **No floor verdicts (audit plan r10; Devin accepted):** Phase 9 does not change Floor
Day. Floor meals exist only in Sasha's migrated templates (`purpose = 'floor'` rows, components
with `food_ref_id` null, as authored) and the resolver uses them exactly as `main` does today. The
Avoid-safety verdict is a separate "Later" feature (README).

- [ ] **Step 1: Write the failing tests**

`templates-route.test.ts` (mocks `requireUser` as `tests/sync/ops-route.test.ts:1-20` does, and
`lib/server/plan-templates`): 401 without a session; 200 with `templates` and `version` only; the response parses
with `TemplatesResponseSchema`; `version` changes when a template row changes.

`templates-rls.test.ts` (DB): seed the default template for A and B with the admin client; as A,
`select * from day_templates` returns only A's; the route called with A's cookie (pattern:
`tests/sync/cross-user-http.test.ts:24-35` `cookieHeaderFor`) returns no B template.

- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run tests/plan/templates-route.test.ts`.
- [ ] **Step 3: Implement** `loadTemplates` and the route (`export const runtime = "nodejs"; export const dynamic = "force-dynamic";`, `requireUser`, `jsonError`).
- [ ] **Step 4: Run and see them pass** (and `tests/plan/templates-rls.test.ts` against the local stack).
- [ ] **Step 5: Commit** — `git commit -am "feat: GET /api/plan/templates"`

---

### Task 6: The slice gate on `p9-tenancy` and the PR

- [ ] **Step 1: Create or reuse the preview branch** — `bash scripts/db-branch.sh create p9-tenancy` (only if it does not exist; at most one preview branch). `bash scripts/db-branch.sh env` prints the `SUPABASE_TEST_*` values for it.
- [ ] **Step 2: Apply migrations to `p9-tenancy` only** — `SUPABASE_PROJECT_REF=<p9-tenancy branch ref> python3 scripts/apply-migrations.py` (dry run). Check the ref is the branch's, not production's. The dry-run list must be exactly the versions the restored branch lacks, in order (after Devin's restore and README step 5: `20261104090000`, `20261104090100`). Then `--commit`, then run `scripts/p9/check-sync-guard.sql` on the branch.
- [ ] **Step 3: Gate (spec Slices item 4)** — on the local stack: seed (with a synthetic `manual` user and the fixture) and backfill (with the test account) produce the expected rows (Task 2 tests); the endpoint returns them under RLS; a cross-user read returns nothing (Task 5 DB test). Run those files only.
- [ ] **Step 4:** (removed in round 10: no floor ref mapping; floor components keep `food_ref_id` null.)
- [ ] **Step 5: Fast gates, push, PR** — `pnpm exec tsc --noEmit && pnpm lint && pnpm exec vitest run --changed origin/main`; `gh pr create` (base `main`, or `feat/tdee-rate-goals` if stacked). Unmerged. Review to `docs/audit/code/`.

## Preview test steps

1. On the `p9-tenancy` Supabase branch (table editor): `account_claims` has one `manual` row per
   user; `day_templates` is empty until the seed runs.
2. Devin runs, against `p9-tenancy` only: `select seed_templates_from_fixture('<Sasha id>', '<fixture json>'::jsonb);`
   (or `pnpm exec tsx scripts/p9/seed.ts --target p9-tenancy --user <id>` if slice 7 has landed).
   Then `day_templates` shows 3 rows for her, `template_slots` 15, `slot_meals` 23 (14 + 9).
3. On the Vercel preview signed in as T (after `backfill_default_templates(array['<T id>'])`), open
   DevTools → Console and run
   `await (await fetch("/api/plan/templates", { headers: { "x-smc-account": "<T id>" } })).json()`
   (every data route needs the account header, PR #248): one template `everyday`, four slots. The same call without the header answers `401 account_header_required`.
4. Signed in as D, the same call with D's id shows only D's templates (empty list if none); with
   T's id it answers `409 account_mismatch`.
5. The app itself looks unchanged (nothing reads templates yet).

## Rollback

- Code: revert the merge commit.
- Database (preview or, later, production by Devin): run
  `supabase/migrations/down/20261104090100_plan_days_category_override.down.sql`, then
  `…/20261104090000_day_templates.down.sql`. Each down file refuses and changes nothing once data
  it would destroy exists (any `category_override`; any invited claim). Before that point no
  existing row changes. Slice 7's drills prove the free case; slice 7's drill C proves the refusal
  after a category toggle.

## Human steps for Devin

1. Merge PRs #249, #250 and #241 into `main`, and apply #241's migrations on production with
   `apply-migrations.py` (README steps 4–5).
2. Dump production and restore into `p9-tenancy` (`scripts/backup.sh`,
   `scripts/restore-to-branch.sh <dump> --confirm <branch-ref>`) before Task 6 step 4.
3. (Removed in round 10: no floor ref mapping to confirm.)
4. On production later, in rollout order and after a backup: apply M1, run the seed with Sasha's
   id and the backfill with the test account id (Open for Devin 7).
